import { describe, expect, it } from 'vitest'
import { photoFit } from './photoFit'

// Пропорции настоящих фото меню Bulochka (октябрь 2026) и рамок страницы.
const LANDSCAPE = 900 / 600 // кофе, выпечка
const SQUARE = 900 / 899 // бутылки соков
const PORTRAIT = 900 / 1349 // вертикальные бутылки
const WIDE = 1376 / 768 // «עוגת הבית»
const TILE = 4 / 3
const THUMB = 1
const PHONE_DETAIL = 390 / 439
const TABLET_DETAIL = 678 / 820

describe('photoFit', () => {
  it('a 3:2 photo in a 4:3 tile loses only a little at the sides', () => {
    expect(photoFit(LANDSCAPE, TILE)).toBe('cover')
  })

  it('bottles are never cut top and bottom in a tile', () => {
    expect(photoFit(SQUARE, TILE)).toBe('contain')
    expect(photoFit(PORTRAIT, TILE)).toBe('contain')
  })

  it('a very wide photo is shown whole instead of losing its sides', () => {
    expect(photoFit(WIDE, TILE)).toBe('contain')
  })

  it('square thumbnails: square photos fill, others are shown whole', () => {
    expect(photoFit(SQUARE, THUMB)).toBe('cover')
    expect(photoFit(LANDSCAPE, THUMB)).toBe('contain')
    expect(photoFit(PORTRAIT, THUMB)).toBe('contain')
  })

  it('tall item card: a croissant photo is shown whole, a square bottle fills it', () => {
    expect(photoFit(LANDSCAPE, PHONE_DETAIL)).toBe('contain')
    expect(photoFit(LANDSCAPE, TABLET_DETAIL)).toBe('contain')
    expect(photoFit(SQUARE, PHONE_DETAIL)).toBe('cover')
    expect(photoFit(SQUARE, TABLET_DETAIL)).toBe('cover')
  })

  it('falls back to cover while a size is unknown', () => {
    expect(photoFit(0, TILE)).toBe('cover')
    expect(photoFit(LANDSCAPE, Number.NaN)).toBe('cover')
  })
})
