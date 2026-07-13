import type { MenuItem } from '../types'

/** Плитка-заглушка вместо фото: мягкий тон + первая буква */
const TILE_TONES = [
  'bg-orange-50 text-orange-300',
  'bg-emerald-50 text-emerald-300',
  'bg-sky-50 text-sky-300',
  'bg-amber-50 text-amber-300',
  'bg-rose-50 text-rose-300',
  'bg-violet-50 text-violet-300',
]

function tileTone(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 997
  return TILE_TONES[h % TILE_TONES.length]
}

const SIZES = {
  // Иконка чуть меньше плитки: занимает ~64% ширины, по центру
  card: 'w-[64%] mx-auto aspect-square rounded-xl text-3xl',
  // Полноширинное фото плитки товара: от края до края, cover, скруглены только верхние углы
  tile: 'w-full aspect-[4/3] rounded-t-2xl text-4xl',
  line: 'w-10 h-10 rounded-lg text-base',
  mini: 'w-8 h-8 rounded-lg text-sm',
  hero: 'w-full aspect-square rounded-2xl text-5xl',
} as const

// Крупные превью (карточка/герой) — фото целиком (contain); плитка и мелкие — заполняют (cover)
const FIT = { card: 'object-contain', hero: 'object-contain', tile: 'object-cover', line: 'object-cover', mini: 'object-cover' } as const

export default function ItemImage({ item, size }: { item: Pick<MenuItem, 'name' | 'image_url'>; size: keyof typeof SIZES }) {
  const cls = SIZES[size]
  if (item.image_url) {
    // lazy/async: не декодировать все фото каталога разом — щадим CPU T2
    return <img src={item.image_url} alt="" loading="lazy" decoding="async" className={`${cls} ${FIT[size]}`} />
  }
  return (
    <div className={`${cls} ${tileTone(item.name)} flex items-center justify-center font-black select-none shrink-0`}>
      {item.name.slice(0, 1).toUpperCase()}
    </div>
  )
}
