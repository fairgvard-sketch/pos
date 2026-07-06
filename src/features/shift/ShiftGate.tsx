import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { openShift } from './api'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { parseMoney } from '../../lib/money'
import AppSidebar from '../../components/AppSidebar'

/** Экран «смена не открыта»: ввод размена → открытие */
export default function ShiftGate() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const staff = useAuthStore((s) => s.staff)
  const qc = useQueryClient()
  const [floatStr, setFloatStr] = useState('')

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
          <div className="text-5xl mb-4">🔒</div>
          <h1 className="text-xl font-black text-gray-900">{t(lang, 'noShiftTitle')}</h1>
          <p className="text-sm text-gray-400 mt-1 mb-6">{t(lang, 'noShiftHint')}</p>

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
            <p className="text-[11px] text-gray-400 mt-1.5">{t(lang, 'openingFloatHint')}</p>
          </div>

          <button type="submit" disabled={open.isPending} className="btn-primary w-full !py-3.5 !rounded-2xl">
            {t(lang, 'openShift')}
          </button>
        </form>
      </main>
    </div>
  )
}
