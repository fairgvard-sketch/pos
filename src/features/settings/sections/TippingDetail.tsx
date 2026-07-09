import { useLangStore } from '../../../store/langStore'
import { useDeviceStore } from '../../../store/deviceStore'
import { t } from '../../../lib/i18n'
import { Group, InputRow, SegmentRow, ToggleRow } from '../ui'

/** Деталь «Чаевые» (Square: Tipping) — настройки этой кассы, перенос из DeviceTab */
export default function TippingDetail() {
  const lang = useLangStore((s) => s.lang)
  const collectTips = useDeviceStore((s) => s.collectTips)
  const tipAskBeforePayment = useDeviceStore((s) => s.tipAskBeforePayment)
  const tipPresets = useDeviceStore((s) => s.tipPresets)
  const tipAllowCustom = useDeviceStore((s) => s.tipAllowCustom)
  const tipBeforeTax = useDeviceStore((s) => s.tipBeforeTax)
  const tipSmartAmounts = useDeviceStore((s) => s.tipSmartAmounts)
  const tipSmartThreshold = useDeviceStore((s) => s.tipSmartThreshold)
  const tipSmartFixed = useDeviceStore((s) => s.tipSmartFixed)
  const setCollectTips = useDeviceStore((s) => s.setCollectTips)
  const setTipAskBeforePayment = useDeviceStore((s) => s.setTipAskBeforePayment)
  const setTipPresets = useDeviceStore((s) => s.setTipPresets)
  const setTipAllowCustom = useDeviceStore((s) => s.setTipAllowCustom)
  const setTipBeforeTax = useDeviceStore((s) => s.setTipBeforeTax)
  const setTipSmartAmounts = useDeviceStore((s) => s.setTipSmartAmounts)
  const setTipSmartThreshold = useDeviceStore((s) => s.setTipSmartThreshold)
  const setTipSmartFixed = useDeviceStore((s) => s.setTipSmartFixed)

  return (
    <div className="space-y-6">
      <Group>
        <ToggleRow
          label={t(lang, 'collectTipsTitle')}
          hint={t(lang, 'collectTipsHint')}
          device
          checked={collectTips}
          onChange={setCollectTips}
        />
      </Group>

      {collectTips && (
        <>
          <Group>
            <ToggleRow
              label={t(lang, 'tipAskTitle')}
              hint={t(lang, 'tipAskHint')}
              checked={tipAskBeforePayment}
              onChange={setTipAskBeforePayment}
            />
            <InputRow label={t(lang, 'tipPresetsTitle')} hint={t(lang, 'tipPresetsHint')}>
              <div className="flex gap-2">
                {tipPresets.map((p, i) => (
                  <div key={i} className="relative">
                    <input
                      className="input !w-20 text-center tabular-nums pe-6"
                      inputMode="numeric"
                      value={p || ''}
                      onChange={(e) => {
                        const v = Math.min(99, Math.max(0, parseInt(e.target.value, 10) || 0))
                        setTipPresets(tipPresets.map((x, j) => (j === i ? v : x)))
                      }}
                    />
                    <span className="absolute end-2.5 top-1/2 -translate-y-1/2 text-sm text-gray-500">%</span>
                  </div>
                ))}
              </div>
            </InputRow>
            <SegmentRow<'gross' | 'net'>
              label={t(lang, 'tipBaseTitle')}
              hint={t(lang, 'tipBaseHint')}
              options={[
                { value: 'gross', label: t(lang, 'tipBaseGross') },
                { value: 'net', label: t(lang, 'tipBaseNet') },
              ]}
              value={tipBeforeTax ? 'net' : 'gross'}
              onChange={(v) => setTipBeforeTax(v === 'net')}
            />
            <ToggleRow
              label={t(lang, 'tipCustomTitle')}
              hint={t(lang, 'tipCustomHint')}
              checked={tipAllowCustom}
              onChange={setTipAllowCustom}
            />
          </Group>

          {/* Умные суммы (Square: Smart Tip Amounts): мелкий чек → фиксированные ₪ */}
          <Group>
            <ToggleRow
              label={t(lang, 'tipSmartTitle')}
              hint={t(lang, 'tipSmartHint')}
              checked={tipSmartAmounts}
              onChange={setTipSmartAmounts}
            />
            {tipSmartAmounts && (
              <>
                <InputRow label={t(lang, 'tipSmartUpTo')}>
                  <div className="relative">
                    <input
                      className="input !w-24 text-center tabular-nums pe-6"
                      inputMode="numeric"
                      value={tipSmartThreshold / 100 || ''}
                      onChange={(e) => {
                        const v = Math.max(0, parseInt(e.target.value, 10) || 0)
                        setTipSmartThreshold(v * 100)
                      }}
                    />
                    <span className="absolute end-2.5 top-1/2 -translate-y-1/2 text-sm text-gray-500">₪</span>
                  </div>
                </InputRow>
                <InputRow label={t(lang, 'tipSmartFixedLabel')}>
                  <div className="flex gap-2">
                    {tipSmartFixed.map((a, i) => (
                      <div key={i} className="relative">
                        <input
                          className="input !w-20 text-center tabular-nums pe-6"
                          inputMode="numeric"
                          value={a / 100 || ''}
                          onChange={(e) => {
                            const v = Math.max(0, parseInt(e.target.value, 10) || 0)
                            setTipSmartFixed(tipSmartFixed.map((x, j) => (j === i ? v * 100 : x)))
                          }}
                        />
                        <span className="absolute end-2.5 top-1/2 -translate-y-1/2 text-sm text-gray-500">₪</span>
                      </div>
                    ))}
                  </div>
                </InputRow>
              </>
            )}
          </Group>
        </>
      )}
    </div>
  )
}
