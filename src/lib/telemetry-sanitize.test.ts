import { describe, expect, it } from 'vitest'
import {
  LIMITS,
  UNVERIFIED_CTX,
  fingerprintOf,
  sanitizeCount,
  sanitizeCtx,
  sanitizeEntry,
  sanitizeMessage,
  sanitizeRoute,
  sanitizeSource,
  sanitizeStack,
  sanitizeUserAgent,
  sanitizeVersion,
  toWireError,
} from './telemetry-sanitize'

/** Все «секреты» ниже выдуманы для тестов и нигде не существуют. */
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKEsignature0000'

describe('sanitizeMessage: что остаётся оператору', () => {
  it('сохраняет обычную ошибку браузера целиком', () => {
    expect(sanitizeMessage("TypeError: Cannot read properties of undefined (reading 'items')"))
      .toBe("TypeError: Cannot read properties of undefined (reading 'items')")
    expect(sanitizeMessage('Error: Failed to fetch')).toBe('Error: Failed to fetch')
  })

  it('сохраняет класс ошибки и машинный код сервера', () => {
    expect(sanitizeMessage('Error: PGRST116: JSON object requested, multiple (or no) rows returned'))
      .toContain('PGRST116')
    // нелатинский хвост интерпретировать нечем, код остаётся
    expect(sanitizeMessage('Error: invoice_immutable: счета не удаляются'))
      .toBe('Error: invoice_immutable: [unsafe]')
  })

  it('сохраняет диагностику смены (074/082) без изменений', () => {
    expect(sanitizeMessage('Error: shift_overdue: days=2 opened_at=2026-09-13T04:00:00.000Z'))
      .toBe('Error: shift_overdue: days=2 opened_at=2026-09-13T04:00:00.000Z')
  })

  it('не строка и пустая строка дают пустой результат', () => {
    expect(sanitizeMessage(null)).toBe('')
    expect(sanitizeMessage({ message: 'x' })).toBe('')
    expect(sanitizeMessage('   ')).toBe('')
  })

  it('ограничивает длину', () => {
    expect(sanitizeMessage('Error: ' + 'a'.repeat(5_000)).length).toBeLessThanOrEqual(LIMITS.message)
  })
})

describe('sanitizeMessage: что вычищается', () => {
  const cases: Array<[string, string, string]> = [
    ['JWT', `auth failed with ${FAKE_JWT}`, 'eyJ'],
    ['Bearer', 'request failed: Bearer fakeSecretValue123456', 'fakeSecretValue123456'],
    ['access_token', 'access_token=fakeaccess0011223344556677', 'fakeaccess0011223344556677'],
    ['refresh_token', 'refresh_token=fakerefresh99887766554433', 'fakerefresh99887766554433'],
    ['apikey', 'apikey=fakeanonkey00112233445566778899', 'fakeanonkey00112233445566778899'],
    ['password', 'login failed password=F4keP@ssw0rd', 'F4keP@ssw0rd'],
    ['pin', 'verify failed pin=9137', '9137'],
    ['email', 'guest qa.fake@example.test rejected', 'qa.fake@example.test'],
    ['телефон +972', 'sms to +972500000001 failed', '972500000001'],
    ['телефон 05x', 'sms to 050-000-0002 failed', '050-000-0002'],
    ['uuid', 'order 9f1c2b3a-1111-4222-8333-444455556666 not found', '9f1c2b3a'],
    ['data-url', 'print failed data:image/png;base64,AAAAFAKEPAYLOAD', 'FAKEPAYLOAD'],
    ['query', 'GET https://db.example.test/rest/v1/guests?phone=eq.0500000003 failed', '0500000003'],
    ['fragment', 'redirect https://app.example.test/cb#access_token=fakeaccess0011223344', 'fakeaccess0011223344'],
    ['userinfo', 'GET https://fakeuser:fakepw@db.example.test/rest/v1/orders failed', 'fakepw'],
    ['JSON гостя', 'invalid payload {"customer_name":"QA Fake Guest"}', 'QA Fake Guest'],
    ['detail Postgres', 'Key (phone)=(+972500000004) already exists', '972500000004'],
    ['иврит', 'name אורח בדיקה rejected', 'אורח'],
  ]

  for (const [label, input, secret] of cases) {
    it(`не пропускает: ${label}`, () => {
      expect(sanitizeMessage(input)).not.toContain(secret)
    })
  }

  it('очистка идемпотентна: повторное чтение не меняет текст', () => {
    // очередь перечитывается при каждом capture и flush: дрейф сообщения
    // ломал бы дедупликацию и растил запись с каждым чтением
    for (const [, input] of cases.map((c) => [c[0], c[1]] as const)) {
      const once = sanitizeMessage(input)
      expect(sanitizeMessage(once)).toBe(once)
      expect(sanitizeMessage(sanitizeMessage(once))).toBe(once)
    }
  })

  it('оставляет полезный контекст рядом с вычищенным', () => {
    const out = sanitizeMessage('GET https://db.example.test/rest/v1/guests?phone=eq.0500000003 failed')
    expect(out).toContain('db.example.test/rest/v1/guests')
    expect(out).toContain('GET')
  })
})

describe('sanitizeMessage: префикс не делает значение безопасным (F6.1-R1)', () => {
  const prefixed: Array<[string, string]> = [
    ['password: FakeQaPass9', 'FakeQaPass9'],
    ['Error: password: FakeQaPass9', 'FakeQaPass9'],
    ['Error: pin: 9137', '9137'],
    ['pin: 9137', '9137'],
    ["Error: failed password='FakeQaPass9'", 'FakeQaPass9'],
    ['Error: failed password=[FakeQaPass9]', 'FakeQaPass9'],
    ['Error: token: "FakeQaToken9"', 'FakeQaToken9'],
    ['session: FakeQaSession9', 'FakeQaSession9'],
  ]

  for (const [input, secret] of prefixed) {
    it(`не пропускает: ${input}`, () => {
      expect(sanitizeMessage(input)).not.toContain(secret)
    })
  }

  it('идемпотентно: собственный плейсхолдер не путается со значением', () => {
    for (const [input] of prefixed) {
      const once = sanitizeMessage(input)
      expect(sanitizeMessage(once)).toBe(once)
      expect(once).toContain('[redacted]')
    }
  })

  it('класс ошибки и машинный код остаются полезными', () => {
    expect(sanitizeMessage('Error: pin: 9137')).toBe('Error: pin=[redacted]')
    expect(sanitizeMessage('TypeError: x is not a function'))
      .toBe('TypeError: x is not a function')
    expect(sanitizeMessage('Error: invoice_immutable: 23505'))
      .toBe('Error: invoice_immutable: 23505')
  })
})

describe('sanitizeUserAgent: только браузер и платформа (F6.1-R1)', () => {
  it('выбрасывает постороннюю приписку с секретом', () => {
    const out = sanitizeUserAgent('Mozilla/5.0 Chrome/120.0 password=FakeQaPass9')
    expect(out).not.toContain('FakeQaPass9')
    expect(out).toBe('Mozilla/5.0 Chrome/120.0')
  })

  it('оставляет реальный UA терминала', () => {
    const t2 = 'Mozilla/5.0 (Linux; Android 7.1.2; SUNMI T2 Build/N2G47H) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0.2743.100 Mobile Safari/537.36'
    const out = sanitizeUserAgent(t2)
    expect(out).toContain('Android 7.1.2')
    expect(out).toContain('Chrome/52.0.2743.100')
    expect(out).toContain('Mobile')
  })

  it('не пропускает почту, URL и нелатинский текст', () => {
    expect(sanitizeUserAgent('Mozilla/5.0 qa.fake@example.test')).toBe('Mozilla/5.0')
    expect(sanitizeUserAgent('Mozilla/5.0 (Linux) https://pos.example.test/order/42'))
      .toBe('Mozilla/5.0 (Linux)')
    expect(sanitizeUserAgent('Mozilla/5.0 אורח בדיקה')).toBe('Mozilla/5.0')
  })

  it('очистка идемпотентна', () => {
    for (const ua of [
      'Mozilla/5.0 Chrome/120.0 password=FakeQaPass9',
      'Mozilla/5.0 (Linux; Android 7.1.2) Chrome/52.0.2743.100 Mobile Safari/537.36',
    ]) {
      const once = sanitizeUserAgent(ua)
      expect(sanitizeUserAgent(once)).toBe(once)
    }
  })
})

describe('sanitizeStack', () => {
  const stack = [
    `TypeError: x is not a function for qa.fake@example.test`,
    `    at Object.pay (https://pos.example.test/assets/index-DkH7t2Vb.js?token=${FAKE_JWT}:14:2903)`,
    `    at HTMLButtonElement.<anonymous> (https://fakeuser:fakepw@pos.example.test/assets/index-DkH7t2Vb.js#${FAKE_JWT}:9:112)`,
  ].join('\n')

  it('оставляет функцию, файл и позицию', () => {
    const out = sanitizeStack(stack) ?? ''
    expect(out).toContain('Object.pay')
    expect(out).toContain('index-DkH7t2Vb.js')
    expect(out).toContain(':14:2903')
    expect(out).toContain(':9:112')
  })

  it('выбрасывает заголовок стека и секреты', () => {
    const out = sanitizeStack(stack) ?? ''
    expect(out).not.toContain('qa.fake@example.test')
    expect(out).not.toContain('eyJ')
    expect(out).not.toContain('fakeuser')
    expect(out).not.toContain('fakepw')
    expect(out).not.toContain('?token=')
  })

  it('сохраняет имя файла и позицию при длинном пути', () => {
    const long = `    at pay (https://pos.example.test/${'segment/'.repeat(20)}index-DkH7t2Vb.js:14:2903)`
    const out = sanitizeStack(long) ?? ''
    expect(out).toContain('index-DkH7t2Vb.js')
    expect(out).toContain(':14:2903')
  })

  it('очистка кадров идемпотентна', () => {
    const once = sanitizeStack(stack) ?? ''
    expect(sanitizeStack(once)).toBe(once)
  })

  it('ограничивает число кадров и длину', () => {
    const many = Array.from({ length: 50 }, (_, i) => `    at f${i} (https://pos.example.test/a.js:${i}:1)`).join('\n')
    const out = sanitizeStack(many) ?? ''
    expect(out.split('\n')).toHaveLength(LIMITS.frames)
    expect(out.length).toBeLessThanOrEqual(LIMITS.stack)
  })

  it('без кадров и не строка — undefined', () => {
    expect(sanitizeStack('just a sentence')).toBeUndefined()
    expect(sanitizeStack(null)).toBeUndefined()
    expect(sanitizeStack({ stack: 'x' })).toBeUndefined()
  })
})

describe('sanitizeRoute', () => {
  it('оставляет статические маршруты', () => {
    expect(sanitizeRoute('/sell')).toBe('/sell')
    expect(sanitizeRoute('/settings/floor-plan')).toBe('/settings/floor-plan')
    expect(sanitizeRoute('/m/bulochka-center')).toBe('/m/bulochka-center')
  })

  it('маскирует идентификаторы и данные в пути', () => {
    expect(sanitizeRoute('/order/9f1c2b3a-1111-4222-8333-444455556666')).toBe('/order/:id')
    expect(sanitizeRoute('/orders/4210')).toBe('/orders/:n')
    expect(sanitizeRoute('/guests/qa.fake@example.test')).toBe('/guests/:x')
    expect(sanitizeRoute('/guests/0500000005')).toBe('/guests/:n')
  })

  it('маскировка идемпотентна', () => {
    for (const route of ['/sell', '/order/9f1c2b3a-1111-4222-8333-444455556666', '/orders/4210', '/guests/qa.fake@example.test']) {
      const once = sanitizeRoute(route)
      expect(sanitizeRoute(once)).toBe(once)
    }
  })

  it('не строка — корень', () => {
    expect(sanitizeRoute(undefined)).toBe('/')
    expect(sanitizeRoute(42)).toBe('/')
  })
})

describe('нормализация служебных полей', () => {
  it('source', () => {
    expect(sanitizeSource('print')).toBe('print')
    expect(sanitizeSource('evil')).toBe('window')
    expect(sanitizeSource(42)).toBe('window')
    expect(sanitizeSource(undefined)).toBe('window')
  })

  it('count', () => {
    expect(sanitizeCount(3)).toBe(3)
    expect(sanitizeCount(2.7)).toBe(2)
    expect(sanitizeCount(0)).toBe(1)
    expect(sanitizeCount(-5)).toBe(1)
    expect(sanitizeCount(1e12)).toBe(LIMITS.count)
    expect(sanitizeCount('12')).toBe(1)
    expect(sanitizeCount(Number.NaN)).toBe(1)
    // не конечное число — не «много повторов», а мусор: считаем за одну запись
    expect(sanitizeCount(Number.POSITIVE_INFINITY)).toBe(1)
    expect(sanitizeCount({ n: 1 })).toBe(1)
  })

  it('version и user_agent', () => {
    expect(sanitizeVersion('1.1.0')).toBe('1.1.0')
    expect(sanitizeVersion('1.1.0 <script>')).toBe('')
    expect(sanitizeVersion(7)).toBe('')
    expect(sanitizeUserAgent('Mozilla/5.0 (Linux; Android 7.1.2)')).toContain('Android 7.1.2')
    expect(sanitizeUserAgent('x'.repeat(9_000)).length).toBeLessThanOrEqual(LIMITS.userAgent)
    expect(sanitizeUserAgent(null)).toBe('')
  })

  it('ctx — только поколение входа в точном формате', () => {
    // F6.1-R1: метка контекста = 16 hex (см. telemetry-context). Любая другая
    // строка — «владелец неизвестен», а не «пусть будет как есть».
    expect(sanitizeCtx('0123456789abcdef')).toBe('0123456789abcdef')
    expect(sanitizeCtx('u1a2b3c')).toBe(UNVERIFIED_CTX)
    expect(sanitizeCtx('0123456789ABCDEF')).toBe(UNVERIFIED_CTX)
    expect(sanitizeCtx('bad ctx value!')).toBe(UNVERIFIED_CTX)
    expect(sanitizeCtx(null)).toBe(UNVERIFIED_CTX)
  })
})

describe('sanitizeEntry', () => {
  it('отбрасывает не-объекты и записи без сообщения', () => {
    for (const junk of [null, undefined, 5, 'str', [], {}, { message: 12 }, { message: '' }]) {
      expect(sanitizeEntry(junk)).toBeNull()
    }
  })

  it('оставляет только разрешённые поля', () => {
    const e = sanitizeEntry({
      message: 'Error: boom',
      source: 'print',
      count: 4,
      route: '/sell',
      app_version: '1.1.0',
      user_agent: 'jsdom',
      service_role_key: 'fake-service-key',
      nested: { guest: 'QA Fake Guest' },
    })
    expect(e).not.toBeNull()
    expect(Object.keys(e!).sort()).toEqual([
      'app_version', 'count', 'ctx', 'fingerprint', 'message',
      'route', 'source', 'stack', 'user_agent',
    ])
    expect(JSON.stringify(e)).not.toContain('service_role_key')
    expect(JSON.stringify(e)).not.toContain('QA Fake Guest')
  })

  it('пересчитывает fingerprint по очищенным значениям', () => {
    const a = sanitizeEntry({ message: 'Error: sms to +972500000001 failed', source: 'outbox', fingerprint: 'spoofed' })
    const b = sanitizeEntry({ message: 'Error: sms to +972500000009 failed', source: 'outbox', fingerprint: 'other' })
    expect(a!.fingerprint).not.toBe('spoofed')
    // одинаковый сбой с разным телефоном — одна запись, а не две
    expect(a!.fingerprint).toBe(b!.fingerprint)
  })

  it('fingerprint различает источник и место сбоя', () => {
    const stack = '    at pay (https://pos.example.test/a.js:1:1)'
    expect(fingerprintOf('print', 'Error: x', stack)).not.toBe(fingerprintOf('outbox', 'Error: x', stack))
    expect(fingerprintOf('print', 'Error: x', stack)).not.toBe(
      fingerprintOf('print', 'Error: x', '    at print (https://pos.example.test/b.js:2:2)'),
    )
    expect(fingerprintOf('print', 'Error: x', stack)).toBe(fingerprintOf('print', 'Error: x', stack))
  })
})

describe('идемпотентность записи целиком', () => {
  it('повторная очистка записи не меняет ни одно поле', () => {
    const first = sanitizeEntry({
      message: 'guest.save failed: sms to +972500000001 failed for qa.fake@example.test',
      stack: `    at pay (https://pos.example.test/order/9f1c2b3a-1111-4222-8333-444455556666/index-DkH7t2Vb.js?token=${FAKE_JWT}:14:2903)`,
      route: '/order/9f1c2b3a-1111-4222-8333-444455556666',
      source: 'outbox',
      app_version: '1.1.0',
      user_agent: 'Mozilla/5.0 (Linux; Android 7.1.2)',
      count: 2,
    })!
    const second = sanitizeEntry(first)!
    expect(second).toEqual(first)
    expect(sanitizeEntry(second)).toEqual(first)
  })
})

describe('toWireError', () => {
  it('не отдаёт клиентскую метку контекста серверу', () => {
    const entry = sanitizeEntry({ message: 'Error: boom', source: 'window', ctx: '0123456789abcdef' })!
    const wire = toWireError(entry)
    expect('ctx' in wire).toBe(false)
    expect(entry.ctx).toBe('0123456789abcdef')
    expect(JSON.stringify(wire)).not.toContain('0123456789abcdef')
    expect(wire.source).toBe('window')
  })

  it('не отдаёт пустой stack', () => {
    const entry = sanitizeEntry({ message: 'Error: boom', source: 'window' })!
    expect('stack' in toWireError(entry)).toBe(false)
  })
})
