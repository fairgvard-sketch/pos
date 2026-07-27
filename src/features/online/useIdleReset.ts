import { useEffect, useRef, useState } from 'react'

/**
 * Киоск-режим гостевого меню: планшет на столе не должен хранить чужой
 * заказ. Минута без касаний → «вы ещё здесь?» → 20 секунд на ответ →
 * возврат на главный экран с очисткой корзины.
 *
 * Почему именно так:
 *   • отсчёт сбрасывает любой ввод, включая скролл — гость, который просто
 *     читает состав, не увидит вопроса;
 *   • пока вкладка скрыта, таймеры не тикают: телефон в кармане не должен
 *     «протухать» и сбрасывать корзину, пока гость идёт к стойке;
 *   • на ответ даётся отдельные 20 секунд, и обратный отсчёт виден —
 *     диалог не появляется молча и не исчезает внезапно.
 */

/** Бездействие до вопроса */
const IDLE_MS = 60_000
/** Сколько ждём ответа на «вы ещё здесь?» */
export const CONFIRM_SEC = 20

/** События, любое из которых означает «гость здесь» */
const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const

export function useIdleReset(enabled: boolean, onReset: () => void) {
  /** null — вопрос не показан; число — сколько секунд осталось */
  const [countdown, setCountdown] = useState<number | null>(null)

  // Через ref, чтобы пересоздание колбэка родителем не перезапускало таймеры
  const onResetRef = useRef(onReset)
  useEffect(() => {
    onResetRef.current = onReset
  })

  /** Перезапуск отсчёта изнутри эффекта — нужен кнопке «я здесь» */
  const restartRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!enabled) return

    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let tick: ReturnType<typeof setInterval> | undefined

    const clearAll = () => {
      if (idleTimer) clearTimeout(idleTimer)
      if (tick) clearInterval(tick)
      idleTimer = undefined
      tick = undefined
    }

    /** Возврат к отсчёту бездействия: и при старте, и после «я здесь» */
    const restart = () => {
      clearAll()
      setCountdown(null)
      idleTimer = setTimeout(() => {
        setCountdown(CONFIRM_SEC)
        let left = CONFIRM_SEC
        tick = setInterval(() => {
          left -= 1
          if (left <= 0) {
            clearAll()
            setCountdown(null)
            onResetRef.current()
            return
          }
          setCountdown(left)
        }, 1000)
      }, IDLE_MS)
    }

    /** Активность гостя. Во время вопроса не считается: там явная кнопка,
     *  иначе случайный скролл под диалогом молча снимал бы вопрос. */
    const onActivity = () => {
      setCountdown((current) => {
        if (current === null) restart()
        return current
      })
    }

    const onVisibility = () => {
      // Вкладка скрыта — гость не может «бездействовать» осмысленно.
      if (document.visibilityState === 'hidden') clearAll()
      else restart()
    }

    restartRef.current = restart
    restart()
    for (const type of ACTIVITY) {
      window.addEventListener(type, onActivity, { passive: true })
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      clearAll()
      // Хук выключили (например, появился активный заказ) — вопрос,
      // если он висел, снимаем вместе с таймерами.
      setCountdown(null)
      for (const type of ACTIVITY) window.removeEventListener(type, onActivity)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled])

  /** «Я здесь» — снимаем вопрос и начинаем отсчёт бездействия заново */
  const stayActive = () => restartRef.current()

  return { countdown, stayActive }
}
