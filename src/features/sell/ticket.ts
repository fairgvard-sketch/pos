import type { CartLine } from '../../store/cartStore'
import type { KitchenTicketLine } from '../receipt/printCanvas'

/** Строка корзины → строка кухонного тикета (с заметками) */
export function toTicketLine(l: CartLine): KitchenTicketLine {
  return {
    qty: l.qty,
    name: l.name,
    variantName: l.variantName,
    modifiers: l.mods.map((m) => m.name),
    notes: l.notes,
  }
}
