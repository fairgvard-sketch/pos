import { describe, it, expect } from 'vitest'
import { failedNoCache } from './queryState'

describe('failedNoCache (P1-7)', () => {
  it('ошибка без данных — критична', () => {
    expect(failedNoCache({ isError: true, data: undefined })).toBe(true)
  })

  it('ошибка при живом кэше — работаем по кэшу', () => {
    expect(failedNoCache({ isError: true, data: [] })).toBe(false)
    expect(failedNoCache({ isError: true, data: { id: 1 } })).toBe(false)
  })

  it('null — честный ответ («смены нет»), не отказ', () => {
    expect(failedNoCache({ isError: true, data: null })).toBe(false)
    expect(failedNoCache({ isError: false, data: null })).toBe(false)
  })

  it('загрузка/успех без ошибки — не критично', () => {
    expect(failedNoCache({ isError: false, data: undefined })).toBe(false)
    expect(failedNoCache({ isError: false, data: [1] })).toBe(false)
  })
})
