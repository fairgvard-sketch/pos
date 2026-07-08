import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useDeviceStore } from '../store/deviceStore'

/**
 * Автоблокировка кассы: N секунд без касаний/клавиш → сброс PIN-сессии
 * и экран PIN (Square: Security → Timeout). Рендерит null, живёт в App.
 */
export default function AutoLock() {
  const staff = useAuthStore((s) => s.staff)
  const lock = useAuthStore((s) => s.lock)
  const autoLockSec = useDeviceStore((s) => s.autoLockSec)
  const navigate = useNavigate()

  useEffect(() => {
    if (!staff || autoLockSec <= 0) return

    let timer: ReturnType<typeof setTimeout>
    const fire = () => {
      lock()
      navigate('/pin', { replace: true })
    }
    const reset = () => {
      clearTimeout(timer)
      timer = setTimeout(fire, autoLockSec * 1000)
    }

    // Любое взаимодействие сбрасывает отсчёт
    const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'touchstart', 'wheel']
    for (const ev of events) window.addEventListener(ev, reset, { passive: true })
    reset()

    return () => {
      clearTimeout(timer)
      for (const ev of events) window.removeEventListener(ev, reset)
    }
  }, [staff, autoLockSec, lock, navigate])

  return null
}
