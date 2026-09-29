-- ============================================================
-- 173: ANGLE Guest — публичный каталог заведений
--
-- `locations` остаётся операционной сущностью POS. Публичная карточка
-- вынесена отдельно: точка не появляется в каталоге случайно только потому,
-- что у неё есть QR-меню. Анонимный браузер таблицу не читает — выдачу
-- фильтрует Edge Function `public-restaurants` под service_role.
--
-- Рейтинг в этой версии только демонстрационный. Его имя в схеме намеренно
-- содержит `demo`: такие данные нельзя принять за Google или за реальные
-- отзывы гостей. После подключения внешнего источника demo-поля скрываются.
-- ============================================================

CREATE TABLE restaurant_directory_profiles (
  location_id       UUID PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  is_published      BOOLEAN NOT NULL DEFAULT FALSE,
  city              TEXT,
  country_code      TEXT NOT NULL DEFAULT 'IL'
                    CHECK (country_code ~ '^[A-Z]{2}$'),
  cuisine_labels    TEXT[] NOT NULL DEFAULT '{}',
  summary           TEXT,
  hero_url          TEXT,
  price_level       SMALLINT CHECK (price_level BETWEEN 1 AND 4),
  demo_rating       NUMERIC(2,1) CHECK (demo_rating BETWEEN 1 AND 5),
  demo_rating_count INTEGER CHECK (demo_rating_count >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT restaurant_directory_demo_rating_pair CHECK (
    (demo_rating IS NULL AND demo_rating_count IS NULL)
    OR (demo_rating IS NOT NULL AND demo_rating_count IS NOT NULL)
  )
);

CREATE INDEX restaurant_directory_published_idx
  ON restaurant_directory_profiles(is_published, city)
  WHERE is_published;
CREATE INDEX restaurant_directory_org_idx
  ON restaurant_directory_profiles(org_id);

COMMENT ON TABLE restaurant_directory_profiles IS
  'Опциональная публичная карточка точки в каталоге ANGLE Guest. '
  'Наличие точки или QR-меню само по себе её не публикует.';
COMMENT ON COLUMN restaurant_directory_profiles.demo_rating IS
  'Только явно помеченная демонстрационная оценка для прототипа; не Google и не отзыв гостя.';

-- Каталог тем же серверным гейтом узнаёт, можно ли показывать переход к
-- Reserve. Дополнительное поле обратно совместимо с public-menu.
CREATE OR REPLACE FUNCTION org_public_menu_gates(p_org UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'public_menu',         org_has_capability(p_org, 'public_menu'),
    'online_orders',       org_has_capability(p_org, 'online_orders'),
    'table_service',       org_has_capability(p_org, 'table_service'),
    'public_reservations', org_has_capability(p_org, 'public_reservations'),
    'pos',                 org_has_product(p_org, 'pos')
  )
$$;

REVOKE ALL ON FUNCTION org_public_menu_gates(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION org_public_menu_gates(UUID) TO service_role;

ALTER TABLE restaurant_directory_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY restaurant_directory_org_read
  ON restaurant_directory_profiles FOR SELECT TO authenticated
  USING (org_id = auth_org_id());

-- В первой версии редактирование идёт миграцией/операторским контуром.
-- Аноним получает только DTO из Edge Function, не таблицу и не org_id.
REVOKE ALL ON restaurant_directory_profiles FROM anon, public;
GRANT SELECT ON restaurant_directory_profiles TO authenticated;
GRANT ALL ON restaurant_directory_profiles TO service_role;

-- Первый пилот уже существует как location и QR-меню. Публикуем именно
-- дополнительную карточку каталога, не создавая второе заведение и не
-- меняя его режим обслуживания автоматически.
INSERT INTO restaurant_directory_profiles (
  location_id,
  org_id,
  is_published,
  city,
  cuisine_labels,
  summary,
  hero_url,
  price_level,
  demo_rating,
  demo_rating_count
)
SELECT
  l.id,
  l.org_id,
  TRUE,
  'Tel Aviv',
  ARRAY['Bakery', 'Coffee'],
  'Fresh pastries, coffee and an easy neighborhood stop on Pinsker Street.',
  COALESCE(
    NULLIF(l.settings -> 'online_orders' ->> 'header_url', ''),
    '/brand/bulochka/hero-poster.png'
  ),
  2,
  4.8,
  320
FROM locations l
WHERE l.id = 'fe2eebf0-65e3-45b4-a81f-331359d71955'
ON CONFLICT (location_id) DO NOTHING;
