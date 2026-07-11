-- ============================================================
-- 044 STAFF SESSIONS — серверная проверка прав сотрудника.
--
-- Было: БД доверяет устройству (JWT), роль сотрудника enforced на
-- клиенте (lib/perms.ts). Злонамеренный клиент с anon-ключом мог
-- звать привилегированные RPC (возврат, void, закрытие смены...)
-- с чужим p_staff_id — сервер проверял только «staff существует».
--
-- Теперь: verify_staff_pin выдаёт токен сессии (staff_sessions),
-- привилегированные RPC принимают p_staff_session и проверяют право
-- В БД через require_staff_perm() — зеркало клиентского lib/perms.ts
-- (те же ключи и дефолты). Авторизация — по роли сессии; авторство
-- записи — по-прежнему p_staff_id (офлайн-replay может доехать под
-- другим залогиненным сотрудником — это атрибуция, не эскалация).
--
-- ДВУХФАЗНАЯ РАСКАТКА (грабли: задеплоенные клиенты и хвост
-- офлайн-очереди зовут RPC без токена):
--   044 (эта) — МЯГКИЙ режим: p_staff_session IS NULL → пропуск.
--   045 — СТРОГИЙ: NULL → ошибка + revoke прямых UPDATE locations/staff.
--   045 применять ТОЛЬКО когда все кассы обновились и очередь пуста.
--
-- Сигнатуры меняются через DROP + CREATE (не CREATE OR REPLACE):
-- добавление параметра создаёт overload, а два overload ломают
-- разрешение имён в PostgREST (грабли 033/042).
-- ============================================================

-- ── Сессии сотрудников ───────────────────────────────────────
CREATE TABLE staff_sessions (
  token       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Продлевается при использовании (require_staff_perm): вечно открытая
  -- касса с активной работой не протухает, брошенная сессия — умирает.
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '72 hours',
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX idx_staff_sessions_staff ON staff_sessions(staff_id);

-- Токен — секрет: доступ только из SECURITY DEFINER функций.
ALTER TABLE staff_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON staff_sessions FROM anon, authenticated, public;

-- ── Проверка права по сессии (зеркало src/lib/perms.ts) ─────
-- Возвращает staff_id сессии; NULL в мягком режиме без токена.
-- Ключи прав: discount / price_edit / refund / void_order /
-- close_shift / cash_movement (locations.settings.perms) +
-- служебный 'manage' (сотрудники, настройки точки) — всегда manager+.
CREATE OR REPLACE FUNCTION require_staff_perm(p_session UUID, p_perm TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_staff staff%ROWTYPE;
  v_level TEXT;
BEGIN
  -- МЯГКИЙ режим (044): без токена пропускаем — дорабатывают старые
  -- клиенты и хвост офлайн-очереди. 045 заменяет ветку на RAISE.
  IF p_session IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT s.* INTO v_staff
  FROM staff_sessions ss
  JOIN staff s ON s.id = ss.staff_id
  WHERE ss.token = p_session
    AND ss.org_id = auth_org_id()
    AND ss.revoked_at IS NULL
    AND ss.expires_at > NOW()
    AND s.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff session invalid';
  END IF;

  -- Скользящее продление: активная сессия не протухает посреди смены
  UPDATE staff_sessions
  SET expires_at = GREATEST(expires_at, NOW() + INTERVAL '72 hours')
  WHERE token = p_session;

  v_level := COALESCE(
    (SELECT l.settings #>> ARRAY['perms', p_perm] FROM locations l WHERE l.id = auth_location_id()),
    CASE p_perm WHEN 'refund' THEN 'manager' WHEN 'manage' THEN 'manager' ELSE 'all' END
  );

  IF v_level = 'manager' AND v_staff.role NOT IN ('manager', 'owner') THEN
    RAISE EXCEPTION 'forbidden: %', p_perm;
  END IF;

  RETURN v_staff.id;
END $$;

REVOKE EXECUTE ON FUNCTION require_staff_perm FROM anon, public;

-- ── verify_staff_pin: + выдача токена сессии ────────────────
-- Возвращаемые колонки расширяются → DROP + CREATE (тип менять нельзя).
-- Старые клиенты лишнюю колонку игнорируют.
DROP FUNCTION IF EXISTS verify_staff_pin(TEXT);

CREATE FUNCTION verify_staff_pin(p_pin TEXT)
RETURNS TABLE (id UUID, name TEXT, role TEXT, location_id UUID, session_token UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_staff staff%ROWTYPE;
  v_token UUID;
BEGIN
  SELECT s.* INTO v_staff
  FROM staff s
  WHERE s.org_id = auth_org_id()
    AND s.is_active
    AND (s.location_id IS NULL OR s.location_id = auth_location_id())
    AND s.pin_hash = crypt(p_pin, s.pin_hash)
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Гигиена: сессии не финансовые записи, протухшие удаляем
  DELETE FROM staff_sessions
  WHERE org_id = auth_org_id() AND expires_at < NOW() - INTERVAL '7 days';

  INSERT INTO staff_sessions (staff_id, org_id, location_id)
  VALUES (v_staff.id, v_staff.org_id, auth_location_id())
  RETURNING token INTO v_token;

  RETURN QUERY SELECT v_staff.id, v_staff.name, v_staff.role, v_staff.location_id, v_token;
END $$;

REVOKE EXECUTE ON FUNCTION verify_staff_pin FROM anon, public;

-- ============================================================
-- Привилегированные RPC: + p_staff_session (DEFAULT NULL) и
-- require_staff_perm в начале. Тела — копии актуальных версий
-- (029/030, 042, 034, 039, 038, 002, 040), меняется только проверка.
-- ============================================================

-- ── issue_refund (030 + сессия, право 'refund') ─────────────
DROP FUNCTION IF EXISTS issue_refund(UUID, UUID, UUID, INTEGER, TEXT, TEXT, JSONB);

CREATE FUNCTION issue_refund(
  p_refund_id UUID,
  p_order_id  UUID,
  p_staff_id  UUID,
  p_amount    INTEGER,
  p_method    TEXT,
  p_reason    TEXT  DEFAULT NULL,
  p_items     JSONB DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org             UUID := auth_org_id();
  v_loc             UUID := auth_location_id();
  v_order           orders%ROWTYPE;
  v_shift           UUID;
  v_paid            INTEGER;
  v_refunded        INTEGER;
  v_paid_method     INTEGER;
  v_refunded_method INTEGER;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'refund');
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;
  IF p_method NOT IN ('cash', 'card') THEN
    RAISE EXCEPTION 'invalid refund method';
  END IF;

  -- Идемпотентность: этот возврат уже проведён
  IF EXISTS (SELECT 1 FROM refunds WHERE id = p_refund_id) THEN
    RETURN json_build_object('refund_id', p_refund_id, 'duplicate', TRUE);
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_order.status NOT IN ('paid', 'fulfilled', 'refunded') THEN
    RAISE EXCEPTION 'order not refundable';
  END IF;

  SELECT
    COALESCE(SUM(amount)  FILTER (WHERE amount > 0), 0),
    COALESCE(-SUM(amount) FILTER (WHERE amount < 0), 0),
    COALESCE(SUM(amount)  FILTER (WHERE amount > 0 AND method = p_method), 0),
    COALESCE(-SUM(amount) FILTER (WHERE amount < 0 AND method = p_method), 0)
  INTO v_paid, v_refunded, v_paid_method, v_refunded_method
  FROM payments WHERE order_id = p_order_id;

  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > v_paid - v_refunded THEN
    RAISE EXCEPTION 'invalid refund amount';
  END IF;

  -- Возврат тем же способом: не больше, чем оплачено этим способом
  IF p_amount > v_paid_method - v_refunded_method THEN
    RAISE EXCEPTION 'refund exceeds amount paid by %', p_method;
  END IF;

  -- Деньги выдаются сейчас → возврат в текущую открытую смену
  SELECT id INTO v_shift FROM shifts WHERE location_id = v_loc AND status = 'open';
  IF v_shift IS NULL THEN
    RAISE EXCEPTION 'no open shift';
  END IF;

  INSERT INTO refunds (id, org_id, order_id, shift_id, staff_id, amount, method, reason, items)
  VALUES (p_refund_id, v_org, p_order_id, v_shift, p_staff_id, p_amount, p_method,
          NULLIF(TRIM(p_reason), ''), p_items);

  INSERT INTO payments (org_id, order_id, shift_id, method, amount, refund_id)
  VALUES (v_org, p_order_id, v_shift, p_method, -p_amount, p_refund_id);

  -- Возвращено всё → заказ считается возвращённым целиком
  IF v_refunded + p_amount >= v_paid THEN
    UPDATE orders SET
      status        = 'refunded',
      refunded_at   = NOW(),
      refunded_by   = p_staff_id,
      refund_reason = NULLIF(TRIM(p_reason), '')
    WHERE id = p_order_id;
  END IF;

  RETURN json_build_object(
    'refund_id', p_refund_id,
    'refunded',  p_amount,
    'remaining', v_paid - v_refunded - p_amount
  );
END $$;

REVOKE EXECUTE ON FUNCTION issue_refund FROM anon, public;

-- ── void_order_item (042 + сессия, право 'void_order') ──────
DROP FUNCTION IF EXISTS void_order_item(UUID, UUID, TEXT);

CREATE FUNCTION void_order_item(
  p_item_id  UUID,
  p_staff_id UUID,
  p_reason   TEXT DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_item      order_items%ROWTYPE;
  v_order     orders%ROWTYPE;
  v_subtotal  INTEGER;
  v_disc      INTEGER;
  v_total     INTEGER;
  v_vat       INTEGER;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'void_order');
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT * INTO v_item FROM order_items
  WHERE id = p_item_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'item not found';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = v_item.order_id AND org_id = v_org FOR UPDATE;

  -- Replay: строка уже отменена → итоги уже пересчитаны, вернуть их
  IF v_item.voided_at IS NOT NULL THEN
    RETURN json_build_object('order_id', v_order.id, 'total', v_order.total, 'subtotal', v_order.subtotal);
  END IF;

  IF v_order.status <> 'open' THEN
    RAISE EXCEPTION 'order not open';
  END IF;

  UPDATE order_items
  SET voided_at = NOW(), voided_by = p_staff_id, void_reason = NULLIF(TRIM(p_reason), '')
  WHERE id = p_item_id;

  SELECT COALESCE(SUM(line_total), 0) INTO v_subtotal
  FROM order_items WHERE order_id = v_order.id AND voided_at IS NULL;

  v_disc := 0;
  IF v_order.discount_type = 'percent' THEN
    v_disc := ROUND(v_subtotal * v_order.discount_value / 100.0);
  ELSIF v_order.discount_type = 'fixed' THEN
    v_disc := v_order.discount_value;
  END IF;
  IF v_disc > v_subtotal THEN
    v_disc := v_subtotal;
  END IF;

  v_total := round_order_total(v_subtotal - v_disc, v_subtotal, v_disc > 0);
  IF v_disc > 0 THEN v_disc := v_subtotal - v_total; END IF;
  v_vat := ROUND(v_total * v_order.vat_rate / (100 + v_order.vat_rate));

  UPDATE orders
  SET subtotal = v_subtotal, discount_amount = v_disc, total = v_total, vat_amount = v_vat
  WHERE id = v_order.id;

  RETURN json_build_object('order_id', v_order.id, 'total', v_total, 'subtotal', v_subtotal);
END $$;

REVOKE EXECUTE ON FUNCTION void_order_item FROM anon, public;

-- ── void_table_order (042 + сессия, право 'void_order') ─────
DROP FUNCTION IF EXISTS void_table_order(UUID, TEXT);

CREATE FUNCTION void_table_order(
  p_order_id UUID,
  p_reason   TEXT DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_order orders%ROWTYPE;
BEGIN
  PERFORM require_staff_perm(p_staff_session, 'void_order');

  SELECT * INTO v_order FROM orders
  WHERE id = p_order_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_order.status = 'voided' THEN
    RETURN;  -- идемпотентно: уже отменён
  END IF;
  IF v_order.status <> 'open' THEN
    RAISE EXCEPTION 'order already paid';
  END IF;

  UPDATE orders
  SET status = 'voided', voided_at = NOW(), void_reason = NULLIF(TRIM(p_reason), '')
  WHERE id = p_order_id;
END $$;

REVOKE EXECUTE ON FUNCTION void_table_order FROM anon, public;

-- ── set_order_discount (034 + сессия, право 'discount') ─────
DROP FUNCTION IF EXISTS set_order_discount(UUID, TEXT, INTEGER, TEXT);

CREATE FUNCTION set_order_discount(
  p_order_id UUID,
  p_type     TEXT,
  p_value    INTEGER DEFAULT NULL,
  p_reason   TEXT    DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_order    orders%ROWTYPE;
  v_subtotal INTEGER;
  v_disc     INTEGER;
  v_total    INTEGER;
  v_vat      INTEGER;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'discount');
  IF p_type IS NOT NULL AND p_type NOT IN ('percent', 'fixed') THEN
    RAISE EXCEPTION 'invalid discount type';
  END IF;
  IF p_type IS NOT NULL AND (p_value IS NULL OR p_value < 0) THEN
    RAISE EXCEPTION 'invalid discount value';
  END IF;
  IF p_type = 'percent' AND p_value > 100 THEN
    RAISE EXCEPTION 'invalid discount percent';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_order.status <> 'open' THEN
    RAISE EXCEPTION 'order not open';
  END IF;

  SELECT COALESCE(SUM(line_total), 0) INTO v_subtotal
  FROM order_items WHERE order_id = p_order_id AND voided_at IS NULL;

  v_disc := 0;
  IF p_type = 'percent' THEN
    v_disc := ROUND(v_subtotal * p_value / 100.0);
  ELSIF p_type = 'fixed' THEN
    v_disc := p_value;
  END IF;
  IF v_disc > v_subtotal THEN v_disc := v_subtotal; END IF;

  v_total := round_order_total(v_subtotal - v_disc, v_subtotal, v_disc > 0);
  IF v_disc > 0 THEN v_disc := v_subtotal - v_total; END IF;
  v_vat := ROUND(v_total * v_order.vat_rate / (100 + v_order.vat_rate));

  UPDATE orders SET
    discount_type   = p_type,
    discount_value  = CASE WHEN p_type IS NULL THEN NULL ELSE p_value END,
    discount_reason = CASE WHEN p_type IS NULL THEN NULL ELSE NULLIF(TRIM(p_reason), '') END,
    subtotal = v_subtotal, discount_amount = v_disc,
    total = v_total, vat_amount = v_vat
  WHERE id = p_order_id;

  RETURN json_build_object('total', v_total, 'discount_amount', v_disc, 'subtotal', v_subtotal);
END $$;

REVOKE EXECUTE ON FUNCTION set_order_discount FROM anon, public;

COMMENT ON FUNCTION set_order_discount(UUID, TEXT, INTEGER, TEXT, UUID) IS
  'Идемпотентна для offline-replay: абсолютная установка скидки (042)';

-- ── close_shift (039 + сессия, право 'close_shift') ─────────
DROP FUNCTION IF EXISTS close_shift(UUID, UUID, INTEGER, TEXT);

CREATE FUNCTION close_shift(
  p_shift_id      UUID,
  p_staff_id      UUID,
  p_counted_cash  INTEGER,
  p_note          TEXT DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org         UUID := auth_org_id();
  v_shift       shifts%ROWTYPE;
  v_cash        INTEGER;
  v_card        INTEGER;
  v_gross_cash  INTEGER;
  v_gross_card  INTEGER;
  v_refunds     INTEGER;
  v_vat         INTEGER;
  v_orders      INTEGER;
  v_tips        INTEGER;
  v_in          INTEGER;
  v_out         INTEGER;
  v_expected    INTEGER;
  v_open_tables INTEGER;
  v_abandoned   INTEGER;
  v_z           INTEGER;
  v_closed_at   TIMESTAMPTZ := NOW();
BEGIN
  PERFORM require_staff_perm(p_staff_session, 'close_shift');

  SELECT * INTO v_shift FROM shifts WHERE id = p_shift_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift not found';
  END IF;
  IF v_shift.status <> 'open' THEN
    RAISE EXCEPTION 'shift already closed';
  END IF;

  -- Guard: блокируют только НАСТОЯЩИЕ счета столов — open, стол
  -- существует И есть хотя бы одна активная (не voided) позиция.
  SELECT COUNT(*) INTO v_open_tables
  FROM orders o
  WHERE o.location_id = v_shift.location_id
    AND o.status = 'open'
    AND o.table_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM tables t WHERE t.id = o.table_id)
    AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.voided_at IS NULL);
  IF v_open_tables > 0 THEN
    RAISE EXCEPTION 'shift has open orders: %', v_open_tables;
  END IF;

  -- Авто-аннулируем мусор: брошенные counter-заказы (035) + пустые и
  -- осиротевшие столовые заказы (039). «Пустой» = нет активных позиций;
  -- «осиротевший» = стол не существует.
  UPDATE orders o
  SET status = 'voided', voided_at = NOW(),
      void_reason = COALESCE(void_reason, 'abandoned at shift close')
  WHERE o.location_id = v_shift.location_id
    AND o.status = 'open'
    AND (
      o.table_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM tables t WHERE t.id = o.table_id)
      OR NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.voided_at IS NULL)
    );
  GET DIAGNOSTICS v_abandoned = ROW_COUNT;

  -- Нетто + брутто/возвраты одним проходом по payments смены
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE method = 'cash'), 0),
    COALESCE(SUM(amount) FILTER (WHERE method = 'card'), 0),
    COALESCE(SUM(amount) FILTER (WHERE method = 'cash' AND amount > 0), 0),
    COALESCE(SUM(amount) FILTER (WHERE method = 'card' AND amount > 0), 0),
    COALESCE(-SUM(amount) FILTER (WHERE amount < 0), 0),
    COUNT(DISTINCT order_id) FILTER (WHERE amount > 0)
  INTO v_cash, v_card, v_gross_cash, v_gross_card, v_refunds, v_orders
  FROM payments WHERE shift_id = p_shift_id;

  SELECT COALESCE(SUM(tip_amount), 0) INTO v_tips
  FROM orders WHERE shift_id = p_shift_id AND status <> 'voided';

  SELECT COALESCE(SUM(vat_amount), 0) INTO v_vat
  FROM orders WHERE shift_id = p_shift_id AND status <> 'voided';

  SELECT
    COALESCE(SUM(amount) FILTER (WHERE type = 'in'), 0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'out'), 0)
  INTO v_in, v_out
  FROM cash_movements WHERE shift_id = p_shift_id;

  v_expected := v_shift.opening_float + v_cash + v_in - v_out;

  INSERT INTO z_counters (location_id, counter)
  VALUES (v_shift.location_id, 1)
  ON CONFLICT (location_id) DO UPDATE SET counter = z_counters.counter + 1
  RETURNING counter INTO v_z;

  UPDATE shifts SET
    status        = 'closed',
    closed_by     = p_staff_id,
    counted_cash  = p_counted_cash,
    expected_cash = v_expected,
    cash_diff     = p_counted_cash - v_expected,
    total_sales   = v_cash + v_card,
    orders_count  = v_orders,
    closed_at     = v_closed_at,
    close_note    = NULLIF(TRIM(p_note), ''),
    z_number      = v_z
  WHERE id = p_shift_id;

  RETURN json_build_object(
    'cash_sales',       v_cash,
    'card_sales',       v_card,
    'total_sales',      v_cash + v_card,
    'gross_cash',       v_gross_cash,
    'gross_card',       v_gross_card,
    'gross_total',      v_gross_cash + v_gross_card,
    'refunds_total',    v_refunds,
    'vat_total',        v_vat,
    'tips_total',       v_tips,
    'cash_in',          v_in,
    'cash_out',         v_out,
    'expected_cash',    v_expected,
    'counted_cash',     p_counted_cash,
    'cash_diff',        p_counted_cash - v_expected,
    'orders_count',     v_orders,
    'abandoned_voided', v_abandoned,
    'z_number',         v_z,
    'opened_at',        v_shift.opened_at,
    'closed_at',        v_closed_at,
    'opening_float',    v_shift.opening_float
  );
END $$;

REVOKE EXECUTE ON FUNCTION close_shift FROM anon, public;

-- ── add_cash_movement (038 + сессия, право 'cash_movement') ─
DROP FUNCTION IF EXISTS add_cash_movement(UUID, UUID, TEXT, INTEGER, TEXT);

CREATE FUNCTION add_cash_movement(
  p_shift_id UUID,
  p_staff_id UUID,
  p_type     TEXT,
  p_amount   INTEGER,
  p_reason   TEXT DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_shift shifts%ROWTYPE;
  v_id    UUID;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'cash_movement');
  IF p_type NOT IN ('in', 'out') THEN
    RAISE EXCEPTION 'invalid type';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'invalid amount';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT * INTO v_shift FROM shifts WHERE id = p_shift_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift not found';
  END IF;
  IF v_shift.status <> 'open' THEN
    RAISE EXCEPTION 'shift not open';
  END IF;

  INSERT INTO cash_movements (org_id, location_id, shift_id, staff_id, type, amount, reason)
  VALUES (v_org, v_shift.location_id, p_shift_id, p_staff_id, p_type, p_amount, NULLIF(TRIM(p_reason), ''))
  RETURNING id INTO v_id;

  RETURN json_build_object('id', v_id);
END $$;

REVOKE EXECUTE ON FUNCTION add_cash_movement FROM anon, public;

-- ── create_staff (002 + сессия, 'manage') ───────────────────
DROP FUNCTION IF EXISTS create_staff(TEXT, TEXT, TEXT, UUID);

CREATE FUNCTION create_staff(
  p_name        TEXT,
  p_role        TEXT,
  p_pin         TEXT,
  p_location_id UUID DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_id  UUID;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'manage');
  IF p_role NOT IN ('owner', 'manager', 'barista') THEN
    RAISE EXCEPTION 'invalid role';
  END IF;
  IF p_pin !~ '^\d{4,8}$' THEN
    RAISE EXCEPTION 'PIN must be 4-8 digits';
  END IF;

  INSERT INTO staff (org_id, location_id, name, role, pin_hash)
  VALUES (v_org, p_location_id, p_name, p_role, crypt(p_pin, gen_salt('bf')))
  RETURNING staff.id INTO v_id;

  RETURN v_id;
END $$;

REVOKE EXECUTE ON FUNCTION create_staff FROM anon, public;

-- ── set_staff_pin (002 + сессия, 'manage') ──────────────────
DROP FUNCTION IF EXISTS set_staff_pin(UUID, TEXT);

CREATE FUNCTION set_staff_pin(
  p_staff_id UUID,
  p_pin      TEXT,
  p_staff_session UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  PERFORM require_staff_perm(p_staff_session, 'manage');
  IF p_pin !~ '^\d{4,8}$' THEN
    RAISE EXCEPTION 'PIN must be 4-8 digits';
  END IF;

  UPDATE staff
  SET pin_hash = crypt(p_pin, gen_salt('bf'))
  WHERE id = p_staff_id AND org_id = auth_org_id();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff not found';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION set_staff_pin FROM anon, public;

-- ── delete_staff (040 + сессия, 'manage') ───────────────────
DROP FUNCTION IF EXISTS delete_staff(UUID);

CREATE FUNCTION delete_staff(
  p_staff_id UUID,
  p_staff_session UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'manage');

  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org) THEN
    RAISE EXCEPTION 'staff not found';
  END IF;

  -- Любая ссылка на сотрудника из аудируемых таблиц блокирует удаление.
  -- (Авторство платежа — через orders, отдельной payments.staff_id нет.)
  IF EXISTS (SELECT 1 FROM orders         WHERE staff_id    = p_staff_id)
     OR EXISTS (SELECT 1 FROM orders       WHERE voided_by   = p_staff_id)
     OR EXISTS (SELECT 1 FROM orders       WHERE refunded_by = p_staff_id)
     OR EXISTS (SELECT 1 FROM refunds      WHERE staff_id    = p_staff_id)
     OR EXISTS (SELECT 1 FROM shifts       WHERE opened_by   = p_staff_id)
     OR EXISTS (SELECT 1 FROM shifts       WHERE closed_by   = p_staff_id)
     OR EXISTS (SELECT 1 FROM time_entries WHERE staff_id    = p_staff_id)
     OR EXISTS (SELECT 1 FROM cash_movements WHERE staff_id  = p_staff_id)
  THEN
    RAISE EXCEPTION 'staff has records';
  END IF;

  DELETE FROM staff WHERE id = p_staff_id AND org_id = v_org;
END $$;

REVOKE EXECUTE ON FUNCTION delete_staff FROM anon, public;

-- ============================================================
-- Новые RPC на замену прямым UPDATE locations/staff (их гранты
-- отзывает 045). Клиентские updateServiceMode/updateReceiptDetails/
-- updateVatRate/updateLocationSettings/updateLoyaltySettings/
-- updateStaffMember переходят сюда.
-- ============================================================

-- ── update_location_config: аллow-лист правимых полей точки ──
CREATE OR REPLACE FUNCTION update_location_config(
  p_patch JSONB,
  p_staff_session UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc UUID := auth_location_id();
BEGIN
  IF v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'manage');

  IF p_patch ? 'service_mode' AND (p_patch ->> 'service_mode') NOT IN ('counter', 'counter_tables', 'tables') THEN
    RAISE EXCEPTION 'invalid service_mode';
  END IF;
  IF p_patch ? 'vat_rate' AND ((p_patch ->> 'vat_rate')::NUMERIC < 0 OR (p_patch ->> 'vat_rate')::NUMERIC > 50) THEN
    RAISE EXCEPTION 'invalid vat_rate';
  END IF;
  IF p_patch ? 'loyalty_mode' AND (p_patch ->> 'loyalty_mode') NOT IN ('off', 'stamps', 'points') THEN
    RAISE EXCEPTION 'invalid loyalty_mode';
  END IF;

  UPDATE locations SET
    service_mode          = CASE WHEN p_patch ? 'service_mode' THEN p_patch ->> 'service_mode' ELSE service_mode END,
    vat_rate              = CASE WHEN p_patch ? 'vat_rate' THEN (p_patch ->> 'vat_rate')::NUMERIC ELSE vat_rate END,
    receipt_business_name = CASE WHEN p_patch ? 'receipt_business_name' THEN NULLIF(TRIM(p_patch ->> 'receipt_business_name'), '') ELSE receipt_business_name END,
    receipt_address       = CASE WHEN p_patch ? 'receipt_address' THEN NULLIF(TRIM(p_patch ->> 'receipt_address'), '') ELSE receipt_address END,
    receipt_tax_id        = CASE WHEN p_patch ? 'receipt_tax_id' THEN NULLIF(TRIM(p_patch ->> 'receipt_tax_id'), '') ELSE receipt_tax_id END,
    receipt_phone         = CASE WHEN p_patch ? 'receipt_phone' THEN NULLIF(TRIM(p_patch ->> 'receipt_phone'), '') ELSE receipt_phone END,
    receipt_footer        = CASE WHEN p_patch ? 'receipt_footer' THEN NULLIF(TRIM(p_patch ->> 'receipt_footer'), '') ELSE receipt_footer END,
    loyalty_mode          = CASE WHEN p_patch ? 'loyalty_mode' THEN p_patch ->> 'loyalty_mode' ELSE loyalty_mode END,
    loyalty_stamps_goal   = CASE WHEN p_patch ? 'loyalty_stamps_goal' THEN (p_patch ->> 'loyalty_stamps_goal')::INTEGER ELSE loyalty_stamps_goal END,
    loyalty_points_percent = CASE WHEN p_patch ? 'loyalty_points_percent' THEN (p_patch ->> 'loyalty_points_percent')::NUMERIC ELSE loyalty_points_percent END,
    loyalty_points_min_redeem = CASE WHEN p_patch ? 'loyalty_points_min_redeem' THEN (p_patch ->> 'loyalty_points_min_redeem')::INTEGER ELSE loyalty_points_min_redeem END,
    settings              = CASE WHEN p_patch ? 'settings' THEN p_patch -> 'settings' ELSE settings END
  WHERE id = v_loc;
END $$;

REVOKE EXECUTE ON FUNCTION update_location_config FROM anon, public;

-- ── update_staff: правка карточки сотрудника (не PIN) ────────
CREATE OR REPLACE FUNCTION update_staff(
  p_staff_id UUID,
  p_patch    JSONB,
  p_staff_session UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_staff_perm(p_staff_session, 'manage');

  IF p_patch ? 'role' AND (p_patch ->> 'role') NOT IN ('owner', 'manager', 'barista') THEN
    RAISE EXCEPTION 'invalid role';
  END IF;

  UPDATE staff SET
    name      = CASE WHEN p_patch ? 'name' THEN p_patch ->> 'name' ELSE name END,
    role      = CASE WHEN p_patch ? 'role' THEN p_patch ->> 'role' ELSE role END,
    is_active = CASE WHEN p_patch ? 'is_active' THEN (p_patch ->> 'is_active')::BOOLEAN ELSE is_active END
  WHERE id = p_staff_id AND org_id = auth_org_id();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff not found';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION update_staff FROM anon, public;

-- ── bootstrap_org: + адрес, реквизиты чека сеются в SQL ──────
-- Раньше клиент после онбординга писал реквизиты прямым UPDATE
-- locations — 045 этот путь закрывает, а staff-сессии в онбординге
-- ещё нет. Теперь реквизиты выставляет сам bootstrap_org.
DROP FUNCTION IF EXISTS bootstrap_org(TEXT, TEXT, TEXT, TEXT);

CREATE FUNCTION bootstrap_org(
  p_org_name      TEXT,
  p_location_name TEXT,
  p_owner_name    TEXT,
  p_owner_pin     TEXT,
  p_business_address TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_org UUID;
  v_loc UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = v_uid AND raw_app_meta_data ? 'org_id'
  ) THEN
    RAISE EXCEPTION 'org already bootstrapped for this account';
  END IF;
  IF p_owner_pin !~ '^\d{4,8}$' THEN
    RAISE EXCEPTION 'PIN must be 4-8 digits';
  END IF;

  INSERT INTO orgs (name) VALUES (p_org_name) RETURNING id INTO v_org;
  INSERT INTO locations (org_id, name, receipt_business_name, receipt_address)
    VALUES (v_org, p_location_name,
            NULLIF(TRIM(p_org_name), ''), NULLIF(TRIM(p_business_address), ''))
    RETURNING id INTO v_loc;
  INSERT INTO staff (org_id, location_id, name, role, pin_hash)
    VALUES (v_org, NULL, p_owner_name, 'owner', crypt(p_owner_pin, gen_salt('bf')));

  UPDATE auth.users
  SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('org_id', v_org, 'location_id', v_loc)
  WHERE id = v_uid;

  RETURN json_build_object('org_id', v_org, 'location_id', v_loc);
END $$;

REVOKE EXECUTE ON FUNCTION bootstrap_org FROM anon, public;
