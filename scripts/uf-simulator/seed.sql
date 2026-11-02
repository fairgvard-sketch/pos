-- ============================================================
-- Тестовый бизнес для официального симулятора Единого формата 1.31
-- (https://www.gov.il/he/service/file-review-simulator).
--
-- ТОЛЬКО ЛОКАЛЬНАЯ БАЗА. Запускается из scripts/uf-simulator/build-set.mjs,
-- который потом собирает и проверяет набор. Бизнес выдуманный:
-- «קפה לדוגמא», ח.פ 514000009 (контрольная цифра верна).
--
-- Продажи и возвраты проводятся НАСТОЯЩИМИ функциями кассы —
-- place_order / pay_order / set_order_buyer / issue_refund — под
-- device-JWT, как их вызывает касса: номера чеков, НДС, скидки,
-- слепок эмитента и номера зикуев выдаёт база, а не этот файл.
--
-- Объём под требования симулятора: ≥10 полных документов каждого
-- выпускаемого типа (320 и 330) и ~2000+ записей. Период — шесть
-- прошедших дней: place_order принимает время продажи не старше 7 дней
-- (clamp_client_ts, 042). issue_refund датирует возврат текущим
-- моментом, поэтому зикуи ложатся на сегодняшний день периода.
--
-- Всё выполняется в ОДНОЙ транзакции, которая в конце откатывается:
-- бизнес живёт ровно столько, сколько нужно, чтобы выгрузить его ленту,
-- и локальная база остаётся чистой (pgTAP-наборы, ищущие события без
-- фильтра по организации, не видят чужих смен и возвратов). Выдача —
-- одна строка JSON: {location_id, from, to, issuers, documents} — те же
-- uf_export_issuers_for / uf_export_documents_for, что у Edge Function.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;
SELECT setseed(0.4242);

CREATE TEMP TABLE uf_sim_result (key TEXT PRIMARY KEY, value TEXT);
CREATE TEMP TABLE uf_sim_docs (n SERIAL PRIMARY KEY, doc JSONB);
CREATE TEMP TABLE uf_sim_orders (
  order_id UUID PRIMARY KEY,
  total INTEGER,
  method TEXT,
  discounted BOOLEAN
);

DO $$
DECLARE
  v_org     UUID := gen_random_uuid();
  v_loc     UUID := gen_random_uuid();
  v_staff   UUID := gen_random_uuid();
  v_session UUID := gen_random_uuid();
  v_coffee  UUID := gen_random_uuid();
  v_bakery  UUID := gen_random_uuid();
  v_item    UUID;
  v_today   DATE := (NOW() AT TIME ZONE 'Asia/Jerusalem')::date;
  v_day     DATE;
  v_count   INTEGER;
  v_minute  INTEGER;
  v_placed  TIMESTAMPTZ;
  v_items   JSONB;
  v_line    JSONB;
  v_pick    RECORD;
  v_discount JSONB;
  v_result  JSON;
  v_order   UUID;
  v_total   INTEGER;
  v_tip     INTEGER;
  v_method  TEXT;
  v_payments JSONB;
  v_cash    INTEGER;
  v_r       DOUBLE PRECISION;
  v_names   TEXT[] := ARRAY['נועה', 'יוסי', 'מיכל', 'דניאל', 'שירה', 'אבי', 'Маша', 'רון'];
  v_refund  RECORD;
  v_n       INTEGER := 0;
  v_snapshot JSONB;
  v_amount  INTEGER;
BEGIN
  -- ── Бизнес, точка, сотрудник, смена ─────────────────────────
  INSERT INTO orgs (id, name) VALUES (v_org, 'קפה לדוגמא');
  INSERT INTO organization_products (org_id, product) VALUES (v_org, 'pos');
  INSERT INTO locations (
    id, org_id, name, timezone, vat_rate,
    receipt_business_name, receipt_tax_id, receipt_address
  ) VALUES (
    v_loc, v_org, 'קפה לדוגמא', 'Asia/Jerusalem', 18,
    'קפה לדוגמא בע"מ', '514000009', 'רחוב הדוגמא 1, תל אביב'
  );
  INSERT INTO staff (id, org_id, location_id, name, role, pin_hash)
  VALUES (v_staff, v_org, v_loc, 'מנהלת', 'owner', 'simulator-unused');
  INSERT INTO staff_sessions (token, staff_id, org_id, location_id)
  VALUES (v_session, v_staff, v_org, v_loc);

  -- Устройство кассы этой точки (как JWT после bootstrap_org)
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', gen_random_uuid(), 'role', 'authenticated',
      'app_metadata', json_build_object('org_id', v_org, 'location_id', v_loc)
    )::text,
    false
  );
  PERFORM open_shift(v_staff, 50000);

  -- ── Меню: позиции с размерами и без ─────────────────────────
  INSERT INTO menu_categories (id, org_id, location_id, name, sort_order) VALUES
    (v_coffee, v_org, v_loc, 'קפה ומשקאות', 1),
    (v_bakery, v_org, v_loc, 'מאפים ואוכל', 2);

  CREATE TEMP TABLE uf_sim_menu (item_id UUID, variant_id UUID) ON COMMIT DROP;

  FOR v_pick IN
    SELECT * FROM (VALUES
      ('אספרסו',          v_coffee, 1000, ARRAY['יחיד', 'כפול'],   ARRAY[1000, 1400]),
      ('קפוצ׳ינו',        v_coffee, 1400, ARRAY['קטן', 'גדול'],    ARRAY[1400, 1700]),
      ('לאטה',            v_coffee, 1500, ARRAY['קטן', 'גדול'],    ARRAY[1500, 1800]),
      ('אמריקנו',         v_coffee, 1200, NULL,                    NULL),
      ('תה נענע',         v_coffee, 1100, NULL,                    NULL),
      ('שוקו חם',         v_coffee, 1300, ARRAY['קטן', 'גדול'],    ARRAY[1300, 1600]),
      ('מיץ תפוזים סחוט', v_coffee, 1600, NULL,                    NULL),
      ('קרואסון חמאה',    v_bakery, 1400, NULL,                    NULL),
      ('קרואסון שקדים',   v_bakery, 1800, NULL,                    NULL),
      ('עוגת גבינה',      v_bakery, 2200, NULL,                    NULL),
      ('בורקס גבינה',     v_bakery, 1500, NULL,                    NULL),
      ('כריך טונה',       v_bakery, 3200, NULL,                    NULL),
      ('סלט יווני',       v_bakery, 4200, NULL,                    NULL),
      ('Сырники',         v_bakery, 2800, NULL,                    NULL)
    ) AS m(name, category, price, variants, prices)
  LOOP
    v_item := gen_random_uuid();
    INSERT INTO menu_items (id, org_id, category_id, name, price)
    VALUES (v_item, v_org, v_pick.category, v_pick.name, v_pick.price);
    IF v_pick.variants IS NULL THEN
      INSERT INTO uf_sim_menu VALUES (v_item, NULL);
    ELSE
      FOR i IN 1..array_length(v_pick.variants, 1) LOOP
        INSERT INTO item_variants (org_id, item_id, name, price, is_default, sort_order)
        VALUES (v_org, v_item, v_pick.variants[i], v_pick.prices[i], i = 1, i);
      END LOOP;
      INSERT INTO uf_sim_menu
      SELECT v_item, id FROM item_variants WHERE item_id = v_item;
    END IF;
  END LOOP;

  -- ── Неделя продаж: ~95 чеков в день, 07:00–19:30 ────────────
  FOR d IN REVERSE 6..1 LOOP
    v_day := v_today - d;
    v_count := 92 + floor(random() * 8)::int;
    FOR i IN 1..v_count LOOP
      v_minute := 7 * 60 + ((i - 1) * 750) / v_count + floor(random() * 5)::int;
      v_placed := (v_day + make_interval(mins => v_minute)) AT TIME ZONE 'Asia/Jerusalem';

      -- 1–4 позиции, иногда по две штуки, изредка — свободная позиция
      v_items := '[]'::jsonb;
      FOR k IN 1..(1 + (random() < 0.45)::int + (random() < 0.2)::int + (random() < 0.08)::int) LOOP
        IF random() < 0.02 THEN
          v_line := jsonb_build_object('custom_name', 'פריט חופשי', 'unit_price_override', 2500, 'qty', 1);
        ELSE
          SELECT * INTO v_pick FROM uf_sim_menu ORDER BY random() LIMIT 1;
          v_line := jsonb_build_object(
            'menu_item_id', v_pick.item_id,
            'qty', CASE WHEN random() < 0.15 THEN 2 ELSE 1 END
          );
          IF v_pick.variant_id IS NOT NULL THEN
            v_line := v_line || jsonb_build_object('variant_id', v_pick.variant_id);
          END IF;
        END IF;
        v_items := v_items || jsonb_build_array(v_line);
      END LOOP;

      v_r := random();
      v_discount := CASE
        WHEN v_r < 0.07 THEN '{"type": "percent", "value": 10, "reason": "הנחת עובד"}'::jsonb
        WHEN v_r < 0.09 THEN '{"type": "fixed", "value": 500, "reason": "פיצוי ללקוח"}'::jsonb
        ELSE NULL
      END;

      v_result := place_order(
        gen_random_uuid(), v_staff,
        CASE WHEN random() < 0.6 THEN 'here' ELSE 'takeaway' END,
        CASE WHEN random() < 0.3 THEN v_names[1 + floor(random() * 8)::int] END,
        v_items, v_discount, NULL, v_placed, v_session
      );
      v_order := (v_result ->> 'order_id')::uuid;
      v_total := (v_result ->> 'total')::int;

      -- Способ оплаты; чаевые — только к карте, ~20% карточных чеков
      v_r := random();
      v_tip := 0;
      v_method := CASE
        WHEN v_r < 0.30 THEN 'cash'
        WHEN v_r < 0.83 THEN 'card'
        WHEN v_r < 0.89 THEN 'bit'
        WHEN v_r < 0.94 THEN 'cibus'
        WHEN v_r < 0.97 THEN 'tenbis'
        ELSE 'split'
      END;
      IF v_method = 'card' AND random() < 0.2 THEN
        v_tip := GREATEST(100, round(v_total * 0.1 / 100.0)::int * 100);
      END IF;
      IF v_method = 'split' THEN
        v_cash := (v_total / 2 / 100) * 100;
        v_payments := jsonb_build_array(
          jsonb_build_object('method', 'cash', 'amount', v_cash),
          jsonb_build_object('method', 'card', 'amount', v_total - v_cash)
        );
      ELSE
        v_payments := jsonb_build_array(jsonb_build_object('method', v_method, 'amount', v_total + v_tip));
      END IF;

      PERFORM pay_order(v_order, v_payments, v_tip, gen_random_uuid(), v_placed + INTERVAL '1 minute', v_session);

      -- Чек на компанию (B2B, 048) — ~3%
      IF random() < 0.03 THEN
        PERFORM set_order_buyer(
          v_order,
          CASE WHEN random() < 0.5 THEN 'משרד לדוגמא בע"מ' ELSE 'סטודיו לדוגמא' END,
          CASE WHEN random() < 0.5 THEN '515151512' ELSE '513000000' END,
          v_session
        );
      END IF;

      INSERT INTO uf_sim_orders VALUES (v_order, v_total, v_method, v_discount IS NOT NULL);
    END LOOP;
  END LOOP;

  -- ── Возвраты (330): 14 штук, три вида ───────────────────────
  FOR v_refund IN
    SELECT * FROM uf_sim_orders
    WHERE method IN ('cash', 'card', 'bit') AND NOT discounted
    ORDER BY random() LIMIT 14
  LOOP
    v_n := v_n + 1;
    IF v_n <= 5 THEN
      -- полный возврат по позициям
      SELECT jsonb_agg(jsonb_build_object(
        'name', CASE WHEN variant_name IS NULL THEN name ELSE name || ' ' || variant_name END,
        'qty', qty, 'amount', line_total) ORDER BY id)
      INTO v_snapshot FROM order_items WHERE order_id = v_refund.order_id;
      v_amount := v_refund.total;
    ELSIF v_n <= 11 THEN
      -- частичный: одна позиция чека
      SELECT jsonb_build_array(jsonb_build_object(
        'name', CASE WHEN variant_name IS NULL THEN name ELSE name || ' ' || variant_name END,
        'qty', qty, 'amount', line_total)), line_total
      INTO v_snapshot, v_amount
      FROM order_items WHERE order_id = v_refund.order_id ORDER BY id LIMIT 1;
    ELSE
      -- возврат суммой, без позиций
      v_snapshot := NULL;
      v_amount := LEAST(v_refund.total, 1000);
    END IF;

    PERFORM issue_refund(
      gen_random_uuid(), v_refund.order_id, v_staff, v_amount, v_refund.method,
      (ARRAY['טעות בהזמנה', 'לקוח לא מרוצה', 'מוצר חסר'])[1 + (v_n % 3)],
      v_snapshot, v_session
    );
  END LOOP;

  INSERT INTO uf_sim_result VALUES
    ('location_id', v_loc::text),
    ('from', (v_today - 6)::text),
    ('to', v_today::text);
END $$;

-- ── Лента документов — постранично, как у Edge Function ─────
DO $$
DECLARE
  v_loc  UUID := (SELECT value FROM uf_sim_result WHERE key = 'location_id')::uuid;
  v_from DATE := (SELECT value FROM uf_sim_result WHERE key = 'from')::date;
  v_to   DATE := (SELECT value FROM uf_sim_result WHERE key = 'to')::date;
  v_page JSONB;
  v_after_ts TIMESTAMPTZ;
  v_after_id UUID;
BEGIN
  LOOP
    v_page := uf_export_documents_for(v_loc, v_from, v_to, v_after_ts, v_after_id, 500) -> 'documents';
    INSERT INTO uf_sim_docs (doc) SELECT d FROM jsonb_array_elements(v_page) WITH ORDINALITY AS t(d, i) ORDER BY i;
    EXIT WHEN jsonb_array_length(v_page) < 500;
    v_after_ts := (v_page -> -1 ->> 'ts')::timestamptz;
    v_after_id := (v_page -> -1 ->> 'id')::uuid;
  END LOOP;
END $$;

SELECT json_build_object(
  'location_id', (SELECT value FROM uf_sim_result WHERE key = 'location_id'),
  'from', (SELECT value FROM uf_sim_result WHERE key = 'from'),
  'to', (SELECT value FROM uf_sim_result WHERE key = 'to'),
  'issuers', uf_export_issuers_for(
    (SELECT value FROM uf_sim_result WHERE key = 'location_id')::uuid,
    (SELECT value FROM uf_sim_result WHERE key = 'from')::date,
    (SELECT value FROM uf_sim_result WHERE key = 'to')::date
  ),
  'documents', (SELECT jsonb_agg(doc ORDER BY n) FROM uf_sim_docs)
);

ROLLBACK;
