import { describe, expect, it } from 'vitest'
import { resolvePublicHeroVideo } from './heroVideo'

const BULOCHKA = 'fe2eebf0-65e3-45b4-a81f-331359d71955'
const LEGACY_UPLOAD =
  'https://qgmnxrgtlpyqglwqmsej.supabase.co/storage/v1/object/public/menu-images/c31c811a-3c95-4a47-9f54-9142dbab5be8/hero-videos/80c50a7c-3a21-4ae5-b8ac-550b9928edb9.mp4'

describe('resolvePublicHeroVideo', () => {
  it('uses the optimized bundled Bulochka video for the legacy upload', () => {
    expect(resolvePublicHeroVideo(BULOCHKA, LEGACY_UPLOAD)).toBe(
      '/brand/bulochka/hero.mp4?v=3',
    )
  })

  it('uses the bundled showcase video when no upload is configured', () => {
    expect(resolvePublicHeroVideo(BULOCHKA, null)).toBe(
      '/brand/bulochka/hero.mp4?v=3',
    )
  })

  it('keeps a later owner upload', () => {
    expect(resolvePublicHeroVideo(BULOCHKA, 'https://cdn.example.com/new.mp4')).toBe(
      'https://cdn.example.com/new.mp4',
    )
  })

  it('does not add showcase media to other locations', () => {
    expect(resolvePublicHeroVideo('another-location', null)).toBeNull()
  })
})
