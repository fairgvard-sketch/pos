import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Lang } from '../lib/i18n'

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
}

export const useLangStore = create<LangState>()(
  persist(
    (set) => ({
      lang: 'ru',
      setLang: (lang) => {
        applyDocLang(lang)
        set({ lang })
      },
    }),
    {
      name: 'kassa-lang',
      onRehydrateStorage: () => (state) => {
        if (state) applyDocLang(state.lang)
      },
    }
  )
)
