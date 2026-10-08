import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useLangStore } from '../store/langStore'
import { t } from '../lib/i18n'
import BrandWordmark from '../components/ui/BrandWordmark'
import LangToggle from '../components/ui/LangToggle'
import { classify, unlock } from './api'
import { useWaiterSession } from './store'

const PIN_LENGTH = 4

/**
 * Вход официанта на телефоне: свой PIN, автоотправка на 4-й цифре.
 * Телефон к официанту не привязан — уволенный теряет доступ вместе с PIN.
 */
export default function PinScreen() {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()
  const setSession = useWaiterSession((s) => s.setSession)
  const [pin, setPin] = useState('')
  const [checking, setChecking] = useState(false)
  const [shake, setShake] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const submitting = useRef(false)

  const submit = useCallback(async (full: string) => {
    if (submitting.current) return
    submitting.current = true
    setChecking(true)
    try {
      const r = await unlock(full)
      if (r.ok && r.session_token && r.staff && r.location) {
        setMessage(null)
        // Данные прошлой смены официанта — не этого
        qc.clear()
        setSession({ token: r.session_token, staff: r.staff, location: r.location })
        return
      }
      setMessage(null)
    } catch (e) {
      const kind = classify(e)
      setMessage(
        kind === 'locked' ? t(lang, 'pinLockedOut')
          : kind === 'network' ? t(lang, 'wOffline')
            : t(lang, 'wErrGeneric')
      )
    } finally {
      setChecking(false)
      submitting.current = false
    }
    setShake(true)
    setTimeout(() => setShake(false), 400)
    setPin('')
  }, [lang, qc, setSession])

  const press = useCallback((d: string) => {
    if (checking) return
    const next = (pin + d).slice(0, PIN_LENGTH)
    setPin(next)
    if (next.length === PIN_LENGTH) void submit(next)
  }, [pin, checking, submit])

  const backspace = useCallback(() => {
    if (!checking) setPin((p) => p.slice(0, -1))
  }, [checking])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (/^\d$/.test(e.key)) press(e.key)
      if (e.key === 'Backspace') backspace()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [press, backspace])

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center px-4 py-8 relative">
      <div className="absolute end-4" style={{ top: 'calc(1rem + env(safe-area-inset-top))' }}>
        <LangToggle />
      </div>
      <h1 className="mb-2">
        <BrandWordmark className="text-2xl" />
      </h1>
      <p
        className={`text-sm mb-8 text-center ${message ? 'text-gray-900 font-medium' : 'text-gray-500'}`}
        role={message ? 'alert' : undefined}
      >
        {message ?? (checking ? t(lang, 'checking') : t(lang, 'enterPin'))}
      </p>

      <div className={`flex gap-3 mb-10 ${shake ? 'animate-[shake_0.4s_ease-in-out]' : ''}`}>
        {Array.from({ length: PIN_LENGTH }).map((_, i) => (
          <div
            key={i}
            className={`w-3.5 h-3.5 rounded-full transition-all duration-150 ${i < pin.length ? 'bg-gray-900 scale-110' : 'bg-gray-200'}`}
          />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-3 w-full max-w-[320px]" dir="ltr">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            onClick={() => press(d)}
            disabled={checking}
            className="card h-16 text-2xl font-bold text-gray-900 active:scale-[0.95] transition-transform"
          >
            {d}
          </button>
        ))}
        <button
          onClick={() => press('0')}
          disabled={checking}
          className="card col-span-2 h-16 text-2xl font-bold text-gray-900 active:scale-[0.95] transition-transform"
        >
          0
        </button>
        <button onClick={backspace} disabled={checking} className="btn-ghost h-16 text-xl" aria-label="backspace">
          ⌫
        </button>
      </div>
    </div>
  )
}
