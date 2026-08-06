-- ============================================================
-- 146 ЧЕКЛИСТ ЗАПУСКА ЗАСЧИТЫВАЕТ ПРАВИЛА ВИЗИТА
--
-- МОТИВ. 145 дал владельцу второй — и главный — способ рассказать
-- гостю условия: список `rules`, который виден ДО заявки. Чеклист
-- запуска (126) остался считать шаг только по `policy` — свободному
-- тексту отмены, который показывается ПОСЛЕ брони.
--
-- Владелец написал правила и увидел ненастроенный пункт. Это худший
-- вид неправды в чеклисте: он считается из данных именно для того,
-- чтобы ему верили, а тут он отрицает сделанную работу и отправляет
-- заполнять поле, которое дублирует уже написанное.
--
-- ЧТО ЗДЕСЬ. Шаг `policy` засчитывается, если задано ХОТЬ ЧТО-ТО из
-- двух: правила визита (145) или текст отмены (126). Оба отвечают на
-- один вопрос владельца — «гость знает условия?»; требовать оба
-- значило бы придумать работу, которой продукт не требует.
--
-- `detail` теперь называет, чем шаг закрыт: «3 rules · cancellation
-- text». Пункт чеклиста, который молча меняет смысл, доверия не
-- прибавляет.
--
-- Тело скопировано из 126 дословно; изменены ТОЛЬКО расчёт v_policy,
-- его detail и добавлена переменная счётчика правил.
--
-- ⚠️ ТРЕБУЕТ 126 и 145.
-- ============================================================

CREATE OR REPLACE FUNCTION reserve_launch_checklist_web(p_location_id UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_loc      locations%ROWTYPE;
  v_rsv      JSONB;
  v_tables   INTEGER;
  v_seats    INTEGER;
  v_schedule BOOLEAN;
  v_rules    INTEGER;
  v_text     BOOLEAN;
  v_policy   BOOLEAN;
  v_detail   TEXT;
  v_brand    BOOLEAN;
  v_slug     BOOLEAN;
  v_tested   BOOLEAN;
BEGIN
  PERFORM _reservation_web_member(p_location_id);

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id AND org_id = v_org;
  v_rsv := COALESCE(v_loc.settings -> 'reservations', '{}'::jsonb);

  SELECT COUNT(*)::INTEGER, COALESCE(SUM(seats), 0)::INTEGER
  INTO v_tables, v_seats
  FROM tables WHERE location_id = p_location_id AND org_id = v_org AND is_active;

  -- Расписание задано ЯВНО: legacy-пара open/close и умолчания 117
  -- считаются «ещё не настроено» — владелец их не выбирал.
  v_schedule := jsonb_typeof(v_rsv -> 'schedule' -> 'weekly') = 'object'
                AND (SELECT COUNT(*) FROM jsonb_object_keys(v_rsv -> 'schedule' -> 'weekly')) > 0;

  -- Условия визита: правила до заявки (145) ИЛИ текст отмены (126).
  -- Считаем правила через ту же нормализацию, что видит гость: пункт
  -- с пустым текстом до него не доезжает и закрывать шаг не должен.
  v_rules := jsonb_array_length(reservation_rules(v_loc.settings));
  v_text  := NULLIF(btrim(COALESCE(v_rsv ->> 'policy', '')), '') IS NOT NULL;
  v_policy := v_rules > 0 OR v_text;
  v_detail := NULLIF(concat_ws(' · ',
    CASE WHEN v_rules > 0
         THEN v_rules || CASE WHEN v_rules = 1 THEN ' rule' ELSE ' rules' END END,
    CASE WHEN v_text THEN 'cancellation text' END), '');

  -- Брендинг: гостю нужно понять, куда он идёт. Имя + хотя бы один
  -- способ связи или адрес.
  v_brand := COALESCE(
    NULLIF(btrim(COALESCE(v_rsv ->> 'display_name', '')), ''),
    NULLIF(btrim(COALESCE(v_loc.settings ->> 'display_name', '')), ''),
    NULLIF(btrim(COALESCE(v_loc.receipt_business_name, '')), '')) IS NOT NULL
    AND COALESCE(
      NULLIF(btrim(COALESCE(v_rsv ->> 'address', '')), ''),
      NULLIF(btrim(COALESCE(v_loc.receipt_address, '')), ''),
      NULLIF(btrim(COALESCE(v_loc.receipt_phone, '')), '')) IS NOT NULL;

  SELECT EXISTS (SELECT 1 FROM location_slugs WHERE location_id = p_location_id)
  INTO v_slug;

  SELECT EXISTS (
    SELECT 1 FROM reservations
    WHERE location_id = p_location_id AND org_id = v_org AND is_test
  ) INTO v_tested;

  RETURN json_build_object(
    'location_id', p_location_id,
    'accepting', COALESCE((v_rsv ->> 'enabled')::BOOLEAN, FALSE),
    'steps', json_build_array(
      json_build_object('key', 'tables', 'done', v_tables > 0,
        'detail', v_tables || ' tables · ' || v_seats || ' seats'),
      json_build_object('key', 'schedule', 'done', v_schedule, 'detail', NULL),
      json_build_object('key', 'policy', 'done', v_policy, 'detail', v_detail),
      json_build_object('key', 'branding', 'done', v_brand, 'detail', NULL),
      json_build_object('key', 'link', 'done', v_slug, 'detail', NULL),
      json_build_object('key', 'test_booking', 'done', v_tested, 'detail', NULL)
    ),
    'ready', v_tables > 0 AND v_schedule AND v_brand
  );
END $$;

COMMENT ON FUNCTION reserve_launch_checklist_web(UUID) IS
  'Готовность точки к публикации брони (126/146). Считается из данных, а не из галочек владельца; шаг условий закрывают правила визита (145) или текст отмены.';
