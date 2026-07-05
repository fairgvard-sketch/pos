import { useNavigate } from 'react-router-dom'
import { useLangStore } from '../../store/langStore'
import AttendanceTab from '../analytics/AttendanceTab'

export default function AttendancePage() {
  const navigate = useNavigate()
  const lang = useLangStore((s) => s.lang)
  const isRu = lang === 'ru'

  return (
    <div className="min-h-screen bg-[#f8f9fb]">
      <header className="bg-white border-b border-gray-100 h-14 px-6 flex items-center gap-3 sticky top-0 z-10">
        <button
          onClick={() => navigate('/hub')}
          className="w-8 h-8 rounded-xl hover:bg-gray-100 flex items-center justify-center text-gray-500 hover:text-gray-900 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <span className="font-bold text-gray-900">
          {isRu ? 'Табель' : 'שעון נוכחות'}
        </span>
      </header>

      <div className="p-6">
        <AttendanceTab />
      </div>
    </div>
  )
}
