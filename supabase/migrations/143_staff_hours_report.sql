-- ============================================================
-- 143. Часы сотрудника: отчёт по дням и правка табеля из кабинета.
--
-- Что было не так:
--
--   * `time_entries_report` (022/027) отдаёт ПЛОСКИЙ список смен за
--     период и итог по человеку. Вопрос владельца «покажи часы Ани за
--     август по дням, я распечатаю и отдам бухгалтеру» приходилось
--     собирать на клиенте: группировка по календарному дню считалась
--     из часового пояса БРАУЗЕРА. Касса стоит в Израиле, кабинет
--     открывают откуда угодно — ночная смена уезжала на соседний день,
--     и печатный табель не сходился с экранным;
--   * отчёт скоупится только по org. У сети из трёх точек часы всех
--     точек складывались в одно число без возможности разделить;
--   * права: читать табель мог любой аутентифицированный клиент,
--     а править — только `p_actor_id` = staff-строка с ролью
--     manager/owner. У веб-владельца кабинета staff-строки может не
--     быть вовсе (091), поэтому исправить забытую отметку из кабинета
--     было нельзя — только подойти к терминалу;
--   * `save_time_entry` брал точку из `auth_location_id()`. В JWT
--     веб-владельца её нет — INSERT падал бы на NOT NULL.
--
-- Здесь:
--
--   1. `staff_hours_report` — смены с УЖЕ посчитанным на сервере
--      календарным днём и днём недели в часовом поясе точки, фильтры
--      по сотрудникам и точкам, единый гейт права `manage`. Оба
--      клиента (касса и кабинет) видят одну и ту же нарезку по дням.
--   2. `save_time_entry` / `delete_time_entry` пускают веб-владельца
--      кабинета (`require_backoffice_or_staff`), принимают точку
--      параметром и запоминают, КТО правил, даже когда правил веб-
--      аккаунт без staff-строки (`edited_by_user`).
--
-- День смены = день её НАЧАЛА в часовом поясе точки. Смена с 22:00 до
-- 06:00 целиком принадлежит дню прихода: так её и записывают в
-- зарплатный табель, и так её печатает касса.
--
-- Аудит-инвариант 022/027 не нарушен: записи по-прежнему не удаляются
-- физически, правка помечается edited_at/edited_by/edited_by_user.
--
-- ⚠️ ТРЕБУЕТ 022/027 (time_entries), 088 (auth_backoffice_role),
--    091 (assert_backoffice_location), 095/096 (require_staff_perm,
--    require_backoffice_or_staff).
-- ============================================================

-- ── 1. Кто правил из кабинета ───────────────────────────────
-- `edited_by` ссылается на staff. У веб-идентичности staff-строки
-- может не быть (091), а «исправлено кем-то» — не аудит. Отдельная
-- колонка на auth.users закрывает дыру, не ломая прежние записи.
ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS edited_by_user UUID REFERENCES auth.users(id);

COMMENT ON COLUMN time_entries.edited_by_user IS
  'Веб-аккаунт кабинета, исправивший запись (143). Заполняется, когда у правщика нет staff-строки; edited_by остаётся для кассового пути.';

-- ============================================================
-- RPC: staff_hours_report — часы по дням за произвольный период
--
-- p_from/p_to — КАЛЕНДАРНЫЕ даты включительно, а не метки времени:
-- «август» задаётся как 2026-08-01…2026-08-31 и не зависит от того,
-- в каком поясе открыт клиент.
-- ============================================================
CREATE OR REPLACE FUNCTION staff_hours_report(
  p_from          DATE,
  p_to            DATE,
  p_tz            TEXT   DEFAULT 'Asia/Jerusalem',
  p_staff_ids     UUID[] DEFAULT NULL,
  p_location_ids  UUID[] DEFAULT NULL,
  p_staff_session UUID   DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org    UUID := auth_org_id();
  v_from   TIMESTAMPTZ;
  v_to     TIMESTAMPTZ;
  -- Пустой массив = «все»: клиент присылает его, когда владелец снял
  -- последнюю галочку, и это не повод показать пустой отчёт.
  v_locs   UUID[] := CASE WHEN COALESCE(cardinality(p_location_ids), 0) = 0
                          THEN NULL ELSE p_location_ids END;
  v_staff  UUID[] := CASE WHEN COALESCE(cardinality(p_staff_ids), 0) = 0
                          THEN NULL ELSE p_staff_ids END;
  v_result JSONB;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'invalid period';
  END IF;

  -- Табель — зарплатные данные: тот же гейт, что у управления командой.
  -- Веб-владелец кабинета подтверждён членством (088), PIN не нужен.
  IF COALESCE(auth_backoffice_role(), '') NOT IN ('owner', 'manager') THEN
    PERFORM require_staff_perm(p_staff_session, 'manage');
  END IF;

  -- Границы периода — локальная полночь точки, а не UTC-сутки.
  v_from := (p_from::TIMESTAMP AT TIME ZONE p_tz);
  v_to   := ((p_to + 1)::TIMESTAMP AT TIME ZONE p_tz);

  WITH ent AS (
    SELECT
      te.id,
      te.staff_id,
      te.location_id,
      te.clock_in,
      te.clock_out,
      te.note,
      te.edited_at,
      -- День и день недели считаются ЗДЕСЬ: клиент их только показывает.
      -- 0 = воскресенье (א) — израильская неделя.
      ((te.clock_in AT TIME ZONE p_tz)::DATE)                     AS day,
      EXTRACT(DOW FROM (te.clock_in AT TIME ZONE p_tz))::INT      AS dow,
      (te.clock_out IS NULL)                                      AS is_open,
      -- Открытая смена считается «до сих пор»: так её видно и в кассе.
      -- Забытый уход даёт заведомо большое число — это сигнал исправить,
      -- а не молча посчитанные сутки.
      EXTRACT(EPOCH FROM (COALESCE(te.clock_out, NOW()) - te.clock_in))::INT AS seconds,
      COALESCE(es.name, om.display_name)                          AS edited_by_name
    FROM time_entries te
    LEFT JOIN staff es ON es.id = te.edited_by
    LEFT JOIN organization_members om
           ON om.auth_user_id = te.edited_by_user AND om.org_id = te.org_id
    WHERE te.org_id = v_org
      AND te.deleted_at IS NULL
      AND te.clock_in >= v_from
      AND te.clock_in <  v_to
      AND (v_locs  IS NULL OR te.location_id = ANY(v_locs))
      AND (v_staff IS NULL OR te.staff_id    = ANY(v_staff))
  ),
  -- Сотрудник попадает в отчёт, если у него есть смены; а если его
  -- спросили поимённо — и с пустым результатом, иначе карточка
  -- сотрудника без смен показала бы «сотрудник не найден».
  people AS (
    SELECT s.id, s.name, s.role, s.is_active
    FROM staff s
    WHERE s.org_id = v_org
      AND (v_staff IS NULL OR s.id = ANY(v_staff))
      AND (v_staff IS NOT NULL OR EXISTS (SELECT 1 FROM ent WHERE ent.staff_id = s.id))
  )
  SELECT jsonb_build_object(
    'scope', jsonb_build_object(
      'from', p_from,
      'to',   p_to,
      'tz',   p_tz,
      'location_ids', COALESCE(to_jsonb(v_locs), 'null'::JSONB)
    ),
    'staff', COALESCE((
      SELECT jsonb_agg(row_to_json(x)::JSONB ORDER BY x.name)
      FROM (
        SELECT
          p.id   AS staff_id,
          p.name,
          p.role,
          p.is_active,
          COALESCE((SELECT SUM(e.seconds) FROM ent e WHERE e.staff_id = p.id), 0)::INT AS seconds,
          COALESCE((SELECT COUNT(DISTINCT e.day) FROM ent e WHERE e.staff_id = p.id), 0)::INT AS days,
          COALESCE((SELECT COUNT(*) FROM ent e WHERE e.staff_id = p.id), 0)::INT AS shifts,
          COALESCE((SELECT bool_or(e.is_open) FROM ent e WHERE e.staff_id = p.id), FALSE) AS has_open,
          COALESCE((
            SELECT jsonb_agg(row_to_json(d)::JSONB ORDER BY d.day, d.clock_in)
            FROM (
              SELECT e.id, e.day, e.dow, e.clock_in, e.clock_out, e.seconds,
                     e.is_open, e.note, e.edited_at, e.edited_by_name,
                     e.location_id, l.name AS location_name
              FROM ent e
              LEFT JOIN locations l ON l.id = e.location_id
              WHERE e.staff_id = p.id
            ) d
          ), '[]'::JSONB) AS entries
        FROM people p
      ) x
    ), '[]'::JSONB),
    'totals', jsonb_build_object(
      'seconds', COALESCE((SELECT SUM(seconds) FROM ent), 0)::INT,
      'shifts',  (SELECT COUNT(*) FROM ent)::INT,
      'days',    (SELECT COUNT(DISTINCT day) FROM ent)::INT,
      'staff',   (SELECT COUNT(*) FROM people)::INT
    )
  ) INTO v_result;

  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION staff_hours_report(DATE, DATE, TEXT, UUID[], UUID[], UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION staff_hours_report(DATE, DATE, TEXT, UUID[], UUID[], UUID)
  TO authenticated;

COMMENT ON FUNCTION staff_hours_report(DATE, DATE, TEXT, UUID[], UUID[], UUID) IS
  'Часы сотрудников по дням за период (143): день и день недели считаются в часовом поясе точки, фильтры по сотрудникам и точкам, право manage.';

-- ============================================================
-- RPC: save_time_entry — правка табеля кассой ИЛИ кабинетом
--
-- Прежняя сигнатура удаляется: параметр с DEFAULT дал бы PostgREST
-- две подходящие функции («is not unique»). Старый клиент шлёт те же
-- шесть именованных аргументов и по-прежнему попадает в эту функцию.
-- ============================================================
DROP FUNCTION IF EXISTS save_time_entry(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT);

CREATE OR REPLACE FUNCTION save_time_entry(
  p_entry_id      UUID,
  p_staff_id      UUID,
  p_clock_in      TIMESTAMPTZ,
  p_clock_out     TIMESTAMPTZ,
  p_actor_id      UUID DEFAULT NULL,
  p_note          TEXT DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL,
  p_location_id   UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_web   BOOLEAN := auth_backoffice_role() IS NOT NULL;
  v_actor UUID;
  v_user  UUID;
  v_loc   UUID;
  v_id    UUID;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Право: единый гейт (091/096) — веб-членство ИЛИ manage-сессия кассы.
  -- Фолбэк на прежнюю проверку p_actor_id оставлен ровно для клиентов,
  -- собранных до 143; удалить следующей миграцией после раскатки.
  IF v_web OR p_staff_session IS NOT NULL THEN
    v_actor := require_backoffice_or_staff(p_staff_session, 'manage');
  ELSE
    PERFORM assert_timesheet_manager(p_actor_id, v_org);
    v_actor := p_actor_id;
  END IF;
  IF v_web THEN
    v_user := auth.uid();
  END IF;

  IF p_clock_in IS NULL OR p_clock_in > NOW() THEN
    RAISE EXCEPTION 'invalid clock_in';
  END IF;
  IF p_clock_out IS NOT NULL AND p_clock_out <= p_clock_in THEN
    RAISE EXCEPTION 'clock_out must be after clock_in';
  END IF;

  IF p_entry_id IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org) THEN
      RAISE EXCEPTION 'invalid staff';
    END IF;

    -- Точка: параметром (кабинет), из токена устройства (касса) или,
    -- в последнюю очередь, приписка сотрудника. NOT NULL обязан
    -- получить осмысленное значение, а не упасть на веб-владельце.
    IF p_location_id IS NOT NULL THEN
      PERFORM assert_backoffice_location(p_location_id);
    END IF;
    v_loc := COALESCE(
      p_location_id,
      auth_location_id(),
      (SELECT location_id FROM staff WHERE id = p_staff_id)
    );
    IF v_loc IS NULL OR NOT EXISTS (
      SELECT 1 FROM locations WHERE id = v_loc AND org_id = v_org
    ) THEN
      RAISE EXCEPTION 'location required';
    END IF;

    INSERT INTO time_entries (org_id, location_id, staff_id, clock_in, clock_out,
                              note, edited_by, edited_by_user, edited_at)
    VALUES (v_org, v_loc, p_staff_id, p_clock_in, p_clock_out,
            NULLIF(TRIM(p_note), ''), v_actor, v_user, NOW())
    RETURNING id INTO v_id;
  ELSE
    UPDATE time_entries
    SET clock_in = p_clock_in, clock_out = p_clock_out,
        note = NULLIF(TRIM(p_note), ''),
        edited_by = v_actor, edited_by_user = v_user, edited_at = NOW()
    WHERE id = p_entry_id AND org_id = v_org AND deleted_at IS NULL
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'entry not found';
    END IF;
  END IF;

  RETURN json_build_object('entry_id', v_id);
END $$;

REVOKE ALL ON FUNCTION save_time_entry(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_time_entry(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, UUID, UUID)
  TO authenticated;

COMMENT ON FUNCTION save_time_entry(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, UUID, UUID) IS
  'Правка табеля (027, расширена 143): касса по manage-сессии, кабинет по членству; точка приходит параметром, автор правки пишется в edited_by/edited_by_user.';

-- ============================================================
-- RPC: delete_time_entry — мягкое удаление, тот же гейт
-- ============================================================
DROP FUNCTION IF EXISTS delete_time_entry(UUID, UUID);

CREATE OR REPLACE FUNCTION delete_time_entry(
  p_entry_id      UUID,
  p_actor_id      UUID DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_web   BOOLEAN := auth_backoffice_role() IS NOT NULL;
  v_actor UUID;
  v_user  UUID;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF v_web OR p_staff_session IS NOT NULL THEN
    v_actor := require_backoffice_or_staff(p_staff_session, 'manage');
  ELSE
    PERFORM assert_timesheet_manager(p_actor_id, v_org);
    v_actor := p_actor_id;
  END IF;
  IF v_web THEN
    v_user := auth.uid();
  END IF;

  UPDATE time_entries
  SET deleted_at = NOW(), edited_by = v_actor, edited_by_user = v_user, edited_at = NOW()
  WHERE id = p_entry_id AND org_id = v_org AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entry not found';
  END IF;
END $$;

REVOKE ALL ON FUNCTION delete_time_entry(UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION delete_time_entry(UUID, UUID, UUID) TO authenticated;

COMMENT ON FUNCTION delete_time_entry(UUID, UUID, UUID) IS
  'Мягкое удаление записи табеля (027, расширено 143): касса по manage-сессии, кабинет по членству.';

-- ============================================================
-- ОТКАТ / ВОССТАНОВЛЕНИЕ
--
-- Forward-only. Данные не переписываются: добавлена одна NULL-колонка,
-- остальное — функции. Вернуть прежнее поведение правки — переиздать
-- тела 027 новой миграцией (сигнатуры придётся снова DROP+CREATE).
--
-- ПРОВЕРКА на целевой базе (под кассой с manage-сессией):
--   SELECT staff_hours_report(
--     date_trunc('month', NOW())::DATE,
--     NOW()::DATE, 'Asia/Jerusalem', NULL, NULL, '<staff_session>'
--   ) -> 'totals';
--   -- 'seconds' должно совпасть с суммой по time_entries за тот же период:
--   SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(clock_out, NOW()) - clock_in)))::INT
--   FROM time_entries
--   WHERE deleted_at IS NULL
--     AND clock_in >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Jerusalem')
--                     AT TIME ZONE 'Asia/Jerusalem';
-- ============================================================
