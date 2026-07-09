import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchCurrentShift, fetchShiftReport, closeShift, type CloseResult } from './api'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney, parseMoney } from '../../lib/money'
import AppSidebar from '../../components/AppSidebar'

export default function ShiftPage() {
  const navigate = useNavigate()
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const staff = useAuthStore((s) => s.staff)
  const qc = useQueryClient()

  const { data: shift } = useQuery({ queryKey: ['current_shift'], queryFn: fetchCurrentShift })
  const { data: report } = useQuery({
    queryKey: ['shift_report', shift?.id],
    queryFn: () => fetchShiftReport(shift!.id),
    enabled: !!shift,
    refetchInterval: 15_000,
  })

  const [closing, setClosing] = useState(false)
  const [countedStr, setCountedStr] = useState('')
  const [note, setNote] = useState('')
  const [result, setResult] = useState<CloseResult | null>(null)

  const close = useMutation({
    mutationFn: () => {
      const counted = parseMoney(countedStr || '0')
      if (counted === null) throw new Error(t(lang, 'countedCash'))
      return closeShift(shift!.id, staff!.id, counted, note)
    },
    onSuccess: (res) => {
      setResult(res)
      setClosing(false)
      qc.invalidateQueries({ queryKey: ['current_shift'] })
    },
    onError: (e) =>
      toast.error(
        e.message.includes('open orders') ? t(lang, 'closeShiftOpenOrders') : e.message
      ),
  })

  if (!staff) return null

  // Экран итога после закрытия
  if (result) {
    const diff = result.cash_diff
    return (
      <Shell isRtl={isRtl} lang={lang} onBack={() => navigate('/home')}>
        <div className="max-w-md mx-auto w-full">
          <div className="text-center mb-6">
            <div className="text-4xl mb-2">✓</div>
            <h1 className="text-xl font-black text-gray-900">{t(lang, 'shiftClosed')}</h1>
          </div>
          <div className="card p-5 space-y-1">
            <Row label={t(lang, 'zReport')} bold />
            <Line label={t(lang, 'cashSales')} value={formatMoney(result.cash_sales, lang)} />
            <Line label={t(lang, 'cardSales')} value={formatMoney(result.card_sales, lang)} />
            <Line label={t(lang, 'totalSales')} value={formatMoney(result.total_sales, lang)} bold />
            {result.tips_total > 0 && (
              <Line label={t(lang, 'tipsTotal')} value={formatMoney(result.tips_total, lang)} />
            )}
            <div className="divider my-2" />
            <Line label={t(lang, 'expectedCash')} value={formatMoney(result.expected_cash, lang)} />
            <Line label={t(lang, 'countedCash')} value={formatMoney(result.counted_cash, lang)} />
            <Line
              label={diff === 0 ? t(lang, 'exactMatch') : diff < 0 ? t(lang, 'shortage') : t(lang, 'surplus')}
              value={formatMoney(Math.abs(diff), lang)}
              tone={diff === 0 ? 'ok' : 'warn'}
              bold
            />
          </div>
          <button onClick={() => navigate('/home')} className="btn-primary w-full mt-5 !rounded-2xl">
            {t(lang, 'back')}
          </button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell isRtl={isRtl} lang={lang} onBack={() => navigate('/home')}>
      <div className="max-w-md mx-auto w-full">
        <h1 className="text-2xl font-black text-gray-900 mb-1">{t(lang, 'shift')}</h1>
        {shift && (
          <p className="text-sm text-gray-400 mb-5">
            {t(lang, 'openedAt')}: {new Date(shift.opened_at).toLocaleString(lang === 'he' ? 'he-IL' : 'ru-RU')}
          </p>
        )}

        {/* X-отчёт (живой) */}
        {report && (
          <div className="card p-5 space-y-1 mb-5">
            <Row label={t(lang, 'xReport')} bold />
            <Line label={t(lang, 'ordersCount')} value={String(report.orders_count)} />
            <Line label={t(lang, 'cashSales')} value={formatMoney(report.cash_sales, lang)} />
            <Line label={t(lang, 'cardSales')} value={formatMoney(report.card_sales, lang)} />
            <Line label={t(lang, 'totalSales')} value={formatMoney(report.total_sales, lang)} bold />
            {report.tips_total > 0 && (
              <Line label={t(lang, 'tipsTotal')} value={formatMoney(report.tips_total, lang)} />
            )}
            <div className="divider my-2" />
            <Line label={t(lang, 'openingFloat')} value={formatMoney(report.opening_float, lang)} />
            <Line label={t(lang, 'expectedCash')} value={formatMoney(report.expected_cash, lang)} bold />
          </div>
        )}

        {!closing ? (
          <button onClick={() => setClosing(true)} className="btn-danger w-full !rounded-2xl">
            {t(lang, 'closeShift')}
          </button>
        ) : (
          <div className="card p-5 space-y-3">
            <div>
              <label className="text-xs font-medium text-gray-500 mb-1 block">{t(lang, 'countedCash')}</label>
              <input
                className="input tabular-nums text-lg"
                inputMode="decimal"
                autoFocus
                placeholder="0"
                value={countedStr}
                onChange={(e) => setCountedStr(e.target.value)}
              />
              <p className="text-[11px] text-gray-400 mt-1.5">{t(lang, 'countCashHint')}</p>
            </div>
            <input
              className="input"
              placeholder={t(lang, 'closeNote')}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                onClick={() => confirm(t(lang, 'confirmClose')) && close.mutate()}
                disabled={close.isPending || !countedStr.trim()}
                className="btn-danger flex-1 !rounded-2xl"
              >
                {t(lang, 'closeShift')}
              </button>
              <button onClick={() => setClosing(false)} className="btn-secondary">{t(lang, 'cancel')}</button>
            </div>
          </div>
        )}
      </div>
    </Shell>
  )
}

function Shell({ isRtl, lang, onBack, children }: { isRtl: boolean; lang: 'ru' | 'he'; onBack: () => void; children: React.ReactNode }) {
  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="shift" />
      <main className="flex-1 bg-white rounded-3xl overflow-y-auto p-6">
        <button onClick={onBack} className="btn-ghost !px-2 -ms-2 mb-4 text-sm">
          {isRtl ? '→' : '←'} {t(lang, 'back')}
        </button>
        {children}
      </main>
    </div>
  )
}

function Row({ label, bold }: { label: string; bold?: boolean }) {
  return <div className={`text-xs uppercase tracking-wide text-gray-400 mb-1 ${bold ? 'font-bold' : ''}`}>{label}</div>
}

function Line({ label, value, bold, tone }: { label: string; value: string; bold?: boolean; tone?: 'ok' | 'warn' }) {
  const color = tone === 'ok' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : 'text-gray-900'
  return (
    <div className="flex justify-between items-baseline py-0.5">
      <span className={`text-sm ${bold ? 'font-bold text-gray-900' : 'text-gray-500'}`}>{label}</span>
      <span className={`tabular-nums ${bold ? 'font-black' : 'font-semibold'} ${color}`}>{value}</span>
    </div>
  )
}
