import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { signInDevice, signUpDevice, bootstrapOrg, getDeviceContext } from './api'
import { t, translations } from '../../lib/i18n'
import { useLangStore } from '../../store/langStore'
import type { Lang } from '../../lib/i18n'
import LangToggle from '../../components/ui/LangToggle'
import ArrowLogo from '../../components/ui/ArrowLogo'

type TKey = keyof typeof translations.ru

type Step = 'auth' | 'biz' | 'owner'

/** Правая брендовая панель: тёмная, список возможностей POS (без фото — CSP). */
function BrandPanel({ lang }: { lang: Lang }) {
  const features: TKey[] = [
    'arrowFeatSpeed',
    'arrowFeatTables',
    'arrowFeatLoyalty',
    'arrowFeatTips',
    'arrowFeatReceipts',
    'arrowFeatReports',
    'arrowFeatStaff',
    'arrowFeatOffline',
  ]
  return (
    <div className="hidden lg:flex flex-col justify-between bg-gray-900 text-white rounded-3xl p-10 xl:p-12 h-full">
      <div className="flex items-center gap-3">
        <ArrowLogo className="w-8 h-8 text-white/90" />
        <span className="text-lg font-bold tracking-tight">{t(lang, 'arrowBrand')}</span>
      </div>

      <div>
        <h2 className="text-3xl xl:text-4xl font-black leading-tight mb-8">
          {t(lang, 'arrowPanelTitle')}
        </h2>
        <ul className="space-y-4">
          {features.map((key) => (
            <li key={key} className="flex items-center gap-3 text-base text-white/90">
              <svg viewBox="0 0 20 20" className="w-5 h-5 shrink-0 text-white/60" fill="none">
                <path
                  d="M5 10.5l3.5 3.5L15 6.5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {t(lang, key)}
            </li>
          ))}
        </ul>
      </div>

      <p className="text-sm text-white/40">© {new Date().getFullYear()} {t(lang, 'arrowBrand')}</p>
    </div>
  )
}

/**
 * Одноразовая настройка кассы в стиле Square — двухколоночный мастер:
 *  1. auth  — вход/регистрация аккаунта заведения (Supabase Auth).
 *  2. biz   — название бизнеса, название точки, адрес (адрес → в реквизиты чека).
 *  3. owner — имя владельца + PIN → bootstrap_org.
 * Если у устройства уже есть org — сразу /pin.
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
  const [address, setAddress] = useState('')
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
        setStep('biz')
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

  function handleBiz(e: React.FormEvent) {
    e.preventDefault()
    if (!orgName.trim() || !locationName.trim()) return
    setStep('owner')
  }

  async function handleBootstrap(e: React.FormEvent) {
    e.preventDefault()
    if (!/^\d{4,8}$/.test(ownerPin)) {
      toast.error(t(lang, 'ownerPin'))
      return
    }
    setBusy(true)
    try {
      await bootstrapOrg(orgName.trim(), locationName.trim(), ownerName.trim(), ownerPin, address)
      navigate('/pin', { replace: true })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onboarding = step !== 'auth'

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="min-h-screen bg-white p-4 lg:p-6">
      <div className="mx-auto max-w-6xl h-full min-h-[calc(100vh-2rem)] lg:min-h-[calc(100vh-3rem)] grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        {/* ── Левая колонка: форма ─────────────────────────── */}
        <div className="flex flex-col">
          {/* Шапка: логотип + язык */}
          <div className="flex items-center justify-between mb-10 lg:mb-16">
            <div className="flex items-center gap-2.5">
              <ArrowLogo className="w-8 h-8 text-gray-900" />
              <span className="text-lg font-bold tracking-tight text-gray-900">
                {t(lang, 'arrowBrand')}
              </span>
            </div>
            <LangToggle />
          </div>

          <div className="flex-1 flex flex-col justify-center max-w-md w-full mx-auto lg:mx-0">
            {/* Индикатор шага онбординга */}
            {onboarding && (
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                {t(lang, 'stepOf')} {step === 'biz' ? 1 : 2}/2
              </p>
            )}

            {/* ── Шаг 1: вход / регистрация ── */}
            {step === 'auth' && (
              <form onSubmit={handleAuth} className="space-y-6">
                <div>
                  <h1 className="text-3xl font-black text-gray-900 tracking-tight">
                    {t(lang, mode === 'signin' ? 'setupSignInTitle' : 'setupSignUpTitle')}
                  </h1>
                  <p className="text-sm text-gray-500 mt-2 leading-relaxed">
                    {t(lang, mode === 'signin' ? 'setupSignInSub' : 'setupSignUpSub')}
                  </p>
                </div>

                <div className="space-y-3">
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    className="input h-13 px-5 text-base rounded-2xl"
                    placeholder={t(lang, 'email')}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  <input
                    type="password"
                    required
                    minLength={6}
                    autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                    className="input h-13 px-5 text-base rounded-2xl"
                    placeholder={t(lang, 'password')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>

                <button
                  type="submit"
                  disabled={busy}
                  className="btn-primary w-full h-13 rounded-full text-base"
                >
                  {busy
                    ? t(lang, 'signingIn')
                    : t(lang, mode === 'signin' ? 'setupContinue' : 'setupCreateAccount')}
                </button>

                <p className="text-sm text-gray-500 text-center">
                  {t(lang, mode === 'signin' ? 'setupNewHere' : 'setupAlready')}{' '}
                  <button
                    type="button"
                    className="font-semibold text-gray-900 underline underline-offset-2 hover:text-gray-700"
                    onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
                  >
                    {t(lang, mode === 'signin' ? 'signUp' : 'signIn')}
                  </button>
                </p>
              </form>
            )}

            {/* ── Шаг 2: бизнес ── */}
            {step === 'biz' && (
              <form onSubmit={handleBiz} className="space-y-6">
                <div>
                  <h1 className="text-3xl font-black text-gray-900 tracking-tight">
                    {t(lang, 'bizStepTitle')}
                  </h1>
                  <p className="text-sm text-gray-500 mt-2 leading-relaxed">
                    {t(lang, 'bizStepHint')}
                  </p>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="text-xs font-semibold text-gray-500 mb-1.5 block">
                      {t(lang, 'orgName')}
                    </label>
                    <input
                      required
                      autoFocus
                      className="input h-13 px-5 text-base rounded-2xl"
                      value={orgName}
                      onChange={(e) => setOrgName(e.target.value)}
                    />
                    <p className="text-xs text-gray-500 mt-1.5">{t(lang, 'orgNameHint')}</p>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-gray-500 mb-1.5 block">
                      {t(lang, 'locationName')}
                    </label>
                    <input
                      required
                      className="input h-13 px-5 text-base rounded-2xl"
                      value={locationName}
                      onChange={(e) => setLocationName(e.target.value)}
                    />
                    <p className="text-xs text-gray-500 mt-1.5">{t(lang, 'locationNameHint')}</p>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-gray-500 mb-1.5 block">
                      {t(lang, 'bizAddress')}
                    </label>
                    <input
                      className="input h-13 px-5 text-base rounded-2xl"
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                    />
                    <p className="text-xs text-gray-500 mt-1.5">{t(lang, 'bizAddressHint')}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="btn-ghost h-13 px-6 rounded-full text-base"
                    onClick={() => setStep('auth')}
                  >
                    {t(lang, 'back')}
                  </button>
                  <button type="submit" className="btn-primary flex-1 h-13 rounded-full text-base">
                    {t(lang, 'setupNext')}
                  </button>
                </div>
              </form>
            )}

            {/* ── Шаг 3: владелец + PIN ── */}
            {step === 'owner' && (
              <form onSubmit={handleBootstrap} className="space-y-6">
                <div>
                  <h1 className="text-3xl font-black text-gray-900 tracking-tight">
                    {t(lang, 'ownerStepTitle')}
                  </h1>
                  <p className="text-sm text-gray-500 mt-2 leading-relaxed">
                    {t(lang, 'ownerStepHint')}
                  </p>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-semibold text-gray-500 mb-1.5 block">
                      {t(lang, 'ownerName')}
                    </label>
                    <input
                      required
                      autoFocus
                      className="input h-13 px-5 text-base rounded-2xl"
                      placeholder={t(lang, 'ownerNamePlaceholder')}
                      value={ownerName}
                      onChange={(e) => setOwnerName(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-gray-500 mb-1.5 block">
                      {t(lang, 'ownerPin')}
                    </label>
                    <input
                      required
                      inputMode="numeric"
                      pattern="\d{4,8}"
                      maxLength={8}
                      className="input h-13 px-5 text-2xl rounded-2xl tracking-[0.5em] font-bold text-center"
                      value={ownerPin}
                      onChange={(e) => setOwnerPin(e.target.value.replace(/\D/g, ''))}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    disabled={busy}
                    className="btn-ghost h-13 px-6 rounded-full text-base"
                    onClick={() => setStep('biz')}
                  >
                    {t(lang, 'back')}
                  </button>
                  <button
                    type="submit"
                    disabled={busy}
                    className="btn-primary flex-1 h-13 rounded-full text-base"
                  >
                    {busy ? t(lang, 'creating') : t(lang, 'createOrg')}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>

        {/* ── Правая колонка: брендовая панель ─────────────── */}
        <BrandPanel lang={lang} />
      </div>
    </div>
  )
}
