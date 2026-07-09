import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { updateLocationSettings } from '../auth/api'
import type { Location, LocationSettings } from '../../types'

/**
 * Мутация мелких настроек точки (locations.settings, 036) с optimistic-
 * обновлением кеша current_location — тумблеры реагируют мгновенно.
 * patch — раздел целиком (perms/receipt/shift мержатся по верхнему уровню).
 */
export function useLocationSettings(location: Location | undefined) {
  const qc = useQueryClient()
  const settings = location?.settings ?? {}

  const mutation = useMutation({
    mutationFn: (next: LocationSettings) => updateLocationSettings(next),
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: ['current_location'] })
      const prev = qc.getQueryData(['current_location'])
      qc.setQueryData(['current_location'], (old: Location | undefined) =>
        old ? { ...old, settings: next } : old
      )
      return { prev }
    },
    onError: (e, _next, ctx) => {
      qc.setQueryData(['current_location'], ctx?.prev)
      toast.error(e.message)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['current_location'] }),
  })

  /** Наложить частичный патч на текущие настройки и сохранить */
  function update(patch: LocationSettings) {
    mutation.mutate({
      ...settings,
      ...patch,
      perms: patch.perms ? { ...settings.perms, ...patch.perms } : settings.perms,
      receipt: patch.receipt ? { ...settings.receipt, ...patch.receipt } : settings.receipt,
      shift: patch.shift ? { ...settings.shift, ...patch.shift } : settings.shift,
    })
  }

  return { settings, update, isPending: mutation.isPending }
}
