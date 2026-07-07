import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchCurrentLocation, updateServiceMode, updateReceiptDetails, type ReceiptDetails } from '../auth/api'
import { fetchTables, createTable, deleteTable } from '../tables/api'
import { useLangStore } from '../../store/langStore'
import { t, type TranslationKey } from '../../lib/i18n'
import type { ServiceMode } from '../../types'
import AppSidebar from '../../components/AppSidebar'

interface ModeOption {
  mode: ServiceMode
  title: TranslationKey
  hint: TranslationKey
  disabled?: boolean // tables (полные столы) — ещё в разработке
}

const MODES: ModeOption[] = [
  { mode: 'counter', title: 'modeCounter', hint: 'modeCounterHint' },
  { mode: 'counter_tables', title: 'modeCounterTables', hint: 'modeCounterTablesHint' },
  { mode: 'tables', title: 'modeTables', hint: 'modeTablesHint' },
]

export default function SettingsPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const qc = useQueryClient()

  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const { data: tables = [] } = useQuery({ queryKey: ['tables'], queryFn: fetchTables })

  const [newLabel, setNewLabel] = useState('')
  const [newZone, setNewZone] = useState('')

  const addTable = useMutation({
    mutationFn: () => createTable(newLabel.trim(), newZone.trim() || null, tables.length),
    onSuccess: () => {
      setNewLabel(''); setNewZone('')
      qc.invalidateQueries({ queryKey: ['tables'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const removeTable = useMutation({
    mutationFn: (id: string) => deleteTable(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tables'] }),
    onError: (e) => toast.error(e.message),
  })

  const save = useMutation({
    mutationFn: (mode: ServiceMode) => updateServiceMode(mode),
    // Оптимистично: подменяем режим в кеше, экраны реагируют мгновенно
    onMutate: async (mode) => {
      await qc.cancelQueries({ queryKey: ['current_location'] })
      const prev = qc.getQueryData(['current_location'])
      qc.setQueryData(['current_location'], (old: typeof location) => (old ? { ...old, service_mode: mode } : old))
      return { prev }
    },
    onError: (e, _mode, ctx) => {
      qc.setQueryData(['current_location'], ctx?.prev)
      toast.error(e.message)
    },
    onSuccess: () => toast.success(t(lang, 'saved')),
  })

  // ── Реквизиты чека ──
  const [receipt, setReceipt] = useState<ReceiptDetails>({
    receipt_business_name: '', receipt_address: '', receipt_tax_id: '', receipt_phone: '', receipt_footer: '',
  })
  // Заполняем форму из локации, когда та подгрузилась
  useEffect(() => {
    if (location) {
      setReceipt({
        receipt_business_name: location.receipt_business_name ?? '',
        receipt_address: location.receipt_address ?? '',
        receipt_tax_id: location.receipt_tax_id ?? '',
        receipt_phone: location.receipt_phone ?? '',
        receipt_footer: location.receipt_footer ?? '',
      })
    }
  }, [location])

  const saveReceipt = useMutation({
    mutationFn: () => updateReceiptDetails(receipt),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['current_location'] }); toast.success(t(lang, 'saved')) },
    onError: (e) => toast.error(e.message),
  })

  const current = location?.service_mode

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="settings" />

      <main className="flex-1 bg-white rounded-3xl overflow-y-auto p-6">
        <h1 className="text-2xl font-black text-gray-900 mb-6">{t(lang, 'settingsTitle')}</h1>

        <section className="max-w-2xl">
          <h2 className="text-base font-bold text-gray-900">{t(lang, 'serviceModeTitle')}</h2>
          <p className="text-sm text-gray-500 mt-1 mb-4">{t(lang, 'serviceModeHint')}</p>

          <div className="space-y-2">
            {MODES.map((m) => {
              const active = current === m.mode
              return (
                <button
                  key={m.mode}
                  onClick={() => !m.disabled && !active && save.mutate(m.mode)}
                  disabled={m.disabled || save.isPending}
                  className={`w-full text-start rounded-2xl border p-4 transition-all ${
                    active
                      ? 'border-gray-900 bg-gray-900/[0.03]'
                      : m.disabled
                        ? 'border-gray-100 opacity-50 cursor-not-allowed'
                        : 'border-gray-200 hover:border-gray-400 active:scale-[0.99]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-gray-900">{t(lang, m.title)}</span>
                    <span
                      className={`w-5 h-5 rounded-full border-2 shrink-0 flex items-center justify-center ${
                        active ? 'border-gray-900 bg-gray-900' : 'border-gray-300'
                      }`}
                    >
                      {active && <span className="w-2 h-2 rounded-full bg-white" />}
                    </span>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">{t(lang, m.hint)}</p>
                </button>
              )
            })}
          </div>
        </section>

        {/* Реквизиты чека */}
        <section className="max-w-2xl mt-10">
          <h2 className="text-base font-bold text-gray-900">{t(lang, 'receiptDetailsTitle')}</h2>
          <p className="text-sm text-gray-500 mt-1 mb-4">{t(lang, 'receiptDetailsHint')}</p>

          <div className="space-y-3">
            <Field label={t(lang, 'receiptBusinessName')} value={receipt.receipt_business_name ?? ''}
              placeholder={location?.name ?? ''}
              onChange={(v) => setReceipt((r) => ({ ...r, receipt_business_name: v }))} />
            <Field label={t(lang, 'receiptTaxId')} value={receipt.receipt_tax_id ?? ''}
              onChange={(v) => setReceipt((r) => ({ ...r, receipt_tax_id: v }))} />
            <Field label={t(lang, 'receiptAddress')} value={receipt.receipt_address ?? ''}
              onChange={(v) => setReceipt((r) => ({ ...r, receipt_address: v }))} />
            <Field label={t(lang, 'receiptPhone')} value={receipt.receipt_phone ?? ''}
              onChange={(v) => setReceipt((r) => ({ ...r, receipt_phone: v }))} />
            <Field label={t(lang, 'receiptFooter')} value={receipt.receipt_footer ?? ''}
              onChange={(v) => setReceipt((r) => ({ ...r, receipt_footer: v }))} />
          </div>

          <button
            onClick={() => saveReceipt.mutate()}
            disabled={saveReceipt.isPending}
            className="btn-primary !py-2.5 !px-6 mt-4"
          >
            {t(lang, 'save')}
          </button>
        </section>

        {/* Управление столами — только в режиме столов */}
        {current === 'tables' && (
          <section className="max-w-2xl mt-10">
            <h2 className="text-base font-bold text-gray-900 mb-4">{t(lang, 'tablesManage')}</h2>

            {tables.length === 0 ? (
              <p className="text-sm text-gray-500 mb-4">{t(lang, 'noTablesYet')}</p>
            ) : (
              <div className="flex flex-wrap gap-2 mb-4">
                {tables.map((tb) => (
                  <div key={tb.id} className="flex items-center gap-2 rounded-xl border border-gray-200 ps-3 pe-1.5 h-11">
                    <span className="font-bold text-gray-900 tabular-nums">{tb.label}</span>
                    {tb.zone && <span className="text-xs text-gray-500">{tb.zone}</span>}
                    <button
                      onClick={() => removeTable.mutate(tb.id)}
                      className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-red-500"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <input
                className="input !py-2 max-w-[160px]"
                placeholder={t(lang, 'tableLabelField')}
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && newLabel.trim() && addTable.mutate()}
              />
              <input
                className="input !py-2 max-w-[160px]"
                placeholder={t(lang, 'tableZoneField')}
                value={newZone}
                onChange={(e) => setNewZone(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && newLabel.trim() && addTable.mutate()}
              />
              <button
                onClick={() => addTable.mutate()}
                disabled={!newLabel.trim() || addTable.isPending}
                className="btn-secondary !py-2 whitespace-nowrap"
              >
                {t(lang, 'addTable')}
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

function Field({
  label, value, placeholder, onChange,
}: { label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">{label}</span>
      <input className="input" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}
