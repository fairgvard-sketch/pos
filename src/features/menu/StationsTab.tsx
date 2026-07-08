import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchStations, createStation, updateStation, deleteStation } from './api'
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

      {stations.map((s) => (
        <div key={s.id} className="card px-4 py-3 flex items-center justify-between gap-3">
          <InlineRename
            value={s.name}
            placeholder={t(lang, 'stationName')}
            className="font-semibold text-gray-900"
            onSave={(name) => rename.mutate({ id: s.id, name })}
          />
          <ConfirmDeleteButton onConfirm={() => remove.mutate(s.id)} />
        </div>
      ))}
    </div>
  )
}
