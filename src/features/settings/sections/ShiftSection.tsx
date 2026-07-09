import { useEffect, useState } from 'react'
import { useLangStore } from '../../../store/langStore'
import { t } from '../../../lib/i18n'
import { parseMoney, type Agorot } from '../../../lib/money'
import { Group, InputRow } from '../ui'
import { useLocationSettings } from '../useLocationSettings'
import type { Location } from '../../../types'

/**
 * Категория «Смена» (настройки точки, 036): стартовая сумма по умолчанию,
 * напоминание о закрытии, порог предупреждения о наличных.
 * Пустое поле = настройка выключена (null). Сохранение — по уходу из поля.
 */
export default function ShiftSection({ location }: { location: Location | undefined }) {
  const lang = useLangStore((s) => s.lang)
  const { settings, update } = useLocationSettings(location)
  const shift = settings.shift

  return (
    <div className="space-y-6">
      <Group>
        <MoneyRow
          label={t(lang, 'defaultFloatTitle')}
          hint={t(lang, 'defaultFloatHint')}
          value={shift?.default_opening_float ?? null}
          onCommit={(v) => update({ shift: { ...shift, default_opening_float: v } })}
        />
        <InputRow label={t(lang, 'closeReminderTitle')} hint={t(lang, 'closeReminderHint')}>
          <input
            type="time"
            className="input !w-32 text-center tabular-nums"
            value={shift?.close_reminder ?? ''}
            onChange={(e) => update({ shift: { ...shift, close_reminder: e.target.value || null } })}
          />
        </InputRow>
        <MoneyRow
          label={t(lang, 'cashWarnTitle')}
          hint={t(lang, 'cashWarnHint')}
          value={shift?.cash_warn_threshold ?? null}
          onCommit={(v) => update({ shift: { ...shift, cash_warn_threshold: v } })}
        />
      </Group>
    </div>
  )
}

/** Денежное поле в ₪, null = не задано; коммит по blur/Enter */
function MoneyRow({
  label, hint, value, onCommit,
}: {
  label: string
  hint?: string
  value: Agorot | null
  onCommit: (v: Agorot | null) => void
}) {
  const [str, setStr] = useState(value === null ? '' : String(value / 100))
  useEffect(() => {
    setStr(value === null ? '' : String(value / 100))
  }, [value])

  function commit() {
    const trimmed = str.trim()
    const next = trimmed === '' ? null : parseMoney(trimmed)
    if (trimmed !== '' && next === null) {
      // невалидный ввод — откатываем к сохранённому
      setStr(value === null ? '' : String(value / 100))
      return
    }
    if (next !== value) onCommit(next)
  }

  return (
    <InputRow label={label} hint={hint}>
      <div className="relative">
        <input
          className="input !w-28 text-center tabular-nums pe-6"
          inputMode="decimal"
          placeholder="—"
          value={str}
          onChange={(e) => setStr(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className="absolute end-2.5 top-1/2 -translate-y-1/2 text-sm text-gray-500">₪</span>
      </div>
    </InputRow>
  )
}
