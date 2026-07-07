-- ============================================================
-- 019 RECEIPT DETAILS — реквизиты заведения для чека.
--
-- Поля печатаются в шапке/подвале чека. Хранятся на locations
-- (у каждой точки свои). Все необязательные — пустое просто не
-- печатается. RLS: существующая политика locations_all (по org).
-- ============================================================

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS receipt_business_name TEXT,  -- название для чека (если ≠ name)
  ADD COLUMN IF NOT EXISTS receipt_address       TEXT,  -- адрес
  ADD COLUMN IF NOT EXISTS receipt_tax_id         TEXT,  -- מס׳ עוסק / налоговый номер
  ADD COLUMN IF NOT EXISTS receipt_phone          TEXT,  -- телефон
  ADD COLUMN IF NOT EXISTS receipt_footer         TEXT;  -- нижняя строка («Спасибо!»)
