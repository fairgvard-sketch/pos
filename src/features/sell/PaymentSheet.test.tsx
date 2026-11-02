import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import PaymentSheet from './PaymentSheet'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
import { formatMoney } from '../../lib/money'
import { t } from '../../lib/i18n'

const money = (a: number) => formatMoney(a, 'ru')
// getByText сводит неразрывные пробелы (разделитель тысяч) к обычным
const moneyText = (a: number) => money(a).replace(/\s+/g, ' ')

function setup(total: number) {
  const onPay = vi.fn()
  render(<PaymentSheet total={total} startMode="cash" onCancel={vi.fn()} onPay={onPay} busy={false} />)
  return { onPay }
}

beforeEach(() => {
  useLangStore.setState({ lang: 'ru' })
  useDeviceStore.setState({ payMethodOrder: ['cash', 'card'] })
})

describe('PaymentSheet: быстрые суммы наличных', () => {
  it('номиналы всегда 1–200 ₪, независимо от суммы', () => {
    setup(3700)
    for (const shekels of [1, 5, 10, 20, 50, 100, 200]) {
      expect(screen.getByRole('button', { name: money(shekels * 100) })).toBeInTheDocument()
    }
  })

  it('номинал прибавляется к «Получено» и не закрывает счёт', () => {
    const { onPay } = setup(3700)
    fireEvent.click(screen.getByRole('button', { name: money(5000) }))
    fireEvent.click(screen.getByRole('button', { name: money(2000) }))
    expect(onPay).not.toHaveBeenCalled()
    expect(screen.getByText(moneyText(7000))).toBeInTheDocument()
    expect(screen.getByText(moneyText(3300))).toBeInTheDocument() // сдача

    fireEvent.click(screen.getByRole('button', { name: t('ru', 'confirmPayment') }))
    expect(onPay).toHaveBeenCalledWith(
      [{ method: 'cash', amount: 3700, tendered: 7000, change_due: 3300 }],
      null,
    )
  })

  it('«Без сдачи» ставит остаток в «Получено», оплату закрывает «Оплатить»', () => {
    const { onPay } = setup(3750)
    fireEvent.click(screen.getByRole('button', { name: money(1000) }))
    fireEvent.click(screen.getByRole('button', { name: t('ru', 'exactAmount') }))
    expect(onPay).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: t('ru', 'confirmPayment') }))
    expect(onPay).toHaveBeenCalledWith(
      [{ method: 'cash', amount: 3750, tendered: 3750, change_due: 0 }],
      null,
    )
  })

  it('выше лимита наличных «Макс.» ставит разрешённый максимум', () => {
    setup(1200000)
    fireEvent.click(screen.getByRole('button', { name: t('ru', 'cashLimitMax') }))
    expect(screen.getAllByText(moneyText(120000)).length).toBeGreaterThan(1)
    expect(screen.getByRole('button', { name: new RegExp(t('ru', 'acceptPart')) })).toBeEnabled()
  })
})
