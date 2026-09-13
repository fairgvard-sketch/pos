-- Run only after restoring into an isolated test database. Reports counts, never row values.
-- No persistent changes: temporary checks are rolled back. psql -v ON_ERROR_STOP=1 is required.
BEGIN;
SET timezone='UTC';
CREATE TEMP TABLE restore_health AS SELECT jsonb_build_object(
  'schema',public.get_schema_version(),
  'checkout_mode',(SELECT mode FROM public.billing_checkout_settings),
  'issued_order_payment_mismatches',(SELECT count(*) FROM (
    SELECT o.id FROM public.orders o LEFT JOIN public.payments p
      ON p.order_id=o.id AND p.refund_id IS NULL
    WHERE o.receipt_number IS NOT NULL OR o.status IN ('paid','fulfilled','refunded')
    GROUP BY o.id HAVING o.total+coalesce(o.tip_amount,0) <> coalesce(sum(p.amount),0)
  ) x),
  'refund_payment_mismatches',(SELECT count(*) FROM (
    SELECT r.id FROM public.refunds r LEFT JOIN public.payments p ON p.refund_id=r.id
    GROUP BY r.id HAVING r.amount <> -coalesce(sum(p.amount),0)
  ) x),
  'receipt_counter_mismatches',(SELECT count(*) FROM public.receipt_counters c FULL JOIN (
    SELECT location_id,max(receipt_number) AS last_no FROM public.orders
    WHERE receipt_number IS NOT NULL GROUP BY location_id
  ) d USING(location_id) WHERE coalesce(c.counter,0)<>coalesce(d.last_no,0)),
  'refund_counter_mismatches',(SELECT count(*) FROM public.refund_counters c FULL JOIN (
    SELECT location_id,max(refund_number) AS last_no FROM public.refunds
    WHERE refund_number IS NOT NULL GROUP BY location_id
  ) d USING(location_id) WHERE coalesce(c.counter,0)<>coalesce(d.last_no,0)),
  'receipt_number_gaps',(SELECT count(*) FROM (
    SELECT location_id FROM public.orders WHERE receipt_number IS NOT NULL GROUP BY location_id
    HAVING min(receipt_number)<>1 OR max(receipt_number)<>count(DISTINCT receipt_number)
  ) d),
  'refund_number_gaps',(SELECT count(*) FROM (
    SELECT location_id FROM public.refunds WHERE refund_number IS NOT NULL GROUP BY location_id
    HAVING min(refund_number)<>1 OR max(refund_number)<>count(DISTINCT refund_number)
  ) d),
  'closed_shift_cash_diff_mismatches',(SELECT count(*) FROM public.shifts
    WHERE status='closed' AND cash_diff IS DISTINCT FROM counted_cash-expected_cash),
  'stock_movements',(SELECT count(*) FROM public.stock_movements),
  'triggers_mode',current_setting('session_replication_role')
) AS result;
SELECT result FROM restore_health;

CREATE TEMP TABLE restore_fk_results(name text, child text, checked bigint, broken bigint, cross_org bigint);
DO $$
DECLARE r record; v_join text; v_present text; v_broken bigint; v_count bigint; v_cross bigint;
BEGIN
  FOR r IN
    SELECT c.*, c.conrelid::regclass AS child, c.confrelid::regclass AS parent
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE c.contype='f' AND n.nspname IN ('auth','public')
  LOOP
    SELECT string_agg(format('p.%I=c.%I',p.attname,a.attname),' AND ' ORDER BY k.i),
      CASE WHEN r.confmatchtype='f' THEN 'NOT (' || string_agg(format('c.%I IS NULL',a.attname),' AND ' ORDER BY k.i) || ')'
      ELSE string_agg(format('c.%I IS NOT NULL',a.attname),' AND ' ORDER BY k.i) END
    INTO v_join,v_present FROM generate_subscripts(r.conkey,1) k(i)
    JOIN pg_attribute a ON a.attrelid=r.conrelid AND a.attnum=r.conkey[k.i]
    JOIN pg_attribute p ON p.attrelid=r.confrelid AND p.attnum=r.confkey[k.i];
    EXECUTE format('SELECT count(*) FROM %s c WHERE %s',r.child,v_present) INTO v_count;
    EXECUTE format('SELECT count(*) FROM %s c WHERE %s AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s)',r.child,v_present,r.parent,v_join) INTO v_broken;
    v_cross:=0;
    IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=r.conrelid AND attname='org_id' AND NOT attisdropped)
      AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=r.confrelid AND attname='org_id' AND NOT attisdropped) THEN
      EXECUTE format('SELECT count(*) FROM %s c JOIN %s p ON %s WHERE c.org_id IS DISTINCT FROM p.org_id',r.child,r.parent,v_join) INTO v_cross;
    END IF;
    INSERT INTO restore_fk_results VALUES(r.conname,r.child::text,v_count,v_broken,v_cross);
  END LOOP;
END $$;
SELECT jsonb_build_object('foreign_keys',count(*),'checked_references',sum(checked),
  'broken_references',sum(broken),'cross_org_references',sum(cross_org),
  'failing_constraints',coalesce(jsonb_agg(jsonb_build_object('name',name,'table',child,'broken',broken,'cross_org',cross_org)) FILTER(WHERE broken>0 OR cross_org>0),'[]'))
FROM restore_fk_results;

DO $$
DECLARE r record;
BEGIN
  IF current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'restore_integrity_failed: triggers must be enabled' USING ERRCODE='23514';
  END IF;
  FOR r IN SELECT key,value FROM restore_health h, jsonb_each(h.result) LOOP
    IF (r.key LIKE '%mismatches' OR r.key LIKE '%gaps') AND r.value::text <> '0' THEN
      RAISE EXCEPTION 'restore_integrity_failed: %', r.key USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM restore_fk_results WHERE broken>0 OR cross_org>0) THEN
    RAISE EXCEPTION 'restore_integrity_failed: foreign keys or tenant references' USING ERRCODE='23514';
  END IF;
END $$;
ROLLBACK;
