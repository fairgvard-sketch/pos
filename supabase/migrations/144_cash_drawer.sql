-- ============================================================
-- 144 CASH DRAWER — денежный ящик: физическое открытие и его аудит.
--
-- Что было не так: касса умела считать наличные (038 движения,
-- 037 Z-отчёт), но НЕ умела открывать денежный ящик. На терминале
-- Sunmi ящик подключён к принтеру и открывается импульсом ESC/POS —
-- без этого кассир открывал ящик ключом, а «открытие без продажи»
-- (no-sale) нигде не фиксировалось. Это классическая дыра учёта:
-- недостача в конце смены есть, а следа, кто и когда лазил в ящик,
-- нет.
--
-- Здесь — серверная половина: журнал открытий. Само открытие делает
-- клиент (мост APK / RawBT), сервер лишь фиксирует факт.
--
-- Решения:
--   * drawer_opens — только INSERT (инвариант №2: аудит не переписывается);
--     id приходит с клиента и служит ключом идемпотентности, поэтому
--     replay офлайн-очереди не задваивает запись;
--   * право на РУЧНОЕ открытие (`no_sale`) = существующее `cash_movement`:
--     доступ к ящику без продажи — та же по смыслу операция, что
--     внесение/изъятие. Новый ключ права не заводим, чтобы не плодить
--     сущности в ролях (094) и кабинете;
--   * сопутствующие открытия (оплата наличными, возврат, инкассация,
--     открытие/закрытие смены) идут в МЯГКОМ режиме сессии (086):
--     право уже проверено самой операцией, журнал не должен её ронять;
--   * смена определяется сервером (текущая открытая на точке) — клиент
--     не обязан её знать; вне смены пишем с shift_id = NULL, а не теряем
--     запись;
--   * capability-гейта здесь НЕТ сознательно (как у close_shift и
--     uf_export_*, 105): ящик физически открывает клиент, и приостановка
--     продукта не должна превращать открытие в НЕзаписанное — иначе гейт
--     создаёт дыру именно в аудите.
--
-- ⚠️ ТРЕБУЕТ 086 (require_staff_session), 094/095 (require_staff_perm).
-- ============================================================

CREATE TABLE IF NOT EXISTS drawer_opens (
  -- Клиентский UUID: ключ идемпотентности офлайн-replay (ON CONFLICT)
  id          UUID PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  -- Открытие вне смены возможно (пересчёт кассы до открытия) — NULL допустим
  shift_id    UUID REFERENCES shifts(id) ON DELETE SET NULL,
  staff_id    UUID REFERENCES staff(id),
  -- Заказ, с которым связано открытие (оплата наличными/возврат)
  order_id    UUID REFERENCES orders(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL CHECK (reason IN (
                'sale', 'refund', 'cash_in', 'cash_out',
                'shift_open', 'shift_close', 'no_sale', 'test')),
  -- Комментарий кассира к открытию без продажи (зачем открывал)
  note        TEXT,
  -- Физический терминал (devices.device_uuid) — на точке их несколько
  device_uuid UUID,
  -- Честное время события на кассе (офлайн-replay приезжает позже)
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drawer_opens_shift
  ON drawer_opens(shift_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_drawer_opens_org_time
  ON drawer_opens(org_id, opened_at DESC);

ALTER TABLE drawer_opens ENABLE ROW LEVEL SECURITY;

-- Чтение — своей org (экран смены, будущие отчёты кабинета);
-- запись только через RPC (SECURITY DEFINER), как у cash_movements.
DO $$ BEGIN
  CREATE POLICY drawer_opens_select ON drawer_opens
    FOR SELECT TO authenticated USING (org_id = auth_org_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Новые объекты обязаны выдавать гранты явно (см. 071)
GRANT SELECT ON TABLE drawer_opens TO authenticated;
GRANT ALL    ON TABLE drawer_opens TO service_role;

COMMENT ON TABLE drawer_opens IS
  'Журнал открытий денежного ящика (144). Только INSERT; id — клиентский UUID (идемпотентность replay).';

-- ============================================================
-- RPC: log_drawer_open — зафиксировать открытие ящика
--
-- Возвращает {"id": ..., "logged": true|false}; logged=false означает
-- «уже записано с этим uuid» (повтор после timeout/replay), а не ошибку.
-- ============================================================
CREATE OR REPLACE FUNCTION log_drawer_open(
  p_op_uuid       UUID,
  p_reason        TEXT,
  p_staff_id      UUID        DEFAULT NULL,
  p_order_id      UUID        DEFAULT NULL,
  p_note          TEXT        DEFAULT NULL,
  p_device_uuid   UUID        DEFAULT NULL,
  p_opened_at     TIMESTAMPTZ DEFAULT NULL,
  p_staff_session UUID        DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org           UUID := auth_org_id();
  v_loc           UUID := auth_location_id();
  v_session_staff UUID;
  v_staff         UUID;
  v_shift         UUID;
  v_order         UUID;
  v_written       INTEGER;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_op_uuid IS NULL THEN
    RAISE EXCEPTION 'op uuid required';
  END IF;
  IF p_reason NOT IN ('sale', 'refund', 'cash_in', 'cash_out',
                      'shift_open', 'shift_close', 'no_sale', 'test') THEN
    RAISE EXCEPTION 'invalid reason';
  END IF;

  -- Ручное открытие без продажи — привилегия уровня «движение наличных»
  -- (строгий режим: без валидной сессии отказ). Остальные причины
  -- сопровождают уже авторизованную операцию — мягкий режим 086.
  IF p_reason = 'no_sale' THEN
    v_session_staff := require_staff_perm(p_staff_session, 'cash_movement');
  ELSE
    v_session_staff := require_staff_session(p_staff_session);
  END IF;

  -- Автор в журнале — тот, кто открыл ящик В МОМЕНТ события, поэтому
  -- payload приоритетнее сессии: офлайн-запись доезжает позже и часто уже
  -- под чужим PIN, а «ящик открыл сменщик» — ложь в аудите. Сессия при
  -- этом остаётся тем, что даёт ПРАВО (проверено выше), и подставляется,
  -- когда клиент автора не передал.
  IF p_staff_id IS NOT NULL THEN
    SELECT id INTO v_staff FROM staff WHERE id = p_staff_id AND org_id = v_org;
  END IF;
  IF v_staff IS NULL THEN
    v_staff := v_session_staff;
  END IF;

  -- Текущая открытая смена точки; вне смены — NULL (запись всё равно нужна)
  SELECT id INTO v_shift
  FROM shifts
  WHERE org_id = v_org AND location_id = v_loc AND status = 'open'
  ORDER BY opened_at DESC
  LIMIT 1;

  -- Чужой заказ в журнал не пишем (ссылка должна быть проверяемой)
  IF p_order_id IS NOT NULL THEN
    SELECT id INTO v_order FROM orders WHERE id = p_order_id AND org_id = v_org;
  END IF;

  INSERT INTO drawer_opens (
    id, org_id, location_id, shift_id, staff_id, order_id,
    reason, note, device_uuid, opened_at
  ) VALUES (
    p_op_uuid, v_org, v_loc, v_shift, v_staff, v_order,
    p_reason, NULLIF(TRIM(p_note), ''), p_device_uuid,
    COALESCE(p_opened_at, NOW())
  )
  ON CONFLICT (id) DO NOTHING;

  GET DIAGNOSTICS v_written = ROW_COUNT;

  RETURN json_build_object('id', p_op_uuid, 'logged', v_written > 0);
END $$;

REVOKE EXECUTE ON FUNCTION
  log_drawer_open(UUID, TEXT, UUID, UUID, TEXT, UUID, TIMESTAMPTZ, UUID)
  FROM anon, public;
GRANT EXECUTE ON FUNCTION
  log_drawer_open(UUID, TEXT, UUID, UUID, TEXT, UUID, TIMESTAMPTZ, UUID)
  TO authenticated;
