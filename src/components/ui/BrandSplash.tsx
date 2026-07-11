import { useEffect, useState } from 'react'
import logoUrl from '../../assets/logo/logo.png'
import './BrandSplash.css'

/**
 * Сплэш Angle. Хореография (~3 с, затем растворение):
 *  1. знак-стрелка влетает снизу-слева, закладывает мёртвую петлю
 *     (непрерывный оборот -360° вокруг точки над знаком) и приземляется;
 *  2. из-за знака выезжают буквы NGLE — складывается словограмма ANGLE,
 *     короткая выдержка — и экран уходит в fade.
 *
 * По умолчанию исчезает сам после полного проигрыша (старт кассы).
 * Режим загрузки (онлайн-меню): передай done={false}, пока данные не готовы —
 * сплэш держится и растворяется, когда done станет true (но не раньше,
 * чем доиграет анимация). Роутер под сплэшем работает — это перекрытие.
 */
const PLAY_MS = 2500
const FADE_MS = 400

export default function BrandSplash({ done = true }: { done?: boolean }) {
  const [played, setPlayed] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setPlayed(true), PLAY_MS)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!played || !done || gone) return
    setLeaving(true)
    const t = setTimeout(() => setGone(true), FADE_MS)
    return () => clearTimeout(t)
  }, [played, done, gone])

  if (gone) return null

  return (
    <div dir="ltr" aria-hidden="true" className={`brand-splash${leaving ? ' brand-splash--leave' : ''}`}>
      <div className="brand-splash__group">
        <span className="brand-splash__fly">
          <span className="brand-splash__loop">
            <img className="brand-splash__mark" src={logoUrl} alt="" draggable={false} />
          </span>
        </span>
        <span className="brand-splash__clip">
          <span className="brand-splash__text">NGLE</span>
        </span>
      </div>
    </div>
  )
}
