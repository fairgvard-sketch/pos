import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { updateServiceMode } from '../auth/api'
import { fetchTables, createTable, deleteTable } from '../tables/api'
import { useLangStore } from '../../store/langStore'
import { t, type TranslationKey } from '../../lib/i18n'
import type { Location, ServiceMode } from '../../types'

interface ModeOption {
  mode: ServiceMode
  title: TranslationKey
  hint: TranslationKey
}

const MODES: ModeOption[] = [
  { mode: 'counter', title: 'modeCounter', hint: 'modeCounterHint' },
  { mode: 'counter_tables', title: 'modeCounterTables', hint: 'modeCounterTablesHint' },
  { mode: 'tables', title: 'modeTables', hint: 'modeTablesHint' },
]

/** Таб «Обслуживание»: режим точки + управление столами */
export default function ServiceTab({ location }: { location: Location | undefined }) {
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

  const save = useMutation({
    mutationFn: (mode: ServiceMode) => updateServiceMode(mode),
    // Оптимистично: подменяем режим в кеше, экраны реагируют мгновенно
    onMutate: async (mode) => {
      await qc.cancelQueries({ queryKey: ['current_location'] })
      const prev = qc.getQueryData(['current_location'])
      qc.setQueryData(['current_location'], (old: typeof location) => (old ? { ...old, service_mode: mode } : old))
      return { prev }
    },
    onError: (e, _mode, ctx) => {
      qc.setQueryData(['current_location'], ctx?.prev)
      toast.error(e.message)
    },
    onSuccess: () => toast.success(t(lang, 'saved')),
  })

  const current = location?.service_mode

  return (
    <>
      <section className="max-w-2xl">
        <h2 className="text-base font-bold text-gray-900">{t(lang, 'serviceModeTitle')}</h2>
        <p className="text-sm text-gray-500 mt-1 mb-4">{t(lang, 'serviceModeHint')}</p>

        <div className="space-y-2">
          {MODES.map((m) => {
            const active = current === m.mode
            return (
              <button
                key={m.mode}
                onClick={() => !active && save.mutate(m.mode)}
                disabled={save.isPending}
                className={`w-full text-start rounded-2xl border p-4 transition-all ${
                  active
                    ? 'border-gray-900 bg-gray-900/[0.03]'
                    : 'border-gray-200 hover:border-gray-400 active:scale-[0.99]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-gray-900">{t(lang, m.title)}</span>
                  <span
                    className={`w-5 h-5 rounded-full border-2 shrink-0 flex items-center justify-center ${
                      active ? 'border-gray-900 bg-gray-900' : 'border-gray-300'
                    }`}
                  >
                    {active && <span className="w-2 h-2 rounded-full bg-white" />}
                  </span>
                </div>
                <p className="text-sm text-gray-500 mt-1">{t(lang, m.hint)}</p>
              </button>
            )
          })}
        </div>
      </section>

      {/* Управление столами — только в режиме столов */}
      {current === 'tables' && (
        <section className="max-w-2xl mt-10">
          <h2 className="text-base font-bold text-gray-900 mb-4">{t(lang, 'tablesManage')}</h2>

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
        </section>
      )}
    </>
  )
}
