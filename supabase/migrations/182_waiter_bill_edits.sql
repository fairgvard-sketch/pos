-- ============================================================
-- 182 ТЕЛЕФОН ОФИЦИАНТА: ПРАВКА И ПЕРЕНОС ОТПРАВЛЕННОГО
--
-- То же, что 181 дал кассе, теперь и на телефоне (решение владельца
-- 09.10.2026): отправленную позицию официант может
--   • убрать целиком или уменьшить — только с PIN менеджера/владельца,
--     которого он зовёт к телефону (проверка и лимит попыток те же, что
--     у кассы; лимит считается по телефону, касса им не блокируется);
--   • перенести на другой стол — без PIN.
-- Fire был с 180, «ещё одна такая же» — обычная отправка.
--
-- Телефон работает через обёртки waiter_*: они подставляют точку
-- телефона (_waiter_act_as), вызывают ровно те же void_bill_line /
-- move_bill_lines, что касса, и восстанавливают claims.
--
-- ТИКЕТЫ КУХНЕ. Отмену и перенос печатает касса T2, как и дозаказы
-- телефона: задание print_jobs пишется в той же транзакции. Новые виды
-- kitchen_void («ביטול») и kitchen_move («הועבר לשולחן N»).
--
-- Старый бандл кассы распечатал бы такое задание как обычный заказ —
-- кухня приготовила бы отменённое. Поэтому прежний claim_print_jobs(UUID)
-- отдаёт только kitchen, а новые виды забирает перегрузка с явным
-- списком видов, которую вызывает только новый бандл. Пока касса не
-- обновилась, задание ждёт (и через 30 минут истекает с «не напечатан»
-- на телефоне); отставшая касса видит обязательную плашку обновления.
-- ============================================================

ALTER TABLE print_jobs DROP CONSTRAINT print_jobs_kind_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_kind_check
  CHECK (kind IN ('kitchen', 'kitchen_void', 'kitchen_move'));

-- ── Забрать задания: общее тело ─────────────────────────────
CREATE FUNCTION _claim_print_jobs(p_device_uuid UUID, p_kinds TEXT[])
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org  UUID := auth_org_id();
  v_loc  UUID := auth_location_id();
  v_jobs JSON;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_org_capability('pos_operate');

  -- Залежавшееся не печатаем: тикет получасовой давности кухня примет
  -- за новый заказ. Официант видит «не напечатан» и говорит кухне.
  UPDATE print_jobs
  SET status = 'expired', finished_at = NOW(), error = 'expired'
  WHERE location_id = v_loc AND status = 'pending'
    AND created_at < NOW() - INTERVAL '30 minutes';

  -- Касса пропала посреди печати: напечаталось или нет — неизвестно.
  -- Вслепую не повторяем (двойной тикет = двойная готовка).
  UPDATE print_jobs
  SET status = 'failed', finished_at = NOW(), error = 'interrupted'
  WHERE location_id = v_loc AND status = 'printing'
    AND claimed_at < NOW() - INTERVAL '2 minutes';

  WITH picked AS (
    SELECT id FROM print_jobs
    WHERE location_id = v_loc AND status = 'pending' AND kind = ANY(p_kinds)
    ORDER BY created_at
    LIMIT 10
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE print_jobs j
    SET status = 'printing', claimed_device_uuid = p_device_uuid,
        claimed_at = NOW(), attempts = j.attempts + 1
    FROM picked
    WHERE j.id = picked.id
    RETURNING j.id, j.kind, j.payload, j.created_at
  )
  SELECT COALESCE(json_agg(json_build_object(
           'id', id, 'kind', kind, 'payload', payload, 'created_at', created_at)
         ORDER BY created_at), '[]'::JSON)
  INTO v_jobs FROM claimed;

  RETURN v_jobs;
END $$;

REVOKE ALL ON FUNCTION _claim_print_jobs(UUID, TEXT[]) FROM PUBLIC, anon, authenticated;

-- Прежняя подпись — касса до 182: только обычные заказы
CREATE OR REPLACE FUNCTION claim_print_jobs(p_device_uuid UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN _claim_print_jobs(p_device_uuid, ARRAY['kitchen']);
END $$;

-- Новая касса называет виды, которые умеет печатать
CREATE FUNCTION claim_print_jobs(p_device_uuid UUID, p_kinds TEXT[])
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF COALESCE(cardinality(p_kinds), 0) = 0 THEN
    RAISE EXCEPTION 'kinds required';
  END IF;
  RETURN _claim_print_jobs(p_device_uuid, p_kinds);
END $$;

REVOKE ALL ON FUNCTION claim_print_jobs(UUID, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION claim_print_jobs(UUID, TEXT[]) TO authenticated;

-- ── Счёт стола: данные для «ещё одной такой же» ─────────────
-- Добавлены товар, вариант, цена за штуку и модификаторы с id
-- (как у кассы в 181). Остальное — без изменений.
CREATE OR REPLACE FUNCTION _waiter_bill(p_staff_session UUID, p_table_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v       JSONB := _waiter_enter(p_staff_session);
  v_loc   UUID  := (v ->> 'location_id')::UUID;
  v_order orders%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tables WHERE id = p_table_id AND location_id = v_loc AND is_active) THEN
    RAISE EXCEPTION 'table not found';
  END IF;

  SELECT * INTO v_order FROM orders
  WHERE table_id = p_table_id AND location_id = v_loc AND status = 'open';
  IF NOT FOUND THEN
    RETURN json_build_object('order', NULL, 'lines', '[]'::JSON);
  END IF;

  RETURN json_build_object(
    'order', json_build_object(
      'id', v_order.id, 'daily_number', v_order.daily_number,
      'total', v_order.total, 'opened_at', v_order.created_at),
    'lines', COALESCE((
      SELECT json_agg(json_build_object(
               'id', i.id, 'name', i.name, 'variant_name', i.variant_name,
               'qty', i.qty, 'line_total', i.line_total,
               'modifiers', COALESCE((SELECT json_agg(m.name ORDER BY m.name)
                                      FROM order_item_modifiers m
                                      WHERE m.order_item_id = i.id), '[]'::JSON),
               'notes', i.notes, 'course', i.course, 'held', i.held,
               'menu_item_id', i.menu_item_id, 'variant_id', i.variant_id,
               'unit_price', i.unit_price,
               'mods', COALESCE((SELECT json_agg(json_build_object(
                                          'id', m.modifier_id, 'name', m.name,
                                          'priceDelta', m.price_delta) ORDER BY m.name)
                                 FROM order_item_modifiers m
                                 WHERE m.order_item_id = i.id), '[]'::JSON))
             ORDER BY i.course NULLS FIRST, i.name)
      FROM order_items i
      WHERE i.order_id = v_order.id AND i.voided_at IS NULL
    ), '[]'::JSON)
  );
END $$;

-- Строки тикета без придержанного: кухня его ещё не видела
CREATE FUNCTION _waiter_visible_lines(p_lines JSONB)
RETURNS JSONB
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(e - 'held' ORDER BY ord), '[]'::JSONB)
  FROM jsonb_array_elements(COALESCE(p_lines, '[]'::JSONB)) WITH ORDINALITY AS x(e, ord)
  WHERE NOT COALESCE((e ->> 'held')::BOOLEAN, FALSE)
$$;

REVOKE ALL ON FUNCTION _waiter_visible_lines(JSONB) FROM PUBLIC, anon, authenticated;

-- ── Убрать позицию по PIN менеджера ─────────────────────────
-- p_qty NULL — вся строка. Неверный PIN — ok:false (не исключение:
-- откат стёр бы попытку из лимита).
CREATE FUNCTION _waiter_void_line(
  p_staff_session UUID,
  p_item_id       UUID,
  p_qty           INTEGER,
  p_reason        TEXT,
  p_manager_pin   TEXT,
  p_op_uuid       UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v       JSONB := _waiter_enter(p_staff_session);
  v_org   UUID  := (v ->> 'org_id')::UUID;
  v_loc   UUID  := (v ->> 'location_id')::UUID;
  v_res   JSONB;
  v_lines JSONB;
BEGIN
  -- Только счёт стола: стойку и доставку телефон не трогает
  IF NOT EXISTS (
    SELECT 1 FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE i.id = p_item_id AND o.location_id = v_loc AND o.table_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'item not found';
  END IF;

  v_res := void_bill_line(p_item_id, p_qty, p_reason, p_manager_pin, p_staff_session, p_op_uuid)::JSONB;
  IF NOT COALESCE((v_res ->> 'ok')::BOOLEAN, FALSE) THEN
    RETURN v_res::JSON;
  END IF;

  v_lines := _waiter_visible_lines(v_res -> 'ticket_lines');
  IF jsonb_array_length(v_lines) > 0 THEN
    INSERT INTO print_jobs (id, org_id, location_id, order_id, kind, payload,
                            waiter_device_id, staff_id)
    VALUES (p_op_uuid, v_org, v_loc, (v_res ->> 'order_id')::UUID, 'kitchen_void',
            jsonb_build_object('tableLabel', v_res ->> 'table_label',
                               'staffName', v ->> 'staff_name', 'lines', v_lines),
            (v ->> 'device_id')::UUID, (v ->> 'staff_id')::UUID)
    ON CONFLICT (id) DO NOTHING;
  END IF;

  RETURN json_build_object(
    'ok',          TRUE,
    'order_id',    v_res -> 'order_id',
    'total',       v_res -> 'total',
    'approved_by', v_res -> 'approved_by',
    'job_id',      (SELECT id FROM print_jobs WHERE id = p_op_uuid)
  );
END $$;

REVOKE ALL ON FUNCTION _waiter_void_line(UUID, UUID, INTEGER, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;

-- ── Перенести позиции на другой стол ────────────────────────
CREATE FUNCTION _waiter_move_lines(
  p_staff_session UUID,
  p_item_ids      UUID[],
  p_to_table_id   UUID,
  p_op_uuid       UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v       JSONB := _waiter_enter(p_staff_session);
  v_org   UUID  := (v ->> 'org_id')::UUID;
  v_loc   UUID  := (v ->> 'location_id')::UUID;
  v_res   JSONB;
  v_lines JSONB;
BEGIN
  v_res := move_bill_lines(p_item_ids, p_to_table_id, p_staff_session, p_op_uuid)::JSONB;

  v_lines := _waiter_visible_lines(v_res -> 'ticket_lines');
  IF jsonb_array_length(v_lines) > 0 THEN
    INSERT INTO print_jobs (id, org_id, location_id, order_id, kind, payload,
                            waiter_device_id, staff_id)
    VALUES (p_op_uuid, v_org, v_loc, (v_res ->> 'target_order_id')::UUID, 'kitchen_move',
            jsonb_build_object('tableLabel', v_res ->> 'from_label',
                               'movedTo', v_res ->> 'to_label',
                               'staffName', v ->> 'staff_name', 'lines', v_lines),
            (v ->> 'device_id')::UUID, (v ->> 'staff_id')::UUID)
    ON CONFLICT (id) DO NOTHING;
  END IF;

  RETURN json_build_object(
    'ok',           TRUE,
    'source_total', v_res -> 'source_total',
    'source_empty', v_res -> 'source_empty',
    'target_total', v_res -> 'target_total',
    'to_label',     v_res -> 'to_label',
    'job_id',       (SELECT id FROM print_jobs WHERE id = p_op_uuid)
  );
END $$;

REVOKE ALL ON FUNCTION _waiter_move_lines(UUID, UUID[], UUID, UUID) FROM PUBLIC, anon, authenticated;

-- ── Публичные обёртки (см. 180: claims телефона восстанавливаются) ──
CREATE FUNCTION waiter_void_line(
  p_staff_session UUID,
  p_item_id       UUID,
  p_qty           INTEGER,
  p_reason        TEXT,
  p_manager_pin   TEXT,
  p_op_uuid       UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_saved TEXT := current_setting('request.jwt.claims', TRUE);
  v_res   JSON;
BEGIN
  v_res := _waiter_void_line(p_staff_session, p_item_id, p_qty, p_reason, p_manager_pin, p_op_uuid);
  PERFORM _waiter_restore_claims(v_saved);
  RETURN v_res;
END $$;

CREATE FUNCTION waiter_move_lines(
  p_staff_session UUID,
  p_item_ids      UUID[],
  p_to_table_id   UUID,
  p_op_uuid       UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_saved TEXT := current_setting('request.jwt.claims', TRUE);
  v_res   JSON;
BEGIN
  v_res := _waiter_move_lines(p_staff_session, p_item_ids, p_to_table_id, p_op_uuid);
  PERFORM _waiter_restore_claims(v_saved);
  RETURN v_res;
END $$;

REVOKE ALL ON FUNCTION waiter_void_line(UUID, UUID, INTEGER, TEXT, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION waiter_move_lines(UUID, UUID[], UUID, UUID)             FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION waiter_void_line(UUID, UUID, INTEGER, TEXT, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION waiter_move_lines(UUID, UUID[], UUID, UUID)             TO authenticated;

COMMENT ON FUNCTION waiter_void_line(UUID, UUID, INTEGER, TEXT, TEXT, UUID) IS
  'Телефон официанта: убрать отправленную позицию по PIN менеджера + тикет ביטול (182)';
COMMENT ON FUNCTION waiter_move_lines(UUID, UUID[], UUID, UUID) IS
  'Телефон официанта: перенести позиции на другой стол + тикет הועבר (182)';
