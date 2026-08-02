import { useIsMutating } from '@tanstack/react-query'
import { useCartStore } from '../store/cartStore'
import UpdateToast from './UpdateToast'

/**
 * Плашка обновления для кассы: та же, что у гостя, но с кассовым
 * определением «сейчас нельзя».
 *
 * Занято = есть незакрытый чек в корзине или летит мутация. Мутации сюда
 * попадают все разом (`useIsMutating`), и это правильнее списка флагов по
 * местам вызова: оплата, отправка на кухню, открытие смены и возврат
 * одинаково не переживут перезагрузки, а забыть проставить флаг в новом
 * месте — вопрос времени.
 */
export default function PosUpdateToast() {
  const mutating = useIsMutating()
  const lines = useCartStore((s) => s.lines)
  return <UpdateToast busy={mutating > 0 || lines.length > 0} />
}
