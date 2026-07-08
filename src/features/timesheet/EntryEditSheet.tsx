import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { saveTimeEntry, deleteTimeEntry, type TimeEntryRow } from './api'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'

/** Правим существующую запись либо добавляем смену сотруднику задним числом */
type Target = { entry: TimeEntryRow } | { staffId: string; staffName: string }

function isExisting(x: Target): x is { entry: TimeEntryRow } {
  return 'entry' in x
}

interface Props {
  target: Target
  onClose: () => void
}

function toDateInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function toTimeInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Локальные дата + «ЧЧ:ММ» → Date */
function combine(dateStr: string, timeStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [hh, mm] = timeStr.split(':').map(Number)
  return new Date(y, m - 1, d, hh, mm)
}

/**
 * Правка табеля менеджером: сотрудник забыл отметиться — добавляем
 * смену задним числом или исправляем время. Уход позже прихода
 * «через полночь» трактуется как следующий день (ночная смена).
 */
export default function EntryEditSheet({ target, onClose }: Props) {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const qc = useQueryClient()
  const actor = useAuthStore((s) => s.staff)
  const existing = isExisting(target)

  const entry = existing ? target.entry : null
  const staffName = existing ? target.entry.staff_name : target.staffName

  const [date, setDate] = useState(() => toDateInput(entry ? new Date(entry.clock_in) : new Date()))
  const [inTime, setInTime] = useState(() => (entry ? toTimeInput(new Date(entry.clock_in)) : ''))
  const [outTime, setOutTime] = useState(() =>
    entry?.clock_out ? toTimeInput(new Date(entry.clock_out)) : ''
  )
  const [note, setNote] = useState(entry?.note ?? '')

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['timesheet'] })
    toast.success(t(lang, 'tsSaved'))
    onClose()
  }

  const save = useMutation({
    mutationFn: async () => {
      const clockIn = combine(date, inTime)
      let clockOut: Date | null = null
      if (outTime) {
        clockOut = combine(date, outTime)
        if (clockOut <= clockIn) clockOut.setDate(clockOut.getDate() + 1) // ночная смена
      }
      await saveTimeEntry({
        entryId: entry?.id ?? null,
        staffId: existing ? target.entry.staff_id : target.staffId,
        clockIn,
        clockOut,
        actorId: actor!.id,
        note: note.trim() || undefined,
      })
    },
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  })

  const remove = useMutation({
    mutationFn: () => deleteTimeEntry(entry!.id, actor!.id),
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  })

  const busy = save.isPending || remove.isPending
  const valid = !!date && !!inTime && combine(date, inTime) <= new Date()

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-xs p-6 max-h-[92vh] overflow-y-auto animate-[rise-in_0.2s_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-black text-gray-900 mb-1">
          {t(lang, existing ? 'tsEditShift' : 'tsAddShift')}
        </h2>
        <p className="text-sm text-gray-500 mb-4">{staffName}</p>

        <label className="block text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">
          {t(lang, 'tsDate')}
        </label>
        <input
          type="date"
          className="input mb-3"
          value={date}
          max={toDateInput(new Date())}
          onChange={(e) => e.target.value && setDate(e.target.value)}
        />

        <div className="grid grid-cols-2 gap-3 mb-1">
          <div>
            <label className="block text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">
              {t(lang, 'tsClockIn')}
            </label>
            <input type="time" className="input" value={inTime} onChange={(e) => setInTime(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">
              {t(lang, 'tsClockOut')}
            </label>
            <input type="time" className="input" value={outTime} onChange={(e) => setOutTime(e.target.value)} />
          </div>
        </div>
        <p className="text-xs text-gray-400 mb-3">{t(lang, 'tsStillOpen')}</p>

        <label className="block text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">
          {t(lang, 'tsNote')}
        </label>
        <input className="input mb-4" value={note} onChange={(e) => setNote(e.target.value)} />

        <button
          onClick={() => save.mutate()}
          disabled={busy || !valid}
          className="btn-primary w-full !py-3.5 !rounded-2xl"
        >
          {t(lang, 'save')}
        </button>

        {existing && (
          <button
            onClick={() => { if (confirm(t(lang, 'tsConfirmDelete'))) remove.mutate() }}
            disabled={busy}
            className="btn-danger w-full !py-3.5 !rounded-2xl mt-2"
          >
            {t(lang, 'delete')}
          </button>
        )}
      </div>
    </div>
  )
}
