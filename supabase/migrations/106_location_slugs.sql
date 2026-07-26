-- ============================================================
-- 106. Человекочитаемые слаги точек для публичных ссылок
--
-- /order/<uuid> нельзя продиктовать по телефону и стыдно печатать на
-- флаере. Слаг даёт /order/bulochka, но UUID-ссылки обязаны продолжать
-- работать: они уже нанесены на QR-наклейки столов (099).
--
-- Слаг живёт в отдельной таблице, а не колонкой в locations: он нужен
-- анонимному гостю ДО резолва точки, поэтому требует собственной RLS-
-- политики на чтение. Класть публично читаемое поле в locations значило
-- бы открыть анону строку целиком.
-- ============================================================

CREATE TABLE location_slugs (
  slug        TEXT PRIMARY KEY,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Слаг стоит в публичном URL: только строчная латиница, цифры и дефис,
  -- без ведущего/замыкающего дефиса. 3..40 — читаемо и влезает в QR.
  CONSTRAINT location_slugs_format CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{1,38})[a-z0-9]$'),
  -- Одна точка — один канонический слаг: иначе печатные материалы и
  -- аналитика начинают расходиться.
  CONSTRAINT location_slugs_one_per_location UNIQUE (location_id)
);

CREATE INDEX location_slugs_location_idx ON location_slugs(location_id);
CREATE INDEX location_slugs_org_idx ON location_slugs(org_id);

COMMENT ON TABLE location_slugs IS
  'Человекочитаемый слаг точки для публичных ссылок /order/<slug> (106). '
  'UUID-ссылки остаются валидными — слаг только дополнительный вход.';

-- ── Служебные сегменты, которые нельзя занять ────────────────
-- Формат /order/:locIdOrSlug конфликтов не создаёт, но слаг попадает и в
-- будущие маршруты, и в QR-подписи. Резерв закрывает имена заранее, пока
-- ни один клиент их не занял — потом отнимать уже больно.
CREATE TABLE reserved_slugs (
  slug TEXT PRIMARY KEY
);

INSERT INTO reserved_slugs (slug) VALUES
  ('order'), ('reserve'), ('menu'), ('assets'), ('brand'), ('icons'),
  ('api'), ('admin'), ('app'), ('static'), ('public'), ('sw'),
  ('favicon'), ('manifest'), ('install'), ('angle'), ('pos'), ('www');

COMMENT ON TABLE reserved_slugs IS
  'Служебные имена, недоступные как слаг точки (106).';

-- ============================================================
-- set_location_slug — владелец задаёт слаг из бэкофиса
--
-- Занятость проверяется в БД, а не в UI: два владельца могут сохранять
-- один слаг одновременно, и арбитром обязан быть уникальный индекс.
-- ============================================================
CREATE OR REPLACE FUNCTION set_location_slug(
  p_location_id UUID,
  p_slug TEXT,
  p_staff_session UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID;
  v_slug TEXT;
BEGIN
  -- Нормализуем до валидации: владелец наберёт «Bulochka » с заглавной и
  -- пробелом, и это не повод показывать ошибку формата.
  v_slug := lower(btrim(coalesce(p_slug, '')));

  -- Порядок как в 091: сначала точка принадлежит организации из JWT,
  -- затем право (владелец бэкофиса ИЛИ manage-сессия кассы).
  PERFORM assert_backoffice_location(p_location_id);
  PERFORM require_backoffice_or_staff(p_staff_session, 'manage');

  -- Тот же гейт, что и у публичной витрины: слаг бессмысленен без неё.
  PERFORM require_org_capability('public_menu');

  SELECT org_id INTO v_org FROM locations WHERE id = p_location_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'location_not_found';
  END IF;

  IF v_slug = '' THEN
    DELETE FROM location_slugs WHERE location_id = p_location_id;
    RETURN jsonb_build_object('slug', NULL);
  END IF;

  IF v_slug !~ '^[a-z0-9]([a-z0-9-]{1,38})[a-z0-9]$' THEN
    RAISE EXCEPTION 'invalid_slug_format';
  END IF;

  IF EXISTS (SELECT 1 FROM reserved_slugs WHERE slug = v_slug) THEN
    RAISE EXCEPTION 'slug_reserved';
  END IF;

  IF EXISTS (
    SELECT 1 FROM location_slugs
    WHERE slug = v_slug AND location_id <> p_location_id
  ) THEN
    RAISE EXCEPTION 'slug_taken';
  END IF;

  INSERT INTO location_slugs (slug, location_id, org_id)
  VALUES (v_slug, p_location_id, v_org)
  ON CONFLICT (location_id) DO UPDATE SET slug = EXCLUDED.slug;

  RETURN jsonb_build_object('slug', v_slug);
END $$;

REVOKE ALL ON FUNCTION set_location_slug(UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_location_slug(UUID, TEXT, UUID) TO authenticated, service_role;

COMMENT ON FUNCTION set_location_slug(UUID, TEXT, UUID) IS
  'Задаёт/снимает слаг точки (106). Пустая строка удаляет слаг. '
  'Требует capability public_menu и права settings_write.';

-- ============================================================
-- resolve_location_slug — гостевой резолв слага в UUID
--
-- Единственная функция, доступная анону: отдаёт ТОЛЬКО id точки. Дальше
-- гость идёт в public-menu с UUID, поэтому контракт Edge Functions и их
-- проверки UUID остаются нетронутыми.
-- ============================================================
CREATE OR REPLACE FUNCTION resolve_location_slug(p_slug TEXT)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT location_id FROM location_slugs WHERE slug = lower(btrim(p_slug))
$$;

REVOKE ALL ON FUNCTION resolve_location_slug(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_location_slug(TEXT) TO anon, authenticated, service_role;

COMMENT ON FUNCTION resolve_location_slug(TEXT) IS
  'Публичный резолв слага в location_id (106). Отдаёт только id: '
  'витрину по нему выдаёт public-menu со своими capability-гейтами.';

-- ── RLS ─────────────────────────────────────────────────────
-- Таблица закрыта наглухо: анон читает слаги исключительно через
-- resolve_location_slug (SECURITY DEFINER), что не даёт перечислить
-- клиентов Angle обходом по таблице.
ALTER TABLE location_slugs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reserved_slugs ENABLE ROW LEVEL SECURITY;

CREATE POLICY location_slugs_org_read ON location_slugs
  FOR SELECT TO authenticated
  USING (org_id = (auth.jwt() -> 'app_metadata' ->> 'org_id')::UUID);

-- Владелец должен видеть свой слаг в бэкофисе; политика выше сужает выдачу
-- до его организации. Запись идёт только через set_location_slug, поэтому
-- INSERT/UPDATE/DELETE не выдаются никому.
GRANT SELECT ON location_slugs TO authenticated;

-- ── Слаг существующей точке ─────────────────────────────────
-- Developer showcase (лехмания/Snif Pinsker 29): ссылка с флаера уже
-- нужна, а слаг у точки один — берём каноническое имя заведения.
INSERT INTO location_slugs (slug, location_id, org_id)
SELECT 'bulochka', id, org_id FROM locations
WHERE id = 'fe2eebf0-65e3-45b4-a81f-331359d71955'
ON CONFLICT DO NOTHING;
