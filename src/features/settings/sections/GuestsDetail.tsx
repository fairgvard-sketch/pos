import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { searchGuests, formatPhone } from '../../loyalty/api'
import { useLangStore } from '../../../store/langStore'
import { t, formatDate } from '../../../lib/i18n'
import { formatMoney } from '../../../lib/money'
import type { Location } from '../../../types'

/** Деталь «Гости»: поиск + балансы лояльности (перенос из LoyaltyTab) */
export default function GuestsDetail({ location }: { location: Location | undefined }) {
  const lang = useLangStore((s) => s.lang)
  const [guestQuery, setGuestQuery] = useState('')
  const { data: guests = [] } = useQuery({
    queryKey: ['guests', guestQuery],
    queryFn: () => searchGuests(guestQuery),
    placeholderData: (prev) => prev,
  })

  const pointsMode = location?.loyalty_mode === 'points'

  return (
    <div>
      <input
        className="input mb-3"
        placeholder={t(lang, 'guestSearchPh')}
        value={guestQuery}
        onChange={(e) => setGuestQuery(e.target.value)}
      />
      <div className="space-y-1.5">
        {guests.map((g) => (
          <div
            key={g.id}
            className="px-4 py-2.5 rounded-xl border border-gray-100 bg-white flex items-center justify-between gap-3"
          >
            <div className="min-w-0">
              <div className="font-semibold text-gray-900 text-sm truncate">{g.name || formatPhone(g.phone)}</div>
              <div className="text-xs text-gray-500 tabular-nums">
                {g.name && `${formatPhone(g.phone)} · `}
                {t(lang, 'guestVisits')}: {g.visits}
                {g.last_visit_at && ` · ${formatDate(g.last_visit_at, lang)}`}
              </div>
            </div>
            <div className="shrink-0 text-sm font-bold text-gray-900 tabular-nums text-end">
              {pointsMode ? formatMoney(g.points, lang) : `${g.stamps} ${t(lang, 'stampsShort')}`}
            </div>
          </div>
        ))}
        {guests.length === 0 && <p className="text-sm text-gray-500 text-center py-6">{t(lang, 'guestNotFound')}</p>}
      </div>
    </div>
  )
}
