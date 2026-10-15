/**
 * Как вписать фото товара в рамку.
 *
 * Фото меню приходят в разных пропорциях: у Bulochka горизонтальные 3:2
 * (кофе, выпечка), квадратные 1:1 (бутылки соков) и вертикальные 2:3. Рамки
 * тоже разные: плитка 4:3, миниатюры 1:1, высокая карточка товара. Обрезка
 * по рамке (`cover`) срезала квадратной бутылке крышку и дно, а у
 * вертикальной оставляла одно горлышко.
 *
 * Правило: `cover` только когда фото чуть шире рамки — срезаются лишь поля
 * по бокам, не больше ~12% с каждой стороны, а верх и низ никогда (почти:
 * допуск 2.5%). Во всех остальных случаях фото показывается целиком по
 * центру (`contain`) на размытой копии самого себя.
 */
export type PhotoFit = 'cover' | 'contain'

/** Насколько фото может быть уже рамки: срез сверху и снизу ≤ 2.5%. */
const MIN_COVER = 0.95
/** Насколько фото может быть шире рамки: срез по бокам ≤ ~11.5% с каждой стороны. */
const MAX_COVER = 1.3

/**
 * cropSides — для декоративных рамок (плитка категории): фото шире рамки
 * обрезается по бокам на любую величину, предмет в центре кадра остаётся
 * целым. Верх и низ по-прежнему не срезаются: вертикальное фото — целиком.
 */
export function photoFit(photoRatio: number, frameRatio: number, cropSides = false): PhotoFit {
  if (!(photoRatio > 0) || !(frameRatio > 0)) return 'cover'
  const relative = photoRatio / frameRatio
  return relative >= MIN_COVER && (cropSides || relative <= MAX_COVER) ? 'cover' : 'contain'
}

/**
 * Пропорции уже загруженных фото (src → ширина / высота). Плитка, открытая
 * повторно, и миниатюра корзины знают форму фото до загрузки и не
 * перестраивают кадр после первого показа.
 */
export const photoRatios = new Map<string, number>()

export function rememberPhotoRatio(src: string | null | undefined, image: HTMLImageElement) {
  if (!src || !image.naturalWidth || !image.naturalHeight) return
  photoRatios.set(src, image.naturalWidth / image.naturalHeight)
}
