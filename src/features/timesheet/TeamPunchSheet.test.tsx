import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TeamPunchSheet from './TeamPunchSheet'
import { t } from '../../lib/i18n'
import { useNetStore } from '../../lib/offline/net'

const punchByPin = vi.fn()
vi.mock('./api', () => ({ punchByPin: (pin: string) => punchByPin(pin) }))

function setup() {
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TeamPunchSheet lang="ru" isRtl={false} onClose={onClose} />
    </QueryClientProvider>
  )
  return { onClose }
}

const typePin = (pin: string) => {
  for (const d of pin) fireEvent.click(screen.getByRole('button', { name: d }))
}

describe('TeamPunchSheet: приход и уход с экрана PIN', () => {
  beforeEach(() => {
    punchByPin.mockReset()
    useNetStore.setState({ online: true })
  })

  it('четвёртая цифра отмечает приход и показывает, кто пришёл', async () => {
    punchByPin.mockResolvedValue({ action: 'in', staff_name: 'Noa' })
    setup()
    typePin('2468')
    expect(punchByPin).toHaveBeenCalledWith('2468')
    expect(await screen.findByRole('status')).toHaveTextContent(`Noa — ${t('ru', 'workdayStarted')}`)
  })

  it('уход — с отработанным временем', async () => {
    punchByPin.mockResolvedValue({ action: 'out', staff_name: 'Noa', seconds: 8 * 3600 + 5 * 60 })
    setup()
    typePin('2468')
    expect(await screen.findByRole('status')).toHaveTextContent(`Noa — ${t('ru', 'workdayEnded')} · 8:05`)
  })

  it('без сети ничего не отмечает и объясняет почему', async () => {
    useNetStore.setState({ online: false })
    setup()
    typePin('2468')
    expect(punchByPin).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(t('ru', 'offlineBlockedHint'))
  })

  it('перебор PIN — понятное сообщение', async () => {
    punchByPin.mockRejectedValue(new Error('pin_locked_out'))
    setup()
    typePin('1111')
    expect(await screen.findByRole('alert')).toHaveTextContent(t('ru', 'pinLockedOut'))
  })
})
