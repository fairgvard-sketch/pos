-- ============================================================
-- 040 DELETE STAFF — умное удаление сотрудника.
--
-- Удалить сотрудника можно ТОЛЬКО если он никогда ничего не пробивал:
-- нет ни заказов, ни платежей, ни возвратов, ни смен, ни отметок
-- табеля, ни движений наличных, ни void'ов. Это защита аудита
-- (инвариант №2: авторство финансовых записей священно; FK на
-- staff(id) стоят как RESTRICT — БД и так не даст удалить).
--
-- Если записи есть — сотрудника НЕ удаляем, а возвращаем понятную
-- ошибку 'staff has records'; на клиенте предлагаем деактивацию
-- (is_active=false, verify_staff_pin такого не пустит).
--
-- SECURITY DEFINER + REVOKE как у create_staff/set_staff_pin:
-- staff под колоночными грантами, прямой DELETE клиенту закрыт.
-- ============================================================

CREATE OR REPLACE FUNCTION delete_staff(p_staff_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

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
