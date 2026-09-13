-- A6.2: subscriptions are per location; the shared catalogue is per organization.
BEGIN;
SELECT no_plan();
INSERT INTO orgs(id,name) VALUES
 ('a6300000-0000-4000-8000-000000000001','Multi A'),
 ('a6300000-0000-4000-8000-000000000002','Multi B');
INSERT INTO locations(id,org_id,name) VALUES
 ('a6310000-0000-4000-8000-000000000001','a6300000-0000-4000-8000-000000000001','A1 Menu'),
 ('a6310000-0000-4000-8000-000000000002','a6300000-0000-4000-8000-000000000001','A2 Orders Reserve'),
 ('a6310000-0000-4000-8000-000000000003','a6300000-0000-4000-8000-000000000002','B1');
INSERT INTO auth.users(id) VALUES ('a6320000-0000-4000-8000-000000000001');
INSERT INTO organization_members(org_id,auth_user_id,role) VALUES
 ('a6300000-0000-4000-8000-000000000001','a6320000-0000-4000-8000-000000000001','owner');
INSERT INTO subscriptions(org_id,location_id,product,status,unit_price_agorot,current_period_end,grace_days) VALUES
 ('a6300000-0000-4000-8000-000000000001','a6310000-0000-4000-8000-000000000001','menu','active',4900,NOW()+INTERVAL '1 day',0),
 ('a6300000-0000-4000-8000-000000000001','a6310000-0000-4000-8000-000000000002','online_orders','active',9900,NOW()+INTERVAL '1 day',0),
 ('a6300000-0000-4000-8000-000000000001','a6310000-0000-4000-8000-000000000002','reservations','active',9900,NOW()+INTERVAL '1 day',0),
 ('a6300000-0000-4000-8000-000000000002','a6310000-0000-4000-8000-000000000003','pos','active',14900,NOW()+INTERVAL '1 day',0);
INSERT INTO invoices(org_id,number,period_start,period_end,status,total_agorot) VALUES
 ('a6300000-0000-4000-8000-000000000001','A6.2-A',NOW(),NOW()+INTERVAL '1 day','paid',4900),
 ('a6300000-0000-4000-8000-000000000002','A6.2-B',NOW(),NOW()+INTERVAL '1 day','paid',14900);
CREATE FUNCTION pg_temp.cap(p_location uuid,p_cap text) RETURNS boolean LANGUAGE sql AS $$
 SELECT org_has_capability_at(auth_org_id(),p_location,p_cap)
$$;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims='{"sub":"a6320000-0000-4000-8000-000000000001","app_metadata":{"org_id":"a6300000-0000-4000-8000-000000000001"}}';
SELECT ok(pg_temp.cap('a6310000-0000-4000-8000-000000000001','public_menu'),'A1 Menu has public menu');
SELECT ok(NOT pg_temp.cap('a6310000-0000-4000-8000-000000000001','online_orders'),'A1 does not inherit A2 Orders');
SELECT ok(NOT pg_temp.cap('a6310000-0000-4000-8000-000000000001','reservations_desk'),'A1 does not inherit A2 Reserve');
SELECT ok(pg_temp.cap('a6310000-0000-4000-8000-000000000002','online_orders'),'A2 has Orders');
SELECT ok(pg_temp.cap('a6310000-0000-4000-8000-000000000002','public_menu'),'Orders intentionally includes public menu');
SELECT ok(pg_temp.cap('a6310000-0000-4000-8000-000000000002','reservations_desk'),'A2 has Reserve');
SELECT ok(NOT pg_temp.cap('a6310000-0000-4000-8000-000000000003','pos_operate'),'foreign location subscription grants no access to A');
SELECT is((SELECT count(*) FROM subscriptions),3::bigint,'owner sees only own organization subscriptions');
SELECT is((SELECT count(*) FROM invoices),1::bigint,'owner cannot read other organization invoice');
SELECT throws_ok($$UPDATE subscriptions SET current_period_end=NOW()+INTERVAL '1 year'$$,'42501',NULL,'owner cannot extend subscription through table writes');
SELECT throws_ok($$SELECT update_location_config_web('a6310000-0000-4000-8000-000000000003','{"name":"foreign"}')$$,
 'P0001','location not in organization','web location config rejects foreign point');
RESET ROLE;
UPDATE subscriptions SET current_period_end=NOW()-INTERVAL '1 second'
 WHERE org_id='a6300000-0000-4000-8000-000000000001' AND product='menu';
SET LOCAL ROLE authenticated;
SELECT ok(NOT pg_temp.cap('a6310000-0000-4000-8000-000000000001','public_menu'),'expired A1 Menu is not rescued by A2 Orders aggregate');
SELECT ok(pg_temp.cap('a6310000-0000-4000-8000-000000000002','online_orders'),'A2 Orders survives A1 expiry');
SELECT ok(pg_temp.cap('a6310000-0000-4000-8000-000000000002','reservations_desk'),'A2 Reserve survives A1 expiry');
SELECT is((SELECT count(*) FROM invoices WHERE number='A6.2-A' AND total_agorot=4900),1::bigint,'expiry preserves own paid invoice unchanged');
SELECT lives_ok($$SELECT org_billing_state()$$,'expiry does not remove account billing/history access');
RESET ROLE;
UPDATE organization_members SET role='manager' WHERE auth_user_id='a6320000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT is(auth_backoffice_role(),'manager','manager uses current membership, not cached role');
SELECT lives_ok($$SELECT update_location_config_web('a6310000-0000-4000-8000-000000000002','{"name":"A2 updated"}')$$,'manager may configure own organization other point');
SELECT throws_ok($$SELECT uf_export_info_web('a6310000-0000-4000-8000-000000000003')$$,
 'P0001','location not in organization','manager cannot export foreign location');
RESET ROLE;
-- Manual grants are deliberately organization-wide, not a subscription bypass.
INSERT INTO organization_products(org_id,product,source) VALUES ('a6300000-0000-4000-8000-000000000001','menu','manual')
 ON CONFLICT(org_id,product) DO UPDATE SET source='manual',is_active=true,status='active',expires_at=NULL;
SET LOCAL ROLE authenticated;
SELECT ok(pg_temp.cap('a6310000-0000-4000-8000-000000000001','public_menu'),'explicit manual organization grant covers expired point');
SELECT throws_ok($$SELECT uf_export_info_web('a6310000-0000-4000-8000-000000000003')$$,
 'P0001','location not in organization','manual grant still cannot cross tenant wrapper');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
