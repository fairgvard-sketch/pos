-- ============================================================
-- 005 — Избранное в меню + режим обслуживания точки
-- ============================================================

-- Избранные товары: первая вкладка кассы (самое продаваемое — в 1 тап)
ALTER TABLE menu_items ADD COLUMN is_favorite BOOLEAN NOT NULL DEFAULT FALSE;

-- Режим обслуживания точки:
--   counter        — стойка (заказ+оплата у кассы)
--   counter_tables — стойка + номер стола на заказе («куда нести»)
--   tables         — полный режим столов с открытыми счетами (фаза 6)
ALTER TABLE locations ADD COLUMN service_mode TEXT NOT NULL DEFAULT 'counter'
  CHECK (service_mode IN ('counter', 'counter_tables', 'tables'));
