-- A6.2: device identities, RPC ownership and stale signed claims after revocation.
-- Synthetic fixtures only; auth.users rows model actual issued identities.
BEGIN;
SELECT no_plan();
CREATE FUNCTION pg_temp.device_claims(p_user uuid,p_org uuid,p_location uuid DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',jsonb_build_object('sub',p_user,'role','authenticated',
    'app_metadata',jsonb_strip_nulls(jsonb_build_object('org_id',p_org,'location_id',p_location)))::text,true);
$$;

INSERT INTO orgs(id,name) VALUES
 ('a6200000-0000-4000-8000-000000000001','A6.2 Org A'),
 ('a6200000-0000-4000-8000-000000000002','A6.2 Org B');
INSERT INTO locations(id,org_id,name) VALUES
 ('a6210000-0000-4000-8000-000000000001','a6200000-0000-4000-8000-000000000001','A1'),
 ('a6210000-0000-4000-8000-000000000002','a6200000-0000-4000-8000-000000000001','A2'),
 ('a6210000-0000-4000-8000-000000000003','a6200000-0000-4000-8000-000000000002','B1');
INSERT INTO auth.users(id,raw_app_meta_data) VALUES
 ('a6220000-0000-4000-8000-000000000001','{"org_id":"a6200000-0000-4000-8000-000000000001"}'),
 ('a6220000-0000-4000-8000-000000000002','{"org_id":"a6200000-0000-4000-8000-000000000001","location_id":"a6210000-0000-4000-8000-000000000001"}'),
 ('a6220000-0000-4000-8000-000000000003','{"org_id":"a6200000-0000-4000-8000-000000000001","location_id":"a6210000-0000-4000-8000-000000000002"}'),
 ('a6220000-0000-4000-8000-000000000004','{"org_id":"a6200000-0000-4000-8000-000000000002","location_id":"a6210000-0000-4000-8000-000000000003"}');
INSERT INTO organization_members(org_id,auth_user_id,role) VALUES
 ('a6200000-0000-4000-8000-000000000001','a6220000-0000-4000-8000-000000000001','owner');
INSERT INTO devices(id,org_id,location_id,auth_user_id,device_uuid,name,settings,archived_at,outbox_pending) VALUES
 ('a6230000-0000-4000-8000-000000000001','a6200000-0000-4000-8000-000000000001','a6210000-0000-4000-8000-000000000001','a6220000-0000-4000-8000-000000000002','a6240000-0000-4000-8000-000000000001','Device A1','{"protected":true}',NULL,0),
 ('a6230000-0000-4000-8000-000000000002','a6200000-0000-4000-8000-000000000001','a6210000-0000-4000-8000-000000000002','a6220000-0000-4000-8000-000000000003','a6240000-0000-4000-8000-000000000002','Device A2','{}',NULL,0),
 ('a6230000-0000-4000-8000-000000000003','a6200000-0000-4000-8000-000000000002','a6210000-0000-4000-8000-000000000003','a6220000-0000-4000-8000-000000000004','a6240000-0000-4000-8000-000000000003','Device B1','{}',NULL,0);

SET LOCAL ROLE authenticated;
SELECT pg_temp.device_claims('a6220000-0000-4000-8000-000000000001','a6200000-0000-4000-8000-000000000001');
SELECT is(jsonb_array_length(get_backoffice_fleet()),2,'digital owner sees only their two devices');
SELECT throws_ok($$SELECT rename_device_web('a6230000-0000-4000-8000-000000000003','foreign')$$,
 'P0001','not_found','owner cannot rename foreign device');
SELECT throws_ok($$SELECT uf_export_info_web('a6210000-0000-4000-8000-000000000003')$$,
 'P0001','location not in organization','owner cannot export foreign location');
SELECT lives_ok($$SELECT update_location_config_web('a6210000-0000-4000-8000-000000000002','{"name":"A2 configured"}')$$,
 'owner can configure another location in the same organization');

SELECT pg_temp.device_claims('a6220000-0000-4000-8000-000000000002','a6200000-0000-4000-8000-000000000001','a6210000-0000-4000-8000-000000000001');
SELECT is(auth_org_id(),'a6200000-0000-4000-8000-000000000001'::uuid,'active device identity retains tenant');
SELECT lives_ok($$SELECT register_device('a6240000-0000-4000-8000-000000000001','Device A1','{"own":1}')$$,
 'same device registration is idempotent');
SELECT is((SELECT count(*) FROM devices),2::bigint,'device table read excludes other organization');
SELECT throws_ok($$SELECT update_device_settings('a6240000-0000-4000-8000-000000000002','{"attack":true}')$$,
 'P0001','device not found','device cannot patch another account settings directly');
SELECT throws_ok($$SELECT get_backoffice_fleet()$$,'P0001','staff session required','device is not implicitly a web manager');

SELECT pg_temp.device_claims('a6220000-0000-4000-8000-000000000003','a6200000-0000-4000-8000-000000000001','a6210000-0000-4000-8000-000000000002');
SELECT throws_ok($$SELECT register_device('a6240000-0000-4000-8000-000000000001','stolen','{"protected":false}')$$,
 'P0001','device_identity_conflict','register_device cannot take over another account UUID');
RESET ROLE;
SELECT is((SELECT auth_user_id FROM devices WHERE id='a6230000-0000-4000-8000-000000000001'),
 'a6220000-0000-4000-8000-000000000002'::uuid,'registration refusal preserves device owner');
-- Restore only test metadata after a failing baseline assertion so revocation is independent.
UPDATE devices SET auth_user_id='a6220000-0000-4000-8000-000000000002',name='Device A1',settings='{"protected":true}'
 WHERE id='a6230000-0000-4000-8000-000000000001';

SET LOCAL ROLE authenticated;
SELECT pg_temp.device_claims('a6220000-0000-4000-8000-000000000002','a6200000-0000-4000-8000-000000000001','a6210000-0000-4000-8000-000000000001');
SELECT throws_ok($$UPDATE devices SET location_id='a6210000-0000-4000-8000-000000000003'
 WHERE id='a6230000-0000-4000-8000-000000000001'$$,'23514',NULL,'direct device write cannot reference a foreign tenant location');
RESET ROLE;
UPDATE devices SET location_id='a6210000-0000-4000-8000-000000000001' WHERE id='a6230000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT pg_temp.device_claims('a6220000-0000-4000-8000-000000000001','a6200000-0000-4000-8000-000000000001');
SELECT lives_ok($$SELECT set_device_archived_web('a6230000-0000-4000-8000-000000000001',true)$$,'archive is allowed');
SELECT pg_temp.device_claims('a6220000-0000-4000-8000-000000000002','a6200000-0000-4000-8000-000000000001','a6210000-0000-4000-8000-000000000001');
SELECT is(auth_org_id(),'a6200000-0000-4000-8000-000000000001'::uuid,'archive intentionally does not revoke access');
SELECT pg_temp.device_claims('a6220000-0000-4000-8000-000000000001','a6200000-0000-4000-8000-000000000001');
SELECT is(delete_device_web('a6230000-0000-4000-8000-000000000001')::jsonb->>'access_revoked','true','delete revokes dedicated device account');
SELECT pg_temp.device_claims('a6220000-0000-4000-8000-000000000002','a6200000-0000-4000-8000-000000000001','a6210000-0000-4000-8000-000000000001');
SELECT is(auth_org_id(),NULL::uuid,'deleted account old JWT cannot resolve organization');
SELECT is(auth_location_id(),NULL::uuid,'deleted account old JWT cannot resolve location');
SELECT is((SELECT count(*) FROM locations),0::bigint,'deleted account old JWT cannot read locations');
SELECT throws_ok($$SELECT register_device('a6240000-0000-4000-8000-000000000001')$$,
 'P0001','not authenticated','deleted account old JWT cannot resurrect device');
SELECT throws_ok($$SELECT org_billing_state()$$,'P0001','not authenticated','deleted account old JWT cannot read billing');
RESET ROLE;
SELECT is((SELECT count(*) FROM devices WHERE auth_user_id='a6220000-0000-4000-8000-000000000002'),0::bigint,'deleted device remains absent');
SELECT is((SELECT count(*) FROM auth.users WHERE id='a6220000-0000-4000-8000-000000000003'),1::bigint,'other device account remains intact');
SET LOCAL ROLE authenticated;
SELECT pg_temp.device_claims('a6220000-0000-4000-8000-000000000003','a6200000-0000-4000-8000-000000000001','a6210000-0000-4000-8000-000000000002');
SELECT is(auth_location_id(),'a6210000-0000-4000-8000-000000000002'::uuid,'other active device continues working');
SELECT lives_ok($$SELECT register_device('a6240000-0000-4000-8000-000000000006','New terminal')$$,
 'fresh UUID registration works, including another physical device on shared account');

RESET ROLE;
UPDATE auth.users SET banned_until=NOW()+INTERVAL '1 day'
 WHERE id='a6220000-0000-4000-8000-000000000003';
SET LOCAL ROLE authenticated;
SELECT is(auth_org_id(),NULL::uuid,'banned device old JWT loses tenant');
SELECT is(auth_location_id(),NULL::uuid,'banned device old JWT loses location');
SELECT throws_ok($$SELECT register_device('a6240000-0000-4000-8000-000000000002')$$,
 'P0001','not authenticated','banned device cannot register again');
RESET ROLE;
UPDATE auth.users SET banned_until=NOW()-INTERVAL '1 second'
 WHERE id='a6220000-0000-4000-8000-000000000003';
SET LOCAL ROLE authenticated;
SELECT is(auth_org_id(),'a6200000-0000-4000-8000-000000000001'::uuid,'expired ban permits the existing account again');
SELECT pg_temp.device_claims('a6220000-0000-4000-8000-000000000003','a6200000-0000-4000-8000-000000000001','a6210000-0000-4000-8000-000000000003');
SELECT is(auth_org_id(),NULL::uuid,'mismatched signed org/location claims fail closed');

-- Removing a fleet row is NOT account revocation for shared or human accounts.
RESET ROLE;
INSERT INTO devices(id,org_id,location_id,auth_user_id,device_uuid,name,archived_at,outbox_pending) VALUES
 ('a6230000-0000-4000-8000-000000000004','a6200000-0000-4000-8000-000000000001','a6210000-0000-4000-8000-000000000002','a6220000-0000-4000-8000-000000000003','a6240000-0000-4000-8000-000000000004','Shared',NOW(),0),
 ('a6230000-0000-4000-8000-000000000005','a6200000-0000-4000-8000-000000000001','a6210000-0000-4000-8000-000000000001','a6220000-0000-4000-8000-000000000001','a6240000-0000-4000-8000-000000000005','Human',NOW(),0);
SET LOCAL ROLE authenticated;
SELECT pg_temp.device_claims('a6220000-0000-4000-8000-000000000001','a6200000-0000-4000-8000-000000000001');
SELECT is(delete_device_web('a6230000-0000-4000-8000-000000000004')::jsonb->>'reason','account_shared','shared account deletion reports no account revocation');
SELECT is(delete_device_web('a6230000-0000-4000-8000-000000000005')::jsonb->>'reason','account_is_member','human account is not deleted with fleet row');
SELECT pg_temp.device_claims('a6220000-0000-4000-8000-000000000003','a6200000-0000-4000-8000-000000000001','a6210000-0000-4000-8000-000000000002');
SELECT lives_ok($$SELECT register_device('a6240000-0000-4000-8000-000000000002')$$,'other device on shared account still registers');
SELECT pg_temp.device_claims('a6220000-0000-4000-8000-000000000001','a6200000-0000-4000-8000-000000000001','a6210000-0000-4000-8000-000000000001');
SELECT is(auth_backoffice_role(),'owner','combined account uses live web membership');
RESET ROLE;
UPDATE organization_members SET is_active=false WHERE auth_user_id='a6220000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT is(auth_backoffice_role(),NULL::text,'combined account loses web role after membership revocation');
SELECT is(auth_org_id(),'a6200000-0000-4000-8000-000000000001'::uuid,'membership revocation alone does not revoke separate device identity');
SELECT throws_ok($$SELECT get_backoffice_fleet()$$,'P0001','staff session required','combined account no longer bypasses web management with old JWT');
SELECT pg_temp.device_claims('a6220000-0000-4000-8000-000000000001','a6200000-0000-4000-8000-000000000001');
SELECT is(auth_org_id(),NULL::uuid,'same revoked account without a device claim has no digital tenant');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
