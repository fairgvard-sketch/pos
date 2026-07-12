import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { updateReceiptDetails, type ReceiptDetails } from '../../auth/api'
import { useLangStore } from '../../../store/langStore'
import { t } from '../../../lib/i18n'
import { Field } from '../ui'
import type { Location } from '../../../types'

/** Деталь «Реквизиты чека»: шапка/подвал хешбонита (перенос из BusinessTab) */
export default function ReceiptDetailsDetail({ location }: { location: Location | undefined }) {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()

  const [receipt, setReceipt] = useState<ReceiptDetails>({
    receipt_business_name: '', receipt_address: '', receipt_tax_id: '', receipt_phone: '', receipt_footer: '',
  })
  // Заполняем поля из точки при её появлении/смене (сравнение с прошлым
  // location в рендере вместо setState в эффекте):
  const [prevLoc, setPrevLoc] = useState(location)
  if (location && location !== prevLoc) {
    setPrevLoc(location)
    setReceipt({
      receipt_business_name: location.receipt_business_name ?? '',
      receipt_address: location.receipt_address ?? '',
      receipt_tax_id: location.receipt_tax_id ?? '',
      receipt_phone: location.receipt_phone ?? '',
      receipt_footer: location.receipt_footer ?? '',
    })
  }

  const saveReceipt = useMutation({
    mutationFn: () => updateReceiptDetails(receipt),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['current_location'] }); toast.success(t(lang, 'saved')) },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div>
      <p className="text-sm text-gray-500 mb-4">{t(lang, 'receiptDetailsHint')}</p>

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
    </div>
  )
}
