import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchReceipt, setOrderBuyer, type Receipt } from './api'
import { renderReceiptCanvas } from './printCanvas'
import { fetchCurrentLocation } from '../auth/api'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
import { canvasToRawbtUrl, canvasToEscposBase64 } from '../../lib/escpos'
import { receiptMethodLabel } from '../../lib/payMethods'
import { t } from '../../lib/i18n'
import type { Location } from '../../types'

interface Props {
  /** id серверного заказа — чек тянется fetchReceipt */
  orderId?: string
  /** Готовый чек (офлайн: временный документ, собранный на кассе) — без запроса */
  receipt?: Receipt
  onClose: () => void
}

/**
 * Просмотр и печать чека (браузерная печать → системный/термопринтер).
 * Сам чек — ВСЕГДА на иврите и RTL (фискальный документ Израиля),
 * независимо от языка интерфейса. Кнопки модалки — на языке UI.
 */
export default function ReceiptSheet({ orderId, receipt: localReceipt, onClose }: Props) {
  const lang = useLangStore((s) => s.lang)
  const printMode = useDeviceStore((s) => s.printMode)
  const qc = useQueryClient()
  const { data: fetched, isLoading } = useQuery({
    queryKey: ['receipt', orderId],
    queryFn: () => fetchReceipt(orderId!),
    enabled: !localReceipt && !!orderId,
  })
  const receipt = localReceipt ?? fetched
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })

  // Чек на компанию (048): реквизиты покупателя добавляются один раз,
  // после — печать уже с блоком «לכבוד». Только для серверных чеков.
  const [buyerOpen, setBuyerOpen] = useState(false)
  const [bizName, setBizName] = useState('')
  const [bizTaxId, setBizTaxId] = useState('')
  const taxIdValid = bizTaxId === '' || /^\d{9}$/.test(bizTaxId)
  const saveBuyer = useMutation({
    mutationFn: () => setOrderBuyer(orderId!, bizName.trim(), bizTaxId || null),
    onSuccess: () => {
      setBuyerOpen(false)
      qc.invalidateQueries({ queryKey: ['receipt', orderId] })
      toast.success(t(lang, 'bizInvoiceSaved'))
    },
    onError: (e) => toast.error(e.message),
  })
  const canAddBuyer = !!orderId && !!receipt && !receipt.provisional && !receipt.buyer_name

  /**
   * Печать чека, по приоритету:
   *  1. APK-обёртка (window.KassaAndroid): тихая печать на встроенный
   *     принтер Sunmi через мост — как у нативных POS. Перекрывает настройку.
   *  2. rawbt: картинка → ESC/POS растр → приложение RawBT (Sunmi без APK).
   *  3. browser: системный диалог печати (обычный принтер / PDF).
   */
  function handlePrint() {
    if (!receipt) return
    // Второй экземпляр (настройка точки) печатается как *העתק*
    const copies = location?.settings?.receipt?.copies ?? 1
    const bridge = window.KassaAndroid
    if (bridge?.isAvailable()) {
      bridge.printBase64(canvasToEscposBase64(renderReceiptCanvas(receipt, location)))
      if (copies === 2) {
        bridge.printBase64(canvasToEscposBase64(renderReceiptCanvas(receipt, location, { copy: true })))
      }
      return
    }
    if (printMode === 'rawbt') {
      window.location.href = canvasToRawbtUrl(renderReceiptCanvas(receipt, location))
      if (copies === 2) {
        // RawBT принимает по одной ссылке за раз — копию отправляем с паузой
        setTimeout(() => {
          window.location.href = canvasToRawbtUrl(renderReceiptCanvas(receipt, location, { copy: true }))
        }, 3000)
      }
      return
    }
    // Браузерный диалог: количество копий выбирается в самом диалоге
    window.print()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-3xl w-full max-w-sm max-h-[90vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 overflow-y-auto">
          {isLoading || !receipt ? (
            <p className="text-center text-gray-400 py-12">…</p>
          ) : (
            <ReceiptBody receipt={receipt} location={location} />
          )}
        </div>

        <div className="p-4 pt-3 border-t border-gray-100 shrink-0 space-y-2">
          {/* Чек на компанию: свёрнутая кнопка → мини-форма (название + ח.פ.) */}
          {canAddBuyer && !buyerOpen && (
            <button
              onClick={() => setBuyerOpen(true)}
              className="btn-secondary w-full !py-2.5 !rounded-2xl !text-sm"
            >
              {t(lang, 'bizInvoiceBtn')}
            </button>
          )}
          {canAddBuyer && buyerOpen && (
            <div className="space-y-2">
              <input
                className="input !py-2.5"
                autoFocus
                placeholder={t(lang, 'bizName')}
                value={bizName}
                onChange={(e) => setBizName(e.target.value)}
              />
              <input
                className="input !py-2.5"
                inputMode="numeric"
                placeholder={t(lang, 'bizTaxId')}
                value={bizTaxId}
                onChange={(e) => setBizTaxId(e.target.value.replace(/\D/g, '').slice(0, 9))}
              />
              <p className="text-xs text-gray-500">{t(lang, 'bizInvoiceHint')}</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => saveBuyer.mutate()}
                  disabled={saveBuyer.isPending || !bizName.trim() || !taxIdValid}
                  className="btn-primary !py-2.5 !rounded-2xl !text-sm disabled:opacity-40"
                >
                  {t(lang, 'save')}
                </button>
                <button onClick={() => setBuyerOpen(false)} className="btn-ghost !py-2.5 !rounded-2xl !text-sm">
                  {t(lang, 'cancel')}
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button onClick={handlePrint} disabled={!receipt} className="btn-primary !py-3.5 !rounded-2xl">
              {t(lang, 'printReceipt')}
            </button>
            <button onClick={onClose} className="btn-ghost !py-3.5 !rounded-2xl">
              {t(lang, 'close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Сумма на чеке — без символа валюты, как в израильских чеках: 83.00 */
function fmt(agorot: number): string {
  return (agorot / 100).toFixed(2)
}

/** Название типа документа на иврите (фиск. требование Израиля) */
function docTypeLabel(dt: Receipt['doc_type']): string {
  switch (dt) {
    case 'receipt': return 'קבלה'
    case 'tax_invoice': return 'חשבונית מס'
    case 'invoice_receipt': return 'חשבונית מס/קבלה'
  }
}

/** Тело чека — оно же печатается (класс receipt-print). Иврит, RTL. */
function ReceiptBody({ receipt: r, location }: { receipt: Receipt; location: Location | undefined }) {
  const businessName = location?.receipt_business_name || location?.name || ''
  const dt = new Date(r.paid_at ?? r.created_at)
  const dateStr = dt.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const timeStr = dt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
  const itemCount = r.lines.reduce((s, l) => s + l.qty, 0)
  const netAmount = r.total - r.vat_amount  // סה"כ חייב במע"מ

  return (
    <div dir="rtl" className="receipt-print font-mono text-[13px] text-gray-900 leading-snug">
      {/* Шапка: название, адрес, налоговый номер */}
      <div className="text-center mb-2">
        <div className="font-bold text-base">{businessName}</div>
        {location?.receipt_address && <div className="text-xs">{location.receipt_address}</div>}
        {location?.receipt_phone && <div className="text-xs">טל׳: {location.receipt_phone}</div>}
        {location?.receipt_tax_id && <div className="text-xs">ע.מ/ח.פ: {location.receipt_tax_id}</div>}
      </div>

      {/* Тип документа + сквозной номер (у временного номера ещё нет) */}
      <div className="text-center font-bold text-sm">
        {docTypeLabel(r.doc_type)} {r.receipt_number ?? '—'}
      </div>
      {/* Оригинал; офлайн — временный документ (номер присвоится при синке) */}
      <div className="text-center text-xs mb-1">{r.provisional ? '*מסמך זמני*' : '*מקור*'}</div>

      <Divider />

      {/* Мета: метка справа, значение слева (RTL) */}
      <MetaRow label="תאריך:" value={`${timeStr} ${dateStr}`} />
      <MetaRow label="הזמנה:" value={r.provisional && r.provisional_number ? r.provisional_number : `#${r.daily_number}`} />
      {r.table_label && <MetaRow label="שולחן:" value={r.table_label} />}
      {r.customer_name && <MetaRow label="לקוח/ה:" value={r.customer_name} />}
      {r.staff_name && <MetaRow label="מוכר/ת:" value={r.staff_name} />}
      {r.allocation_number && <MetaRow label="מספר הקצאה:" value={r.allocation_number} />}
      {/* Покупатель-бизнес (048) — блок реквизитов на чеке */}
      {r.buyer_name && <MetaRow label="לכבוד:" value={r.buyer_name} />}
      {r.buyer_name && r.buyer_tax_id && <MetaRow label="ח.פ./ע.מ:" value={r.buyer_tax_id} />}

      <Divider />

      {/* Таблица позиций: שם | מחיר | כמות | לתשלום.
          Числовые колонки фикс. ширины (моноширинный шрифт) — не «прыгают»;
          название занимает остаток и обрезается в одну строку. */}
      <div className="grid grid-cols-[1fr_3.5rem_2rem_3.5rem] text-xs font-bold border-b border-gray-300 pb-1 mb-1">
        <span>שם</span>
        <span className="text-left">מחיר</span>
        <span className="text-center">כמות</span>
        <span className="text-left">לתשלום</span>
      </div>
      {/* Цена строки уже включает модификаторы; их расшифровка — опция точки */}
      {r.lines.map((l, i) => (
        <div key={i}>
          <div className="grid grid-cols-[1fr_3.5rem_2rem_3.5rem] text-sm items-baseline">
            <span className="truncate pl-2">
              {l.name}
              {l.variant_name && ` ${l.variant_name}`}
            </span>
            <span className="text-left tabular-nums">{fmt(l.unit_price)}</span>
            <span className="text-center tabular-nums">{l.qty}</span>
            <span className="text-left tabular-nums">{fmt(l.line_total)}</span>
          </div>
          {(location?.settings?.receipt?.print_modifiers ?? false) &&
            l.modifiers.map((m, j) => (
              <div key={j} className="grid grid-cols-[1fr_3.5rem_2rem_3.5rem] text-xs text-gray-700 items-baseline">
                <span className="truncate pe-3">+ {m.name}</span>
                <span className="text-left tabular-nums">{m.price_delta !== 0 ? fmt(m.price_delta) : ''}</span>
              </div>
            ))}
        </div>
      ))}

      {/* Кол-во позиций */}
      <div className="flex justify-between text-sm font-bold border-t border-gray-300 mt-1 pt-1">
        <span>סה"כ פריטים</span>
        <span className="tabular-nums">{itemCount}</span>
      </div>

      {/* Скидка (если есть) */}
      {r.discount_amount > 0 && (
        <div className="flex justify-between text-sm mt-1">
          <span>הנחה{r.discount_type === 'percent' ? ` ${r.discount_value}%` : ''}</span>
          <span className="tabular-nums">−{fmt(r.discount_amount)}</span>
        </div>
      )}

      {/* Вычет лояльности (бесплатный напиток / баллы) */}
      {r.loyalty_discount > 0 && (
        <div className="flex justify-between text-sm mt-1">
          <span>הטבת מועדון</span>
          <span className="tabular-nums">−{fmt(r.loyalty_discount)}</span>
        </div>
      )}

      {/* Чаевые — сверх итога, вне базы НДС */}
      {r.tip_amount > 0 && (
        <div className="flex justify-between text-sm mt-1">
          <span>טיפ</span>
          <span className="tabular-nums">{fmt(r.tip_amount)}</span>
        </div>
      )}

      {/* Итого к оплате — крупно (с чаевыми) */}
      <div className="text-center font-bold text-lg my-3">
        לתשלום: {fmt(r.total + r.tip_amount)}
      </div>

      {/* Разбивка НДС: net + сумма НДС */}
      <MetaRow label='סה"כ חייב במע"מ' value={fmt(netAmount)} />
      <MetaRow label={`מע"מ ${Number(r.vat_rate).toFixed(1)}%`} value={fmt(r.vat_amount)} />

      {/* Оплата */}
      {r.payments.length > 0 && (
        <>
          <Divider />
          {r.payments.map((p, i) => (
            <div key={i}>
              <MetaRow label={receiptMethodLabel(p.method)} value={fmt(p.amount)} />
              {p.method === 'cash' && p.tendered != null && p.change_due != null && p.change_due > 0 && (
                <>
                  <MetaRow label="שולם" value={fmt(p.tendered)} />
                  <MetaRow label="עודף" value={fmt(p.change_due)} />
                </>
              )}
            </div>
          ))}
        </>
      )}

      {/* Подвал-благодарность */}
      {location?.receipt_footer && (
        <>
          <Divider />
          <div className="text-center text-xs">{location.receipt_footer}</div>
        </>
      )}
    </div>
  )
}

function Divider() {
  return <div className="border-t border-dashed border-gray-300 my-2" />
}

/** Строка «метка — значение»: метка справа, значение слева (RTL) */
function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span>{label}</span>
      <span className="tabular-nums" dir="ltr">{value}</span>
    </div>
  )
}
