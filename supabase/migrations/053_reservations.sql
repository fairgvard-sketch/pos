-- ============================================================
-- 053 RESERVATIONS — книга броней столов (фаза A: внутренний
-- инструмент кассы, без публичного сайта).
--
-- Модель:
--   * Бронь — запись в reservations: дата+время, гость, стол
--     (необязательно заранее), кол-во гостей, заметка, теги.
--     Денег НЕ касается (инвариант 1 не затрагивается).
--   * Жизненный цикл статуса:
--       requested → confirmed → seated → completed
--                              ↘ no_show | cancelled
--     Отмена/неявка — смена статуса, НЕ удаление (аудит-трейл цел,
--     инвариант 2 в духе — историю броней не теряем).
--   * Посадка гостя (seat_reservation) переиспользует
--     open_or_get_table_order (013): открывается обычный счёт стола,
--     бронь получает order_id и статус 'seated'. Дальше — обычный
--     флоу зала (дозаказ/оплата). Нужна открытая смена (её требует
--     open_or_get_table_order).
--   * source='pos' (заведено на кассе). 'site' зарезервирован под
--     фазу C (публичная бронь с сайта, аналог online_orders 050).
--   * client_uuid UNIQUE — заготовка идемпотентности под сайт.
--
-- Права (фаза A): книгой броней управляет ЛЮБОЙ сотрудник — как
-- столами (RLS скоуп только по org, роль не enforced). Create/edit/
-- статусы — прямые запросы под RLS-политикой (как createTable/
-- setTableStatus в 013/016). Только seat — RPC (нужен SECURITY
-- DEFINER open_or_get_table_order + проверка смены/занятости стола).
-- ============================================================

CREATE TABLE reservations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id    UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  table_id       UUID REFERENCES tables(id) ON DELETE SET NULL,  -- назначенный стол
  reserved_at    TIMESTAMPTZ NOT NULL,                            -- дата+время брони
  duration_min   INTEGER NOT NULL DEFAULT 90,                     -- сколько держим стол
  party_size     INTEGER NOT NULL DEFAULT 2,
  customer_name  TEXT NOT NULL,
  customer_phone TEXT,
  note           TEXT,                                            -- «у окна», «день рождения»
  tags           TEXT[] NOT NULL DEFAULT '{}',                    -- VIP / ДР / аллергия
  status         TEXT NOT NULL DEFAULT 'confirmed'
                   CHECK (status IN ('requested','confirmed','seated','completed','no_show','cancelled')),
  source         TEXT NOT NULL DEFAULT 'pos' CHECK (source IN ('pos','site')),
  order_id       UUID REFERENCES orders(id) ON DELETE SET NULL,   -- счёт после посадки
  client_uuid    UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),  -- идемпотентность (сайт, фаза C)
  created_by     UUID REFERENCES staff(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Книга броней грузится по дню (диапазон reserved_at); статусы фильтруются.
CREATE INDEX idx_reservations_loc_time   ON reservations(location_id, reserved_at);
CREATE INDEX idx_reservations_loc_status ON reservations(location_id, status);
-- «Ближайшая активная бронь стола» — для бейджа в зале
CREATE INDEX idx_reservations_table_active ON reservations(table_id)
  WHERE status IN ('requested','confirmed');

-- updated_at сам обновляется на любой правке (клиент шлёт прямые UPDATE)
CREATE OR REPLACE FUNCTION touch_reservation_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_reservations_updated_at
  BEFORE UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION touch_reservation_updated_at();

-- Realtime: касса подписана на изменения броней (несколько устройств —
-- одна книга; правка на одном видна на другом)
ALTER PUBLICATION supabase_realtime ADD TABLE reservations;

ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;

-- Как tables_all (013): читают/пишут устройства своей организации,
-- роль enforced не тут (фаза A — любой сотрудник).
CREATE POLICY reservations_all ON reservations FOR ALL TO authenticated
  USING (org_id = auth_org_id())
  WITH CHECK (org_id = auth_org_id());

-- ============================================================
-- RPC: seat_reservation — посадить гостя брони за стол.
-- Открывает (или возвращает) счёт стола через open_or_get_table_order
-- и привязывает бронь к заказу. Идемпотентно: повторный вызов по уже
-- посаженной брони вернёт её же счёт.
--   p_table_id — переопределяет стол брони (гостя сажают не туда, где
--   бронировали). NULL → берётся reservations.table_id.
-- ============================================================
CREATE OR REPLACE FUNCTION seat_reservation(
  p_reservation_id UUID,
  p_staff_id       UUID,
  p_table_id       UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_res       reservations%ROWTYPE;
  v_table     UUID;
  v_order_res JSON;
  v_order_id  UUID;
  v_o         orders%ROWTYPE;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_res FROM reservations
    WHERE id = p_reservation_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found';
  END IF;

  -- Уже посажены → вернуть существующий счёт (double-tap безопасен)
  IF v_res.status = 'seated' AND v_res.order_id IS NOT NULL THEN
    SELECT * INTO v_o FROM orders WHERE id = v_res.order_id;
    RETURN json_build_object('order_id', v_o.id, 'daily_number', v_o.daily_number,
                             'total', v_o.total, 'existing', TRUE);
  END IF;
  IF v_res.status IN ('completed','no_show','cancelled') THEN
    RAISE EXCEPTION 'reservation closed';
  END IF;

  v_table := COALESCE(p_table_id, v_res.table_id);
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'no_table';         -- стол не выбран
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tables WHERE id = v_table AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'table not found';
  END IF;
  -- Стол занят чужим открытым счётом → пусть хост выберет другой
  IF EXISTS (SELECT 1 FROM orders WHERE table_id = v_table AND status = 'open') THEN
    RAISE EXCEPTION 'table_busy';
  END IF;

  -- Открыть счёт (требует открытой смены — enforced внутри)
  v_order_res := open_or_get_table_order(v_table, p_staff_id);
  v_order_id  := (v_order_res ->> 'order_id')::UUID;

  UPDATE reservations
    SET status = 'seated', table_id = v_table, order_id = v_order_id
    WHERE id = p_reservation_id;

  RETURN json_build_object(
    'order_id',     v_order_id,
    'daily_number', (v_order_res ->> 'daily_number')::INTEGER,
    'total',        (v_order_res ->> 'total')::INTEGER,
    'existing',     FALSE
  );
END $$;

REVOKE EXECUTE ON FUNCTION seat_reservation FROM anon, public;
