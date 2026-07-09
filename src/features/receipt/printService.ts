import { fetchReceipt, fetchRefundReceipt } from './api'
import { renderReceiptCanvas, renderRefundReceiptCanvas, renderKitchenTicketCanvas, type KitchenTicketData } from './printCanvas'
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
    const ok = printCanvasSilently(renderReceiptCanvas(receipt, location), allowRawbt)
    // Второй экземпляр (настройка точки) — как *העתק*; RawBT принимает
    // по одной ссылке за раз, поэтому с паузой
    if (ok && (location?.settings?.receipt?.copies ?? 1) === 2) {
      setTimeout(() => {
        printCanvasSilently(renderReceiptCanvas(receipt, location, { copy: true }), allowRawbt)
      }, 3000)
    }
    return ok
  } catch {
    return false
  }
}

/** Автопечать תעודת זיכוי после оформления возврата (тихие пути) */
export async function autoPrintRefundReceipt(
  refundId: string,
  location: Location | undefined,
  allowRawbt: boolean,
): Promise<boolean> {
  try {
    const receipt = await fetchRefundReceipt(refundId)
    return printCanvasSilently(renderRefundReceiptCanvas(receipt, location), allowRawbt)
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
