import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchTables, createTable } from '../tables/api'
import { useLangStore } from '../../store/langStore'

export default function RetailPage() {
  const navigate = useNavigate()
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()

  const { data: tables, isLoading } = useQuery({
    queryKey: ['tables'],
    queryFn: fetchTables,
  })

  useEffect(() => {
    if (isLoading || !tables) return

    if (tables.length > 0) {
      navigate(`/order/${tables[0].id}`, { replace: true })
      return
    }

    createTable(1, 1, null).then(() => {
      qc.invalidateQueries({ queryKey: ['tables'] })
    })
  }, [tables, isLoading])

  return (
    <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center">
      <p className="text-gray-400 text-sm">
        {lang === 'he' ? 'טוען...' : 'Загрузка...'}
      </p>
    </div>
  )
}
