-- ============================================================
-- 148 ОПЛАТА ЗАКРЫВАЕТ УЖЕ ПРИГОТОВЛЕННЫЙ ЗАКАЗ
--
-- МОТИВ. Счёт стола готовят ДО оплаты (013): позиции появляются в
-- очереди сразу, заказ живёт в статусе 'open', пока гость сидит.
-- Бариста отмечает всё готовым — и переход paid → fulfilled внутри
-- `mark_item_ready` (010/015) НЕ срабатывает: он написан как
-- `... WHERE id = ... AND status = 'paid'`, а заказ в этот момент
-- ещё 'open'. Заказ уходит с экрана бариста только потому, что
-- клиент прячет open-заказы без pending-позиций.
--
-- Потом гость платит. `pay_order` ставит 'paid' безусловно, а очередь
-- показывает ЛЮБОЙ 'paid'-заказ — и выданный полчаса назад заказ
-- возвращается на кухню с уже проставленными галочками. Вывести его
-- оттуда может только новый переход paid → fulfilled, то есть повторный
-- тап бариста по тому, что давно съедено.
--
-- Раздельная оплата по позициям (021) удваивает эффект: часть и
-- остаток — два заказа с одним `daily_number`, и после оплаты на
-- экране появляются две одинаковые карточки одного стола.
--
-- ЧТО ЗДЕСЬ. Оплата закрывает заказ, если среди активных позиций нет
-- ни одной 'pending' — готовить нечего, значит заказ выдан. Если
-- готовить ещё есть что (обычная продажа у стойки), заказ остаётся
-- 'paid' и уходит из очереди прежним путём, по mark_item_ready /
-- mark_order_ready.
--
-- Деньги не трогаются: платежи, чек и фискальный номер пишет прежняя
-- реализация, здесь меняется только состояние ВЫДАЧИ.
--
-- Разовый backfill приводит к тому же правилу заказы, уже застрявшие
-- в 'paid' с полностью готовыми позициями, — иначе они остались бы
-- висеть на экране бариста и после этой миграции.
--
-- ⚠️ ТРЕБУЕТ 105 (обёртка pay_order с capability и staff-сессией).
-- ============================================================

CREATE OR REPLACE FUNCTION pay_order(
  p_order_id      UUID,
  p_payments      JSONB,
  p_tip           INTEGER     DEFAULT 0,
  p_payment_uuid  UUID        DEFAULT NULL,
  p_paid_at       TIMESTAMPTZ DEFAULT NULL,
  p_staff_session UUID        DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_result JSON;
BEGIN
  PERFORM require_org_capability('pos_operate');
  PERFORM require_staff_session(p_staff_session);
  v_result := pay_order_impl(p_order_id, p_payments, p_tip, p_payment_uuid, p_paid_at);

  -- Готовить нечего → заказ выдан, а не «оплачен и ждёт кухню».
  -- Идемпотентно: на replay офлайн-очереди заказ уже 'fulfilled' и
  -- условие status = 'paid' не выполняется.
  UPDATE orders o
  SET status = 'fulfilled', fulfilled_at = COALESCE(p_paid_at, NOW())
  WHERE o.id = p_order_id
    AND o.org_id = auth_org_id()
    AND o.status = 'paid'
    -- Заказ без активных позиций не «приготовлен»: закрывать нечего
    AND EXISTS (
      SELECT 1 FROM order_items i
      WHERE i.order_id = o.id AND i.voided_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM order_items i
      WHERE i.order_id = o.id AND i.voided_at IS NULL AND i.prep_status = 'pending'
    );

  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION pay_order(UUID, JSONB, INTEGER, UUID, TIMESTAMPTZ, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pay_order(UUID, JSONB, INTEGER, UUID, TIMESTAMPTZ, UUID)
  TO authenticated;

COMMENT ON FUNCTION pay_order(UUID, JSONB, INTEGER, UUID, TIMESTAMPTZ, UUID) IS
  'Оплата заказа: capability + staff-сессия, cash guard 068, закрытие заказа, в котором готовить нечего (148).';

-- ── Разовый backfill: снять с очереди то, что уже застряло ───
-- Только состояние выдачи: суммы, платежи и номера документов не трогаем.
UPDATE orders o
SET status = 'fulfilled', fulfilled_at = COALESCE(o.fulfilled_at, o.paid_at, NOW())
WHERE o.status = 'paid'
  AND EXISTS (
    SELECT 1 FROM order_items i
    WHERE i.order_id = o.id AND i.voided_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM order_items i
    WHERE i.order_id = o.id AND i.voided_at IS NULL AND i.prep_status = 'pending'
  );
