-- ============================================================
-- 154: история визита — записанные переходы, а не догадки
--
-- ЗАЧЕМ.
--
-- У брони была ОДНА колонка на все решения: `decided_at` (053). Её
-- перезаписывает и подтверждение, и отказ, и завершение, и неявка.
-- Поэтому вопрос «когда эту бронь подтвердили» ответа не имел: в
-- колонке лежал момент ПОСЛЕДНЕГО решения, и назвать его
-- подтверждением означало бы выдать догадку за факт.
--
-- `activity_events` (098) здесь не помогает: она знает только смены и
-- возвраты, про брони в ней нет ничего.
--
-- Спор «мы подтвердили в четверг» / «мне никто не звонил» разрешается
-- записью или не разрешается вовсе.
--
-- ЧТО ЗАПИСЫВАЕТСЯ, А ЧТО НЕТ.
--
-- Только то, что произошло ПОСЛЕ этой миграции. История старых броней
-- не достраивается задним числом: восстановить из одного `decided_at`,
-- что именно и когда случилось, нельзя, а правдоподобная реконструкция
-- — это ложь, на которую потом сошлются в споре с гостем.
--
-- Пишет ТРИГГЕР, а не тело RPC. Бронь меняют шесть функций (кассовые
-- 119, веб-зеркала 120/127, гостевые 118, лист ожидания 122), и запись
-- события в каждой означала бы, что рано или поздно её где-то забудут.
--
-- Таблица append-only: UPDATE и DELETE отозваны у всех клиентских
-- ролей. История, которую можно переписать, историей не является.
--
-- ⚠️ ТРЕБУЕТ 053 (reservations), 088 (organization_members),
--    152 (get_visit_web).
-- ============================================================

CREATE TABLE IF NOT EXISTS reservation_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id    UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN (
                   'confirmed', 'rejected', 'cancelled', 'completed',
                   'no_show', 'seated', 'moved', 'tables')),
  at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Кто именно. Кабинет и касса — разные контуры, поэтому обе ссылки
  -- отдельные (та же модель, что у `decided_by` / `decided_by_member`).
  actor_member   UUID REFERENCES organization_members(id),
  actor_staff    UUID REFERENCES staff(id),
  -- Подробность перехода: прежнее время у переноса, причина у отказа.
  -- Персональных данных гостя здесь нет — они в самой брони.
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_reservation_events_visit
  ON reservation_events(reservation_id, at);

COMMENT ON TABLE reservation_events IS
  'Append-only переходы визита (154). Пишется триггером; события до 154 отсутствуют намеренно — восстановить их из одного decided_at нельзя.';

ALTER TABLE reservation_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY reservation_events_select ON reservation_events
  FOR SELECT TO authenticated USING (org_id = auth_org_id());

-- Читать — своей организации (RLS выше), писать может только триггер
-- (SECURITY DEFINER от владельца схемы).
GRANT SELECT ON reservation_events TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON reservation_events FROM authenticated;
REVOKE ALL ON reservation_events FROM anon;

/**
 * Переходы визита → события.
 *
 * Считается ИЗ РАЗНИЦЫ строк, а не из намерения вызывающего: любая из
 * шести функций, меняющих бронь, попадает сюда одинаково.
 *
 * Одно обновление может дать несколько событий (сменили время И столы),
 * и это правильно: они действительно произошли оба.
 */
CREATE OR REPLACE FUNCTION _log_reservation_event()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := NEW.decided_by_member;
  v_staff  UUID := NEW.decided_by;
BEGIN
  -- Статус: переход называется своим именем, а не «решение принято»
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('confirmed', 'rejected', 'cancelled', 'completed', 'no_show') THEN
    INSERT INTO reservation_events (
      org_id, location_id, reservation_id, type, actor_member, actor_staff, detail
    ) VALUES (
      NEW.org_id, NEW.location_id, NEW.id, NEW.status, v_member, v_staff,
      CASE WHEN NEW.reject_reason IS NOT NULL AND NEW.reject_reason IS DISTINCT FROM OLD.reject_reason
           THEN jsonb_build_object('reason', NEW.reject_reason)
           ELSE '{}'::jsonb END
    );
  END IF;

  -- Посадка: отдельного статуса у неё нет (119), отметка — момент
  IF NEW.arrived_at IS NOT NULL AND OLD.arrived_at IS NULL THEN
    INSERT INTO reservation_events (
      org_id, location_id, reservation_id, type, actor_member, actor_staff
    ) VALUES (NEW.org_id, NEW.location_id, NEW.id, 'seated', v_member, v_staff);
  END IF;

  -- Перенос: прежнее время — часть факта, иначе «перенесена» ничего не
  -- говорит тому, кто разбирает спор
  IF NEW.reserved_at IS DISTINCT FROM OLD.reserved_at THEN
    INSERT INTO reservation_events (
      org_id, location_id, reservation_id, type, actor_member, actor_staff, detail
    ) VALUES (
      NEW.org_id, NEW.location_id, NEW.id, 'moved', v_member, v_staff,
      jsonb_build_object('from', OLD.reserved_at, 'to', NEW.reserved_at)
    );
  END IF;

  -- Пересадка за другой стол
  IF NEW.table_id IS DISTINCT FROM OLD.table_id
     OR COALESCE(NEW.hold_table_ids, '{}') IS DISTINCT FROM COALESCE(OLD.hold_table_ids, '{}') THEN
    INSERT INTO reservation_events (
      org_id, location_id, reservation_id, type, actor_member, actor_staff
    ) VALUES (NEW.org_id, NEW.location_id, NEW.id, 'tables', v_member, v_staff);
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_log_reservation_event ON reservations;
CREATE TRIGGER trg_log_reservation_event
  AFTER UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION _log_reservation_event();

-- ── Карточка визита отдаёт историю ───────────────────────────
/**
 * Тело 152 плюс блок `events`.
 *
 * Имя автора резолвится здесь, а не на клиенте: кабинет не имеет права
 * читать `staff` целиком, а без имени событие отвечает «когда», но не
 * «кто» — и половина споров остаётся неразрешённой.
 */
CREATE OR REPLACE FUNCTION get_visit_web(
  p_location_id UUID,
  p_id          UUID
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := _reservation_web_member(p_location_id);
  v_org    UUID := auth_org_id();
  v_r      reservations%ROWTYPE;
  v_guest  guests%ROWTYPE;
  v_out    JSONB;
BEGIN
  SELECT * INTO v_r FROM reservations
  WHERE id = p_id AND org_id = v_org AND location_id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF v_r.guest_id IS NOT NULL THEN
    SELECT * INTO v_guest FROM guests WHERE id = v_r.guest_id AND org_id = v_org;
  END IF;

  v_out := jsonb_build_object(
    'id',       v_r.id,
    'order',    _visit_order_summary(v_r.order_id),
    'tables', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', t.id, 'label', t.label, 'seats', COALESCE(t.seats, 2),
               'zone_name', z.name, 'is_primary', rt.is_primary)
             ORDER BY rt.is_primary DESC, t.label)
      FROM reservation_tables rt
      JOIN tables t ON t.id = rt.table_id
      LEFT JOIN table_zones z ON z.id = t.zone_id
      WHERE rt.reservation_id = v_r.id
    ), '[]'::jsonb),
    'events', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'type', e.type,
               'at',   e.at,
               'detail', e.detail,
               -- Кабинет показывает имя, а не uuid. У кассового
               -- перехода это имя сотрудника, у веб — имя члена
               -- организации; пусто, если ни того, ни другого.
               'actor_name', COALESCE(m.display_name, s.name))
             ORDER BY e.at)
      FROM reservation_events e
      LEFT JOIN organization_members m ON m.id = e.actor_member
      LEFT JOIN staff s ON s.id = e.actor_staff
      WHERE e.reservation_id = v_r.id
    ), '[]'::jsonb),
    'guest', CASE WHEN v_guest.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id',            v_guest.id,
      'name',          v_guest.name,
      'phone',         v_guest.phone,
      -- Внутреннее (121): наружу этот путь не ведёт — функция закрыта
      -- членством owner/manager и capability `reservations_desk`.
      'notes',         v_guest.notes,
      'tags',          COALESCE(to_jsonb(v_guest.tags), '[]'::jsonb),
      -- Денежная часть есть только там, где есть касса. У standalone
      -- Reserve она нулевая, и показывать её нельзя: пустая «средняя
      -- сумма чека» выглядит как гость, который ничего не тратит.
      'loyalty_visits', v_guest.visits,
      'total_spent',    v_guest.total_spent,
      'last_visit_at',  v_guest.last_visit_at,
      'anonymized',     v_guest.anonymized_at IS NOT NULL,
      'stats',          guest_reservation_stats(v_guest.id)) END
  );

  RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION get_visit_web(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_visit_web(UUID, UUID) TO authenticated, service_role;

-- ============================================================
-- ОТКАТ
--
-- Forward-only. Функциональный откат — снять триггер:
--
--   DROP TRIGGER IF EXISTS trg_log_reservation_event ON reservations;
--
-- Таблицу при этом НЕ удалять: уже записанные переходы — история, а
-- удаление истории ради отката поведения несоразмерно. Карточка визита
-- продолжит работать, блок `events` просто перестанет пополняться.
--
-- ПРОВЕРКА под веб-владельцем:
--   SELECT set_reservation_status_web('<loc>', '<res>', 'confirmed');
--   SELECT get_visit_web('<loc>', '<res>') -> 'events';
-- ============================================================
