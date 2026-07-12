-- ============================================================
-- 057 RESERVATION SEATING — посадка брони за стол → открытие счёта.
--
-- Дополняет публичную бронь (053): подтверждённую бронь с назначенным
-- столом касса «сажает» — открывается обычный счёт стола
-- (open_or_get_table_order, 013) и привязывается к брони (order_id).
-- Дальше — обычный флоу зала (дозаказ/оплата). Требует открытой смены
-- (её enforce'ит open_or_get_table_order).
--
-- Без нового статуса: «посажен» = confirmed + order_id IS NOT NULL.
-- Так публичный флоу 053 (new→confirmed→rejected|cancelled) не меняется,
-- а UI кассы отличает посаженную бронь по наличию order_id.
-- ============================================================

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id) ON DELETE SET NULL;

-- ============================================================
-- RPC: seat_reservation — открыть счёт стола для подтверждённой брони.
-- Идемпотентно: повтор по уже посаженной (order_id открыт) вернёт тот
-- же счёт. Стол, занятый другим открытым счётом, → table_busy.
-- ============================================================
CREATE OR REPLACE FUNCTION seat_reservation(p_id UUID, p_staff_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_r         reservations%ROWTYPE;
  v_order_res JSON;
  v_order_id  UUID;
  v_o         orders%ROWTYPE;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT * INTO v_r FROM reservations
    WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found';
  END IF;
  IF v_r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'not confirmed';
  END IF;
  IF v_r.table_id IS NULL THEN
    RAISE EXCEPTION 'no_table';
  END IF;

  -- Уже посажены и счёт ещё открыт → вернуть его (double-tap безопасен)
  IF v_r.order_id IS NOT NULL THEN
    SELECT * INTO v_o FROM orders WHERE id = v_r.order_id;
    IF FOUND AND v_o.status = 'open' THEN
      RETURN json_build_object('order_id', v_o.id, 'daily_number', v_o.daily_number,
                               'total', v_o.total, 'existing', TRUE);
    END IF;
  END IF;

  -- Стол занят другим открытым счётом → пусть кассир решит вручную
  IF EXISTS (SELECT 1 FROM orders WHERE table_id = v_r.table_id AND status = 'open') THEN
    RAISE EXCEPTION 'table_busy';
  END IF;

  -- Открыть счёт стола (требует открытой смены — enforced внутри)
  v_order_res := open_or_get_table_order(v_r.table_id, p_staff_id);
  v_order_id  := (v_order_res ->> 'order_id')::UUID;

  UPDATE reservations SET order_id = v_order_id WHERE id = p_id;

  RETURN json_build_object(
    'order_id',     v_order_id,
    'daily_number', (v_order_res ->> 'daily_number')::INTEGER,
    'total',        (v_order_res ->> 'total')::INTEGER,
    'existing',     FALSE
  );
END $$;

REVOKE EXECUTE ON FUNCTION seat_reservation FROM anon, public;
