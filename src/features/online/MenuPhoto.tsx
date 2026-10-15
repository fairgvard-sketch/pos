import { useEffect, useRef, useState } from 'react'
import { photoFit, photoRatios, rememberPhotoRatio } from './photoFit'

/**
 * Фото товара, вписанное в рамку родителя по правилу photoFit: чуть шире
 * рамки — обрезается по бокам, иначе показывается целиком по центру на
 * размытой копии самого себя (см. photoFit.ts).
 *
 * Слой занимает всю рамку (absolute, inset 0), поэтому у рамки должны быть
 * собственный размер и position: relative. Размер рамки меряется
 * ResizeObserver: карточка товара меняет пропорции при повороте экрана.
 */
export default function MenuPhoto({
  src, className, loading, fetchPriority, decoding, cropSides = false, onLoad, onError,
}: {
  src: string
  /** Декоративная рамка (плитка категории): широкое фото обрезается по бокам. */
  cropSides?: boolean
  /** Класс самого <img>: прежние правила поверхности (прозрачность до загрузки и т. п.). */
  className?: string
  loading?: 'eager' | 'lazy'
  fetchPriority?: 'high' | 'low' | 'auto'
  decoding?: 'async' | 'sync' | 'auto'
  onLoad?: (image: HTMLImageElement) => void
  onError?: () => void
}) {
  const frameRef = useRef<HTMLSpanElement>(null)
  // Форма фото переживает перемонтирование: повторно открытая плитка
  // сразу знает, вписывать ли его целиком.
  const [ratioState, setRatioState] = useState(() => ({ src, ratio: photoRatios.get(src) ?? null }))
  const photoRatio = ratioState.src === src ? ratioState.ratio : photoRatios.get(src) ?? null
  const [frameRatio, setFrameRatio] = useState<number | null>(null)

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const measure = () => {
      const { width, height } = frame.getBoundingClientRect()
      if (width > 0 && height > 0) setFrameRatio(width / height)
    }
    // Колбэк ResizeObserver приходит до отрисовки кадра: фото не успевает
    // мелькнуть в неверной обрезке. Старые Safari без него — по resize.
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure)
      observer.observe(frame)
      return () => observer.disconnect()
    }
    const frameId = window.requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    return () => {
      window.cancelAnimationFrame(frameId)
      window.removeEventListener('resize', measure)
    }
  }, [])

  const fit = photoRatio && frameRatio ? photoFit(photoRatio, frameRatio, cropSides) : null
  // Целиком: рамка <img> повторяет само фото, а не всю рамку, — тогда
  // растушёвка краёв (CSS по data-band) ложится на кромку снимка и стык с
  // размытой подложкой не читается резкой линией.
  const band = fit === 'contain' && photoRatio && frameRatio
    ? photoRatio < frameRatio ? 'sides' : 'ends'
    : undefined
  const containSize = band === 'sides'
    ? { width: `${(photoRatio! / frameRatio!) * 100}%`, height: '100%' }
    : band === 'ends'
      ? { width: '100%', height: `${(frameRatio! / photoRatio!) * 100}%` }
      : null

  return (
    <span ref={frameRef} className="menu-photo" data-fit={fit ?? undefined} data-band={band}>
      {fit === 'contain' && (
        <span
          className="menu-photo-backdrop"
          style={{ backgroundImage: `url(${JSON.stringify(src)})` }}
          aria-hidden
        />
      )}
      <img
        src={src}
        alt=""
        className={className}
        loading={loading}
        fetchPriority={fetchPriority}
        decoding={decoding}
        // Инлайн-стиль сильнее правил поверхностей: плитка, корзина и
        // карточка задают свою обрезку, а форму фото знает только этот слой.
        style={fit ? { objectFit: fit, ...containSize } : undefined}
        onLoad={(event) => {
          const image = event.currentTarget
          rememberPhotoRatio(src, image)
          setRatioState({ src, ratio: photoRatios.get(src) ?? null })
          onLoad?.(image)
        }}
        onError={onError}
      />
    </span>
  )
}
