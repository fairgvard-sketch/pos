import { useNavigate } from 'react-router-dom'
import { useLangStore } from '../../../store/langStore'
import { t } from '../../../lib/i18n'
import { Group, NavRow } from '../ui'
import type { DetailId } from '../registry'
import type { Location } from '../../../types'

/** Категория «Бизнес»: реквизиты чека (drill-down), меню, дашборд */
export default function BusinessSection({
  location, openDetail,
}: { location: Location | undefined; openDetail: (id: DetailId) => void }) {
  const lang = useLangStore((s) => s.lang)
  const navigate = useNavigate()

  return (
    <div className="space-y-6">
      <Group>
        <NavRow
          label={t(lang, 'receiptDetailsTitle')}
          hint={t(lang, 'receiptDetailsHint')}
          value={location?.receipt_business_name ?? location?.name}
          onClick={() => openDetail('receipt-details')}
        />
      </Group>

      {/* Экраны, убранные из сайдбара: полная админка меню и дашборд владельца */}
      <Group>
        <NavRow label={t(lang, 'menu')} hint={t(lang, 'menuAdminHint')} onClick={() => navigate('/menu')} />
        <NavRow label={t(lang, 'dashboard')} hint={t(lang, 'dashboardHint')} onClick={() => navigate('/dashboard')} />
      </Group>
    </div>
  )
}
