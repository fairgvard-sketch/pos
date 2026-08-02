-- ============================================================
-- 135. Парк касс: окончательное удаление терминала
--
-- Архив (130) — классификация: терминал продолжает работать, строка
-- остаётся, действие обратимо. Владельцу нужно и другое: терминал
-- продан, потерян или заменён, и он не должен ни работать, ни
-- занимать место в списке.
--
-- Почему одного DELETE строки мало. `register_device` (065)
-- идемпотентна и создаёт строку заново по (org_id, device_uuid) под
-- ЛЮБОЙ живой сессией устройства. Удалили строку — касса при
-- следующем запуске зарегистрируется снова и вернётся в список. То
-- есть «удаление», которое не закрывает вход, — это ложь интерфейса.
--
-- Поэтому здесь два шага: строка парка удаляется, а учётка терминала
-- удаляется вместе с ней — но только если это действительно учётка
-- ТЕРМИНАЛА, а не человека:
--   • на ней не висит других устройств;
--   • она не является членством в бэкофисе (organization_members).
-- Иначе удаляется только строка парка, а вход остаётся — и функция
-- честно возвращает `access_revoked: false`.
--
-- Что НЕ удаляется никогда: заказы, смены, платежи, чеки и события
-- журнала. Финансовые записи не переписываются и не исчезают —
-- `activity_events.device_id` обнуляется каскадом (SET NULL, 133), и
-- событие остаётся с точкой и сотрудником, но без терминала.
--
-- Защита от потери денег: терминал с неотправленной очередью удалить
-- нельзя. Пока `outbox_pending > 0`, где-то лежат продажи, не дошедшие
-- до базы; удаление учётки закрыло бы им путь навсегда.
--
-- ⚠️ ТРЕБУЕТ 130 (_device_web_guard, archived_at).
-- ============================================================

/**
 * Окончательное удаление терминала.
 *
 * Возвращает JSON:
 *   deleted        — строка парка удалена;
 *   access_revoked — учётка терминала удалена (вход закрыт);
 *   reason         — почему вход НЕ закрыт, если это так.
 *
 * Ошибки (стабильные коды для интерфейса):
 *   not_found        — чужой или несуществующий терминал;
 *   outbox_pending   — есть неотправленные операции;
 *   not_archived     — удаление только из архива: сначала владелец
 *                      убирает кассу из работы и убеждается, что она
 *                      не нужна.
 */
CREATE OR REPLACE FUNCTION delete_device_web(
  p_device_id     UUID,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_dev      devices%ROWTYPE;
  v_auth     UUID;
  v_others   INTEGER := 0;
  v_member   INTEGER := 0;
  v_revoked  BOOLEAN := FALSE;
  v_reason   TEXT    := NULL;
BEGIN
  PERFORM _device_web_guard(p_staff_session);

  SELECT * INTO v_dev
  FROM devices
  WHERE id = p_device_id AND org_id = auth_org_id();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- Сначала архив, потом удаление: два шага вместо одного там, где
  -- ошибку нельзя отменить.
  IF v_dev.archived_at IS NULL THEN
    RAISE EXCEPTION 'not_archived';
  END IF;

  -- Неотправленные операции — это деньги, которые ещё в пути
  IF COALESCE(v_dev.outbox_pending, 0) > 0 THEN
    RAISE EXCEPTION 'outbox_pending';
  END IF;

  v_auth := v_dev.auth_user_id;

  DELETE FROM devices WHERE id = p_device_id;

  IF v_auth IS NULL THEN
    v_reason := 'no_account';
  ELSE
    SELECT COUNT(*) INTO v_others FROM devices WHERE auth_user_id = v_auth;
    SELECT COUNT(*) INTO v_member FROM organization_members WHERE auth_user_id = v_auth;

    IF v_others > 0 THEN
      -- Одна учётка на несколько касс: закрыв вход, мы выключили бы
      -- и работающие терминалы.
      v_reason := 'account_shared';
    ELSIF v_member > 0 THEN
      -- Это аккаунт человека (владелец/менеджер), а не терминала.
      v_reason := 'account_is_member';
    ELSE
      DELETE FROM auth.users WHERE id = v_auth;
      v_revoked := TRUE;
    END IF;
  END IF;

  RETURN json_build_object(
    'deleted', TRUE,
    'access_revoked', v_revoked,
    'reason', v_reason
  );
END $$;

REVOKE ALL ON FUNCTION delete_device_web(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION delete_device_web(UUID, UUID) TO authenticated, service_role;

COMMENT ON FUNCTION delete_device_web IS
  'Окончательное удаление терминала (135): строка парка + учётка терминала, только из архива и только с пустой очередью. Заказы, смены и события остаются.';

-- ============================================================
-- ОТКАТ
--
-- Forward-only. Функциональный откат — отозвать EXECUTE:
--   REVOKE EXECUTE ON FUNCTION delete_device_web(UUID, UUID) FROM authenticated;
-- Парк вернётся к «архив без удаления»; работающие кассы не
-- затрагиваются. Удалённые строки и учётки не восстанавливаются —
-- поэтому интерфейс обязан спрашивать подтверждение по имени.
--
-- ПРОВЕРКА (под веб-владельцем):
--   SELECT set_device_archived_web('<device>', TRUE);
--   SELECT delete_device_web('<device>');   -- {"deleted":true,"access_revoked":true}
--   SELECT COUNT(*) FROM devices WHERE id = '<device>';        -- 0
--   SELECT COUNT(*) FROM orders WHERE location_id = '<loc>';   -- не изменилось
-- ============================================================
