import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { moveTableOrder, mergeTableOrders, voidTableOrder, fetchOrderLines, type TableOccupancy } from './api'
import { fetchCurrentLocation } from '../auth/api'
import { printKitchenTicket } from '../receipt/printService'
import { billToKitchenTicket } from '../receipt/kitchenTicket'
import { hasSilentPrintPath } from '../../lib/escpos'
import { useDeviceStore } from '../../store/deviceStore'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t, formatTime, formatElapsed } from '../../lib/i18n'
import { can } from '../../lib/perms'
import { formatMoney } from '../../lib/money'
import type { Table } from '../../types'
import Icon, { type IconName } from '../../components/Icon'

interface Props {
  /** Занятый стол, по которому открыли действия */
  table: Table
  /** Открытый счёт этого стола */
  occ: TableOccupancy
  /** Все активные столы точки */
  tables: Table[]
  /** Занятость по столам (table_id → счёт) */
  occupancy: Map<string, TableOccupancy>
  /** Обычный переход в счёт (продажа) */
  onOpenBill: () => void
  onClose: () => void
}

type Screen = 'menu' | 'view' | 'move' | 'merge'

/** Меню действий по занятому столу (открывается долгим тапом в зале) */
export default function TableActionSheet({ table, occ, tables, occupancy, onOpenBill, onClose }: Props) {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const qc = useQueryClient()
  const [screen, setScreen] = useState<Screen>('menu')

  // Освобождение стола аннулирует счёт → право void_order (настройки точки)
  const staff = useAuthStore((s) => s.staff)
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const canVoidOrder = can(staff?.role, 'void_order', location?.settings, staff?.role_perms)

  const refresh = () => qc.invalidateQueries({ queryKey: ['open_table_orders'] })

  const move = useMutation({
    mutationFn: (toTableId: string) => moveTableOrder(occ.order_id, toTableId),
    onSuccess: () => { toast.success(t(lang, 'tableMoved')); refresh(); onClose() },
    onError: (e) => toast.error(e.message),
  })

  const merge = useMutation({
    mutationFn: (targetOrderId: string) => mergeTableOrders(occ.order_id, targetOrderId),
    onSuccess: () => { toast.success(t(lang, 'tablesMerged')); refresh(); onClose() },
    onError: (e) => toast.error(e.message),
  })

  const free = useMutation({
    mutationFn: () => voidTableOrder(occ.order_id),
    onSuccess: () => { refresh(); onClose() },
    onError: (e) => toast.error(e.message),
  })

  // Перепечатка кухонного тикета по открытому счёту (потеряли бумажку):
  // весь текущий счёт одним тикетом, без пометки «повтор». Чисто локальная
  // печать — заказ не мутирует, на экране бариста ничего не появляется.
  const kitchenTicketOn = useDeviceStore((s) => s.printKitchenTicket)
  const deviceName = useDeviceStore((s) => s.deviceName)
  const printMode = useDeviceStore((s) => s.printMode)
  const [printingTicket, setPrintingTicket] = useState(false)

  async function reprintTicket() {
    const allowRawbt = printMode === 'rawbt'
    if (!hasSilentPrintPath(allowRawbt)) {
      toast.error(t(lang, 'testPrintNoSilent'))
      return
    }
    setPrintingTicket(true)
    try {
      const lines = await qc.fetchQuery({
        queryKey: ['order_lines', occ.order_id],
        queryFn: () => fetchOrderLines(occ.order_id),
      })
      void printKitchenTicket(
        billToKitchenTicket({
          dailyNumber: occ.daily_number,
          tableLabel: table.label,
          staffName: occ.staff_name ?? '',
          deviceName,
          lines,
        }),
        allowRawbt
      )
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setPrintingTicket(false)
    }
  }

  // Свободные столы (для переноса) и другие занятые (для объединения)
  const freeTables = tables.filter((tb) => tb.id !== table.id && !occupancy.has(tb.id))
  const busyTables = tables.filter((tb) => tb.id !== table.id && occupancy.has(tb.id))
  const busy = move.isPending || merge.isPending || free.isPending

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-sm p-6 animate-[rise-in_0.2s_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Заголовок */}
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-lg font-black text-gray-900">
            {t(lang, 'tableLabel')} {table.label}
          </h2>
          <span className="text-sm font-bold text-red-500 tabular-nums">{formatMoney(occ.total, lang)}</span>
        </div>

        {screen === 'menu' && (
          <div className="space-y-2">
            <ActionRow icon="orders" label={t(lang, 'openTableBill')} onClick={onOpenBill} />
            <ActionRow icon="note" label={t(lang, 'tableInfo')} onClick={() => setScreen('view')} />
            {kitchenTicketOn && (
              <ActionRow
                icon="queue"
                label={t(lang, 'kitchenTicketTitle')}
                disabled={printingTicket}
                onClick={() => void reprintTicket()}
              />
            )}
            <ActionRow
              icon="customers"
              label={t(lang, 'moveTable')}
              disabled={freeTables.length === 0}
              onClick={() => setScreen('move')}
            />
            <ActionRow
              icon="customers"
              label={t(lang, 'mergeTable')}
              disabled={busyTables.length === 0}
              onClick={() => setScreen('merge')}
            />
            <ActionRow icon="refund" label={t(lang, 'freeTable')} danger onClick={() => {
              if (!canVoidOrder) { toast.error(t(lang, 'permManagerToast')); return }
              if (confirm(t(lang, 'confirmFreeTable'))) free.mutate()
            }} />
          </div>
        )}

        {screen === 'view' && <TableInfo occ={occ} onBack={() => setScreen('menu')} />}

        {screen === 'move' && (
          <TablePicker
            title={t(lang, 'moveTableTo')}
            tables={freeTables}
            occupancy={occupancy}
            emptyLabel={t(lang, 'noFreeTables')}
            busy={busy}
            onPick={(tb) => move.mutate(tb.id)}
            onBack={() => setScreen('menu')}
          />
        )}

        {screen === 'merge' && (
          <TablePicker
            title={t(lang, 'mergeTableWith')}
            tables={busyTables}
            occupancy={occupancy}
            emptyLabel={t(lang, 'noBusyTables')}
            hint={t(lang, 'mergeDiscountWarning')}
            busy={busy}
            onPick={(tb) => merge.mutate(occupancy.get(tb.id)!.order_id)}
            onBack={() => setScreen('menu')}
          />
        )}

        <button onClick={onClose} className="btn-ghost w-full mt-3">
          {t(lang, 'cancel')}
        </button>
      </div>
    </div>
  )
}

function ActionRow({
  icon,
  label,
  onClick,
  disabled = false,
  danger = false,
}: {
  icon: IconName
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl border text-start text-sm font-semibold
                 transition-all active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none ${
                   danger
                     ? 'border-red-200 text-red-600 hover:border-red-400 hover:bg-red-50'
                     : 'border-gray-200 text-gray-900 hover:border-gray-400'
                 }`}
    >
      <Icon name={icon} size={20} />
      {label}
    </button>
  )
}

function TablePicker({
  title,
  tables,
  occupancy,
  emptyLabel,
  hint,
  busy,
  onPick,
  onBack,
}: {
  title: string
  tables: Table[]
  occupancy: Map<string, TableOccupancy>
  emptyLabel: string
  hint?: string
  busy: boolean
  onPick: (tb: Table) => void
  onBack: () => void
}) {
  const lang = useLangStore((s) => s.lang)
  return (
    <div>
      <button onClick={onBack} className="text-sm text-gray-400 hover:text-gray-600 mb-3">← {t(lang, 'back')}</button>
      <h3 className="text-sm font-bold text-gray-500 mb-3">{title}</h3>
      {hint && <p className="text-xs text-amber-600 mb-3">{hint}</p>}
      {tables.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">{emptyLabel}</p>
      ) : (
        <div className="grid grid-cols-4 gap-2 max-h-64 overflow-y-auto">
          {tables.map((tb) => {
            const occ = occupancy.get(tb.id)
            return (
              <button
                key={tb.id}
                onClick={() => onPick(tb)}
                disabled={busy}
                className={`aspect-square rounded-xl border-2 bg-white flex flex-col items-center justify-center gap-0.5
                           transition-all active:scale-[0.95] disabled:opacity-50 ${
                             occ ? 'border-red-500' : 'border-gray-200 hover:border-gray-400'
                           }`}
              >
                <span className="text-lg font-black text-gray-900 tabular-nums leading-none">{tb.label}</span>
                {occ && <span className="text-[10px] font-bold text-red-500 tabular-nums">{formatMoney(occ.total, lang)}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Вся информация по столу: заказ, время, кассир + сам счёт */
function TableInfo({ occ, onBack }: { occ: TableOccupancy; onBack: () => void }) {
  const lang = useLangStore((s) => s.lang)
  const { data: lines = [], isLoading } = useQuery({
    queryKey: ['order_lines', occ.order_id],
    queryFn: () => fetchOrderLines(occ.order_id),
  })

  // «Занято N мин» тикает раз в 30 с (Date.now() нельзя звать прямо в рендере —
  // нечистый вызов; держим момент в state)
  const [nowTs, setNowTs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const meta: { label: string; value: string }[] = [
    { label: t(lang, 'infoOrderNo'), value: `#${occ.daily_number}` },
    { label: t(lang, 'infoOpenedAt'), value: formatTime(occ.opened_at, lang) },
    { label: t(lang, 'infoOccupied'), value: formatElapsed(occ.opened_at, nowTs, lang) },
    ...(occ.staff_name ? [{ label: t(lang, 'infoStaff'), value: occ.staff_name }] : []),
    { label: t(lang, 'infoItems'), value: String(occ.item_count) },
  ]

  return (
    <div>
      <button onClick={onBack} className="text-sm text-gray-400 hover:text-gray-600 mb-3">← {t(lang, 'back')}</button>

      <div className="rounded-2xl bg-gray-50 border border-gray-100 p-4 mb-3 space-y-1.5">
        {meta.map((row) => (
          <div key={row.label} className="flex justify-between gap-3 text-sm">
            <span className="text-gray-500">{row.label}</span>
            <span className="font-semibold text-gray-900 tabular-nums text-end">{row.value}</span>
          </div>
        ))}
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-400 text-center py-8">…</p>
      ) : lines.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">{t(lang, 'billEmpty')}</p>
      ) : (
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {lines.map((l, i) => (
            <div key={i} className="flex items-start justify-between gap-2 text-sm">
              <div className="min-w-0">
                <span className="font-semibold text-gray-900">
                  {l.qty > 1 && <span className="text-gray-400">{l.qty}× </span>}
                  {l.name}
                  {l.variant_name && <span className="text-gray-500 font-medium"> · {l.variant_name}</span>}
                </span>
                {l.modifiers.length > 0 && (
                  <span className="block text-xs text-gray-500 truncate">{l.modifiers.join(' · ')}</span>
                )}
              </div>
              <span className="font-bold text-gray-900 tabular-nums shrink-0">{formatMoney(l.line_total, lang)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
