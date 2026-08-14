import { describe, expect, it } from 'vitest'
import {
  composeName, composeNote, draftErrors, isDraftValid, isEmailValid,
  reserveFlow, stepAfter, stepBefore, stepIndex, EMPTY_DRAFT,
  type DetailsDraft,
} from './reserveFlow'

/**
 * Путь гостя и его черновик. Раньше и порядок экранов, и «сколько всего
 * шагов» были написаны в разметке константами `hasRules ? 4 : 3` в трёх
 * местах — при появлении предоплаты они разошлись бы молча.
 */

const LABELS = {
  birthday: 'День рождения',
  high_chair: 'Детский стул',
  accessibility: 'Доступная посадка',
}

function draft(over: Partial<DetailsDraft> = {}): DetailsDraft {
  return {
    ...EMPTY_DRAFT,
    firstName: 'וולד',
    lastName: 'אנוטוב',
    phone: '0541234567',
    email: 'guest@example.com',
    ...over,
  }
}

describe('порядок экранов по настройкам точки', () => {
  it('без правил и без предоплаты — время, контакты', () => {
    const flow = reserveFlow({ hasRules: false, hasPrepay: false })
    expect(flow).toEqual(['times', 'details'])
  })

  it('правила без предоплаты — время, правила, контакты', () => {
    expect(reserveFlow({ hasRules: true, hasPrepay: false }))
      .toEqual(['times', 'rules', 'details'])
  })

  it('предоплата без правил — время, контакты, оплата', () => {
    expect(reserveFlow({ hasRules: false, hasPrepay: true }))
      .toEqual(['times', 'details', 'prepay'])
  })

  it('правила и предоплата — все четыре шага по порядку', () => {
    expect(reserveFlow({ hasRules: true, hasPrepay: true }))
      .toEqual(['times', 'rules', 'details', 'prepay'])
  })

  it('предоплата ВСЕГДА после контактов, а не до них', () => {
    const flow = reserveFlow({ hasRules: true, hasPrepay: true })
    expect(flow.indexOf('prepay')).toBeGreaterThan(flow.indexOf('details'))
  })
})

describe('индикатор прогресса считает только видимые шаги', () => {
  it('пропущенный шаг не занимает деление', () => {
    const noRules = reserveFlow({ hasRules: false, hasPrepay: false })
    // Контакты — второй из двух, а не «третий из четырёх»
    expect(stepIndex(noRules, 'details')).toBe(2)
    expect(noRules.length).toBe(2)

    const all = reserveFlow({ hasRules: true, hasPrepay: true })
    expect(stepIndex(all, 'details')).toBe(3)
    expect(all.length).toBe(4)
  })

  it('шага вне потока в полосе нет', () => {
    expect(stepIndex(reserveFlow({ hasRules: false, hasPrepay: false }), 'rules')).toBe(0)
  })
})

describe('назад и вперёд симметричны', () => {
  const all = reserveFlow({ hasRules: true, hasPrepay: true })
  const bare = reserveFlow({ hasRules: false, hasPrepay: false })

  it('каждый шаг возвращается туда, откуда пришёл', () => {
    for (const step of all) {
      const back = stepBefore(all, step)
      if (back === 'slot') continue
      expect(stepAfter(all, back)).toBe(step)
    }
  })

  it('первый шаг уходит назад на экран входа', () => {
    expect(stepBefore(all, 'times')).toBe('slot')
    expect(stepBefore(bare, 'times')).toBe('slot')
  })

  it('без правил контакты возвращаются сразу к времени', () => {
    expect(stepBefore(bare, 'details')).toBe('times')
  })

  it('с правилами контакты возвращаются к правилам', () => {
    expect(stepBefore(all, 'details')).toBe('rules')
  })

  it('после последнего шага дальше некуда', () => {
    expect(stepAfter(all, 'prepay')).toBeNull()
    expect(stepAfter(bare, 'details')).toBeNull()
  })
})

describe('проверка контактов', () => {
  it('полный черновик проходит', () => {
    expect(isDraftValid(draft())).toBe(true)
  })

  it('имя и фамилия обязательны по отдельности', () => {
    expect(draftErrors(draft({ firstName: '  ' })).firstName).toBe(true)
    expect(draftErrors(draft({ lastName: '' })).lastName).toBe(true)
    // Одно заполненное поле не закрывает второе
    expect(isDraftValid(draft({ lastName: '' }))).toBe(false)
  })

  it('телефон короче девяти цифр отклоняется, формат записи не важен', () => {
    expect(draftErrors(draft({ phone: '054-123-4567' })).phone).toBe(false)
    expect(draftErrors(draft({ phone: '+972 54 123 4567' })).phone).toBe(false)
    expect(draftErrors(draft({ phone: '12345678' })).phone).toBe(true)
  })

  it('почта обязательна и проверяется по формату', () => {
    expect(isEmailValid('guest@example.com')).toBe(true)
    expect(isEmailValid('guest.name+tag@mail.co.il')).toBe(true)
    expect(isEmailValid('')).toBe(false)
    expect(isEmailValid('guest@example')).toBe(false) // домен без точки
    expect(isEmailValid('guest example@mail.com')).toBe(false) // пробел
    expect(isEmailValid('a@b@c.com')).toBe(false) // две собаки
    expect(isEmailValid(`${'a'.repeat(250)}@b.com`)).toBe(false) // длиннее 254
  })
})

describe('сборка имени и заметки', () => {
  it('имя собирается из двух полей, лишние пробелы уходят', () => {
    expect(composeName(draft({ firstName: ' וולד ', lastName: ' אנוטוב ' })))
      .toBe('וולד אנוטוב')
  })

  it('пожелания уезжают в ту же заметку, что читает хостес', () => {
    expect(composeNote(draft({ extras: ['birthday'], note: 'у окна' }), LABELS))
      .toBe('День рождения · у окна')
  })

  it('порядок пожеланий постоянный и не зависит от порядка нажатий', () => {
    const a = composeNote(draft({ extras: ['accessibility', 'birthday'] }), LABELS)
    const b = composeNote(draft({ extras: ['birthday', 'accessibility'] }), LABELS)
    expect(a).toBe(b)
    expect(a).toBe('День рождения · Доступная посадка')
  })

  it('пустой черновик даёт NULL, а не пустую строку', () => {
    expect(composeNote(draft(), LABELS)).toBeNull()
  })

  it('заметка обрезается до предела колонки', () => {
    const long = composeNote(draft({ note: 'я'.repeat(300) }), LABELS)!
    expect(long.length).toBe(200)
  })
})
