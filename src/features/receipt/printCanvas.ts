import type { Receipt, RefundReceipt } from './api'
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
  // Рисуем на заведомо высоком холсте, затем обрезаем по факту
  const tall = document.createElement('canvas')
  tall.width = W
  tall.height = 3000
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
      metaRow(p.method === 'cash' ? 'מזומן' : 'אשראי', fmt(p.amount))
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
export function renderRefundReceiptCanvas(r: RefundReceipt, location: Location | undefined): HTMLCanvasElement {
  const tall = document.createElement('canvas')
  tall.width = W
  tall.height = 2000
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
  center('*מקור*', 22, false, 4)
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
  metaRow(r.method === 'cash' ? 'מזומן' : 'אשראי', `−${fmt(r.amount)}`)

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
  tall.height = 2000
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
  metaRow('סה"כ מכירות', fmt(z.grossCash + z.grossCard), 28, true)
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
  lines: KitchenTicketLine[]
  /** Локализованные подписи (тикет — на языке интерфейса кассы) */
  labels: { takeaway: string; here: string; delivery: string; table: string; addon: string }
}

/**
 * Бегунок для бариста/кухни: номер крупно, тип, стол, позиции с
 * модификаторами и заметками. БЕЗ цен. Печатается при оплате
 * (весь заказ) или при дозаказе стола (только новые позиции).
 */
export function renderKitchenTicketCanvas(d: KitchenTicketData): HTMLCanvasElement {
  const tall = document.createElement('canvas')
  tall.width = W
  tall.height = 2000
  const ctx = tall.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W, tall.height)
  ctx.fillStyle = '#000'

  let y = 44

  // Номер — очень крупно (виден с расстояния); дозаказ — метка стола
  ctx.textAlign = 'center'
  if (d.dailyNumber !== null) {
    ctx.font = FONT(72, true)
    // Офлайн-заказ приходит с локальным номером K-n (уже с префиксом)
    ctx.fillText(typeof d.dailyNumber === 'string' ? d.dailyNumber : `#${d.dailyNumber}`, W / 2, y + 28)
    y += 100
  } else {
    ctx.font = FONT(48, true)
    ctx.fillText(d.labels.addon, W / 2, y + 12)
    y += 72
  }

  // Тип заказа / стол / имя / время
  ctx.font = FONT(28, true)
  const meta: string[] = []
  if (d.tableLabel) meta.push(`${d.labels.table} ${d.tableLabel}`)
  else meta.push(d.labels[d.orderType])
  if (d.customerName) meta.push(d.customerName)
  meta.push(new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }))
  ctx.fillText(meta.join(' · '), W / 2, y)
  y += 44

  // Разделитель
  ctx.save()
  ctx.setLineDash([8, 8])
  ctx.beginPath()
  ctx.moveTo(MX, y - 16)
  ctx.lineTo(RIGHT, y - 16)
  ctx.stroke()
  ctx.restore()
  y += 12

  // Позиции: 2× Капучино Большой
  for (const l of d.lines) {
    ctx.font = FONT(34, true)
    ctx.textAlign = 'right'
    const name = l.variantName ? `${l.name} ${l.variantName}` : l.name
    ctx.fillText(`${l.qty > 1 ? `${l.qty}× ` : ''}${name}`, RIGHT, y)
    y += 44
    ctx.font = FONT(28)
    for (const m of l.modifiers) {
      ctx.fillText(`← ${m}`, RIGHT - 24, y)
      y += 38
    }
    if (l.notes) {
      ctx.fillText(`✎ ${l.notes}`, RIGHT - 24, y)
      y += 38
    }
    y += 8
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
