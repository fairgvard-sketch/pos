-- ============================================================
-- 113. Лояльность в онлайн-заказах
--
-- Заявка с сайта несёт customer_phone (одни цифры, 050), но заказ
-- создавался без guest_id — гость, заказавший онлайн, не получал ни
-- штампов, ни баллов. Здесь accept_online_order сам находит гостя по
-- телефону в рамках org (создавая при первом заказе) и привязывает его
-- к заказу. Начисление остаётся там же, где было: pay_order (046)
-- начисляет по orders.guest_id в момент оплаты.
--
-- Инварианты:
--   * балансы меняет только сервер — здесь мы лишь проставляем связь;
--   * ничего не списываем: награда за онлайн-заказ выбирается кассиром
--     на кассе через apply_loyalty, как и раньше;
--   * идемпотентность accept_online_order сохранена (повтор по
--     статусу 'accepted' возвращает тот же заказ до всякой записи);
--   * при выключенной программе (loyalty_mode='off') гость не заводится.
-- ============================================================

-- ── Найти или завести гостя по телефону ─────────────────────
-- Только для серверных вызовов: клиент по-прежнему создаёт гостей
-- через INSERT с колоночными грантами (031).
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

  RETURN v_guest_id;
END $$;

REVOKE ALL ON FUNCTION upsert_guest_by_phone(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ── accept_online_order: привязка гостя к создаваемому заказу ──
-- Тело — копия 099 с одним добавленным шагом (см. «113» ниже).
CREATE OR REPLACE FUNCTION accept_online_order(
  p_online_id UUID,
  p_staff_id  UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_oo       online_orders%ROWTYPE;
  v_items    JSONB;
  v_res      JSON;
  v_order_id UUID;
  v_o        orders%ROWTYPE;
  v_table_order_existed BOOLEAN := FALSE;
  v_loyalty_mode TEXT;
  v_guest_id UUID;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_oo
  FROM online_orders
  WHERE id = p_online_id AND org_id = v_org
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'online order not found';
  END IF;
  IF v_oo.status = 'accepted' THEN
    SELECT * INTO v_o FROM orders WHERE id = v_oo.order_id;
    RETURN json_build_object(
      'order_id', v_o.id,
      'daily_number', v_o.daily_number,
      'total', v_o.total,
      'duplicate', TRUE
    );
  END IF;
  IF v_oo.status <> 'new' THEN
    RAISE EXCEPTION 'already decided';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'menu_item_id', e -> 'menu_item_id',
    'variant_id',   e -> 'variant_id',
    'modifier_ids', COALESCE(e -> 'modifier_ids', '[]'::jsonb),
    'qty',          e -> 'qty',
    'notes',        e -> 'notes'
  ))
  INTO v_items
  FROM jsonb_array_elements(v_oo.items) e;

  IF v_oo.table_id IS NOT NULL THEN
    -- Новый QR-заказ открывает счёт; следующий QR-заказ того же стола
    -- становится дозаказом в уже открытый счёт.
    v_res := open_or_get_table_order(
      p_table_id      := v_oo.table_id,
      p_staff_id      := p_staff_id,
      p_client_uuid   := v_oo.client_uuid,
      p_opened_at     := v_oo.created_at,
      p_staff_session := NULL
    );
    v_order_id := (v_res ->> 'order_id')::UUID;
    v_table_order_existed := COALESCE((v_res ->> 'existing')::BOOLEAN, FALSE);

    PERFORM append_to_order(
      p_order_id      := v_order_id,
      p_staff_id      := p_staff_id,
      p_items         := v_items,
      p_op_uuid       := v_oo.client_uuid,
      p_staff_session := NULL
    );
  ELSE
    v_res := place_order(
      p_client_uuid   := v_oo.client_uuid,
      p_staff_id      := p_staff_id,
      p_order_type    := v_oo.order_type,
      p_customer_name := v_oo.customer_name,
      p_items         := v_items,
      p_staff_session := NULL
    );
    IF (v_res ->> 'duplicate')::BOOLEAN THEN
      RAISE EXCEPTION 'client uuid conflict';
    END IF;
    v_order_id := (v_res ->> 'order_id')::UUID;
  END IF;

  -- ── 113: гость лояльности по телефону заявки ──────────────
  -- Только при включённой программе и только если заказ ещё не привязан
  -- к гостю вручную (счёт стола мог быть открыт кассиром с гостем).
  SELECT loyalty_mode INTO v_loyalty_mode
  FROM locations WHERE id = v_oo.location_id;

  IF COALESCE(v_loyalty_mode, 'off') <> 'off' THEN
    v_guest_id := upsert_guest_by_phone(v_org, v_oo.customer_phone, v_oo.customer_name);
  END IF;

  UPDATE orders
  SET source = CASE
        -- Не превращаем весь ранее открытый POS-счёт стола в online revenue:
        -- QR здесь лишь добавил новые строки в смешанный счёт.
        WHEN v_oo.table_id IS NOT NULL AND v_table_order_existed THEN source
        ELSE 'site'
      END,
      customer_phone = COALESCE(NULLIF(v_oo.customer_phone, ''), customer_phone),
      pickup_at = v_oo.pickup_at,
      delivery_address = v_oo.delivery_address,
      order_channel = v_oo.order_channel,
      -- COALESCE: ручная привязка кассира на открытом счёте приоритетнее
      guest_id = COALESCE(guest_id, v_guest_id)
  WHERE id = v_order_id;

  UPDATE online_orders
  SET status = 'accepted',
      order_id = v_order_id,
      decided_by = p_staff_id,
      decided_at = NOW()
  WHERE id = p_online_id;

  SELECT * INTO v_o FROM orders WHERE id = v_order_id;
  RETURN json_build_object(
    'order_id', v_o.id,
    'daily_number', v_o.daily_number,
    'total', v_o.total,
    'duplicate', FALSE
  );
END $$;

REVOKE EXECUTE ON FUNCTION accept_online_order(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_online_order(UUID, UUID) TO authenticated;
