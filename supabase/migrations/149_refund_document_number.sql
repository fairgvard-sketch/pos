-- ============================================================
-- 149 НОМЕР ДОКУМЕНТА ВОЗВРАТА ВОЗВРАЩАЕТСЯ НА МЕСТО
--
-- ЧТО СЛОМАЛОСЬ. Миграция 029 завела для תעודת זיכוי собственную
-- сквозную непрерывную нумерацию: `refunds.location_id` +
-- `refunds.refund_number` из счётчика `refund_counters`, атомарно
-- внутри `issue_refund`. Требование рשות המסים: возврат — отдельный
-- фискальный документ со своей непрерывной нумерацией.
--
-- Миграция 044 переписала `issue_refund` под staff-сессии через
-- DROP + CREATE — и обе колонки вместе с инкрементом счётчика в новом
-- теле не появились. 046 перенесла тело дальше. С тех пор ни одна
-- живая функция не трогает `refund_counters` вообще.
--
-- ЧТО ЭТО ЗНАЧИЛО. Каждый возврат создавался с location_id = NULL и
-- refund_number = NULL, поэтому:
--   * на печатном зикуе вместо номера прочерк (printCanvas рисует
--     `refund_number ?? '—'`);
--   * выгрузка Единого формата отбирает возвраты условием
--     `location_id = точка AND refund_number IS NOT NULL` (073/107) —
--     под него не подходил НИ ОДИН возврат, и в наборе מבנה אחיד не
--     было ни одного документа типа 330. Оборот в наборе завышен на
--     сумму возвратов периода.
--   * непрерывной нумерации кредитных нот не существовало.
--
-- Деньги при этом были целы: возврат пишет отрицательный `payments`,
-- поэтому отчёт продаж и Z-отчёт считали верно. Ломалась документарная
-- фискальная часть.
--
-- ЧТО ЗДЕСЬ. Нумерация переезжает из тела функции в ТРИГГЕР таблицы.
-- Это и есть главная правка: в 029 она жила внутри `issue_refund`,
-- поэтому переписывание функции смогло её потерять. На триггере любая
-- будущая правка `issue_refund` (и любой новый путь создания возврата —
-- их в истории уже четыре) не сможет выкинуть номер молча.
--
-- Исторические возвраты НЕ нумеруются: задним числом присвоить номер
-- документу, который уже напечатан с прочерком, — решение владельца и
-- его бухгалтера, а не миграции. Отдельный шаг, когда решение будет
-- принято.
--
-- Forward-only: 029/044/046 не редактируются.
-- ⚠️ ТРЕБУЕТ 029 (refund_counters, колонки refunds).
-- ============================================================

-- ── Номер документа присваивает таблица, а не вызывающий ─────
-- SECURITY DEFINER: `refund_counters` закрыт RLS, а писать в него
-- обязан любой путь возврата. BEFORE INSERT — номер попадает в ту же
-- строку и ту же транзакцию, отдельного UPDATE нет.
CREATE OR REPLACE FUNCTION refunds_assign_document_number()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc UUID;
BEGIN
  -- Точка документа: своя, если вызывающий её знает, иначе — точка
  -- заказа. `auth_location_id()` здесь намеренно НЕ используется:
  -- возврат может оформляться из бэкофиса, где точки в JWT нет.
  v_loc := COALESCE(
    NEW.location_id,
    (SELECT o.location_id FROM orders o WHERE o.id = NEW.order_id)
  );

  IF v_loc IS NULL THEN
    -- Возврат без точки — документ без эмитента. Такого быть не должно:
    -- лучше отказ, чем ещё одна строка, невидимая для выгрузки.
    RAISE EXCEPTION 'refund without location';
  END IF;

  NEW.location_id := v_loc;

  -- Номер выдаётся один раз. Повтор (idempotency-путь `issue_refund`
  -- до вставки не доходит, но пути создания возврата ещё будут
  -- меняться) не тратит номер: непрерывность важнее.
  IF NEW.refund_number IS NULL THEN
    INSERT INTO refund_counters (location_id, counter)
    VALUES (v_loc, 1)
    ON CONFLICT (location_id)
    DO UPDATE SET counter = refund_counters.counter + 1
    RETURNING counter INTO NEW.refund_number;
  END IF;

  RETURN NEW;
END $$;

REVOKE EXECUTE ON FUNCTION refunds_assign_document_number() FROM anon, public;

DROP TRIGGER IF EXISTS trg_refunds_document_number ON refunds;
CREATE TRIGGER trg_refunds_document_number
  BEFORE INSERT ON refunds
  FOR EACH ROW EXECUTE FUNCTION refunds_assign_document_number();

COMMENT ON FUNCTION refunds_assign_document_number() IS
  'Сквозной номер תעודת זיכוי и точка документа на каждый возврат (149). '
  'Живёт триггером, а не в issue_refund: в 029 нумерация была в теле '
  'функции и потерялась при её переписывании в 044.';

-- ── Счётчик не должен отстать от уже выданных номеров ────────
-- До 044 номера выдавались (029), потом перестали. Если в точке уже
-- есть пронумерованные возвраты, счётчик обязан продолжить с них, а не
-- начать с единицы: два документа с номером 7 — хуже, чем пропуск.
INSERT INTO refund_counters (location_id, counter)
SELECT r.location_id, MAX(r.refund_number)
FROM refunds r
WHERE r.location_id IS NOT NULL AND r.refund_number IS NOT NULL
GROUP BY r.location_id
ON CONFLICT (location_id)
DO UPDATE SET counter = GREATEST(refund_counters.counter, EXCLUDED.counter);
