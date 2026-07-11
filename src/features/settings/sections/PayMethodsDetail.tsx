import {
  DndContext, closestCenter, PointerSensor, TouchSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, verticalListSortingStrategy, arrayMove, useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useLangStore } from '../../../store/langStore'
import { useDeviceStore, type PayMethod } from '../../../store/deviceStore'
import { t } from '../../../lib/i18n'
import { payMethodIcon, payMethodLabel, WALLET_METHODS } from '../../../lib/payMethods'
import Icon from '../../../components/Icon'
import { Group, ToggleRow } from '../ui'

/**
 * Деталь «Способы оплаты» (Square: Payment types) — настройка кассы:
 * перетаскиванием задаём порядок способов в окне оплаты; первый —
 * выбран по умолчанию. Кошельки (Cibus/Tenbis/Bit, 046) включаются
 * тумблером — включённый попадает в список и в окно оплаты.
 */
export default function PayMethodsDetail() {
  const lang = useLangStore((s) => s.lang)
  const order = useDeviceStore((s) => s.payMethodOrder)
  const setOrder = useDeviceStore((s) => s.setPayMethodOrder)

  function toggleWallet(m: PayMethod, on: boolean) {
    if (on) setOrder(order.includes(m) ? order : [...order, m])
    else setOrder(order.filter((x) => x !== m))
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 6 } })
  )

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = order.indexOf(active.id as PayMethod)
    const to = order.indexOf(over.id as PayMethod)
    if (from < 0 || to < 0) return
    setOrder(arrayMove(order, from, to))
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-500">{t(lang, 'payMethodsPageHint')}</p>
      <Group>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            {order.map((m, i) => (
              <Row key={m} method={m} isDefault={i === 0} />
            ))}
          </SortableContext>
        </DndContext>
      </Group>

      {/* Кошельки: включённый появляется в списке выше и в окне оплаты */}
      <Group title={t(lang, 'walletsGroup')}>
        {WALLET_METHODS.map((m) => (
          <ToggleRow
            key={m}
            label={payMethodLabel(lang, m)}
            checked={order.includes(m)}
            onChange={(v) => toggleWallet(m, v)}
          />
        ))}
      </Group>
      <p className="text-xs text-gray-500 px-1">{t(lang, 'walletsHint')}</p>
    </div>
  )
}

function Row({ method, isDefault }: { method: PayMethod; isDefault: boolean }) {
  const lang = useLangStore((s) => s.lang)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: method })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`min-h-[52px] px-4 py-3 flex items-center gap-3 bg-white ${isDragging ? 'shadow-lg rounded-xl' : ''}`}
    >
      {/* Ручка перетаскивания */}
      <button
        {...attributes}
        {...listeners}
        aria-label={t(lang, 'reorder')}
        className="shrink-0 w-8 h-11 -ms-2 flex items-center justify-center text-gray-300 hover:text-gray-500 cursor-grab active:cursor-grabbing touch-none"
      >
        <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <circle cx="5" cy="4" r="1.3" /><circle cx="11" cy="4" r="1.3" />
          <circle cx="5" cy="8" r="1.3" /><circle cx="11" cy="8" r="1.3" />
          <circle cx="5" cy="12" r="1.3" /><circle cx="11" cy="12" r="1.3" />
        </svg>
      </button>
      <Icon name={payMethodIcon(method)} size={18} />
      <span className="flex-1 text-sm font-semibold text-gray-900">
        {payMethodLabel(lang, method)}
      </span>
      {isDefault && (
        <span className="shrink-0 inline-flex items-center rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-semibold text-gray-500">
          {t(lang, 'payDefault')}
        </span>
      )}
    </div>
  )
}
