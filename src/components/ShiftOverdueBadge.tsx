import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { fetchCurrentShift } from '../features/shift/api'
import { fetchCurrentLocation } from '../features/auth/api'
import { useShiftOverdue } from '../features/shift/overdue'
import { useLangStore } from '../store/langStore'
import { t } from '../lib/i18n'

/**
 * Постоянное предупреждение о просроченной смене (пересекла границу
 * операционного дня) — в сайдбаре, то есть на всех рабочих экранах.
 * Ничего не рисует, пока смена в пределах опердня. Тап ведёт на страницу
 * смены: пересчитать кассу и закрыть.
 */
export default function ShiftOverdueBadge() {
  const lang = useLangStore((s) => s.lang)
  const navigate = useNavigate()
  const { data: shift } = useQuery({ queryKey: ['current_shift'], queryFn: fetchCurrentShift })
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const { daysCrossed, hours } = useShiftOverdue(
    shift?.opened_at,
    location?.settings?.shift?.day_cutoff
  )

  if (!shift || daysCrossed < 1) return null

  return (
    <button
      onClick={() => navigate('/shift')}
      className="w-full rounded-xl border bg-red-50 text-red-700 border-red-200
                 px-2 py-2 text-[11px] font-bold leading-tight text-center
                 hover:bg-red-100 transition-colors active:scale-[0.97]"
    >
      {t(lang, 'shiftOverdueBadge')}
      <span className="block font-semibold text-[10px] mt-0.5">
        {t(lang, 'shiftOverdueFor')
          .replace('{days}', String(daysCrossed))
          .replace('{hours}', String(hours))}
      </span>
    </button>
  )
}
