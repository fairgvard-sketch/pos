import { useEffect, useState } from 'react'

/**
 * Широкая раскладка гостевого меню: планшет в альбомной ориентации (киоск
 * на столе или у стойки, iPad гостя) и окно десктопа. Категории стоят
 * колонкой у начала строки, заказ — постоянной панелью у конца, отдельный
 * экран корзины не нужен. Портретный планшет и телефон остаются в одной
 * колонке: там третья колонка отняла бы ширину у карточек товаров.
 */
export const PUBLIC_MENU_WIDE_QUERY = '(min-width: 64rem) and (orientation: landscape)'

function matchesWide(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(PUBLIC_MENU_WIDE_QUERY).matches
}

/** Раскладка следует за поворотом экрана без перезагрузки страницы. */
export function useWideLayout(): boolean {
  const [wide, setWide] = useState(matchesWide)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(PUBLIC_MENU_WIDE_QUERY)
    const onChange = () => setWide(media.matches)
    onChange()
    // Киоском часто служит старый iPad: addEventListener у MediaQueryList
    // появился только в Safari 14, до него работает addListener.
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    }
    media.addListener(onChange)
    return () => media.removeListener(onChange)
  }, [])

  return wide
}
