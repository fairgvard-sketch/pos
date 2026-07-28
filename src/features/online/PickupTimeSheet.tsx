import { useEffect, useMemo, useRef, useState } from 'react'
import { t, type Lang } from '../../lib/i18n'
import type { PickupSlot } from './pickupSlots'

/**
 * Барабан выбора времени заказа: два колеса — день и время (112).
 *
 * Выпадающий `<select>` показывал слоты системным списком: на длинном
 * расписании гость листал сотню строк без ощущения «дня». Здесь день и
 * время разведены по колёсам, поэтому «завтра к 9:00» — два коротких
 * движения вместо прокрутки общего списка.
 *
 * Прокрутка нативная (scroll-snap), без обработчиков перетаскивания:
 * инерция и «липкость» достаются от системы, а на Chrome 52 (Sunmi T2)
 * колесо деградирует в обычный скролл — выбор остаётся рабочим.
 *
 * Палитра общая с остальной гостевой страницей: акцент near-black,
 * без цветных кнопок.
 */

interface Props {
  lang: Lang
  slots: PickupSlot[]
  /** Выбранный слот на момент открытия; '' — ничего не выбрано */
  value: string
  onCancel: () => void
  onConfirm: (iso: string) => void
}

/** Высота строки барабана и число видимых строк — должны совпадать с CSS. */
const ROW_H = 44
const VISIBLE = 5

/** Одно колесо: строки со scroll-snap, активная — по центру. */
function Wheel({ items, index, onIndexChange, ariaLabel }: {
  items: { key: string; label: string }[]
  index: number
  onIndexChange: (next: number) => void
  ariaLabel: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Программный скролл не должен трактоваться как выбор пользователя,
  // иначе выравнивание колеса переставляло бы соседнее.
  const silent = useRef(false)

  // Синхронизация позиции с выбранным индексом (и при смене списка)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const target = index * ROW_H
    if (Math.abs(el.scrollTop - target) < 2) return
    silent.current = true
    el.scrollTo({ top: target, behavior: 'auto' })
    // Снимаем флаг после того, как браузер отдал событие scroll
    requestAnimationFrame(() => { silent.current = false })
  }, [index, items.length])

  function onScroll() {
    if (silent.current) return
    if (settle.current) clearTimeout(settle.current)
    // Ждём остановки: событие scroll летит десятками, а выбор — один
    settle.current = setTimeout(() => {
      const el = ref.current
      if (!el) return
      const next = Math.round(el.scrollTop / ROW_H)
      const clamped = Math.max(0, Math.min(items.length - 1, next))
      if (clamped !== index) onIndexChange(clamped)
    }, 90)
  }

  useEffect(() => () => { if (settle.current) clearTimeout(settle.current) }, [])

  return (
    <div
      ref={ref}
      className="public-menu-wheel"
      role="listbox"
      aria-label={ariaLabel}
      tabIndex={0}
      onScroll={onScroll}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          onIndexChange(Math.min(items.length - 1, index + 1))
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          onIndexChange(Math.max(0, index - 1))
        }
      }}
    >
      {/* Отступы сверху/снизу поднимают первую и последнюю строку к центру */}
      <div className="public-menu-wheel-pad" aria-hidden />
      {items.map((item, i) => (
        <div
          key={item.key}
          role="option"
          aria-selected={i === index}
          className={`public-menu-wheel-row ${i === index ? 'is-active' : ''}`}
          onClick={() => onIndexChange(i)}
        >
          {item.label}
        </div>
      ))}
      <div className="public-menu-wheel-pad" aria-hidden />
    </div>
  )
}

export default function PickupTimeSheet({ lang, slots, value, onCancel, onConfirm }: Props) {
  // Дни в порядке появления: «сегодня» может отсутствовать, если точка
  // на сегодня уже закрыта — тогда первым колесом идёт «завтра».
  const days = useMemo(() => {
    const order: PickupSlot['day'][] = []
    for (const slot of slots) if (!order.includes(slot.day)) order.push(slot.day)
    return order
  }, [slots])

  const initialDay = useMemo(() => {
    const found = slots.find((slot) => slot.iso === value)
    return Math.max(0, days.indexOf(found?.day ?? days[0]))
  }, [slots, value, days])

  const [dayIndex, setDayIndex] = useState(initialDay)
  const dayKey = days[dayIndex] ?? days[0]
  const daySlots = useMemo(
    () => slots.filter((slot) => slot.day === dayKey),
    [slots, dayKey]
  )

  const [rawTimeIndex, setTimeIndex] = useState(() => {
    const within = slots.filter((slot) => slot.day === (days[initialDay] ?? days[0]))
    const found = within.findIndex((slot) => slot.iso === value)
    return found >= 0 ? found : 0
  })

  // Смена дня: в новом дне слотов может быть меньше. Зажимаем индекс при
  // чтении, а не правим состояние эффектом — иначе лишний каскадный рендер
  // (и предупреждение react-hooks/set-state-in-effect).
  const timeIndex = Math.min(rawTimeIndex, Math.max(0, daySlots.length - 1))

  const dayItems = days.map((day) => ({
    key: day,
    label: t(lang, day === 'today' ? 'pubSlotsToday' : 'pubSlotsTomorrow'),
  }))
  const timeItems = daySlots.map((slot) => ({ key: slot.iso, label: slot.label }))
  const picked = daySlots[timeIndex]

  return (
    <div
      className="public-menu-picker-overlay fixed inset-0 z-50 flex items-end justify-center"
      onClick={onCancel}
    >
      <div
        className="public-menu-picker-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pickup-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="public-menu-picker-grabber" aria-hidden />

        <div className="public-menu-picker-head">
          <button
            type="button"
            onClick={onCancel}
            aria-label={t(lang, 'close')}
            className="public-menu-picker-close"
          >
            ✕
          </button>
          <h3 id="pickup-sheet-title">{t(lang, 'pubPickupTime')}</h3>
        </div>

        <div className="public-menu-picker-wheels">
          {/* Подсветка центральной строки — общая для обоих колёс */}
          <span className="public-menu-wheel-highlight" aria-hidden />
          <Wheel
            items={dayItems}
            index={dayIndex}
            onIndexChange={setDayIndex}
            ariaLabel={t(lang, 'pubSlotsToday')}
          />
          <Wheel
            items={timeItems}
            index={timeIndex}
            onIndexChange={setTimeIndex}
            ariaLabel={t(lang, 'pubPickupTime')}
          />
        </div>

        <button
          type="button"
          className="public-menu-picker-confirm"
          disabled={!picked}
          onClick={() => picked && onConfirm(picked.iso)}
        >
          {t(lang, 'pubConfirmTime')}
        </button>
      </div>
    </div>
  )
}

export { ROW_H, VISIBLE }
