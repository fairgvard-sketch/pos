import type { Receipt, RefundReceipt } from './api'
import { receiptMethodLabel } from '../../lib/payMethods'
import type { Location } from '../../types'

/**
 * Рендер чека в canvas для печати картинкой (ESC/POS растр через RawBT).
 * Раскладка повторяет ReceiptBody (иврит, RTL): метки справа, значения
 * слева, таблица позиций שם|מחיר|כמות|לתשלום. fillText сам корректно
 * рисует иврит (bidi внутри строки), выравнивание задаём вручную.
 */

const W = 576              // ширина головки 80мм @ 203dpi
const MX = 12              // поля
const RIGHT = W - MX
// Колонки таблицы (x в пикселях): в RTL название справа, суммы к левому краю
const COL_TOTAL = MX       // לתשלום (левый край, textAlign left)
const COL_QTY = 150        // כמות (центр)
const COL_PRICE = 200      // מחיר (left)
const NAME_MAX = RIGHT - 290 // максимум ширины названия

const FONT = (size: number, bold = false) => `${bold ? '700' : '400'} ${size}px monospace`

/**
 * Высота чернового холста под чек/тикет. Раньше стояла ФИКСИРОВАННАЯ
 * (3000/2000px) — длинный чек (много позиций + модификаторы) не влезал,
 * рисунок обрезался, а `out.height = min(tall.height, y+24)` капал итог по
 * потолку → хвост чека терялся молча. Теперь считаем от фактического
 * контента: шапка/подвал (base) + строки с запасом на модификаторы, плюс
 * потолок как страховка от абсурдных значений (память WebView T2 конечна).
 */
const MAX_SCRATCH_HEIGHT = 20000
function scratchHeight(base: number, rowCount: number, perRow = 70): number {
  return Math.min(MAX_SCRATCH_HEIGHT, Math.ceil(base + rowCount * perRow))
}

function fmt(agorot: number): string {
  return (agorot / 100).toFixed(2)
}

function docTypeLabel(dt: Receipt['doc_type']): string {
  switch (dt) {
    case 'receipt': return 'קבלה'
    case 'tax_invoice': return 'חשבונית מס'
    case 'invoice_receipt': return 'חשבונית מס/קבלה'
  }
}

export interface ReceiptRenderOpts {
  /** Печать копии: *העתק* вместо *מקור* (второй экземпляр, перепечатка) */
  copy?: boolean
}

export function renderReceiptCanvas(
  r: Receipt,
  location: Location | undefined,
  opts: ReceiptRenderOpts = {}
): HTMLCanvasElement {
  // Рисуем на холсте, высота которого посчитана от контента (иначе длинный
  // чек обрезался). Строки товаров + их модификаторы (если печатаются).
  const printModsForHeight = location?.settings?.receipt?.print_modifiers ?? false
  const modRows = printModsForHeight
    ? r.lines.reduce((s, l) => s + l.modifiers.length, 0)
    : 0
  const tall = document.createElement('canvas')
  tall.width = W
  tall.height = scratchHeight(1100, r.lines.length + modRows)
  const ctx = tall.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W, tall.height)
  ctx.fillStyle = '#000'

  let y = 30

  const center = (text: string, size: number, bold = false, gap = 8) => {
    ctx.font = FONT(size, bold)
    ctx.textAlign = 'center'
    ctx.fillText(text, W / 2, y)
    y += size + gap
  }
  // Метка справа, значение слева (RTL-строка)
  const metaRow = (label: string, value: string, size = 26, bold = false) => {
    ctx.font = FONT(size, bold)
    ctx.textAlign = 'right'
    ctx.fillText(label, RIGHT, y)
    ctx.textAlign = 'left'
    ctx.fillText(value, MX, y)
    y += size + 8
  }
  const divider = () => {
    ctx.save()
    ctx.strokeStyle = '#000'
    ctx.setLineDash([6, 6])
    ctx.beginPath()
    ctx.moveTo(MX, y - 8)
    ctx.lineTo(RIGHT, y - 8)
    ctx.stroke()
    ctx.restore()
    y += 16
  }
  // Обрезка длинного названия под максимальную ширину
  const fitText = (text: string, maxWidth: number): string => {
    if (ctx.measureText(text).width <= maxWidth) return text
    let s = text
    while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1)
    return s + '…'
  }

  // ── Шапка ──
  const businessName = location?.receipt_business_name || location?.name || ''
  if (businessName) center(businessName, 34, true, 10)
  if (location?.receipt_address) center(location.receipt_address, 24)
  if (location?.receipt_phone) center(`טל׳: ${location.receipt_phone}`, 24)
  if (location?.receipt_tax_id) center(`ע.מ/ח.פ: ${location.receipt_tax_id}`, 24)
  y += 6

  // ── Тип документа + номер (у временного офлайн-чека номера ещё нет) ──
  center(`${docTypeLabel(r.doc_type)} ${r.receipt_number ?? '—'}`, 28, true, 6)
  center(r.provisional ? '*מסמך זמני*' : opts.copy ? '*העתק*' : '*מקור*', 22, false, 4)
  divider()

  // ── Мета ──
  const dt = new Date(r.paid_at ?? r.created_at)
  const dateStr = dt.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const timeStr = dt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
  metaRow('תאריך:', `${timeStr} ${dateStr}`)
  metaRow('הזמנה:', r.provisional && r.provisional_number ? r.provisional_number : `#${r.daily_number}`)
  if (r.table_label) metaRow('שולחן:', r.table_label)
  if (r.customer_name) metaRow('לקוח/ה:', r.customer_name)
  if (r.staff_name) metaRow('מוכר/ת:', r.staff_name)
  if (r.allocation_number) metaRow('מספר הקצאה:', r.allocation_number)
  // Покупатель-бизнес (048): חשבונית מס для B2B — реквизиты покупателя
  if (r.buyer_name) {
    metaRow('לכבוד:', r.buyer_name, 26, true)
    if (r.buyer_tax_id) metaRow('ח.פ./ע.מ:', r.buyer_tax_id)
  }
  divider()

  // ── Таблица позиций ──
  ctx.font = FONT(22, true)
  ctx.textAlign = 'right'
  ctx.fillText('שם', RIGHT, y)
  ctx.textAlign = 'left'
  ctx.fillText('מחיר', COL_PRICE, y)
  ctx.textAlign = 'center'
  ctx.fillText('כמות', COL_QTY, y)
  ctx.textAlign = 'left'
  ctx.fillText('לתשלום', COL_TOTAL, y)
  y += 28
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(MX, y - 20)
  ctx.lineTo(RIGHT, y - 20)
  ctx.stroke()
  ctx.restore()

  // Цена строки уже включает надбавки модификаторов; их расшифровка —
  // опция точки (Настройки → Чеки и печать → Модификаторы в чеке)
  const printMods = location?.settings?.receipt?.print_modifiers ?? false
  for (const l of r.lines) {
    ctx.font = FONT(26)
    const name = l.variant_name ? `${l.name} ${l.variant_name}` : l.name
    ctx.textAlign = 'right'
    ctx.fillText(fitText(name, NAME_MAX), RIGHT, y)
    ctx.textAlign = 'left'
    ctx.fillText(fmt(l.unit_price), COL_PRICE, y)
    ctx.textAlign = 'center'
    ctx.fillText(String(l.qty), COL_QTY, y)
    ctx.textAlign = 'left'
    ctx.fillText(fmt(l.line_total), COL_TOTAL, y)
    y += 34
    if (printMods) {
      for (const m of l.modifiers) {
        ctx.font = FONT(22)
        ctx.textAlign = 'right'
        ctx.fillText(fitText(`+ ${m.name}`, NAME_MAX), RIGHT - 18, y)
        if (m.price_delta !== 0) {
          ctx.textAlign = 'left'
          ctx.fillText(fmt(m.price_delta), COL_PRICE, y)
        }
        y += 28
      }
    }
  }

  // Кол-во позиций
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(MX, y - 22)
  ctx.lineTo(RIGHT, y - 22)
  ctx.stroke()
  ctx.restore()
  const itemCount = r.lines.reduce((s, l) => s + l.qty, 0)
  metaRow('סה"כ פריטים', String(itemCount), 26, true)

  // Скидка
  if (r.discount_amount > 0) {
    metaRow(
      `הנחה${r.discount_type === 'percent' ? ` ${r.discount_value}%` : ''}`,
      `−${fmt(r.discount_amount)}`
    )
  }

  // Вычет лояльности (бесплатный напиток / баллы)
  if (r.loyalty_discount > 0) {
    metaRow('הטבת מועדון', `−${fmt(r.loyalty_discount)}`)
  }

  // Чаевые — сверх итога, в базу מע"מ не входят
  if (r.tip_amount > 0) {
    metaRow('טיפ', fmt(r.tip_amount))
  }

  // Итого крупно (с чаевыми — то, что фактически заплатил гость)
  y += 10
  center(`לתשלום: ${fmt(r.total + r.tip_amount)}`, 36, true, 16)

  // НДС — база только товары (r.total), без чаевых
  metaRow('סה"כ חייב במע"מ', fmt(r.total - r.vat_amount))
  metaRow(`מע"מ ${Number(r.vat_rate).toFixed(1)}%`, fmt(r.vat_amount))

  // Оплата
  if (r.payments.length > 0) {
    divider()
    for (const p of r.payments) {
      metaRow(receiptMethodLabel(p.method), fmt(p.amount))
      if (p.method === 'cash' && p.tendered != null && p.change_due != null && p.change_due > 0) {
        metaRow('שולם', fmt(p.tendered))
        metaRow('עודף', fmt(p.change_due))
      }
    }
  }

  // Футер
  if (location?.receipt_footer) {
    divider()
    center(location.receipt_footer, 24)
  }

  // Обрезать по фактической высоте
  const out = document.createElement('canvas')
  out.width = W
  out.height = Math.min(tall.height, y + 24)
  const octx = out.getContext('2d')!
  octx.fillStyle = '#fff'
  octx.fillRect(0, 0, out.width, out.height)
  octx.drawImage(tall, 0, 0)
  return out
}

// ── תעודת זיכוי — чек возврата ────────────────────────────

/**
 * Кредитный документ возврата: своя сквозная нумерация, ссылка на
 * исходный чек, возвращённые позиции (или одна строка суммой),
 * доля НДС, способ выдачи. Иврит/RTL, раскладка как у чека.
 */
export function renderRefundReceiptCanvas(
  r: RefundReceipt,
  location: Location | undefined,
  opts: ReceiptRenderOpts = {}
): HTMLCanvasElement {
  const tall = document.createElement('canvas')
  tall.width = W
  // Возврат может перечислять построчно возвращённые позиции — высота от их числа
  tall.height = scratchHeight(1000, r.items?.length ?? 0)
  const ctx = tall.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W, tall.height)
  ctx.fillStyle = '#000'

  let y = 30

  const center = (text: string, size: number, bold = false, gap = 8) => {
    ctx.font = FONT(size, bold)
    ctx.textAlign = 'center'
    ctx.fillText(text, W / 2, y)
    y += size + gap
  }
  const metaRow = (label: string, value: string, size = 26, bold = false) => {
    ctx.font = FONT(size, bold)
    ctx.textAlign = 'right'
    ctx.fillText(label, RIGHT, y)
    ctx.textAlign = 'left'
    ctx.fillText(value, MX, y)
    y += size + 8
  }
  const divider = () => {
    ctx.save()
    ctx.strokeStyle = '#000'
    ctx.setLineDash([6, 6])
    ctx.beginPath()
    ctx.moveTo(MX, y - 8)
    ctx.lineTo(RIGHT, y - 8)
    ctx.stroke()
    ctx.restore()
    y += 16
  }
  const fitText = (text: string, maxWidth: number): string => {
    if (ctx.measureText(text).width <= maxWidth) return text
    let s = text
    while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1)
    return s + '…'
  }

  // ── Шапка (реквизиты бизнеса) ──
  const businessName = location?.receipt_business_name || location?.name || ''
  if (businessName) center(businessName, 34, true, 10)
  if (location?.receipt_address) center(location.receipt_address, 24)
  if (location?.receipt_phone) center(`טל׳: ${location.receipt_phone}`, 24)
  if (location?.receipt_tax_id) center(`ע.מ/ח.פ: ${location.receipt_tax_id}`, 24)
  y += 6

  // ── Тип документа + номер ──
  center(`תעודת זיכוי ${r.refund_number ?? '—'}`, 28, true, 6)
  center(opts.copy ? '*העתק*' : '*מקור*', 22, false, 4)
  divider()

  // ── Мета: дата, исходный документ ──
  const dt = new Date(r.created_at)
  const dateStr = dt.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const timeStr = dt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
  metaRow('תאריך:', `${timeStr} ${dateStr}`)
  if (r.receipt_number != null) metaRow('עבור חשבונית:', String(r.receipt_number))
  metaRow('הזמנה:', `#${r.daily_number}`)
  if (r.staff_name) metaRow('מוכר/ת:', r.staff_name)
  if (r.reason) metaRow('סיבה:', fitText(r.reason, RIGHT - 200))
  divider()

  // ── Возвращённые позиции (или одна строка суммой) ──
  if (r.items && r.items.length > 0) {
    for (const l of r.items) {
      ctx.font = FONT(26)
      ctx.textAlign = 'right'
      ctx.fillText(fitText(`${l.qty > 1 ? `${l.qty}× ` : ''}${l.name}`, NAME_MAX + 150), RIGHT, y)
      ctx.textAlign = 'left'
      ctx.fillText(`−${fmt(l.amount)}`, COL_TOTAL, y)
      y += 34
    }
    y += 4
  }

  // ── Итог зикуя крупно ──
  center(`סה"כ זיכוי: −${fmt(r.amount)}`, 36, true, 16)

  // НДС (доля в возвращённой сумме)
  metaRow('סה"כ חייב במע"מ', `−${fmt(r.amount - r.vat_amount)}`)
  metaRow(`מע"מ ${Number(r.vat_rate).toFixed(1)}%`, `−${fmt(r.vat_amount)}`)

  // Способ выдачи
  divider()
  metaRow(receiptMethodLabel(r.method), `−${fmt(r.amount)}`)

  if (location?.receipt_footer) {
    divider()
    center(location.receipt_footer, 24)
  }

  const out = document.createElement('canvas')
  out.width = W
  out.height = Math.min(tall.height, y + 24)
  const octx = out.getContext('2d')!
  octx.fillStyle = '#fff'
  octx.fillRect(0, 0, out.width, out.height)
  octx.drawImage(tall, 0, 0)
  return out
}

// ── דו"ח Z — отчёт закрытия смены ─────────────────────────

export interface ZReportData {
  zNumber: number | null
  openedAt: string | null
  closedAt: string | null
  staffName: string | null
  ordersCount: number
  grossCash: number
  grossCard: number
  /** Кошельки (046): брутто по каждому способу кроме cash/card */
  grossWallets: { method: string; amount: number }[]
  refundsTotal: number
  /** Нетто-выручка (продажи − возвраты) */
  netTotal: number
  vatTotal: number | null
  tipsTotal: number
  openingFloat: number | null
  /** Внесения/изъятия наличных за смену (038) */
  cashIn: number
  cashOut: number
  expectedCash: number
  countedCash: number
  cashDiff: number
  note?: string | null
}

/**
 * Печатный דו"ח Z: реквизиты бизнеса, сквозной номер Z (037), период
 * смены, брутто-продажи по способам, возвраты, НДС, кассовая сверка.
 * Иврит/RTL, раскладка как у чека.
 */
export function renderZReportCanvas(z: ZReportData, location: Location | undefined): HTMLCanvasElement {
  const tall = document.createElement('canvas')
  tall.width = W
  // Разбивка по способам оплаты (кошельки) — высота с запасом на их число
  tall.height = scratchHeight(1600, z.grossWallets?.length ?? 0)
  const ctx = tall.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W, tall.height)
  ctx.fillStyle = '#000'

  let y = 30

  const center = (text: string, size: number, bold = false, gap = 8) => {
    ctx.font = FONT(size, bold)
    ctx.textAlign = 'center'
    ctx.fillText(text, W / 2, y)
    y += size + gap
  }
  const metaRow = (label: string, value: string, size = 26, bold = false) => {
    ctx.font = FONT(size, bold)
    ctx.textAlign = 'right'
    ctx.fillText(label, RIGHT, y)
    ctx.textAlign = 'left'
    ctx.fillText(value, MX, y)
    y += size + 8
  }
  const divider = () => {
    ctx.save()
    ctx.strokeStyle = '#000'
    ctx.setLineDash([6, 6])
    ctx.beginPath()
    ctx.moveTo(MX, y - 8)
    ctx.lineTo(RIGHT, y - 8)
    ctx.stroke()
    ctx.restore()
    y += 16
  }
  const dtParts = (iso: string) => {
    const d = new Date(iso)
    return `${d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })} ${d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' })}`
  }

  // ── Шапка (реквизиты бизнеса) ──
  const businessName = location?.receipt_business_name || location?.name || ''
  if (businessName) center(businessName, 34, true, 10)
  if (location?.receipt_address) center(location.receipt_address, 24)
  if (location?.receipt_phone) center(`טל׳: ${location.receipt_phone}`, 24)
  if (location?.receipt_tax_id) center(`ע.מ/ח.פ: ${location.receipt_tax_id}`, 24)
  y += 6

  center(`דו"ח Z מס' ${z.zNumber ?? '—'}`, 30, true, 6)
  center('סגירת משמרת', 24, false, 4)
  divider()

  if (z.openedAt) metaRow('נפתחה:', dtParts(z.openedAt))
  metaRow('נסגרה:', dtParts(z.closedAt ?? new Date().toISOString()))
  if (z.staffName) metaRow('נסגרה ע"י:', z.staffName)
  metaRow('עסקאות:', String(z.ordersCount))
  divider()

  // ── Продажи (брутто) ──
  metaRow('מכירות מזומן', fmt(z.grossCash))
  metaRow('מכירות אשראי', fmt(z.grossCard))
  for (const w of z.grossWallets) {
    metaRow(`מכירות ${receiptMethodLabel(w.method)}`, fmt(w.amount))
  }
  const grossAll = z.grossCash + z.grossCard + z.grossWallets.reduce((s, w) => s + w.amount, 0)
  metaRow('סה"כ מכירות', fmt(grossAll), 28, true)
  if (z.refundsTotal > 0) metaRow('החזרים', `−${fmt(z.refundsTotal)}`)
  metaRow('סה"כ נטו', fmt(z.netTotal), 28, true)
  if (z.vatTotal != null) metaRow('מתוך זה מע"מ', fmt(z.vatTotal))
  if (z.tipsTotal > 0) metaRow('טיפים', fmt(z.tipsTotal))
  divider()

  // ── Кассовая сверка ──
  if (z.openingFloat != null) metaRow('עודף פתיחה', fmt(z.openingFloat))
  if (z.cashIn > 0) metaRow('הפקדות מזומן', `+${fmt(z.cashIn)}`)
  if (z.cashOut > 0) metaRow('משיכות מזומן', `−${fmt(z.cashOut)}`)
  metaRow('מזומן צפוי', fmt(z.expectedCash))
  metaRow('מזומן שנספר', fmt(z.countedCash))
  metaRow(
    z.cashDiff === 0 ? 'התאמה מלאה' : z.cashDiff < 0 ? 'חוסר' : 'עודף',
    z.cashDiff === 0 ? '✓' : `${z.cashDiff < 0 ? '−' : '+'}${fmt(Math.abs(z.cashDiff))}`,
    28, true
  )
  if (z.note) {
    divider()
    center(z.note, 24)
  }

  y += 6
  center('— סוף דו"ח —', 22, false, 4)

  const out = document.createElement('canvas')
  out.width = W
  out.height = Math.min(tall.height, y + 24)
  const octx = out.getContext('2d')!
  octx.fillStyle = '#fff'
  octx.fillRect(0, 0, out.width, out.height)
  octx.drawImage(tall, 0, 0)
  return out
}

// ── Тестовая печать ───────────────────────────────────────

/**
 * Пробный оттиск (Настройки → Устройство → Тестовая печать):
 * проверка, что тихая печать реально доходит до принтера.
 * Двуязычно — иврит и русский, без фискальной нагрузки.
 */
export function renderTestPrintCanvas(businessName: string, deviceName: string): HTMLCanvasElement {
  const tall = document.createElement('canvas')
  tall.width = W
  tall.height = 600
  const ctx = tall.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W, tall.height)
  ctx.fillStyle = '#000'

  let y = 40
  const center = (text: string, size: number, bold = false, gap = 10) => {
    ctx.font = FONT(size, bold)
    ctx.textAlign = 'center'
    ctx.fillText(text, W / 2, y)
    y += size + gap
  }

  if (businessName) center(businessName, 34, true, 14)
  center('בדיקת הדפסה', 30, true, 6)
  center('Тестовая печать', 26, false, 14)

  ctx.save()
  ctx.strokeStyle = '#000'
  ctx.setLineDash([6, 6])
  ctx.beginPath()
  ctx.moveTo(MX, y)
  ctx.lineTo(RIGHT, y)
  ctx.stroke()
  ctx.restore()
  y += 24

  if (deviceName) center(deviceName, 26, false, 10)
  const now = new Date()
  center(
    `${now.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`,
    24, false, 10
  )
  center('✓ OK', 30, true, 10)

  const out = document.createElement('canvas')
  out.width = W
  out.height = Math.min(tall.height, y + 24)
  const octx = out.getContext('2d')!
  octx.fillStyle = '#fff'
  octx.fillRect(0, 0, out.width, out.height)
  octx.drawImage(tall, 0, 0)
  return out
}

// ── Тикет на кухню/бар ────────────────────────────────────

export interface KitchenTicketLine {
  qty: number
  name: string
  variantName: string | null
  modifiers: string[]
  notes: string
}

export interface KitchenTicketData {
  /** Номер заказа (#42); строка K-n у офлайн-заказа; null для дозаказа стола */
  dailyNumber: number | string | null
  orderType: 'here' | 'takeaway' | 'delivery'
  customerName: string
  tableLabel: string
  /** Имя кассира (PIN-сессия) — строка קופאי/ת в шапке */
  staffName: string
  /** Имя устройства из настроек — строка מדפסת в шапке */
  deviceName: string
  lines: KitchenTicketLine[]
}

// Тикет, как и чек, печатается только на иврите — независимо от языка кассы
const TICKET_HE = {
  printer: 'מדפסת',
  orderNo: 'מספר הזמנה',
  printedAt: 'תאריך ושעת הדפסה',
  cashier: 'קופאי/ת',
  order: 'הזמנה',
  table: 'שולחן',
  addon: 'תוספת להזמנה',
  here: 'כאן',
  takeaway: 'לקחת',
  delivery: 'משלוח',
} as const

/**
 * Бегунок для бариста/кухни в формате «как счёт»: ровная шапка
 * метка-значение (принтер, номер заказа, время печати, кассир), затем
 * стол/тип и номер умеренным жирным, затем позиции — количество отдельной
 * колонкой, пунктир между позициями. БЕЗ цен и БЕЗ крупных «заказ/дозаказ»:
 * у дозаказа стола вместо номера строка-пометка обычным кеглем.
 */
export function renderKitchenTicketCanvas(d: KitchenTicketData): HTMLCanvasElement {
  const tall = document.createElement('canvas')
  tall.width = W
  // Считаем все рисуемые строки, чтобы длинный заказ не обрезался:
  // позиция ~48px + пунктир ~22px, модификаторы/заметки ~36px → запас 72.
  const ticketRows = d.lines.reduce(
    (s, l) => s + 1 + l.modifiers.length + (l.notes ? 1 : 0),
    0
  )
  tall.height = scratchHeight(760, ticketRows, 72)
  const ctx = tall.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W, tall.height)
  ctx.fillStyle = '#000'

  let y = 44

  // Шапка: метка справа, значение слева — ровные края, как metaRow счёта
  const metaRow = (label: string, value: string) => {
    ctx.font = FONT(26)
    ctx.textAlign = 'right'
    ctx.fillText(`${label}:`, RIGHT, y)
    ctx.textAlign = 'left'
    ctx.fillText(value, MX, y)
    y += 36
  }
  const divider = () => {
    ctx.save()
    ctx.setLineDash([8, 8])
    ctx.beginPath()
    ctx.moveTo(MX, y - 22)
    ctx.lineTo(RIGHT, y - 22)
    ctx.stroke()
    ctx.restore()
    y += 22
  }

  // Офлайн-заказ приходит с локальным номером K-n (уже с префиксом)
  const numText = d.dailyNumber === null
    ? ''
    : typeof d.dailyNumber === 'string' ? d.dailyNumber : `#${d.dailyNumber}`
  const now = new Date()
  const printedAt =
    `${now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })} ` +
    now.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })

  if (d.deviceName) metaRow(TICKET_HE.printer, d.deviceName)
  if (numText) metaRow(TICKET_HE.orderNo, numText)
  metaRow(TICKET_HE.printedAt, printedAt)
  if (d.staffName) metaRow(TICKET_HE.cashier, d.staffName)
  y += 8
  divider()

  // Куда нести: стол или тип заказа, имя клиента, номер — умеренный жирный
  const subRow = (text: string) => {
    ctx.font = FONT(30, true)
    ctx.textAlign = 'right'
    ctx.fillText(text, RIGHT, y)
    y += 42
  }
  subRow(d.tableLabel ? `${TICKET_HE.table} ${d.tableLabel}` : TICKET_HE[d.orderType])
  if (d.customerName) subRow(d.customerName)
  subRow(numText ? `${TICKET_HE.order}: ${numText}` : TICKET_HE.addon)
  y += 6
  divider()

  // Позиции: количество колонкой слева, название справа; длинное название
  // ужимается под остаток ширины, чтобы колонки не наезжали друг на друга
  d.lines.forEach((l, i) => {
    if (i > 0) divider()
    ctx.font = FONT(36, true)
    ctx.textAlign = 'left'
    ctx.fillText(String(l.qty), MX, y)
    const qtyW = ctx.measureText(String(l.qty)).width
    const name = l.variantName ? `${l.name} ${l.variantName}` : l.name
    const maxW = RIGHT - MX - qtyW - 24
    let size = 36
    ctx.font = FONT(size, true)
    while (size > 24 && ctx.measureText(name).width > maxW) {
      size -= 2
      ctx.font = FONT(size, true)
    }
    ctx.textAlign = 'right'
    ctx.fillText(name, RIGHT, y)
    y += 48
    ctx.font = FONT(28)
    for (const m of l.modifiers) {
      ctx.fillText(m, RIGHT - 36, y)
      y += 36
    }
    if (l.notes) {
      ctx.fillText(`✎ ${l.notes}`, RIGHT - 36, y)
      y += 36
    }
  })

  const out = document.createElement('canvas')
  out.width = W
  out.height = Math.min(tall.height, y + 24)
  const octx = out.getContext('2d')!
  octx.fillStyle = '#fff'
  octx.fillRect(0, 0, out.width, out.height)
  octx.drawImage(tall, 0, 0)
  return out
}

/**
 * QR-флаер онлайн-заказов (Настройки → Обслуживание): визитка на термоленте —
 * название, QR со ссылкой на страницу заказа, подпись. Клеится на стойку.
 * qr — уже отрисованный QR-canvas (библиотека qrcode), мы только компонуем.
 */
export function renderQrFlyerCanvas(businessName: string, qr: HTMLCanvasElement, caption: string): HTMLCanvasElement {
  const qrSize = 400
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = 620
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W, canvas.height)
  ctx.fillStyle = '#000'

  let y = 56
  ctx.font = FONT(40, true)
  ctx.textAlign = 'center'
  ctx.fillText(businessName, W / 2, y)
  y += 28

  ctx.drawImage(qr, (W - qrSize) / 2, y, qrSize, qrSize)
  y += qrSize + 52

  ctx.font = FONT(30)
  ctx.fillText(caption, W / 2, y)
  return canvas
}
