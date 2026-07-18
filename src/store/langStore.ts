import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Lang } from '../lib/i18n'

/**
 * Коммерческий прод — иврит-only (P3-14): русский интерфейс — внутренний
 * инструмент и существует только в сборке с VITE_ENABLE_INTERNAL_RUSSIAN=true
 * (dev / внутренние стенды). Без флага переключатель скрыт (LangToggle),
 * дефолт и принудительный язык — he, persisted 'ru' от старых сборок
 * приводится к 'he' при гидрации.
 */
export const RUSSIAN_UI_ENABLED = import.meta.env.VITE_ENABLE_INTERNAL_RUSSIAN === 'true'

interface LangState {
  lang: Lang
  setLang: (lang: Lang) => void
}

/**
 * <html lang> обязан следовать выбранному языку: прод-сборка (legacy-таргет
 * Chrome 52) компилирует логические свойства (ms-, me-, start, end) в
 * left/right через селектор :lang(he) — при захардкоженном lang="ru"
 * RTL-раскладка в иврите молча ломается (в dev-сборке не воспроизводится).
 */
function applyDocLang(lang: Lang) {
  document.documentElement.lang = lang
  document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr'
}

export const useLangStore = create<LangState>()(
  persist(
    (set) => ({
      lang: RUSSIAN_UI_ENABLED ? 'ru' : 'he',
      setLang: (lang) => {
        if (!RUSSIAN_UI_ENABLED && lang !== 'he') return
        applyDocLang(lang)
        set({ lang })
      },
    }),
    {
      name: 'kassa-lang',
      onRehydrateStorage: () => (state) => {
        if (!state) return
        if (!RUSSIAN_UI_ENABLED && state.lang !== 'he') {
          // Устаревший persisted 'ru': setLang('he') проходит guard и
          // перезаписывает storage, чтобы приведение не повторялось
          state.setLang('he')
          return
        }
        applyDocLang(state.lang)
      },
    }
  )
)
