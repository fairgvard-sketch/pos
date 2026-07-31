-- ============================================================
-- 120 RESERVATION DESK WEB — действия таймлайна хостес из кабинета.
--
-- МОТИВ. 119 дал столу хостес всё нужное: связь визита со столами,
-- назначение/объединение, правку и отметку посадки. Но все три RPC
-- требуют активную строку `staff` с PIN — то есть кассу. У владельца
-- standalone-точки кассы нет, `staff` может не быть вовсе, и таймлайн
-- в кабинете остался бы витриной «только посмотреть»: назначить стол
-- нельзя, отметить, что гость сел, нельзя.
--
-- Здесь — веб-зеркала тех же действий по модели 091/096/102: право даёт
-- членство в `organization_members`, точка приходит параметром (в JWT
-- веб-владельца `location_id` нет), сверху capability-гейт
-- `reservations_desk`. Бронь, посаженная в POS-заказ, из веба
-- неприкасаема — правило 102 сохранено.
--
-- Тела не дублируются: проверки вынесены в общий guard, а сама работа
-- делается теми же функциями 119 под `SECURITY DEFINER`. Иначе правила
-- «занятость перепроверяется» и «вместимость не проверяется» пришлось бы
-- держать в двух местах — ровно та ошибка, которую разбирали в 117.
--
-- ⚠️ ТРЕБУЕТ 119.
-- ============================================================

-- ── Общий guard веб-стола ────────────────────────────────────
/**
 * Проверяет, что вызывающий — активный owner/manager кабинета этой
 * организации, точка принадлежит ей, а продукт подключён. Возвращает id
 * членства для атрибуции решения.
 */
CREATE OR REPLACE FUNCTION _reservation_web_member(p_location_id UUID)
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID;
BEGIN
  IF auth_backoffice_role() IS NULL
     OR auth_backoffice_role() NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'backoffice access denied';
  END IF;

  SELECT id INTO v_member
  FROM organization_members
  WHERE auth_user_id = auth.uid() AND org_id = auth_org_id() AND is_active
  LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'backoffice access denied';
  END IF;

  PERFORM assert_backoffice_location(p_location_id);

  IF NOT org_has_capability(auth_org_id(), 'reservations_desk') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;

  RETURN v_member;
END $$;

REVOKE ALL ON FUNCTION _reservation_web_member(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION _reservation_web_member(UUID) TO authenticated, service_role;

-- ── Столы визита ─────────────────────────────────────────────
/**
 * Назначить / объединить / разъединить столы из кабинета. Пустой массив
 * снимает столы. Проверки принадлежности и занятости — те же, что у
 * кассовой `set_reservation_tables` (119): здесь только смена способа
 * авторизации, а не правил.
 */
CREATE OR REPLACE FUNCTION set_reservation_tables_web(
  p_location_id UUID,
  p_id          UUID,
  p_table_ids   UUID[]
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := _reservation_web_member(p_location_id);
  v_r      reservations%ROWTYPE;
  v_ids    UUID[] := COALESCE(p_table_ids, '{}');
  v_table  UUID;
  v_buf    INTEGER;
BEGIN
  SELECT * INTO v_r FROM reservations
  WHERE id = p_id AND org_id = auth_org_id() AND location_id = p_location_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_r.status NOT IN ('new', 'confirmed') THEN
    RAISE EXCEPTION 'not_active';
  END IF;
  IF v_r.order_id IS NOT NULL THEN
    RAISE EXCEPTION 'pos_mode';
  END IF;

  SELECT COALESCE((settings -> 'reservations' ->> 'buffer_min')::INTEGER, 0)
  INTO v_buf FROM locations WHERE id = p_location_id;

  FOREACH v_table IN ARRAY v_ids LOOP
    IF NOT EXISTS (
      SELECT 1 FROM tables
      WHERE id = v_table AND org_id = auth_org_id()
        AND location_id = p_location_id AND is_active
    ) THEN
      RAISE EXCEPTION 'invalid table';
    END IF;
    IF NOT _table_free(v_table, v_r.reserved_at, v_r.duration_min, v_buf, v_r.id) THEN
      RAISE EXCEPTION 'table_busy';
    END IF;
  END LOOP;

  BEGIN
    UPDATE reservations
    SET table_id       = CASE WHEN array_length(v_ids, 1) IS NULL THEN NULL ELSE v_ids[1] END,
        hold_table_ids = CASE
                           WHEN array_length(v_ids, 1) IS NULL OR array_length(v_ids, 1) < 2
                             THEN '{}'::UUID[]
                           ELSE v_ids[2:array_length(v_ids, 1)]
                         END,
        decided_by_member = v_member
    WHERE id = p_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'table_busy';
  END;

  RETURN json_build_object('reservation_id', p_id, 'tables', v_ids);
END $$;

REVOKE ALL ON FUNCTION set_reservation_tables_web(UUID, UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_reservation_tables_web(UUID, UUID, UUID[])
  TO authenticated, service_role;

-- ── Посадка гостя ────────────────────────────────────────────
/**
 * Отметить, что гость сел, без POS-заказа. Для standalone-точки это и
 * есть посадка: стол остаётся занят до completed/no_show.
 */
CREATE OR REPLACE FUNCTION mark_reservation_arrived_web(
  p_location_id UUID,
  p_id          UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := _reservation_web_member(p_location_id);
  v_r      reservations%ROWTYPE;
BEGIN
  SELECT * INTO v_r FROM reservations
  WHERE id = p_id AND org_id = auth_org_id() AND location_id = p_location_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'not_confirmed';
  END IF;

  IF v_r.arrived_at IS NULL THEN
    UPDATE reservations
    SET arrived_at = NOW(), decided_by_member = v_member
    WHERE id = p_id;
  END IF;

  RETURN json_build_object('reservation_id', p_id, 'arrived', TRUE);
END $$;

REVOKE ALL ON FUNCTION mark_reservation_arrived_web(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mark_reservation_arrived_web(UUID, UUID)
  TO authenticated, service_role;

-- ── Правка визита ────────────────────────────────────────────
/**
 * Время, размер компании, зона, заметка и длительность из кабинета.
 * NULL = «не менять». Занятость столов перепроверяется, часы работы —
 * нет: расписание ограничивает гостя, а не хостес (правило 060).
 */
CREATE OR REPLACE FUNCTION update_reservation_web(
  p_location_id UUID,
  p_id          UUID,
  p_reserved_at TIMESTAMPTZ DEFAULT NULL,
  p_party_size  INTEGER     DEFAULT NULL,
  p_note        TEXT        DEFAULT NULL,
  p_zone_id     UUID        DEFAULT NULL,
  p_duration    INTEGER     DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := _reservation_web_member(p_location_id);
  v_r      reservations%ROWTYPE;
  v_at     TIMESTAMPTZ;
  v_dur    INTEGER;
  v_buf    INTEGER;
  v_table  UUID;
BEGIN
  SELECT * INTO v_r FROM reservations
  WHERE id = p_id AND org_id = auth_org_id() AND location_id = p_location_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_r.status NOT IN ('new', 'confirmed') THEN
    RAISE EXCEPTION 'not_active';
  END IF;
  IF v_r.order_id IS NOT NULL THEN
    RAISE EXCEPTION 'pos_mode';
  END IF;

  v_at  := COALESCE(p_reserved_at, v_r.reserved_at);
  v_dur := COALESCE(p_duration, v_r.duration_min);
  IF v_dur < 15 OR v_dur > 1440 THEN
    RAISE EXCEPTION 'invalid_duration';
  END IF;
  IF p_party_size IS NOT NULL AND (p_party_size < 1 OR p_party_size > 200) THEN
    RAISE EXCEPTION 'invalid_party';
  END IF;
  IF p_zone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM table_zones
    WHERE id = p_zone_id AND location_id = p_location_id AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid_zone';
  END IF;

  SELECT COALESCE((settings -> 'reservations' ->> 'buffer_min')::INTEGER, 0)
  INTO v_buf FROM locations WHERE id = p_location_id;

  IF v_at <> v_r.reserved_at OR v_dur <> v_r.duration_min THEN
    FOREACH v_table IN ARRAY (
      ARRAY(SELECT x FROM unnest(ARRAY[v_r.table_id] || COALESCE(v_r.hold_table_ids, '{}')) AS x
            WHERE x IS NOT NULL)
    ) LOOP
      IF NOT _table_free(v_table, v_at, v_dur, v_buf, v_r.id) THEN
        RAISE EXCEPTION 'table_busy';
      END IF;
    END LOOP;
  END IF;

  BEGIN
    UPDATE reservations
    SET reserved_at  = v_at,
        duration_min = v_dur,
        party_size   = COALESCE(p_party_size, party_size),
        note         = COALESCE(NULLIF(LEFT(TRIM(p_note), 200), ''), note),
        zone_id      = COALESCE(p_zone_id, zone_id),
        decided_by_member = v_member
    WHERE id = p_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'table_busy';
  END;

  RETURN json_build_object('reservation_id', p_id, 'reserved_at', v_at);
END $$;

REVOKE ALL ON FUNCTION update_reservation_web(UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT, UUID, INTEGER)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION update_reservation_web(UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT, UUID, INTEGER)
  TO authenticated, service_role;

-- ============================================================
-- ОТКАТ
--
-- Forward-only, схему не меняет — только функции. Функциональный откат:
-- отозвать EXECUTE у `authenticated`, кабинет вернётся к списку без
-- действий над столами (кассовый путь 119 не затрагивается).
--
-- ПРОВЕРКА: под веб-владельцем без POS
--   SELECT set_reservation_tables_web('<loc>', '<res>', ARRAY['<table>']::UUID[]);
--   SELECT mark_reservation_arrived_web('<loc>', '<res>');
-- ============================================================
