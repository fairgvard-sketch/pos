import { useState } from 'react'
// import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchAllGuests, fetchGuestVisits, createGuest } from './api'
import { useLangStore } from '../../store/langStore'
import { formatDate } from '../../lib/i18n'
import HubButton from '../../components/ui/HubButton'
import LangToggle from '../../components/ui/LangToggle'
import type { Guest, GuestVisit } from './api'

export default function LoyaltyPage() {
  
  const qc = useQueryClient()
  const lang = useLangStore((s) => s.lang)
  const isRu = lang === 'ru'

  const [selected, setSelected] = useState<Guest | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [search, setSearch] = useState('')

  const { data: guests = [] } = useQuery<Guest[]>({
    queryKey: ['all-guests'],
    queryFn: fetchAllGuests,
  })

  const { data: visits = [] } = useQuery<GuestVisit[]>({
    queryKey: ['guest-visits', selected?.id],
    queryFn: () => fetchGuestVisits(selected!.id),
    enabled: !!selected,
  })

  const createMutation = useMutation({
    mutationFn: () => createGuest(newName.trim(), newPhone.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['all-guests'] })
      setShowCreate(false)
      setNewName('')
      setNewPhone('')
      toast.success(isRu ? 'Гость добавлен' : 'האורח נוסף')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const filtered = guests.filter(
    (g) => !search || g.name.toLowerCase().includes(search.toLowerCase()) || g.phone.includes(search)
  )

  return (
    <div className="min-h-screen bg-[#f8f9fb] flex flex-col">
      <header className="bg-white border-b border-gray-100 h-14 px-6 flex items-center gap-3 sticky top-0 z-10">
        <HubButton />
        <span className="font-bold text-gray-900 flex-1">
          {isRu ? 'Программа лояльности' : 'מועדון לקוחות'}
        </span>
        <LangToggle />
      </header>

      <div className="flex flex-1 gap-6 p-6 overflow-hidden">
        {/* Guest list */}
        <div className="flex-1 max-w-sm flex flex-col gap-3">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder={isRu ? 'Поиск по имени / телефону...' : 'חיפוש לפי שם / טלפון...'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input flex-1 text-sm"
            />
            <button onClick={() => setShowCreate(true)} className="btn-primary text-sm px-3">
              +
            </button>
          </div>

          {showCreate && (
            <div className="card p-4 flex flex-col gap-2">
              <p className="font-bold text-sm">{isRu ? 'Новый гость' : 'אורח חדש'}</p>
              <input
                type="text"
                placeholder={isRu ? 'Имя' : 'שם'}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="input text-sm"
              />
              <input
                type="tel"
                placeholder={isRu ? 'Телефон' : 'טלפון'}
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                className="input text-sm"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => createMutation.mutate()}
                  disabled={!newName || !newPhone || createMutation.isPending}
                  className="btn-success flex-1 text-sm"
                >
                  {isRu ? 'Сохранить' : 'שמור'}
                </button>
                <button onClick={() => setShowCreate(false)} className="btn-secondary flex-1 text-sm">
                  {isRu ? 'Отмена' : 'ביטול'}
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2 overflow-y-auto">
            {filtered.map((g) => (
              <button
                key={g.id}
                onClick={() => setSelected(g)}
                className={`card p-3 text-left transition-all ${
                  selected?.id === g.id ? 'ring-2 ring-gray-900' : 'hover:shadow-md'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-sm text-gray-900">{g.name}</p>
                    <p className="text-xs text-gray-500">{g.phone}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-purple-700">{g.points} {isRu ? 'б.' : 'נק׳'}</p>
                    <p className="text-xs text-gray-400">{g.visits} {isRu ? 'визитов' : 'ביקורים'}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Guest detail */}
        {selected && (
          <div className="flex-1 card p-5 self-start">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-gray-900">{selected.name}</h3>
                <p className="text-gray-500">{selected.phone}</p>
              </div>
              <div className="text-right">
                <p className="text-3xl font-black text-purple-700">{selected.points}</p>
                <p className="text-xs text-gray-500">{isRu ? 'баллов' : 'נקודות'}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-5">
              <div className="bg-gray-50 rounded-xl p-3 text-center">
                <p className="text-2xl font-black text-gray-900">{selected.visits}</p>
                <p className="text-xs text-gray-500">{isRu ? 'визитов' : 'ביקורים'}</p>
              </div>
              <div className="bg-gray-50 rounded-xl p-3 text-center">
                <p className="text-2xl font-black text-gray-900">
                  {visits.reduce((s, v) => s + v.total_paid, 0).toFixed(0)} ₪
                </p>
                <p className="text-xs text-gray-500">{isRu ? 'потрачено всего' : 'סה"כ הוצאות'}</p>
              </div>
            </div>

            <h4 className="font-bold text-gray-800 mb-3">{isRu ? 'История визитов' : 'היסטוריית ביקורים'}</h4>
            <div className="flex flex-col gap-2 max-h-96 overflow-y-auto">
              {visits.length === 0 && (
                <p className="text-gray-400 text-sm">{isRu ? 'Нет данных' : 'אין נתונים'}</p>
              )}
              {visits.map((v) => (
                <div key={v.id} className="flex items-center justify-between py-2 border-b border-gray-100">
                  <div>
                    <p className="text-sm text-gray-700">{formatDate(v.created_at, lang)}</p>
                    <p className="text-xs text-gray-400">#{v.order_id.slice(0, 8).toUpperCase()}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold">{v.total_paid.toFixed(2)} ₪</p>
                    <p className="text-xs text-green-600">+{v.earned} {isRu ? 'б.' : 'נק׳'}</p>
                    {v.spent > 0 && <p className="text-xs text-red-500">−{v.spent} {isRu ? 'б.' : 'נק׳'}</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
