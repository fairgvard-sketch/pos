-- ============================================================
-- 045 STAFF SESSIONS STRICT — включение строгого режима.
--
-- ⚠️ ПРИМЕНЯТЬ ТОЛЬКО КОГДА:
--   1) все кассы обновлены до клиента, передающего p_staff_session
--      (деплой Vercel после 044 + перезагрузка касс);
--   2) офлайн-очередь на всех кассах пуста (Настройки → Оплата →
--      журнал офлайн-операций) — хвост, поставленный старым клиентом,
--      не несёт токена и упрётся в строгую проверку.
--
-- Делает две вещи:
--   * require_staff_perm: вызов привилегированного RPC БЕЗ токена
--     сессии → ошибка (в 044 пропускался — мягкий режим);
--   * закрывает прямые записи клиента в locations (настройки, права,
--     ставка НДС, реквизиты) и staff (роль!) — теперь только через
--     update_location_config / update_staff с manager-сессией.
--     До этого любой клиент с anon-ключом и JWT устройства мог
--     переписать locations.settings.perms или назначить себе owner.
-- ============================================================

-- ── Строгий require_staff_perm (тело 044, ветка NULL → RAISE) ─
CREATE OR REPLACE FUNCTION require_staff_perm(p_session UUID, p_perm TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_staff staff%ROWTYPE;
  v_level TEXT;
BEGIN
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

  v_level := COALESCE(
    (SELECT l.settings #>> ARRAY['perms', p_perm] FROM locations l WHERE l.id = auth_location_id()),
    CASE p_perm WHEN 'refund' THEN 'manager' WHEN 'manage' THEN 'manager' ELSE 'all' END
  );

  IF v_level = 'manager' AND v_staff.role NOT IN ('manager', 'owner') THEN
    RAISE EXCEPTION 'forbidden: %', p_perm;
  END IF;

  RETURN v_staff.id;
END $$;

-- ── locations: только чтение напрямую, запись через RPC ──────
DROP POLICY IF EXISTS locations_all ON locations;
CREATE POLICY locations_select ON locations FOR SELECT TO authenticated
  USING (org_id = auth_org_id());
REVOKE INSERT, UPDATE, DELETE ON locations FROM authenticated;

-- ── staff: правки карточки (включая роль) — только update_staff ─
DROP POLICY IF EXISTS staff_update ON staff;
REVOKE UPDATE ON staff FROM authenticated;
