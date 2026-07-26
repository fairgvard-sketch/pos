-- ============================================================
-- 102 RESERVATIONS WEB DESK — веб-стол хостес без POS
-- (Phase 4 standalone digital products).
--
-- Данные броней уже независимы от POS (053/063): смена не требуется,
-- гость подаёт заявку через Edge Function. Здесь добавляется рабочее
-- место в веб-кабинете:
--   1) Терминальные статусы визита: completed (гость ушёл) и no_show
--      (не пришёл). СОЗНАТЕЛЬНО не добавляются активные arrived/seated:
--      движок доступности (occupancy-триггер, exclusion-индекс 063,
--      _table_free) везде считает занятость по new/confirmed, и менять
--      его предикаты — отдельная рискованная работа. Визит занимает
--      стол в статусе confirmed; терминальный статус освобождает окно —
--      это корректно для обоих (completed = визит окончен, no_show =
--      стол можно отдавать).
--   2) decided_by_member — атрибуция веб-решений (как в 101).
--   3) set_reservation_status_web — переводы статусов из кабинета:
--      owner/manager-членство (091/096), модуль reservations обязателен.
--      Брони, посаженные в POS-заказ (order_id, seat_reservation 057),
--      неприкасаемы — их визит живёт на кассе.
--
-- POS-путь (accept/reject_reservation, seat_reservation) не изменился:
-- «посадить и открыть заказ» остаётся возможностью точек с POS.
--
-- ⚠️ ТРЕБУЕТ 100 (org_has_product), 091 (assert_backoffice_location).
-- ============================================================

-- ── Терминальные статусы визита ──────────────────────────────
ALTER TABLE reservations DROP CONSTRAINT reservations_status_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_status_check
  CHECK (status IN (
    'new', 'confirmed', 'rejected', 'cancelled', 'completed', 'no_show'
  ));

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS
  decided_by_member UUID REFERENCES organization_members(id);

COMMENT ON COLUMN reservations.decided_by_member IS
  'Член организации (веб-кабинет), принявший решение по брони; decided_by остаётся для PIN-сотрудника кассы.';

-- ── Переводы статусов из веб-кабинета ────────────────────────
CREATE OR REPLACE FUNCTION set_reservation_status_web(
  p_location_id UUID,
  p_id          UUID,
  p_status      TEXT,
  p_reason      TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member  organization_members%ROWTYPE;
  v_r       reservations%ROWTYPE;
  v_allowed TEXT[];
BEGIN
  -- Только веб-членство owner/manager: кассовый поток остаётся на
  -- accept/reject_reservation с PIN-сессией.
  IF auth_backoffice_role() IS NULL
     OR auth_backoffice_role() NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'backoffice access denied';
  END IF;
  SELECT * INTO v_member
  FROM organization_members
  WHERE auth_user_id = auth.uid() AND org_id = auth_org_id() AND is_active
  LIMIT 1;
  IF v_member.id IS NULL THEN
    RAISE EXCEPTION 'backoffice access denied';
  END IF;
  PERFORM assert_backoffice_location(p_location_id);

  IF NOT org_has_product(auth_org_id(), 'reservations') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;

  SELECT * INTO v_r
  FROM reservations
  WHERE id = p_id
    AND org_id = auth_org_id()
    AND location_id = p_location_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_r.order_id IS NOT NULL THEN
    -- Гость уже посажен в POS-заказ (057) — визит живёт на кассе.
    RAISE EXCEPTION 'pos_mode';
  END IF;

  -- Ретрай той же кнопки после таймаута — no-op, не ошибка.
  IF v_r.status = p_status THEN
    RETURN json_build_object(
      'reservation_id', v_r.id, 'status', v_r.status, 'duplicate', TRUE
    );
  END IF;

  -- CASE в присваивании, не в IF-условии (грабли сплиттера CLI, 076).
  v_allowed := CASE v_r.status
    WHEN 'new'       THEN ARRAY['confirmed', 'rejected', 'cancelled']
    WHEN 'confirmed' THEN ARRAY['cancelled', 'completed', 'no_show']
    ELSE ARRAY[]::TEXT[]
  END;
  IF NOT (p_status = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;

  UPDATE reservations SET
    status = p_status,
    reject_reason = CASE
      WHEN p_status IN ('rejected', 'cancelled')
        THEN NULLIF(LEFT(TRIM(COALESCE(p_reason, '')), 200), '')
      ELSE reject_reason
    END,
    cancelled_at = CASE
      WHEN p_status = 'cancelled' THEN NOW()
      ELSE cancelled_at
    END,
    decided_by_member = v_member.id,
    decided_at = NOW()
  WHERE id = v_r.id;

  RETURN json_build_object('reservation_id', v_r.id, 'status', p_status);
END $$;

REVOKE ALL ON FUNCTION set_reservation_status_web(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_reservation_status_web(UUID, UUID, TEXT, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION set_reservation_status_web(UUID, UUID, TEXT, TEXT) IS
  'Веб-стол хостес: переводы статусов брони без POS. Owner/manager-членство, модуль reservations; брони с order_id (посажены на кассе) неприкасаемы. Терминальные completed/no_show освобождают окно стола (вне предикатов движка доступности — сознательно).';
