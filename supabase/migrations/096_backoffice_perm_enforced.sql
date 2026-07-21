-- ============================================================
-- 096 ВЕБ-КОНТУР ПРОВЕРЯЕТ ПРАВА — закрытие находки аудита.
--
-- До 096 require_backoffice_or_staff (091) принимала p_perm, но в ветке
-- веб-ролей его НЕ читала: членство в organization_members с ролью
-- owner/manager возвращало staff_id сразу. p_perm проверялся только во
-- второй ветке — кассовой, через require_staff_perm.
--
-- Следствие: locations.settings.perms были правилами ТОЛЬКО кассы. Владелец,
-- пометивший возвраты как manager-only, за кассой получал ограничение, а тот
-- же человек через веб-кабинет — нет. Один сотрудник имел разный объём прав в
-- зависимости от входа, и настройка молча не действовала там, где её разумно
-- считать действующей.
--
-- ── Что меняется ────────────────────────────────────────────
-- Веб-роль теперь отображается на уровень права так же, как кассовая:
--   * owner   — выше ограничений, всегда (см. ниже, это НЕ послабление);
--   * manager — как кассовый manager: проходит 'all' и 'manager'-уровни;
--   * accountant — только 'all'-уровни; на 'manage' и прочие
--     manager-операции не допускается (роль читающая по замыслу 088).
--
-- ── Почему owner остаётся неограниченным ────────────────────
-- Ровно та же причина, что в 094 для кастомных ролей: perms живут в
-- locations.settings, а меняет их сам владелец через бэкофис по праву
-- 'manage'. Подчинив owner этим настройкам, мы получаем состояние, в котором
-- владелец запирает сам себя (выставил manage='manager', потерял связь с
-- staff-строкой manager) и восстановить доступ из продукта нечем. Это не
-- гипотеза: staff_id в organization_members опционален (091), т.е. у владельца
-- может вообще не быть роли сотрудника.
--
-- ── Совместимость ───────────────────────────────────────────
-- На момент миграции в проде ровно один активный член бэкофиса — owner,
-- веб-manager'ов нет. То есть сегодня правило никому не меняет доступ;
-- оно фиксирует поведение до появления второго веб-сотрудника, когда цена
-- ошибки уже была бы реальной.
--
-- ⚠️ ТРЕБУЕТ 091 (гейт), 094 (уровни прав), 095 (скоуп сессии).
-- ============================================================

-- ── Уровень права для веб-роли ──────────────────────────────
-- Зеркало фолбэк-логики require_staff_perm, но точку взять неоткуда:
-- organization_members скоупится ОРГАНИЗАЦИЕЙ (колонки location_id там нет),
-- а в JWT веб-пользователя auth_location_id() пуст. Поэтому:
--   * если членство связано со staff-строкой — берём её точку (тот же
--     человек, тот же набор настроек, что и за кассой);
--   * если связи нет (staff_id NULL, допустимо по 091) — точки нет, и
--     единственный честный ответ — БАЗОВЫЙ уровень. Настройку конкретной
--     точки в этом случае не угадываем: молча выбрать «какую-нибудь» точку
--     организации значило бы применять чужие правила.
CREATE OR REPLACE FUNCTION backoffice_perm_level(p_perm TEXT, p_staff_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT l.settings #>> ARRAY['perms', p_perm]
     FROM staff s
     JOIN locations l ON l.id = s.location_id
     WHERE s.id = p_staff_id AND s.org_id = auth_org_id()),
    CASE p_perm WHEN 'refund' THEN 'manager' WHEN 'manage' THEN 'manager'
                WHEN 'stock_take' THEN 'manager' ELSE 'all' END
  );
$$;

REVOKE EXECUTE ON FUNCTION backoffice_perm_level FROM anon, public;

-- ── require_backoffice_or_staff: + проверка права ───────────
-- Тело 091 сохранено (членство, автор операции = staff_id, фолбэк на
-- кассовый путь). Добавлена ТОЛЬКО проверка уровня для не-owner веб-ролей.
CREATE OR REPLACE FUNCTION require_backoffice_or_staff(p_session UUID, p_perm TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role    TEXT := auth_backoffice_role();
  v_member  organization_members%ROWTYPE;
  v_level   TEXT;
BEGIN
  IF v_role IN ('owner', 'manager', 'accountant') THEN
    SELECT * INTO v_member
    FROM organization_members
    WHERE auth_user_id = auth.uid()
      AND org_id = auth_org_id()
      AND is_active
    LIMIT 1;

    -- Владелец не ограничивается настройками, которые сам же и правит:
    -- иначе запрёт себя без пути восстановления (см. шапку).
    IF v_role = 'owner' THEN
      RETURN v_member.staff_id;
    END IF;

    -- НОВОЕ (096): веб-роль подчиняется тем же уровням, что кассовая.
    -- Точка — из связанной staff-строки; без связи действует базовый уровень.
    v_level := backoffice_perm_level(p_perm, v_member.staff_id);

    IF v_level = 'manager' AND v_role <> 'manager' THEN
      RAISE EXCEPTION 'forbidden: %', p_perm;
    END IF;

    RETURN v_member.staff_id;
  END IF;

  -- Иначе прежний путь: PIN-сессия сотрудника (строгий режим 090/095).
  RETURN require_staff_perm(p_session, p_perm);
END $$;

REVOKE EXECUTE ON FUNCTION require_backoffice_or_staff FROM anon, public;
GRANT EXECUTE ON FUNCTION require_backoffice_or_staff(UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION require_backoffice_or_staff IS
  'Единый гейт записи (091, ужесточён 096): веб-роли проверяются по уровню права, owner — исключение.';
