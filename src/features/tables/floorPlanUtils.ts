/** Следующее имя стола продолжает числовую схему зоны: 6→7, T6→T7. */
export function nextTableLabel(tables: { label: string }[]): string {
  const numbered = tables
    .map((table) => /^(.*?)(\d+)$/.exec(table.label.trim()))
    .filter((match): match is RegExpExecArray => match !== null)

  if (numbered.length > 0) {
    const prefix = numbered[0][1]
    const sameSeries = numbered.filter((match) => match[1] === prefix)
    if (sameSeries.length === numbered.length) {
      const max = Math.max(...sameSeries.map((match) => Number.parseInt(match[2], 10)))
      return `${prefix}${max + 1}`
    }
  }

  return String(tables.length + 1)
}
