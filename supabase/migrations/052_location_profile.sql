-- ============================================================
-- 052 — Профиль заведения: логотип + правка имени точки.
--
-- Настройки → карточка точки становится профилем: аватар-логотип
-- (locations.logo_url, файл в бакете menu-images), название точки
-- (locations.name) и название заведения (receipt_business_name,
-- уже было в 044). Логотип показывается и на публичной странице
-- заказа (public-menu). Тело update_location_config — копия 044
-- + два поля в allow-листе.
-- ============================================================

ALTER TABLE locations ADD COLUMN IF NOT EXISTS logo_url TEXT;

CREATE OR REPLACE FUNCTION update_location_config(
  p_patch JSONB,
  p_staff_session UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc UUID := auth_location_id();
BEGIN
  IF v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'manage');

  IF p_patch ? 'service_mode' AND (p_patch ->> 'service_mode') NOT IN ('counter', 'counter_tables', 'tables') THEN
    RAISE EXCEPTION 'invalid service_mode';
  END IF;
  IF p_patch ? 'vat_rate' AND ((p_patch ->> 'vat_rate')::NUMERIC < 0 OR (p_patch ->> 'vat_rate')::NUMERIC > 50) THEN
    RAISE EXCEPTION 'invalid vat_rate';
  END IF;
  IF p_patch ? 'loyalty_mode' AND (p_patch ->> 'loyalty_mode') NOT IN ('off', 'stamps', 'points') THEN
    RAISE EXCEPTION 'invalid loyalty_mode';
  END IF;
  -- Имя точки — обязательное (печатается в чеке, видно гостю)
  IF p_patch ? 'name' AND NULLIF(TRIM(p_patch ->> 'name'), '') IS NULL THEN
    RAISE EXCEPTION 'invalid name';
  END IF;

  UPDATE locations SET
    name                  = CASE WHEN p_patch ? 'name' THEN TRIM(p_patch ->> 'name') ELSE name END,
    logo_url              = CASE WHEN p_patch ? 'logo_url' THEN NULLIF(TRIM(p_patch ->> 'logo_url'), '') ELSE logo_url END,
    service_mode          = CASE WHEN p_patch ? 'service_mode' THEN p_patch ->> 'service_mode' ELSE service_mode END,
    vat_rate              = CASE WHEN p_patch ? 'vat_rate' THEN (p_patch ->> 'vat_rate')::NUMERIC ELSE vat_rate END,
    receipt_business_name = CASE WHEN p_patch ? 'receipt_business_name' THEN NULLIF(TRIM(p_patch ->> 'receipt_business_name'), '') ELSE receipt_business_name END,
    receipt_address       = CASE WHEN p_patch ? 'receipt_address' THEN NULLIF(TRIM(p_patch ->> 'receipt_address'), '') ELSE receipt_address END,
    receipt_tax_id        = CASE WHEN p_patch ? 'receipt_tax_id' THEN NULLIF(TRIM(p_patch ->> 'receipt_tax_id'), '') ELSE receipt_tax_id END,
    receipt_phone         = CASE WHEN p_patch ? 'receipt_phone' THEN NULLIF(TRIM(p_patch ->> 'receipt_phone'), '') ELSE receipt_phone END,
    receipt_footer        = CASE WHEN p_patch ? 'receipt_footer' THEN NULLIF(TRIM(p_patch ->> 'receipt_footer'), '') ELSE receipt_footer END,
    loyalty_mode          = CASE WHEN p_patch ? 'loyalty_mode' THEN p_patch ->> 'loyalty_mode' ELSE loyalty_mode END,
    loyalty_stamps_goal   = CASE WHEN p_patch ? 'loyalty_stamps_goal' THEN (p_patch ->> 'loyalty_stamps_goal')::INTEGER ELSE loyalty_stamps_goal END,
    loyalty_points_percent = CASE WHEN p_patch ? 'loyalty_points_percent' THEN (p_patch ->> 'loyalty_points_percent')::NUMERIC ELSE loyalty_points_percent END,
    loyalty_points_min_redeem = CASE WHEN p_patch ? 'loyalty_points_min_redeem' THEN (p_patch ->> 'loyalty_points_min_redeem')::INTEGER ELSE loyalty_points_min_redeem END,
    settings              = CASE WHEN p_patch ? 'settings' THEN p_patch -> 'settings' ELSE settings END
  WHERE id = v_loc;
END $$;

REVOKE EXECUTE ON FUNCTION update_location_config FROM anon, public;
