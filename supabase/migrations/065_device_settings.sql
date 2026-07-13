-- ============================================================
-- 065: Настоящие per-device настройки (P5)
--
-- Таблица devices (001) существовала, но не использовалась: deviceStore
-- жил только в localStorage. Теперь привязываем устройство к аккаунту
-- Supabase Auth (auth.uid) + идентификатору устройства (клиентский UUID) и
-- синхронизируем настройки в БД.
--
-- Модель идентичности: один Supabase-аккаунт может работать на нескольких
-- физических терминалах (та же почта). Поэтому строка devices ключуется
-- клиентским device_uuid, а RLS-пол устройства — auth.uid(): устройство
-- читает/меняет ТОЛЬКО свои строки (где auth_user_id = auth.uid()), а не все
-- устройства организации.
--
-- Настройки — JSONB (стартовый экран, ориентация, ширина ленты, принтер и
-- пр.). Финансовых данных тут нет; правки безопасны.
-- ============================================================

-- ── Новые колонки devices ──
ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_uuid UUID;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS auth_user_id UUID;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS app_version TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS webview_version TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS printer_capabilities JSONB;
-- last_seen_at уже есть (001)

-- device_uuid уникален в пределах org (одна строка на физический терминал).
-- ПОЛНЫЙ уникальный индекс (не частичный): register_device использует его как
-- арбитр в ON CONFLICT (org_id, device_uuid) — с частичным индексом Postgres
-- не подобрал бы его без WHERE-предиката и упал бы. Старые строки devices до
-- 065 имеют device_uuid = NULL; несколько NULL в UNIQUE разрешены (NULL не
-- равен NULL), поэтому полный индекс их не конфликтует.
CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_org_uuid
  ON devices(org_id, device_uuid);
CREATE INDEX IF NOT EXISTS idx_devices_auth_user ON devices(auth_user_id);

-- ── RLS: устройство видит/правит только СВОИ строки ──
-- Прежняя permissive-политика devices_all (org-wide, FOR ALL) заменяется:
--  • SELECT — по org (менеджеру нужно видеть список касс точки);
--  • INSERT/UPDATE/DELETE — только собственная строка (auth.uid()).
-- Так одно устройство не перепишет настройки другого. Запись всё равно идёт
-- через RPC register_device (SECURITY DEFINER) — прямой доступ страхует RLS.
DROP POLICY IF EXISTS devices_all ON devices;

CREATE POLICY devices_select ON devices FOR SELECT TO authenticated
  USING (org_id = auth_org_id());

CREATE POLICY devices_insert_own ON devices FOR INSERT TO authenticated
  WITH CHECK (org_id = auth_org_id() AND auth_user_id = auth.uid());

CREATE POLICY devices_update_own ON devices FOR UPDATE TO authenticated
  USING (org_id = auth_org_id() AND auth_user_id = auth.uid())
  WITH CHECK (org_id = auth_org_id() AND auth_user_id = auth.uid());

CREATE POLICY devices_delete_own ON devices FOR DELETE TO authenticated
  USING (org_id = auth_org_id() AND auth_user_id = auth.uid());

-- ── register_device: идемпотентная регистрация/обновление своей кассы ──
-- Идемпотентна по (org_id, device_uuid): повтор не создаёт вторую строку,
-- обновляет существующую. Пишет auth_user_id = auth.uid() — владельца строки.
-- Настройки МЕРЖАТСЯ (jsonb ||), чтобы не затирать поля, выставленные с
-- другого экрана. name/версии/принтер обновляются, если переданы.
CREATE OR REPLACE FUNCTION register_device(
  p_device_uuid UUID,
  p_name TEXT DEFAULT NULL,
  p_settings JSONB DEFAULT NULL,
  p_app_version TEXT DEFAULT NULL,
  p_webview_version TEXT DEFAULT NULL,
  p_printer_capabilities JSONB DEFAULT NULL
) RETURNS devices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_loc UUID := auth_location_id();
  v_uid UUID := auth.uid();
  v_row devices;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  INSERT INTO devices (
    org_id, location_id, device_uuid, auth_user_id, name, settings,
    app_version, webview_version, printer_capabilities, last_seen_at
  ) VALUES (
    v_org, v_loc, p_device_uuid, v_uid, COALESCE(p_name, 'Касса'),
    COALESCE(p_settings, '{}'::jsonb), p_app_version, p_webview_version,
    p_printer_capabilities, NOW()
  )
  ON CONFLICT (org_id, device_uuid) DO UPDATE SET
    auth_user_id         = v_uid,
    name                 = COALESCE(p_name, devices.name),
    settings             = devices.settings || COALESCE(p_settings, '{}'::jsonb),
    app_version          = COALESCE(p_app_version, devices.app_version),
    webview_version      = COALESCE(p_webview_version, devices.webview_version),
    printer_capabilities = COALESCE(p_printer_capabilities, devices.printer_capabilities),
    last_seen_at         = NOW()
  RETURNING * INTO v_row;

  RETURN v_row;
END $$;

REVOKE EXECUTE ON FUNCTION register_device FROM anon, public;

-- ── update_device_settings: сохранить настройки своей кассы (merge) ──
-- Отдельный лёгкий путь для частых правок настроек (без name/версий).
-- Мержит патч в settings; RLS уже гарантирует «только своя строка», но
-- SECURITY DEFINER + явный auth.uid() в WHERE страхует.
CREATE OR REPLACE FUNCTION update_device_settings(
  p_device_uuid UUID,
  p_patch JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_next JSONB;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'patch must be a json object';
  END IF;

  UPDATE devices
  SET settings = settings || p_patch, last_seen_at = NOW()
  WHERE device_uuid = p_device_uuid
    AND auth_user_id = v_uid
    AND org_id = auth_org_id()
  RETURNING settings INTO v_next;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'device not found';
  END IF;
  RETURN v_next;
END $$;

REVOKE EXECUTE ON FUNCTION update_device_settings FROM anon, public;
