import { useState, useRef, useEffect } from 'react'

interface Props {
  value: string
  onSave: (name: string) => void
  /** Классы текста в режиме показа (совпадают с исходным заголовком) */
  className?: string
  /** Плейсхолдер поля ввода */
  placeholder?: string
}

/**
 * Инлайн-переименование: клик по тексту превращает его в поле прямо на месте.
 * Enter/blur — сохранить (если непусто и изменилось), Esc — отменить.
 * Заменяет системный prompt() — единый стиль, RTL, тач-мишени.
 */
export default function InlineRename({ value, onSave, className = '', placeholder }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  function start() {
    setDraft(value)
    setEditing(true)
  }

  function commit() {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== value) onSave(next)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="input !py-1.5 !px-2.5 max-w-[16rem]"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
        }}
        // Клик по полю не должен всплывать (напр. в раскрывающемся заголовке группы)
        onClick={(e) => e.stopPropagation()}
      />
    )
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); start() }}
      className={`text-start rounded-md px-1 -mx-1 hover:bg-gray-100 transition-colors ${className}`}
    >
      {value}
    </button>
  )
}
