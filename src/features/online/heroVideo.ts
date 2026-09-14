const BULOCHKA_LOCATION_ID = 'fe2eebf0-65e3-45b4-a81f-331359d71955'
const BULOCHKA_BUNDLED_HERO = '/brand/bulochka/hero.mp4?v=3'

// This upload is the original 4.6 MB source now replaced by the optimized
// bundled asset. A later owner upload must still take precedence.
const BULOCHKA_LEGACY_UPLOAD =
  'https://qgmnxrgtlpyqglwqmsej.supabase.co/storage/v1/object/public/menu-images/c31c811a-3c95-4a47-9f54-9142dbab5be8/hero-videos/80c50a7c-3a21-4ae5-b8ac-550b9928edb9.mp4'

export function resolvePublicHeroVideo(
  locationId: string,
  configuredUrl?: string | null,
): string | null {
  if (locationId !== BULOCHKA_LOCATION_ID) return configuredUrl ?? null
  if (!configuredUrl || configuredUrl === BULOCHKA_LEGACY_UPLOAD) {
    return BULOCHKA_BUNDLED_HERO
  }
  return configuredUrl
}
