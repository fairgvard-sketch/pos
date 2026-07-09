import toast from 'react-hot-toast'
import { useLangStore } from '../../../store/langStore'
import { useDeviceStore, type PrintMode } from '../../../store/deviceStore'
import { t } from '../../../lib/i18n'
import { Group, SegmentRow, SoonRow, ToggleRow } from '../ui'
import { useLocationSettings } from '../useLocationSettings'
import type { Location } from '../../../types'

/** Категория «Чеки и печать»: способ печати (касса) + опции содержимого чека (точка) */
export default function ReceiptsSection({ location }: { location: Location | undefined }) {
  const lang = useLangStore((s) => s.lang)
  const printMode = useDeviceStore((s) => s.printMode)
  const autoPrintReceipt = useDeviceStore((s) => s.autoPrintReceipt)
  const receiptPrompt = useDeviceStore((s) => s.receiptPrompt)
  const printKitchenTicket = useDeviceStore((s) => s.printKitchenTicket)
  const setPrintMode = useDeviceStore((s) => s.setPrintMode)
  const setAutoPrintReceipt = useDeviceStore((s) => s.setAutoPrintReceipt)
  const setReceiptPrompt = useDeviceStore((s) => s.setReceiptPrompt)
  const setPrintKitchenTicket = useDeviceStore((s) => s.setPrintKitchenTicket)

  const { settings, update } = useLocationSettings(location)
  const soon = () => toast(t(lang, 'featureSoon'))

  return (
    <div className="space-y-6">
      <Group title={t(lang, 'groupPrinting')}>
        <div>
          <SegmentRow<PrintMode>
            label={t(lang, 'printModeTitle')}
            hint={t(lang, 'printModeHint')}
            device
            options={[
              { value: 'browser', label: t(lang, 'printModeBrowser') },
              { value: 'rawbt', label: t(lang, 'printModeRawbt') },
            ]}
            value={printMode}
            onChange={setPrintMode}
          />
          {printMode === 'rawbt' && (
            <p className="text-xs text-amber-600 px-4 pb-3 -mt-1">{t(lang, 'printModeRawbtHint')}</p>
          )}
        </div>
        <ToggleRow
          label={t(lang, 'autoPrintTitle')}
          hint={t(lang, 'autoPrintHint')}
          device
          checked={autoPrintReceipt}
          onChange={setAutoPrintReceipt}
        />
        <ToggleRow
          label={t(lang, 'receiptPromptTitle')}
          hint={t(lang, 'receiptPromptHint')}
          device
          checked={receiptPrompt}
          onChange={setReceiptPrompt}
        />
        <ToggleRow
          label={t(lang, 'kitchenTicketTitle')}
          hint={t(lang, 'kitchenTicketHint')}
          device
          checked={printKitchenTicket}
          onChange={setPrintKitchenTicket}
        />
      </Group>

      {/* Содержимое чека — настройки точки, общие для всех касс */}
      <Group title={t(lang, 'groupReceiptContent')}>
        <ToggleRow
          label={t(lang, 'printModifiersTitle')}
          hint={t(lang, 'printModifiersHint')}
          checked={settings.receipt?.print_modifiers ?? false}
          onChange={(v) => update({ receipt: { print_modifiers: v } })}
        />
        <SegmentRow<1 | 2>
          label={t(lang, 'receiptCopiesTitle')}
          hint={t(lang, 'receiptCopiesHint')}
          options={[
            { value: 1, label: '1' },
            { value: 2, label: '2' },
          ]}
          value={settings.receipt?.copies ?? 1}
          onChange={(v) => update({ receipt: { copies: v } })}
        />
      </Group>

      {/* Запланировано (Square: Signature and receipt) */}
      <Group title={t(lang, 'groupPlanned')}>
        <SoonRow label={t(lang, 'signatureTitle')} hint={t(lang, 'signatureHint')} onTap={soon} />
      </Group>
    </div>
  )
}
