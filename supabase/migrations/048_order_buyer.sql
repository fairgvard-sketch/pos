-- ============================================================
-- 048 ORDER BUYER — реквизиты покупателя-бизнеса на чеке (B2B).
--
-- Сценарий: клиент забирает заказ для офиса и просит документ на
-- компанию — с названием и ח.פ./ע.מ, чтобы зачесть входной НДС.
-- Наш розничный документ и так חשבונית מס/קבלה (invoice_receipt,
-- 020) со сквозной нумерацией — отдельная серия НЕ нужна, достаточно
-- дополнить документ блоком реквизитов покупателя.
--
-- Поток: реквизиты добавляются ПОСЛЕ оплаты из окна чека (обычно
-- покупатель спохватывается у кассы) — set_order_buyer, затем чек
-- печатается уже с блоком покупателя.
--
-- Правила:
--   * только на оплаченных/выданных заказах (документ существует);
--   * один раз: повторная смена реквизитов фискального документа
--     запрещена ('buyer already set') — опечатку исправляет возврат
--     и новый чек, как с любым другим реквизитом документа;
--   * ח.פ./ע.מ — 9 цифр (израильский формат), опционален (частник
--     может попросить документ просто на имя).
--
-- allocation_number (מספר הקצאה, реформа חשבונית ישראל) уже есть
-- с 020 — когда пороги дойдут до розничных сумм, здесь появится
-- вызов API налоговой; схема готова.
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS buyer_name   TEXT,
  ADD COLUMN IF NOT EXISTS buyer_tax_id TEXT;

CREATE OR REPLACE FUNCTION set_order_buyer(
  p_order_id UUID,
  p_name     TEXT,
  p_tax_id   TEXT DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org    UUID := auth_org_id();
  v_order  orders%ROWTYPE;
  v_name   TEXT := NULLIF(TRIM(p_name), '');
  v_tax_id TEXT := NULLIF(TRIM(COALESCE(p_tax_id, '')), '');
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'buyer');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'buyer name required';
  END IF;
  IF v_tax_id IS NOT NULL AND v_tax_id !~ '^\d{9}$' THEN
    RAISE EXCEPTION 'invalid tax id';
  END IF;

  SELECT * INTO v_order FROM orders
  WHERE id = p_order_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_order.status NOT IN ('paid', 'fulfilled') THEN
    RAISE EXCEPTION 'order not paid';
  END IF;
  IF v_order.buyer_name IS NOT NULL THEN
    RAISE EXCEPTION 'buyer already set';
  END IF;

  UPDATE orders SET buyer_name = v_name, buyer_tax_id = v_tax_id
  WHERE id = p_order_id;
END $$;

REVOKE EXECUTE ON FUNCTION set_order_buyer FROM anon, public;
