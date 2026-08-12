-- ============================================================
-- 153: подбор из листа ожидания на освободившийся слот
--
-- ЗАЧЕМ.
--
-- Петля возврата была построена наполовину. `waitlist_matches` (122)
-- умеет ответить, кого можно позвать на освободившееся время, и делает
-- это честно — проверяет не только пожелание гостя, но и реальную
-- возможность посадить. Вызвать её было НЕКОМУ: обёртка в кабинете
-- существовала и не использовалась ни одним экраном.
--
-- Поэтому отмена вечерней брони на шестерых просто освобождала стол.
-- Гость, который час назад ушёл ни с чем и оставил телефон, об этом не
-- узнавал: заведение теряло и его, и выручку вечера.
--
-- ЧТО ЗДЕСЬ.
--
-- 1. `waitlist_matches_web` — тот же подбор, но с правом кабинета
--    (членство owner/manager + capability `reservations_desk`), как у
--    остальных `_web`-функций стола. `waitlist_matches` остаётся как
--    была: она проверяет только организацию, и менять её значило бы
--    трогать путь, которым уже пользуются.
--
-- 2. К ответу добавлено ПОЧЕМУ кандидат подходит: приемлемое окно
--    времени, зоны и обещанное ожидание. Без них список выглядит как
--    «позвоните этим людям» без объяснения, откуда они взялись, и
--    хостес не может решить, кому звонить первым.
--
-- Предложение по-прежнему СТОЛ НЕ ДЕРЖИТ (правило 122): бронь
-- создаётся только при согласии гостя, и слот перепроверяется в этот
-- момент. Иначе лист ожидания сам стал бы источником фантомной
-- занятости.
--
-- ⚠️ ТРЕБУЕТ 122 (waitlist_matches, _pick_tables), 120
--    (_reservation_web_member).
-- ============================================================

CREATE OR REPLACE FUNCTION waitlist_matches_web(
  p_location_id UUID,
  p_at          TIMESTAMPTZ,
  p_limit       INTEGER DEFAULT 10
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := _reservation_web_member(p_location_id);
  v_org    UUID := auth_org_id();
  v_loc    locations%ROWTYPE;
  v_local  TIMESTAMP;
  v_dur    INTEGER;
  v_buf    INTEGER;
  v_comb   BOOLEAN;
BEGIN
  SELECT * INTO v_loc FROM locations WHERE id = p_location_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;

  -- Истёкшие предложения возвращаются в очередь ДО подбора: гость не
  -- виноват, что не успел, и места в очереди не теряет (122).
  PERFORM _expire_waitlist_offers(p_location_id);

  v_local := p_at AT TIME ZONE COALESCE(NULLIF(v_loc.timezone, ''), 'Asia/Jerusalem');
  v_dur   := COALESCE((v_loc.settings -> 'reservations' ->> 'duration_min')::INTEGER, 90);
  v_buf   := COALESCE((v_loc.settings -> 'reservations' ->> 'buffer_min')::INTEGER, 0);
  v_comb  := COALESCE((v_loc.settings -> 'reservations' ->> 'combine')::BOOLEAN, FALSE);

  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(m) ORDER BY m.created_at)
    FROM (
      SELECT w.id, w.customer_name, w.customer_phone, w.party_size,
             w.note, w.created_at, w.status, w.zone_ids,
             -- Почему этот кандидат подходит. Окно и обещание — не
             -- украшение: хостес решает, кому звонить первым, и «ждёт
             -- с 18:00, обещали 20 минут» отвечает на этот вопрос, а
             -- имя с телефоном — нет.
             w.time_from, w.time_to, w.quoted_min,
             -- Имена зон словом: список uuid не объясняет ничего.
             COALESCE((
               SELECT jsonb_agg(z.name ORDER BY z.sort_order, z.name)
               FROM table_zones z
               WHERE z.id = ANY(w.zone_ids) AND z.location_id = p_location_id
             ), '[]'::jsonb) AS zone_names
      FROM waitlist_entries w
      WHERE w.location_id = p_location_id
        AND w.status = 'waiting'
        AND w.wanted_date = v_local::DATE
        AND v_local::TIME >= w.time_from
        AND v_local::TIME <= w.time_to
        -- Есть ли куда посадить именно эту компанию. Показать в списке
        -- того, кого посадить некуда, значит обмануть дважды (122).
        AND array_length(
              _pick_tables(p_location_id, w.party_size, p_at, v_dur, v_buf, v_comb,
                           NULL,
                           CASE WHEN cardinality(w.zone_ids) = 1 THEN w.zone_ids[1] END),
              1) IS NOT NULL
      ORDER BY w.created_at
      LIMIT GREATEST(1, LEAST(50, COALESCE(p_limit, 10)))
    ) m
  ), '[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION waitlist_matches_web(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION waitlist_matches_web(UUID, TIMESTAMPTZ, INTEGER)
  TO authenticated, service_role;

-- ============================================================
-- ОТКАТ
--
-- Forward-only: схема не менялась, существующие функции не тронуты.
-- Функциональный откат — отозвать EXECUTE у `authenticated`: кабинет
-- перестанет предлагать кандидатов на освободившийся слот, остальной
-- лист ожидания продолжит работать.
--
-- ПРОВЕРКА под веб-владельцем:
--   SELECT waitlist_matches_web('<loc>', NOW() + INTERVAL '2 hours');
-- ============================================================
