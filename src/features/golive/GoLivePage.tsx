import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchCurrentLocation } from '../auth/api'
import { fetchItems } from '../menu/api'
import { fetchStaffList } from '../settings/api'
import { checkSchemaVersion, MIN_SCHEMA_VERSION } from '../../lib/schemaVersion'
import { goLiveConfirmed, goLiveGaps, GAP_LABELS } from './checks'
import { useLocationSettings } from '../settings/useLocationSettings'
import { hasSilentPrintPath } from '../../lib/escpos'
import { bridgeAvailable } from '../../lib/androidBridge'
import { renderTestPrintCanvas } from '../receipt/printCanvas'
import { printCanvasWithRetry } from '../receipt/printFailure'
import { useAuthStore } from '../../store/authStore'
import { useDeviceStore } from '../../store/deviceStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { payMethodLabel } from '../../lib/payMethods'
import AppSidebar from '../../components/AppSidebar'
import BackButton from '../../components/BackButton'

/**
 * Чек-лист запуска точки (go-live wizard, P3-13): live-проверка готовности
 * перед первой продажей. Критические пробелы (реквизиты чека, каталог)
 * блокируют продажу на SellPage, пока менеджер не закроет их и не подтвердит
 * запуск. Остальные пункты — предупреждения: показываем честно, не блокируем.
 */

type RowStatus = 'ok' | 'fail' | 'warn' | 'pending'

function StatusDot({ status }: { status: RowStatus }) {
  const cls =
    status === 'ok' ? 'bg-emerald-500' :
    status === 'fail' ? 'bg-red-500' :
    status === 'warn' ? 'bg-amber-400' : 'bg-gray-300'
  return <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${cls}`} />
}

function CheckRow({
  status, label, value, hint, action, actionLabel,
}: {
  status: RowStatus
  label: string
  value?: string
  hint?: string
  action?: () => void
  actionLabel?: string
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <StatusDot status={status} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-gray-900">{label}</div>
        {hint && <div className="text-xs text-gray-500 mt-0.5">{hint}</div>}
      </div>
      {value && <div className="text-sm text-gray-500 tabular-nums text-end shrink-0">{value}</div>}
      {action && actionLabel && (
        <button className="btn-secondary !py-1.5 !px-3 text-xs shrink-0" onClick={action}>
          {actionLabel}
        </button>
      )}
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wide px-4 mb-1.5">{title}</h2>
      <div className="rounded-2xl border border-gray-100 bg-white divide-y divide-gray-100">{children}</div>
    </section>
  )
}

export default function GoLivePage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const navigate = useNavigate()
  const staff = useAuthStore((s) => s.staff)
  const printMode = useDeviceStore((s) => s.printMode)
  const tapeWidth = useDeviceStore((s) => s.tapeWidth)
  const payMethodOrder = useDeviceStore((s) => s.payMethodOrder)
  const deviceName = useDeviceStore((s) => s.deviceName)

  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const itemsQ = useQuery({ queryKey: ['menu_items'], queryFn: fetchItems })
  const staffQ = useQuery({ queryKey: ['staff'], queryFn: fetchStaffList })
  const schemaQ = useQuery({ queryKey: ['schema_check'], queryFn: checkSchemaVersion, staleTime: 60_000 })

  const { update, isPending } = useLocationSettings(location)

  const itemsCount = itemsQ.data ? itemsQ.data.length : null
  const activeStaff = staffQ.data?.filter((s) => s.is_active).length ?? null
  const gaps = location ? goLiveGaps(location, itemsCount) : []
  const confirmed = goLiveConfirmed(location)
  const goLive = location?.settings?.go_live

  // Пока location/каталог не приехали — кнопка неактивна (решение по фактам)
  const canConfirm = !!location && itemsCount !== null && gaps.length === 0 && !confirmed

  const bridgePresent = bridgeAvailable()
  const printStatus: RowStatus = bridgePresent ? 'ok' : printMode === 'rawbt' ? 'warn' : 'warn'
  const printValue = bridgePresent
    ? t(lang, 'goLivePrintBridge')
    : printMode === 'rawbt' ? 'RawBT' : t(lang, 'goLivePrintBrowser')

  async function testPrint() {
    const allowRawbt = printMode === 'rawbt'
    if (hasSilentPrintPath(allowRawbt)) {
      const ok = await printCanvasWithRetry(
        () => renderTestPrintCanvas(location?.receipt_business_name || location?.name || '', deviceName),
        allowRawbt,
      )
      if (ok) toast.success(t(lang, 'testPrintSent'))
      return
    }
    toast(t(lang, 'testPrintNoSilent'))
  }

  function confirmLaunch() {
    if (!canConfirm || !staff) return
    update({
      go_live: {
        confirmed_at: new Date().toISOString(),
        confirmed_by: staff.name,
        source: 'wizard',
      },
    })
    toast.success(t(lang, 'goLiveConfirmedToast'))
  }

  function toggleBackupConfirmed() {
    update({
      go_live: { backup_confirmed_at: goLive?.backup_confirmed_at ? null : new Date().toISOString() },
    })
  }

  const vatStatus: RowStatus = location ? 'ok' : 'pending'
  const schemaStatus: RowStatus =
    schemaQ.data?.status === 'ok' ? 'ok' :
    schemaQ.data?.status === 'outdated' ? 'fail' :
    schemaQ.data ? 'warn' : 'pending'

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="settings" />
      <main className="flex-1 bg-white rounded-3xl overflow-y-auto p-6">
        <BackButton onClick={() => navigate('/settings')} className="mb-4" />
        <div className="max-w-xl mx-auto w-full space-y-6 pb-8">
          <div>
            <h1 className="text-2xl font-black text-gray-900">{t(lang, 'goLiveTitle')}</h1>
            <p className="text-sm text-gray-500 mt-1">{t(lang, 'goLiveHint')}</p>
          </div>

          {confirmed && (
            <div className="rounded-2xl bg-emerald-50 border border-emerald-200 px-4 py-3">
              <p className="text-sm font-bold text-emerald-700">
                {t(lang, 'goLiveConfirmedBanner')}
                {' · '}
                {new Date(goLive!.confirmed_at!).toLocaleDateString(lang === 'he' ? 'he-IL' : 'ru-RU')}
                {goLive?.source === 'grandfather'
                  ? ` · ${t(lang, 'goLiveGrandfather')}`
                  : goLive?.confirmed_by ? ` · ${goLive.confirmed_by}` : ''}
              </p>
            </div>
          )}

          <Card title={t(lang, 'goLiveCritical')}>
            <CheckRow
              status={location ? (location.receipt_business_name?.trim() ? 'ok' : 'fail') : 'pending'}
              label={t(lang, 'goLiveBusinessName')}
              value={location?.receipt_business_name ?? undefined}
              hint={t(lang, 'goLiveReceiptWhere')}
            />
            <CheckRow
              status={location ? (location.receipt_tax_id?.trim() ? 'ok' : 'fail') : 'pending'}
              label={t(lang, 'goLiveTaxId')}
              value={location?.receipt_tax_id ?? undefined}
              hint={t(lang, 'goLiveReceiptWhere')}
            />
            <CheckRow
              status={itemsCount === null ? 'pending' : itemsCount > 0 ? 'ok' : 'fail'}
              label={t(lang, 'goLiveCatalog')}
              value={itemsCount !== null ? String(itemsCount) : undefined}
              hint={t(lang, 'goLiveCatalogHint')}
              action={itemsCount === 0 ? () => navigate('/menu') : undefined}
              actionLabel={itemsCount === 0 ? t(lang, 'goLiveOpen') : undefined}
            />
          </Card>

          <Card title={t(lang, 'goLiveDevice')}>
            <CheckRow
              status={schemaStatus}
              label={t(lang, 'goLiveSchema')}
              value={schemaQ.data && schemaQ.data.status !== 'unknown'
                ? `${schemaQ.data.version} / ${MIN_SCHEMA_VERSION}`
                : undefined}
              hint={t(lang, 'goLiveSchemaHint')}
            />
            <CheckRow
              status={printStatus}
              label={t(lang, 'goLivePrint')}
              value={printValue}
              hint={t(lang, 'goLivePrintHint')}
              action={testPrint}
              actionLabel={t(lang, 'testPrint')}
            />
            <CheckRow
              status="ok"
              label={t(lang, 'tapeWidth')}
              value={`${tapeWidth} mm`}
              hint={t(lang, 'goLiveTapeHint')}
            />
            <CheckRow
              status={payMethodOrder.length > 0 ? 'ok' : 'fail'}
              label={t(lang, 'goLivePayMethods')}
              value={payMethodOrder.map((m) => payMethodLabel(lang, m)).join(' · ')}
            />
            <CheckRow
              status={activeStaff === null ? 'pending' : activeStaff > 0 ? 'ok' : 'fail'}
              label={t(lang, 'goLiveStaff')}
              value={activeStaff !== null ? String(activeStaff) : undefined}
            />
          </Card>

          <Card title={t(lang, 'goLiveOps')}>
            <CheckRow
              status={vatStatus}
              label={t(lang, 'vatRateTitle')}
              value={location ? `${Number(location.vat_rate)}%` : undefined}
            />
            <CheckRow
              status={goLive?.backup_confirmed_at ? 'ok' : 'warn'}
              label={t(lang, 'goLiveBackup')}
              hint={t(lang, 'goLiveBackupHint')}
              action={toggleBackupConfirmed}
              actionLabel={goLive?.backup_confirmed_at ? t(lang, 'goLiveBackupUndo') : t(lang, 'goLiveBackupConfirm')}
            />
          </Card>

          {!confirmed && (
            <div>
              {gaps.length > 0 && (
                <p className="text-sm text-red-600 font-semibold mb-2">
                  {t(lang, 'goLiveGapsLeft')}: {gaps.map((g) => t(lang, GAP_LABELS[g])).join(' · ')}
                </p>
              )}
              <button
                className="btn-primary w-full !py-3.5 !rounded-2xl disabled:opacity-40"
                disabled={!canConfirm || isPending}
                onClick={confirmLaunch}
              >
                {t(lang, 'goLiveConfirmBtn')}
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
