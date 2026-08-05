import { useMemo, useState } from 'react'
import { toDateKey } from './api'
import { monthRange, monthTitle } from './hours'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'

export interface HoursReportRequest {
  staffId: string | null
  staffName: string
  from: Date
  to: Date
}

interface Props {
  /** «Один сотрудник» требует выбора человека, свод — нет */
  mode: 'staff' | 'summary'
  staff: { staff_id: string; name: string }[]
  onCancel: () => void
  onSubmit: (req: HoursReportRequest) => void
}

/** YYYY-MM-DD → локальная дата (не UTC, иначе дата съедет на день) */
function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * Форма отчёта по часам: сотрудник и период.
 *
 * Повторяет привычный владельцу порядок из старой кассы — сначала кого и
 * за когда, потом сам отчёт, — но пресетами вместо двух дат: «этот месяц»
 * и «прошлый месяц» закрывают почти все запросы, а произвольные даты
 * остаются третьей кнопкой для тех случаев, когда нужны именно они.
 *
 * Имена сотрудников — плитками, а не выпадающим списком: по списку из
 * восьми человек пальцем на терминале не попадают.
 */
export default function HoursReportSheet({ mode, staff, onCancel, onSubmit }: Props) {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const locale = isRtl ? 'he-IL' : 'ru-RU'

  const now = new Date()
  const [staffId, setStaffId] = useState<string | null>(null)
  const [preset, setPreset] = useState<'month' | 'prev' | 'custom'>('month')
  const [customFrom, setCustomFrom] = useState(() => toDateKey(monthRange(now.getFullYear(), now.getMonth())[0]))
  const [customTo, setCustomTo] = useState(() => toDateKey(now))

  const [from, to] = useMemo<[Date, Date]>(() => {
    // «Сегодня» берётся внутри: вынесенное наружу оно было бы новым
    // объектом на каждый рендер и обнуляло бы мемоизацию
    const today = new Date()
    if (preset === 'month') return monthRange(today.getFullYear(), today.getMonth())
    if (preset === 'prev') {
      const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      return monthRange(prev.getFullYear(), prev.getMonth())
    }
    let f = parseDate(customFrom)
    let tt = parseDate(customTo)
    if (tt < f) [f, tt] = [tt, f] // перепутанный диапазон — молча чиним
    return [f, tt]
  }, [preset, customFrom, customTo])

  const ready = mode === 'summary' || staffId !== null
  const picked = staff.find((s) => s.staff_id === staffId)

  const PRESETS: { key: 'month' | 'prev' | 'custom'; label: string }[] = [
    { key: 'month', label: t(lang, 'thisMonth') },
    { key: 'prev', label: t(lang, 'tsLastMonth') },
    { key: 'custom', label: t(lang, 'periodCustom') },
  ]

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="card w-full max-w-lg max-h-[92vh] flex flex-col overflow-hidden animate-[rise-in_0.2s_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-6 pt-6 pb-4">
          <h2 className="text-xl font-black text-gray-900">
            {t(lang, mode === 'summary' ? 'tsReportSummary' : 'tsReportStaff')}
          </h2>
          <p className="text-sm text-gray-500">
            {t(lang, mode === 'summary' ? 'tsReportSummaryHint' : 'tsReportStaffHint')}
          </p>
        </header>

        <div className="flex-1 overflow-y-auto px-6">
          {mode === 'staff' && (
            <>
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">
                {t(lang, 'tsPickStaff')}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-6">
                {staff.map((s) => (
                  <button
                    key={s.staff_id}
                    onClick={() => setStaffId(s.staff_id)}
                    className={`min-h-14 px-3 rounded-2xl text-sm font-bold transition-all active:scale-[0.97] ${
                      s.staff_id === staffId
                        ? 'bg-gray-900 text-white'
                        : 'bg-white border border-gray-200 text-gray-900 hover:border-gray-300'
                    }`}
                  >
                    <span className="line-clamp-2">{s.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">
            {t(lang, 'tsPeriod')}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPreset(p.key)}
                className={`min-h-12 px-3 rounded-2xl text-sm font-bold transition-all active:scale-[0.97] ${
                  preset === p.key
                    ? 'bg-gray-900 text-white'
                    : 'bg-white border border-gray-200 text-gray-900 hover:border-gray-300'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {preset === 'custom' ? (
            <div className="flex items-center gap-2 mt-3">
              <input type="date" className="input !py-2.5" value={customFrom} max={toDateKey(now)}
                onChange={(e) => e.target.value && setCustomFrom(e.target.value)} />
              <span className="text-gray-400 shrink-0">—</span>
              <input type="date" className="input !py-2.5" value={customTo} max={toDateKey(now)}
                onChange={(e) => e.target.value && setCustomTo(e.target.value)} />
            </div>
          ) : (
            // Пресет обязан назвать себя датами: «этот месяц» в первых
            // числах — это два дня, а не тридцать, и это должно быть видно
            <p className="text-sm text-gray-500 mt-2 tabular-nums" dir="ltr">
              {preset === 'prev'
                ? monthTitle(from.getFullYear(), from.getMonth(), locale)
                : `${from.toLocaleDateString(locale)} — ${to.toLocaleDateString(locale)}`}
            </p>
          )}
        </div>

        <footer className="px-6 py-4 flex gap-2">
          <button onClick={onCancel} className="btn-secondary flex-1 !py-3.5 !rounded-2xl">
            {t(lang, 'close')}
          </button>
          <button
            onClick={() => onSubmit({ staffId, staffName: picked?.name ?? '', from, to })}
            disabled={!ready}
            className="btn-primary flex-1 !py-3.5 !rounded-2xl"
          >
            {t(lang, 'tsShowReport')}
          </button>
        </footer>
      </div>
    </div>
  )
}
