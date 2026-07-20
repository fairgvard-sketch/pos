import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchCurrentShift, fetchShiftReport, closeShift, addCashMovement, fetchShiftMovements, type CloseResult } from './api'
import { fetchOnShiftStaff, clockOutStaff } from '../timesheet/api'
import { fetchCurrentLocation } from '../auth/api'
import { landingRoute } from '../auth/landing'
import { useCloseReminder } from './reminder'
import { useShiftOverdue } from './overdue'
import { renderZReportCanvas, type ZReportData } from '../receipt/printCanvas'
import { hasSilentPrintPath } from '../../lib/escpos'
import { printCanvasWithRetry } from '../receipt/printFailure'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
import { t, formatTime } from '../../lib/i18n'
import { payMethodLabel, receiptMethodLabel, type PayMethodId } from '../../lib/payMethods'
import { can } from '../../lib/perms'
import { useOutboxStore, pendingOpsCount } from '../../lib/offline/outboxStore'
import { useNetStore } from '../../lib/offline/net'
import { formatMoney, parseMoney } from '../../lib/money'
import AppSidebar from '../../components/AppSidebar'
import BackButton from '../../components/BackButton'
import LoadErrorState from '../../components/LoadErrorState'
import { failedNoCache } from '../../lib/queryState'
import WasteSheet from './WasteSheet'
import type { Location } from '../../types'

/** Данные печатного דו"ח Z из результата close_shift (поля 037 с фолбэками) */
function toZReportData(res: CloseResult, openedAt: string | undefined, staffName: string | null, note: string): ZReportData {
  return {
    zNumber: res.z_number ?? null,
    openedAt: res.opened_at ?? openedAt ?? null,
    closedAt: res.closed_at ?? new Date().toISOString(),
    staffName,
    ordersCount: res.orders_count,
    grossCash: res.gross_cash ?? res.cash_sales,
    grossCard: res.gross_card ?? res.card_sales,
    // Кошельки (046): всё, что не cash/card, отдельными строками Z
    grossWallets: Object.entries(res.method_gross ?? {})
      .filter(([m]) => m !== 'cash' && m !== 'card')
      .map(([method, amount]) => ({ method, amount })),
    refundsTotal: res.refunds_total ?? 0,
    netTotal: res.total_sales,
    vatTotal: res.vat_total ?? null,
    tipsTotal: res.tips_total,
    openingFloat: res.opening_float ?? null,
    cashIn: res.cash_in ?? 0,
    cashOut: res.cash_out ?? 0,
    expectedCash: res.expected_cash,
    countedCash: res.counted_cash,
    cashDiff: res.cash_diff,
    note: note || null,
  }
}

export default function ShiftPage() {
  const navigate = useNavigate()
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const staff = useAuthStore((s) => s.staff)
  const qc = useQueryClient()

  const shiftQ = useQuery({ queryKey: ['current_shift'], queryFn: fetchCurrentShift })
  const { data: shift } = shiftQ
  const { data: report } = useQuery({
    queryKey: ['shift_report', shift?.id],
    queryFn: () => fetchShiftReport(shift!.id),
    enabled: !!shift,
    refetchInterval: 15_000,
  })
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const backRoute = landingRoute(location?.service_mode)

  // Настройки точки: право закрытия, напоминание, порог наличных
  const canCloseShift = can(staff?.role, 'close_shift', location?.settings)
  // Офлайн (фаза 7): закрытие смены заблокировано, пока очередь не пуста
  const outboxOps = useOutboxStore((s) => s.ops)
  const pendingOps = pendingOpsCount({ ops: outboxOps })
  const online = useNetStore((s) => s.online)
  const remindClose = useCloseReminder(shift?.opened_at, location?.settings?.shift?.close_reminder)
  const overdue = useShiftOverdue(shift?.opened_at, location?.settings?.shift?.day_cutoff)
  const cashWarnAt = location?.settings?.shift?.cash_warn_threshold ?? null
  const tooMuchCash = report != null && cashWarnAt != null && cashWarnAt > 0 && report.expected_cash > cashWarnAt

  // ── Движение наличных (038): внесение/изъятие в течение смены ──
  const canCashMove = can(staff?.role, 'cash_movement', location?.settings)
  const [movementType, setMovementType] = useState<'in' | 'out' | null>(null)
  // Списание дня (047): онлайн-only — add_waste не идемпотентен
  const [showWaste, setShowWaste] = useState(false)
  const { data: movements = [] } = useQuery({
    queryKey: ['cash_movements', shift?.id],
    queryFn: () => fetchShiftMovements(shift!.id),
    enabled: !!shift,
  })
  const addMovement = useMutation({
    mutationFn: (v: { type: 'in' | 'out'; amount: number; reason: string }) =>
      addCashMovement(shift!.id, staff!.id, v.type, v.amount, v.reason),
    onSuccess: () => {
      setMovementType(null)
      toast.success(t(lang, 'cashMoveAdded'))
      qc.invalidateQueries({ queryKey: ['shift_report', shift?.id] })
      qc.invalidateQueries({ queryKey: ['cash_movements', shift?.id] })
    },
    onError: (e) => toast.error(e.message),
  })

  const [closing, setClosing] = useState(false)
  const [countedStr, setCountedStr] = useState('')
  const [note, setNote] = useState('')
  const [result, setResult] = useState<CloseResult | null>(null)
  // Данные печатного Z-отчёта — снимаются в момент закрытия (после
  // закрытия current_shift обнуляется, opened_at оттуда уже не взять)
  const [zData, setZData] = useState<ZReportData | null>(null)
  const printMode = useDeviceStore((s) => s.printMode)
  // Диалог подтверждения закрытия (заменяет window.confirm — тот не работает
  // в APK-обёртке Sunmi). Внутри — проверка, кто на смене в табеле.
  const [confirmOpen, setConfirmOpen] = useState(false)

  const close = useMutation({
    mutationFn: async (staffToClockOut: string[]) => {
      const counted = parseMoney(countedStr || '0')
      if (counted === null) throw new Error(t(lang, 'countedCash'))
      // Сначала снимаем выбранных сотрудников с табеля, затем закрываем смену
      for (const id of staffToClockOut) {
        await clockOutStaff(id).catch(() => {})
      }
      return closeShift(shift!.id, staff!.id, counted, note)
    },
    onSuccess: (res) => {
      const z = toZReportData(res, shift?.opened_at, staff?.name ?? null, note)
      setResult(res)
      setZData(z)
      setClosing(false)
      setConfirmOpen(false)
      // Кэш смены обновляем ДО попытки печати: сбой печати не должен
      // оставить в кэше «открытую» смену (инцидент 20.07 — вечный
      // «shift already closed» при повторном закрытии)
      qc.invalidateQueries({ queryKey: ['current_shift'] })
      qc.invalidateQueries({ queryKey: ['timesheet'] })
      // דו"ח Z печатается при закрытии автоматически (тихие пути:
      // мост APK / RawBT); в браузерном режиме — кнопкой на экране итога
      const allowRawbt = printMode === 'rawbt'
      if (hasSilentPrintPath(allowRawbt)) {
        void printCanvasWithRetry(() => renderZReportCanvas(z, location), allowRawbt)
      }
    },
    onError: (e) => {
      // Смена уже закрыта на сервере (другое устройство или потерянный ответ
      // прошлой попытки): деньги посчитаны, Z-отчёт есть — не тупик, а
      // устаревший экран. Обновляем состояние и говорим честно.
      if (e.message.includes('shift already closed') || e.message.includes('shift not found')) {
        setClosing(false)
        setConfirmOpen(false)
        qc.invalidateQueries({ queryKey: ['current_shift'] })
        toast.error(t(lang, 'shiftAlreadyClosedToast'))
        return
      }
      toast.error(
        e.message.includes('open orders') ? t(lang, 'closeShiftOpenOrders') : e.message
      )
    },
  })

  // Нажали «Закрыть смену» в форме → открываем диалог (сам подтянет табель)
  function requestClose() {
    if (!countedStr.trim()) return
    setConfirmOpen(true)
  }

  if (!staff) return null

  // Печать דו"ח Z с экрана итога: мост APK → RawBT → браузерный диалог
  async function printZ() {
    if (!zData) return
    const allowRawbt = printMode === 'rawbt'
    if (hasSilentPrintPath(allowRawbt)) {
      await printCanvasWithRetry(() => renderZReportCanvas(zData, location), allowRawbt)
      return
    }
    window.print()
  }

  // Экран итога после закрытия
  if (result) {
    const diff = result.cash_diff
    return (
      <Shell isRtl={isRtl} onBack={() => navigate(backRoute)}>
        <div className="max-w-md mx-auto w-full">
          <div className="text-center mb-6">
            <div className="text-4xl mb-2">✓</div>
            <h1 className="text-xl font-black text-gray-900">{t(lang, 'shiftClosed')}</h1>
            {result.z_number != null && (
              <p className="text-sm text-gray-500 mt-1">{t(lang, 'zReport')} №{result.z_number}</p>
            )}
          </div>
          <div className="card p-5 space-y-1">
            <Row label={t(lang, 'zReport')} bold />
            <Line label={t(lang, 'ordersCount')} value={String(result.orders_count)} />
            <Line label={t(lang, 'cashSales')} value={formatMoney(result.gross_cash ?? result.cash_sales, lang)} />
            <Line label={t(lang, 'cardSales')} value={formatMoney(result.gross_card ?? result.card_sales, lang)} />
            {Object.entries(result.method_gross ?? {})
              .filter(([m]) => m !== 'cash' && m !== 'card')
              .map(([m, amount]) => (
                <Line key={m} label={payMethodLabel(lang, m as PayMethodId)} value={formatMoney(amount, lang)} />
              ))}
            {(result.refunds_total ?? 0) > 0 && (
              <Line label={t(lang, 'refundsTotal')} value={`−${formatMoney(result.refunds_total!, lang)}`} />
            )}
            <Line label={t(lang, 'totalSales')} value={formatMoney(result.total_sales, lang)} bold />
            {result.vat_total != null && (
              <Line label={t(lang, 'vatOfSales')} value={formatMoney(result.vat_total, lang)} />
            )}
            {result.tips_total > 0 && (
              <Line label={t(lang, 'tipsTotal')} value={formatMoney(result.tips_total, lang)} />
            )}
            <div className="divider my-2" />
            {(result.cash_in ?? 0) > 0 && (
              <Line label={t(lang, 'cashInLabel')} value={`+${formatMoney(result.cash_in!, lang)}`} />
            )}
            {(result.cash_out ?? 0) > 0 && (
              <Line label={t(lang, 'cashOutLabel')} value={`−${formatMoney(result.cash_out!, lang)}`} />
            )}
            <Line label={t(lang, 'expectedCash')} value={formatMoney(result.expected_cash, lang)} />
            <Line label={t(lang, 'countedCash')} value={formatMoney(result.counted_cash, lang)} />
            <Line
              label={diff === 0 ? t(lang, 'exactMatch') : diff < 0 ? t(lang, 'shortage') : t(lang, 'surplus')}
              value={formatMoney(Math.abs(diff), lang)}
              tone={diff === 0 ? 'ok' : 'warn'}
              bold
            />
          </div>
          <div className="grid grid-cols-2 gap-2 mt-5">
            <button onClick={printZ} className="btn-secondary !rounded-2xl">
              {t(lang, 'printZReport')}
            </button>
            <button onClick={() => navigate(backRoute)} className="btn-primary !rounded-2xl">
              {t(lang, 'back')}
            </button>
          </div>
        </div>
        {/* Печатная версия דו"ח Z для браузерного диалога: на экране спрятана
            за пределами вьюпорта, @media print показывает только её */}
        {zData && <ZReportPrintBody z={zData} location={location} />}
      </Shell>
    )
  }

  // Состояние смены не загрузилось и кэша нет: страница без данных выглядит
  // как «смены нет» — честная ошибка вместо пустых карточек (P1-7)
  if (failedNoCache(shiftQ)) {
    return (
      <Shell isRtl={isRtl} onBack={() => navigate(backRoute)}>
        <div className="pt-24">
          <LoadErrorState
            title={t(lang, 'shiftLoadError')}
            hint={t(lang, 'shiftLoadErrorHint')}
            onRetry={() => { void shiftQ.refetch() }}
          />
        </div>
      </Shell>
    )
  }

  return (
    <Shell isRtl={isRtl} onBack={() => navigate(backRoute)}>
      <div className="max-w-md mx-auto w-full">
        <h1 className="text-2xl font-black text-gray-900 mb-1">{t(lang, 'shift')}</h1>
        {shift && (
          <p className="text-sm text-gray-500 mb-5">
            {t(lang, 'openedAt')}: {new Date(shift.opened_at).toLocaleString(lang === 'he' ? 'he-IL' : 'ru-RU')}
          </p>
        )}

        {/* Просроченная смена: пересекла границу операционного дня — просим
            менеджера пересчитать кассу и закрыть смену (P1, overdue) */}
        {overdue.daysCrossed >= 1 && (
          <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-3 mb-3">
            <p className="text-sm font-bold text-red-700">
              {t(lang, 'shiftOverdueBanner')
                .replace('{days}', String(overdue.daysCrossed))
                .replace('{hours}', String(overdue.hours))}
            </p>
            <p className="text-sm text-red-700 mt-0.5">{t(lang, 'shiftOverdueAction')}</p>
          </div>
        )}

        {/* Баннеры: пора закрывать / много наличных (настройки точки «Смена») */}
        {remindClose && (
          <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 mb-3 text-sm font-semibold text-amber-800">
            {t(lang, 'closeReminderBanner')}
          </div>
        )}
        {tooMuchCash && (
          <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 mb-3 text-sm font-semibold text-amber-800">
            {t(lang, 'cashWarnBanner')} · {formatMoney(report!.expected_cash, lang)}
          </div>
        )}

        {/* Табель — вход отсюда (из сайдбара пункт убран: приход/уход — часть смены) */}
        <button
          onClick={() => navigate('/timesheet')}
          className="w-full mb-5 min-h-[52px] px-4 rounded-2xl border border-gray-100 bg-white
                     flex items-center gap-3 text-start hover:bg-gray-50 transition-colors"
        >
          <span className="flex-1 text-sm font-semibold text-gray-900">{t(lang, 'timesheet')}</span>
          <svg className="w-4 h-4 text-gray-400 shrink-0 rtl:-scale-x-100" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {/* X-отчёт (живой) */}
        {report && (
          <div className="card p-5 space-y-1 mb-5">
            <Row label={t(lang, 'xReport')} bold />
            <Line label={t(lang, 'ordersCount')} value={String(report.orders_count)} />
            <Line label={t(lang, 'cashSales')} value={formatMoney(report.cash_sales, lang)} />
            <Line label={t(lang, 'cardSales')} value={formatMoney(report.card_sales, lang)} />
            {Object.entries(report.method_sales ?? {})
              .filter(([m]) => m !== 'cash' && m !== 'card')
              .map(([m, amount]) => (
                <Line key={m} label={payMethodLabel(lang, m as PayMethodId)} value={formatMoney(amount, lang)} />
              ))}
            <Line label={t(lang, 'totalSales')} value={formatMoney(report.total_sales, lang)} bold />
            {report.tips_total > 0 && (
              <Line label={t(lang, 'tipsTotal')} value={formatMoney(report.tips_total, lang)} />
            )}
            <div className="divider my-2" />
            <Line label={t(lang, 'openingFloat')} value={formatMoney(report.opening_float, lang)} />
            {(report.cash_in ?? 0) > 0 && (
              <Line label={t(lang, 'cashInLabel')} value={`+${formatMoney(report.cash_in!, lang)}`} />
            )}
            {(report.cash_out ?? 0) > 0 && (
              <Line label={t(lang, 'cashOutLabel')} value={`−${formatMoney(report.cash_out!, lang)}`} />
            )}
            <Line label={t(lang, 'expectedCash')} value={formatMoney(report.expected_cash, lang)} bold />
          </div>
        )}

        {/* Внесение/изъятие наличных (038) */}
        {shift && (
          <div className="mb-5">
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => {
                  if (!canCashMove) { toast.error(t(lang, 'permManagerToast')); return }
                  // add_cash_movement не идемпотентен — без сети недоступен
                  if (!online) { toast.error(t(lang, 'offlineBlockedHint')); return }
                  setMovementType('in')
                }}
                className={`btn-secondary !rounded-2xl ${canCashMove && online ? '' : '!opacity-40'}`}
              >
                {t(lang, 'cashInBtn')}
              </button>
              <button
                onClick={() => {
                  if (!canCashMove) { toast.error(t(lang, 'permManagerToast')); return }
                  if (!online) { toast.error(t(lang, 'offlineBlockedHint')); return }
                  setMovementType('out')
                }}
                className={`btn-secondary !rounded-2xl ${canCashMove && online ? '' : '!opacity-40'}`}
              >
                {t(lang, 'cashOutBtn')}
              </button>
            </div>

            {/* Списание дня (047): сколько выбросили — остатки и отчёт потерь.
                Скрыто, если учёт остатков выключен тумблером точки */}
            {location?.settings?.interface?.inventory_enabled !== false && (
              <button
                onClick={() => {
                  if (!online) { toast.error(t(lang, 'offlineBlockedHint')); return }
                  setShowWaste(true)
                }}
                className={`btn-secondary w-full !rounded-2xl mt-2 ${online ? '' : '!opacity-40'}`}
              >
                {t(lang, 'wasteDayBtn')}
              </button>
            )}

            {movements.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {movements.map((m) => (
                  <div
                    key={m.id}
                    className="px-4 py-2.5 rounded-xl border border-gray-100 bg-white flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-gray-900 truncate">
                        {m.reason || t(lang, m.type === 'in' ? 'cashInLabel' : 'cashOutLabel')}
                      </div>
                      <div className="text-xs text-gray-500 tabular-nums">
                        {formatTime(m.created_at, lang)}
                        {m.staff?.name && ` · ${m.staff.name}`}
                      </div>
                    </div>
                    <span className={`shrink-0 text-sm font-bold tabular-nums ${m.type === 'in' ? 'text-emerald-600' : 'text-gray-900'}`}>
                      {m.type === 'in' ? '+' : '−'}{formatMoney(m.amount, lang)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Блок закрытия — только при открытой смене: после рефетча
            current_shift → null кнопка для несуществующей смены не рисуется */}
        {shift && (!closing ? (
          <button
            onClick={() => {
              if (!canCloseShift) { toast.error(t(lang, 'permManagerToast')); return }
              // Офлайн-очередь не пуста: replay-платежи должны упасть в ЭТУ
              // смену (иначе — 'no open shift' и ручной разбор). Сначала синк.
              if (pendingOps > 0) { toast.error(`${t(lang, 'offlineCloseShiftBlocked')} (${pendingOps})`); return }
              if (!online) { toast.error(t(lang, 'offlineBlockedHint')); return }
              setClosing(true)
            }}
            className={`btn-danger w-full !rounded-2xl ${canCloseShift && online && pendingOps === 0 ? '' : '!opacity-40'}`}
          >
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
              <p className="text-[11px] text-gray-500 mt-1.5">{t(lang, 'countCashHint')}</p>
            </div>
            <input
              className="input"
              placeholder={t(lang, 'closeNote')}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                onClick={requestClose}
                disabled={close.isPending || !countedStr.trim()}
                className="btn-danger flex-1 !rounded-2xl"
              >
                {t(lang, 'closeShift')}
              </button>
              <button onClick={() => setClosing(false)} className="btn-secondary">{t(lang, 'cancel')}</button>
            </div>
          </div>
        ))}
      </div>

      {confirmOpen && (
        <CloseShiftDialog
          lang={lang}
          isRtl={isRtl}
          busy={close.isPending}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={(ids) => close.mutate(ids)}
        />
      )}

      {movementType && (
        <CashMovementDialog
          lang={lang}
          isRtl={isRtl}
          type={movementType}
          busy={addMovement.isPending}
          onCancel={() => setMovementType(null)}
          onConfirm={(amount, reason) => addMovement.mutate({ type: movementType, amount, reason })}
        />
      )}

      {showWaste && <WasteSheet onClose={() => setShowWaste(false)} />}
    </Shell>
  )
}

/** Модалка внесения/изъятия наличных: сумма + причина (своя, не window.confirm — APK) */
function CashMovementDialog({
  lang, isRtl, type, busy, onCancel, onConfirm,
}: {
  lang: 'ru' | 'he'
  isRtl: boolean
  type: 'in' | 'out'
  busy: boolean
  onCancel: () => void
  onConfirm: (amount: number, reason: string) => void
}) {
  const [amountStr, setAmountStr] = useState('')
  const [reason, setReason] = useState('')
  const amount = parseMoney(amountStr)
  const valid = amount !== null && amount > 0

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <form
        onSubmit={(e) => { e.preventDefault(); if (valid) onConfirm(amount!, reason.trim()) }}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 animate-[rise-in_0.2s_ease-out]"
      >
        <h2 className="text-lg font-black text-gray-900 mb-1">
          {t(lang, type === 'in' ? 'cashInBtn' : 'cashOutBtn')}
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          {t(lang, type === 'in' ? 'cashInHint' : 'cashOutHint')}
        </p>

        <label className="text-xs font-medium text-gray-500 mb-1 block">{t(lang, 'cashMoveAmount')}</label>
        <div className="relative mb-3">
          <input
            className="input tabular-nums text-lg pe-8"
            inputMode="decimal"
            autoFocus
            placeholder="0"
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
          />
          <span className="absolute end-3 top-1/2 -translate-y-1/2 text-gray-500">₪</span>
        </div>

        <input
          className="input mb-5"
          placeholder={t(lang, 'cashMoveReason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />

        <div className="flex gap-2">
          <button type="submit" disabled={!valid || busy} className="btn-primary flex-1 !rounded-2xl">
            {t(lang, type === 'in' ? 'cashInBtn' : 'cashOutBtn')}
          </button>
          <button type="button" onClick={onCancel} disabled={busy} className="btn-secondary">
            {t(lang, 'cancel')}
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * Подтверждение закрытия смены. Своя модалка вместо window.confirm —
 * системный диалог не показывается в WebView-обёртке Sunmi. Если в
 * табеле есть сотрудники на смене, показываем их галочками (по умолчанию
 * все отмечены) и снимаем выбранных с табеля при закрытии.
 */
function CloseShiftDialog({
  lang,
  isRtl,
  busy,
  onCancel,
  onConfirm,
}: {
  lang: 'ru' | 'he'
  isRtl: boolean
  busy: boolean
  onCancel: () => void
  onConfirm: (staffIds: string[]) => void
}) {
  const { data: onShift, isLoading } = useQuery({
    queryKey: ['on_shift_staff'],
    queryFn: fetchOnShiftStaff,
  })
  // По умолчанию отмечаем всех, кто на смене
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const initialized = useRef(false)
  useEffect(() => {
    if (onShift && !initialized.current) {
      initialized.current = true
      setPicked(new Set(onShift.map((s) => s.staff_id)))
    }
  }, [onShift])

  const locale = lang === 'he' ? 'he-IL' : 'ru-RU'
  const hasStaff = (onShift?.length ?? 0) > 0

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 animate-[rise-in_0.2s_ease-out]">
        <h2 className="text-lg font-black text-gray-900 mb-2">{t(lang, 'closeShiftTitle')}</h2>

        {isLoading ? (
          <p className="text-center text-gray-400 py-6">…</p>
        ) : (
          <>
            <p className="text-sm text-gray-500 mb-4">
              {hasStaff ? t(lang, 'closeShiftStaffOnShift') : t(lang, 'confirmClose')}
            </p>

            {hasStaff && (
              <>
                <div className="text-xs font-semibold text-gray-500 mb-2">{t(lang, 'closeShiftPickStaff')}</div>
                <div className="space-y-2 mb-5 max-h-64 overflow-y-auto">
                  {onShift!.map((s) => {
                    const on = picked.has(s.staff_id)
                    return (
                      <button
                        key={s.staff_id}
                        onClick={() => toggle(s.staff_id)}
                        className={`w-full flex items-center gap-3 rounded-2xl border p-3 text-start transition-all min-h-[52px] ${
                          on ? 'border-gray-900 bg-gray-50' : 'border-gray-200'
                        }`}
                      >
                        <span
                          className={`w-6 h-6 rounded-md border-2 flex items-center justify-center shrink-0 ${
                            on ? 'bg-gray-900 border-gray-900 text-white' : 'border-gray-300'
                          }`}
                        >
                          {on && '✓'}
                        </span>
                        <span className="flex-1 min-w-0 flex items-baseline justify-between gap-2">
                          <span className="font-bold text-gray-900 truncate">{s.staff_name}</span>
                          <span className="text-xs text-gray-500 tabular-nums shrink-0" dir="ltr">
                            {t(lang, 'sinceShort')} {new Date(s.clock_in).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => onConfirm(Array.from(picked))}
                disabled={busy}
                className="btn-danger flex-1 !rounded-2xl"
              >
                {hasStaff && picked.size > 0 ? t(lang, 'closeAndClockOut') : t(lang, 'closeShiftOnly')}
              </button>
              <button onClick={onCancel} disabled={busy} className="btn-secondary">
                {t(lang, 'cancel')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Shell({ isRtl, onBack, children }: { isRtl: boolean; onBack: () => void; children: React.ReactNode }) {
  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="shift" />
      <main className="flex-1 bg-white rounded-3xl overflow-y-auto p-6">
        <BackButton onClick={onBack} className="mb-4" />
        {children}
      </main>
    </div>
  )
}

/**
 * Печатная версия דו"ח Z (иврит/RTL, как чек) для браузерного пути печати.
 * На экране уводится за вьюпорт; @media print (index.css) показывает
 * только .receipt-print и позиционирует её в 0,0.
 */
function ZReportPrintBody({ z, location }: { z: ZReportData; location: Location | undefined }) {
  const fmt = (agorot: number) => (agorot / 100).toFixed(2)
  const dt = (iso: string) => {
    const d = new Date(iso)
    return `${d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })} ${d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' })}`
  }
  const businessName = location?.receipt_business_name || location?.name || ''

  return (
    <div dir="rtl" className="receipt-print fixed start-[-9999px] top-0 w-[300px] font-mono text-[13px] text-gray-900 leading-snug bg-white">
      <div className="text-center mb-2">
        <div className="font-bold text-base">{businessName}</div>
        {location?.receipt_address && <div className="text-xs">{location.receipt_address}</div>}
        {location?.receipt_phone && <div className="text-xs">טל׳: {location.receipt_phone}</div>}
        {location?.receipt_tax_id && <div className="text-xs">ע.מ/ח.פ: {location.receipt_tax_id}</div>}
      </div>

      <div className="text-center font-bold text-sm">דו"ח Z מס' {z.zNumber ?? '—'}</div>
      <div className="text-center text-xs mb-1">סגירת משמרת</div>
      <ZDivider />

      {z.openedAt && <ZRow label="נפתחה:" value={dt(z.openedAt)} />}
      <ZRow label="נסגרה:" value={dt(z.closedAt ?? new Date().toISOString())} />
      {z.staffName && <ZRow label='נסגרה ע"י:' value={z.staffName} />}
      <ZRow label="עסקאות:" value={String(z.ordersCount)} />
      <ZDivider />

      <ZRow label="מכירות מזומן" value={fmt(z.grossCash)} />
      <ZRow label="מכירות אשראי" value={fmt(z.grossCard)} />
      {z.grossWallets.map((w) => (
        <ZRow key={w.method} label={`מכירות ${receiptMethodLabel(w.method)}`} value={fmt(w.amount)} />
      ))}
      <ZRow
        label='סה"כ מכירות'
        value={fmt(z.grossCash + z.grossCard + z.grossWallets.reduce((s, w) => s + w.amount, 0))}
        bold
      />
      {z.refundsTotal > 0 && <ZRow label="החזרים" value={`−${fmt(z.refundsTotal)}`} />}
      <ZRow label='סה"כ נטו' value={fmt(z.netTotal)} bold />
      {z.vatTotal != null && <ZRow label='מתוך זה מע"מ' value={fmt(z.vatTotal)} />}
      {z.tipsTotal > 0 && <ZRow label="טיפים" value={fmt(z.tipsTotal)} />}
      <ZDivider />

      {z.openingFloat != null && <ZRow label="עודף פתיחה" value={fmt(z.openingFloat)} />}
      {z.cashIn > 0 && <ZRow label="הפקדות מזומן" value={`+${fmt(z.cashIn)}`} />}
      {z.cashOut > 0 && <ZRow label="משיכות מזומן" value={`−${fmt(z.cashOut)}`} />}
      <ZRow label="מזומן צפוי" value={fmt(z.expectedCash)} />
      <ZRow label="מזומן שנספר" value={fmt(z.countedCash)} />
      <ZRow
        label={z.cashDiff === 0 ? 'התאמה מלאה' : z.cashDiff < 0 ? 'חוסר' : 'עודף'}
        value={z.cashDiff === 0 ? '✓' : `${z.cashDiff < 0 ? '−' : '+'}${fmt(Math.abs(z.cashDiff))}`}
        bold
      />
      {z.note && (
        <>
          <ZDivider />
          <div className="text-center text-xs">{z.note}</div>
        </>
      )}
      <div className="text-center text-xs mt-2">— סוף דו"ח —</div>
    </div>
  )
}

function ZDivider() {
  return <div className="border-t border-dashed border-gray-300 my-2" />
}

function ZRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between text-sm ${bold ? 'font-bold' : ''}`}>
      <span>{label}</span>
      <span className="tabular-nums" dir="ltr">{value}</span>
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
