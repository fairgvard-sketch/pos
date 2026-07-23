-- ============================================================
-- 097 FLEET BACKOFFICE — раздел «Девайсы» для владельца в вебе.
--
-- Мотив: телеметрия парка (074) — версии, last_seen, здоровье offline-очереди —
-- существует, но выдана ТОЛЬКО service_role (ops_fleet — операторский view для
-- SQL Editor). Владелец в ANGLE back office своих касс не видит: в вебе есть
-- лишь счётчик devices (088). Когда у владельца больше одной кассы (несколько
-- стоек в точке или несколько точек), ему нужно отличать терминалы и замечать
-- «молчащий» или с зависшей очередью.
--
-- Решение по образцу sales_report (089): одна RPC get_backoffice_fleet().
--   * Гейт как везде в бэкофисе: владелец/менеджер проходит по членству (088),
--     иначе — прежний путь require_staff_perm(session, 'manage') для кассы.
--   * SECURITY INVOKER: тело читает devices ПОД RLS вызывающего. Политика
--     devices_select (065) скоупит по org_id = auth_org_id(), поэтому чужая
--     организация недостижима даже при ошибке в гейте — тот же инвариант, что
--     и у 089. Никаких новых GRANT на сами таблицы не выдаём.
--   * PII не отдаём: только эксплуатационные поля устройства. client_errors
--     (стек-трейсы) СЮДА НЕ ВХОДЯТ — они закрыты и для владельца (074), это
--     операторский канал.
--
-- Точка (location) в JWT веб-владельца отсутствует — возвращаем ВСЕ устройства
-- организации с именем их точки, чтобы фронт мог сгруппировать/отфильтровать
-- сам. Касса (staff-путь) тоже получает парк своей org — RLS не различает.
--
-- ⚠️ ТРЕБУЕТ 088 (auth_backoffice_role), 074 (heartbeat-колонки devices).
-- ============================================================

CREATE OR REPLACE FUNCTION get_backoffice_fleet(
  p_staff_session UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  -- Веб-владелец/менеджер подтверждён членством (088) — PIN не нужен.
  -- Иначе прежний путь: staff-сессия с правом 'manage' (строгий режим 090).
  IF COALESCE(auth_backoffice_role(), '') NOT IN ('owner', 'manager') THEN
    PERFORM require_staff_perm(p_staff_session, 'manage');
  END IF;

  -- RLS (devices_select) уже ограничил выборку организацией вызывающего.
  -- location_id у devices NOT NULL (001), но join оставляем LEFT — устойчивее
  -- к возможному ON DELETE в будущем и не роняет строку при рассинхроне.
  SELECT COALESCE(jsonb_agg(row_to_json(f) ORDER BY f.silence_seconds DESC NULLS FIRST), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT
      d.id,
      d.name,
      d.location_id,
      l.name                                              AS location_name,
      d.app_version,
      d.webview_version,
      d.bridge_version,
      d.outbox_pending,
      d.outbox_oldest_at,
      COALESCE(d.outbox_failed, FALSE)                    AS outbox_failed,
      d.last_seen_at,
      -- «Молчание» в секундах: NULL, если касса ни разу не выходила на связь
      -- (never_seen фронт трактует как offline). Считаем на сервере, чтобы UI
      -- не зависел от расхождения часов клиента.
      CASE WHEN d.last_seen_at IS NULL THEN NULL
           ELSE EXTRACT(EPOCH FROM (NOW() - d.last_seen_at))::bigint
      END                                                 AS silence_seconds
    FROM devices d
    LEFT JOIN locations l ON l.id = d.location_id
  ) f;

  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION get_backoffice_fleet FROM anon, public;
GRANT EXECUTE ON FUNCTION get_backoffice_fleet(UUID) TO authenticated;

COMMENT ON FUNCTION get_backoffice_fleet(UUID) IS
  'Парк устройств организации для ANGLE back office: версии, last_seen, здоровье offline-очереди. Гейт — членство владельца/менеджера или manage-сессия кассы; чтение под RLS вызывающего (своя org). PII/стеки не отдаёт.';
