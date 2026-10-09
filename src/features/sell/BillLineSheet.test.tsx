import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import BillLineSheet from './BillLineSheet'
import { t } from '../../lib/i18n'
import type { BillLine } from '../tables/api'
import type { Table } from '../../types'

const line: BillLine = {
  id: 'l1', name: 'Burger', variant_name: null, qty: 3, line_total: 15000,
  modifiers: ['Medium'], notes: null, course: null, held: false,
  menu_item_id: 'm1', variant_id: null, unit_price: 5000, mods: [{ id: 'mod1', name: 'Medium', priceDelta: 0 }],
}
const table = (id: string, label: string): Table => ({
  id, label, public_token: id, org_id: 'o', location_id: 'loc', zone: null, zone_id: null, sort_order: 0,
  is_active: true, seats: 2, combinable: false, status: 'free', pos_x: null, pos_y: null, width: 10, height: 10,
  shape: 'square', created_at: '',
})

function setup(over: Partial<Parameters<typeof BillLineSheet>[0]> = {}) {
  const props = {
    line, lang: 'ru' as const, isRtl: false, initialMode: 'menu' as const, initialVoidQty: null,
    tables: [table('t1', '1'), table('t2', '2')], occupancy: new Map(), currentTableId: 't1',
    online: true, synced: true, busy: false,
    onAddOne: vi.fn(), onVoid: vi.fn().mockResolvedValue('ok'), onMove: vi.fn(), onClose: vi.fn(),
    ...over,
  }
  render(<BillLineSheet {...props} />)
  return props
}

const typePin = (pin: string) => {
  for (const d of pin) fireEvent.click(screen.getByRole('button', { name: d }))
}

describe('BillLineSheet: правка отправленной позиции', () => {
  it('«−» просит PIN менеджера и убирает одну порцию с причиной', async () => {
    const p = setup()
    fireEvent.click(screen.getByRole('button', { name: '− Burger' }))
    expect(screen.getByText(t('ru', 'managerPinTitle'))).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: t('ru', 'voidReasonGuest') }))
    typePin('8888')
    await waitFor(() => expect(p.onVoid).toHaveBeenCalledWith(1, t('ru', 'voidReasonGuest'), '8888'))
  })

  it('«Убрать позицию» убирает строку целиком', async () => {
    const p = setup()
    fireEvent.click(screen.getByRole('button', { name: t('ru', 'lineRemove') }))
    typePin('8888')
    await waitFor(() => expect(p.onVoid).toHaveBeenCalledWith(null, t('ru', 'voidReasonMistake'), '8888'))
  })

  it('неверный PIN — сообщение, ввод сбрасывается', async () => {
    setup({ initialMode: 'void', onVoid: vi.fn().mockResolvedValue('bad_pin') })
    typePin('1111')
    expect(await screen.findByRole('alert')).toHaveTextContent(t('ru', 'managerPinInvalid'))
  })

  it('«+» добавляет такую же порцию без PIN', () => {
    const p = setup()
    fireEvent.click(screen.getByRole('button', { name: '+ Burger' }))
    expect(p.onAddOne).toHaveBeenCalledTimes(1)
    expect(p.onVoid).not.toHaveBeenCalled()
  })

  it('перенос: выбор стола, кроме текущего', () => {
    const p = setup()
    fireEvent.click(screen.getByRole('button', { name: t('ru', 'moveTable') }))
    expect(screen.queryByRole('button', { name: '1' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    expect(p.onMove).toHaveBeenCalledWith('t2')
  })

  it('без сети убрать и перенести нельзя — с подсказкой', () => {
    setup({ online: false })
    expect(screen.getByRole('button', { name: t('ru', 'lineRemove') })).toBeDisabled()
    expect(screen.getByRole('button', { name: t('ru', 'moveTable') })).toBeDisabled()
    expect(screen.getByText(t('ru', 'offlineBlockedHint'))).toBeInTheDocument()
  })
})
