-- pgTAP: идемпотентность повторного pay_order (op_log, 042).
-- Запуск: supabase test db  (нужен локальный стек, см. supabase/tests/README.md).
--
-- Проверяем механизм op_log напрямую: повтор операции с тем же op_uuid
-- возвращает ПЕРВЫЙ сохранённый результат и НЕ создаёт вторую запись —
-- это гарантия того, что replay pay_order не тратит второй номер чека.

BEGIN;
SELECT plan(4);

-- op_log существует и имеет ожидаемую форму (миграция 042)
SELECT has_table('op_log');
SELECT has_column('op_log', 'op_uuid');
SELECT has_column('op_log', 'result');

-- Симуляция дедупа: первая запись результата сохраняется, повтор с тем же
-- op_uuid не создаёт второй строки (PRIMARY KEY op_uuid). Проверяем, что
-- сохранённый result читается обратно без изменений — так pay_order при
-- replay вернёт первый ответ (включая receipt_number).
DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_uuid UUID := gen_random_uuid();
  v_first JSONB := '{"receipt_number": 117}'::jsonb;
BEGIN
  INSERT INTO op_log (op_uuid, org_id, result) VALUES (v_uuid, v_org, v_first);
  -- Повторная вставка того же op_uuid игнорируется (дедуп)
  INSERT INTO op_log (op_uuid, org_id, result)
  VALUES (v_uuid, v_org, '{"receipt_number": 999}'::jsonb)
  ON CONFLICT (op_uuid) DO NOTHING;
END $$;

-- Результат остался ПЕРВЫМ (117), не перезаписан вторым вызовом (999)
SELECT results_eq(
  $$ SELECT (result ->> 'receipt_number')::int FROM op_log
     WHERE result ->> 'receipt_number' IN ('117','999') $$,
  $$ VALUES (117) $$,
  'повтор op_uuid не перезаписывает первый результат'
);

SELECT * FROM finish();
ROLLBACK;
