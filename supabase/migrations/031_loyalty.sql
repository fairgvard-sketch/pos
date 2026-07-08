-- ============================================================
-- 031 LOYALTY — программа лояльности: штампы и баллы.
--
-- Две механики, режим выбирается в настройках точки:
--   * stamps — «каждый N-й напиток бесплатно». Штамп даёт позиция
--     из категории с флагом loyalty_stamps. Награда — самая дешёвая
--     такая позиция в чеке бесплатно, списывается goal штампов.
--   * points — кешбэк: баллы = агороты (баланс показывается как ₪).
--     Начисление loyalty_points_percent от суммы чека, списание —
--     как скидка (клиент следит за порогом min_redeem; сервер
--     защищает баланс).
--
-- Гость = телефон в рамках org. Балансы на строке гостя — снапшот,
-- меняются ТОЛЬКО через SECURITY DEFINER (колоночные гранты, как
-- staff.pin_hash); каждое изменение — строка в loyalty_events
-- (аудит-трейл, как payments/refunds).
--
-- Поток: касса привязывает гостя/награду к open-заказу RPC
-- apply_loyalty (скидка пересчитывается сервером, place_order не
-- трогаем). Балансы списываются/начисляются в pay_order — заказ,
-- брошенный до оплаты, балансов не касается.
--
-- V1 сознательно не делает: возврат баллов при refund (возврат
-- денег баллы не трогает), лояльность на счетах столов.
-- ============================================================

-- ── Настройки программы (на точке, рядом с реквизитами чека) ──
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS loyalty_mode TEXT NOT NULL DEFAULT 'off'
    CHECK (loyalty_mode IN ('off', 'stamps', 'points')),
  ADD COLUMN IF NOT EXISTS loyalty_stamps_goal INTEGER NOT NULL DEFAULT 10
    CHECK (loyalty_stamps_goal BETWEEN 2 AND 50),
  ADD COLUMN IF NOT EXISTS loyalty_points_percent NUMERIC(5,2) NOT NULL DEFAULT 5
    CHECK (loyalty_points_percent BETWEEN 0 AND 50),
  ADD COLUMN IF NOT EXISTS loyalty_points_min_redeem INTEGER NOT NULL DEFAULT 1000
    CHECK (loyalty_points_min_redeem >= 0);

-- Какие категории дают штамп (кофе — да, выпечка — нет)
ALTER TABLE menu_categories
  ADD COLUMN IF NOT EXISTS loyalty_stamps BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Гости ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS guests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  phone         TEXT NOT NULL,                   -- только цифры, нормализует клиент
  name          TEXT,
  stamps        INTEGER NOT NULL DEFAULT 0 CHECK (stamps >= 0),
  points        INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),  -- агороты
  visits        INTEGER NOT NULL DEFAULT 0,
  total_spent   INTEGER NOT NULL DEFAULT 0,      -- агороты, за всё время
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_visit_at TIMESTAMPTZ,
  UNIQUE (org_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_guests_org_phone ON guests(org_id, phone);

ALTER TABLE guests ENABLE ROW LEVEL SECURITY;
CREATE POLICY guests_all ON guests FOR ALL TO authenticated
  USING (org_id = auth_org_id()) WITH CHECK (org_id = auth_org_id());

-- Балансы/счётчики клиент менять не может — только имя и телефон.
-- Никаких DELETE: история визитов ссылается на гостя.
REVOKE ALL ON guests FROM anon, authenticated;
GRANT SELECT ON guests TO authenticated;
GRANT INSERT (org_id, phone, name) ON guests TO authenticated;
GRANT UPDATE (phone, name) ON guests TO authenticated;

-- ── Журнал движений (append-only, пишет только сервер) ────
CREATE TABLE IF NOT EXISTS loyalty_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  guest_id     UUID NOT NULL REFERENCES guests(id),
  order_id     UUID REFERENCES orders(id),
  kind         TEXT NOT NULL CHECK (kind IN ('earn', 'redeem', 'adjust')),
  stamps_delta INTEGER NOT NULL DEFAULT 0,
  points_delta INTEGER NOT NULL DEFAULT 0,       -- агороты
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_events_guest ON loyalty_events(guest_id, created_at DESC);

ALTER TABLE loyalty_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY loyalty_events_read ON loyalty_events FOR SELECT TO authenticated
  USING (org_id = auth_org_id());

REVOKE ALL ON loyalty_events FROM anon, authenticated;
GRANT SELECT ON loyalty_events TO authenticated;

-- ── Заказ знает гостя и применённую награду ───────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS guest_id UUID REFERENCES guests(id),
  ADD COLUMN IF NOT EXISTS loyalty_redeem TEXT
    CHECK (loyalty_redeem IN ('stamps', 'points')),
  ADD COLUMN IF NOT EXISTS loyalty_discount INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_orders_guest ON orders(guest_id) WHERE guest_id IS NOT NULL;

-- ============================================================
-- RPC: apply_loyalty — привязать гостя (и, опционально, награду)
-- к открытому заказу. Скидку считает СЕРВЕР (клиент присылает
-- намерение — как place_order/set_order_discount). Итоги заказа
-- пересчитываются той же формулой, что 011/024.
--
-- p_redeem: NULL — без списания
--           {"type":"stamps"}                — бесплатный напиток
--           {"type":"points","amount":1200}  — списать агороты
-- p_guest_id = NULL — отвязать гостя и снять награду.
-- Идемпотентен: повторный вызов перезаписывает привязку.
-- ============================================================
CREATE OR REPLACE FUNCTION apply_loyalty(
  p_order_id UUID,
  p_guest_id UUID,
  p_redeem   JSONB DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_order    orders%ROWTYPE;
  v_guest    guests%ROWTYPE;
  v_goal     INTEGER;
  v_subtotal INTEGER;
  v_disc     INTEGER := 0;
  v_loy      INTEGER := 0;
  v_redeem   TEXT := NULL;
  v_free     INTEGER;
  v_amount   INTEGER;
  v_total    INTEGER;
  v_vat      INTEGER;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_order.status <> 'open' THEN
    RAISE EXCEPTION 'order not open';
  END IF;

  IF p_guest_id IS NOT NULL THEN
    SELECT * INTO v_guest FROM guests WHERE id = p_guest_id AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'guest not found';
    END IF;
  END IF;

  -- Подытог и ручная скидка — пересчёт из активных позиций (как 024)
  SELECT COALESCE(SUM(line_total), 0) INTO v_subtotal
  FROM order_items WHERE order_id = p_order_id AND voided_at IS NULL;

  IF v_order.discount_type = 'percent' THEN
    v_disc := ROUND(v_subtotal * v_order.discount_value / 100.0);
  ELSIF v_order.discount_type = 'fixed' THEN
    v_disc := v_order.discount_value;
  END IF;
  IF v_disc > v_subtotal THEN v_disc := v_subtotal; END IF;

  -- Награда (только вместе с гостем)
  IF p_guest_id IS NOT NULL AND p_redeem IS NOT NULL AND (p_redeem ->> 'type') IS NOT NULL THEN
    v_redeem := p_redeem ->> 'type';

    IF v_redeem = 'stamps' THEN
      SELECT loyalty_stamps_goal INTO v_goal FROM locations WHERE id = v_order.location_id;
      IF v_guest.stamps < v_goal THEN
        RAISE EXCEPTION 'insufficient stamps';
      END IF;
      -- Бесплатной становится самая дешёвая штампуемая позиция чека
      SELECT MIN(oi.unit_price) INTO v_free
      FROM order_items oi
      JOIN menu_items mi ON mi.id = oi.menu_item_id
      JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE oi.order_id = p_order_id AND oi.voided_at IS NULL AND mc.loyalty_stamps;
      IF v_free IS NULL THEN
        RAISE EXCEPTION 'no stampable item in order';
      END IF;
      v_loy := LEAST(v_free, v_subtotal - v_disc);

    ELSIF v_redeem = 'points' THEN
      v_amount := NULLIF(p_redeem ->> 'amount', '')::INTEGER;
      IF v_amount IS NULL OR v_amount <= 0 THEN
        RAISE EXCEPTION 'invalid redeem amount';
      END IF;
      IF v_amount > v_guest.points THEN
        RAISE EXCEPTION 'insufficient points';
      END IF;
      v_loy := LEAST(v_amount, v_subtotal - v_disc);

    ELSE
      RAISE EXCEPTION 'invalid redeem type';
    END IF;
  END IF;

  v_total := v_subtotal - v_disc - v_loy;
  v_vat := ROUND(v_total * v_order.vat_rate / (100 + v_order.vat_rate));

  UPDATE orders SET
    guest_id         = p_guest_id,
    loyalty_redeem   = v_redeem,
    loyalty_discount = v_loy,
    subtotal         = v_subtotal,
    discount_amount  = v_disc,
    total            = v_total,
    vat_amount       = v_vat
  WHERE id = p_order_id;

  RETURN json_build_object('total', v_total, 'loyalty_discount', v_loy);
END $$;

REVOKE EXECUTE ON FUNCTION apply_loyalty FROM anon, public;

-- ============================================================
-- pay_order — та же логика, что 008, плюс финализация лояльности:
-- списание награды и начисление по текущему режиму точки. Всё в
-- одной транзакции с оплатой; guard по status='open' гарантирует
-- однократность. Заказ, не дошедший до оплаты, балансы не трогает.
-- ============================================================
CREATE OR REPLACE FUNCTION pay_order(p_order_id UUID, p_payments JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org    UUID := auth_org_id();
  v_loc    UUID := auth_location_id();
  v_order  orders%ROWTYPE;
  v_shift  UUID;
  v_pay    JSONB;
  v_sum    INTEGER := 0;
  -- лояльность
  v_guest    guests%ROWTYPE;
  v_mode     TEXT;
  v_goal     INTEGER;
  v_pct      NUMERIC(5,2);
  v_eligible INTEGER;
  v_stamps_d INTEGER := 0;  -- итоговое изменение штампов
  v_points_d INTEGER := 0;  -- итоговое изменение баллов (агороты)
  v_earn     INTEGER := 0;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_order.status <> 'open' THEN
    RAISE EXCEPTION 'order not open';
  END IF;

  SELECT id INTO v_shift FROM shifts WHERE location_id = v_loc AND status = 'open';
  IF v_shift IS NULL THEN
    RAISE EXCEPTION 'no open shift';
  END IF;

  FOR v_pay IN SELECT * FROM jsonb_array_elements(p_payments) LOOP
    IF (v_pay ->> 'method') NOT IN ('cash', 'card') THEN
      RAISE EXCEPTION 'invalid payment method';
    END IF;
    v_sum := v_sum + (v_pay ->> 'amount')::INTEGER;
    INSERT INTO payments (org_id, order_id, shift_id, method, amount, tendered, change_due)
    VALUES (v_org, p_order_id, v_shift, v_pay ->> 'method',
            (v_pay ->> 'amount')::INTEGER,
            NULLIF(v_pay ->> 'tendered', '')::INTEGER,
            NULLIF(v_pay ->> 'change_due', '')::INTEGER);
  END LOOP;

  IF v_sum < v_order.total THEN
    RAISE EXCEPTION 'insufficient payment: % < %', v_sum, v_order.total;
  END IF;

  -- ── Лояльность: списать награду, начислить по режиму ─────
  IF v_order.guest_id IS NOT NULL THEN
    SELECT * INTO v_guest FROM guests WHERE id = v_order.guest_id FOR UPDATE;

    SELECT loyalty_mode, loyalty_stamps_goal, loyalty_points_percent
      INTO v_mode, v_goal, v_pct
    FROM locations WHERE id = v_order.location_id;

    -- Списание (баланс мог утечь с другого устройства — перепроверяем)
    IF v_order.loyalty_redeem = 'stamps' THEN
      IF v_guest.stamps < v_goal THEN
        RAISE EXCEPTION 'insufficient stamps';
      END IF;
      v_stamps_d := -v_goal;
      INSERT INTO loyalty_events (org_id, guest_id, order_id, kind, stamps_delta)
      VALUES (v_org, v_guest.id, p_order_id, 'redeem', -v_goal);
    ELSIF v_order.loyalty_redeem = 'points' THEN
      IF v_guest.points < v_order.loyalty_discount THEN
        RAISE EXCEPTION 'insufficient points';
      END IF;
      v_points_d := -v_order.loyalty_discount;
      INSERT INTO loyalty_events (org_id, guest_id, order_id, kind, points_delta)
      VALUES (v_org, v_guest.id, p_order_id, 'redeem', -v_order.loyalty_discount);
    END IF;

    -- Начисление по текущему режиму точки
    IF v_mode = 'stamps' THEN
      SELECT COALESCE(SUM(oi.qty), 0) INTO v_eligible
      FROM order_items oi
      JOIN menu_items mi ON mi.id = oi.menu_item_id
      JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE oi.order_id = p_order_id AND oi.voided_at IS NULL AND mc.loyalty_stamps;
      -- Подаренный напиток штамп не даёт
      v_earn := GREATEST(v_eligible - CASE WHEN v_order.loyalty_redeem = 'stamps' THEN 1 ELSE 0 END, 0);
      IF v_earn > 0 THEN
        v_stamps_d := v_stamps_d + v_earn;
        INSERT INTO loyalty_events (org_id, guest_id, order_id, kind, stamps_delta)
        VALUES (v_org, v_guest.id, p_order_id, 'earn', v_earn);
      END IF;
    ELSIF v_mode = 'points' THEN
      v_earn := ROUND(v_order.total * v_pct / 100);
      IF v_earn > 0 THEN
        v_points_d := v_points_d + v_earn;
        INSERT INTO loyalty_events (org_id, guest_id, order_id, kind, points_delta)
        VALUES (v_org, v_guest.id, p_order_id, 'earn', v_earn);
      END IF;
    END IF;

    UPDATE guests SET
      stamps        = stamps + v_stamps_d,
      points        = points + v_points_d,
      visits        = visits + 1,
      total_spent   = total_spent + v_order.total,
      last_visit_at = NOW()
    WHERE id = v_guest.id;
  END IF;

  UPDATE orders
  SET status = 'paid', paid_at = NOW(), shift_id = v_shift
  WHERE id = p_order_id;

  RETURN json_build_object('order_id', p_order_id, 'paid', v_sum);
END $$;
