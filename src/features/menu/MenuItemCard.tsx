import { useState } from 'react'
import type { MenuItem } from '../../types'
import type { Lang } from '../../lib/i18n'
import { useOrderStore } from '../../store/orderStore'
import ModifierModal from './ModifierModal'

interface Props {
  item: MenuItem
  lang: Lang
  onAdd: (modifierIds: string[], extraPrice: number, note: string, modifierNames: string[]) => void
}

export default function MenuItemCard({ item, lang, onAdd }: Props) {
  const cart = useOrderStore((s) => s.cart)
  const inCart = cart.filter((c) => c.menu_item.id === item.id).reduce((s, c) => s + c.qty, 0)
  const [showModal, setShowModal] = useState(false)

  return (
    <>
      <div className="relative w-full pb-[100%]">
        <button
          onClick={() => item.ask_modifiers ? setShowModal(true) : onAdd([], 0, '', [])}
          disabled={!item.is_available}
          className={`
            absolute inset-0 rounded-2xl overflow-hidden
            transition-all duration-150 active:scale-[0.97] select-none
            shadow-[0_1px_4px_rgba(0,0,0,0.08)]
            ${inCart > 0
              ? 'ring-2 ring-gray-900 shadow-[0_4px_16px_rgba(0,0,0,0.14)]'
              : 'hover:shadow-[0_4px_16px_rgba(0,0,0,0.13)]'
            }
            ${!item.is_available ? 'opacity-40 cursor-not-allowed' : ''}
          `}
        >
          {/* Image / placeholder */}
          {item.image_url ? (
            <img
              src={item.image_url}
              alt={item.name}
              className="absolute inset-0 w-full h-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-gray-100 to-gray-50 flex items-center justify-center">
              <span className="text-4xl font-black text-gray-300 select-none leading-none">
                {item.name.trim().slice(0, 2).toUpperCase()}
              </span>
            </div>
          )}

          {/* Gradient overlay — stronger for readability */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />

          {/* Info */}
          <div className="absolute bottom-0 left-0 right-0 p-3">
            <p className="text-white text-xs font-semibold leading-tight line-clamp-2 drop-shadow-sm">
              {item.name}
            </p>
            <p className="text-white text-sm font-black mt-1 tabular-nums drop-shadow-sm">
              {item.price} ₪
            </p>
          </div>

          {/* Cart badge */}
          {inCart > 0 && (
            <div className="absolute top-2 right-2 min-w-[22px] h-[22px] px-1 bg-gray-900 rounded-full flex items-center justify-center shadow-md">
              <span className="text-white text-xs font-bold">{inCart}</span>
            </div>
          )}

          {/* Unavailable overlay */}
          {!item.is_available && (
            <div className="absolute inset-0 bg-white/60 flex items-center justify-center">
              <span className="text-xs font-semibold text-gray-400 bg-white/90 px-2 py-1 rounded-lg">
                {lang === 'he' ? 'לא זמין' : 'Недоступно'}
              </span>
            </div>
          )}
        </button>
      </div>

      {showModal && (
        <ModifierModal
          item={item}
          onConfirm={(modifierIds, extraPrice, note, modifierNames) => {
            onAdd(modifierIds, extraPrice, note, modifierNames)
            setShowModal(false)
          }}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  )
}
