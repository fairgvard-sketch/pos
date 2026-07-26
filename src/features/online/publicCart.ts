export interface StoredPublicCartLine {
  key: string
  itemId: string
  name: string
  variantId: string | null
  variantName: string | null
  modIds: string[]
  modNames: string[]
  unitPrice: number
  qty: number
}

const CART_VERSION = 1
const CART_TTL_MS = 6 * 60 * 60 * 1000

export function publicCartKey(locationId: string): string {
  return `kassa-public-cart:${locationId}`
}

function isLine(value: unknown): value is StoredPublicCartLine {
  if (!value || typeof value !== 'object') return false
  const line = value as Partial<StoredPublicCartLine>
  return (
    typeof line.key === 'string' &&
    typeof line.itemId === 'string' &&
    typeof line.name === 'string' &&
    (line.variantId === null || typeof line.variantId === 'string') &&
    (line.variantName === null || typeof line.variantName === 'string') &&
    Array.isArray(line.modIds) &&
    line.modIds.every((id) => typeof id === 'string') &&
    Array.isArray(line.modNames) &&
    line.modNames.every((name) => typeof name === 'string') &&
    Number.isInteger(line.unitPrice) &&
    (line.unitPrice ?? -1) >= 0 &&
    Number.isInteger(line.qty) &&
    (line.qty ?? 0) > 0 &&
    (line.qty ?? 0) <= 99
  )
}

export function readPublicCart(locationId: string, now = Date.now()): StoredPublicCartLine[] {
  try {
    const raw = localStorage.getItem(publicCartKey(locationId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as { version?: number; savedAt?: number; lines?: unknown }
    if (
      parsed.version !== CART_VERSION ||
      typeof parsed.savedAt !== 'number' ||
      now - parsed.savedAt > CART_TTL_MS ||
      !Array.isArray(parsed.lines) ||
      !parsed.lines.every(isLine)
    ) {
      localStorage.removeItem(publicCartKey(locationId))
      return []
    }
    return parsed.lines
  } catch {
    return []
  }
}

export function writePublicCart(locationId: string, lines: StoredPublicCartLine[], now = Date.now()): void {
  try {
    const key = publicCartKey(locationId)
    if (lines.length === 0) {
      localStorage.removeItem(key)
      return
    }
    localStorage.setItem(key, JSON.stringify({ version: CART_VERSION, savedAt: now, lines }))
  } catch {
    // Safari private mode / storage quota: корзина продолжает работать в памяти.
  }
}
