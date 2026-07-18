import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { patchLocationSettings } from '../auth/api'
import type { Location, LocationSettings } from '../../types'

/**
 * Мутация мелких настроек точки (locations.settings, 036) с optimistic-
 * обновлением кеша current_location — тумблеры реагируют мгновенно.
 *
 * P8: на сервер шлём ТОЛЬКО патч (patch_location_settings, 064) — deep-merge
 * происходит в БД под блокировкой строки, поэтому параллельная правка соседних
 * ключей (два таба/устройства) их не затирает. Клиентский merge остаётся лишь
 * для оптимистичного отображения.
 */
export function useLocationSettings(location: Location | undefined) {
  const qc = useQueryClient()
  const settings = location?.settings ?? {}

  /** Локальный deep-merge (1 уровень) для оптимистичного кеша */
  function mergeLocal(base: LocationSettings, patch: LocationSettings): LocationSettings {
    const out: LocationSettings = { ...base, ...patch }
    for (const key of ['perms', 'receipt', 'shift', 'online_orders', 'reservations', 'tips', 'pay_methods', 'quick_amounts', 'interface', 'go_live'] as const) {
      const p = (patch as Record<string, unknown>)[key]
      const b = (base as Record<string, unknown>)[key]
      if (p && typeof p === 'object' && b && typeof b === 'object') {
        ;(out as Record<string, unknown>)[key] = { ...b, ...p }
      }
    }
    return out
  }

  const mutation = useMutation({
    mutationFn: (patch: LocationSettings) => patchLocationSettings(patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: ['current_location'] })
      const prev = qc.getQueryData(['current_location'])
      qc.setQueryData(['current_location'], (old: Location | undefined) =>
        old ? { ...old, settings: mergeLocal(old.settings ?? {}, patch) } : old
      )
      return { prev }
    },
    onSuccess: (merged) => {
      // Сервер вернул авторитетный merge — синхронизируем кеш точно
      qc.setQueryData(['current_location'], (old: Location | undefined) =>
        old ? { ...old, settings: merged } : old
      )
    },
    onError: (e, _patch, ctx) => {
      qc.setQueryData(['current_location'], ctx?.prev)
      toast.error(e.message)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['current_location'] }),
  })

  /** Наложить частичный патч на текущие настройки и сохранить (server-side merge) */
  function update(patch: LocationSettings) {
    mutation.mutate(patch)
  }

  return { settings, update, isPending: mutation.isPending }
}
