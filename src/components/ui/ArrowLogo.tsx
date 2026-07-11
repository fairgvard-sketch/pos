import logoUrl from '../../assets/logo/logo.png'

/**
 * Знак Angle (стрелка-«A»). Единая точка: меняешь файл assets/logo/logo.png —
 * обновляется везде (сплэш, мастер входа, PIN-экран). className задаёт размер.
 * Источник — anglelogo.png (оригинал с полями); logo.png — он же с обрезкой.
 *
 * Логотип чёрный на прозрачном фоне. На тёмных подложках передавай
 * invert — CSS-фильтр перекрашивает его в белый, без второго файла.
 */
export default function ArrowLogo({
  className = '',
  invert = false,
}: {
  className?: string
  invert?: boolean
}) {
  return (
    <img
      src={logoUrl}
      alt="Angle"
      className={`object-contain ${invert ? 'invert' : ''} ${className}`}
      draggable={false}
    />
  )
}
