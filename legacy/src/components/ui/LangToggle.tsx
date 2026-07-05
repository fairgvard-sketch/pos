import { useLangStore } from '../../store/langStore'

export default function LangToggle() {
  const { lang, setLang } = useLangStore()

  return (
    <div className="flex rounded-xl overflow-hidden border border-gray-200 bg-gray-50 p-0.5 gap-0.5">
      {(['ru', 'he'] as const).map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all duration-150 ${
            lang === l
              ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
              : 'text-gray-400 hover:text-gray-600'
          }`}
        >
          {l === 'ru' ? 'RU' : 'עב'}
        </button>
      ))}
    </div>
  )
}
