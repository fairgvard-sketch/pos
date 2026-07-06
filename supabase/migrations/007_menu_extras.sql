-- ============================================================
-- 007 — фото товаров (Storage), иконки категорий, поля склада
-- ============================================================

-- Иконка категории (эмодзи/глиф для колонки категорий)
ALTER TABLE menu_categories ADD COLUMN icon TEXT;

-- Складские поля (само списание остатков — отдельная фаза,
-- поля уже сохраняются и пригодятся для отчётов)
ALTER TABLE menu_items ADD COLUMN cost INTEGER;                -- себестоимость, агороты
ALTER TABLE menu_items ADD COLUMN sku TEXT;
ALTER TABLE menu_items ADD COLUMN track_inventory BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE menu_items ADD COLUMN stock INTEGER;               -- NULL = не ограничен

-- ── Storage: публичный бакет для фото меню ──────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('menu-images', 'menu-images', TRUE)
ON CONFLICT (id) DO NOTHING;

-- Файлы лежат в папке своего org: {org_id}/{uuid}.jpg
CREATE POLICY "menu_images_read" ON storage.objects FOR SELECT
  USING (bucket_id = 'menu-images');

CREATE POLICY "menu_images_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'menu-images'
    AND (storage.foldername(name))[1] = auth_org_id()::text
  );

CREATE POLICY "menu_images_update" ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'menu-images'
    AND (storage.foldername(name))[1] = auth_org_id()::text
  );

CREATE POLICY "menu_images_delete" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'menu-images'
    AND (storage.foldername(name))[1] = auth_org_id()::text
  );
