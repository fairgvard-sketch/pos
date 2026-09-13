-- A6: protect digital identities even while an old signed JWT is valid.
-- A digital token has no location_id. Membership, not its cached org claim,
-- authorizes tenant reads/RPCs. Keep the existing POS device-token/PIN model:
-- a location-bearing device identity is a separate authorization channel.
-- Operator/service calls are not web sessions and keep the existing semantics.
CREATE OR REPLACE FUNCTION auth_org_id()
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org UUID := NULLIF(auth.jwt()->'app_metadata'->>'org_id','')::UUID;
BEGIN
  IF current_setting('role', TRUE) = 'authenticated'
     AND NULLIF(auth.jwt()->'app_metadata'->>'location_id','') IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM organization_members m
       WHERE m.org_id = v_org AND m.auth_user_id = auth.uid() AND m.is_active
     ) THEN
    RETURN NULL;
  END IF;
  RETURN v_org;
END $$;
REVOKE ALL ON FUNCTION auth_org_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION auth_org_id() TO authenticated, service_role;

-- Direct PostgREST catalogue calls must honor the same product and web-role
-- boundary as save_menu_item/reorder_menu. Device/PIN writes retain their
-- existing contract; making that legacy path strict is a separate POS rollout.
CREATE FUNCTION catalog_table_access(p_write BOOLEAN)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT org_has_capability(auth_org_id(), 'catalog_manage') AND (
    auth_location_id() IS NOT NULL
    OR auth_backoffice_role() IN (
      'owner', 'manager', CASE WHEN NOT p_write THEN 'accountant' END
    )
  )
$$;
REVOKE ALL ON FUNCTION catalog_table_access(BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION catalog_table_access(BOOLEAN) TO authenticated, service_role;

DO $$
DECLARE v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['stations','menu_categories','menu_items',
    'item_variants','modifier_groups','modifiers','menu_item_modifier_groups',
    'modifier_supplies','variant_supplies'] LOOP
    EXECUTE format('CREATE POLICY catalog_read_boundary ON %I AS RESTRICTIVE FOR SELECT TO authenticated USING ((SELECT catalog_table_access(false)))', v_table);
    EXECUTE format('CREATE POLICY catalog_insert_boundary ON %I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK ((SELECT catalog_table_access(true)))', v_table);
    EXECUTE format('CREATE POLICY catalog_update_boundary ON %I AS RESTRICTIVE FOR UPDATE TO authenticated USING ((SELECT catalog_table_access(true))) WITH CHECK ((SELECT catalog_table_access(true)))', v_table);
    EXECUTE format('CREATE POLICY catalog_delete_boundary ON %I AS RESTRICTIVE FOR DELETE TO authenticated USING ((SELECT catalog_table_access(true)))', v_table);
  END LOOP;
END $$;

-- 129 replaced the public 105 wrapper, dropping its capability check. Preserve
-- all partial-payload/variant/supply behavior, but make the body private again.
ALTER FUNCTION save_menu_item(JSONB,JSONB,JSONB,UUID,UUID,JSONB)
  RENAME TO save_menu_item_129_impl;
REVOKE ALL ON FUNCTION save_menu_item_129_impl(JSONB,JSONB,JSONB,UUID,UUID,JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION save_menu_item(
  p_item JSONB, p_variants JSONB DEFAULT '[]', p_group_ids JSONB DEFAULT '[]',
  p_item_id UUID DEFAULT NULL, p_staff_session UUID DEFAULT NULL, p_supplies JSONB DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM require_org_capability('catalog_manage');
  RETURN save_menu_item_129_impl(p_item,p_variants,p_group_ids,p_item_id,p_staff_session,p_supplies);
END $$;
REVOKE ALL ON FUNCTION save_menu_item(JSONB,JSONB,JSONB,UUID,UUID,JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_menu_item(JSONB,JSONB,JSONB,UUID,UUID,JSONB) TO authenticated, service_role;

ALTER FUNCTION bulk_update_menu_items(JSONB,TEXT,BOOLEAN,UUID,NUMERIC,INTEGER,UUID)
  RENAME TO bulk_update_menu_items_128_impl;
REVOKE ALL ON FUNCTION bulk_update_menu_items_128_impl(JSONB,TEXT,BOOLEAN,UUID,NUMERIC,INTEGER,UUID)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION bulk_update_menu_items(
  p_ids JSONB, p_action TEXT, p_available BOOLEAN DEFAULT NULL, p_category_id UUID DEFAULT NULL,
  p_percent NUMERIC DEFAULT NULL, p_delta INTEGER DEFAULT NULL, p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM require_org_capability('catalog_manage');
  RETURN bulk_update_menu_items_128_impl(p_ids,p_action,p_available,p_category_id,p_percent,p_delta,p_staff_session);
END $$;
REVOKE ALL ON FUNCTION bulk_update_menu_items(JSONB,TEXT,BOOLEAN,UUID,NUMERIC,INTEGER,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION bulk_update_menu_items(JSONB,TEXT,BOOLEAN,UUID,NUMERIC,INTEGER,UUID) TO authenticated, service_role;

-- Operational data is not unlocked by a cached navigation context either.
-- Existing tenant/location RLS remains in force; these predicates only narrow it.
DO $$
DECLARE v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['online_orders','online_order_events'] LOOP
    EXECUTE format('CREATE POLICY product_read_boundary ON %I AS RESTRICTIVE FOR SELECT TO authenticated USING (org_has_capability_at(auth_org_id(),location_id,''orders_desk''))', v_table);
  END LOOP;
  FOREACH v_table IN ARRAY ARRAY['reservations','reservation_events','reservation_tables',
    'reservation_payments','reservation_funnel_events','waitlist_entries'] LOOP
    EXECUTE format('CREATE POLICY product_read_boundary ON %I AS RESTRICTIVE FOR SELECT TO authenticated USING (org_has_capability_at(auth_org_id(),location_id,''reservations_desk''))', v_table);
  END LOOP;
END $$;

-- Menu images are deliberately public guest assets, not private documents.
-- Writes also serve Reserve branding, so do not require catalogue for that product.
CREATE FUNCTION product_asset_write_access()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (auth_location_id() IS NOT NULL OR auth_backoffice_role() IN ('owner','manager'))
    AND (org_has_capability(auth_org_id(),'catalog_manage')
      OR org_has_capability(auth_org_id(),'public_reservations'))
$$;
REVOKE ALL ON FUNCTION product_asset_write_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION product_asset_write_access() TO authenticated, service_role;
CREATE POLICY product_image_insert_boundary ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (bucket_id <> 'menu-images' OR (SELECT product_asset_write_access()));
CREATE POLICY product_image_update_boundary ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (bucket_id <> 'menu-images' OR (SELECT product_asset_write_access()))
  WITH CHECK (bucket_id <> 'menu-images' OR (SELECT product_asset_write_access()));
CREATE POLICY product_image_delete_boundary ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
  USING (bucket_id <> 'menu-images' OR (SELECT product_asset_write_access()));

-- UUID foreign keys alone do not prove tenant ownership. Enforce references
-- for direct writes AND SECURITY DEFINER RPCs. Do not rewrite/delete old data,
-- change PostgREST relationship names, or reinterpret same-org locations.
CREATE FUNCTION check_catalog_tenant_references()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_org UUID := (v_row->>'org_id')::UUID;
  v_parent UUID;
  v_index INTEGER;
  v_valid BOOLEAN;
BEGIN
  FOR v_index IN 0..TG_NARGS / 2 - 1 LOOP
    v_parent := NULLIF(v_row->>TG_ARGV[v_index * 2], '')::UUID;
    IF v_parent IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE id=$1 AND org_id=$2)', TG_ARGV[v_index * 2 + 1])
        INTO v_valid USING v_parent, v_org;
      IF NOT v_valid THEN
        RAISE EXCEPTION 'catalog_reference_not_in_org' USING ERRCODE='23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION check_catalog_tenant_references() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER catalog_tenant_references BEFORE INSERT OR UPDATE ON stations
  FOR EACH ROW EXECUTE FUNCTION check_catalog_tenant_references('location_id','locations');
CREATE TRIGGER catalog_tenant_references BEFORE INSERT OR UPDATE ON menu_categories
  FOR EACH ROW EXECUTE FUNCTION check_catalog_tenant_references('location_id','locations');
CREATE TRIGGER catalog_tenant_references BEFORE INSERT OR UPDATE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION check_catalog_tenant_references('category_id','menu_categories','station_id','stations');
CREATE TRIGGER catalog_tenant_references BEFORE INSERT OR UPDATE ON item_variants
  FOR EACH ROW EXECUTE FUNCTION check_catalog_tenant_references('item_id','menu_items');
CREATE TRIGGER catalog_tenant_references BEFORE INSERT OR UPDATE ON modifiers
  FOR EACH ROW EXECUTE FUNCTION check_catalog_tenant_references('group_id','modifier_groups');
CREATE TRIGGER catalog_tenant_references BEFORE INSERT OR UPDATE ON menu_item_modifier_groups
  FOR EACH ROW EXECUTE FUNCTION check_catalog_tenant_references('item_id','menu_items','group_id','modifier_groups');
