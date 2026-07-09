import type { ReactNode } from 'react'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'

/**
 * Общие кирпичи настроек v2 (стиль Square): группы строк с divider,
 * строка-ссылка с текущим значением и chevron, тумблеры, сегменты.
 * Тач-мишени ≥44px, контраст AA, RTL через логические свойства.
 */

/** Бейдж «эта касса» — настройка живёт в localStorage устройства, не в БД */
export function DeviceBadge() {
  const lang = useLangStore((s) => s.lang)
  return (
    <span className="ms-2 inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-500 align-middle whitespace-nowrap">
      {t(lang, 'thisDevice')}
    </span>
  )
}

/** Группа строк: заголовок + белая карточка со строками через divider */
export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section>
      {title && (
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2 px-1">{title}</h3>
      )}
      <div className="rounded-2xl border border-gray-100 bg-white divide-y divide-gray-100 overflow-hidden">
        {children}
      </div>
    </section>
  )
}

function Chevron() {
  return (
    <svg
      className="w-4 h-4 text-gray-400 shrink-0 rtl:-scale-x-100"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Строка-ссылка: label + текущее значение + chevron → drill-down */
export function NavRow({
  label, value, hint, device, onClick,
}: {
  label: string
  value?: string
  hint?: string
  device?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="w-full min-h-[52px] px-4 py-3 flex items-center gap-3 text-start hover:bg-gray-50 transition-colors"
    >
      <span className="flex-1 min-w-0">
        <span className="text-sm font-semibold text-gray-900">
          {label}
          {device && <DeviceBadge />}
        </span>
        {hint && <span className="block text-xs text-gray-500 mt-0.5">{hint}</span>}
      </span>
      {value && <span className="text-sm text-gray-500 shrink-0 max-w-[40%] truncate">{value}</span>}
      <Chevron />
    </button>
  )
}

/**
 * Строка-заглушка для запланированной настройки (Square-паритет):
 * показывает пункт с бейджем «Скоро», кликом отвечает toast'ом.
 * Тап не открывает drill-down — функции ещё нет.
 */
export function SoonRow({ label, hint, onTap }: { label: string; hint?: string; onTap: () => void }) {
  return (
    <button
      onClick={onTap}
      className="w-full min-h-[52px] px-4 py-3 flex items-center gap-3 text-start hover:bg-gray-50 transition-colors"
    >
      <span className="flex-1 min-w-0">
        <span className="text-sm font-semibold text-gray-400">{label}</span>
        {hint && <span className="block text-xs text-gray-400 mt-0.5">{hint}</span>}
      </span>
      <SoonBadge />
    </button>
  )
}

/** Бейдж «Скоро» — запланированная, но ещё не реализованная настройка */
export function SoonBadge() {
  const lang = useLangStore((s) => s.lang)
  return (
    <span className="shrink-0 inline-flex items-center rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-semibold text-gray-500 whitespace-nowrap">
      {t(lang, 'comingSoon')}
    </span>
  )
}

/** Тумблер (перенесён из DeviceTab) */
export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`shrink-0 w-12 h-7 rounded-full transition-colors relative ${
        checked ? 'bg-gray-900' : 'bg-gray-200'
      }`}
    >
      <span
        className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow transition-all ${
          checked ? 'start-6' : 'start-1'
        }`}
      />
    </button>
  )
}

/** Строка с тумблером */
export function ToggleRow({
  label, hint, checked, device, onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  device?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="min-h-[52px] px-4 py-3 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-gray-900">
          {label}
          {device && <DeviceBadge />}
        </div>
        {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  )
}

/** Сегментированный выбор (2–4 варианта) */
export function Segment<T extends string | number>({
  options, value, onChange, disabled,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <div className="inline-flex rounded-xl border border-gray-100 bg-gray-50 p-0.5 gap-0.5 shrink-0">
      {options.map((o) => (
        <button
          key={String(o.value)}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`h-9 px-3 rounded-lg text-sm font-semibold transition-all whitespace-nowrap ${
            value === o.value
              ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Строка с сегментированным выбором */
export function SegmentRow<T extends string | number>({
  label, hint, options, value, device, disabled, onChange,
}: {
  label: string
  hint?: string
  options: { value: T; label: string }[]
  value: T
  device?: boolean
  disabled?: boolean
  onChange: (v: T) => void
}) {
  return (
    <div className="min-h-[52px] px-4 py-3 flex items-center gap-4 flex-wrap">
      <div className="flex-1 min-w-[160px]">
        <div className="text-sm font-semibold text-gray-900">
          {label}
          {device && <DeviceBadge />}
        </div>
        {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      </div>
      <Segment options={options} value={value} onChange={onChange} disabled={disabled} />
    </div>
  )
}

/**
 * Строка с полем ввода справа (число/время/деньги). Сохранение — на onBlur
 * вызывающего; suffix — единица (₪/%/…) внутри поля.
 */
export function InputRow({
  label, hint, device, children,
}: {
  label: string
  hint?: string
  device?: boolean
  children: ReactNode
}) {
  return (
    <div className="min-h-[52px] px-4 py-3 flex items-center gap-4 flex-wrap">
      <div className="flex-1 min-w-[160px]">
        <div className="text-sm font-semibold text-gray-900">
          {label}
          {device && <DeviceBadge />}
        </div>
        {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

/** Текстовое поле с подписью (перенесено из BusinessTab, контраст label поднят до AA) */
export function Field({
  label, value, placeholder, onChange,
}: { label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">{label}</span>
      <input className="input" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

/** Шапка drill-down детали: ← Назад + заголовок */
export function DetailHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const lang = useLangStore((s) => s.lang)
  return (
    <div className="flex items-center gap-2 mb-6">
      <button
        onClick={onBack}
        aria-label={t(lang, 'back')}
        className="w-11 h-11 -ms-3 flex items-center justify-center rounded-xl text-gray-500 hover:text-gray-900 hover:bg-gray-50 transition-colors active:scale-[0.94]"
      >
        <svg className="w-5 h-5 rtl:-scale-x-100" viewBox="0 0 20 20" fill="none" aria-hidden>
          <path d="M12.5 4l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <h2 className="text-xl font-black text-gray-900">{title}</h2>
    </div>
  )
}
