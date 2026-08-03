-- ============================================================
-- 139. Сквозной номер онлайн-заявки — то, чем её называют вслух.
--
-- Что было не так: у `online_orders` нет ни одного человеческого номера.
--   * кабинет показывал хвост UUID («#A3F19») — его нельзя продиктовать
--     по телефону и нельзя сверить с бумагой;
--   * гость standalone-точки не видел вообще ничего: `daily_number`
--     появляется только после конверсии заявки в POS-заказ;
--   * `daily_number` сбрасывается каждый день, поэтому «заказ №42»
--     недельной давности неотличим от сегодняшнего — искать по нему
--     историю нельзя.
--
-- Здесь: счётчик НА ТОЧКУ, который НЕ сбрасывается по дням. Номер
-- выдаётся один раз, не переиспользуется и остаётся у заявки навсегда —
-- в отличие от дневного номера кассы, который отвечает на другой вопрос
-- («какой ты по счёту сегодня у стойки»).
--
-- Нумерация начинается с 1001 сознательно: четырёхзначный номер сразу
-- читается как номер заявки и не путается с дневным номером кассы,
-- который редко переваливает за сотню. Оба номера у POS-заявки живут
-- рядом и означают разное: #1042 — заявка, #43 — заказ на терминале.
--
-- Номер ставит ТРИГГЕР, а не `submit_online_order`. Функция приёма
-- заявки переписывалась уже восемь раз (050→051→054→058→100→101→112→116)
-- и каждое повторение тела — риск потерять ранее восстановленный гейт
-- (так уже случалось в 058, см. комментарий в 116). Триггер закрывает
-- ВСЕ пути вставки, включая будущие, и не требует трогать 300 строк
-- проверок цен, часов и антиспама.
--
-- Финансовых записей это не касается: `online_orders` — заявка, а не
-- заказ; фискальная нумерация (020) и `orders.daily_number` (004) не
-- меняются.
--
-- ⚠️ ТРЕБУЕТ 050 (online_orders), 105 (get_online_order_status v4).
-- ============================================================

-- ── Счётчик точки ────────────────────────────────────────────
-- Тот же приём, что у дневного номера кассы (`order_counters`, 004):
-- атомарный upsert вместо MAX()+1, поэтому две параллельные заявки не
-- получат один номер.
CREATE TABLE IF NOT EXISTS online_order_counters (
  location_id UUID PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  counter     INTEGER NOT NULL
);

COMMENT ON TABLE online_order_counters IS
  'Сквозной счётчик номеров онлайн-заявок на точку (139). Не сбрасывается по дням — в отличие от order_counters (004).';

ALTER TABLE online_order_counters ENABLE ROW LEVEL SECURITY;
-- Счётчик — служебная запись: читать и писать его клиенту незачем,
-- номер приходит уже в строке заявки.
REVOKE ALL ON online_order_counters FROM anon, authenticated;

-- ── Номер заявки ─────────────────────────────────────────────
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS order_number INTEGER;

COMMENT ON COLUMN online_orders.order_number IS
  'Человеческий номер заявки, сквозной в пределах точки и не сбрасывающийся по дням (139). Не путать с orders.daily_number.';

-- Бэкфилл: старым заявкам номера раздаются в порядке их появления,
-- чтобы «раньше пришла — меньше номер» выполнялось и для истории.
WITH numbered AS (
  SELECT
    id,
    1000 + ROW_NUMBER() OVER (
      PARTITION BY location_id ORDER BY created_at, id
    ) AS number
  FROM online_orders
  WHERE order_number IS NULL
)
UPDATE online_orders o
SET order_number = numbered.number
FROM numbered
WHERE o.id = numbered.id;

-- Счётчик встаёт на последний выданный номер точки; точка без заявок
-- начнёт с 1001 при первой вставке (см. триггер ниже).
INSERT INTO online_order_counters (location_id, counter)
SELECT location_id, MAX(order_number)
FROM online_orders
WHERE order_number IS NOT NULL
GROUP BY location_id
ON CONFLICT (location_id) DO UPDATE
  SET counter = GREATEST(online_order_counters.counter, EXCLUDED.counter);

-- Номер обязан быть уникальным внутри точки: по нему ищут заявку.
CREATE UNIQUE INDEX IF NOT EXISTS online_orders_number_uidx
  ON online_orders(location_id, order_number);

-- ── Выдача номера ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION online_orders_assign_number()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Явно переданный номер уважаем (восстановление из дампа), иначе
  -- берём следующий у точки.
  IF NEW.order_number IS NULL THEN
    INSERT INTO online_order_counters (location_id, counter)
    VALUES (NEW.location_id, 1001)
    ON CONFLICT (location_id)
      DO UPDATE SET counter = online_order_counters.counter + 1
    RETURNING counter INTO NEW.order_number;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION online_orders_assign_number() IS
  'BEFORE INSERT online_orders: сквозной номер заявки из счётчика точки (139).';

DROP TRIGGER IF EXISTS trg_online_orders_number ON online_orders;
CREATE TRIGGER trg_online_orders_number
  BEFORE INSERT ON online_orders
  FOR EACH ROW
  EXECUTE FUNCTION online_orders_assign_number();

-- ============================================================
-- get_online_order_status: тело 105 дословно + номер заявки.
--
-- Гостю standalone-точки показывать было нечего: `daily_number`
-- заполняется только после конверсии в POS-заказ. Теперь у заявки есть
-- собственный номер, и он уезжает на страницу статуса.
-- ============================================================
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
  -- Capability-гейт (105): статус заявки — часть продукта Orders.
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
    'daily_number',  v_o.daily_number,
    -- Номер заявки (139): есть всегда, в отличие от номера на кассе.
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
  'Статус заявки для гостя: тело 105 + сквозной номер заявки order_number (139).';

-- ============================================================
-- ОТКАТ / ВОССТАНОВЛЕНИЕ
--
-- Forward-only. Колонка `order_number` не удаляется — номера уже
-- названы гостям. Функциональный откат: снять триггер
--   DROP TRIGGER trg_online_orders_number ON online_orders;
-- Тогда новые заявки останутся без номера, а старые сохранят свой.
--
-- ПРОВЕРКА на целевой базе:
--   SELECT location_id, MIN(order_number), MAX(order_number), COUNT(*)
--   FROM online_orders GROUP BY location_id;
--   SELECT * FROM online_order_counters;
-- Номеров без значения быть не должно:
--   SELECT COUNT(*) FROM online_orders WHERE order_number IS NULL;  -- 0
-- ============================================================
