-- ============================================================
-- 140. История заявки — кто и когда двигал онлайн-заказ.
--
-- Что было не так: у заявки хранится ТОЛЬКО последнее решение
-- (`decided_at`, `decided_by`/`decided_by_member`). Цепочка
-- `new → accepted → preparing → ready → completed` нигде не остаётся:
-- после «Готово» невозможно ответить, когда заказ приняли, сколько он
-- готовился и кто его закрыл. Кабинет из-за этого может показать в
-- карточке заказа либо два события, либо выдуманную ленту.
--
-- Здесь: append-only журнал переходов. Пишется триггером, а не
-- вызывающими функциями, поэтому в него попадают ВСЕ пути — веб-кабинет
-- (`set_online_order_status_web`), касса (`accept_online_order`,
-- `reject_online_order`) и любой будущий.
--
-- Инвариант аудита (AGENTS.md §2): записи только добавляются. У клиента
-- нет INSERT/UPDATE/DELETE, читает он их под той же RLS, что и заявки.
--
-- Персональные данные в журнал не кладём: имя автора — это
-- `display_name` веб-члена или имя сотрудника кассы (они и так видны в
-- интерфейсе), почта и телефон — нет.
--
-- Бэкфилл честен по объёму знаний: у старых заявок восстановимы только
-- «получена» (`created_at`) и последнее решение (`decided_at`).
-- Промежуточных шагов у них не было записано, и придумывать их нельзя —
-- лента такой заявки просто короче.
--
-- ⚠️ ТРЕБУЕТ 050 (online_orders), 088 (organization_members),
--    101 (decided_by_member).
-- ============================================================

CREATE TABLE IF NOT EXISTS online_order_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id     UUID NOT NULL REFERENCES locations(id),
  online_order_id UUID NOT NULL REFERENCES online_orders(id) ON DELETE CASCADE,
  -- Состояние, в которое заявка перешла: словарь тот же, что у
  -- online_orders.status (CHECK там же, 101).
  status          TEXT NOT NULL,
  -- Причина отказа/отмены — та, что уехала гостю.
  reason          TEXT,
  actor_kind      TEXT NOT NULL CHECK (actor_kind IN ('guest', 'backoffice', 'pos', 'system')),
  actor_member    UUID REFERENCES organization_members(id),
  actor_staff     UUID REFERENCES staff(id),
  -- Снимок имени на момент события (инвариант «имена снапшотятся»):
  -- уволенный сотрудник не должен превращать историю в «—».
  actor_name      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE online_order_events IS
  'Append-only история переходов онлайн-заявки (140): что произошло, когда и кто это сделал — касса, кабинет или гость.';

CREATE INDEX IF NOT EXISTS idx_online_order_events_order
  ON online_order_events(online_order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_online_order_events_loc
  ON online_order_events(location_id, created_at);

ALTER TABLE online_order_events ENABLE ROW LEVEL SECURITY;

-- Читают члены организации (та же политика, что у самих заявок, 050).
CREATE POLICY online_order_events_select ON online_order_events
  FOR SELECT TO authenticated USING (org_id = auth_org_id());

REVOKE ALL ON online_order_events FROM anon;
REVOKE INSERT, UPDATE, DELETE ON online_order_events FROM authenticated;
GRANT SELECT ON online_order_events TO authenticated, service_role;

-- ── Запись события ───────────────────────────────────────────
/**
 * Автор перехода вычисляется из самой заявки, а не из контекста вызова:
 * веб-кабинет проставляет `decided_by_member`, касса — `decided_by`, и
 * оба обновляют `decided_at`. Сравнение с `decided_at` обязательно —
 * иначе повторный перевод тем же человеком (у него `decided_by_member`
 * не меняется) записался бы как системный.
 */
CREATE OR REPLACE FUNCTION online_orders_log_event()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_kind    TEXT := 'system';
  v_member  UUID := NULL;
  v_staff   UUID := NULL;
  v_name    TEXT := NULL;
  v_reason  TEXT := NULL;
  v_decided BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Заявку создаёт гость; время события — время заявки, а не NOW():
    -- вставка и создание должны совпадать до секунды.
    INSERT INTO online_order_events (
      org_id, location_id, online_order_id, status, actor_kind, created_at
    ) VALUES (
      NEW.org_id, NEW.location_id, NEW.id, NEW.status, 'guest', NEW.created_at
    );
    RETURN NULL;
  END IF;

  -- Правки без смены статуса (лояльность, привязка заказа) историю не
  -- засоряют.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;

  v_decided := NEW.decided_at IS DISTINCT FROM OLD.decided_at;
  IF v_decided AND NEW.decided_by_member IS NOT NULL THEN
    v_kind := 'backoffice';
    v_member := NEW.decided_by_member;
    SELECT display_name INTO v_name
    FROM organization_members WHERE id = v_member;
  ELSIF v_decided AND NEW.decided_by IS NOT NULL THEN
    v_kind := 'pos';
    v_staff := NEW.decided_by;
    SELECT name INTO v_name FROM staff WHERE id = v_staff;
  END IF;

  IF NEW.status IN ('rejected', 'cancelled') THEN
    v_reason := NEW.reject_reason;
  END IF;

  INSERT INTO online_order_events (
    org_id, location_id, online_order_id, status, reason,
    actor_kind, actor_member, actor_staff, actor_name
  ) VALUES (
    NEW.org_id, NEW.location_id, NEW.id, NEW.status, v_reason,
    v_kind, v_member, v_staff, v_name
  );
  RETURN NULL;
END $$;

COMMENT ON FUNCTION online_orders_log_event() IS
  'AFTER INSERT/UPDATE online_orders: запись перехода в online_order_events (140).';

DROP TRIGGER IF EXISTS trg_online_orders_events ON online_orders;
CREATE TRIGGER trg_online_orders_events
  AFTER INSERT OR UPDATE ON online_orders
  FOR EACH ROW
  EXECUTE FUNCTION online_orders_log_event();

-- ── Бэкфилл ──────────────────────────────────────────────────
-- Первое событие есть у каждой заявки: её получили.
INSERT INTO online_order_events (
  org_id, location_id, online_order_id, status, actor_kind, created_at
)
SELECT o.org_id, o.location_id, o.id, 'new', 'guest', o.created_at
FROM online_orders o
WHERE NOT EXISTS (
  SELECT 1 FROM online_order_events e WHERE e.online_order_id = o.id
);

-- Второе — последнее известное решение. Промежуточные шаги старых
-- заявок не восстановимы, поэтому их и не пишем.
INSERT INTO online_order_events (
  org_id, location_id, online_order_id, status, reason,
  actor_kind, actor_member, actor_staff, actor_name, created_at
)
SELECT
  o.org_id, o.location_id, o.id, o.status,
  CASE WHEN o.status IN ('rejected', 'cancelled') THEN o.reject_reason END,
  CASE
    WHEN o.decided_by_member IS NOT NULL THEN 'backoffice'
    WHEN o.decided_by IS NOT NULL THEN 'pos'
    ELSE 'system'
  END,
  o.decided_by_member, o.decided_by,
  COALESCE(m.display_name, s.name),
  COALESCE(o.decided_at, o.created_at)
FROM online_orders o
LEFT JOIN organization_members m ON m.id = o.decided_by_member
LEFT JOIN staff s ON s.id = o.decided_by
WHERE o.status <> 'new'
  AND NOT EXISTS (
    SELECT 1 FROM online_order_events e
    WHERE e.online_order_id = o.id AND e.status = o.status
  );

-- ============================================================
-- ОТКАТ / ВОССТАНОВЛЕНИЕ
--
-- Forward-only. Журнал не удаляется: это аудит. Функциональный откат —
-- снять триггер новой миграцией:
--   DROP TRIGGER trg_online_orders_events ON online_orders;
-- Записанное останется, новые переходы перестанут журналироваться.
--
-- ПРОВЕРКА на целевой базе:
--   SELECT status, actor_kind, COUNT(*)
--   FROM online_order_events GROUP BY 1, 2 ORDER BY 1;
--   -- у каждой заявки минимум одно событие:
--   SELECT COUNT(*) FROM online_orders o
--   WHERE NOT EXISTS (SELECT 1 FROM online_order_events e
--                     WHERE e.online_order_id = o.id);   -- 0
-- ============================================================
