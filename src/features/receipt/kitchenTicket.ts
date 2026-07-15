import type { Receipt } from './api'
import type { BillLine } from '../tables/api'
import type { KitchenTicketData } from './printCanvas'

/**
 * Перепечатка кухонного тикета из сохранённых данных заказа (снапшот в БД):
 * история операций и открытые счета столов. Печать чисто локальная — ничего
 * не пишет в БД и не появляется на экране бариста; пометки «повтор» нет,
 * тикет выглядит как оригинал.
 */

/** Тикет из полного чека заказа (история операций) */
export function receiptToKitchenTicket(r: Receipt, deviceName: string): KitchenTicketData {
  return {
    // Офлайн-заказ до синка живёт под локальным номером K-n
    dailyNumber: r.provisional ? (r.provisional_number ?? r.daily_number) : r.daily_number,
    orderType: r.order_type,
    customerName: r.customer_name ?? '',
    tableLabel: r.table_label ?? '',
    staffName: r.staff_name ?? '',
    deviceName,
    lines: r.lines.map((l) => ({
      qty: l.qty,
      name: l.name,
      variantName: l.variant_name,
      modifiers: l.modifiers.map((m) => m.name),
      notes: l.notes ?? '',
    })),
  }
}

/** Тикет по открытому счёту стола (зал): весь текущий счёт одним тикетом */
export function billToKitchenTicket(args: {
  dailyNumber: number
  tableLabel: string
  staffName: string
  deviceName: string
  lines: BillLine[]
}): KitchenTicketData {
  return {
    dailyNumber: args.dailyNumber,
    orderType: 'here',
    customerName: '',
    tableLabel: args.tableLabel,
    staffName: args.staffName,
    deviceName: args.deviceName,
    lines: args.lines.map((l) => ({
      qty: l.qty,
      name: l.name,
      variantName: l.variant_name,
      modifiers: l.modifiers,
      notes: l.notes ?? '',
    })),
  }
}
