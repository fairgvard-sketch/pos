import { useLangStore } from '../../store/langStore'
import { LANGS, type Lang } from '../../lib/i18n'

/** Подпись языка на его же языке: человек находит свой, не зная текущего */
const LABELS: Record<Lang, string> = { he: 'עב', en: 'EN', ru: 'RU' }
const NAMES: Record<Lang, string> = { he: 'עברית', en: 'English', ru: 'Русский' }

export default function LangToggle() {
  const { lang, setLang } = useLangStore()

  return (
    <div className="flex rounded-xl overflow-hidden border border-gray-200 bg-gray-50 p-0.5 gap-0.5" dir="ltr">
      {LANGS.map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          aria-label={NAMES[l]}
          aria-pressed={lang === l}
          lang={l}
          className={`min-w-11 min-h-9 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all duration-150 ${
            lang === l
              ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {LABELS[l]}
        </button>
      ))}
    </div>
  )
}
