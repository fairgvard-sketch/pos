-- ============================================================
-- 095 PIN-THROTTLE + СКОУП СЕССИИ ПО ТОЧКЕ — по итогам аудита безопасности.
--
-- Две независимые дыры, закрываются одной миграцией (обе — про сессию).
--
-- ── 1) Перебор PIN ──────────────────────────────────────────
-- verify_staff_pin (044) не считала неудачные попытки: ни лимита, ни
-- задержки. Практическое пространство — 10 000 (UI шлёт на 4-й цифре), а
-- запрос matches ЛЮБОГО сотрудника организации (WHERE org_id AND pin_hash,
-- LIMIT 1) — с 10 сотрудниками перебор схлопывается ещё на порядок.
-- Вызвать RPC может любой с сессией устройства, включая украденный или
-- невозвращённый терминал; скриптом это минуты, а на выходе — роль до
-- manager: возвраты, скидки, закрытие смены.
--
-- Защита двухслойная, обе на стороне БД (клиенту доверять нечего):
--   * задержка на КАЖДОМ неуспехе — bcrypt сам по себе не настолько
--     медленный, чтобы отбить скриптовый перебор;
--   * блокировка по (org_id, auth.uid()) после N неудач подряд.
-- Скоуп счётчика — устройство, а не сотрудник: сотрудник неизвестен, пока
-- PIN не сошёлся, — это и есть суть атаки. Успешный вход счётчик обнуляет,
-- поэтому честная опечатка бариста ничего не копит.
--
-- Окно и порог намеренно щадящие (10 попыток / 15 минут): POS-терминал в
-- спешке, промах пальцем — норма, а блокировка кассы в час пик дороже, чем
-- лишние 10 попыток атакующему. Против перебора работает в первую очередь
-- задержка, блокировка — второй рубеж.
--
-- ── 2) Сессия не скоупилась по точке ────────────────────────
-- require_staff_perm (090/094) сверяла ss.org_id, но НЕ location_id — хотя
-- колонка есть и заполняется с 044. Токен точки А проходил на точке Б той
-- же организации, причём уровень права читается из настроек ТЕКУЩЕЙ точки
-- (auth_location_id()) — то есть сотрудник точки со слабыми настройками
-- получал право на точке со строгими. Сейчас сеть одноточечная, но это
-- ровно тот баг, который выстреливает при втором заведении.
--
-- ⚠️ Сессии, выданные ДО 095, могут иметь location_id IS NULL (устройство
-- без location_id в JWT). Жёсткое равенство разлогинило бы их посреди
-- смены, поэтому NULL трактуется как legacy-permissive: отвергается только
-- явное расхождение. Со временем такие сессии истекут сами.
--
-- ⚠️ ТРЕБУЕТ 094 (ветка кастомной роли в require_staff_perm).
-- ============================================================

-- ── Журнал неудачных PIN-попыток ────────────────────────────
-- Не финансовая запись: чистится свободно, в аудит-трейл не входит.
CREATE TABLE pin_attempts (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- Устройство = аккаунт Supabase Auth (auth.uid()), а НЕ devices.id:
  -- отдельного device_id в app_metadata нет, а токен кассы — это ровно
  -- её auth-пользователь. NULL для контекстов без auth (pgTAP, сервисные).
  auth_user_id UUID,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pin_attempts_scope
  ON pin_attempts (org_id, auth_user_id, attempted_at DESC);

-- Содержимое — сигнал безопасности, клиенту не нужно ни на чтение, ни на запись.
ALTER TABLE pin_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pin_attempts FROM anon, authenticated, public;
GRANT ALL ON pin_attempts TO service_role;
GRANT USAGE, SELECT ON SEQUENCE pin_attempts_id_seq TO service_role;

COMMENT ON TABLE pin_attempts IS
  'Неудачные попытки PIN (095), скоуп (org_id, auth_user_id). Не аудит-трейл: чистится свободно.';

-- ── Общие хелперы throttle ──────────────────────────────────
-- Вынесены отдельно: PIN сверяют ДВЕ функции — verify_staff_pin (вход) и
-- punch_by_pin (023, табель). Если throttle навесить только на первую,
-- перебор просто переезжает на вторую: там тот же bcrypt по тем же
-- сотрудникам организации. Порог живёт в одном месте.
CREATE OR REPLACE FUNCTION pin_throttle_check()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fails INTEGER;
  -- Окно скользящее: блокировка снимается сама, когда старые неудачи
  -- выпадают из окна — отдельный lockout-таймер не нужен.
  c_max_fails CONSTANT INTEGER  := 10;
  c_window    CONSTANT INTERVAL := INTERVAL '15 minutes';
BEGIN
  SELECT COUNT(*) INTO v_fails
  FROM pin_attempts
  WHERE org_id = auth_org_id()
    AND auth_user_id IS NOT DISTINCT FROM auth.uid()
    AND attempted_at > NOW() - c_window;

  IF v_fails >= c_max_fails THEN
    -- Отдельный код: клиенту нужно показать «попробуйте позже», а не
    -- «неверный PIN» — иначе бариста долбит заведомо мёртвый ввод.
    RAISE EXCEPTION 'pin_locked_out';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION pin_throttle_check FROM anon, public;

-- Неудача: записать след и притормозить вызывающего.
CREATE OR REPLACE FUNCTION pin_throttle_fail()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO pin_attempts (org_id, auth_user_id) VALUES (auth_org_id(), auth.uid());
  -- Задержка на неуспехе — основной тормоз скриптового перебора: 300 мс
  -- незаметны человеку с опечаткой и превращают 10 000 вариантов в часы
  -- даже без учёта блокировки.
  PERFORM pg_sleep(0.3);
END $$;

REVOKE EXECUTE ON FUNCTION pin_throttle_fail FROM anon, public;

-- Успех: журнал этого устройства обнуляется, чтобы опечатки честного
-- сотрудника не копились до блокировки через несколько смен.
CREATE OR REPLACE FUNCTION pin_throttle_reset()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM pin_attempts
  WHERE org_id = auth_org_id() AND auth_user_id IS NOT DISTINCT FROM auth.uid();
  -- Заодно подрезаем старый журнал, чтобы он не рос вечно
  DELETE FROM pin_attempts WHERE attempted_at < NOW() - INTERVAL '7 days';
END $$;

REVOKE EXECUTE ON FUNCTION pin_throttle_reset FROM anon, public;

-- ── verify_staff_pin: throttle поверх тела 094 ──────────────
-- Тело 094 сохранено ЦЕЛИКОМ, включая role_id/role_perms в RETURNS TABLE:
-- без них клиент кассы перестанет видеть кастомную роль и начнёт прятать
-- кнопки, которые сервер разрешает. Добавлены: проверка блокировки ДО
-- сверки хеша, запись неудачи с задержкой, обнуление счётчика при успехе.
--
-- DROP обязателен: CREATE OR REPLACE не меняет тип возврата (42P13).
DROP FUNCTION IF EXISTS verify_staff_pin(TEXT);

CREATE FUNCTION verify_staff_pin(p_pin TEXT)
RETURNS TABLE (id UUID, name TEXT, role TEXT, location_id UUID, session_token UUID,
               role_id UUID, role_perms JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_staff  staff%ROWTYPE;
  v_token  UUID;
  v_org    UUID := auth_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Блокировка проверяется ДО сверки хеша: иначе перебор продолжает
  -- работать, просто с ответом «заблокировано» после каждой удачи.
  PERFORM pin_throttle_check();

  SELECT s.* INTO v_staff
  FROM staff s
  WHERE s.org_id = v_org
    AND s.is_active
    AND (s.location_id IS NULL OR s.location_id = auth_location_id())
    AND s.pin_hash = crypt(p_pin, s.pin_hash)
  LIMIT 1;

  IF NOT FOUND THEN
    PERFORM pin_throttle_fail();
    RETURN;
  END IF;

  PERFORM pin_throttle_reset();

  -- Гигиена: сессии не финансовые записи, протухшие удаляем
  DELETE FROM staff_sessions
  WHERE org_id = v_org AND expires_at < NOW() - INTERVAL '7 days';

  INSERT INTO staff_sessions (staff_id, org_id, location_id)
  VALUES (v_staff.id, v_staff.org_id, auth_location_id())
  RETURNING token INTO v_token;

  RETURN QUERY SELECT v_staff.id, v_staff.name, v_staff.role, v_staff.location_id, v_token,
                      v_staff.role_id,
                      (SELECT r.perms FROM roles r WHERE r.id = v_staff.role_id);
END $$;

REVOKE EXECUTE ON FUNCTION verify_staff_pin FROM anon, public;
GRANT EXECUTE ON FUNCTION verify_staff_pin(TEXT) TO authenticated;

COMMENT ON FUNCTION verify_staff_pin IS
  'PIN-вход (095): throttle по (org_id, auth_user_id) — задержка на неуспехе + блокировка после 10 неудач за 15 минут.';

-- ── require_staff_perm: + скоуп сессии по точке ─────────────
-- Тело 094 сохранено полностью (строгая проверка, скользящее продление,
-- ветка кастомной роли, фолбэк-уровни 055). Добавлено ТОЛЬКО условие
-- location_id в выборке сессии.
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
    -- НОВОЕ (095): токен точки А не действует на точке Б. Legacy-сессии с
    -- NULL location_id пропускаем — иначе разлогин посреди смены при
    -- раскатке; отвергается только явное расхождение.
    AND (ss.location_id IS NULL OR ss.location_id = auth_location_id())
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

  -- Владелец не ограничивается ролью: иначе он запрёт сам себя
  IF v_staff.role = 'owner' THEN
    RETURN v_staff.id;
  END IF;

  -- Кастомная роль (094) — источник истины для своих ключей.
  IF v_staff.role_id IS NOT NULL AND p_perm <> 'manage' THEN
    IF role_allows(v_staff.role_id, p_perm) THEN
      RETURN v_staff.id;
    END IF;
    RAISE EXCEPTION 'forbidden: %', p_perm;
  END IF;

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

-- ── current_actor_role: тот же скоуп ────────────────────────
-- Условия обязаны совпадать с require_staff_perm, иначе роль пришла бы из
-- сессии чужой точки — и «только владелец трогает владельца» (093)
-- решалось бы по токену, который сам по себе здесь уже невалиден.
CREATE OR REPLACE FUNCTION current_actor_role(p_session UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := auth_backoffice_role();
BEGIN
  IF v_role IS NOT NULL THEN
    RETURN v_role;
  END IF;

  RETURN (
    SELECT s.role
    FROM staff_sessions ss
    JOIN staff s ON s.id = ss.staff_id
    WHERE ss.token = p_session
      AND ss.org_id = auth_org_id()
      AND (ss.location_id IS NULL OR ss.location_id = auth_location_id())
      AND ss.revoked_at IS NULL
      AND ss.expires_at > NOW()
      AND s.is_active
    LIMIT 1
  );
END $$;

REVOKE EXECUTE ON FUNCTION current_actor_role FROM anon, public;
GRANT EXECUTE ON FUNCTION current_actor_role(UUID) TO authenticated;

-- ── punch_by_pin (023): тот же throttle ─────────────────────
-- Табель сверяет тот же bcrypt по тем же сотрудникам организации. Без
-- throttle здесь перебор просто переезжает с экрана блокировки на экран
-- табеля — дыра остаётся открытой. Тело 023 сохранено дословно, добавлены
-- только три вызова хелперов.
CREATE OR REPLACE FUNCTION punch_by_pin(p_pin TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_loc   UUID := auth_location_id();
  v_staff staff%ROWTYPE;
  v_open  time_entries%ROWTYPE;
  v_id    UUID;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  PERFORM pin_throttle_check();

  -- Идентификация по PIN (та же логика, что verify_staff_pin)
  SELECT * INTO v_staff
  FROM staff s
  WHERE s.org_id = v_org
    AND s.is_active
    AND (s.location_id IS NULL OR s.location_id = v_loc)
    AND s.pin_hash = crypt(p_pin, s.pin_hash);
  IF NOT FOUND THEN
    PERFORM pin_throttle_fail();
    RAISE EXCEPTION 'wrong pin';
  END IF;

  PERFORM pin_throttle_reset();

  -- Есть открытый день → закрываем (clock-out)
  SELECT * INTO v_open FROM time_entries
  WHERE staff_id = v_staff.id AND clock_out IS NULL
  ORDER BY clock_in DESC LIMIT 1;

  IF FOUND THEN
    UPDATE time_entries SET clock_out = NOW()
    WHERE id = v_open.id
    RETURNING * INTO v_open;
    RETURN json_build_object(
      'action',     'out',
      'staff_name', v_staff.name,
      'clock_in',   v_open.clock_in,
      'clock_out',  v_open.clock_out,
      'seconds',    EXTRACT(EPOCH FROM (v_open.clock_out - v_open.clock_in))::INTEGER
    );
  END IF;

  -- Иначе открываем новый день (clock-in)
  INSERT INTO time_entries (org_id, location_id, staff_id)
  VALUES (v_org, v_loc, v_staff.id)
  RETURNING id INTO v_id;

  RETURN json_build_object(
    'action',     'in',
    'staff_name', v_staff.name,
    'entry_id',   v_id
  );
END $$;

REVOKE EXECUTE ON FUNCTION punch_by_pin FROM anon, public;
GRANT EXECUTE ON FUNCTION punch_by_pin(TEXT) TO authenticated;
