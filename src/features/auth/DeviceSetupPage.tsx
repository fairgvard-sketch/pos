import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { signInDevice, signUpDevice, bootstrapOrg, getDeviceContext } from './api'
import { t } from '../../lib/i18n'
import { useLangStore } from '../../store/langStore'
import LangToggle from '../../components/ui/LangToggle'

type Step = 'auth' | 'org'

/**
 * Одноразовая настройка устройства:
 * 1. Вход/регистрация аккаунта кофейни (Supabase Auth).
 * 2. Если организации ещё нет — онбординг (bootstrap_org).
 */
export default function DeviceSetupPage() {
  const navigate = useNavigate()
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'

  const [step, setStep] = useState<Step>('auth')
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [busy, setBusy] = useState(false)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const [orgName, setOrgName] = useState('')
  const [locationName, setLocationName] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [ownerPin, setOwnerPin] = useState('')

  async function handleAuth(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      if (mode === 'signin') {
        await signInDevice(email, password)
      } else {
        await signUpDevice(email, password)
      }
      const ctx = await getDeviceContext()
      if (ctx?.orgId) {
        navigate('/pin', { replace: true })
      } else {
        setStep('org')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'confirm-email') {
        toast('Подтвердите email по ссылке из письма, затем войдите', { duration: 6000 })
        setMode('signin')
      } else {
        toast.error(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleBootstrap(e: React.FormEvent) {
    e.preventDefault()
    if (!/^\d{4,8}$/.test(ownerPin)) {
      toast.error(t(lang, 'ownerPin'))
      return
    }
    setBusy(true)
    try {
      await bootstrapOrg(orgName.trim(), locationName.trim(), ownerName.trim(), ownerPin)
      navigate('/pin', { replace: true })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="min-h-screen bg-[#f8f9fb] flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-black text-gray-900">{t(lang, 'appName')}</h1>
          <LangToggle />
        </div>

        {step === 'auth' && (
          <form onSubmit={handleAuth} className="card p-6 space-y-4">
            <div>
              <h2 className="text-lg font-bold text-gray-900">{t(lang, 'deviceSetup')}</h2>
              <p className="text-sm text-gray-500 mt-1">{t(lang, 'deviceSetupHint')}</p>
            </div>

            <div className="space-y-3">
              <input
                type="email"
                required
                autoComplete="email"
                className="input"
                placeholder={t(lang, 'email')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <input
                type="password"
                required
                minLength={6}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                className="input"
                placeholder={t(lang, 'password')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <button type="submit" disabled={busy} className="btn-primary w-full">
              {busy ? t(lang, 'signingIn') : t(lang, mode === 'signin' ? 'signIn' : 'signUp')}
            </button>

            <button
              type="button"
              className="btn-ghost w-full"
              onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
            >
              {t(lang, mode === 'signin' ? 'noAccount' : 'haveAccount')}{' '}
              <span className="font-semibold">
                {t(lang, mode === 'signin' ? 'signUp' : 'signIn')}
              </span>
            </button>
          </form>
        )}

        {step === 'org' && (
          <form onSubmit={handleBootstrap} className="card p-6 space-y-4">
            <div>
              <h2 className="text-lg font-bold text-gray-900">{t(lang, 'orgSetup')}</h2>
              <p className="text-sm text-gray-500 mt-1">{t(lang, 'orgSetupHint')}</p>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-500 mb-1 block">{t(lang, 'orgName')}</label>
                <input
                  required
                  className="input"
                  placeholder={t(lang, 'orgNamePlaceholder')}
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-500 mb-1 block">{t(lang, 'locationName')}</label>
                <input
                  required
                  className="input"
                  placeholder={t(lang, 'locationNamePlaceholder')}
                  value={locationName}
                  onChange={(e) => setLocationName(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-500 mb-1 block">{t(lang, 'ownerName')}</label>
                <input
                  required
                  className="input"
                  placeholder={t(lang, 'ownerNamePlaceholder')}
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-500 mb-1 block">{t(lang, 'ownerPin')}</label>
                <input
                  required
                  inputMode="numeric"
                  pattern="\d{4,8}"
                  maxLength={8}
                  className="input tracking-[0.5em] font-bold"
                  value={ownerPin}
                  onChange={(e) => setOwnerPin(e.target.value.replace(/\D/g, ''))}
                />
              </div>
            </div>

            <button type="submit" disabled={busy} className="btn-primary w-full">
              {busy ? t(lang, 'creating') : t(lang, 'createOrg')}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
