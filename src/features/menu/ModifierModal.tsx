import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchModifierGroupsForItem } from './modifiers'
import { useLangStore } from '../../store/langStore'
import type { MenuItem } from '../../types'

interface Props {
  item: MenuItem
  initialModifierIds?: string[]
  initialNote?: string
  confirmLabel?: string
  onConfirm: (selectedModifierIds: string[], extraPrice: number, note: string, modifierNames: string[]) => void
  onClose: () => void
}

export default function ModifierModal({ item, initialModifierIds = [], initialNote = '', confirmLabel, onConfirm, onClose }: Props) {
  const lang = useLangStore((s) => s.lang)
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [note, setNote] = useState(initialNote)

  const { data: groups = [], isLoading } = useQuery({
    queryKey: ['modifiers', item.id],
    queryFn: () => fetchModifierGroupsForItem(item.id),
  })

  useEffect(() => {
    if (groups.length === 0 || initialModifierIds.length === 0) return
    const init: Record<string, string[]> = {}
    groups.forEach((g) => {
      const ids = g.modifiers.map((m) => m.id).filter((id) => initialModifierIds.includes(id))
      if (ids.length > 0) init[g.id] = ids
    })
    setSelected(init)
  }, [groups])

  const toggle = (groupId: string, modId: string, multi: boolean) => {
    setSelected((prev) => {
      const current = prev[groupId] ?? []
      if (multi) {
        return {
          ...prev,
          [groupId]: current.includes(modId)
            ? current.filter((id) => id !== modId)
            : [...current, modId],
        }
      } else {
        return {
          ...prev,
          [groupId]: current.includes(modId) ? [] : [modId],
        }
      }
    })
  }

  const allSelected = Object.values(selected).flat()

  const extraPrice = groups.flatMap((g) => g.modifiers)
    .filter((m) => allSelected.includes(m.id))
    .reduce((sum, m) => sum + m.price_delta, 0)

  const missingRequired = groups.some(
    (g) => g.required && !(selected[g.id]?.length > 0)
  )

  const handleConfirm = () => {
    if (missingRequired) return
    const names = groups.flatMap((g) => g.modifiers)
      .filter((m) => allSelected.includes(m.id))
      .map((m) => m.name)
    onConfirm(allSelected, extraPrice, note, names)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl w-full max-w-md max-h-[85vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        dir={lang === 'he' ? 'rtl' : 'ltr'}
      >
        {/* Header */}
        <div className="p-5 border-b border-gray-100">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-bold text-gray-900 text-lg">{item.name}</h2>
              <p className="text-gray-900 font-bold mt-0.5">
                {(item.price + extraPrice).toFixed(0)} ₪
                {extraPrice > 0 && (
                  <span className="text-gray-400 font-normal text-sm ml-1">
                    (+{extraPrice} ₪)
                  </span>
                )}
              </p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl font-bold">
              ×
            </button>
          </div>
        </div>

        {/* Modifier groups */}
        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
          {isLoading ? (
            <div className="text-center text-gray-400 py-8">Загрузка...</div>
          ) : groups.length === 0 ? (
            <div className="text-center text-gray-400 py-4 text-sm">
              Нет доступных модификаторов
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.id}>
                <div className="flex items-center gap-2 mb-2">
                  <p className="font-semibold text-gray-800 text-sm">{group.name}</p>
                  {group.required && (
                    <span className="text-xs text-red-500 font-medium">• Обязательно</span>
                  )}
                  {!group.required && (
                    <span className="text-xs text-gray-400">
                      {group.multi ? '(несколько)' : '(одно)'}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {group.modifiers.map((mod) => {
                    const isSelected = (selected[group.id] ?? []).includes(mod.id)
                    return (
                      <button
                        key={mod.id}
                        onClick={() => toggle(group.id, mod.id, group.multi)}
                        className={`
                          px-3 py-2 rounded-xl text-sm font-medium transition-all border-2 active:scale-95
                          ${isSelected
                            ? 'bg-blue-600 text-white border-blue-600'
                            : 'bg-white text-gray-700 border-gray-200 hover:border-blue-300'
                          }
                        `}
                      >
                        {mod.name}
                        {mod.price_delta > 0 && (
                          <span className={`ml-1 text-xs ${isSelected ? 'text-blue-200' : 'text-gray-400'}`}>
                            +{mod.price_delta}₪
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))
          )}

          {/* Free-text note */}
          <div>
            <p className="font-semibold text-gray-800 text-sm mb-2">
              {lang === 'he' ? 'הערה חופשית' : 'Свободная заметка'}
            </p>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={lang === 'he' ? 'למשל: ללא עמילן...' : 'Например: без крахмала...'}
              className="input text-sm"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-gray-100">
          <button
            onClick={handleConfirm}
            disabled={missingRequired}
            className="btn-primary w-full"
          >
            {confirmLabel ?? (lang === 'he' ? 'הוסף להזמנה' : 'Добавить в заказ')}
          </button>
          {missingRequired && (
            <p className="text-center text-red-500 text-xs mt-2">
              {lang === 'he' ? 'יש לבחור אפשרות חובה' : 'Выберите обязательный модификатор'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
