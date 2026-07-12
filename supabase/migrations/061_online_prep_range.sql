-- ============================================================
-- 061 — Время приготовления как ДИАПАЗОН (мин–макс) + таймер у гостя.
--
-- 054 хранило одно число prep_minutes. Реальность кофейни — вилка
-- («готово через 20–35 мин»): гостю честнее видеть диапазон, а после
-- принятия — обратный отсчёт в стиле Wolt до верхней границы.
--
-- Хранение — locations.settings.online_orders (паттерн 051/054):
--   { "prep_min": 20, "prep_max": 35 }
-- Обратная совместимость: старый ключ prep_minutes читается как
-- min=max, если новых ключей нет (public-menu/фронт разбирают сами).
-- prep_min = prep_max = 0 → «не показывать» (как раньше).
--
-- set_online_prep_range заменяет set_online_prep_minutes (одно-арговый
-- оставляем как обёртку min=max=p_minutes для хвоста старых клиентов).
-- Право — прежнее 'online_pause' (тот же, что пауза/prep в 054).
--
-- get_online_order_status: + decided_at и prep_min/prep_max, чтобы
-- гость мог показать таймер «готово через ~N мин» (accepted + макс).
-- Деплой edge functions public-menu И public-order после миграции.
-- ============================================================

-- ── Время приготовления: вилка мин–макс ─────────────────────
CREATE OR REPLACE FUNCTION set_online_prep_range(
  p_min           INTEGER,
  p_max           INTEGER,
  p_staff_session UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc UUID := auth_location_id();
BEGIN
  IF v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'online_pause');

  IF p_min IS NULL OR p_max IS NULL
     OR p_min < 0 OR p_max < 0 OR p_min > 180 OR p_max > 180
     OR p_max < p_min THEN
    RAISE EXCEPTION 'invalid prep minutes';
  END IF;

  -- Пишем новые ключи и вычищаем legacy prep_minutes, чтобы не было
  -- рассинхрона (public-menu отдаёт приоритет новым ключам)
  UPDATE locations SET settings = jsonb_set(
    COALESCE(settings, '{}'::jsonb),
    '{online_orders}',
    (COALESCE(settings -> 'online_orders', '{}'::jsonb) - 'prep_minutes')
      || jsonb_build_object('prep_min', p_min, 'prep_max', p_max)
  )
  WHERE id = v_loc;
END $$;

REVOKE EXECUTE ON FUNCTION set_online_prep_range FROM anon, public;

-- ── Обёртка старого одно-аргового RPC: min=max (совместимость) ─
CREATE OR REPLACE FUNCTION set_online_prep_minutes(
  p_minutes       INTEGER,
  p_staff_session UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_online_prep_range(p_minutes, p_minutes, p_staff_session);
END $$;

REVOKE EXECUTE ON FUNCTION set_online_prep_minutes FROM anon, public;

-- ── get_online_order_status: + decided_at + вилка prep ──────
-- Гость строит таймер: старт = decided_at (момент принятия кассой),
-- финиш = decided_at + prep_max минут. prep_min/max читаем из
-- настроек точки (legacy prep_minutes → min=max как запасной вариант).
-- ============================================================
CREATE OR REPLACE FUNCTION get_online_order_status(p_client_uuid UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_oo   online_orders%ROWTYPE;
  v_o    orders%ROWTYPE;
  v_oo_s JSONB;         -- settings.online_orders точки
  v_min  INTEGER;
  v_max  INTEGER;
BEGIN
  SELECT * INTO v_oo FROM online_orders WHERE client_uuid = p_client_uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_oo.order_id IS NOT NULL THEN
    SELECT * INTO v_o FROM orders WHERE id = v_oo.order_id;
  END IF;

  SELECT settings -> 'online_orders' INTO v_oo_s FROM locations WHERE id = v_oo.location_id;
  -- Новые ключи в приоритете; legacy prep_minutes = min=max
  v_min := COALESCE((v_oo_s ->> 'prep_min')::INTEGER, (v_oo_s ->> 'prep_minutes')::INTEGER, 0);
  v_max := COALESCE((v_oo_s ->> 'prep_max')::INTEGER, (v_oo_s ->> 'prep_minutes')::INTEGER, 0);

  RETURN json_build_object(
    'status',        v_oo.status,
    'reject_reason', v_oo.reject_reason,
    'total',         COALESCE(v_o.total, v_oo.total),
    'daily_number',  v_o.daily_number,
    'order_status',  v_o.status,
    'order_type',    v_oo.order_type,
    'created_at',    v_oo.created_at,
    -- Таймер у гостя (061): момент принятия и вилка приготовления
    'decided_at',    v_oo.decided_at,
    'prep_min',      v_min,
    'prep_max',      v_max
  );
END $$;

REVOKE ALL ON FUNCTION get_online_order_status FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_online_order_status TO service_role;
