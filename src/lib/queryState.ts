/**
 * Критический запрос «упал и показать нечего» (P1-7): ошибка при живом
 * persist-кэше не страшна — работаем по кэшу; опасен только отказ без данных,
 * его нельзя рисовать как пустоту (пустое меню, свободный зал, «нет смены»).
 * `data === undefined` отличает отказ без кэша от честного null («смены нет»).
 */
export function failedNoCache(q: { isError: boolean; data: unknown }): boolean {
  return q.isError && q.data === undefined
}
