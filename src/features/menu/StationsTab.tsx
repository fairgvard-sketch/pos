import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import type { Station } from '../../types'
import { fetchStations, createStation, updateStation, deleteStation, reorderStations } from './api'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import InlineRename from '../../components/InlineRename'
import ConfirmDeleteButton from '../../components/ConfirmDeleteButton'

export default function StationsTab() {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()
  const { data: stations = [] } = useQuery({ queryKey: ['stations'], queryFn: fetchStations })
  const [newName, setNewName] = useState('')
  const invalidate = () => qc.invalidateQueries({ queryKey: ['stations'] })

  const add = useMutation({
    mutationFn: () => createStation(newName.trim()),
    onSuccess: () => { setNewName(''); invalidate() },
    onError: (e) => toast.error(e.message),
  })
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => updateStation(id, name),
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: deleteStation,
    onSuccess: () => { invalidate(); toast.success(t(lang, 'deleted')) },
    onError: (e) => toast.error(e.message),
  })
  // Порядок станций = очередность позиций для кухни (087):
  // оптимистично переставляем кэш, при ошибке перечитываем сервер
  const reorder = useMutation({
    mutationFn: (ids: string[]) => reorderStations(ids),
    onError: (e) => { toast.error((e as Error).message); invalidate() },
  })
  function move(idx: number, dir: -1 | 1) {
    const next = [...stations]
    const [s] = next.splice(idx, 1)
    next.splice(idx + dir, 0, s)
    qc.setQueryData<Station[]>(['stations'], next)
    reorder.mutate(next.map((st) => st.id))
  }

  return (
    <div className="max-w-md space-y-3">
      <form
        onSubmit={(e) => { e.preventDefault(); if (newName.trim()) add.mutate() }}
        className="flex gap-2"
      >
        <input
          className="input"
          placeholder={t(lang, 'stationName')}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="submit" disabled={!newName.trim() || add.isPending} className="btn-primary whitespace-nowrap">
          {t(lang, 'newStation')}
        </button>
      </form>

      {stations.map((s, idx) => (
        <div key={s.id} className="card px-4 py-3 flex items-center justify-between gap-3">
          <InlineRename
            value={s.name}
            placeholder={t(lang, 'stationName')}
            className="font-semibold text-gray-900"
            onSave={(name) => rename.mutate({ id: s.id, name })}
          />
          <div className="flex items-center gap-1">
            <button
              onClick={() => move(idx, -1)}
              disabled={idx === 0}
              title={t(lang, 'moveUp')}
              className="w-8 h-8 rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              ↑
            </button>
            <button
              onClick={() => move(idx, 1)}
              disabled={idx === stations.length - 1}
              title={t(lang, 'moveDown')}
              className="w-8 h-8 rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              ↓
            </button>
            <ConfirmDeleteButton onConfirm={() => remove.mutate(s.id)} />
          </div>
        </div>
      ))}

      {stations.length > 1 && (
        <p className="text-sm text-gray-500">{t(lang, 'stationsOrderHint')}</p>
      )}
    </div>
  )
}
