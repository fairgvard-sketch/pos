import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { openShift } from './api'
import { fetchCurrentLocation } from '../auth/api'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { parseMoney } from '../../lib/money'
import { useNetStore } from '../../lib/offline/net'
import AppSidebar from '../../components/AppSidebar'

/** Экран «смена не открыта»: ввод размена → открытие */
export default function ShiftGate() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const staff = useAuthStore((s) => s.staff)
  const qc = useQueryClient()
  const online = useNetStore((s) => s.online)
  const [floatStr, setFloatStr] = useState('')

  // Префилл размена из настроек точки (Смена → стартовая сумма по умолчанию)
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const defaultFloat = location?.settings?.shift?.default_opening_float ?? null
  const [prefilled, setPrefilled] = useState(false)
  useEffect(() => {
    if (!prefilled && defaultFloat !== null && floatStr === '') {
      setFloatStr(String(defaultFloat / 100))
      setPrefilled(true)
    }
  }, [prefilled, defaultFloat, floatStr])

  const open = useMutation({
    mutationFn: () => {
      const float = floatStr.trim() ? parseMoney(floatStr) : 0
      if (float === null) throw new Error(t(lang, 'openingFloat'))
      return openShift(staff!.id, float)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['current_shift'] }),
    onError: (e) => toast.error(e.message),
  })

  if (!staff) return null

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="sell" />
      <main className="flex-1 bg-white rounded-3xl flex items-center justify-center">
        <form
          onSubmit={(e) => { e.preventDefault(); open.mutate() }}
          className="w-full max-w-sm p-6 text-center"
        >
          <h1 className="text-xl font-black text-gray-900">{t(lang, 'noShiftTitle')}</h1>
          <p className="text-sm text-gray-500 mt-1 mb-6">{t(lang, 'noShiftHint')}</p>

          <div className="text-start mb-5">
            <label className="text-xs font-medium text-gray-500 mb-1 block">{t(lang, 'openingFloat')}</label>
            <input
              className="input tabular-nums text-lg text-center"
              inputMode="decimal"
              autoFocus
              placeholder="0"
              value={floatStr}
              onChange={(e) => setFloatStr(e.target.value)}
            />
            <p className="text-[11px] text-gray-500 mt-1.5">{t(lang, 'openingFloatHint')}</p>
          </div>

          {/* Открытие смены — только онлайн: open_shift не идемпотентен,
              а без смены сервер всё равно не примет replay-продажи */}
          {!online && (
            <p className="text-xs text-amber-600 font-semibold mb-2">{t(lang, 'offlineBlockedHint')}</p>
          )}
          <button type="submit" disabled={open.isPending || !online} className="btn-primary w-full !py-3.5 !rounded-2xl">
            {t(lang, 'openShift')}
          </button>
        </form>
      </main>
    </div>
  )
}
