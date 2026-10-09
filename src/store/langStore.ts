import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { LANGS, type Lang } from '../lib/i18n'

/**
 * Язык интерфейса кассы: иврит (по умолчанию), английский или русский —
 * выбор на экране PIN и в настройках устройства. Печатные чеки и тикеты
 * всегда на иврите независимо от выбора.
 *
 * VITE_ENABLE_INTERNAL_RUSSIAN=true меняет только язык по умолчанию на
 * русский (dev и внутренние стенды); выбор доступен в любой сборке.
 */
export const DEFAULT_LANG: Lang =
  import.meta.env.VITE_ENABLE_INTERNAL_RUSSIAN === 'true' ? 'ru' : 'he'

interface LangState {
  lang: Lang
  setLang: (lang: Lang) => void
}

function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (LANGS as readonly string[]).includes(v)
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
      lang: DEFAULT_LANG,
      setLang: (lang) => {
        if (!isLang(lang)) return
        applyDocLang(lang)
        set({ lang })
      },
    }),
    {
      name: 'kassa-lang',
      onRehydrateStorage: () => (state) => {
        if (!state) return
        // Повреждённое значение в storage — язык по умолчанию
        if (!isLang(state.lang)) {
          state.setLang(DEFAULT_LANG)
          return
        }
        applyDocLang(state.lang)
      },
    }
  )
)
