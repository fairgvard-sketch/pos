const AGENT_URL = 'http://127.0.0.1:6543'
const TIMEOUT_MS = 2000

export interface PrintItem {
  name: string
  qty: number
  price: number
  notes?: string
  modifiers?: string[]
  guest?: number
}

export interface PrintOrder {
  id: string
  table_number: number
  waiter_name: string
  created_at: string
  total: number
  customer_name?: string
  items: PrintItem[]
}

export interface PrintDiscount {
  type: 'percent' | 'fixed'
  value: number
}

export interface PrintGuestInfo {
  name?: string
  points?: number
  points_used?: number
}

export interface PrintBusinessInfo {
  name?: string
  address?: string
  businessId?: string
  vatRate?: number
}

export interface PrintPayload {
  type: 'kitchen' | 'receipt'
  order: PrintOrder
  discount?: PrintDiscount
  guest_info?: PrintGuestInfo
  business?: PrintBusinessInfo
}

async function isAgentAvailable(): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res = await fetch(`${AGENT_URL}/health`, { signal: ctrl.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

export async function sendToPrinter(payload: PrintPayload): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res = await fetch(`${AGENT_URL}/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    return res.ok
  } catch {
    // Graceful fallback: printer agent not running — silently ignore
    return false
  }
}

export { isAgentAvailable }
