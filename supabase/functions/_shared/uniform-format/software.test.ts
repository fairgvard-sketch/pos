import { describe, expect, it } from 'vitest'
import { NO_REGISTRATION_CERTIFICATE } from './build.ts'
import { VENDOR_NAME, softwareIdentity } from './software.ts'

const env = (vars: Record<string, string>) => (key: string) => vars[key]

describe('softwareIdentity — производитель ПО, а не бизнес-клиент', () => {
  it('номер производителя из секрета, свидетельства нет — 99999999', () => {
    expect(softwareIdentity(env({ UF_VENDOR_TAX_ID: '123456782' }))).toMatchObject({
      vendorTaxId: 123456782,
      vendorName: VENDOR_NAME,
      softwareRegistration: NO_REGISTRATION_CERTIFICATE,
    })
  })

  it('свидетельство из секрета, когда оно появится', () => {
    expect(
      softwareIdentity(env({ UF_VENDOR_TAX_ID: '123456782', UF_SOFTWARE_REGISTRATION: '12345678' }))
        .softwareRegistration,
    ).toBe(12_345_678)
  })

  it('без номера производителя выгрузка не собирается', () => {
    expect(() => softwareIdentity(env({}))).toThrow('uf_missing_vendor_tax_id')
    expect(() => softwareIdentity(env({ UF_VENDOR_TAX_ID: '000000000' }))).toThrow('uf_missing_vendor_tax_id')
  })

  it('свидетельство длиннее 8 цифр — ошибка, а не обрезка', () => {
    expect(() =>
      softwareIdentity(env({ UF_VENDOR_TAX_ID: '123456782', UF_SOFTWARE_REGISTRATION: '123456789' })),
    ).toThrow('uf_bad_software_registration')
  })
})
