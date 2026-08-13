-- ============================================================
-- 160: стирание накрывает то, что появилось после 131
--
-- ЗАЧЕМ.
--
-- `anonymize_guest_web` (131) стирает имя, телефон, заметку, метки,
-- контакты в бронях, листе ожидания и очереди уведомлений. С тех пор
-- появились две новые записи о госте, и обе остались нетронутыми:
--
--   * `reservation_events.detail` (154) хранит причину отказа и отмены.
--     Причину пишет сотрудник свободным текстом, и «перезвонить Мири
--     Леви по 052…» там оказывается регулярно;
--   * `notification_outbox.payload` чистился только от `guest_name`, а
--     телефон мог лежать и отдельным ключом.
--
-- Стирание, которое накрывает не всё, хуже отсутствующего: клиенту
-- сказали «удалили», а данные остались.
--
-- РАЗДЕЛЕНИЕ ПРАВ.
--
-- Стирание — единственное необратимое действие над клиентской базой, и
-- теперь оно доступно ТОЛЬКО владельцу. Слияние (обратимо по журналу
-- `guest_merges`), выгрузка и правка профиля остаются у owner и
-- manager. Раньше все четыре действия проверялись одним гейтом
-- `manage`, то есть менеджер мог необратимо стереть человека.
--
-- Кассовый путь к стиранию не ведёт и не вёл: функцию зовёт только
-- кабинет (`backoffice/src/guests.js`), а удаление персональных данных
-- с терминала у стойки — не операция смены.
--
-- ⚠️ ТРЕБУЕТ 131 (anonymize_guest_web), 154 (reservation_events).
-- ============================================================

CREATE OR REPLACE FUNCTION anonymize_guest_web(
  p_guest_id      UUID,
  p_confirm_phone TEXT,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_staff     UUID;
  v_guest     guests%ROWTYPE;
  v_confirm   TEXT;
  v_upcoming  INTEGER;
  v_rsv       INTEGER := 0;
  v_wait      INTEGER := 0;
  v_notif     INTEGER := 0;
  v_events    INTEGER := 0;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  /*
   * Необратимое действие — только владелец.
   *
   * `require_backoffice_or_staff` пропускал и менеджера, и PIN-сессию с
   * правом `manage`. Для правки профиля это верно, для стирания — нет:
   * отменить его нельзя ничем.
   */
  IF auth_backoffice_role() IS NOT NULL THEN
    IF auth_backoffice_role() <> 'owner' THEN
      RAISE EXCEPTION 'owner_only';
    END IF;
    v_staff := NULL;
  ELSE
    RAISE EXCEPTION 'owner_only';
  END IF;

  SELECT * INTO v_guest FROM guests WHERE id = p_guest_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'guest not found';
  END IF;
  IF v_guest.anonymized_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_anonymized';
  END IF;
  IF v_guest.merged_into IS NOT NULL THEN
    -- У указателя нет своей истории: стирать надо объединённый профиль
    RAISE EXCEPTION 'guest_merged';
  END IF;

  v_confirm := regexp_replace(COALESCE(p_confirm_phone, ''), '\D', '', 'g');
  IF v_confirm = '' OR v_confirm <> v_guest.phone THEN
    RAISE EXCEPTION 'confirm_mismatch';
  END IF;

  -- Будущий визит без контактов — это подстава для хостес: сначала
  -- отмените бронь, потом стирайте.
  SELECT COUNT(*) INTO v_upcoming FROM reservations
  WHERE org_id = v_org
    AND (guest_id = p_guest_id OR customer_phone = v_guest.phone)
    AND status IN ('new', 'confirmed')
    AND reserved_at > NOW();
  IF v_upcoming > 0 THEN
    RAISE EXCEPTION 'has_upcoming_reservation';
  END IF;

  /*
   * История переходов (154). Сам факт «бронь отменили в четверг» —
   * запись о работе заведения и остаётся; свободный текст причины
   * убираем, потому что сотрудник регулярно пишет туда имя и телефон.
   */
  WITH scrubbed AS (
    UPDATE reservation_events e
    SET detail = e.detail - 'reason'
    WHERE e.org_id = v_org
      AND e.detail ? 'reason'
      AND e.reservation_id IN (
        SELECT id FROM reservations
        WHERE org_id = v_org
          AND (guest_id = p_guest_id OR customer_phone = v_guest.phone))
    RETURNING e.id
  ) SELECT COUNT(*) INTO v_events FROM scrubbed;

  -- Брони: контакты стираем, сам визит остаётся в истории точки.
  -- Ловим и по телефону — брони до 121 не имеют guest_id.
  WITH scrubbed AS (
    UPDATE reservations
    SET customer_name = '—', customer_phone = '', note = NULL
    WHERE org_id = v_org
      AND (guest_id = p_guest_id OR customer_phone = v_guest.phone)
    RETURNING id
  ) SELECT COUNT(*) INTO v_rsv FROM scrubbed;

  WITH scrubbed AS (
    UPDATE waitlist_entries
    SET customer_name = '—', customer_phone = '', note = NULL
    WHERE org_id = v_org
      AND (guest_id = p_guest_id OR customer_phone = v_guest.phone)
    RETURNING id
  ) SELECT COUNT(*) INTO v_wait FROM scrubbed;

  -- Очередь уведомлений: получатель и ЛЮБЫЕ личные ключи payload.
  -- Раньше убирался только `guest_name`, а телефон мог лежать рядом.
  WITH scrubbed AS (
    UPDATE notification_outbox
    SET recipient  = NULL,
        payload    = payload - 'guest_name' - 'guest_phone' - 'phone' - 'name',
        status     = CASE WHEN status = 'pending' THEN 'skipped' ELSE status END,
        last_error = CASE WHEN status = 'pending' THEN 'guest_anonymized' ELSE last_error END
    WHERE org_id = v_org AND recipient = v_guest.phone
    RETURNING id
  ) SELECT COUNT(*) INTO v_notif FROM scrubbed;

  PERFORM set_config('app.actor_staff', '', TRUE);

  -- Телефон нельзя просто очистить: он NOT NULL и уникален в
  -- организации. Ставим заведомо не-номер — по нему никого не найдут,
  -- а прежний ключ освобождается для нового человека.
  UPDATE guests SET
    name          = NULL,
    phone         = 'deleted:' || LEFT(md5(id::TEXT), 12),
    notes         = NULL,
    tags          = '{}',
    anonymized_at = NOW()
  WHERE id = p_guest_id;

  -- Аудит правок хранил СТАРЫЕ значения — то есть имя и телефон.
  -- Оставляем факт правки, убираем содержимое.
  UPDATE guest_audit
  SET old_value = NULL, new_value = NULL
  WHERE guest_id = p_guest_id;

  INSERT INTO guest_audit (org_id, guest_id, field, old_value, new_value, auth_user, staff_id)
  VALUES (v_org, p_guest_id, 'anonymize', NULL, NULL, auth.uid(), NULL);

  RETURN jsonb_build_object(
    'guest_id',      p_guest_id,
    'reservations',  v_rsv,
    'waitlist',      v_wait,
    'notifications', v_notif,
    'events',        v_events
  );
END $$;

REVOKE ALL ON FUNCTION anonymize_guest_web(UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION anonymize_guest_web(UUID, TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION anonymize_guest_web(UUID, TEXT, UUID) IS
  'Удаление личных данных гостя (131/160). Только владелец: действие необратимо. Накрывает брони, лист ожидания, очередь уведомлений, причины в истории визитов и аудит. Заказы и чеки остаются: документы учёта хранятся по закону.';

-- ============================================================
-- ОТКАТ
--
-- Forward-only, схема не менялась.
--
-- ⚠️ ИЗМЕНЕНИЕ ПРАВ: менеджер больше не может стирать клиента. Если
-- это окажется неверным для конкретного заведения, вернуть прежний
-- гейт новой миграцией — заменить блок owner_only на
-- `PERFORM require_backoffice_or_staff(p_staff_session, 'manage');`.
-- Редактировать эту миграцию нельзя.
--
-- ПРОВЕРКА под владельцем кабинета:
--   SELECT anonymize_guest_web('<guest>', '<его телефон>');
-- под менеджером ожидается отказ `owner_only`.
-- ============================================================
