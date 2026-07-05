/**
 * Kassa ESC/POS Print Agent
 * Runs on localhost:6543, accepts POST /print with order data,
 * sends ESC/POS commands to thermal printer via USB or network.
 *
 * Config via config.json:
 *   printerType    = "usb" | "network" | "file" (default: "file" for testing)
 *   printerUsb     = "/dev/usb/lp0" or "\\\\.\COM3"
 *   printerHost    = "192.168.1.100"
 *   printerPort    = "9100"
 *   agentPort      = 6543
 *   businessName   = "שם העסק"
 *   businessAddress= "כתובת"
 *   businessId     = "123456789"   (ח.פ / ע.מ)
 *   vatRate        = 18            (percent, e.g. 18 for Israel)
 */

const express = require('express')
const cors = require('cors')
const { ThermalPrinter, PrinterTypes, CharacterSet } = require('node-thermal-printer')
const fs = require('fs')
const path = require('path')

const app = express()
app.use(cors())
app.use(express.json())

// Load config
let cfg = {}
try {
  cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))
} catch (_) {}

const PRINTER_TYPE    = cfg.printerType    || process.env.PRINTER_TYPE    || 'file'
const PRINTER_USB     = cfg.printerUsb     || process.env.PRINTER_USB     || '/dev/usb/lp0'
const PRINTER_HOST    = cfg.printerHost    || process.env.PRINTER_HOST    || '192.168.1.100'
const PRINTER_PORT    = cfg.printerPort    || process.env.PRINTER_PORT    || '9100'
const AGENT_PORT      = cfg.agentPort      || process.env.AGENT_PORT      || 6543
const BUSINESS_NAME   = cfg.businessName   || process.env.BUSINESS_NAME   || 'המסעדה'
const BUSINESS_ADDR   = cfg.businessAddress|| process.env.BUSINESS_ADDR   || ''
const BUSINESS_ID     = cfg.businessId     || process.env.BUSINESS_ID     || ''
const VAT_RATE        = parseFloat(cfg.vatRate || process.env.VAT_RATE || '18')

// Receipt counter stored in memory (resets on restart — for production use a DB/file)
let receiptCounter = 1000

function nextReceiptNo() {
  return ++receiptCounter
}

function buildPrinterInterface() {
  if (PRINTER_TYPE === 'network') return `tcp://${PRINTER_HOST}:${PRINTER_PORT}`
  if (PRINTER_TYPE === 'usb')     return PRINTER_USB
  return path.join(__dirname, 'print_output.bin')
}

// Right-pad or left-pad a string to fixed width (for monospace alignment)
function padR(str, len) {
  str = String(str)
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length)
}
function padL(str, len) {
  str = String(str)
  return str.length >= len ? str.slice(0, len) : ' '.repeat(len - str.length) + str
}

// Format date in Israeli style: DD/MM/YYYY HH:MM
function fmtDate(isoStr) {
  const d = new Date(isoStr || Date.now())
  const dd   = String(d.getDate()).padStart(2, '0')
  const mm   = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  const hh   = String(d.getHours()).padStart(2, '0')
  const min  = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm} ${dd}/${mm}/${yyyy}`
}

async function printJob(payload) {
  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: buildPrinterInterface(),
    characterSet: CharacterSet.PC862_HEBREW,
    removeSpecialCharacters: false,
    lineCharacter: '-',
    options: { timeout: 3000 },
  })

  const { type = 'kitchen', order, discount, guest_info, business: biz } = payload
  const orderId  = (order.id || '').slice(0, 8).toUpperCase()
  const dateStr  = fmtDate(order.created_at)

  // Payload can override config-level business info
  const bizName   = (biz?.name    || BUSINESS_NAME).trim()
  const bizAddr   = (biz?.address || BUSINESS_ADDR).trim()
  const bizId     = (biz?.businessId || BUSINESS_ID).trim()
  const vatRate   = biz?.vatRate != null ? biz.vatRate : VAT_RATE

  if (type === 'kitchen') {
    // ── Kitchen ticket ──────────────────────────────────────────
    printer.alignCenter()
    printer.bold(true)
    printer.setTextSize(1, 1)
    printer.println('*** KITCHEN ***')
    printer.setTextNormal()
    printer.bold(false)

    printer.alignLeft()
    printer.println(`Stol: ${order.table_number}   #${orderId}`)
    printer.println(`Ofitsiant: ${order.waiter_name || '-'}`)
    printer.println(dateStr)
    printer.drawLine()

    for (const item of order.items || []) {
      printer.bold(true)
      printer.setTextSize(1, 1)
      printer.println(`${item.qty}x  ${item.name}`)
      printer.setTextNormal()
      printer.bold(false)
      if (item.notes)            printer.println(`   >> ${item.notes}`)
      if (item.modifiers?.length) item.modifiers.forEach((m) => printer.println(`   - ${m}`))
      if (item.guest)            printer.println(`   [Guest ${item.guest}]`)
    }

    printer.drawLine()
    printer.cut()
    const ok = await printer.execute()
    return ok

  } else {
    // ── Receipt — Israeli tax-receipt style ─────────────────────

    const receiptNo = nextReceiptNo()

    // ── Header: business info ───────────────────────────────────
    printer.alignCenter()
    printer.bold(true)
    printer.setTextSize(1, 1)
    printer.println(bizName || 'המסעדה')
    printer.setTextNormal()
    printer.bold(false)

    if (bizAddr) printer.println(bizAddr)
    if (bizId)   printer.println(`ח.פ: ${bizId}`)  // ח.פ:

    printer.drawLine()

    // ── Items table header ──────────────────────────────────────
    // Columns (RTL layout on 48-char paper):
    //   שם (name) | מחיר (unit price) | כמות (qty) | לתשלום (line total)
    // We print LTR on ESC/POS but mirror column order for RTL readability
    const W = 48  // total chars wide (80mm paper ≈ 48 chars at normal size)
    const C1 = 22, C2 = 7, C3 = 5, C4 = 10  // widths: name, price, qty, total (=44+4 sep)

    printer.alignLeft()
    const hdr = padR('שם', C1)         // שם
        + padL('מחיר', C2)  // מחיר
        + padL('כמות', C3)  // כמות
        + padL('לתשלום', C4) // לתשלום
    printer.println(hdr)
    printer.drawLine()

    // ── Items ───────────────────────────────────────────────────
    let subtotal = 0
    for (const item of order.items || []) {
      const lineTotal = (item.price || 0) * (item.qty || 1)
      subtotal += lineTotal

      const nameLine = padR(item.name || '', C1)
           + padL((item.price || 0).toFixed(2), C2)
           + padL(String(item.qty || 1), C3)
           + padL(lineTotal.toFixed(2), C4)
      printer.println(nameLine)

      if (item.notes) printer.println('  ' + item.notes)
    }

    printer.drawLine()

    // ── Discount ────────────────────────────────────────────────
    let discountAmount = 0
    if (discount && discount.value > 0) {
      if (discount.type === 'percent') {
        discountAmount = subtotal * (discount.value / 100)
        printer.println(
          padR(`הנחה ${discount.value}%`, C1 + C2 + C3)  // הנחה X%
          + padL(`-${discountAmount.toFixed(2)}`, C4)
        )
      } else {
        discountAmount = Math.min(subtotal, discount.value)
        printer.println(
          padR('הנחה', C1 + C2 + C3)   // הנחה
          + padL(`-${discountAmount.toFixed(2)}`, C4)
        )
      }
    }

    // ── Points ──────────────────────────────────────────────────
    if (guest_info?.points_used > 0) {
      printer.println(
        padR(`נקודות (${guest_info.points_used})`, C1 + C2 + C3)  // נקודות
        + padL(`-${guest_info.points_used.toFixed(2)}`, C4)
      )
      discountAmount += guest_info.points_used
    }

    const finalTotal = Math.max(0, subtotal - discountAmount)

    // ── VAT breakdown ────────────────────────────────────────────
    // Israeli receipts show: net (without VAT) + VAT amount + total
    const vatFactor = vatRate / 100
    const netAmount = finalTotal / (1 + vatFactor)
    const vatAmount = finalTotal - netAmount

    printer.drawLine()

    // Subtotal line (if discount applied)
    if (discountAmount > 0) {
      printer.println(
        padR('סה"כ לפני הנחה', C1 + C2 + C3) // סה"כ לפני הנחה
        + padL(subtotal.toFixed(2), C4)
      )
    }

    // VAT breakdown lines
    printer.println(
      padR(`מע"מ ${vatRate}.0%`, C1 + C2 + C3)   // מע"מ X%
      + padL(vatAmount.toFixed(2), C4)
    )
    printer.println(
      padR('סה"כ ללא מע"מ', C1 + C2 + C3)  // סה"כ ללא מע"מ
      + padL(netAmount.toFixed(2), C4)
    )

    printer.drawLine()

    // ── Grand total ──────────────────────────────────────────────
    printer.bold(true)
    printer.setTextSize(1, 1)
    printer.println(
      padR('לתשלום:', C1 + C2 + C3)  // לתשלום:
      + padL(`${finalTotal.toFixed(2)}`, C4)
    )
    printer.setTextNormal()
    printer.bold(false)

    printer.drawLine()

    // ── Footer: receipt metadata ─────────────────────────────────
    printer.alignLeft()
    printer.println(`תאריך: ${dateStr}`)   // תאריך:
    printer.println(`מספר: ${receiptNo}`)        // מספר:
    printer.println(`קופא: ${order.waiter_name || '-'}`)  // קופא:
    printer.println(`ללפק: ${order.table_number}`)         // ללפק:

    if (order.customer_name) {
      printer.bold(true)
      printer.println(`לקוח: ${order.customer_name}`)  // לקוח:
      printer.bold(false)
    }

    // ── Loyalty ──────────────────────────────────────────────────
    if (guest_info?.name) {
      printer.drawLine()
      printer.alignCenter()
      const pointsAfter = (guest_info.points || 0)
        - (guest_info.points_used || 0)
        + Math.floor(finalTotal)
      printer.println(`${guest_info.name}`)
      printer.println(`נקודות: ${pointsAfter}`)  // נקודות:
    }

    // ── Thank you ────────────────────────────────────────────────
    printer.drawLine()
    printer.alignCenter()
    printer.println('תודה שקביתם אצלנו!')  // תודה שקביתם אצלנו!
    printer.println('תתראו אותנו יום מקסימא')  // תתראו אותנו יום מקסימא
    printer.cut()

    const ok = await printer.execute()
    return ok
  }
}

// ── Routes ────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, printer: PRINTER_TYPE, version: '2.0.0' })
})

app.post('/print', async (req, res) => {
  try {
    const ok = await printJob(req.body)
    res.json({ ok: !!ok })
  } catch (err) {
    console.error('[print-agent] Error:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.listen(AGENT_PORT, '127.0.0.1', () => {
  console.log(`[print-agent] Running on http://127.0.0.1:${AGENT_PORT}`)
  console.log(`[print-agent] Printer: ${PRINTER_TYPE}`)
  console.log(`[print-agent] Business: ${BUSINESS_NAME}`)
  if (BUSINESS_ID)  console.log(`[print-agent] Business ID: ${BUSINESS_ID}`)
  if (PRINTER_TYPE === 'network') console.log(`[print-agent] Network: ${PRINTER_HOST}:${PRINTER_PORT}`)
  if (PRINTER_TYPE === 'usb')     console.log(`[print-agent] USB: ${PRINTER_USB}`)
})
