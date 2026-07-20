-- ============================================================
-- 090 STAFF PERM STRICT RESTORE — возврат строгого режима.
--
-- Регресс: 045 включила строгий режим (вызов привилегированного RPC без
-- токена сессии → RAISE). Затем 055 переопределила require_staff_perm,
-- взяв за основу тело 044 (мягкое) — ей нужно было лишь добавить
-- 'stock_take' в фолбэк-CASE. Строгая ветка молча откатилась и с тех пор
-- не действовала, в том числе на production.
--
-- Следствие до 090: гейт держал только ПЕРЕДАННЫЙ битый токен, а вызов
-- без токена проходил. Возвраты, скидки, отмены, закрытие смены, склад,
-- настройки и управление сотрудниками защищал только клиент.
--
-- Это тело 055 (фолбэк со 'stock_take' сохранён) + ветка NULL из 045.
-- Единственное изменение против живой функции — RETURN NULL → RAISE.
--
-- ── Почему применять безопасно ──────────────────────────────
-- 1) Парк: 11 активных устройств, все на app_version 1.1.0 — клиент
--    передаёт p_staff_session во всех 16 модулях, включая replay.
-- 2) Офлайн-очередь: drain.ts помечает привилегированную операцию
--    blocked_auth и НЕ отправляет её без PIN-сессии (OPS_NEED_STAFF_TOKEN:
--    table.void, table.discount, table.void_item), а ответ сервера
--    'staff session required' распознаётся как не-доменная ошибка и не
--    роняет FIFO. То есть хвост очереди упрётся в паузу, а не в failed.
-- 3) Горячий поток (place/pay/open/append/queue) проверяет ДРУГУЮ функцию
--    require_staff_session и остаётся в мягком режиме — продажа и оплата
--    этой миграцией не затрагиваются.
--
-- ⚠️ Строгий режим означает: сотрудник ДОЛЖЕН быть в PIN-сессии, иначе
-- привилегированное действие отклоняется сервером. Это и есть цель.
-- ============================================================

CREATE OR REPLACE FUNCTION require_staff_perm(p_session UUID, p_perm TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_staff staff%ROWTYPE;
  v_level TEXT;
BEGIN
  -- СТРОГИЙ режим (045, восстановлен 090): без токена — отказ.
  IF p_session IS NULL THEN
    RAISE EXCEPTION 'staff session required';
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

  -- Фолбэк-уровни из 055: stock_take тоже менеджерский
  v_level := COALESCE(
    (SELECT l.settings #>> ARRAY['perms', p_perm] FROM locations l WHERE l.id = auth_location_id()),
    CASE p_perm WHEN 'refund' THEN 'manager' WHEN 'manage' THEN 'manager'
                WHEN 'stock_take' THEN 'manager' ELSE 'all' END
  );

  IF v_level = 'manager' AND v_staff.role NOT IN ('manager', 'owner') THEN
    RAISE EXCEPTION 'forbidden: %', p_perm;
  END IF;

  RETURN v_staff.id;
END $$;

REVOKE EXECUTE ON FUNCTION require_staff_perm FROM anon, public;
