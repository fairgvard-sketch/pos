-- ============================================================
-- 130. Парк касс: переименование и архив
--
-- В кабинете все устройства называются «Касса»: имя задаётся один раз
-- при настройке терминала и потом не меняется. Владелец сети видит
-- десяток одинаковых строк, половина из которых — давно списанные
-- терминалы, и не может понять, какая из них та, что молчит вторые
-- сутки.
--
-- Архив — ТОЛЬКО классификация для кабинета: он не отключает терминал,
-- не отзывает его учётку и не трогает телеметрию. Списанную кассу
-- убирают с глаз, а не из базы: её заказы и смены остаются в отчётах.
-- Настоящее отключение (revoke auth) — отдельная операция, её здесь
-- намеренно нет: необратимое действие не должно прятаться за словом
-- «архивировать».
--
-- ⚠️ ТРЕБУЕТ 097 (get_backoffice_fleet).
-- ============================================================

ALTER TABLE devices ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

COMMENT ON COLUMN devices.archived_at IS
  'Устройство убрано из операционного списка кабинета (130). Терминал продолжает работать: это классификация, а не отключение.';

-- ── Право на изменение парка ────────────────────────────────
/**
 * Тот же гейт, что у чтения парка (097): веб-владелец/менеджер по
 * членству, иначе staff-сессия с правом 'manage'.
 */
CREATE OR REPLACE FUNCTION _device_web_guard(p_staff_session UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth_org_id() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF COALESCE(auth_backoffice_role(), '') NOT IN ('owner', 'manager') THEN
    PERFORM require_staff_perm(p_staff_session, 'manage');
  END IF;
END $$;

REVOKE ALL ON FUNCTION _device_web_guard(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION _device_web_guard(UUID) TO authenticated, service_role;

-- ── Переименование ──────────────────────────────────────────
/**
 * Имя устройства. Пустое имя запрещено: строка без названия в списке
 * парка бесполезнее, чем «Касса».
 */
CREATE OR REPLACE FUNCTION rename_device_web(
  p_device_id     UUID,
  p_name          TEXT,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name TEXT := NULLIF(btrim(COALESCE(p_name, '')), '');
BEGIN
  PERFORM _device_web_guard(p_staff_session);
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'name_required';
  END IF;

  UPDATE devices SET name = LEFT(v_name, 60)
  WHERE id = p_device_id AND org_id = auth_org_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  RETURN json_build_object('device_id', p_device_id, 'name', LEFT(v_name, 60));
END $$;

REVOKE ALL ON FUNCTION rename_device_web(UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION rename_device_web(UUID, TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION rename_device_web(UUID, TEXT, UUID) IS
  'Имя устройства из кабинета (130): в парке все кассы назывались одинаково, и опознать молчащую было нечем.';

-- ── Архив и возврат ─────────────────────────────────────────
/**
 * Убрать устройство из операционного списка или вернуть обратно.
 * Обратимо и не влияет ни на что, кроме показа в кабинете.
 */
CREATE OR REPLACE FUNCTION set_device_archived_web(
  p_device_id     UUID,
  p_archived      BOOLEAN,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM _device_web_guard(p_staff_session);
  IF p_archived IS NULL THEN
    RAISE EXCEPTION 'archived_required';
  END IF;

  UPDATE devices
  SET archived_at = CASE WHEN p_archived THEN NOW() ELSE NULL END
  WHERE id = p_device_id AND org_id = auth_org_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  RETURN json_build_object('device_id', p_device_id, 'archived', p_archived);
END $$;

REVOKE ALL ON FUNCTION set_device_archived_web(UUID, BOOLEAN, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_device_archived_web(UUID, BOOLEAN, UUID) TO authenticated;

COMMENT ON FUNCTION set_device_archived_web(UUID, BOOLEAN, UUID) IS
  'Архив устройства (130) — только классификация кабинета: терминал продолжает работать, записи не удаляются, действие обратимо.';

-- ── Парк отдаёт архивную метку ──────────────────────────────
/**
 * `get_backoffice_fleet` пересоздаётся с `archived_at`: кабинет прячет
 * архивные по умолчанию, но обязан уметь их показать — «убрано с глаз»
 * не значит «потеряно».
 */
CREATE OR REPLACE FUNCTION get_backoffice_fleet(
  p_staff_session UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF COALESCE(auth_backoffice_role(), '') NOT IN ('owner', 'manager') THEN
    PERFORM require_staff_perm(p_staff_session, 'manage');
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(f) ORDER BY f.silence_seconds DESC NULLS FIRST), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT
      d.id,
      d.name,
      d.location_id,
      l.name                                              AS location_name,
      d.app_version,
      d.webview_version,
      d.bridge_version,
      d.outbox_pending,
      d.outbox_oldest_at,
      COALESCE(d.outbox_failed, FALSE)                    AS outbox_failed,
      d.last_seen_at,
      d.registered_at,
      d.archived_at,
      CASE WHEN d.last_seen_at IS NULL THEN NULL
           ELSE EXTRACT(EPOCH FROM (NOW() - d.last_seen_at))::bigint
      END                                                 AS silence_seconds
    FROM devices d
    LEFT JOIN locations l ON l.id = d.location_id
  ) f;

  RETURN v_result;
END $$;

-- ============================================================
-- ОТКАТ
--
-- Forward-only. Колонка archived_at не удаляется (в ней данные о том,
-- что владелец уже разобрал). Функциональный откат — отозвать EXECUTE у
-- rename_device_web / set_device_archived_web: парк вернётся к
-- read-only, телеметрия и работа касс не затрагиваются.
--
-- ПРОВЕРКА: под веб-владельцем
--   SELECT rename_device_web('<device>', 'Стойка 1');
--   SELECT set_device_archived_web('<device>', TRUE);
-- ============================================================
