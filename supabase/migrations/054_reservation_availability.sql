-- ============================================================
-- 054 RESERVATION AVAILABILITY — защита от овербукинга (фаза B).
--
-- Гарантия на уровне БД: на одном столе не могут пересекаться две
-- АКТИВНЫЕ брони (учитывается окно [reserved_at, +duration_min)).
-- Race-free — это констрейнт, а не проверка в приложении: два
-- устройства не смогут забронировать один стол на одно время.
--
--   * Окно брони = tstzrange(reserved_at, reserved_at + duration).
--   * Пересечение (&&) на одном столе (table_id =) запрещено, пока
--     статус активный (requested/confirmed/seated). Отменённые/
--     неявка/завершённые окно не держат.
--   * Брони без стола (table_id IS NULL) в проверке не участвуют.
--   * Строка не конфликтует сама с собой → правку времени/статуса
--     той же брони констрейнт не блокирует.
--
-- Требует btree_gist: gist-класс для '=' по table_id (uuid) рядом с
-- '&&' по диапазону в одном исключающем индексе.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Окно брони как IMMUTABLE-функция. EXCLUDE требует immutable-выражения,
-- а встроенный оператор timestamptz + interval помечен STABLE (из-за
-- дней/месяцев, зависящих от TZ/DST). Прибавление МИНУТ к timestamptz
-- абсолютно (фиксированное число секунд, от TZ не зависит) — поэтому
-- обёртку безопасно объявить IMMUTABLE.
CREATE OR REPLACE FUNCTION reservation_span(p_at TIMESTAMPTZ, p_dur INTEGER)
RETURNS tstzrange
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT tstzrange(p_at, p_at + p_dur * interval '1 minute');
$$;

ALTER TABLE reservations
  ADD CONSTRAINT reservations_no_overlap
  EXCLUDE USING gist (
    table_id WITH =,
    reservation_span(reserved_at, duration_min) WITH &&
  )
  WHERE (table_id IS NOT NULL AND status IN ('requested', 'confirmed', 'seated'));
