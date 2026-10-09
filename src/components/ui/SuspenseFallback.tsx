import { useEffect, useState } from 'react'
import { bootLang } from '../../lib/bootLang'

/**
 * Fallback для <Suspense> на lazy-роутах.
 *
 * Раньше стоял `fallback={null}` — расчёт был на то, что чанк приходит из
 * SW-кэша за миллисекунды. Но при холодном первом заходе на менеджерский
 * экран по медленной 4G терминала (T2) чанк тянется секундами, и всё это
 * время экран пустой — кассир не понимает, нажалась ли кнопка.
 *
 * Решение: короткая задержка (быстрый кэш-хит не мигает спиннером), затем
 * ненавязчивый индикатор загрузки. Самодостаточен: язык читаем из
 * persist-ключа напрямую — компонент должен работать без хуков/сторов.
 */
const SHOW_AFTER_MS = 400


export default function SuspenseFallback() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    const id = setTimeout(() => setShow(true), SHOW_AFTER_MS)
    return () => clearTimeout(id)
  }, [])

  if (!show) return null

  const lang = bootLang()
  const isRtl = lang === 'he'
  const label = { he: 'טוען…', en: 'Loading…', ru: 'Загрузка…' }[lang]

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      role="status"
      aria-live="polite"
      className="h-screen bg-[#eceef1] flex flex-col items-center justify-center gap-4"
    >
      <span
        className="h-9 w-9 rounded-full border-[3px] border-gray-300 border-t-gray-900 animate-spin"
        aria-hidden="true"
      />
      <span className="text-sm text-gray-500">{label}</span>
    </div>
  )
}
