-- ============================================================
-- 086 HOT FLOW STAFF SESSIONS — мягкий режим (P2-11).
--
-- Горячий поток (открытие счёта стола, дозаказ, продажа, оплата, экран
-- бариста) до сих пор доверял клиентскому p_staff_id — известный компромисс
-- AGENTS.md. Теперь эти RPC принимают p_staff_session и проверяют её через
-- require_staff_session:
--
--   * МЯГКИЙ режим (эта миграция, зеркало 044): NULL → пропуск — дорабатывают
--     старые клиенты и хвост офлайн-очереди; строгий режим — ОТДЕЛЬНОЙ
--     миграцией после раскатки клиентов и опустошения очередей (зеркало 045);
--   * переданный, но битый/протухший токен → 'staff session invalid' —
--     drain уже понимает эту ошибку (blocked_auth → PIN → retry);
--   * автор операции остаётся p_staff_id из payload (offline-replay
--     сохраняет исходного автора), сессия лишь подтверждает, что за кассой
--     живой залогиненный сотрудник, — токен читается в момент вызова/replay.
--
-- Механика: существующая функция переименовывается в *_impl и закрывается
-- от клиентов (приём 068), новая обёртка с тем же именем валидирует сессию
-- и делегирует. Тела не копируются — меньше поверхность ошибки.
-- ============================================================

-- ── Проверка сессии без требования конкретного права ────────
-- Возвращает staff_id сессии; NULL в мягком режиме без токена.
CREATE OR REPLACE FUNCTION require_staff_session(p_session UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_staff_id UUID;
BEGIN
  -- МЯГКИЙ режим: без токена пропускаем. Строгая миграция заменит на RAISE.
  IF p_session IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT s.id INTO v_staff_id
  FROM staff_sessions ss
  JOIN staff s ON s.id = ss.staff_id
  WHERE ss.token = p_session
    AND ss.org_id = auth_org_id()
    AND ss.revoked_at IS NULL
    AND ss.expires_at > NOW()
    AND s.is_active;
  IF v_staff_id IS NULL THEN
    RAISE EXCEPTION 'staff session invalid';
  END IF;

  -- Скользящее продление, как в require_staff_perm
  UPDATE staff_sessions
  SET expires_at = GREATEST(expires_at, NOW() + INTERVAL '72 hours')
  WHERE token = p_session;

  RETURN v_staff_id;
END $$;

REVOKE EXECUTE ON FUNCTION require_staff_session FROM anon, public;

-- ── place_order ─────────────────────────────────────────────
ALTER FUNCTION place_order(UUID, UUID, TEXT, TEXT, JSONB, JSONB, TEXT, TIMESTAMPTZ)
  RENAME TO place_order_impl;
REVOKE EXECUTE ON FUNCTION place_order_impl(UUID, UUID, TEXT, TEXT, JSONB, JSONB, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION place_order(
  p_client_uuid   UUID,
  p_staff_id      UUID,
  p_order_type    TEXT,
  p_customer_name TEXT,
  p_items         JSONB,
  p_discount      JSONB       DEFAULT NULL,
  p_table_label   TEXT        DEFAULT NULL,
  p_placed_at     TIMESTAMPTZ DEFAULT NULL,
  p_staff_session UUID        DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_staff_session(p_staff_session);
  RETURN place_order_impl(p_client_uuid, p_staff_id, p_order_type, p_customer_name,
                          p_items, p_discount, p_table_label, p_placed_at);
END $$;

REVOKE EXECUTE ON FUNCTION place_order(UUID, UUID, TEXT, TEXT, JSONB, JSONB, TEXT, TIMESTAMPTZ, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION place_order(UUID, UUID, TEXT, TEXT, JSONB, JSONB, TEXT, TIMESTAMPTZ, UUID)
  TO authenticated;

-- ── pay_order (обёртка 068 остаётся: session → cash-limit → unchecked) ──
ALTER FUNCTION pay_order(UUID, JSONB, INTEGER, UUID, TIMESTAMPTZ)
  RENAME TO pay_order_impl;
REVOKE EXECUTE ON FUNCTION pay_order_impl(UUID, JSONB, INTEGER, UUID, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION pay_order(
  p_order_id      UUID,
  p_payments      JSONB,
  p_tip           INTEGER     DEFAULT 0,
  p_payment_uuid  UUID        DEFAULT NULL,
  p_paid_at       TIMESTAMPTZ DEFAULT NULL,
  p_staff_session UUID        DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_staff_session(p_staff_session);
  RETURN pay_order_impl(p_order_id, p_payments, p_tip, p_payment_uuid, p_paid_at);
END $$;

REVOKE EXECUTE ON FUNCTION pay_order(UUID, JSONB, INTEGER, UUID, TIMESTAMPTZ, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pay_order(UUID, JSONB, INTEGER, UUID, TIMESTAMPTZ, UUID)
  TO authenticated;

-- ── open_or_get_table_order ─────────────────────────────────
ALTER FUNCTION open_or_get_table_order(UUID, UUID, UUID, TIMESTAMPTZ)
  RENAME TO open_or_get_table_order_impl;
REVOKE EXECUTE ON FUNCTION open_or_get_table_order_impl(UUID, UUID, UUID, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION open_or_get_table_order(
  p_table_id      UUID,
  p_staff_id      UUID,
  p_client_uuid   UUID        DEFAULT NULL,
  p_opened_at     TIMESTAMPTZ DEFAULT NULL,
  p_staff_session UUID        DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_staff_session(p_staff_session);
  RETURN open_or_get_table_order_impl(p_table_id, p_staff_id, p_client_uuid, p_opened_at);
END $$;

REVOKE EXECUTE ON FUNCTION open_or_get_table_order(UUID, UUID, UUID, TIMESTAMPTZ, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION open_or_get_table_order(UUID, UUID, UUID, TIMESTAMPTZ, UUID)
  TO authenticated;

-- ── append_to_order ─────────────────────────────────────────
ALTER FUNCTION append_to_order(UUID, UUID, JSONB, UUID)
  RENAME TO append_to_order_impl;
REVOKE EXECUTE ON FUNCTION append_to_order_impl(UUID, UUID, JSONB, UUID)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION append_to_order(
  p_order_id      UUID,
  p_staff_id      UUID,
  p_items         JSONB,
  p_op_uuid       UUID DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_staff_session(p_staff_session);
  RETURN append_to_order_impl(p_order_id, p_staff_id, p_items, p_op_uuid);
END $$;

REVOKE EXECUTE ON FUNCTION append_to_order(UUID, UUID, JSONB, UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION append_to_order(UUID, UUID, JSONB, UUID, UUID)
  TO authenticated;

-- ── Экран бариста: один тап = готово, сессия лишь подтверждается ──
ALTER FUNCTION mark_item_ready(UUID, BOOLEAN)
  RENAME TO mark_item_ready_impl;
REVOKE EXECUTE ON FUNCTION mark_item_ready_impl(UUID, BOOLEAN)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION mark_item_ready(
  p_item_id       UUID,
  p_ready         BOOLEAN DEFAULT TRUE,
  p_staff_session UUID    DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_staff_session(p_staff_session);
  RETURN mark_item_ready_impl(p_item_id, p_ready);
END $$;

REVOKE EXECUTE ON FUNCTION mark_item_ready(UUID, BOOLEAN, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mark_item_ready(UUID, BOOLEAN, UUID) TO authenticated;

ALTER FUNCTION mark_order_ready(UUID)
  RENAME TO mark_order_ready_impl;
REVOKE EXECUTE ON FUNCTION mark_order_ready_impl(UUID)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION mark_order_ready(
  p_order_id      UUID,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_staff_session(p_staff_session);
  RETURN mark_order_ready_impl(p_order_id);
END $$;

REVOKE EXECUTE ON FUNCTION mark_order_ready(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mark_order_ready(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION require_staff_session(UUID) IS
  'Валидация staff-сессии горячего потока (086, мягкий режим): NULL — пропуск, битый токен — исключение, валидный — скользящее продление.';
