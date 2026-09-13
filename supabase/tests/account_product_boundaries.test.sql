-- A6: actual authenticated role, two synthetic tenants, no live Auth/provider.
BEGIN;
SELECT no_plan();
SELECT ok(NOT has_function_privilege('authenticated','save_menu_item_129_impl(jsonb,jsonb,jsonb,uuid,uuid,jsonb)','EXECUTE'),'client cannot call ungated save body');
SELECT ok(NOT has_function_privilege('authenticated','bulk_update_menu_items_128_impl(jsonb,text,boolean,uuid,numeric,integer,uuid)','EXECUTE'),'client cannot call ungated bulk body');
SELECT ok(NOT has_function_privilege('authenticated','check_catalog_tenant_references()','EXECUTE'),'reference trigger function is not a public RPC');

INSERT INTO orgs(id,name) VALUES
 ('a6000000-0000-4000-8000-000000000001','A6 A'),
 ('a6000000-0000-4000-8000-000000000002','A6 B');
INSERT INTO locations(id,org_id,name) VALUES
 ('a6100000-0000-4000-8000-000000000001','a6000000-0000-4000-8000-000000000001','A'),
 ('a6100000-0000-4000-8000-000000000002','a6000000-0000-4000-8000-000000000002','B');
INSERT INTO auth.users(id,raw_app_meta_data) VALUES
 ('a6200000-0000-4000-8000-000000000001','{"org_id":"a6000000-0000-4000-8000-000000000001"}'),
 ('a6200000-0000-4000-8000-000000000002','{"org_id":"a6000000-0000-4000-8000-000000000002"}');
INSERT INTO organization_members(org_id,auth_user_id,role) VALUES
 ('a6000000-0000-4000-8000-000000000001','a6200000-0000-4000-8000-000000000001','owner'),
 ('a6000000-0000-4000-8000-000000000002','a6200000-0000-4000-8000-000000000002','owner');
INSERT INTO menu_categories(id,org_id,location_id,name) VALUES
 ('a6300000-0000-4000-8000-000000000001','a6000000-0000-4000-8000-000000000001','a6100000-0000-4000-8000-000000000001','A category'),
 ('a6300000-0000-4000-8000-000000000002','a6000000-0000-4000-8000-000000000002','a6100000-0000-4000-8000-000000000002','B category');
INSERT INTO menu_items(id,org_id,category_id,name,price) VALUES
 ('a6400000-0000-4000-8000-000000000001','a6000000-0000-4000-8000-000000000001','a6300000-0000-4000-8000-000000000001','A item',1000),
 ('a6400000-0000-4000-8000-000000000002','a6000000-0000-4000-8000-000000000002','a6300000-0000-4000-8000-000000000002','B item',2000);
INSERT INTO modifier_groups(id,org_id,name) VALUES
 ('a6500000-0000-4000-8000-000000000001','a6000000-0000-4000-8000-000000000001','A group'),
 ('a6500000-0000-4000-8000-000000000002','a6000000-0000-4000-8000-000000000002','B group');
INSERT INTO subscriptions(id,org_id,location_id,product,status,unit_price_agorot) VALUES
 ('a6600000-0000-4000-8000-000000000001','a6000000-0000-4000-8000-000000000001','a6100000-0000-4000-8000-000000000001','menu','suspended',4900),
 ('a6600000-0000-4000-8000-000000000002','a6000000-0000-4000-8000-000000000002','a6100000-0000-4000-8000-000000000002','menu','suspended',4900);
INSERT INTO online_orders(id,org_id,location_id,client_uuid,customer_name,customer_phone,items,subtotal,total) VALUES
 ('a6700000-0000-4000-8000-000000000001','a6000000-0000-4000-8000-000000000001','a6100000-0000-4000-8000-000000000001','a6710000-0000-4000-8000-000000000001','A guest','0501111111','[]',100,100),
 ('a6700000-0000-4000-8000-000000000002','a6000000-0000-4000-8000-000000000002','a6100000-0000-4000-8000-000000000002','a6710000-0000-4000-8000-000000000002','B guest','0502222222','[]',200,200);
INSERT INTO reservations(id,org_id,location_id,client_uuid,customer_name,customer_phone,party_size,reserved_at) VALUES
 ('a6800000-0000-4000-8000-000000000001','a6000000-0000-4000-8000-000000000001','a6100000-0000-4000-8000-000000000001','a6810000-0000-4000-8000-000000000001','A guest','0501111111',2,NOW()+INTERVAL '1 day'),
 ('a6800000-0000-4000-8000-000000000002','a6000000-0000-4000-8000-000000000002','a6100000-0000-4000-8000-000000000002','a6810000-0000-4000-8000-000000000002','B guest','0502222222',2,NOW()+INTERVAL '1 day');
INSERT INTO storage.buckets(id,name,public) VALUES ('menu-images','menu-images',true) ON CONFLICT DO NOTHING;

SET LOCAL request.jwt.claims = '{"sub":"a6200000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"a6000000-0000-4000-8000-000000000001"}}';
SET LOCAL ROLE authenticated;
SELECT is(get_backoffice_context()->'products','[]'::jsonb,'unpaid owner has no active products');
SELECT is((SELECT count(*) FROM menu_items),0::bigint,'unpaid owner cannot read catalogue directly');
SELECT is((SELECT count(*) FROM online_orders),0::bigint,'unpaid owner cannot bypass Orders read gate');
SELECT is((SELECT count(*) FROM reservations),0::bigint,'unpaid owner cannot bypass Reserve read gate');
SELECT throws_ok($$SELECT save_menu_item('{"name":"unpaid RPC","price":100,"category_id":"a6300000-0000-4000-8000-000000000001"}')$$,
 'P0001','module_disabled','save_menu_item retains the capability gate after 129');
SELECT throws_ok($$SELECT bulk_update_menu_items('["a6400000-0000-4000-8000-000000000001"]','availability',false)$$,
 'P0001','module_disabled','bulk catalogue RPC also requires a product');
SELECT throws_ok($$INSERT INTO modifier_groups(org_id,name) VALUES ('a6000000-0000-4000-8000-000000000001','unpaid direct')$$,
 '42501',NULL,'direct catalogue insert cannot bypass unpaid subscription');
SELECT throws_ok($$INSERT INTO storage.objects(bucket_id,name) VALUES ('menu-images','a6000000-0000-4000-8000-000000000001/unpaid.jpg')$$,
 '42501',NULL,'unpaid owner cannot upload product assets');
SELECT results_eq('SELECT id FROM subscriptions', $$VALUES ('a6600000-0000-4000-8000-000000000001'::uuid)$$,
 'unpaid owner retains own billing history, never foreign history');
SELECT throws_ok($$SELECT uf_export_info_web('a6100000-0000-4000-8000-000000000002')$$,
 'P0001','location not in organization','foreign fiscal export denied even without subscription gate');
RESET ROLE;

INSERT INTO organization_products(org_id,product,source) VALUES ('a6000000-0000-4000-8000-000000000001','menu','manual')
 ON CONFLICT(org_id,product) DO UPDATE SET is_active=true,status='active',source='manual',expires_at=NULL;
SET LOCAL ROLE authenticated;
SELECT ok(EXISTS(SELECT 1 FROM menu_items WHERE id='a6400000-0000-4000-8000-000000000001'),'Menu-only may read its own catalogue');
SELECT is((SELECT count(*) FROM online_orders),0::bigint,'Menu-only cannot read Orders directly');
SELECT is((SELECT count(*) FROM online_order_events),0::bigint,'Menu-only cannot read Orders event history');
SELECT is((SELECT count(*) FROM reservations),0::bigint,'Menu-only cannot read Reserve directly');
RESET ROLE;
UPDATE organization_products SET is_active=false WHERE org_id='a6000000-0000-4000-8000-000000000001';
-- Reserve does not include catalogue. Orders does include it without Menu.
INSERT INTO organization_products(org_id,product) VALUES ('a6000000-0000-4000-8000-000000000001','reservations');
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*) FROM menu_items),0::bigint,'Reserve-only has no catalogue read');
SELECT results_eq('SELECT id FROM reservations', $$VALUES ('a6800000-0000-4000-8000-000000000001'::uuid)$$,'Reserve-only sees its own bookings, not foreign bookings');
SELECT is((SELECT count(*) FROM online_orders),0::bigint,'Reserve-only has no Orders reads');
SELECT lives_ok($$INSERT INTO storage.objects(bucket_id,name) VALUES ('menu-images','a6000000-0000-4000-8000-000000000001/reserve.jpg')$$,
 'Reserve owner may upload its branding without Menu');
SELECT throws_ok($$SELECT save_menu_item('{"name":"Reserve RPC","price":100,"category_id":"a6300000-0000-4000-8000-000000000001"}')$$,
 'P0001','module_disabled','Reserve-only has no catalogue mutation');
RESET ROLE;
UPDATE organization_products SET is_active=false WHERE org_id='a6000000-0000-4000-8000-000000000001';
INSERT INTO organization_products(org_id,product) VALUES ('a6000000-0000-4000-8000-000000000001','online_orders');
SET LOCAL ROLE authenticated;
SELECT results_eq($$SELECT id FROM menu_items WHERE id IN ('a6400000-0000-4000-8000-000000000001','a6400000-0000-4000-8000-000000000002')$$, $$VALUES ('a6400000-0000-4000-8000-000000000001'::uuid)$$,
 'Orders includes catalogue, scoped to its own tenant');
SELECT results_eq('SELECT id FROM online_orders', $$VALUES ('a6700000-0000-4000-8000-000000000001'::uuid)$$,'Orders-only sees its own orders, not foreign orders');
SELECT is((SELECT count(*) FROM reservations),0::bigint,'Orders-only cannot read Reserve');
SELECT is((SELECT count(*) FROM reservation_events),0::bigint,'Orders-only cannot read Reserve event history');
SELECT lives_ok($$INSERT INTO modifier_groups(org_id,name) VALUES ('a6000000-0000-4000-8000-000000000001','paid owner direct')$$,
 'active owner may manage own catalogue directly');
SELECT throws_ok($$SELECT save_menu_item('{"name":"foreign category","price":100,"category_id":"a6300000-0000-4000-8000-000000000002"}')$$,
 '23514','catalog_reference_not_in_org','RPC cannot attach own item to foreign category');
SELECT throws_ok($$INSERT INTO item_variants(org_id,item_id,name,price) VALUES ('a6000000-0000-4000-8000-000000000001','a6400000-0000-4000-8000-000000000002','foreign variant',100)$$,
 '23514','catalog_reference_not_in_org','direct variant cannot attach to foreign item');
SELECT throws_ok($$INSERT INTO modifiers(org_id,group_id,name) VALUES ('a6000000-0000-4000-8000-000000000001','a6500000-0000-4000-8000-000000000002','foreign modifier')$$,
 '23514','catalog_reference_not_in_org','direct modifier cannot attach to foreign group');
SELECT throws_ok($$SELECT save_menu_item('{"name":"foreign group","price":100,"category_id":"a6300000-0000-4000-8000-000000000001"}','[]','["a6500000-0000-4000-8000-000000000002"]')$$,
 '23514','catalog_reference_not_in_org','RPC cannot attach foreign modifier group');
SELECT throws_ok($$INSERT INTO menu_categories(org_id,location_id,name) VALUES ('a6000000-0000-4000-8000-000000000001','a6100000-0000-4000-8000-000000000002','foreign location')$$,
 '23514','catalog_reference_not_in_org','direct category cannot reference foreign location');
SELECT throws_ok($$INSERT INTO storage.objects(bucket_id,name) VALUES ('menu-images','a6000000-0000-4000-8000-000000000002/foreign.jpg')$$,
 '42501',NULL,'active owner cannot upload into a foreign tenant folder');
UPDATE menu_items SET name='cross-tenant attack' WHERE id='a6400000-0000-4000-8000-000000000002';
RESET ROLE;
SELECT is((SELECT name FROM menu_items WHERE id='a6400000-0000-4000-8000-000000000002'),'B item','foreign item unchanged');

UPDATE organization_members SET role='accountant' WHERE auth_user_id='a6200000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT ok(EXISTS(SELECT 1 FROM menu_items WHERE id='a6400000-0000-4000-8000-000000000001'),'active read-only member may read');
SELECT throws_ok($$INSERT INTO modifier_groups(org_id,name) VALUES ('a6000000-0000-4000-8000-000000000001','accountant mutation')$$,
 '42501',NULL,'read-only member cannot bypass manage via direct insert');
SELECT throws_ok($$INSERT INTO storage.objects(bucket_id,name) VALUES ('menu-images','a6000000-0000-4000-8000-000000000001/accountant.jpg')$$,
 '42501',NULL,'read-only member cannot mutate product images');
UPDATE menu_items SET name='accountant mutation' WHERE id='a6400000-0000-4000-8000-000000000001';
SELECT is((SELECT name FROM menu_items WHERE id='a6400000-0000-4000-8000-000000000001'),'A item','read-only member cannot bypass manage via direct update');
DELETE FROM menu_items WHERE id='a6400000-0000-4000-8000-000000000001';
SELECT ok(EXISTS(SELECT 1 FROM menu_items WHERE id='a6400000-0000-4000-8000-000000000001'),'read-only member cannot bypass manage via delete');
RESET ROLE;

UPDATE organization_members SET role='owner',is_active=false WHERE auth_user_id='a6200000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT is(auth_org_id(),NULL::uuid,'revoked digital membership invalidates stale org claim');
CREATE TEMP TABLE organization_members(org_id UUID,auth_user_id UUID,is_active BOOLEAN);
INSERT INTO pg_temp.organization_members VALUES ('a6000000-0000-4000-8000-000000000001','a6200000-0000-4000-8000-000000000001',true);
SELECT is(auth_org_id(),NULL::uuid,'temporary relations cannot shadow the membership authority');
DROP TABLE pg_temp.organization_members;
SELECT is((SELECT count(*) FROM menu_items),0::bigint,'revoked owner has no direct catalogue reads');
SELECT is((SELECT count(*) FROM locations),0::bigint,'revoked owner has no direct location reads');
SELECT is((SELECT count(*) FROM subscriptions),0::bigint,'revoked owner has no direct billing history reads');
SELECT is((SELECT count(*) FROM online_orders),0::bigint,'revoked owner has no direct operational reads');
SELECT throws_ok('SELECT org_billing_state()','P0001','not authenticated','revoked owner cannot read billing via RPC');
RESET ROLE;
DELETE FROM organization_members WHERE auth_user_id='a6200000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT is(auth_org_id(),NULL::uuid,'deleted digital membership does not restore JWT access');
SELECT is((SELECT count(*) FROM orgs),0::bigint,'deleted membership has no tenant root access');
RESET ROLE;

INSERT INTO organization_members(org_id,auth_user_id,role) VALUES ('a6000000-0000-4000-8000-000000000001','a6200000-0000-4000-8000-000000000001','owner');
UPDATE organization_products SET expires_at=NOW()-INTERVAL '1 second' WHERE org_id='a6000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*) FROM menu_items),0::bigint,'expired subscription closes catalogue without cron');
SELECT is((SELECT count(*) FROM online_orders),0::bigint,'expired subscription closes Orders reads without cron');
SELECT results_eq('SELECT id FROM subscriptions', $$VALUES ('a6600000-0000-4000-8000-000000000001'::uuid)$$,
 'expiry keeps own billing history accessible to active owner');
RESET ROLE;
SELECT ok(EXISTS(SELECT 1 FROM menu_items WHERE id='a6400000-0000-4000-8000-000000000001'),'expiry never deletes catalogue data');
SELECT * FROM finish();
ROLLBACK;
