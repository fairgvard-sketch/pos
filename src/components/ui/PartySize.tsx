import { t, type Lang } from '../../lib/i18n'

/**
 * Размер компании — иконкой и числом, а не словом.
 *
 * Раньше в списках, на таймлайне и в карточках стояло «4 чел.» / «4
 * אורחים». В плотных строках слово занимает больше места, чем сама
 * величина, и на иврите ещё и меняет длину строки: колонки переставали
 * совпадать. Фигурка человека читается мгновенно и одинаково в обоих
 * языках, а число остаётся табличным — цифры под цифрами.
 *
 * Слово никуда не делось для тех, кто экран не видит: оно уходит в
 * `aria-label`, поэтому скринридер по-прежнему произносит «4 гостя».
 */
export default function PartySize({ n, lang, className = '' }: {
  n: number
  lang: Lang
  className?: string
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 tabular-nums whitespace-nowrap ${className}`}
      aria-label={`${n} ${t(lang, 'resGuestsShort')}`}
      title={`${n} ${t(lang, 'resGuestsShort')}`}
    >
      <PersonGlyph />
      {n}
    </span>
  )
}

/**
 * Фигурка масштабируется от размера шрифта (`1em`), а не фиксированными
 * пикселями: один и тот же компонент стоит и в мелкой строке таблицы,
 * и в крупной шапке карточки.
 */
export function PersonGlyph({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <circle cx="12" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M5.5 19.5c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}
