import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchTables, createTable, deleteTable } from '../../tables/api'
import { useLangStore } from '../../../store/langStore'
import { t } from '../../../lib/i18n'

/** Деталь «Столы»: добавление/удаление (перенос из ServiceTab) */
export default function TablesDetail() {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()

  const { data: tables = [] } = useQuery({ queryKey: ['tables'], queryFn: fetchTables })
  const [newLabel, setNewLabel] = useState('')
  const [newZone, setNewZone] = useState('')

  const addTable = useMutation({
    mutationFn: () => createTable(newLabel.trim(), newZone.trim() || null, tables.length),
    onSuccess: () => {
      setNewLabel(''); setNewZone('')
      qc.invalidateQueries({ queryKey: ['tables'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const removeTable = useMutation({
    mutationFn: (id: string) => deleteTable(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tables'] }),
    onError: (e) => toast.error(e.message),
  })

  return (
    <div>
      {tables.length === 0 ? (
        <p className="text-sm text-gray-500 mb-4">{t(lang, 'noTablesYet')}</p>
      ) : (
        <div className="flex flex-wrap gap-2 mb-4">
          {tables.map((tb) => (
            <div key={tb.id} className="flex items-center gap-2 rounded-xl border border-gray-200 ps-3 pe-1.5 h-11">
              <span className="font-bold text-gray-900 tabular-nums">{tb.label}</span>
              {tb.zone && <span className="text-xs text-gray-500">{tb.zone}</span>}
              <button
                onClick={() => removeTable.mutate(tb.id)}
                className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-red-500"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          className="input !py-2 max-w-[160px]"
          placeholder={t(lang, 'tableLabelField')}
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && newLabel.trim() && addTable.mutate()}
        />
        <input
          className="input !py-2 max-w-[160px]"
          placeholder={t(lang, 'tableZoneField')}
          value={newZone}
          onChange={(e) => setNewZone(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && newLabel.trim() && addTable.mutate()}
        />
        <button
          onClick={() => addTable.mutate()}
          disabled={!newLabel.trim() || addTable.isPending}
          className="btn-secondary !py-2 whitespace-nowrap"
        >
          {t(lang, 'addTable')}
        </button>
      </div>
    </div>
  )
}
