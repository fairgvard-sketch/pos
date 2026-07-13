import { useEffect, useState } from 'react'

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

function currentLang(): 'ru' | 'he' {
  try {
    const raw = localStorage.getItem('kassa-lang')
    if (raw) {
      const v = JSON.parse(raw)?.state?.lang
      if (v === 'he' || v === 'ru') return v
    }
  } catch { /* localStorage может быть недоступен */ }
  return 'he'
}

export default function SuspenseFallback() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    const id = setTimeout(() => setShow(true), SHOW_AFTER_MS)
    return () => clearTimeout(id)
  }, [])

  if (!show) return null

  const isRtl = currentLang() === 'he'
  const label = isRtl ? 'טוען…' : 'Загрузка…'

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
