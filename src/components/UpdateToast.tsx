import { useEffect } from 'react'
import { useLangStore } from '../store/langStore'
import { t } from '../lib/i18n'
import { setupSwUpdate, applyUpdate, getSwDiagnostics } from '../lib/swUpdate'
import { hardReload } from '../lib/appUpdate'
import { useUpdateStore } from '../store/updateStore'

/**
 * Плашка «доступна новая версия».
 *
 * Молча перезагружать нельзя: на кассе это брошенный чек, у гостя —
 * набранная корзина. Поэтому обновляем только по нажатию.
 *
 * Два режима:
 *   • обычный — можно закрыть, вернётся при следующей находке;
 *   • обязательный (`behindSchema`) — сервер уже на схеме новее той, под
 *     которую собран этот бандл. Закрыть нельзя: работа на отставшем
 *     фронтенде — это тихие ошибки в чеках и отчётах, а не «неудобство».
 *
 * `busy` приходит снаружи: кассовая оболочка считает открытый чек и
 * незавершённые мутации, гостевая — ничего. Пока занято, кнопка
 * заблокирована с объяснением, а не молча не работает.
 */
export default function UpdateToast({ busy = false }: { busy?: boolean }) {
  const lang = useLangStore((s) => s.lang)
  const ready = useUpdateStore((s) => s.ready)
  const behindSchema = useUpdateStore((s) => s.behindSchema)
  const dismissed = useUpdateStore((s) => s.dismissed)
  const applying = useUpdateStore((s) => s.applying)
  const critical = useUpdateStore((s) => s.critical)

  useEffect(() => {
    const store = useUpdateStore.getState()
    setupSwUpdate(() => {
      const sw = getSwDiagnostics()
      if (sw.error) store.markSwError(sw.error)
      if (sw.waiting) store.markReady()
    })
  }, [])

  const blocked = busy || critical > 0
  const show = (ready || behindSchema) && (behindSchema || !dismissed)
  if (!show) return null

  async function update() {
    if (blocked || applying) return
    const store = useUpdateStore.getState()
    store.setApplying(true)
    // Обязательное обновление без ждущего воркера означает, что SW не
    // обновился сам — тогда сносим оболочку и уходим в сеть.
    if (behindSchema && !getSwDiagnostics().waiting) {
      await hardReload()
      return
    }
    applyUpdate()
  }

  return (
    <div
      className={`app-update-toast${behindSchema ? ' app-update-toast--required' : ''}`}
      role={behindSchema ? 'alert' : 'status'}
    >
      <span>
        {behindSchema ? t(lang, 'appUpdateRequired') : t(lang, 'appUpdateReady')}
        {blocked && <small className="block opacity-80">{t(lang, 'appUpdateBusy')}</small>}
      </span>
      <button
        type="button"
        onClick={() => void update()}
        disabled={blocked || applying}
        className="app-update-toast__action"
      >
        {applying ? t(lang, 'appUpdateApplying') : t(lang, 'appUpdateAction')}
      </button>
      {!behindSchema && (
        <button
          type="button"
          onClick={() => useUpdateStore.getState().dismiss()}
          className="app-update-toast__close"
          aria-label={t(lang, 'close')}
        >
          ✕
        </button>
      )}
    </div>
  )
}
