interface Props {
  value: string
  onChange: (next: string) => void
  // Разрешить дробную часть (для ₪); false — только целые (для %)
  decimal?: boolean
  // Макс. знаков в дробной части
  maxDecimals?: number
}

/**
 * Цифровая клавиатура для тач-планшета — POS без физической клавиатуры.
 * Работает со строкой (контролируется извне), крупные тач-мишени.
 */
export default function NumPad({ value, onChange, decimal = true, maxDecimals = 2 }: Props) {
  function press(d: string) {
    if (d === '.') {
      if (!decimal || value.includes('.')) return
      onChange(value === '' ? '0.' : value + '.')
      return
    }
    // Ограничение знаков после точки
    if (decimal && value.includes('.')) {
      const dec = value.split('.')[1] ?? ''
      if (dec.length >= maxDecimals) return
    }
    // Не копим ведущие нули
    if (value === '0' && d !== '.') { onChange(d); return }
    onChange(value + d)
  }

  function backspace() {
    onChange(value.slice(0, -1))
  }

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', decimal ? '.' : '', '0', '⌫']

  return (
    <div className="grid grid-cols-3 gap-2">
      {keys.map((k, i) =>
        k === '' ? (
          <div key={i} />
        ) : (
          <button
            key={i}
            type="button"
            onClick={() => (k === '⌫' ? backspace() : press(k))}
            className="h-14 rounded-xl bg-gray-50 border border-gray-200 text-xl font-bold text-gray-900
                       flex items-center justify-center tabular-nums
                       hover:border-gray-400 active:scale-[0.94] active:bg-gray-100 transition-all"
          >
            {k}
          </button>
        )
      )}
    </div>
  )
}
