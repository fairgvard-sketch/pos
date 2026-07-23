-- ============================================================
-- 098 ACTIVITY EVENTS — лента активности кассы для веб-кабинета.
--
-- Мотив: начальник хочет видеть в ANGLE back office, что происходит на кассе —
-- открыли смену, закрыли (с суммой), сделали возврат. Уведомлений пока нет:
-- события просто копятся и показываются в дашборде (Home + раздел Activity).
-- Позже поверх этой же таблицы можно навесить доставку (Telegram/push) без
-- переделки — событие уже рождается в доверенной точке.
--
-- Архитектурное решение: НЕ править тела open_shift/close_shift/issue_refund.
-- Эти RPC переопределялись по 5–9 раз (тонкая логика Z-отчёта, guard'ов,
-- частичных возвратов) — вставка в них хрупка и создаёт связность. Вместо
-- этого — AFTER-триггеры на таблицах shifts и refunds:
--   * событие пишется атомарно с самой операцией (одна транзакция);
--   * ловится независимо от того, какая версия RPC его породила и будет
--     ли она переопределена в будущем;
--   * клиент не может подделать событие — оно порождается строкой в БД,
--     а не словами кассы (инвариант: горячему потоку клиента не доверяем).
--
-- Снапшот: тип, точка, имя сотрудника и сумма фиксируются В МОМЕНТ события —
-- лента не «плывёт» при правках меню/деактивации сотрудника (инвариант 5).
-- Деньги — целые агороты (инвариант 1).
--
-- Доступ (правило 071 — новые объекты выдают GRANT сами): таблица закрыта на
-- запись клиентам целиком (пишут только SECURITY DEFINER триггеры); чтение —
-- через RPC get_activity_feed (SECURITY INVOKER, под RLS: своя org).
--
-- ⚠️ ТРЕБУЕТ 088 (auth_backoffice_role), 028/029 (refunds + location_id).
-- ============================================================

CREATE TABLE activity_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  -- Тип события; расширяемо (новые типы — просто новый триггер + строка UI)
  type        TEXT NOT NULL CHECK (type IN ('shift_opened', 'shift_closed', 'refund_issued')),
  -- Ссылка на породившую строку (shift.id / refund.id) — для навигации/дедупа
  ref_id      UUID,
  staff_id    UUID REFERENCES staff(id) ON DELETE SET NULL,
  -- Имя сотрудника снапшотом (не зависит от деактивации/переименования)
  staff_name  TEXT,
  -- Денежный снапшот в агоротах: смысл зависит от type
  --   shift_opened  — opening_float
  --   shift_closed  — total_sales
  --   refund_issued — amount возврата (положительный)
  amount      INTEGER,
  -- Дополнительные поля события (cash_diff, method, reason, …) без раздувания схемы
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Лента читается «свежие сверху» в разрезе org и (опционально) точки
CREATE INDEX idx_activity_org_created ON activity_events(org_id, created_at DESC);
CREATE INDEX idx_activity_loc_created ON activity_events(location_id, created_at DESC);

ALTER TABLE activity_events ENABLE ROW LEVEL SECURITY;

-- Только чтение своей org; запись — исключительно через триггеры (DEFINER).
CREATE POLICY activity_events_select ON activity_events
  FOR SELECT TO authenticated
  USING (org_id = auth_org_id());

REVOKE ALL ON activity_events FROM anon, authenticated, public;
GRANT SELECT ON activity_events TO authenticated;
GRANT ALL  ON activity_events TO service_role;

-- ── Триггер: открытие смены ─────────────────────────────────
CREATE OR REPLACE FUNCTION trg_activity_shift_opened()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO activity_events (org_id, location_id, type, ref_id, staff_id, staff_name, amount)
  SELECT NEW.org_id, NEW.location_id, 'shift_opened', NEW.id, NEW.opened_by,
         (SELECT name FROM staff WHERE id = NEW.opened_by),
         NEW.opening_float;
  RETURN NEW;
END $$;

CREATE TRIGGER activity_shift_opened
  AFTER INSERT ON shifts
  FOR EACH ROW EXECUTE FUNCTION trg_activity_shift_opened();

-- ── Триггер: закрытие смены ─────────────────────────────────
-- Ловим переход в 'closed' (а не любой UPDATE) — идемпотентно к повторным
-- апдейтам закрытой строки.
CREATE OR REPLACE FUNCTION trg_activity_shift_closed()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
    INSERT INTO activity_events (org_id, location_id, type, ref_id, staff_id, staff_name, amount, detail)
    SELECT NEW.org_id, NEW.location_id, 'shift_closed', NEW.id, NEW.closed_by,
           (SELECT name FROM staff WHERE id = NEW.closed_by),
           NEW.total_sales,
           jsonb_build_object(
             'cash_diff',    NEW.cash_diff,
             'counted_cash', NEW.counted_cash,
             'orders_count', NEW.orders_count,
             'z_number',     NEW.z_number
           );
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER activity_shift_closed
  AFTER UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION trg_activity_shift_closed();

-- ── Триггер: возврат ────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_activity_refund_issued()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO activity_events (org_id, location_id, type, ref_id, staff_id, staff_name, amount, detail)
  SELECT NEW.org_id, NEW.location_id, 'refund_issued', NEW.id, NEW.staff_id,
         (SELECT name FROM staff WHERE id = NEW.staff_id),
         NEW.amount,  -- refunds.amount положительный по CHECK (028)
         jsonb_build_object('method', NEW.method, 'reason', NEW.reason);
  RETURN NEW;
END $$;

CREATE TRIGGER activity_refund_issued
  AFTER INSERT ON refunds
  FOR EACH ROW EXECUTE FUNCTION trg_activity_refund_issued();

-- ── Чтение ленты для веб-кабинета ───────────────────────────
-- Гейт как у get_backoffice_fleet (097)/sales_report (089): членство владельца/
-- менеджера ИЛИ manage-сессия кассы. SECURITY INVOKER — чтение под RLS
-- activity_events_select (своя org недостижима для чужих). Пагинация: свежие
-- сверху, keyset по created_at (p_before) — стабильно при доливе новых.
CREATE OR REPLACE FUNCTION get_activity_feed(
  p_limit         INTEGER DEFAULT 50,
  p_before        TIMESTAMPTZ DEFAULT NULL,
  p_location_id   UUID DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  v_limit  INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
BEGIN
  IF COALESCE(auth_backoffice_role(), '') NOT IN ('owner', 'manager') THEN
    PERFORM require_staff_perm(p_staff_session, 'manage');
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(e) ORDER BY e.created_at DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT a.id, a.type, a.location_id,
           (SELECT name FROM locations WHERE id = a.location_id) AS location_name,
           a.staff_name, a.amount, a.detail, a.created_at
    FROM activity_events a
    WHERE (p_before IS NULL OR a.created_at < p_before)
      AND (p_location_id IS NULL OR a.location_id = p_location_id)
    ORDER BY a.created_at DESC
    LIMIT v_limit
  ) e;

  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION get_activity_feed FROM anon, public;
GRANT EXECUTE ON FUNCTION get_activity_feed(INTEGER, TIMESTAMPTZ, UUID, UUID) TO authenticated;

COMMENT ON TABLE activity_events IS
  'Лента активности кассы (открытие/закрытие смены, возврат) для ANGLE back office. Пишется только AFTER-триггерами shifts/refunds (клиент подделать не может), читается get_activity_feed под RLS org.';
