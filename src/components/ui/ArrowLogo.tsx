import logoUrl from '../../assets/logo/logo.webp'

/**
 * Логотип Arrow POS. Единая точка: меняешь файл assets/logo/logo.webp —
 * обновляется везде (мастер входа, PIN-экран). className задаёт размер.
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
      alt="Arrow POS"
      className={`object-contain ${invert ? 'invert' : ''} ${className}`}
      draggable={false}
    />
  )
}
