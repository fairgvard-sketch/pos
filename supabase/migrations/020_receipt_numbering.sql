-- ============================================================
-- 020 RECEIPT NUMBERING — фискальный фундамент (Израиль).
--
-- Требования רשות המסים:
--   * Сквозная НЕПРЕРЫВНАЯ нумерация документов (без пропусков),
--     отдельная от daily_number (#42 на сегодня — операционный, не
--     фискальный). receipt_number глобален по локации.
--   * Тип документа: חשבונית מס-קבלה (invoice_receipt) для розницы,
--     קבלה (receipt), חשבונית מס (tax_invoice).
--   * allocation_number (מספר הקצאה) — под реформу «חשבונית ישראל»:
--     онлайн-номер от налоговой для счетов выше порога. Пока NULL,
--     поле-заготовка (интеграция с API налоговой — отдельная фаза).
--
-- Номер присваивается ТОЛЬКО при оплате (pay_order): open-заказ ещё
-- не документ. Void до оплаты номер не тратит (непрерывность цела).
-- ============================================================

-- Тип фискального документа
DO $$ BEGIN
  CREATE TYPE doc_type AS ENUM ('receipt', 'tax_invoice', 'invoice_receipt');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS receipt_number   INTEGER,        -- сквозной номер документа
  ADD COLUMN IF NOT EXISTS doc_type         doc_type NOT NULL DEFAULT 'invoice_receipt',
  ADD COLUMN IF NOT EXISTS allocation_number TEXT;          -- מספר הקצאה (реформа), пока NULL

-- Сквозной счётчик документов на локацию. Отдельная таблица (не sequence),
-- чтобы номер был непрерывным на org/location и переживал сбои.
CREATE TABLE IF NOT EXISTS receipt_counters (
  location_id UUID PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  counter     INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE receipt_counters ENABLE ROW LEVEL SECURITY;

-- Уникальность номера в рамках локации (защита от дублей)
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_receipt_no
  ON orders(location_id, receipt_number) WHERE receipt_number IS NOT NULL;

-- ── Присвоение номера при оплате ─────────────────────────
-- Оборачиваем pay_order: после успешной оплаты, если номера ещё нет,
-- атомарно инкрементим счётчик локации и проставляем receipt_number.
-- (pay_order из 008 остаётся; тут добавляем присвоение номера отдельной
-- функцией, вызываемой клиентом сразу после pay_order — либо встроить
-- в pay_order позже. Пока отдельный RPC для минимального вмешательства.)
CREATE OR REPLACE FUNCTION assign_receipt_number(p_order_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org    UUID := auth_org_id();
  v_loc    UUID;
  v_status TEXT;
  v_existing INTEGER;
  v_number INTEGER;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT location_id, status, receipt_number
    INTO v_loc, v_status, v_existing
  FROM orders WHERE id = p_order_id AND org_id = v_org
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_status <> 'paid' THEN
    RAISE EXCEPTION 'order not paid';  -- номер только оплаченному документу
  END IF;

  -- Уже присвоен → идемпотентно вернуть
  IF v_existing IS NOT NULL THEN
    RETURN json_build_object('order_id', p_order_id, 'receipt_number', v_existing);
  END IF;

  -- Атомарный инкремент счётчика локации
  INSERT INTO receipt_counters (location_id, counter)
  VALUES (v_loc, 1)
  ON CONFLICT (location_id)
  DO UPDATE SET counter = receipt_counters.counter + 1
  RETURNING counter INTO v_number;

  UPDATE orders SET receipt_number = v_number WHERE id = p_order_id;

  RETURN json_build_object('order_id', p_order_id, 'receipt_number', v_number);
END $$;

REVOKE EXECUTE ON FUNCTION assign_receipt_number(UUID) FROM anon, public;
