-- ============================================================
-- 121 GUEST CRM — бронь и гость становятся одной записью.
--
-- МОТИВ. Профилей гостя было ДВА, и они не знали друг о друге:
--   * `guests` (031/113–115) — телефон, имя, заметка, балансы, визиты и
--     траты. Заполняется продажами и онлайн-заказами;
--   * `guest_history(phone)` (063) — пять агрегатов, посчитанных по
--     таблице `reservations` на лету.
-- Гость, который бронирует стол каждую неделю, в базе клиентов не
-- появлялся вовсе, а хостес, глядя на бронь, не видел ни заметки, ни
-- трат, ни того, что человек дважды не пришёл.
--
-- Здесь бронь получает `guest_id`, и профиль становится один:
--   1. `reservations.guest_id` + триггер: гость находится или заводится
--      по нормализованному телефону в пределах организации тем же
--      `upsert_guest_by_phone` (113), которым пользуются онлайн-заказы.
--      Один вход — один профиль, дублей не возникает;
--   2. `guests.tags` — внутренние метки (VIP, аккуратно с аллергией,
--      дважды не пришёл). Наружу не отдаются НИКОГДА: публичный контур
--      таблицу `guests` не читает вообще, а колоночных грантов на теги
--      нет — только RPC;
--   3. `guest_audit` — кто и когда менял имя, заметку и метки. Пишется
--      ТРИГГЕРОМ, а не телом RPC: прямой UPDATE из клиента (он разрешён
--      колоночным грантом с 114) иначе обходил бы аудит молча;
--   4. `guest_history` v2 и `get_guest_card` v2 — визиты, отмены,
--      неявки, будущие брони, любимая зона и типичный размер компании.
--      Денежная часть остаётся из POS и просто отсутствует у точки без
--      кассы — standalone Reserve от этого не ломается.
--
-- ⚠️ ТРЕБУЕТ 113 (upsert_guest_by_phone), 114 (get_guest_card).
-- ============================================================

-- ── 1. Бронь ↔ гость ─────────────────────────────────────────
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS guest_id UUID REFERENCES guests(id);

CREATE INDEX IF NOT EXISTS idx_reservations_guest
  ON reservations(guest_id, reserved_at DESC) WHERE guest_id IS NOT NULL;

COMMENT ON COLUMN reservations.guest_id IS
  'Профиль гостя (121). Заполняется триггером по нормализованному телефону тем же upsert_guest_by_phone, что и онлайн-заказы — один профиль на человека в организации.';

/**
 * Привязка брони к профилю. BEFORE INSERT, чтобы значение попало в саму
 * строку. Телефон пустой (walk-in без номера) — привязки нет, и это
 * нормально: анонимный гость профиля не заводит.
 */
CREATE OR REPLACE FUNCTION _link_reservation_guest()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_phone TEXT := regexp_replace(COALESCE(NEW.customer_phone, ''), '\D', '', 'g');
BEGIN
  IF NEW.guest_id IS NULL AND LENGTH(v_phone) >= 6 THEN
    NEW.guest_id := upsert_guest_by_phone(NEW.org_id, v_phone, NEW.customer_name);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_reservation_guest ON reservations;
CREATE TRIGGER trg_reservation_guest
  BEFORE INSERT ON reservations
  FOR EACH ROW EXECUTE FUNCTION _link_reservation_guest();

-- Бэкфилл: у существующих броней профиль появляется задним числом.
DO $$
DECLARE
  v_r     RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR v_r IN
    SELECT id, org_id, customer_phone, customer_name
    FROM reservations
    WHERE guest_id IS NULL
      AND LENGTH(regexp_replace(COALESCE(customer_phone, ''), '\D', '', 'g')) >= 6
    ORDER BY created_at
  LOOP
    UPDATE reservations
    SET guest_id = upsert_guest_by_phone(
      v_r.org_id,
      regexp_replace(v_r.customer_phone, '\D', '', 'g'),
      v_r.customer_name)
    WHERE id = v_r.id;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE '121: связано броней с профилями гостей — %.', v_count;
END $$;

-- ── 2. Внутренние метки ──────────────────────────────────────
ALTER TABLE guests ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN guests.tags IS
  'Внутренние метки гостя (121): VIP, постоянный, аллергия, дважды не пришёл. Наружу не отдаются; правятся только через set_guest_profile.';

-- Колоночного гранта на теги НЕТ сознательно: правка только через RPC.

-- ── 3. Аудит изменений профиля ───────────────────────────────
CREATE TABLE IF NOT EXISTS guest_audit (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  guest_id   UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  field      TEXT NOT NULL CHECK (field IN ('name', 'notes', 'tags')),
  old_value  TEXT,
  new_value  TEXT,
  -- Кто: устройство/веб-пользователь есть всегда, сотрудник — если
  -- операция шла через RPC со staff-сессией.
  auth_user  UUID,
  staff_id   UUID REFERENCES staff(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guest_audit_guest
  ON guest_audit(guest_id, changed_at DESC);

ALTER TABLE guest_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY guest_audit_select ON guest_audit
  FOR SELECT TO authenticated USING (org_id = auth_org_id());

REVOKE ALL ON guest_audit FROM anon;
REVOKE INSERT, UPDATE, DELETE ON guest_audit FROM authenticated;
GRANT SELECT ON guest_audit TO authenticated, service_role;

COMMENT ON TABLE guest_audit IS
  'Аудит правок профиля гостя (121). Пишется триггером, поэтому прямой UPDATE из клиента его не обходит.';

/**
 * Аудит правок. ТРИГГЕР, а не тело RPC: колоночный грант 114 разрешает
 * клиенту менять name/notes напрямую, и аудит в RPC был бы обходимым —
 * то есть не аудитом. Сотрудник берётся из транзакционной переменной,
 * которую выставляет set_guest_profile; прямой путь оставляет только
 * auth-пользователя, и это честнее, чем NULL везде.
 */
CREATE OR REPLACE FUNCTION _audit_guest_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_staff UUID := NULLIF(current_setting('app.actor_staff', TRUE), '')::UUID;
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    INSERT INTO guest_audit (org_id, guest_id, field, old_value, new_value, auth_user, staff_id)
    VALUES (NEW.org_id, NEW.id, 'name', OLD.name, NEW.name, auth.uid(), v_staff);
  END IF;
  IF NEW.notes IS DISTINCT FROM OLD.notes THEN
    INSERT INTO guest_audit (org_id, guest_id, field, old_value, new_value, auth_user, staff_id)
    VALUES (NEW.org_id, NEW.id, 'notes', OLD.notes, NEW.notes, auth.uid(), v_staff);
  END IF;
  IF NEW.tags IS DISTINCT FROM OLD.tags THEN
    INSERT INTO guest_audit (org_id, guest_id, field, old_value, new_value, auth_user, staff_id)
    VALUES (NEW.org_id, NEW.id, 'tags',
            array_to_string(OLD.tags, ', '), array_to_string(NEW.tags, ', '),
            auth.uid(), v_staff);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_guest_audit ON guests;
CREATE TRIGGER trg_guest_audit
  AFTER UPDATE OF name, notes, tags ON guests
  FOR EACH ROW EXECUTE FUNCTION _audit_guest_change();

-- ── 4. Правка профиля с проверкой прав ───────────────────────
/**
 * Имя, заметка и метки одним вызовом. NULL = «не менять».
 * Право — `manage` (кассовая PIN-сессия либо членство в кабинете),
 * тот же единый гейт, что у настроек и меню.
 */
CREATE OR REPLACE FUNCTION set_guest_profile(
  p_guest_id      UUID,
  p_name          TEXT    DEFAULT NULL,
  p_notes         TEXT    DEFAULT NULL,
  p_tags          TEXT[]  DEFAULT NULL,
  p_staff_session UUID    DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_staff UUID;
  v_guest guests%ROWTYPE;
  v_tags  TEXT[];
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  v_staff := require_backoffice_or_staff(p_staff_session, 'manage');

  SELECT * INTO v_guest FROM guests WHERE id = p_guest_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'guest not found';
  END IF;

  -- Метки: чистим пустые, режем длину, снимаем дубли и держим потолок —
  -- список меток не должен превращаться в свалку свободного текста.
  IF p_tags IS NOT NULL THEN
    SELECT COALESCE(array_agg(DISTINCT LEFT(TRIM(x), 24)), '{}')
    INTO v_tags
    FROM unnest(p_tags) AS x
    WHERE TRIM(COALESCE(x, '')) <> '';
    IF cardinality(v_tags) > 12 THEN
      RAISE EXCEPTION 'too_many_tags';
    END IF;
  END IF;

  -- Сотрудник для аудита: триггер прочитает его из этой переменной.
  PERFORM set_config('app.actor_staff', COALESCE(v_staff::TEXT, ''), TRUE);

  UPDATE guests
  SET name  = COALESCE(NULLIF(LEFT(TRIM(p_name), 60), ''), name),
      notes = CASE WHEN p_notes IS NULL THEN notes
                   ELSE NULLIF(LEFT(TRIM(p_notes), 500), '') END,
      tags  = COALESCE(v_tags, tags)
  WHERE id = p_guest_id;

  RETURN jsonb_build_object('guest_id', p_guest_id);
END $$;

REVOKE ALL ON FUNCTION set_guest_profile(UUID, TEXT, TEXT, TEXT[], UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_guest_profile(UUID, TEXT, TEXT, TEXT[], UUID)
  TO authenticated, service_role;

-- ── 5. Ресторанная статистика гостя ──────────────────────────
/**
 * Поведение гостя по броням: визиты, отмены, неявки, будущее, любимая
 * зона, типичный размер компании. Отдельная функция, потому что её
 * зовут два места — карточка клиента и стол хостес, — и считаться она
 * должна одинаково.
 */
CREATE OR REPLACE FUNCTION guest_reservation_stats(p_guest_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'total',      COUNT(*),
    -- Состоявшийся визит: явно завершён либо подтверждён и уже прошёл.
    'visits',     COUNT(*) FILTER (
                    WHERE status = 'completed'
                       OR (status = 'confirmed' AND reserved_at < NOW())),
    'upcoming',   COUNT(*) FILTER (
                    WHERE status IN ('new', 'confirmed') AND reserved_at >= NOW()),
    'cancelled',  COUNT(*) FILTER (WHERE status = 'cancelled'),
    'rejected',   COUNT(*) FILTER (WHERE status = 'rejected'),
    'no_shows',   COUNT(*) FILTER (WHERE status = 'no_show'),
    'first_at',   MIN(reserved_at) FILTER (WHERE status <> 'rejected'),
    'last_at',    MAX(reserved_at) FILTER (
                    WHERE status = 'completed'
                       OR (status = 'confirmed' AND reserved_at < NOW())),
    'avg_party',  ROUND(AVG(party_size) FILTER (WHERE status <> 'rejected'), 1),
    'zone',       (SELECT tz.name
                   FROM reservations r2
                   JOIN table_zones tz ON tz.id = r2.zone_id
                   WHERE r2.guest_id = p_guest_id
                   GROUP BY tz.name
                   ORDER BY COUNT(*) DESC, tz.name
                   LIMIT 1),
    'notes',      COALESCE((
                   SELECT jsonb_agg(note ORDER BY reserved_at DESC)
                   FROM (
                     SELECT note, reserved_at FROM reservations
                     WHERE guest_id = p_guest_id
                       AND note IS NOT NULL AND TRIM(note) <> ''
                     ORDER BY reserved_at DESC LIMIT 5
                   ) n), '[]'::jsonb)
  )
  FROM reservations
  WHERE guest_id = p_guest_id
    AND org_id = auth_org_id()
$$;

REVOKE ALL ON FUNCTION guest_reservation_stats(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION guest_reservation_stats(UUID) TO authenticated, service_role;

-- ── 6. guest_history v2: узнавание гостя на брони ────────────
-- Тело 063 заменено: теперь это тонкая обёртка над профилем. Сигнатура
-- прежняя (телефон), поэтому выложенный клиент кассы продолжает работать,
-- но получает вдобавок guest_id, заметку, метки и полную статистику.
CREATE OR REPLACE FUNCTION guest_history(p_phone TEXT)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_phone TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_guest guests%ROWTYPE;
  v_stats JSONB;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF LENGTH(v_phone) < 6 THEN
    RETURN json_build_object('visits', 0, 'cancelled', 0, 'total', 0,
                             'last_at', NULL, 'name', NULL,
                             'notes', '[]'::json, 'tags', '[]'::json);
  END IF;

  SELECT * INTO v_guest FROM guests WHERE org_id = v_org AND phone = v_phone;
  IF NOT FOUND THEN
    RETURN json_build_object('visits', 0, 'cancelled', 0, 'total', 0,
                             'last_at', NULL, 'name', NULL,
                             'notes', '[]'::json, 'tags', '[]'::json);
  END IF;

  v_stats := guest_reservation_stats(v_guest.id);

  RETURN json_build_object(
    -- Прежние ключи 063 — клиент кассы читает именно их
    'visits',    COALESCE((v_stats ->> 'visits')::INTEGER, 0),
    'cancelled', COALESCE((v_stats ->> 'cancelled')::INTEGER, 0)
                 + COALESCE((v_stats ->> 'rejected')::INTEGER, 0),
    'total',     COALESCE((v_stats ->> 'total')::INTEGER, 0),
    'last_at',   v_stats ->> 'last_at',
    'name',      v_guest.name,
    'notes',     COALESCE(v_stats -> 'notes', '[]'::jsonb),
    -- Новое (121): профиль целиком, чтобы хостес видел контекст сразу
    'guest_id',  v_guest.id,
    'guest_note', v_guest.notes,
    'tags',      to_jsonb(v_guest.tags),
    'no_shows',  COALESCE((v_stats ->> 'no_shows')::INTEGER, 0),
    'upcoming',  COALESCE((v_stats ->> 'upcoming')::INTEGER, 0),
    'avg_party', v_stats ->> 'avg_party',
    'zone',      v_stats ->> 'zone',
    -- Денежная часть есть только там, где работает касса
    'total_spent', v_guest.total_spent,
    'pos_visits',  v_guest.visits
  );
END $$;

REVOKE ALL ON FUNCTION guest_history(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION guest_history(TEXT) TO authenticated, service_role;

-- ── 7. Карточка клиента: + ресторанный блок ──────────────────
-- Тело 115 повторено ДОСЛОВНО (forward-only), добавлены только `tags`
-- и блок `reservations`. Переписывать тело заново нельзя: в первой
-- редакции этой миграции так потерялся ключ `favorites` и фильтр
-- статусов заказа — поймано существующим тестом guest_crm.
CREATE OR REPLACE FUNCTION get_guest_card(
  p_guest_id UUID,
  p_limit    INTEGER DEFAULT 20
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_guest    guests%ROWTYPE;
  v_limit    INTEGER := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_orders   JSONB;
  v_favs     JSONB;
  v_events   JSONB;
  v_mode     TEXT;
BEGIN
  -- RLS сама отсечёт чужую org: guests_all скоупит по auth_org_id()
  SELECT * INTO v_guest FROM guests WHERE id = p_guest_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'guest not found';
  END IF;

  -- Последние заказы с позициями. Отменённые строки (voided_at) в состав
  -- не попадают — гость их не покупал, но сам заказ показываем.
  SELECT COALESCE(jsonb_agg(o ORDER BY o.created_at DESC), '[]'::jsonb)
  INTO v_orders
  FROM (
    SELECT
      ord.id,
      ord.daily_number,
      ord.total,
      ord.status,
      ord.created_at,
      ord.loyalty_discount,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'name',         oi.name,
          'variant_name', oi.variant_name,
          'qty',          oi.qty,
          'line_total',   oi.line_total
        ) ORDER BY oi.name)
        FROM order_items oi
        WHERE oi.order_id = ord.id AND oi.voided_at IS NULL
      ), '[]'::jsonb) AS items
    FROM orders ord
    WHERE ord.guest_id = p_guest_id
    ORDER BY ord.created_at DESC
    LIMIT v_limit
  ) o;

  -- Любимые позиции: топ-5 по суммарному количеству за всё время
  SELECT COALESCE(jsonb_agg(f ORDER BY f.qty DESC), '[]'::jsonb)
  INTO v_favs
  FROM (
    SELECT oi.name, SUM(oi.qty)::INTEGER AS qty
    FROM order_items oi
    JOIN orders ord ON ord.id = oi.order_id
    WHERE ord.guest_id = p_guest_id
      AND oi.voided_at IS NULL
      AND ord.status IN ('paid', 'fulfilled')
    GROUP BY oi.name
    ORDER BY SUM(oi.qty) DESC
    LIMIT 5
  ) f;

  -- Движения баллов/штампов (031): начисления, списания, коррекции
  SELECT COALESCE(jsonb_agg(e ORDER BY e.created_at DESC), '[]'::jsonb)
  INTO v_events
  FROM (
    SELECT le.kind, le.stamps_delta, le.points_delta, le.created_at, le.order_id
    FROM loyalty_events le
    WHERE le.guest_id = p_guest_id
    ORDER BY le.created_at DESC
    LIMIT v_limit
  ) e;

  -- 115: режим программы — с точки последнего заказа, иначе любой точки org
  SELECT l.loyalty_mode INTO v_mode
  FROM orders ord
  JOIN locations l ON l.id = ord.location_id
  WHERE ord.guest_id = p_guest_id
  ORDER BY ord.created_at DESC
  LIMIT 1;

  IF v_mode IS NULL THEN
    SELECT l.loyalty_mode INTO v_mode
    FROM locations l
    WHERE l.org_id = v_guest.org_id
    ORDER BY l.created_at
    LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'id',            v_guest.id,
    'phone',         v_guest.phone,
    'name',          v_guest.name,
    'notes',         v_guest.notes,
    'tags',          to_jsonb(v_guest.tags),
    'stamps',        v_guest.stamps,
    'points',        v_guest.points,
    'visits',        v_guest.visits,
    'total_spent',   v_guest.total_spent,
    'last_visit_at', v_guest.last_visit_at,
    'created_at',    v_guest.created_at,
    'loyalty_mode',  COALESCE(v_mode, 'off'),
    'orders',        v_orders,
    'favorites',     v_favs,
    'events',        v_events,
    -- Ресторанный блок (121). У точки без POS orders/favorites
    -- пусты, а этот блок полон — профиль остаётся осмысленным
    -- и без кассы, то есть standalone Reserve не ломается.
    'reservations',  guest_reservation_stats(p_guest_id)
  );
END $$;

REVOKE EXECUTE ON FUNCTION get_guest_card(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_guest_card(UUID, INTEGER) TO authenticated;

-- ============================================================
-- ОТКАТ / ВОССТАНОВЛЕНИЕ
--
-- Forward-only, ничего не удаляется. `reservations.guest_id` производна
-- от телефона и пересобирается:
--
--   UPDATE reservations SET guest_id = NULL WHERE guest_id IS NOT NULL;
--   -- затем повторить DO-блок бэкфилла из этой миграции
--
-- Отключить привязку: DROP TRIGGER trg_reservation_guest ON reservations;
-- (существующие связи и статистика сохранятся).
--
-- ПРОВЕРОЧНЫЕ ЗАПРОСЫ:
--   -- брони с телефоном, но без профиля (ожидается 0)
--   SELECT COUNT(*) FROM reservations
--   WHERE guest_id IS NULL
--     AND LENGTH(regexp_replace(COALESCE(customer_phone,''), '\D', '', 'g')) >= 6;
--
--   -- дубли профилей по телефону (ожидается 0 строк)
--   SELECT org_id, phone, COUNT(*) FROM guests GROUP BY 1, 2 HAVING COUNT(*) > 1;
--
--   -- аудит пишется и на прямой UPDATE
--   UPDATE guests SET notes = 'проверка' WHERE id = '<guest>';
--   SELECT field, old_value, new_value, auth_user, staff_id
--   FROM guest_audit WHERE guest_id = '<guest>' ORDER BY changed_at DESC LIMIT 1;
-- ============================================================
