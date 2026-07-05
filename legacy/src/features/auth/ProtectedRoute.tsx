import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import type { StaffRole } from '../../types'

interface Props {
  children: React.ReactNode
  allowedRoles?: StaffRole[]
}

export default function ProtectedRoute({ children, allowedRoles }: Props) {
  const staff = useAuthStore((s) => s.currentStaff)

  if (!staff) {
    return <Navigate to="/" replace />
  }

  if (allowedRoles && !allowedRoles.includes(staff.role)) {
    const redirect =
      staff.role === 'kitchen' ? '/kitchen'
      : staff.role === 'manager' ? '/hub'
      : '/tables'
    return <Navigate to={redirect} replace />
  }

  return <>{children}</>
}
