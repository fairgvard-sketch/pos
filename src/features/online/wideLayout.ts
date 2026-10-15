import { useEffect, useState } from 'react'

/**
 * Широкая раскладка гостевого меню: планшет в любой ориентации (киоск на
 * столе или у стойки, iPad гостя) и окно десктопа. Категории стоят
 * колонкой у начала строки, корзина — капсулой в нижнем углу.
 *
 * 46rem (736px) — ширина портретного iPad mini; высота 30rem отсекает
 * телефон, повёрнутый боком (у него 390–430px): там колонка категорий
 * отняла бы почти всю высоту экрана. Разница портрета и альбома (две или
 * три плитки в ряд, корзина в одну или две колонки) — в CSS по orientation.
 */
export const PUBLIC_MENU_WIDE_QUERY = '(min-width: 46rem) and (min-height: 30rem)'

/** Портретная ориентация: в широкой раскладке категории — квадратные плитки с фото. */
export const PUBLIC_MENU_PORTRAIT_QUERY = '(orientation: portrait)'

function matches(query: string): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(query).matches
}

/** Раскладка следует за поворотом экрана без перезагрузки страницы. */
export function useWideLayout(): boolean {
  return useMediaQuery(PUBLIC_MENU_WIDE_QUERY)
}

export function useMediaQuery(query: string): boolean {
  const [wide, setWide] = useState(() => matches(query))

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
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
  }, [query])

  return wide
}
