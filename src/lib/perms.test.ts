import { describe, it, expect } from 'vitest'
import { can, permLevel } from './perms'
import type { LocationSettings } from '../types'

/**
 * can() зеркалит серверный require_staff_perm (094). Если эти тесты
 * разойдутся с supabase/tests/custom_roles.test.sql — расходятся UI и сервер,
 * то есть кнопка показывается, а сервер на ней отказывает.
 */

const noSettings = undefined
const strictRefund = { perms: { discount: 'manager' } } as unknown as LocationSettings

describe('can — без кастомной роли (поведение до 094)', () => {
  it('discount по умолчанию доступен всем', () => {
    expect(can('barista', 'discount', noSettings)).toBe(true)
  })

  it('refund по умолчанию только менеджеру', () => {
    expect(can('barista', 'refund', noSettings)).toBe(false)
    expect(can('manager', 'refund', noSettings)).toBe(true)
  })

  it('stock_take по умолчанию только менеджеру', () => {
    expect(can('barista', 'stock_take', noSettings)).toBe(false)
  })

  it('настройка точки поднимает уровень до менеджерского', () => {
    expect(permLevel(strictRefund, 'discount')).toBe('manager')
    expect(can('barista', 'discount', strictRefund)).toBe(false)
    expect(can('manager', 'discount', strictRefund)).toBe(true)
  })
})

describe('can — с кастомной ролью (094)', () => {
  const seniorBarista = ['refund', 'discount']

  it('роль разрешает то, что база запрещает', () => {
    expect(can('barista', 'refund', noSettings, seniorBarista)).toBe(true)
  })

  it('роль запрещает то, что база разрешала', () => {
    // close_shift по умолчанию 'all', но в набор роли не входит
    expect(can('barista', 'close_shift', noSettings, seniorBarista)).toBe(false)
  })

  it('роль важнее настроек точки', () => {
    expect(can('barista', 'discount', strictRefund, seniorBarista)).toBe(true)
  })

  it('пустая роль не даёт ничего', () => {
    expect(can('barista', 'discount', noSettings, [])).toBe(false)
  })
})

describe('can — владелец', () => {
  it('может всё, даже с ограниченной ролью', () => {
    expect(can('owner', 'close_shift', noSettings, [])).toBe(true)
    expect(can('owner', 'refund', strictRefund, ['discount'])).toBe(true)
  })
})
