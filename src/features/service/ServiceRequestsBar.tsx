import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { formatElapsed, t, type Lang } from '../../lib/i18n'
import {
  setServiceRequestStatus,
  type ServiceRequest,
  type ServiceRequestKind,
} from './api'

function serviceRequestLabel(lang: Lang, kind: ServiceRequestKind): string {
  const keys: Record<ServiceRequestKind, Parameters<typeof t>[1]> = {
    call_waiter: 'serviceCallWaiter',
    water: 'serviceWater',
    cutlery: 'serviceCutlery',
    napkins: 'serviceNapkins',
    bread: 'serviceBread',
    next_course: 'serviceNextCourse',
    hold_course: 'serviceHoldCourse',
    problem: 'serviceProblem',
    bill: 'serviceBill',
  }
  return t(lang, keys[kind])
}

export default function ServiceRequestsBar({
  lang,
  requests,
}: {
  lang: Lang
  requests: ServiceRequest[]
}) {
  const qc = useQueryClient()
  const [nowTs, setNowTs] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNowTs(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [])

  const mutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'accepted' | 'completed' }) =>
      setServiceRequestStatus(id, status),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: ['service_requests'] })
      const previous = qc.getQueryData<ServiceRequest[]>(['service_requests'])
      qc.setQueryData<ServiceRequest[]>(['service_requests'], (current = []) =>
        status === 'completed'
          ? current.filter((request) => request.id !== id)
          : current.map((request) => request.id === id
            ? { ...request, status: 'accepted', accepted_at: new Date().toISOString() }
            : request),
      )
      return { previous }
    },
    onError: (error, _variables, context) => {
      if (context?.previous) qc.setQueryData(['service_requests'], context.previous)
      toast.error(error.message)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['service_requests'] }),
  })

  if (requests.length === 0) return null

  return (
    <section className="mb-6" aria-labelledby="service-requests-title">
      <div className="mb-3 flex items-center gap-2">
        <h2 id="service-requests-title" className="text-lg font-black text-gray-900">
          {t(lang, 'serviceRequestsTitle')}
        </h2>
        <span className="min-w-6 h-6 px-2 rounded-full bg-gray-900 text-white text-xs font-bold flex items-center justify-center tabular-nums">
          {requests.length}
        </span>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2">
        {requests.map((request) => {
          const accepted = request.status === 'accepted'
          const isPending = mutation.isPending && mutation.variables?.id === request.id
          return (
            <article
              key={request.id}
              className={`min-w-64 rounded-2xl border p-4 ${
                accepted ? 'border-emerald-300 bg-emerald-50' : 'border-amber-300 bg-amber-50'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
                    {t(lang, 'tableLabel')} {request.table_label}
                  </p>
                  <p className="mt-1 text-base font-black text-gray-900 truncate">
                    {serviceRequestLabel(lang, request.kind)}
                  </p>
                </div>
                <span className="text-xs font-bold text-gray-600 tabular-nums whitespace-nowrap">
                  {formatElapsed(request.created_at, nowTs, lang)}
                </span>
              </div>

              <button
                type="button"
                disabled={isPending}
                onClick={() => mutation.mutate({
                  id: request.id,
                  status: accepted ? 'completed' : 'accepted',
                })}
                className={`mt-4 w-full h-11 rounded-xl text-sm font-bold transition-all active:scale-[0.97] disabled:opacity-60 ${
                  accepted ? 'bg-gray-900 text-white' : 'bg-white border border-gray-300 text-gray-900'
                }`}
              >
                {t(lang, accepted ? 'serviceComplete' : 'serviceAccept')}
              </button>
            </article>
          )
        })}
      </div>
    </section>
  )
}
