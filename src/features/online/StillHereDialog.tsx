import type { Lang } from '../../lib/i18n'
import { t } from '../../lib/i18n'

/**
 * «Вы ещё здесь?» — киоск-режим (см. useIdleReset).
 *
 * Единственный случай в гостевом сценарии, где перекрытие оправдано:
 * вопрос обязан быть замечен, иначе через 20 секунд экран сбросится.
 * Отсчёт показан цифрой — гость видит, сколько осталось, и это не
 * выглядит внезапным.
 */
export default function StillHereDialog({ lang, secondsLeft, onStay }: {
  lang: Lang
  secondsLeft: number
  onStay: () => void
}) {
  return (
    <div className="public-menu-idle" role="alertdialog" aria-modal="true" aria-labelledby="idle-title">
      <div className="public-menu-idle-card">
        <h2 id="idle-title">{t(lang, 'pubStillHere')}</h2>
        <p>{t(lang, 'pubStillHereHint').replace('{sec}', String(secondsLeft))}</p>
        <button type="button" onClick={onStay} autoFocus>
          {t(lang, 'pubStillHereYes')}
        </button>
      </div>
    </div>
  )
}
