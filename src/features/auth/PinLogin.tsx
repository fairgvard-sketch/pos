import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { loginByPin } from './api'
import { clockIn, clockOut } from '../analytics/api'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import LangToggle from '../../components/ui/LangToggle'
import type { Staff } from '../../types'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫']

export default function PinLogin() {
  const [pin, setPin] = useState('')
  const [loading, setLoading] = useState(false)
  const [shake, setShake] = useState(false)
  const [clockStaff, setClockStaff] = useState<Staff | null>(null)
  const [clockLoading, setClockLoading] = useState(false)
  const setStaff = useAuthStore((s) => s.setStaff)
  const navigate = useNavigate()
  const lang = useLangStore((s) => s.lang)
  const isRu = lang === 'ru'

  const handleKey = (key: string) => {
    if (loading) return
    if (key === '⌫') { setPin((p) => p.slice(0, -1)); return }
    if (!key) return
    const next = pin + key
    setPin(next)
    if (next.length === 4) submit(next)
  }

  const submit = async (code: string) => {
    setLoading(true)
    try {
      const staff = await loginByPin(code)
      setStaff(staff)
      if (staff.role === 'kitchen') navigate('/kitchen')
      else if (staff.role === 'manager') navigate('/hub')
      else setClockStaff(staff) // waiter — показываем экран отметки
    } catch {
      toast.error(t(lang, 'wrongPin'))
      setPin('')
      setShake(true)
      setTimeout(() => setShake(false), 500)
    } finally {
      setLoading(false)
    }
  }

  const handleClock = async (type: 'clock_in' | 'clock_out') => {
    if (!clockStaff) return
    setClockLoading(true)
    try {
      if (type === 'clock_in') await clockIn(clockStaff.id)
      else await clockOut(clockStaff.id)
      toast.success(type === 'clock_in'
        ? (isRu ? 'Приход отмечен' : 'כניסה סומנה')
        : (isRu ? 'Уход отмечен' : 'יציאה סומנה'))
    } catch {
      // не критично — всё равно пускаем
    } finally {
      setClockLoading(false)
      navigate('/tables')
    }
  }

  // Экран отметки прихода/ухода для официанта
  if (clockStaff) {
    return (
      <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center p-4">
        <div className="w-full max-w-[320px] flex flex-col items-center gap-6">
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 bg-gray-900 rounded-2xl mb-4">
              <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3v7a4 4 0 004 4v7M7 3v4M11 3v4M15 3c0 0 2 1.5 2 5s-2 5-2 5v8" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-900">{clockStaff.name}</h2>
            <p className="text-sm text-gray-400 mt-1">
              {isRu ? 'Отметьте начало или конец смены' : 'סמן תחילת או סיום משמרת'}
            </p>
          </div>

          <div className="w-full flex flex-col gap-3">
            <button
              onClick={() => handleClock('clock_in')}
              disabled={clockLoading}
              className="btn-success w-full py-4 text-base font-semibold rounded-2xl"
            >
              {isRu ? 'Начало смены' : 'תחילת משמרת'}
            </button>
            <button
              onClick={() => handleClock('clock_out')}
              disabled={clockLoading}
              className="btn-danger w-full py-4 text-base font-semibold rounded-2xl"
            >
              {isRu ? 'Конец смены' : 'סיום משמרת'}
            </button>
            <button
              onClick={() => navigate('/tables')}
              disabled={clockLoading}
              className="btn-ghost w-full py-3 text-sm text-gray-400"
            >
              {isRu ? 'Пропустить' : 'דלג'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center p-4">
      {/* Lang toggle top-right */}
      <div className="absolute top-5 right-5">
        <LangToggle />
      </div>

      <div className="w-full max-w-[320px]">
        {/* Logo */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-gray-900 rounded-2xl mb-4">
            <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3v7a4 4 0 004 4v7M7 3v4M11 3v4M15 3c0 0 2 1.5 2 5s-2 5-2 5v8" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">{t(lang, 'appName')}</h1>
          <p className="text-sm text-gray-400 mt-1">{t(lang, 'enterPin')}</p>
        </div>

        {/* PIN dots */}
        <div className={`flex justify-center gap-3 mb-8 ${shake ? 'animate-[shake_0.4s_ease]' : ''}`}>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={`w-3 h-3 rounded-full transition-all duration-200 ${
                i < pin.length
                  ? 'bg-gray-900 scale-110'
                  : 'bg-gray-200'
              }`}
            />
          ))}
        </div>

        {/* Numpad */}
        <div className="grid grid-cols-3 gap-2.5">
          {KEYS.map((key, idx) => (
            <button
              key={idx}
              onClick={() => handleKey(key)}
              disabled={loading || (!key && key !== '0')}
              className={`
                h-[60px] rounded-2xl text-lg font-semibold
                transition-all duration-100 active:scale-[0.93]
                disabled:opacity-0
                ${!key && key !== '0'
                  ? 'invisible pointer-events-none'
                  : key === '⌫'
                  ? 'bg-[#f0f1f3] text-gray-500 hover:bg-[#e8e9ec] hover:text-gray-900'
                  : 'bg-[#f0f1f3] text-gray-900 hover:bg-[#e8e9ec]'
                }
              `}
            >
              {key === '⌫'
                ? <span className="text-base">⌫</span>
                : key
              }
            </button>
          ))}
        </div>

        {loading && (
          <div className="flex items-center justify-center gap-2 mt-6 text-gray-400 text-sm">
            <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
            {t(lang, 'checking')}
          </div>
        )}
      </div>

      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-8px); }
          40% { transform: translateX(8px); }
          60% { transform: translateX(-6px); }
          80% { transform: translateX(6px); }
        }
      `}</style>
    </div>
  )
}
