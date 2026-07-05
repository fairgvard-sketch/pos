import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'

export default function HubButton() {
  const navigate = useNavigate()
  const role = useAuthStore((s) => s.currentStaff?.role)

  if (role !== 'manager') return null

  return (
    <button
      onClick={() => navigate('/hub')}
      className="w-8 h-8 rounded-xl hover:bg-gray-100 flex items-center justify-center text-gray-500 hover:text-gray-900 transition-colors"
      title="Главный экран"
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
      </svg>
    </button>
  )
}
