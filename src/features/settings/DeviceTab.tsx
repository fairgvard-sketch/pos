import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
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
  const setAutoLockSec = useDeviceStore((s) => s.setAutoLockSec)
  const setLockAfterSale = useDeviceStore((s) => s.setLockAfterSale)
  const setPaymentSound = useDeviceStore((s) => s.setPaymentSound)

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
    </section>
  )
}
