import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { landingRouteFromCache } from './landing'
import { useAuthStore } from '../../store/authStore'
import type { Role } from '../../types'

interface Props {
  allowedRoles?: Role[]
  children: React.ReactNode
}

/**
 * Двухуровневая защита:
 * 1. Нет сессии устройства → /setup
 * 2. Нет PIN-сессии сотрудника → /pin
 * 3. Роль не подходит → рабочий экран (зал/продажа)
 */
export default function ProtectedRoute({ allowedRoles, children }: Props) {
  const staff = useAuthStore((s) => s.staff)
  const qc = useQueryClient()
  const [deviceState, setDeviceState] = useState<'loading' | 'none' | 'ok'>('loading')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setDeviceState(data.session ? 'ok' : 'none')
    })
  }, [])

  if (deviceState === 'loading') return null
  if (deviceState === 'none') return <Navigate to="/setup" replace />
  if (!staff) return <Navigate to="/pin" replace />
  if (allowedRoles && !allowedRoles.includes(staff.role)) {
    return <Navigate to={landingRouteFromCache(qc)} replace />
  }
  return <>{children}</>
}
