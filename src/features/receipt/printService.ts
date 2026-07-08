import { fetchReceipt } from './api'
import { renderReceiptCanvas, renderKitchenTicketCanvas, type KitchenTicketData } from './printCanvas'
import { printCanvasSilently } from '../../lib/escpos'
import type { Location } from '../../types'

/**
 * Автопечать чека после оплаты (fire-and-forget из finishPaid).
 * Только тихие пути (мост APK / RawBT) — браузерный диалог из
 * автопечати не открываем, чтобы не мешать потоку продажи.
 */
export async function autoPrintReceipt(
  orderId: string,
  location: Location | undefined,
  allowRawbt: boolean,
): Promise<boolean> {
  try {
    // Номер чека присвоен внутри pay_order — можно читать сразу
    const receipt = await fetchReceipt(orderId)
    const canvas = renderReceiptCanvas(receipt, location)
    return printCanvasSilently(canvas, allowRawbt)
  } catch {
    return false
  }
}

/** Печать тикета на кухню/бар (данные из корзины — с заметками) */
export function printKitchenTicket(data: KitchenTicketData, allowRawbt: boolean): boolean {
  try {
    return printCanvasSilently(renderKitchenTicketCanvas(data), allowRawbt)
  } catch {
    return false
  }
}
