import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { updateServiceMode } from '../../auth/api'
import { fetchTables } from '../../tables/api'
import { useLangStore } from '../../../store/langStore'
import { t, type TranslationKey } from '../../../lib/i18n'
import { Group, NavRow } from '../ui'
import type { DetailId } from '../registry'
import type { Location, ServiceMode } from '../../../types'

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

/** Деталь «Режим обслуживания»: режим точки + столы (в режиме столов) */
export default function ServiceModeDetail({
  location, openDetail,
}: { location: Location | undefined; openDetail: (id: DetailId) => void }) {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()

  const current = location?.service_mode
  const { data: tables = [] } = useQuery({ queryKey: ['tables'], queryFn: fetchTables })

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

  return (
    <div className="space-y-6">
      <section>
        <p className="text-sm text-gray-500 mb-3 px-1">{t(lang, 'serviceModeHint')}</p>
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

      {current === 'tables' && (
        <Group>
          <NavRow
            label={t(lang, 'tablesManage')}
            value={String(tables.length)}
            onClick={() => openDetail('tables')}
          />
        </Group>
      )}
    </div>
  )
}
