import { useEffect, useRef, useState } from 'react'
import { t, type Lang } from '../../lib/i18n'

/**
 * Выбор языка QR-меню (184). Показывается, только если владелец включил
 * хотя бы один язык кроме иврита.
 *
 * Названия языков — на самих этих языках: турист ищет «English», а не
 * перевод этого слова на язык, которого не читает.
 */
const NATIVE: Record<Lang, string> = { he: 'עברית', en: 'English', ru: 'Русский' }
const SHORT: Record<Lang, string> = { he: 'עב', en: 'EN', ru: 'RU' }

interface SwitchProps {
  lang: Lang
  languages: readonly Lang[]
  onChange: (lang: Lang) => void
}

/**
 * Обложка: все языки сразу, выбор одним тапом. Здесь гость решает, как
 * читать меню, — на общем киоске прятать выбор в меню нельзя.
 */
export function HeroLanguageSwitch({ lang, languages, onChange }: SwitchProps) {
  if (languages.length < 2) return null
  return (
    <div className="public-menu-lang-segmented" role="group" aria-label={t(lang, 'guestLanguage')}>
      {languages.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          aria-label={NATIVE[code]}
          aria-pressed={code === lang}
          onClick={() => onChange(code)}
        >
          {SHORT[code]}
        </button>
      ))}
    </div>
  )
}

/**
 * Шапка меню, корзины и оформления: одна кнопка с текущим языком и короткий
 * список. Сегменты целиком сжали бы название заведения на телефоне.
 *
 * side — к какому краю прижат список: в компактной шапке кнопка стоит у
 * правого края физически (возврат — у левого), в шапке стола — в конце
 * строки по направлению текста.
 */
export function HeaderLanguageMenu({ lang, languages, onChange, side = 'right' }: SwitchProps & {
  side?: 'right' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    // mousedown/touchstart, а не pointerdown: страница собирается и для
    // старых WebView, где Pointer Events ещё нет
    const onOutside = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('touchstart', onOutside, { passive: true })
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onOutside)
      document.removeEventListener('touchstart', onOutside)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (languages.length < 2) return null
  return (
    <div ref={rootRef} className={`public-menu-lang-menu is-${side}`}>
      <button
        type="button"
        className="public-menu-lang-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t(lang, 'guestLanguage')}: ${NATIVE[lang]}`}
        onClick={() => setOpen((value) => !value)}
      >
        <GlobeIcon />
        <span lang={lang}>{SHORT[lang]}</span>
      </button>
      {open && (
        <div className="public-menu-lang-list" role="menu" aria-label={t(lang, 'guestLanguage')}>
          {languages.map((code) => (
            <button
              key={code}
              type="button"
              role="menuitemradio"
              aria-checked={code === lang}
              lang={code}
              dir={code === 'he' ? 'rtl' : 'ltr'}
              onClick={() => {
                setOpen(false)
                if (code !== lang) onChange(code)
              }}
            >
              <span>{NATIVE[code]}</span>
              {code === lang && <CheckIcon />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function GlobeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  )
}
