import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { verifyStaffPin, fetchCurrentLocation } from './api'
import { fetchCategories, fetchItems, fetchModifierGroups } from '../menu/api'
import { fetchCurrentShift } from '../shift/api'
import { landingRoute } from './landing'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import LangToggle from '../../components/ui/LangToggle'
import BrandWordmark from '../../components/ui/BrandWordmark'

const PIN_LENGTH = 4

/**
 * Экран блокировки кассы. Скорость критична:
 * 4 цифры → автоотправка, без кнопки OK. Работает и с клавиатуры.
 */
export default function PinLoginPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const lang = useLangStore((s) => s.lang)
  const setStaff = useAuthStore((s) => s.setStaff)
  const isRtl = lang === 'he'

  const [pin, setPin] = useState('')
  const [checking, setChecking] = useState(false)
  const [shake, setShake] = useState(false)
  // Блокировка после серии неудач (throttle 095): без явного текста кассир
  // видел бы обычную тряску и не понимал, почему верный PIN не пускает.
  const [lockedOut, setLockedOut] = useState(false)
  const submitting = useRef(false)

  // Греем кэш рабочего экрана, пока кассир вводит PIN: сессия устройства
  // уже есть (RLS пропустит), и после 4-й цифры каталог рисуется мгновенно.
  // prefetchQuery уважает staleTime и не дублирует уже идущие запросы.
  useEffect(() => {
    qc.prefetchQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
    qc.prefetchQuery({ queryKey: ['current_shift'], queryFn: fetchCurrentShift })
    qc.prefetchQuery({ queryKey: ['menu_categories'], queryFn: fetchCategories })
    qc.prefetchQuery({ queryKey: ['menu_items'], queryFn: fetchItems })
    qc.prefetchQuery({ queryKey: ['modifier_groups'], queryFn: fetchModifierGroups })
  }, [qc])

  const submit = useCallback(
    async (fullPin: string) => {
      if (submitting.current) return
      submitting.current = true
      setChecking(true)
      try {
        const staff = await verifyStaffPin(fullPin)
        setLockedOut(false)
        setStaff(staff)
        // Сразу на рабочий экран (зал/продажа по режиму точки), минуя хаб.
        // Режим берём из кэша, иначе тянем (кэшируется на будущее).
        const location = await qc.ensureQueryData({
          queryKey: ['current_location'],
          queryFn: fetchCurrentLocation,
        })
        navigate(landingRoute(location.service_mode), { replace: true })
      } catch (e) {
        setLockedOut(e instanceof Error && e.message === 'pin-locked-out')
        setShake(true)
        setTimeout(() => setShake(false), 400)
        setPin('')
      } finally {
        setChecking(false)
        submitting.current = false
      }
    },
    [navigate, setStaff, qc]
  )

  const press = useCallback(
    (digit: string) => {
      if (checking) return
      const next = (pin + digit).slice(0, PIN_LENGTH)
      setPin(next)
      if (next.length === PIN_LENGTH) submit(next)
    },
    [pin, checking, submit]
  )

  const backspace = useCallback(() => {
    if (!checking) setPin((p) => p.slice(0, -1))
  }, [checking])

  // Физическая клавиатура — кассир может работать без тача
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (/^\d$/.test(e.key)) press(e.key)
      if (e.key === 'Backspace') backspace()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [press, backspace])

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="min-h-screen bg-[#f8f9fb] flex flex-col items-center justify-center p-6">
      <div className="absolute top-4 end-4">
        <LangToggle />
      </div>

      <h1 className="mb-2">
        <BrandWordmark className="text-2xl" />
      </h1>
      <p
        className={`text-sm mb-8 ${lockedOut ? 'text-gray-900 font-medium' : 'text-gray-500'}`}
        role={lockedOut ? 'alert' : undefined}
      >
        {lockedOut
          ? t(lang, 'pinLockedOut')
          : checking
            ? t(lang, 'checking')
            : t(lang, 'enterPin')}
      </p>

      {/* Индикатор ввода */}
      <div className={`flex gap-3 mb-10 ${shake ? 'animate-[shake_0.4s_ease-in-out]' : ''}`}>
        {Array.from({ length: PIN_LENGTH }).map((_, i) => (
          <div
            key={i}
            className={`w-3.5 h-3.5 rounded-full transition-all duration-150 ${
              i < pin.length ? 'bg-gray-900 scale-110' : 'bg-gray-200'
            }`}
          />
        ))}
      </div>

      {/* PIN-пад */}
      <div className="grid grid-cols-3 gap-3 w-full max-w-[280px]">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            onClick={() => press(d)}
            disabled={checking}
            className="card-hover h-16 text-xl font-bold text-gray-900 active:scale-[0.95]"
          >
            {d}
          </button>
        ))}
        {/* 0 — широкая клавиша на 2 колонки; ⌫ рядом (RTL зеркалит порядок сам) */}
        <button
          onClick={() => press('0')}
          disabled={checking}
          className="card-hover col-span-2 h-16 text-xl font-bold text-gray-900 active:scale-[0.95]"
        >
          0
        </button>
        <button
          onClick={backspace}
          disabled={checking}
          className="btn-ghost h-16 text-lg"
          aria-label="backspace"
        >
          ⌫
        </button>
      </div>
    </div>
  )
}
