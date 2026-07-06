-- ============================================================
-- 010 QUEUE — очередь бариста.
--
-- Модель:
--   * Экран очереди показывает оплаченные заказы (status = 'paid').
--   * У каждой позиции — свой статус готовности (pending → ready),
--     чтобы бар и кухня отмечали независимо.
--   * Когда ВСЕ позиции заказа ready → заказ fulfilled (уходит
--     из очереди). Логика в mark_item_ready().
--   * Запись — только через RPC (клиент не пишет статусы напрямую).
-- ============================================================

ALTER TABLE order_items
  ADD COLUMN prep_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (prep_status IN ('pending', 'ready'));

ALTER TABLE order_items ADD COLUMN ready_at TIMESTAMPTZ;

-- Быстрый разбор очереди: позиции незакрытых заказов по станции
CREATE INDEX idx_order_items_prep ON order_items(prep_status);

-- ============================================================
-- RPC: mark_item_ready — отметить позицию готовой (или снять).
-- Если после отметки все позиции заказа ready → fulfilled.
-- Возвращает новый статус заказа.
-- ============================================================
CREATE OR REPLACE FUNCTION mark_item_ready(p_item_id UUID, p_ready BOOLEAN DEFAULT TRUE)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_order_id UUID;
  v_pending  INTEGER;
  v_status   TEXT;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  UPDATE order_items
  SET prep_status = CASE WHEN p_ready THEN 'ready' ELSE 'pending' END,
      ready_at    = CASE WHEN p_ready THEN NOW() ELSE NULL END
  WHERE id = p_item_id AND org_id = v_org
  RETURNING order_id INTO v_order_id;

  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'item not found';
  END IF;

  -- Осталось незакрытых позиций в заказе?
  SELECT COUNT(*) INTO v_pending
  FROM order_items
  WHERE order_id = v_order_id AND prep_status = 'pending';

  -- Заказ закрывается/переоткрывается только из paid/fulfilled (не трогаем voided)
  IF v_pending = 0 THEN
    UPDATE orders SET status = 'fulfilled', fulfilled_at = NOW()
    WHERE id = v_order_id AND status = 'paid'
    RETURNING status INTO v_status;
  ELSE
    -- Сняли готовность у позиции ранее закрытого заказа → вернуть в очередь
    UPDATE orders SET status = 'paid', fulfilled_at = NULL
    WHERE id = v_order_id AND status = 'fulfilled'
    RETURNING status INTO v_status;
  END IF;

  IF v_status IS NULL THEN
    SELECT status INTO v_status FROM orders WHERE id = v_order_id;
  END IF;

  RETURN json_build_object('order_id', v_order_id, 'order_status', v_status, 'pending_items', v_pending);
END $$;

-- ============================================================
-- RPC: mark_order_ready — отметить весь заказ готовым разом
-- (кнопка «всё готово» на карточке)
-- ============================================================
CREATE OR REPLACE FUNCTION mark_order_ready(p_order_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  UPDATE order_items
  SET prep_status = 'ready', ready_at = NOW()
  WHERE order_id = p_order_id AND org_id = v_org AND prep_status = 'pending';

  UPDATE orders SET status = 'fulfilled', fulfilled_at = NOW()
  WHERE id = p_order_id AND org_id = v_org AND status = 'paid';

  RETURN json_build_object('order_id', p_order_id, 'order_status', 'fulfilled');
END $$;

REVOKE EXECUTE ON FUNCTION mark_item_ready, mark_order_ready FROM anon, public;
