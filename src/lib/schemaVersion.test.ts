import { describe, it, expect } from 'vitest'
import { interpretSchemaResponse, MIN_SCHEMA_VERSION } from './schemaVersion'

describe('interpretSchemaResponse', () => {
  it('актуальная база — ok с версией', () => {
    expect(interpretSchemaResponse(MIN_SCHEMA_VERSION, null)).toEqual({
      status: 'ok',
      version: MIN_SCHEMA_VERSION,
    })
    expect(interpretSchemaResponse(MIN_SCHEMA_VERSION + 5, null).status).toBe('ok')
  })

  it('отстающая база — outdated', () => {
    expect(interpretSchemaResponse(MIN_SCHEMA_VERSION - 1, null)).toEqual({
      status: 'outdated',
      version: MIN_SCHEMA_VERSION - 1,
    })
  })

  it('функции нет в базе (до 081) — outdated с версией 0', () => {
    expect(interpretSchemaResponse(null, { code: 'PGRST202' })).toEqual({
      status: 'outdated',
      version: 0,
    })
    expect(interpretSchemaResponse(null, { code: '42883' }).status).toBe('outdated')
  })

  it('сетевая/прочая ошибка — unknown, работу не блокируем', () => {
    expect(interpretSchemaResponse(null, { code: 'FETCH_ERROR' }).status).toBe('unknown')
    expect(interpretSchemaResponse(null, {}).status).toBe('unknown')
  })

  it('мусор в ответе — unknown', () => {
    expect(interpretSchemaResponse('abc', null).status).toBe('unknown')
    expect(interpretSchemaResponse(null, null).status).toBe('unknown')
    expect(interpretSchemaResponse(undefined, null).status).toBe('unknown')
  })

  it('число строкой (PostgREST может отдать text) — парсится', () => {
    expect(interpretSchemaResponse(String(MIN_SCHEMA_VERSION), null).status).toBe('ok')
  })
})
