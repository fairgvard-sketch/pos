-- ============================================================
-- 150 ДОКУМЕНТ ЗАПОМИНАЕТ, КТО ЕГО ВЫПУСТИЛ
--
-- ЧТО НЕ ТАК СЕЙЧАС. Суммы, НДС, скидки, названия и цены позиций
-- снапшотятся в момент операции (инвариант 5). Личность эмитента — нет:
-- название бизнеса, ח.פ и адрес живут только колонками `locations`, и
-- каждый, кому нужен документ, читает их ЖИВЫМИ:
--   * печать и повторная печать — `printCanvas.ts` берёт
--     `location.receipt_business_name || location.name`, адрес, телефон,
--     ח.פ прямо из текущей строки точки;
--   * выгрузка Единого формата — `uf_export_info_for` (107) читает те же
--     колонки на момент ЭКСПОРТА.
--
-- Следствие: смена реквизитов задним числом меняет содержимое уже
-- выпущенных חשבונית и уже сданных наборов מבנה אחיד. Для требования
-- неизменности выпущенного документа это дефект.
--
-- ЧТО ЗДЕСЬ. Документ запоминает эмитента в момент, когда становится
-- документом, — то есть когда получает фискальный номер. Дальше правка
-- настроек точки на него не влияет.
--
-- Снапшот хранит РАЗРЕШЁННЫЕ значения, а не сырые колонки: на бумагу
-- уходит `COALESCE(receipt_business_name, name)`, и в слепке должно
-- лежать то же самое, иначе перепечатка разойдётся с оригиналом.
--
-- Три поля, а не пять: имя, ח.פ и адрес — то, что делает документ
-- документом, и ровно то, что берёт выгрузка УФ. Телефон и подпись внизу
-- чека — оформление (см. разделение в кабинете на Legal details и
-- Receipt appearance): их расхождение при перепечатке фискального смысла
-- не имеет.
--
-- Читающая сторона (печать и выгрузка) переводится на слепок ОТДЕЛЬНО:
-- здесь только захват, поведение не меняется ни на байт.
--
-- Forward-only. ⚠️ ТРЕБУЕТ 149 (триггер нумерации возвратов).
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS issuer_name    TEXT,
  ADD COLUMN IF NOT EXISTS issuer_tax_id  TEXT,
  ADD COLUMN IF NOT EXISTS issuer_address TEXT;

ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS issuer_name    TEXT,
  ADD COLUMN IF NOT EXISTS issuer_tax_id  TEXT,
  ADD COLUMN IF NOT EXISTS issuer_address TEXT;

COMMENT ON COLUMN orders.issuer_name IS
  'Кто выпустил документ, на момент выпуска (150). Не читать locations для уже выпущенного.';
COMMENT ON COLUMN orders.issuer_tax_id IS
  'ח.פ/עוסק מורשה на момент выпуска документа (150).';
COMMENT ON COLUMN orders.issuer_address IS
  'Адрес эмитента на момент выпуска документа (150).';

-- ── Заказ: снимок в момент присвоения номера чека ────────────
-- Номер присваивает `pay_order` (041/042/046 — три поколения тела).
-- Триггер, а не правка функции: причина та же, что в 149, где
-- нумерация возвратов потерялась при переписывании RPC.
CREATE OR REPLACE FUNCTION orders_snapshot_issuer()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name    TEXT;
  v_tax_id  TEXT;
  v_address TEXT;
BEGIN
  SELECT COALESCE(l.receipt_business_name, l.name), l.receipt_tax_id, l.receipt_address
    INTO v_name, v_tax_id, v_address
  FROM locations l
  WHERE l.id = NEW.location_id;

  NEW.issuer_name    := COALESCE(NEW.issuer_name, v_name);
  NEW.issuer_tax_id  := COALESCE(NEW.issuer_tax_id, v_tax_id);
  NEW.issuer_address := COALESCE(NEW.issuer_address, v_address);
  RETURN NEW;
END $$;

REVOKE EXECUTE ON FUNCTION orders_snapshot_issuer() FROM anon, public;

-- Два триггера с WHEN вместо одного без него: на `orders` идёт горячий
-- поток, и триггер обязан просыпаться только в момент выпуска документа,
-- а не на каждом апдейте заказа. `UPDATE OF receipt_number` сужает ещё
-- раз — тело не вызывается, если колонки нет в SET.
DROP TRIGGER IF EXISTS trg_orders_issuer_insert ON orders;
CREATE TRIGGER trg_orders_issuer_insert
  BEFORE INSERT ON orders
  FOR EACH ROW WHEN (NEW.receipt_number IS NOT NULL)
  EXECUTE FUNCTION orders_snapshot_issuer();

DROP TRIGGER IF EXISTS trg_orders_issuer_number ON orders;
CREATE TRIGGER trg_orders_issuer_number
  BEFORE UPDATE OF receipt_number ON orders
  FOR EACH ROW WHEN (NEW.receipt_number IS NOT NULL AND OLD.receipt_number IS NULL)
  EXECUTE FUNCTION orders_snapshot_issuer();

-- ── Возврат: снимок там же, где выдаётся номер (149) ─────────
-- Тело 149 сохранено дословно, добавлен только захват эмитента: у
-- возврата номер и точка появляются в одном месте, значит и слепок
-- снимать надо там же.
CREATE OR REPLACE FUNCTION refunds_assign_document_number()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc     UUID;
  v_name    TEXT;
  v_tax_id  TEXT;
  v_address TEXT;
BEGIN
  v_loc := COALESCE(
    NEW.location_id,
    (SELECT o.location_id FROM orders o WHERE o.id = NEW.order_id)
  );

  IF v_loc IS NULL THEN
    RAISE EXCEPTION 'refund without location';
  END IF;

  NEW.location_id := v_loc;

  IF NEW.refund_number IS NULL THEN
    INSERT INTO refund_counters (location_id, counter)
    VALUES (v_loc, 1)
    ON CONFLICT (location_id)
    DO UPDATE SET counter = refund_counters.counter + 1
    RETURNING counter INTO NEW.refund_number;
  END IF;

  -- НОВОЕ (150): зикуй запоминает эмитента так же, как чек
  SELECT COALESCE(l.receipt_business_name, l.name), l.receipt_tax_id, l.receipt_address
    INTO v_name, v_tax_id, v_address
  FROM locations l
  WHERE l.id = v_loc;

  NEW.issuer_name    := COALESCE(NEW.issuer_name, v_name);
  NEW.issuer_tax_id  := COALESCE(NEW.issuer_tax_id, v_tax_id);
  NEW.issuer_address := COALESCE(NEW.issuer_address, v_address);

  RETURN NEW;
END $$;

COMMENT ON FUNCTION refunds_assign_document_number() IS
  'Номер документа возврата (149) и слепок эмитента (150). Триггером, а не в '
  'issue_refund: в 029 нумерация жила в теле функции и потерялась при её '
  'переписывании в 044.';

-- ── Backfill уже выпущенных документов ──────────────────────
-- ЧЕСТНО О ГРАНИЦАХ: подлинные реквизиты на момент выпуска прошлых
-- документов не восстановимы — их никто не сохранял, в том и дефект.
-- Здесь проставляются СЕГОДНЯШНИЕ значения точки. Это не делает прошлые
-- документы правильными задним числом; это останавливает дальнейший
-- дрейф: с этого момента правка настроек их уже не тронет.
UPDATE orders o
SET issuer_name    = COALESCE(l.receipt_business_name, l.name),
    issuer_tax_id  = l.receipt_tax_id,
    issuer_address = l.receipt_address
FROM locations l
WHERE l.id = o.location_id
  AND o.receipt_number IS NOT NULL
  AND o.issuer_name IS NULL;

UPDATE refunds r
SET issuer_name    = COALESCE(l.receipt_business_name, l.name),
    issuer_tax_id  = l.receipt_tax_id,
    issuer_address = l.receipt_address
FROM locations l
WHERE l.id = r.location_id
  AND r.refund_number IS NOT NULL
  AND r.issuer_name IS NULL;
