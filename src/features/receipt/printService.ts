import { fetchReceipt, fetchRefundReceipt, type Receipt } from './api'
import { renderReceiptCanvas, renderRefundReceiptCanvas, renderKitchenTicketCanvas, type KitchenTicketData } from './printCanvas'
import { printCanvasSilently, printCanvasWithResult } from '../../lib/escpos'
import { notifyPrintFailure } from './printFailure'
import type { Location } from '../../types'

/**
 * Автопечать чека после оплаты (fire-and-forget из finishPaid).
 * Только тихие пути (мост APK / RawBT) — браузерный диалог из
 * автопечати не открываем, чтобы не мешать потоку продажи.
 *
 * Ждём результат моста (P6): при ошибке печати — ненавязчивый тост с кнопкой
 * «повторить», а не тихая потеря. Второй экземпляр (*העתק*) печатаем ТОЛЬКО
 * если первый напечатался (иначе гость получил бы копию без оригинала).
 */
export async function autoPrintReceipt(
  orderId: string,
  location: Location | undefined,
  allowRawbt: boolean,
): Promise<boolean> {
  try {
    // Номер чека присвоен внутри pay_order — можно читать сразу
    const receipt = await fetchReceipt(orderId)
    const first = await printCanvasWithResult(renderReceiptCanvas(receipt, location), allowRawbt)
    if (!first.ok) {
      notifyPrintFailure(first.status, () =>
        void printCanvasWithResult(renderReceiptCanvas(receipt, location), allowRawbt)
      )
      return false
    }
    // Второй экземпляр (настройка точки) — как *העתק*; RawBT принимает
    // по одной ссылке за раз, поэтому с паузой. Только после успеха первого.
    if ((location?.settings?.receipt?.copies ?? 1) === 2) {
      setTimeout(() => {
        void printCanvasWithResult(renderReceiptCanvas(receipt, location, { copy: true }), allowRawbt)
      }, 3000)
    }
    return true
  } catch {
    return false
  }
}

/**
 * Автопечать ВРЕМЕННОГО чека офлайн-продажи (фаза 7): чек уже собран
 * на кассе (buildLocalReceipt), сети нет — печатаем без fetchReceipt.
 */
export function autoPrintLocalReceipt(
  receipt: Receipt,
  location: Location | undefined,
  allowRawbt: boolean,
): boolean {
  try {
    // Результат-aware путь: офлайн-чек тоже уведомляет об ошибке печати (P6)
    void printCanvasWithResult(renderReceiptCanvas(receipt, location), allowRawbt).then((r) => {
      if (!r.ok) {
        notifyPrintFailure(r.status, () =>
          void printCanvasWithResult(renderReceiptCanvas(receipt, location), allowRawbt)
        )
      }
    })
    return true
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
