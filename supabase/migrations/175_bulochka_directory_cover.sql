-- Use the approved horizontal venue photo for Bulochka's ANGLE Guest card.
-- The asset is bundled with the public guest application so it stays fast and
-- does not depend on an operator-owned external URL.
UPDATE restaurant_directory_profiles
SET
  hero_url = '/brand/bulochka/directory-cover.webp',
  updated_at = NOW()
WHERE location_id = 'fe2eebf0-65e3-45b4-a81f-331359d71955';
