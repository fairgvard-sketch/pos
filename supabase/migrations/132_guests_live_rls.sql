-- ============================================================
-- 132. Объединённый и стёртый профиль не видны клиенту — на уровне RLS.
--
-- Смоук 131 на живой точке: в кабинете дубль объединился, а касса
-- продолжила показывать ДВЕ строки «Codex Test» и находить старый номер.
-- Причина — терминал работал на прежней сборке: фильтр `merged_into`
-- жил только в клиентском запросе (`searchGuests`), а обновление
-- WebView/PWA на кассе происходит не в момент деплоя.
--
-- Клиентский фильтр — не защита. Ровно то же правило записано в
-- инвариантах проекта про role guards: скрывать должен сервер. Поэтому
-- политика SELECT на `guests` сужается до ЖИВЫХ профилей: любая версия
-- кассы — хоть сегодняшняя, хоть полугодовой давности — перестаёт
-- видеть объединённые и стёртые записи в ту же секунду, когда владелец
-- нажал «Merge» или «Erase».
--
-- Что при этом НЕ ломается:
--   * слияние, стирание, начисление баллов и узнавание по телефону идут
--     через SECURITY DEFINER (владелец функции RLS не подчиняется);
--   * `get_backoffice_guests` и `find_guest_duplicates_web` (INVOKER)
--     и так исключали такие строки явным условием;
--   * заказы, чеки и брони на месте: скрыт профиль, а не история.
--
-- Политика FOR ALL заменяется парой SELECT/INSERT: добавить строгую
-- политику рядом со старой нельзя — политики одной команды
-- складываются по ИЛИ, и широкая продолжила бы пускать. UPDATE/DELETE
-- политик нет намеренно: колоночные гранты на правку отозваны 131,
-- профиль правится только через set_guest_profile.
--
-- ⚠️ ТРЕБУЕТ 031 (guests_all), 131 (merged_into, anonymized_at).
-- ============================================================

DROP POLICY IF EXISTS guests_all ON guests;

CREATE POLICY guests_select ON guests
  FOR SELECT TO authenticated
  USING (
    org_id = auth_org_id()
    AND merged_into IS NULL
    AND anonymized_at IS NULL
  );

-- Гостя по-прежнему заводит касса прямой вставкой (031): колоночный
-- грант INSERT (org_id, phone, name) остаётся, и новая строка сразу
-- видна — она живая по определению.
CREATE POLICY guests_insert ON guests
  FOR INSERT TO authenticated
  WITH CHECK (org_id = auth_org_id());

COMMENT ON POLICY guests_select ON guests IS
  'Клиент видит только живые профили (132): объединённые и стёртые скрыты сервером, а не фильтром в запросе кассы.';

-- ============================================================
-- ОТКАТ
--
-- Forward-only. Возврат к прежнему поведению — новой миграцией:
--   DROP POLICY guests_select ON guests;
--   DROP POLICY guests_insert ON guests;
--   CREATE POLICY guests_all ON guests FOR ALL TO authenticated
--     USING (org_id = auth_org_id()) WITH CHECK (org_id = auth_org_id());
--
-- ПРОВЕРКА: под ролью authenticated с JWT своей организации
--   SELECT count(*) FROM guests;                    -- только живые
--   SELECT count(*) FROM guests WHERE merged_into IS NOT NULL;  -- 0
-- ============================================================
