import ArrowLogo from './ArrowLogo'

/**
 * Фирменный блок Angle: знак-стрелка и рядом слово ANGLE целиком
 * (Archivo Black). Размер задаётся font-size контейнера через className
 * (например text-2xl) — буквы 1em, знак масштабируется от них.
 * invert — белая версия для тёмных подложек.
 *
 * Слово пишется полностью, а не «NGLE» после знака: знак читается как «A»
 * только тем, кто уже знает бренд, — остальные видели «NGLE». То же
 * правило в сплэше (`BrandSplash`), иначе загрузка и вход спорят друг с
 * другом.
 */
export default function BrandWordmark({
  className = '',
  invert = false,
}: {
  className?: string
  invert?: boolean
}) {
  return (
    <span
      dir="ltr"
      className={`inline-flex items-end select-none leading-none ${invert ? 'text-white' : 'text-gray-900'} ${className}`}
    >
      <ArrowLogo className="h-[1.5em] w-auto -mb-[0.14em]" invert={invert} />
      <span
        className="ms-[0.08em] leading-none tracking-[0.04em]"
        style={{ fontFamily: "'Archivo Black', 'Inter', sans-serif" }}
      >
        ANGLE
      </span>
    </span>
  )
}
