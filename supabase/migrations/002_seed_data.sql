-- ============================================================
-- SEED DATA для демонстрации
-- ============================================================

-- Staff
INSERT INTO staff (name, role, pin_code) VALUES
  ('Алексей Иванов',  'manager', '0000'),
  ('Мария Смирнова',  'waiter',  '1111'),
  ('Дмитрий Козлов',  'waiter',  '2222'),
  ('Кухня',           'kitchen', '9999');

-- Tables
INSERT INTO tables (number, capacity, status, zone) VALUES
  (1,  2, 'free', 'Зал A'),
  (2,  4, 'free', 'Зал A'),
  (3,  4, 'free', 'Зал A'),
  (4,  6, 'free', 'Зал A'),
  (5,  2, 'free', 'Зал B'),
  (6,  4, 'free', 'Зал B'),
  (7,  4, 'free', 'Зал B'),
  (8,  8, 'free', 'Зал B'),
  (9,  2, 'free', 'Терраса'),
  (10, 4, 'free', 'Терраса'),
  (11, 6, 'free', 'Терраса'),
  (12, 2, 'free', 'Бар');

-- Menu categories
INSERT INTO menu_categories (name, sort_order, is_active) VALUES
  ('Закуски',    1,  TRUE),
  ('Супы',       2,  TRUE),
  ('Горячее',    3,  TRUE),
  ('Гриль',      4,  TRUE),
  ('Паста',      5,  TRUE),
  ('Пицца',      6,  TRUE),
  ('Десерты',    7,  TRUE),
  ('Напитки',    8,  TRUE),
  ('Алкоголь',   9,  TRUE),
  ('Завтраки',   10, TRUE);

-- Menu items
WITH cats AS (
  SELECT id, name FROM menu_categories
)
INSERT INTO menu_items (category_id, name, price, description, is_available, prep_time_min, image_url)
SELECT c.id, m.name, m.price, m.description, TRUE, m.prep, m.image_url
FROM (VALUES
  ('Закуски', 'Брускетта с томатами',         180,  'Поджаренный хлеб, свежие томаты, базилик',   10, 'https://images.unsplash.com/photo-1572695157366-5e585ab2b69f?w=400&q=80'),
  ('Закуски', 'Салат Цезарь',                 320,  'Романо, курица, пармезан, кростини',           12, 'https://images.unsplash.com/photo-1546793665-c74683f339c1?w=400&q=80'),
  ('Закуски', 'Тартар из лосося',             480,  'Свежий лосось, авокадо, каперсы',              10, 'https://images.unsplash.com/photo-1580822184713-fc5400e7fe10?w=400&q=80'),
  ('Закуски', 'Карпаччо из говядины',         420,  'Тонкие слайсы говядины, рукола, пармезан',     10, 'https://images.unsplash.com/photo-1544025162-d76694265947?w=400&q=80'),
  ('Супы',    'Борщ',                         280,  'Классический украинский борщ со сметаной',      20, 'https://images.unsplash.com/photo-1547592166-23ac45744acd?w=400&q=80'),
  ('Супы',    'Крем-суп из тыквы',            260,  'Тыква, сливки, имбирь',                        15, 'https://images.unsplash.com/photo-1476718406336-bb5a9690ee2a?w=400&q=80'),
  ('Супы',    'Том Ям',                       350,  'Кокосовое молоко, креветки, лайм',             20, 'https://images.unsplash.com/photo-1569050467447-ce54b3bbc37d?w=400&q=80'),
  ('Горячее', 'Стейк Рибай 300г',             980,  'Мраморная говядина, соус на выбор',            25, 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400&q=80'),
  ('Горячее', 'Семга на гриле',               680,  'Стейк из семги, овощи гриль',                  20, 'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=400&q=80'),
  ('Горячее', 'Куриное филе',                 380,  'Куриная грудка в сливочном соусе',              20, 'https://images.unsplash.com/photo-1598103442097-8b74394b95c8?w=400&q=80'),
  ('Паста',   'Паста Карбонара',              380,  'Спагетти, бекон, яйцо, пармезан',              15, 'https://images.unsplash.com/photo-1612874742237-6526221588e3?w=400&q=80'),
  ('Паста',   'Паста Болоньезе',              360,  'Тальятелле, мясной рагу, томаты',               20, 'https://images.unsplash.com/photo-1551892374-ecf8754cf8b0?w=400&q=80'),
  ('Паста',   'Ризотто с грибами',            420,  'Арборио, белые грибы, пармезан',               25, 'https://images.unsplash.com/photo-1476124369491-e7addf5db371?w=400&q=80'),
  ('Десерты', 'Тирамису',                     280,  'Классический итальянский десерт',               5, 'https://images.unsplash.com/photo-1571877227200-a0d98ea607e9?w=400&q=80'),
  ('Десерты', 'Чизкейк Нью-Йорк',            300,  'Крем-сыр, ягодный соус',                       5, 'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?w=400&q=80'),
  ('Десерты', 'Шоколадный фондан',            320,  'Теплый кекс с жидким шоколадом',              12, 'https://images.unsplash.com/photo-1624353365286-3f8d62daad51?w=400&q=80'),
  ('Напитки', 'Американо',                    120,  'Двойной эспрессо с водой',                      5, 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=400&q=80'),
  ('Напитки', 'Капучино',                     150,  'Эспрессо, вспененное молоко',                   5, 'https://images.unsplash.com/photo-1572442388796-11668a67e53d?w=400&q=80'),
  ('Напитки', 'Свежевыжатый сок',             180,  'Апельсин / яблоко / грейпфрут',                 5, 'https://images.unsplash.com/photo-1600271886742-f049cd451bba?w=400&q=80'),
  ('Напитки', 'Вода Evian 0.5л',               80,  'Негазированная / газированная',                  2, 'https://images.unsplash.com/photo-1548839140-29a749e1cf4d?w=400&q=80'),
  ('Алкоголь','Бокал вина 150мл',             320,  'Красное / белое / розовое',                      2, 'https://images.unsplash.com/photo-1510812431401-41d2bd2722f3?w=400&q=80'),
  ('Алкоголь','Пиво Хайнекен 0.5л',           220,  'Светлое разливное',                              2, 'https://images.unsplash.com/photo-1608270586620-248524c67de9?w=400&q=80')
) AS m(cat_name, name, price, description, prep, image_url)
JOIN cats c ON c.name = m.cat_name;
