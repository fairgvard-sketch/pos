import type { Lang } from './i18n'

/**
 * Язык интерфейса прямо из persist-ключа, без сторов и React. Для экранов,
 * которые обязаны нарисоваться, даже когда приложение упало или не
 * поднялось: проверка движка, аварийный сброс, ошибка маршрута, загрузка.
 * Импорт i18n — только тип: в рантайме модуль ни от чего не зависит.
 */
export function bootLang(): Lang {
  try {
    const raw = localStorage.getItem('kassa-lang')
    if (raw) {
      const v = JSON.parse(raw)?.state?.lang
      if (v === 'he' || v === 'en' || v === 'ru') return v
    }
  } catch { /* localStorage может быть недоступен */ }
  return 'he'
}
