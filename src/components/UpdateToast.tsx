import { useEffect, useState } from 'react'
import { useLangStore } from '../store/langStore'
import { t } from '../lib/i18n'
import { setupSwUpdate } from '../lib/swUpdate'

/**
 * Плашка «доступна новая версия».
 *
 * Молча перезагружать страницу нельзя: гость мог набрать корзину или
 * заполнять контакты — потерять это из-за деплоя хуже, чем показать
 * старое меню лишнюю минуту. Поэтому обновляем по тапу.
 *
 * Плашка не перехватывает ввод: одна строка внизу, поверх неё ничего не
 * блокируется, закрыть можно крестиком. Появляется редко — только когда
 * SW действительно скачал новую версию.
 */
export default function UpdateToast() {
  const lang = useLangStore((s) => s.lang)
  const [reload, setReload] = useState<(() => void) | null>(null)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    // Колбэк в состояние кладём функцией-обёрткой: setState с функцией
    // трактует её как updater и вызвал бы её вместо сохранения.
    setupSwUpdate((doReload) => setReload(() => doReload))
  }, [])

  if (!reload || hidden) return null

  return (
    <div className="app-update-toast" role="status">
      <span>{t(lang, 'appUpdateReady')}</span>
      <button type="button" onClick={reload} className="app-update-toast__action">
        {t(lang, 'appUpdateAction')}
      </button>
      <button
        type="button"
        onClick={() => setHidden(true)}
        className="app-update-toast__close"
        aria-label={t(lang, 'close')}
      >
        ✕
      </button>
    </div>
  )
}
