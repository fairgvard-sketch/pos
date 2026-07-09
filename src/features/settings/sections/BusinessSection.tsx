import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { updateVatRate } from '../../auth/api'
import { useLangStore } from '../../../store/langStore'
import { t } from '../../../lib/i18n'
import { Group, InputRow, NavRow } from '../ui'
import type { DetailId } from '../registry'
import type { Location } from '../../../types'

/** Категория «Бизнес»: НДС + реквизиты чека (drill-down) */
export default function BusinessSection({
  location, openDetail,
}: { location: Location | undefined; openDetail: (id: DetailId) => void }) {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()

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

  function commitVat() {
    if (!vatValid) {
      setVat(location ? String(Number(location.vat_rate)) : '')
      return
    }
    if (Number(location?.vat_rate) !== vatNum) saveVat.mutate()
  }

  return (
    <div className="space-y-6">
      <Group>
        <NavRow
          label={t(lang, 'receiptDetailsTitle')}
          hint={t(lang, 'receiptDetailsHint')}
          value={location?.receipt_business_name ?? location?.name}
          onClick={() => openDetail('receipt-details')}
        />
        <InputRow label={t(lang, 'vatRateTitle')} hint={t(lang, 'vatRateHint')}>
          <div className="relative">
            <input
              className="input !w-24 text-center tabular-nums pe-6"
              inputMode="decimal"
              value={vat}
              onChange={(e) => setVat(e.target.value)}
              onBlur={commitVat}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <span className="absolute end-2.5 top-1/2 -translate-y-1/2 text-sm text-gray-500">%</span>
          </div>
        </InputRow>
      </Group>
    </div>
  )
}
