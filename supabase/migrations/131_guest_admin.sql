-- ============================================================
-- 131. Клиентская база: правка профиля, дубли, слияние, приватность.
--
-- Раздел «Customers» в кабинете (114/115/121) умел только читать: имя и
-- заметку правили на терминале, телефон не правился нигде, а один и тот
-- же человек жил двумя записями — «0501234567» с сайта и «972501234567»
-- из брони. Владелец видел двух гостей с половиной истории у каждого и
-- не мог ни объединить их, ни удалить данные по просьбе клиента.
--
-- Что здесь появляется:
--   * телефон в set_guest_profile — с проверкой занятости, а не «упало
--     нарушение уникальности»;
--   * дубли: одинаковый номер без кода страны и одинаковое имя;
--   * слияние: история переезжает к оставшемуся профилю, исходный
--     остаётся указателем (merged_into), перенос записан пообъектно;
--   * анонимизация: личные данные стираются, ФИНАНСОВЫЕ ЗАПИСИ — НЕТ.
--
-- Три решения, которые важнее кода:
--
-- 1. Слияние НЕ УДАЛЯЕТ исходного гостя. Он остаётся строкой с
--    merged_into: старый номер продолжает узнавать человека (заказ с
--    сайта по нему попадёт в объединённый профиль), а сам перенос
--    восстановим по guest_merges — там лежат id всех переехавших
--    записей, а не только счётчики.
--
-- 2. Анонимизация — не удаление. Заказы, чеки и их customer_name/phone
--    остаются: это документы налогового учёта (docs/israel-compliance.md),
--    их нельзя стирать по просьбе клиента. Стирается профиль и то, что
--    висит на нём операционно: брони, лист ожидания, очередь уведомлений
--    и СОДЕРЖИМОЕ аудита правок — иначе «забыли» означало бы «имя лежит
--    в guest_audit».
--
-- 3. Правка профиля становится RPC-only: колоночные гранты UPDATE
--    (031/114) отзываются. Аудит и так писался триггером, но с грантом
--    клиент мог менять имя в обход проверки прав — теперь не может.
--
-- ⚠️ ТРЕБУЕТ 113 (upsert_guest_by_phone), 114 (get_backoffice_guests),
--    121 (guest_audit, set_guest_profile), 122 (waitlist_entries).
-- ============================================================

-- ── 1. Состояния профиля ────────────────────────────────────
ALTER TABLE guests ADD COLUMN IF NOT EXISTS merged_into   UUID REFERENCES guests(id);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS merged_at     TIMESTAMPTZ;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

COMMENT ON COLUMN guests.merged_into IS
  'Профиль объединён с другим (131). Строка остаётся: её телефон продолжает узнавать человека и ведёт в объединённый профиль.';
COMMENT ON COLUMN guests.anonymized_at IS
  'Личные данные стёрты по просьбе клиента (131). Заказы и чеки остаются — это документы учёта.';

-- Списки кабинета и поиск кассы отсекают объединённых и анонимных
CREATE INDEX IF NOT EXISTS idx_guests_live
  ON guests(org_id, last_visit_at DESC)
  WHERE merged_into IS NULL AND anonymized_at IS NULL;

-- ── 2. Журнал слияний ───────────────────────────────────────
/**
 * Пообъектный след переноса. Счётчиков мало: без списка id нельзя
 * ответить на вопрос «какие заказы приехали сюда из второго профиля»,
 * а значит нельзя и разъединить ошибочное слияние.
 */
CREATE TABLE IF NOT EXISTS guest_merges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  target_id     UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  source_id     UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  orders        UUID[] NOT NULL DEFAULT '{}',
  loyalty       UUID[] NOT NULL DEFAULT '{}',
  reservations  UUID[] NOT NULL DEFAULT '{}',
  waitlist      UUID[] NOT NULL DEFAULT '{}',
  -- Балансы исходного профиля на момент слияния: они переезжают
  -- суммой, и без снимка «сколько было» перенос необратим.
  balances      JSONB NOT NULL DEFAULT '{}'::jsonb,
  auth_user     UUID,
  staff_id      UUID REFERENCES staff(id),
  merged_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guest_merges_target
  ON guest_merges(target_id, merged_at DESC);

ALTER TABLE guest_merges ENABLE ROW LEVEL SECURITY;

CREATE POLICY guest_merges_select ON guest_merges
  FOR SELECT TO authenticated USING (org_id = auth_org_id());

REVOKE ALL ON guest_merges FROM anon;
REVOKE INSERT, UPDATE, DELETE ON guest_merges FROM authenticated;
GRANT SELECT ON guest_merges TO authenticated, service_role;

COMMENT ON TABLE guest_merges IS
  'След слияния профилей гостей (131): что именно переехало и какие балансы были у исходного.';

-- ── 3. Аудит: телефон, слияние, анонимизация ────────────────
ALTER TABLE guest_audit DROP CONSTRAINT IF EXISTS guest_audit_field_check;
ALTER TABLE guest_audit ADD CONSTRAINT guest_audit_field_check
  CHECK (field IN ('name', 'notes', 'tags', 'phone', 'merge', 'anonymize'));

/**
 * Триггер аудита + телефон. Он по-прежнему единственный честный путь:
 * что бы ни меняло профиль — RPC, миграция, ручной SQL — запись будет.
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
  IF NEW.phone IS DISTINCT FROM OLD.phone THEN
    INSERT INTO guest_audit (org_id, guest_id, field, old_value, new_value, auth_user, staff_id)
    VALUES (NEW.org_id, NEW.id, 'phone', OLD.phone, NEW.phone, auth.uid(), v_staff);
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
  AFTER UPDATE OF name, notes, tags, phone ON guests
  FOR EACH ROW EXECUTE FUNCTION _audit_guest_change();

-- ── 4. Правка профиля: телефон и RPC-only ───────────────────
-- Старая сигнатура удаляется: с новым параметром по умолчанию PostgREST
-- получил бы две подходящие функции и отказал бы «is not unique».
DROP FUNCTION IF EXISTS set_guest_profile(UUID, TEXT, TEXT, TEXT[], UUID);

/**
 * Имя, телефон, заметка и метки одним вызовом. NULL = «не менять».
 * Право — `manage` (кассовая PIN-сессия либо членство в кабинете).
 *
 * Телефон — ключ узнавания человека: заказы с сайта, брони и лист
 * ожидания находят профиль по нему. Поэтому занятый номер отдаёт
 * `phone_taken` (кабинет предложит слияние), а не нарушение
 * уникальности, и короткий мусор не принимается вовсе.
 */
CREATE OR REPLACE FUNCTION set_guest_profile(
  p_guest_id      UUID,
  p_name          TEXT    DEFAULT NULL,
  p_notes         TEXT    DEFAULT NULL,
  p_tags          TEXT[]  DEFAULT NULL,
  p_staff_session UUID    DEFAULT NULL,
  p_phone         TEXT    DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org    UUID := auth_org_id();
  v_staff  UUID;
  v_guest  guests%ROWTYPE;
  v_tags   TEXT[];
  v_digits TEXT;
  v_other  UUID;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  v_staff := require_backoffice_or_staff(p_staff_session, 'manage');

  SELECT * INTO v_guest FROM guests WHERE id = p_guest_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'guest not found';
  END IF;
  -- Указатель и стёртый профиль не редактируются: правка ушла бы в
  -- никуда (у объединённого историю ведёт другой профиль) или вернула
  -- бы в базу то, что клиент просил удалить.
  IF v_guest.merged_into IS NOT NULL THEN
    RAISE EXCEPTION 'guest_merged';
  END IF;
  IF v_guest.anonymized_at IS NOT NULL THEN
    RAISE EXCEPTION 'guest_anonymized';
  END IF;

  IF p_phone IS NOT NULL THEN
    v_digits := regexp_replace(p_phone, '\D', '', 'g');
    IF length(v_digits) < 7 THEN
      RAISE EXCEPTION 'phone_invalid';
    END IF;
    SELECT id INTO v_other FROM guests
    WHERE org_id = v_org AND phone = v_digits AND id <> p_guest_id;
    IF v_other IS NOT NULL THEN
      RAISE EXCEPTION 'phone_taken';
    END IF;
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
      phone = COALESCE(v_digits, phone),
      notes = CASE WHEN p_notes IS NULL THEN notes
                   ELSE NULLIF(LEFT(TRIM(p_notes), 500), '') END,
      tags  = COALESCE(v_tags, tags)
  WHERE id = p_guest_id;

  RETURN jsonb_build_object('guest_id', p_guest_id);
END $$;

REVOKE ALL ON FUNCTION set_guest_profile(UUID, TEXT, TEXT, TEXT[], UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_guest_profile(UUID, TEXT, TEXT, TEXT[], UUID, TEXT)
  TO authenticated, service_role;

COMMENT ON FUNCTION set_guest_profile(UUID, TEXT, TEXT, TEXT[], UUID, TEXT) IS
  'Правка профиля гостя (121, телефон с 131): единственный путь — колоночные гранты UPDATE отозваны.';

-- Правка профиля только через RPC: с колоночным грантом клиент мог
-- менять имя и телефон в обход проверки прав (аудит-то писался, но
-- «записано» не значит «разрешено»). INSERT остаётся — гостя заводит
-- касса прямой вставкой (031).
REVOKE UPDATE (phone, name, notes) ON guests FROM authenticated;

-- ── 5. Узнавание по телефону следует за слиянием ────────────
/**
 * Конец цепочки слияний: A→B→C вернёт C. Шагов не больше десяти —
 * цикл невозможен (слить уже объединённого профиля нельзя), но
 * бесконечный цикл в горячем пути онлайн-заказа недопустим и в теории.
 */
CREATE OR REPLACE FUNCTION resolve_guest_id(p_guest_id UUID)
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id    UUID := p_guest_id;
  v_next  UUID;
  v_steps INTEGER := 0;
BEGIN
  LOOP
    SELECT merged_into INTO v_next FROM guests WHERE id = v_id;
    EXIT WHEN v_next IS NULL OR v_steps >= 10;
    v_id := v_next;
    v_steps := v_steps + 1;
  END LOOP;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION resolve_guest_id(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION resolve_guest_id(UUID) TO authenticated, service_role;

/**
 * Онлайн-заказ или бронь по СТАРОМУ номеру должны попасть в тот же
 * профиль, куда его объединили. Иначе слияние жило бы ровно до
 * следующего заказа, а история снова раздваивалась.
 */
CREATE OR REPLACE FUNCTION upsert_guest_by_phone(
  p_org_id UUID,
  p_phone  TEXT,
  p_name   TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_digits   TEXT;
  v_guest_id UUID;
BEGIN
  -- Телефон-ключ хранится одними цифрами (нормализация клиента, 031):
  -- повторяем её на сервере, иначе '050-123' и '050123' разойдутся.
  v_digits := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  IF length(v_digits) < 7 THEN
    RETURN NULL;
  END IF;

  INSERT INTO guests (org_id, phone, name)
  VALUES (p_org_id, v_digits, NULLIF(TRIM(COALESCE(p_name, '')), ''))
  ON CONFLICT (org_id, phone) DO UPDATE
    -- Имя дополняем, но НЕ затираем: в кассе его могли уточнить вручную
    SET name = COALESCE(guests.name, EXCLUDED.name)
  RETURNING id INTO v_guest_id;

  RETURN resolve_guest_id(v_guest_id);
END $$;

REVOKE ALL ON FUNCTION upsert_guest_by_phone(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

/**
 * Узнавание гостя на брони (063/121) тоже идёт по телефону, поэтому и
 * оно обязано следовать за слиянием: иначе постоянный клиент, чей
 * второй номер объединили, приходил бы к хостес «впервые».
 *
 * Тело 121 повторено, изменений два: разворот цепочки merged_into и
 * пустой ответ на стёртый профиль — забытый гость не должен всплывать
 * историей, если номер кто-то введёт вручную.
 */
CREATE OR REPLACE FUNCTION guest_history(p_phone TEXT)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_phone TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_guest guests%ROWTYPE;
  v_stats JSONB;
  v_empty JSON := json_build_object('visits', 0, 'cancelled', 0, 'total', 0,
                                    'last_at', NULL, 'name', NULL,
                                    'notes', '[]'::json, 'tags', '[]'::json);
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF LENGTH(v_phone) < 6 THEN
    RETURN v_empty;
  END IF;

  SELECT * INTO v_guest FROM guests WHERE org_id = v_org AND phone = v_phone;
  IF NOT FOUND THEN
    RETURN v_empty;
  END IF;

  IF v_guest.merged_into IS NOT NULL THEN
    SELECT * INTO v_guest FROM guests WHERE id = resolve_guest_id(v_guest.id);
  END IF;
  IF v_guest.anonymized_at IS NOT NULL THEN
    RETURN v_empty;
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

-- ── 6. Список клиентов: сегменты и сортировка ───────────────
DROP FUNCTION IF EXISTS get_backoffice_guests(TEXT, INTEGER, UUID);

/**
 * Список для раздела «Customers». Кроме поиска — сегменты: метки,
 * визиты, сумма, «был за N дней» и «пропал на N дней». Считает сервер:
 * иначе фильтр работал бы по первой странице, а не по базе.
 *
 * Объединённые и анонимные профили в список не попадают: первый —
 * указатель, второй — стёртая запись, работать с ними не с чем.
 */
CREATE OR REPLACE FUNCTION get_backoffice_guests(
  p_search        TEXT    DEFAULT NULL,
  p_limit         INTEGER DEFAULT 100,
  p_staff_session UUID    DEFAULT NULL,
  p_tags          TEXT[]  DEFAULT NULL,
  p_min_visits    INTEGER DEFAULT NULL,
  p_min_spent     INTEGER DEFAULT NULL,
  p_seen_days     INTEGER DEFAULT NULL,
  p_inactive_days INTEGER DEFAULT NULL,
  p_sort          TEXT    DEFAULT 'recent'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  -- Потолок выше прежнего: тем же вызовом кабинет выгружает CSV,
  -- и выгрузка обязана содержать сегмент целиком, а не его начало.
  v_limit  INTEGER := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 5000);
  v_q      TEXT    := NULLIF(TRIM(COALESCE(p_search, '')), '');
  v_sort   TEXT    := COALESCE(NULLIF(TRIM(COALESCE(p_sort, '')), ''), 'recent');
  v_tags   TEXT[]  := CASE WHEN COALESCE(cardinality(p_tags), 0) = 0 THEN NULL ELSE p_tags END;
  v_digits TEXT;
  v_result JSONB;
BEGIN
  IF COALESCE(auth_backoffice_role(), '') NOT IN ('owner', 'manager') THEN
    PERFORM require_staff_perm(p_staff_session, 'manage');
  END IF;

  v_digits := regexp_replace(COALESCE(v_q, ''), '\D', '', 'g');

  SELECT COALESCE(jsonb_agg(to_jsonb(g) - 'rn' ORDER BY g.rn), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT
      id, phone, name, notes, tags, stamps, points, visits, total_spent,
      last_visit_at, created_at,
      ROW_NUMBER() OVER (ORDER BY
        CASE WHEN v_sort = 'spend'  THEN total_spent END DESC NULLS LAST,
        CASE WHEN v_sort = 'visits' THEN visits      END DESC NULLS LAST,
        CASE WHEN v_sort = 'new'    THEN created_at  END DESC NULLS LAST,
        CASE WHEN v_sort = 'name'   THEN lower(COALESCE(name, phone)) END ASC NULLS LAST,
        last_visit_at DESC NULLS LAST,
        created_at DESC
      ) AS rn
    FROM guests
    WHERE merged_into IS NULL
      AND anonymized_at IS NULL
      AND (v_q IS NULL
           OR (length(v_digits) >= 3 AND phone LIKE '%' || v_digits || '%')
           OR (length(v_digits) < 3  AND name ILIKE '%' || v_q || '%'))
      AND (v_tags IS NULL OR tags @> v_tags)
      AND (p_min_visits IS NULL OR visits >= p_min_visits)
      AND (p_min_spent  IS NULL OR total_spent >= p_min_spent)
      AND (p_seen_days  IS NULL
           OR last_visit_at >= NOW() - make_interval(days => p_seen_days))
      -- «Пропал» — про того, кто ходил и перестал. Ни разу не пришедший
      -- не пропадал, и в этот сегмент он не попадает.
      AND (p_inactive_days IS NULL
           OR (last_visit_at IS NOT NULL
               AND last_visit_at < NOW() - make_interval(days => p_inactive_days)))
    ORDER BY rn
    LIMIT v_limit
  ) g;

  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION get_backoffice_guests(TEXT, INTEGER, UUID, TEXT[], INTEGER, INTEGER, INTEGER, INTEGER, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_backoffice_guests(TEXT, INTEGER, UUID, TEXT[], INTEGER, INTEGER, INTEGER, INTEGER, TEXT)
  TO authenticated;

/**
 * Метки, которые реально используются, с числом гостей — чтобы сегменты
 * в кабинете предлагались из данных, а не набирались по памяти.
 */
CREATE OR REPLACE FUNCTION get_guest_tags_web(
  p_staff_session UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF COALESCE(auth_backoffice_role(), '') NOT IN ('owner', 'manager') THEN
    PERFORM require_staff_perm(p_staff_session, 'manage');
  END IF;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.guests DESC, t.tag), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT tag, COUNT(*)::INTEGER AS guests
    FROM guests g, unnest(g.tags) AS tag
    WHERE g.merged_into IS NULL AND g.anonymized_at IS NULL
    GROUP BY tag
    ORDER BY COUNT(*) DESC, tag
    LIMIT 50
  ) t;

  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION get_guest_tags_web(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_guest_tags_web(UUID) TO authenticated;

-- ── 7. Поиск дублей ─────────────────────────────────────────
/**
 * Две причины, по которым один человек живёт двумя записями:
 *
 *   * номер записан по-разному — '0501234567' с кассы и
 *     '972501234567' с сайта; сравниваем последние 9 цифр;
 *   * одинаковое имя при разных номерах — второй телефон, опечатка.
 *
 * Это ПОДСКАЗКА, а не автоматическое слияние: решение принимает
 * владелец, потому что «Дана Леви» бывает и двумя разными людьми.
 */
CREATE OR REPLACE FUNCTION find_guest_duplicates_web(
  p_limit         INTEGER DEFAULT 50,
  p_staff_session UUID    DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_limit  INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_result JSONB;
BEGIN
  IF COALESCE(auth_backoffice_role(), '') NOT IN ('owner', 'manager') THEN
    PERFORM require_staff_perm(p_staff_session, 'manage');
  END IF;

  WITH live AS (
    SELECT
      id, phone, name, tags, stamps, points, visits, total_spent,
      last_visit_at, created_at,
      RIGHT(regexp_replace(phone, '\D', '', 'g'), 9) AS phone_key,
      lower(btrim(COALESCE(name, ''))) AS name_key
    FROM guests
    WHERE merged_into IS NULL AND anonymized_at IS NULL
  ),
  groups AS (
    SELECT 'phone' AS reason, phone_key AS key, array_agg(id) AS ids, COUNT(*) AS n
    FROM live
    WHERE length(phone_key) = 9
    GROUP BY phone_key
    HAVING COUNT(*) > 1
    UNION ALL
    SELECT 'name', name_key, array_agg(id), COUNT(*)
    FROM live
    WHERE length(name_key) >= 3
    GROUP BY name_key
    -- Группа по имени внутри одного номера — это уже группа по телефону
    HAVING COUNT(*) > 1 AND COUNT(DISTINCT phone_key) > 1
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY x.reason, x.key), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT
      gr.reason,
      gr.key,
      (SELECT jsonb_agg(to_jsonb(l) - 'phone_key' - 'name_key'
                        ORDER BY l.total_spent DESC, l.last_visit_at DESC NULLS LAST)
       FROM live l WHERE l.id = ANY(gr.ids)) AS guests
    FROM groups gr
    ORDER BY gr.n DESC, gr.reason, gr.key
    LIMIT v_limit
  ) x;

  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION find_guest_duplicates_web(INTEGER, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION find_guest_duplicates_web(INTEGER, UUID) TO authenticated;

COMMENT ON FUNCTION find_guest_duplicates_web(INTEGER, UUID) IS
  'Подсказка о дублях профилей (131): один номер без кода страны и одинаковое имя. Слияние — отдельное решение владельца.';

-- ── 8. Слияние профилей ─────────────────────────────────────
/**
 * История исходного профиля переезжает к оставшемуся: заказы, движения
 * баллов, брони и лист ожидания. Балансы складываются, метки
 * объединяются, заметки склеиваются — ничего не теряется молча.
 *
 * Исходный профиль ОСТАЁТСЯ строкой-указателем: его телефон продолжает
 * узнавать человека (upsert_guest_by_phone разворачивает цепочку), а
 * guest_merges хранит id всего переехавшего.
 */
CREATE OR REPLACE FUNCTION merge_guests_web(
  p_target_id     UUID,
  p_source_id     UUID,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_staff    UUID;
  v_target   guests%ROWTYPE;
  v_source   guests%ROWTYPE;
  v_orders   UUID[];
  v_events   UUID[];
  v_rsv      UUID[];
  v_wait     UUID[];
  v_tags     TEXT[];
  v_notes    TEXT;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  v_staff := require_backoffice_or_staff(p_staff_session, 'manage');

  IF p_target_id IS NULL OR p_source_id IS NULL OR p_target_id = p_source_id THEN
    RAISE EXCEPTION 'same_guest';
  END IF;

  -- Блокируем обе строки в порядке id: два одновременных слияния
  -- встречных направлений иначе встанут насмерть.
  PERFORM id FROM guests
  WHERE id IN (p_target_id, p_source_id) AND org_id = v_org
  ORDER BY id FOR UPDATE;

  SELECT * INTO v_target FROM guests WHERE id = p_target_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'guest not found';
  END IF;
  SELECT * INTO v_source FROM guests WHERE id = p_source_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'guest not found';
  END IF;
  IF v_target.merged_into IS NOT NULL OR v_source.merged_into IS NOT NULL THEN
    RAISE EXCEPTION 'guest_merged';
  END IF;
  IF v_target.anonymized_at IS NOT NULL OR v_source.anonymized_at IS NOT NULL THEN
    RAISE EXCEPTION 'guest_anonymized';
  END IF;

  -- Переезд истории. guest_id — связь с профилем, а не сумма: деньги,
  -- позиции и налог в заказах не трогаются (инвариант 2).
  WITH moved AS (
    UPDATE orders SET guest_id = p_target_id
    WHERE guest_id = p_source_id AND org_id = v_org
    RETURNING id
  ) SELECT COALESCE(array_agg(id), '{}') INTO v_orders FROM moved;

  WITH moved AS (
    UPDATE loyalty_events SET guest_id = p_target_id
    WHERE guest_id = p_source_id AND org_id = v_org
    RETURNING id
  ) SELECT COALESCE(array_agg(id), '{}') INTO v_events FROM moved;

  WITH moved AS (
    UPDATE reservations SET guest_id = p_target_id
    WHERE guest_id = p_source_id AND org_id = v_org
    RETURNING id
  ) SELECT COALESCE(array_agg(id), '{}') INTO v_rsv FROM moved;

  WITH moved AS (
    UPDATE waitlist_entries SET guest_id = p_target_id
    WHERE guest_id = p_source_id AND org_id = v_org
    RETURNING id
  ) SELECT COALESCE(array_agg(id), '{}') INTO v_wait FROM moved;

  -- Метки объединяются, потолок тот же, что у правки профиля
  SELECT COALESCE(array_agg(DISTINCT x), '{}')
  INTO v_tags
  FROM unnest(v_target.tags || v_source.tags) AS x;
  IF cardinality(v_tags) > 12 THEN
    v_tags := v_tags[1:12];
  END IF;

  v_notes := CASE
    WHEN v_source.notes IS NULL THEN v_target.notes
    WHEN v_target.notes IS NULL THEN v_source.notes
    WHEN v_target.notes = v_source.notes THEN v_target.notes
    ELSE LEFT(v_target.notes || E'\n' || v_source.notes, 500)
  END;

  PERFORM set_config('app.actor_staff', COALESCE(v_staff::TEXT, ''), TRUE);

  UPDATE guests SET
    name          = COALESCE(v_target.name, v_source.name),
    notes         = v_notes,
    tags          = v_tags,
    stamps        = v_target.stamps      + v_source.stamps,
    points        = v_target.points      + v_source.points,
    visits        = v_target.visits      + v_source.visits,
    total_spent   = v_target.total_spent + v_source.total_spent,
    created_at    = LEAST(v_target.created_at, v_source.created_at),
    last_visit_at = GREATEST(
      COALESCE(v_target.last_visit_at, v_source.last_visit_at),
      COALESCE(v_source.last_visit_at, v_target.last_visit_at))
  WHERE id = p_target_id;

  -- Исходный профиль обнуляется, чтобы его балансы не сосчитались
  -- дважды. «Сколько было» лежит в guest_merges.balances.
  UPDATE guests SET
    merged_into = p_target_id,
    merged_at   = NOW(),
    stamps      = 0,
    points      = 0,
    visits      = 0,
    total_spent = 0
  WHERE id = p_source_id;

  INSERT INTO guest_merges (
    org_id, target_id, source_id, orders, loyalty, reservations, waitlist,
    balances, auth_user, staff_id
  ) VALUES (
    v_org, p_target_id, p_source_id, v_orders, v_events, v_rsv, v_wait,
    jsonb_build_object(
      'stamps',      v_source.stamps,
      'points',      v_source.points,
      'visits',      v_source.visits,
      'total_spent', v_source.total_spent,
      'phone',       v_source.phone),
    auth.uid(), v_staff
  );

  INSERT INTO guest_audit (org_id, guest_id, field, old_value, new_value, auth_user, staff_id)
  VALUES
    (v_org, p_target_id, 'merge', p_source_id::TEXT, p_target_id::TEXT, auth.uid(), v_staff),
    (v_org, p_source_id, 'merge', p_source_id::TEXT, p_target_id::TEXT, auth.uid(), v_staff);

  RETURN jsonb_build_object(
    'guest_id',     p_target_id,
    'orders',       cardinality(v_orders),
    'loyalty',      cardinality(v_events),
    'reservations', cardinality(v_rsv),
    'waitlist',     cardinality(v_wait)
  );
END $$;

REVOKE ALL ON FUNCTION merge_guests_web(UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION merge_guests_web(UUID, UUID, UUID) TO authenticated;

COMMENT ON FUNCTION merge_guests_web(UUID, UUID, UUID) IS
  'Слияние профилей гостей (131): история переезжает, исходный остаётся указателем, перенос записан в guest_merges.';

-- ── 9. Удаление личных данных ───────────────────────────────
/**
 * Просьба клиента «удалите мои данные». Стирается то, что описывает
 * человека: имя, телефон, заметка, метки, контакты в бронях, листе
 * ожидания и очереди уведомлений, а также СОДЕРЖИМОЕ аудита правок —
 * иначе имя осталось бы лежать в guest_audit.old_value.
 *
 * НЕ стираются заказы и чеки: это документы налогового учёта
 * (docs/israel-compliance.md), и требование их хранить сильнее просьбы
 * забыть. Профиль остаётся строкой без личных данных, чтобы отчёты и
 * ссылки заказов не рассыпались.
 *
 * Действие необратимо, поэтому нужен p_confirm_phone: кабинет просит
 * ввести номер, а сервер сверяет его с профилем — промах строкой в
 * списке не должен стирать чужого человека.
 */
CREATE OR REPLACE FUNCTION anonymize_guest_web(
  p_guest_id      UUID,
  p_confirm_phone TEXT,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_staff     UUID;
  v_guest     guests%ROWTYPE;
  v_confirm   TEXT;
  v_upcoming  INTEGER;
  v_rsv       INTEGER := 0;
  v_wait      INTEGER := 0;
  v_notif     INTEGER := 0;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  v_staff := require_backoffice_or_staff(p_staff_session, 'manage');

  SELECT * INTO v_guest FROM guests WHERE id = p_guest_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'guest not found';
  END IF;
  IF v_guest.anonymized_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_anonymized';
  END IF;
  IF v_guest.merged_into IS NOT NULL THEN
    -- У указателя нет своей истории: стирать надо объединённый профиль
    RAISE EXCEPTION 'guest_merged';
  END IF;

  v_confirm := regexp_replace(COALESCE(p_confirm_phone, ''), '\D', '', 'g');
  IF v_confirm = '' OR v_confirm <> v_guest.phone THEN
    RAISE EXCEPTION 'confirm_mismatch';
  END IF;

  -- Будущий визит без контактов — это подстава для хостес: сначала
  -- отмените бронь, потом стирайте.
  SELECT COUNT(*) INTO v_upcoming FROM reservations
  WHERE org_id = v_org
    AND (guest_id = p_guest_id OR customer_phone = v_guest.phone)
    AND status IN ('new', 'confirmed')
    AND reserved_at > NOW();
  IF v_upcoming > 0 THEN
    RAISE EXCEPTION 'has_upcoming_reservation';
  END IF;

  -- Брони: контакты стираем, сам визит остаётся в истории точки.
  -- Ловим и по телефону — брони до 121 не имеют guest_id.
  WITH scrubbed AS (
    UPDATE reservations
    SET customer_name = '—', customer_phone = '', note = NULL
    WHERE org_id = v_org
      AND (guest_id = p_guest_id OR customer_phone = v_guest.phone)
    RETURNING id
  ) SELECT COUNT(*) INTO v_rsv FROM scrubbed;

  WITH scrubbed AS (
    UPDATE waitlist_entries
    SET customer_name = '—', customer_phone = '', note = NULL
    WHERE org_id = v_org
      AND (guest_id = p_guest_id OR customer_phone = v_guest.phone)
    RETURNING id
  ) SELECT COUNT(*) INTO v_wait FROM scrubbed;

  -- Очередь уведомлений: получатель и имя в payload — те же личные
  -- данные. Неотправленное отменяем: адресата больше нет.
  WITH scrubbed AS (
    UPDATE notification_outbox
    SET recipient  = NULL,
        payload    = payload - 'guest_name',
        status     = CASE WHEN status = 'pending' THEN 'skipped' ELSE status END,
        last_error = CASE WHEN status = 'pending' THEN 'guest_anonymized' ELSE last_error END
    WHERE org_id = v_org AND recipient = v_guest.phone
    RETURNING id
  ) SELECT COUNT(*) INTO v_notif FROM scrubbed;

  PERFORM set_config('app.actor_staff', COALESCE(v_staff::TEXT, ''), TRUE);

  -- Телефон нельзя просто очистить: он NOT NULL и уникален в
  -- организации. Ставим заведомо не-номер — по нему никого не найдут,
  -- а прежний ключ освобождается для нового человека.
  UPDATE guests SET
    name          = NULL,
    phone         = 'deleted:' || LEFT(md5(id::TEXT), 12),
    notes         = NULL,
    tags          = '{}',
    anonymized_at = NOW()
  WHERE id = p_guest_id;

  -- Аудит правок хранил СТАРЫЕ значения — то есть имя и телефон.
  -- Оставляем факт правки, убираем содержимое.
  UPDATE guest_audit
  SET old_value = NULL, new_value = NULL
  WHERE guest_id = p_guest_id;

  INSERT INTO guest_audit (org_id, guest_id, field, old_value, new_value, auth_user, staff_id)
  VALUES (v_org, p_guest_id, 'anonymize', NULL, NULL, auth.uid(), v_staff);

  RETURN jsonb_build_object(
    'guest_id',     p_guest_id,
    'reservations', v_rsv,
    'waitlist',     v_wait,
    'notifications', v_notif
  );
END $$;

REVOKE ALL ON FUNCTION anonymize_guest_web(UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION anonymize_guest_web(UUID, TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION anonymize_guest_web(UUID, TEXT, UUID) IS
  'Удаление личных данных гостя (131). Заказы и чеки остаются: документы учёта хранятся по закону.';

-- ============================================================
-- ОТКАТ
--
-- Forward-only. Данные не удаляются: merged_into/anonymized_at и
-- guest_merges — это записи о том, что владелец уже решил.
--
-- Функциональный откат — отозвать EXECUTE у merge_guests_web и
-- anonymize_guest_web: раздел вернётся к правке профиля и сегментам,
-- уже объединённые профили останутся объединёнными.
--
-- ⚠️ Колоночные гранты UPDATE(phone, name, notes) на guests отозваны.
-- Возврат к прямой правке из клиента (если понадобится) — новой
-- миграцией с GRANT, а не редактированием этой.
--
-- ПРОВЕРКА: под веб-владельцем
--   SELECT set_guest_profile('<guest>', p_phone => '0501234567');
--   SELECT find_guest_duplicates_web();
--   SELECT merge_guests_web('<target>', '<source>');
--   SELECT anonymize_guest_web('<guest>', '0501234567');
-- ============================================================
