import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Lang } from '../lib/i18n'
import { t } from '../lib/i18n'
import { fetchPrintStatus } from './api'
import { jobOpen, jobStuck, useWaiterDrafts, useWaiterSession, type TrackedJob } from './store'

/** Опрос статуса тикетов, пока касса не отчиталась (печать на T2) */
export function useTicketTracking(): number {
  const token = useWaiterSession((s) => s.session?.token)
  const jobs = useWaiterDrafts((s) => s.jobs)
  const openIds = jobs.filter(jobOpen).map((j) => j.id)
  // Часы для «касса не печатает»: зависание видно и без ответа сервера
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (openIds.length === 0) return
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [openIds.length])

  useQuery({
    queryKey: ['w_jobs', openIds.join(',')],
    queryFn: async () => {
      const rows = await fetchPrintStatus(token!, openIds)
      useWaiterDrafts.getState().updateJobs(rows)
      return rows
    },
    enabled: !!token && openIds.length > 0,
    refetchInterval: 3000,
  })
  return now
}

export type TicketTone = 'ok' | 'wait' | 'bad'

export function ticketState(j: TrackedJob, lang: Lang, now: number): { text: string; tone: TicketTone } {
  if (j.status === 'printed') return { text: t(lang, 'wTicketPrinted'), tone: 'ok' }
  if (j.status === 'failed' || j.status === 'expired') return { text: t(lang, 'wTicketFailed'), tone: 'bad' }
  if (jobStuck(j, now)) return { text: t(lang, 'wTicketStuck'), tone: 'bad' }
  if (j.status === 'printing') return { text: t(lang, 'wTicketPrinting'), tone: 'wait' }
  return { text: t(lang, 'wTicketWaiting'), tone: 'wait' }
}

/** Тикеты, о которых кухне надо сказать голосом */
export function problemJobs(jobs: TrackedJob[], now: number): TrackedJob[] {
  return jobs.filter((j) => j.status === 'failed' || j.status === 'expired' || jobStuck(j, now))
}
