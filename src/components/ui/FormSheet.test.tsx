import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import FormSheet from './FormSheet'
import { t } from '../../lib/i18n'

describe('FormSheet', () => {
  it('рисует шапку, содержимое и нижнюю панель', () => {
    render(
      <FormSheet lang="ru" title="Новая бронь" subtitle="Гость" onClose={() => {}} footer={<button>Сохранить</button>}>
        <input aria-label="Имя" />
      </FormSheet>
    )

    expect(screen.getByRole('dialog', { name: 'Новая бронь' })).toBeInTheDocument()
    expect(screen.getByText('Гость')).toBeInTheDocument()
    expect(screen.getByLabelText('Имя')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeInTheDocument()
  })

  it('закрывается кнопкой и по Escape', () => {
    const onClose = vi.fn()
    render(<FormSheet lang="ru" title="Форма" onClose={onClose}><span /></FormSheet>)

    fireEvent.click(screen.getByRole('button', { name: t('ru', 'close') }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('иврит: лист переключается в RTL', () => {
    render(<FormSheet lang="he" title="הזמנה חדשה" onClose={() => {}}><span /></FormSheet>)
    expect(screen.getByRole('dialog', { name: 'הזמנה חדשה' })).toHaveAttribute('dir', 'rtl')
  })
})
