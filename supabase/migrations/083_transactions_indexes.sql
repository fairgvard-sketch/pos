-- 083: индексы журнала операций (P1 — история вместо limit 200).
--
-- Экран «Операции» переходит на серверную пагинацию и фильтры: период,
-- номер чека/заказа, стол, сотрудник, способ оплаты. Базовый порядок —
-- (location_id, paid_at DESC); поиск по номеру чека — точечный.

CREATE INDEX IF NOT EXISTS idx_orders_loc_paid
  ON orders (location_id, paid_at DESC)
  WHERE paid_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_loc_receipt
  ON orders (location_id, receipt_number)
  WHERE receipt_number IS NOT NULL;
