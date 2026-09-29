-- 177: восстановление состава гостевого заказа после перезагрузки.
--
-- online_orders.items уже хранит серверный снимок названий, вариантов,
-- добавок и цен на момент отправки. Возвращаем этот снимок по тому же
-- client_uuid, который служит секретом гостевой страницы статуса.
-- Финансовые записи и сохранённая заявка не изменяются.

CREATE OR REPLACE FUNCTION get_online_order_status(p_client_uuid UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_oo   online_orders%ROWTYPE;
  v_o    orders%ROWTYPE;
  v_oo_s JSONB;
  v_min  INTEGER;
  v_max  INTEGER;
BEGIN
  SELECT * INTO v_oo
  FROM online_orders
  WHERE client_uuid = p_client_uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT org_has_capability(v_oo.org_id, 'online_orders') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;
  IF v_oo.order_id IS NOT NULL THEN
    SELECT * INTO v_o FROM orders WHERE id = v_oo.order_id;
  END IF;

  SELECT settings -> 'online_orders'
  INTO v_oo_s
  FROM locations
  WHERE id = v_oo.location_id;
  v_min := COALESCE(
    (v_oo_s ->> 'prep_min')::INTEGER,
    (v_oo_s ->> 'prep_minutes')::INTEGER,
    0
  );
  v_max := COALESCE(
    (v_oo_s ->> 'prep_max')::INTEGER,
    (v_oo_s ->> 'prep_minutes')::INTEGER,
    0
  );

  RETURN json_build_object(
    'status',        v_oo.status,
    'reject_reason', v_oo.reject_reason,
    -- У стола настоящий счёт может содержать несколько QR-дозаказов;
    -- конкретному гостю показываем сумму именно его заявки.
    'total',         CASE
                       WHEN v_oo.table_id IS NOT NULL THEN v_oo.total
                       ELSE COALESCE(v_o.total, v_oo.total)
                     END,
    -- Состав берётся из серверного снимка заявки, а не из текущего меню:
    -- переименование блюда или смена цены не перепишут историю гостя.
    'items',         v_oo.items,
    'daily_number',  v_o.daily_number,
    'order_number',  v_oo.order_number,
    'order_status',  v_o.status,
    'order_type',    v_oo.order_type,
    'table_label',   v_oo.table_label,
    'order_channel', v_oo.order_channel,
    'created_at',    v_oo.created_at,
    'decided_at',    v_oo.decided_at,
    'prep_min',      v_min,
    'prep_max',      v_max
  );
END $$;

REVOKE ALL ON FUNCTION get_online_order_status(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_online_order_status(UUID) TO service_role;

COMMENT ON FUNCTION get_online_order_status(UUID) IS
  'Статус и серверный снимок состава гостевой заявки по client_uuid (177).';
