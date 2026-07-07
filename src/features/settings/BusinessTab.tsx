import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { updateReceiptDetails, updateVatRate, type ReceiptDetails } from '../auth/api'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import type { Location } from '../../types'

/** Таб «Бизнес»: реквизиты чека + ставка НДС */
export default function BusinessTab({ location }: { location: Location | undefined }) {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()

  // ── Реквизиты чека ──
  const [receipt, setReceipt] = useState<ReceiptDetails>({
    receipt_business_name: '', receipt_address: '', receipt_tax_id: '', receipt_phone: '', receipt_footer: '',
  })
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

  // ── НДС ──
  const [vat, setVat] = useState('')
  useEffect(() => {
    if (location) setVat(String(Number(location.vat_rate)))
  }, [location])

  const vatNum = Number(vat.replace(',', '.'))
  const vatValid = vat.trim() !== '' && Number.isFinite(vatNum) && vatNum >= 0 && vatNum <= 50

  const saveVat = useMutation({
    mutationFn: () => updateVatRate(vatNum),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['current_location'] }); toast.success(t(lang, 'saved')) },
    onError: (e) => toast.error(e.message),
  })

  return (
    <>
      <section className="max-w-2xl">
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

      <section className="max-w-2xl mt-10">
        <h2 className="text-base font-bold text-gray-900">{t(lang, 'vatRateTitle')}</h2>
        <p className="text-sm text-gray-500 mt-1 mb-4">{t(lang, 'vatRateHint')}</p>

        <div className="flex items-end gap-2">
          <label className="block">
            <span className="block text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">
              {t(lang, 'vatRateLabel')}
            </span>
            <input
              className="input max-w-[120px] tabular-nums"
              inputMode="decimal"
              value={vat}
              onChange={(e) => setVat(e.target.value)}
            />
          </label>
          <button
            onClick={() => saveVat.mutate()}
            disabled={!vatValid || saveVat.isPending || Number(location?.vat_rate) === vatNum}
            className="btn-primary !py-2.5 !px-6"
          >
            {t(lang, 'save')}
          </button>
        </div>
      </section>
    </>
  )
}

export function Field({
  label, value, placeholder, onChange,
}: { label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">{label}</span>
      <input className="input" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}
