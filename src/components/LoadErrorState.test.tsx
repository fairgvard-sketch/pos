import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import LoadErrorState from './LoadErrorState'
import { useLangStore } from '../store/langStore'
import { t } from '../lib/i18n'

describe('LoadErrorState (P1-7)', () => {
  it('показывает заголовок, дефолтный hint и кнопку повтора', () => {
    useLangStore.setState({ lang: 'ru' })
    const onRetry = vi.fn()
    render(<LoadErrorState title="Не удалось проверить смену" onRetry={onRetry} />)

    expect(screen.getByText('Не удалось проверить смену')).toBeInTheDocument()
    expect(screen.getByText(t('ru', 'dataLoadErrorHint'))).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: t('ru', 'offlineRetry') }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('кастомный hint вытесняет дефолтный', () => {
    useLangStore.setState({ lang: 'ru' })
    render(<LoadErrorState title="Ошибка" hint="Свой текст" onRetry={() => {}} />)
    expect(screen.getByText('Свой текст')).toBeInTheDocument()
    expect(screen.queryByText(t('ru', 'dataLoadErrorHint'))).not.toBeInTheDocument()
  })

  it('иврит: кнопка повтора локализована', () => {
    useLangStore.setState({ lang: 'he' })
    render(<LoadErrorState title="שגיאה" onRetry={() => {}} />)
    expect(screen.getByRole('button', { name: t('he', 'offlineRetry') })).toBeInTheDocument()
  })
})
