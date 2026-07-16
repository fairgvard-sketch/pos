-- 074: наблюдаемость парка устройств (эксплуатация, docs/deployment.md).
--
-- Две части:
--  1. Heartbeat: devices получает здоровье offline-очереди и версию моста
--     печати. Лёгкий RPC device_heartbeat дополняет register_device (065):
--     тот выполняется на входе/восстановлении сети, heartbeat — раз в
--     несколько минут, пока касса открыта. «Молчание» устройства видно по
--     last_seen_at.
--  2. client_errors: журнал клиентских ошибок (window.onerror, unhandled
--     rejection, ErrorBoundary, стоп offline-очереди, сбой печати).
--     Дедупликация по fingerprint в пределах дня — шторм одинаковых ошибок
--     схлопывается в count, а не в тысячи строк.
--
-- Доступ (см. правило 071: новые объекты выдают явные GRANT сами):
--  * client_errors ЗАКРЫТА для клиентов целиком — запись только через
--    report_client_errors (SECURITY DEFINER), чтение — операторские
--    ops-view / service_role. Стеки ошибок могут содержать что угодно,
--    поэтому чтение им не выдаётся даже в пределах своей org.
--  * В телеметрию нельзя писать PII: клиент шлёт message/stack/route,
--    без payload заказов, имён гостей и PIN.

-- ── 1. Heartbeat: здоровье offline-очереди на devices ──

ALTER TABLE devices ADD COLUMN IF NOT EXISTS bridge_version   INTEGER;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS outbox_pending   INTEGER;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS outbox_oldest_at TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS outbox_failed    BOOLEAN;

-- Телеметрия никогда не должна ронять кассу: heartbeat до register_device
-- (гонка при первом запуске) — тихий no-op, а не исключение.
CREATE OR REPLACE FUNCTION device_heartbeat(
  p_device_uuid    UUID,
  p_app_version    TEXT DEFAULT NULL,
  p_bridge_version INTEGER DEFAULT NULL,
  p_outbox_pending INTEGER DEFAULT NULL,
  p_outbox_oldest  TIMESTAMPTZ DEFAULT NULL,
  p_outbox_failed  BOOLEAN DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_uid UUID := auth.uid();
BEGIN
  IF v_org IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  UPDATE devices SET
    app_version      = COALESCE(p_app_version, app_version),
    bridge_version   = COALESCE(p_bridge_version, bridge_version),
    outbox_pending   = COALESCE(p_outbox_pending, outbox_pending),
    outbox_oldest_at = p_outbox_oldest,   -- NULL = очередь пуста, затираем
    outbox_failed    = COALESCE(p_outbox_failed, outbox_failed),
    last_seen_at     = NOW()
  WHERE device_uuid = p_device_uuid
    AND org_id = v_org
    AND auth_user_id = v_uid;

  RETURN FOUND;
END $$;

REVOKE EXECUTE ON FUNCTION device_heartbeat FROM anon, public;
GRANT EXECUTE ON FUNCTION device_heartbeat(UUID, TEXT, INTEGER, INTEGER, TIMESTAMPTZ, BOOLEAN)
  TO authenticated, service_role;

-- ── 2. Журнал клиентских ошибок ──

CREATE TABLE client_errors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id   UUID REFERENCES locations(id) ON DELETE CASCADE,
  device_uuid   UUID NOT NULL,
  day           DATE NOT NULL DEFAULT CURRENT_DATE,
  -- Хеш source+message+верхний кадр стека, считает клиент (telemetry.ts)
  fingerprint   TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('window', 'promise', 'react', 'outbox', 'print')),
  message       TEXT NOT NULL,
  stack         TEXT,
  route         TEXT,
  app_version   TEXT,
  user_agent    TEXT,
  count         INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Арбитр дедупликации: одна строка на ошибку×устройство×день
CREATE UNIQUE INDEX uq_client_errors_dedup
  ON client_errors(org_id, device_uuid, fingerprint, day);
-- Retention и операторская выборка «свежие ошибки org»
CREATE INDEX idx_client_errors_org_seen ON client_errors(org_id, last_seen_at);

ALTER TABLE client_errors ENABLE ROW LEVEL SECURITY;
-- Политик для authenticated нет намеренно: таблица закрыта, как op_log
REVOKE ALL ON client_errors FROM anon, authenticated, public;
GRANT ALL ON client_errors TO service_role;

-- Приём пакета ошибок. Ограничители против шторма/флуда:
--  * не больше 20 элементов за вызов (клиент столько и шлёт);
--  * не больше 100 разных fingerprint на устройство в день — дальше пакет
--    молча игнорируется (count у существующих строк продолжает расти);
--  * все текстовые поля обрезаются на входе;
--  * заодно чистится хвост старше 30 дней (только своя org — работа
--    ограничена индексом idx_client_errors_org_seen).
CREATE OR REPLACE FUNCTION report_client_errors(
  p_device_uuid UUID,
  p_errors      JSONB
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_loc      UUID := auth_location_id();
  v_uid      UUID := auth.uid();
  v_elem     JSONB;
  v_fp       TEXT;
  v_source   TEXT;
  v_count    INTEGER;
  v_is_new   INTEGER;
  v_today    INTEGER;
  v_accepted INTEGER := 0;
BEGIN
  IF v_org IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_device_uuid IS NULL OR jsonb_typeof(p_errors) <> 'array' THEN
    RAISE EXCEPTION 'errors must be a json array';
  END IF;

  DELETE FROM client_errors
  WHERE org_id = v_org AND last_seen_at < NOW() - INTERVAL '30 days';

  SELECT COUNT(*) INTO v_today
  FROM client_errors
  WHERE org_id = v_org AND device_uuid = p_device_uuid AND day = CURRENT_DATE;

  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_errors) LIMIT 20 LOOP
    v_fp := LEFT(v_elem ->> 'fingerprint', 64);
    IF v_fp IS NULL OR v_elem ->> 'message' IS NULL THEN
      CONTINUE;  -- битый элемент не валит остальной пакет
    END IF;

    v_source := v_elem ->> 'source';
    IF v_source NOT IN ('window', 'promise', 'react', 'outbox', 'print') THEN
      v_source := 'window';
    END IF;
    v_count := LEAST(GREATEST(COALESCE((v_elem ->> 'count')::INTEGER, 1), 1), 1000);

    IF v_today >= 100 AND NOT EXISTS (
      SELECT 1 FROM client_errors
      WHERE org_id = v_org AND device_uuid = p_device_uuid
        AND fingerprint = v_fp AND day = CURRENT_DATE
    ) THEN
      CONTINUE;  -- дневной лимит новых fingerprint исчерпан
    END IF;

    INSERT INTO client_errors (
      org_id, location_id, device_uuid, fingerprint, source, message,
      stack, route, app_version, user_agent, count
    ) VALUES (
      v_org, v_loc, p_device_uuid, v_fp, v_source,
      LEFT(v_elem ->> 'message', 500),
      LEFT(v_elem ->> 'stack', 4000),
      LEFT(v_elem ->> 'route', 200),
      LEFT(v_elem ->> 'app_version', 32),
      LEFT(v_elem ->> 'user_agent', 256),
      v_count
    )
    ON CONFLICT (org_id, device_uuid, fingerprint, day) DO UPDATE SET
      count        = client_errors.count + EXCLUDED.count,
      last_seen_at = NOW()
    RETURNING (xmax = 0)::INTEGER INTO v_is_new;

    v_today := v_today + v_is_new;
    v_accepted := v_accepted + 1;
  END LOOP;

  RETURN v_accepted;
END $$;

REVOKE EXECUTE ON FUNCTION report_client_errors FROM anon, public;
GRANT EXECUTE ON FUNCTION report_client_errors(UUID, JSONB)
  TO authenticated, service_role;

-- ── 3. Операторские view для SQL Editor / service_role ──
-- security_invoker: view не обходит RLS — читает их только оператор
-- (postgres/service_role), клиентам SELECT не выдан.

CREATE VIEW ops_fleet WITH (security_invoker = true) AS
SELECT
  o.name  AS org,
  l.name  AS location,
  d.name  AS device,
  d.app_version,
  d.webview_version,
  d.bridge_version,
  d.outbox_pending,
  d.outbox_oldest_at,
  d.outbox_failed,
  d.last_seen_at,
  NOW() - d.last_seen_at AS silence
FROM devices d
JOIN orgs o ON o.id = d.org_id
LEFT JOIN locations l ON l.id = d.location_id
ORDER BY d.last_seen_at ASC NULLS FIRST;

CREATE VIEW ops_errors WITH (security_invoker = true) AS
SELECT
  o.name AS org,
  e.day,
  e.source,
  e.message,
  e.count,
  e.app_version,
  e.route,
  e.device_uuid,
  e.last_seen_at
FROM client_errors e
JOIN orgs o ON o.id = e.org_id
ORDER BY e.last_seen_at DESC;

REVOKE ALL ON ops_fleet, ops_errors FROM anon, authenticated, public;
GRANT SELECT ON ops_fleet, ops_errors TO service_role;
