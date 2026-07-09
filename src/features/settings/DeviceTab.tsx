import { useLangStore } from '../../store/langStore'
import { useDeviceStore, type PrintMode, type FirstPayMethod } from '../../store/deviceStore'
import { playPaymentChime } from '../../lib/sound'
import { t } from '../../lib/i18n'

/** Варианты автоблокировки (сек); 0 = выключена */
const AUTOLOCK_OPTIONS = [0, 30, 60, 300, 900]

function lockLabel(sec: number, lang: 'ru' | 'he'): string {
  if (sec === 0) return t(lang, 'autoLockOff')
  if (sec < 60) return `${sec} ${t(lang, 'secShort')}`
  return `${sec / 60} ${t(lang, 'minShort')}`
}

/**
 * Таб «Касса»: настройки ЭТОГО устройства (localStorage, не БД) —
 * автоблокировка, PIN после продажи, звук оплаты. Square: Security/Checkout.
 */
export default function DeviceTab() {
  const lang = useLangStore((s) => s.lang)
  const autoLockSec = useDeviceStore((s) => s.autoLockSec)
  const lockAfterSale = useDeviceStore((s) => s.lockAfterSale)
  const paymentSound = useDeviceStore((s) => s.paymentSound)
  const printMode = useDeviceStore((s) => s.printMode)
  const autoPrintReceipt = useDeviceStore((s) => s.autoPrintReceipt)
  const receiptPrompt = useDeviceStore((s) => s.receiptPrompt)
  const printKitchenTicket = useDeviceStore((s) => s.printKitchenTicket)
  const firstPayMethod = useDeviceStore((s) => s.firstPayMethod)
  const collectTips = useDeviceStore((s) => s.collectTips)
  const tipAskBeforePayment = useDeviceStore((s) => s.tipAskBeforePayment)
  const tipPresets = useDeviceStore((s) => s.tipPresets)
  const tipAllowCustom = useDeviceStore((s) => s.tipAllowCustom)
  const tipBeforeTax = useDeviceStore((s) => s.tipBeforeTax)
  const tipSmartAmounts = useDeviceStore((s) => s.tipSmartAmounts)
  const tipSmartThreshold = useDeviceStore((s) => s.tipSmartThreshold)
  const tipSmartFixed = useDeviceStore((s) => s.tipSmartFixed)
  const setAutoLockSec = useDeviceStore((s) => s.setAutoLockSec)
  const setLockAfterSale = useDeviceStore((s) => s.setLockAfterSale)
  const setPaymentSound = useDeviceStore((s) => s.setPaymentSound)
  const setPrintMode = useDeviceStore((s) => s.setPrintMode)
  const setAutoPrintReceipt = useDeviceStore((s) => s.setAutoPrintReceipt)
  const setReceiptPrompt = useDeviceStore((s) => s.setReceiptPrompt)
  const setPrintKitchenTicket = useDeviceStore((s) => s.setPrintKitchenTicket)
  const setFirstPayMethod = useDeviceStore((s) => s.setFirstPayMethod)
  const setCollectTips = useDeviceStore((s) => s.setCollectTips)
  const setTipAskBeforePayment = useDeviceStore((s) => s.setTipAskBeforePayment)
  const setTipPresets = useDeviceStore((s) => s.setTipPresets)
  const setTipAllowCustom = useDeviceStore((s) => s.setTipAllowCustom)
  const setTipBeforeTax = useDeviceStore((s) => s.setTipBeforeTax)
  const setTipSmartAmounts = useDeviceStore((s) => s.setTipSmartAmounts)
  const setTipSmartThreshold = useDeviceStore((s) => s.setTipSmartThreshold)
  const setTipSmartFixed = useDeviceStore((s) => s.setTipSmartFixed)

  return (
    <div className="max-w-xl space-y-8">
      <p className="text-sm text-gray-500">{t(lang, 'deviceTabHint')}</p>

      {/* Автоблокировка */}
      <section>
        <h3 className="font-bold text-gray-900 mb-1">{t(lang, 'autoLock')}</h3>
        <p className="text-sm text-gray-500 mb-3">{t(lang, 'autoLockHint')}</p>
        <div className="flex gap-2 flex-wrap">
          {AUTOLOCK_OPTIONS.map((sec) => (
            <button
              key={sec}
              onClick={() => setAutoLockSec(sec)}
              className={`h-11 px-4 rounded-xl text-sm font-semibold transition-all active:scale-[0.96] ${
                autoLockSec === sec
                  ? 'bg-gray-900 text-white'
                  : 'bg-white border border-gray-200 text-gray-700 hover:border-gray-400'
              }`}
            >
              {lockLabel(sec, lang)}
            </button>
          ))}
        </div>
      </section>

      {/* PIN после каждой продажи */}
      <ToggleRow
        title={t(lang, 'lockAfterSale')}
        hint={t(lang, 'lockAfterSaleHint')}
        checked={lockAfterSale}
        onChange={setLockAfterSale}
      />

      {/* Звук оплаты */}
      <ToggleRow
        title={t(lang, 'paymentSoundTitle')}
        hint={t(lang, 'paymentSoundHint')}
        checked={paymentSound}
        onChange={(v) => {
          setPaymentSound(v)
          if (v) playPaymentChime() // сразу дать послушать
        }}
      />

      {/* Первый способ оплаты в окне оплаты */}
      <section>
        <h3 className="font-bold text-gray-900 mb-1">{t(lang, 'firstPayTitle')}</h3>
        <p className="text-sm text-gray-500 mb-3">{t(lang, 'firstPayHint')}</p>
        <div className="flex gap-2 flex-wrap">
          {(['cash', 'card'] as FirstPayMethod[]).map((m) => (
            <button
              key={m}
              onClick={() => setFirstPayMethod(m)}
              className={`h-11 px-4 rounded-xl text-sm font-semibold transition-all active:scale-[0.96] ${
                firstPayMethod === m
                  ? 'bg-gray-900 text-white'
                  : 'bg-white border border-gray-200 text-gray-700 hover:border-gray-400'
              }`}
            >
              {t(lang, m === 'cash' ? 'payCash' : 'payCard')}
            </button>
          ))}
        </div>
      </section>

      {/* Чаевые: мастер-тумблер + настройки как в Square (Tipping) */}
      <section>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-bold text-gray-900 mb-1">{t(lang, 'collectTipsTitle')}</h3>
            <p className="text-sm text-gray-500">{t(lang, 'collectTipsHint')}</p>
          </div>
          <Toggle checked={collectTips} onChange={setCollectTips} />
        </div>

        {collectTips && (
          <div className="mt-4 ps-4 border-s-2 border-gray-100 space-y-6">

            {/* Авто-шаг перед оплатой; выкл — только кнопкой на экране продажи */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <h4 className="font-semibold text-gray-900 mb-1">{t(lang, 'tipAskTitle')}</h4>
                <p className="text-sm text-gray-500">{t(lang, 'tipAskHint')}</p>
              </div>
              <Toggle checked={tipAskBeforePayment} onChange={setTipAskBeforePayment} />
            </div>

            {/* Пресеты процентов */}
            <div>
              <h4 className="font-semibold text-gray-900 mb-1">{t(lang, 'tipPresetsTitle')}</h4>
              <p className="text-sm text-gray-500 mb-2">{t(lang, 'tipPresetsHint')}</p>
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
            </div>

            {/* База процента: итог с НДС или без (Square: after/before taxes) */}
            <div>
              <h4 className="font-semibold text-gray-900 mb-1">{t(lang, 'tipBaseTitle')}</h4>
              <p className="text-sm text-gray-500 mb-2">{t(lang, 'tipBaseHint')}</p>
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => setTipBeforeTax(false)}
                  className={`h-11 px-4 rounded-xl text-sm font-semibold transition-all active:scale-[0.96] ${
                    !tipBeforeTax ? 'bg-gray-900 text-white' : 'bg-white border border-gray-200 text-gray-700 hover:border-gray-400'
                  }`}
                >
                  {t(lang, 'tipBaseGross')}
                </button>
                <button
                  onClick={() => setTipBeforeTax(true)}
                  className={`h-11 px-4 rounded-xl text-sm font-semibold transition-all active:scale-[0.96] ${
                    tipBeforeTax ? 'bg-gray-900 text-white' : 'bg-white border border-gray-200 text-gray-700 hover:border-gray-400'
                  }`}
                >
                  {t(lang, 'tipBaseNet')}
                </button>
              </div>
            </div>

            {/* Своя сумма (Square: Allow Custom Amounts) */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <h4 className="font-semibold text-gray-900 mb-1">{t(lang, 'tipCustomTitle')}</h4>
                <p className="text-sm text-gray-500">{t(lang, 'tipCustomHint')}</p>
              </div>
              <Toggle checked={tipAllowCustom} onChange={setTipAllowCustom} />
            </div>

            {/* Умные суммы (Square: Smart Tip Amounts): мелкий чек → фиксированные ₪ */}
            <div>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h4 className="font-semibold text-gray-900 mb-1">{t(lang, 'tipSmartTitle')}</h4>
                  <p className="text-sm text-gray-500">{t(lang, 'tipSmartHint')}</p>
                </div>
                <Toggle checked={tipSmartAmounts} onChange={setTipSmartAmounts} />
              </div>
              {tipSmartAmounts && (
                <div className="mt-3 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-500">{t(lang, 'tipSmartUpTo')}</span>
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
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-500">{t(lang, 'tipSmartFixedLabel')}</span>
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
                </div>
              )}
            </div>

          </div>
        )}
      </section>

      {/* Способ печати чека */}
      <section>
        <h3 className="font-bold text-gray-900 mb-1">{t(lang, 'printModeTitle')}</h3>
        <p className="text-sm text-gray-500 mb-3">{t(lang, 'printModeHint')}</p>
        <div className="flex gap-2 flex-wrap">
          {(['browser', 'rawbt'] as PrintMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setPrintMode(m)}
              className={`h-11 px-4 rounded-xl text-sm font-semibold transition-all active:scale-[0.96] ${
                printMode === m
                  ? 'bg-gray-900 text-white'
                  : 'bg-white border border-gray-200 text-gray-700 hover:border-gray-400'
              }`}
            >
              {t(lang, m === 'browser' ? 'printModeBrowser' : 'printModeRawbt')}
            </button>
          ))}
        </div>
        {printMode === 'rawbt' && (
          <p className="text-xs text-amber-600 mt-2">{t(lang, 'printModeRawbtHint')}</p>
        )}
      </section>

      {/* Автопечать чека после оплаты */}
      <ToggleRow
        title={t(lang, 'autoPrintTitle')}
        hint={t(lang, 'autoPrintHint')}
        checked={autoPrintReceipt}
        onChange={setAutoPrintReceipt}
      />

      {/* Спрашивать, как выдать чек (печать / телефон / без чека) */}
      <ToggleRow
        title={t(lang, 'receiptPromptTitle')}
        hint={t(lang, 'receiptPromptHint')}
        checked={receiptPrompt}
        onChange={setReceiptPrompt}
      />

      {/* Тикет на кухню/бар */}
      <ToggleRow
        title={t(lang, 'kitchenTicketTitle')}
        hint={t(lang, 'kitchenTicketHint')}
        checked={printKitchenTicket}
        onChange={setPrintKitchenTicket}
      />
    </div>
  )
}

function ToggleRow({
  title,
  hint,
  checked,
  onChange,
}: {
  title: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <section className="flex items-start justify-between gap-4">
      <div>
        <h3 className="font-bold text-gray-900 mb-1">{title}</h3>
        <p className="text-sm text-gray-500">{hint}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </section>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`shrink-0 w-14 h-8 rounded-full transition-colors relative ${
        checked ? 'bg-gray-900' : 'bg-gray-200'
      }`}
    >
      <span
        className={`absolute top-1 w-6 h-6 rounded-full bg-white shadow transition-all ${
          checked ? 'start-7' : 'start-1'
        }`}
      />
    </button>
  )
}
