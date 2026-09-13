import { beforeEach, describe, expect, it } from 'vitest'
import {
  CTX_KEY,
  UNVERIFIED_CTX,
  accessTokenOf,
  clearContext,
  contextDigest,
  currentGen,
  identityOf,
  matchesContext,
  newContext,
  randomHex,
  readContext,
  sanitizeCtx,
  writeContext,
} from './telemetry-context'

/** Все идентификаторы ниже выдуманы и существуют только в тестах. */
const USER = '11111111-1111-4111-8111-111111111111'
const ORG = 'aaaaaaaa-1111-4111-8111-111111111111'
const LOC = 'cccccccc-1111-4111-8111-111111111111'

const session = (user = USER, org = ORG, location = LOC) => ({
  access_token: 'synthetic-token',
  user: { id: user, app_metadata: { org_id: org, location_id: location } },
})

beforeEach(() => {
  localStorage.clear()
})

describe('identityOf', () => {
  it('читает тройку из JWT app_metadata', () => {
    expect(identityOf(session())).toEqual({ user: USER, org: ORG, location: LOC })
  })

  it('digital-аккаунт без точки остаётся валидным владельцем', () => {
    expect(identityOf({ user: { id: USER, app_metadata: { org_id: ORG } } }))
      .toEqual({ user: USER, org: ORG, location: '' })
  })

  it('без user id владельца нет', () => {
    for (const junk of [null, undefined, 42, 'session', {}, { user: null }, { user: { id: 7 } }, { user: { id: '' } }]) {
      expect(identityOf(junk)).toBeNull()
    }
  })

  it('не-строковые claim не попадают в тройку', () => {
    expect(identityOf({ user: { id: USER, app_metadata: { org_id: { evil: 1 }, location_id: 5 } } }))
      .toEqual({ user: USER, org: '', location: '' })
  })
})

describe('accessTokenOf', () => {
  it('отдаёт токен текущей сессии и ничего не выдумывает', () => {
    expect(accessTokenOf(session())).toBe('synthetic-token')
    for (const junk of [null, {}, { access_token: '' }, { access_token: 7 }]) {
      expect(accessTokenOf(junk)).toBeNull()
    }
  })
})

describe('contextDigest', () => {
  const id = { user: USER, org: ORG, location: LOC }

  it('128 бит в hex и повторяемость', () => {
    expect(contextDigest('0011223344556677', id)).toMatch(/^[0-9a-f]{32}$/)
    expect(contextDigest('0011223344556677', id)).toBe(contextDigest('0011223344556677', id))
  })

  it('различает user, org и точку по отдельности', () => {
    const base = contextDigest('0011223344556677', id)
    expect(contextDigest('0011223344556677', { ...id, user: ORG })).not.toBe(base)
    expect(contextDigest('0011223344556677', { ...id, org: LOC })).not.toBe(base)
    expect(contextDigest('0011223344556677', { ...id, location: '' })).not.toBe(base)
    // соль устройства тоже входит в отпечаток
    expect(contextDigest('7766554433221100', id)).not.toBe(base)
  })

  it('не склеивает соседние поля', () => {
    const ab = contextDigest('s', { user: 'ab', org: '', location: '' })
    const a_b = contextDigest('s', { user: 'a', org: 'b', location: '' })
    expect(ab).not.toBe(a_b)
  })
})

describe('randomHex', () => {
  it('даёт запрошенную длину и не повторяется', () => {
    const first = randomHex(8)
    expect(first).toMatch(/^[0-9a-f]{16}$/)
    expect(new Set(Array.from({ length: 32 }, () => randomHex(8))).size).toBeGreaterThan(1)
  })
})

describe('хранение записи контекста', () => {
  it('пишет только документированный минимум и читает обратно', () => {
    const ctx = newContext({ user: USER, org: ORG, location: LOC })
    writeContext(ctx)
    const raw = localStorage.getItem(CTX_KEY) ?? ''
    expect(JSON.parse(raw)).toEqual({ v: 1, g: ctx.gen, s: ctx.salt, d: ctx.digest })
    // ни токен, ни идентификаторы аккаунта на диск не уходят
    for (const secret of [USER, ORG, LOC, 'synthetic-token']) expect(raw).not.toContain(secret)
    expect(readContext()).toEqual(ctx)
  })

  it('чужой и повреждённый JSON контекстом не считается', () => {
    const ctx = newContext({ user: USER, org: ORG, location: LOC })
    for (const junk of [
      'не json', '[]', 'null', '{}',
      JSON.stringify({ v: 2, g: ctx.gen, s: ctx.salt, d: ctx.digest }),
      JSON.stringify({ v: 1, g: 'short', s: ctx.salt, d: ctx.digest }),
      JSON.stringify({ v: 1, g: ctx.gen, s: ctx.salt, d: 'nothex' }),
      JSON.stringify({ v: 1, g: ctx.gen, s: ctx.salt }),
    ]) {
      localStorage.setItem(CTX_KEY, junk)
      expect(readContext()).toBeNull()
      expect(currentGen()).toBe(UNVERIFIED_CTX)
    }
  })

  it('совпадение считается по всей тройке', () => {
    const id = { user: USER, org: ORG, location: LOC }
    const ctx = newContext(id)
    expect(matchesContext(ctx, id)).toBe(true)
    expect(matchesContext(ctx, { ...id, location: '' })).toBe(false)
    expect(matchesContext(ctx, { ...id, org: LOC })).toBe(false)
    expect(matchesContext(ctx, { ...id, user: ORG })).toBe(false)
  })

  it('новый вход — новое поколение и новая соль', () => {
    const id = { user: USER, org: ORG, location: LOC }
    const first = newContext(id)
    const second = newContext(id)
    expect(second.gen).not.toBe(first.gen)
    expect(second.salt).not.toBe(first.salt)
    expect(second.digest).not.toBe(first.digest)
  })

  it('закрытие входа стирает запись', () => {
    writeContext(newContext({ user: USER, org: ORG, location: LOC }))
    clearContext()
    expect(readContext()).toBeNull()
    expect(currentGen()).toBe(UNVERIFIED_CTX)
  })

  it('недоступный localStorage не бросает', () => {
    const getItem = Storage.prototype.getItem
    const setItem = Storage.prototype.setItem
    Storage.prototype.getItem = () => { throw new Error('denied') }
    Storage.prototype.setItem = () => { throw new Error('denied') }
    try {
      expect(() => writeContext(newContext({ user: USER, org: ORG, location: LOC }))).not.toThrow()
      expect(readContext()).toBeNull()
      expect(currentGen()).toBe(UNVERIFIED_CTX)
    } finally {
      Storage.prototype.getItem = getItem
      Storage.prototype.setItem = setItem
    }
  })

  it('sanitizeCtx принимает только поколение', () => {
    const ctx = newContext({ user: USER, org: ORG, location: LOC })
    expect(sanitizeCtx(ctx.gen)).toBe(ctx.gen)
    expect(sanitizeCtx(`${ctx.gen}0`)).toBe(UNVERIFIED_CTX)
    expect(sanitizeCtx(UNVERIFIED_CTX)).toBe(UNVERIFIED_CTX)
  })
})
