import { useCallback, useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useLangStore } from '../store/langStore'
import { t } from '../lib/i18n'
import BrandWordmark from '../components/ui/BrandWordmark'
import { classify, pairPhone } from './api'
import { codeFromHash, normalizePairCode, phoneLabel } from './pairCode'
import { useWaiterDrafts, useWaiterSession } from './store'

interface Props {
  /** На этом браузере вошла касса — допуск телефона выключил бы её */
  terminal: boolean
  /** Телефон уже допущен — экран нужен, только если пришёл новый код */
  paired: boolean
}

/**
 * Допуск телефона: QR из кабинета ведёт на /waiter/pair#КОД — код
 * подставляется и отправляется сам. Без QR — ввод кода вручную.
 */
export default function PairScreen({ terminal, paired }: Props) {
  const lang = useLangStore((s) => s.lang)
  const revoked = useWaiterSession((s) => s.revoked)
  const navigate = useNavigate()
  const [hashCode] = useState(() => codeFromHash(window.location.hash))
  const [code, setCode] = useState(hashCode ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const autoSent = useRef(false)

  const submit = useCallback(async (raw: string) => {
    const normalized = normalizePairCode(raw)
    if (!normalized) {
      setError(t(lang, 'wPairInvalid'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await pairPhone(normalized, phoneLabel(navigator.userAgent))
      // Новый допуск — чистый лист: черновики прежней точки здесь чужие
      useWaiterDrafts.getState().clearAll()
      useWaiterSession.getState().setSession(null)
      useWaiterSession.getState().setRevoked(false)
      navigate('/waiter', { replace: true })
    } catch (e) {
      setError(t(lang, classify(e) === 'invalid_code' ? 'wPairInvalid' : 'wPairFailed'))
    } finally {
      setBusy(false)
    }
  }, [lang, navigate])

  useEffect(() => {
    if (hashCode && !terminal && !autoSent.current) {
      autoSent.current = true
      void submit(hashCode)
    }
  }, [hashCode, terminal, submit])

  if (paired && !hashCode) return <Navigate to="/waiter" replace />

  return (
    <div className="min-h-[100dvh] flex flex-col justify-center px-4 py-8">
      <div className="w-full max-w-sm mx-auto">
        <h1 className="mb-8 text-center">
          <BrandWordmark className="text-2xl" />
        </h1>

        {terminal ? (
          <p className="card p-6 text-base text-gray-900 text-center">{t(lang, 'wPairTerminal')}</p>
        ) : (
          <form
            className="card p-6 space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              void submit(code)
            }}
          >
            <div>
              <h2 className="text-xl font-bold text-gray-900">{t(lang, 'wPairTitle')}</h2>
              <p className="text-sm text-gray-500 mt-2">
                {revoked ? t(lang, 'wRevoked') : t(lang, 'wPairHint')}
              </p>
            </div>
            <input
              className="input !text-xl !h-14 text-center tracking-[0.3em] font-semibold uppercase placeholder:tracking-normal placeholder:normal-case placeholder:font-normal placeholder:!text-base"
              dir="ltr"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t(lang, 'wPairCode')}
              autoCapitalize="characters"
              autoComplete="one-time-code"
              autoCorrect="off"
              spellCheck={false}
              maxLength={12}
              disabled={busy}
            />
            {error && <p className="text-sm font-medium text-gray-900" role="alert">{error}</p>}
            <button type="submit" className="btn-primary w-full !h-14 !text-base" disabled={busy}>
              {busy ? t(lang, 'wPairing') : t(lang, 'wPairSubmit')}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
