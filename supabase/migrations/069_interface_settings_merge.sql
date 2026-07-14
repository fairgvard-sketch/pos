-- 069: settings.interface — тумблеры видимости элементов POS (см. 064).
-- Добавляем 'interface' в список deep-merge ключей patch_location_settings:
-- иначе патч одного тумблера перетирал бы соседние в том же разделе
-- (верхнеуровневые ключи вне v_allowed присваиваются целиком).
-- Функция пересоздаётся полностью (forward-only), тело — копия 064 + ключ.

CREATE OR REPLACE FUNCTION patch_location_settings(
  p_patch JSONB,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc UUID := auth_location_id();
  v_cur JSONB;
  v_next JSONB;
  v_key TEXT;
  v_allowed TEXT[] := ARRAY['perms','receipt','shift','online_orders','reservations','tips','pay_methods','quick_amounts','interface'];
BEGIN
  IF v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'manage');

  IF jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'patch must be a json object';
  END IF;

  -- Блокируем строку точки на время merge — исключаем гонку read-modify-write
  SELECT COALESCE(settings, '{}'::jsonb) INTO v_cur
  FROM locations WHERE id = v_loc FOR UPDATE;

  v_next := v_cur;

  -- Верхний уровень: известные разделы-объекты мержим (не перетираем соседей),
  -- прочие ключи присваиваем как есть.
  FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
    IF v_key = ANY(v_allowed)
       AND jsonb_typeof(v_next -> v_key) = 'object'
       AND jsonb_typeof(p_patch -> v_key) = 'object' THEN
      v_next := jsonb_set(v_next, ARRAY[v_key], (v_next -> v_key) || (p_patch -> v_key));
    ELSE
      v_next := jsonb_set(v_next, ARRAY[v_key], p_patch -> v_key);
    END IF;
  END LOOP;

  UPDATE locations SET settings = v_next WHERE id = v_loc;
  RETURN v_next;
END $$;

REVOKE EXECUTE ON FUNCTION patch_location_settings FROM anon, public;
