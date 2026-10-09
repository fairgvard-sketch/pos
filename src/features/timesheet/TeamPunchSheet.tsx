import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { punchByPin } from './api'
import { t, type Lang } from '../../lib/i18n'
import { useNetStore } from '../../lib/offline/net'

const PIN_LENGTH = 4
/** Сколько видно подтверждение, прежде чем окно закроется само */
const DONE_MS = 2500

/** Секунды → «Ч:ММ» */
function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}:${m < 10 ? '0' : ''}${m}`
}

/**
 * «Команда» на экране PIN (решение владельца 10.10.2026): сотрудник
 * отмечает приход или уход своим PIN, не входя в кассу. Сервер
 * (punch_by_pin, 095) сам находит сотрудника и переключает приход ⇄ уход,
 * перебор PIN ограничен тем же лимитом, что вход.
 */
export default function TeamPunchSheet({ lang, isRtl, onClose }: { lang: Lang; isRtl: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [pin, setPin] = useState('')
  const [checking, setChecking] = useState(false)
  const [shake, setShake] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const submitting = useRef(false)

  // Подтверждение видно пару секунд, дальше экран снова свободен для следующего
  useEffect(() => {
    if (!done) return
    const id = setTimeout(onClose, DONE_MS)
    return () => clearTimeout(id)
  }, [done, onClose])

  const submit = useCallback(
    async (fullPin: string) => {
      if (submitting.current) return
      // PIN сверяет сервер (bcrypt в БД) — без сети отметки нет
      if (!useNetStore.getState().online) {
        setError(t(lang, 'offlineBlockedHint'))
        setPin('')
        return
      }
      submitting.current = true
      setChecking(true)
      setError(null)
      try {
        const res = await punchByPin(fullPin)
        setDone(res.action === 'in'
          ? `${res.staff_name} — ${t(lang, 'workdayStarted')}`
          : `${res.staff_name} — ${t(lang, 'workdayEnded')}${res.seconds != null ? ` · ${fmtDuration(res.seconds)}` : ''}`)
        void qc.invalidateQueries({ queryKey: ['timesheet'] })
      } catch (e) {
        setError(e instanceof Error && e.message.includes('pin_locked_out') ? t(lang, 'pinLockedOut') : null)
        setShake(true)
        setTimeout(() => setShake(false), 400)
        setPin('')
      } finally {
        setChecking(false)
        submitting.current = false
      }
    },
    [lang, qc]
  )

  const press = useCallback(
    (digit: string) => {
      if (checking || done) return
      const next = (pin + digit).slice(0, PIN_LENGTH)
      setPin(next)
      if (next.length === PIN_LENGTH) void submit(next)
    },
    [pin, checking, done, submit]
  )
  const backspace = useCallback(() => { if (!checking) setPin((p) => p.slice(0, -1)) }, [checking])

  // Физическая клавиатура: пока окно открыто, цифры идут сюда, а не во вход кассы
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (/^\d$/.test(e.key)) press(e.key)
      if (e.key === 'Backspace') backspace()
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [press, backspace, onClose])

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4"
      onClick={() => !checking && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t(lang, 'teamPunch')}
        className="card w-full max-w-sm p-6 text-center"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-2xl font-black text-gray-900">{t(lang, 'teamPunch')}</h2>
        {done ? (
          <p className="text-lg font-bold text-gray-900 py-10" role="status">{done}</p>
        ) : (
          <>
            <p
              className={`text-sm mt-1 mb-6 ${error ? 'text-gray-900 font-semibold' : 'text-gray-500'}`}
              role={error ? 'alert' : undefined}
            >
              {error ?? (checking ? t(lang, 'checking') : t(lang, 'teamPunchHint'))}
            </p>

            <div className={`flex gap-3 mb-6 justify-center ${shake ? 'animate-[shake_0.4s_ease-in-out]' : ''}`}>
              {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                <div key={i} className={`w-3.5 h-3.5 rounded-full transition-all ${i < pin.length ? 'bg-gray-900 scale-110' : 'bg-gray-200'}`} />
              ))}
            </div>

            <div className="grid grid-cols-3 gap-2 w-full max-w-[260px] mx-auto" dir="ltr">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button key={d} onClick={() => press(d)} disabled={checking}
                  className="card-hover h-14 text-xl font-bold text-gray-900 active:scale-[0.95]">
                  {d}
                </button>
              ))}
              <button onClick={() => press('0')} disabled={checking}
                className="card-hover col-span-2 h-14 text-xl font-bold text-gray-900 active:scale-[0.95]">
                0
              </button>
              <button onClick={backspace} disabled={checking} className="btn-ghost h-14 text-lg" aria-label="backspace">⌫</button>
            </div>
          </>
        )}
        <button onClick={onClose} disabled={checking} className="btn-ghost w-full !h-12 mt-4">{t(lang, 'close')}</button>
      </div>
    </div>
  )
}
