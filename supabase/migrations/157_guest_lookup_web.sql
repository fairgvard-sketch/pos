-- ============================================================
-- 157: узнавание гостя при ручной броне
--
-- ЗАЧЕМ.
--
-- Сервер связывает бронь с профилем по телефону триггером (121), и
-- дубля не возникает. Но хостес об этом НЕ ЗНАЕТ: он вводит номер в
-- пустое поле и заводит визит, не подозревая, что этот человек был у
-- них восемь раз и дважды не пришёл. Вся история, которую продукт
-- честно собрал, оставалась невидимой ровно в тот момент, когда она
-- нужна.
--
-- ПОЧЕМУ ТОЛЬКО ТОЧНОЕ СОВПАДЕНИЕ.
--
-- Поиск по началу номера превратил бы форму брони в перебор
-- клиентской базы: ввёл «05», получил список. Здесь совпадение
-- ТОЧНОЕ и только по полному номеру от семи цифр — то есть узнать
-- можно лишь того, чей номер уже знаешь.
--
-- Ответ намеренно НЕ различает «такого гостя нет» и «номер слишком
-- короткий»: оба случая — пустой ответ, по нему нельзя проверить
-- существование произвольного номера.
--
-- ЧТО ОТДАЁТСЯ.
--
-- Только то, что помогает принять решение прямо сейчас: сколько раз
-- был, когда последний, сколько неявок, обычная компания и зона, одна
-- внутренняя заметка. Ни заказов, ни трат, ни меток — за ними идут в
-- карточку клиента, где право проверяется отдельно.
--
-- ⚠️ ТРЕБУЕТ 120 (_reservation_web_member), 121 (guest_reservation_stats),
--    131 (merged_into/anonymized_at), 155 (guest_retention_facts).
-- ============================================================

CREATE OR REPLACE FUNCTION lookup_guest_by_phone_web(
  p_location_id UUID,
  p_phone       TEXT
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := _reservation_web_member(p_location_id);
  v_org    UUID := auth_org_id();
  v_digits TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_guest  guests%ROWTYPE;
  v_facts  RECORD;
  v_zone   TEXT;
BEGIN
  -- Короткий ввод — пустой ответ, а не ошибка: поле заполняют на
  -- глазах у гостя, и красная строка на третьей цифре бесполезна.
  IF LENGTH(v_digits) < 7 THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_guest
  FROM guests
  WHERE org_id = v_org AND phone = v_digits;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Слитый профиль ведёт к оставшемуся: старый номер продолжает
  -- узнавать человека (131), иначе слияние жило бы до следующей брони.
  IF v_guest.merged_into IS NOT NULL THEN
    SELECT * INTO v_guest FROM guests
    WHERE id = resolve_guest_id(v_guest.id) AND org_id = v_org;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
  END IF;

  -- Стёртый по просьбе клиента профиль не «узнаётся»: его личных
  -- данных больше нет, и показывать его имя хостес нельзя.
  IF v_guest.anonymized_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_facts FROM guest_retention_facts(ARRAY[v_guest.id], NULL);

  SELECT tz.name INTO v_zone
  FROM reservations r
  JOIN table_zones tz ON tz.id = r.zone_id
  WHERE r.guest_id = v_guest.id AND NOT r.is_test
  GROUP BY tz.name
  ORDER BY COUNT(*) DESC, tz.name
  LIMIT 1;

  RETURN jsonb_build_object(
    'guest_id',  v_guest.id,
    'name',      v_guest.name,
    'phone',     v_guest.phone,
    'visits',    v_facts.visits,
    'no_shows',  v_facts.no_shows,
    'cancelled', v_facts.cancelled,
    'upcoming',  v_facts.upcoming,
    'last_at',   v_facts.last_at,
    -- Обычная компания: хостес подставит её, не переспрашивая
    'usual_party', (SELECT ROUND(AVG(r.party_size), 1)
                    FROM reservations r
                    WHERE r.guest_id = v_guest.id AND NOT r.is_test
                      AND (r.status = 'completed'
                           OR (r.status = 'confirmed' AND r.reserved_at < NOW()))),
    'usual_zone', v_zone,
    -- ОДНА заметка, а не вся внутренняя переписка о госте: форма брони
    -- — не место для досье.
    'note',      NULLIF(LEFT(COALESCE(v_guest.notes, ''), 160), ''),
    'segments',  to_jsonb(guest_segment_set(
                   v_facts.visits, v_facts.first_at, v_facts.last_at,
                   v_facts.no_shows, v_facts.upcoming, v_facts.spend))
  );
END $$;

REVOKE ALL ON FUNCTION lookup_guest_by_phone_web(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION lookup_guest_by_phone_web(UUID, TEXT)
  TO authenticated, service_role;

COMMENT ON FUNCTION lookup_guest_by_phone_web(UUID, TEXT) IS
  'Узнавание гостя при ручной броне (157). Только точное совпадение полного номера: поиск по префиксу превратил бы форму в перебор базы.';

-- ============================================================
-- ОТКАТ
--
-- Forward-only: новая функция, ничего не изменено. Функциональный
-- откат — отозвать EXECUTE у `authenticated`: форма брони перестанет
-- узнавать гостя, связь визита с профилем (триггер 121) продолжит
-- работать как раньше.
--
-- ПРОВЕРКА под веб-владельцем:
--   SELECT lookup_guest_by_phone_web('<loc>', '0521234567');
--   SELECT lookup_guest_by_phone_web('<loc>', '052');  -- ожидается NULL
-- ============================================================
