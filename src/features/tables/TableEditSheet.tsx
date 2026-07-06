import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { createTable, updateTable, deleteTable } from './api'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import type { Table } from '../../types'

/** Редактируемый стол: существующий Table, либо { zone } для нового */
type Target = Table | { zone: string | null }

function isExisting(x: Target): x is Table {
  return 'id' in x
}

interface Props {
  target: Target
  /** Порядковый номер для нового стола (max sort_order + 1) */
  nextSortOrder: number
  onClose: () => void
}

/** Инлайн-редактор стола на экране зала: создать / переименовать / удалить */
export default function TableEditSheet({ target, nextSortOrder, onClose }: Props) {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const qc = useQueryClient()
  const existing = isExisting(target)

  const [label, setLabel] = useState(existing ? target.label : '')
  const [zone, setZone] = useState(existing ? (target.zone ?? '') : (target.zone ?? ''))

  const refresh = () => { qc.invalidateQueries({ queryKey: ['tables'] }); onClose() }

  const save = useMutation({
    mutationFn: () =>
      existing
        ? updateTable(target.id, label.trim(), zone.trim() || null)
        : createTable(label.trim(), zone.trim() || null, nextSortOrder),
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  })

  const remove = useMutation({
    mutationFn: () => deleteTable((target as Table).id),
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  })

  const busy = save.isPending || remove.isPending

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="card w-full max-w-xs p-6 animate-[rise-in_0.2s_ease-out]" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-black text-gray-900 mb-4">
          {existing ? `${t(lang, 'tableLabel')} ${target.label}` : t(lang, 'newTable')}
        </h2>

        <label className="block text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">
          {t(lang, 'tableLabelField')}
        </label>
        <input
          className="input mb-3"
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="5"
        />

        <label className="block text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">
          {t(lang, 'tableZoneField')}
        </label>
        <input
          className="input mb-4"
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          placeholder={t(lang, 'tableZonePlaceholder')}
        />

        <button
          onClick={() => save.mutate()}
          disabled={busy || !label.trim()}
          className="btn-primary w-full !py-3.5 !rounded-2xl"
        >
          {t(lang, 'save')}
        </button>

        {existing && (
          <button
            onClick={() => { if (confirm(t(lang, 'confirmDeleteTable'))) remove.mutate() }}
            disabled={busy}
            className="btn-danger w-full mt-2 !py-3.5 !rounded-2xl"
          >
            {t(lang, 'delete')}
          </button>
        )}

        <button onClick={onClose} className="btn-ghost w-full mt-1">
          {t(lang, 'cancel')}
        </button>
      </div>
    </div>
  )
}
