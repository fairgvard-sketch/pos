import { useState } from 'react'
import { supabase } from '../../../lib/supabase'
import { currentStaffToken } from '../../../store/authStore'
import { useLangStore } from '../../../store/langStore'
import { t } from '../../../lib/i18n'
import { formatMoney } from '../../../lib/money'
import { Group } from '../ui'

/** Названия типов документов Единого формата — всегда на иврите, как в документах. */
const DOC_TYPE_NAMES: Record<number, string> = {
  305: 'חשבונית מס',
  320: 'חשבונית מס/קבלה',
  330: 'חשבונית מס זיכוי',
  400: 'קבלה',
}

interface ExportResponse {
  ini_base64: string
  bkmvdata_zip_base64: string
  control_report: { docTypeCode: number; count: number; totalIncVat: number }[]
  total_records: number
  range: { from: string; to: string }
}

/** Прошлый календарный месяц — типовой отчётный период по умолчанию. */
function previousMonthRange(): { from: string; to: string } {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const last = new Date(now.getFullYear(), now.getMonth(), 0)
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from: iso(first), to: iso(last) }
}

function downloadBase64(filename: string, base64: string, mime: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Выгрузка Единого формата 1.31 (מבנה אחיד) для налоговой.
 * Формирование — server-side (Edge Function); здесь только период,
 * скачивание INI.TXT/BKMVDATA.zip и контрольный отчёт (раздел 2.6).
 */
export default function UfExportDetail() {
  const lang = useLangStore((s) => s.lang)
  const defaults = previousMonthRange()
  const [from, setFrom] = useState(defaults.from)
  const [to, setTo] = useState(defaults.to)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ExportResponse | null>(null)

  async function generate() {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { data, error: fnError } = await supabase.functions.invoke('uniform-format-export', {
        body: { staff_session: currentStaffToken(), from, to },
      })
      if (fnError) {
        // Тело ошибки Edge Function содержит машинный код причины
        const ctx = await (fnError as { context?: Response }).context?.json?.().catch(() => null)
        setError(ctx?.error === 'missing_tax_id' ? 'ufExportMissingTaxId' : 'ufExportError')
        return
      }
      setResult(data as ExportResponse)
    } catch {
      setError('ufExportError')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-500">{t(lang, 'ufExportHint')}</p>

      <Group>
        <div className="p-4 space-y-4">
          <div className="flex gap-3 items-end">
            <label className="flex-1">
              <span className="block text-xs font-semibold text-gray-500 mb-1">
                {t(lang, 'ufExportFrom')}
              </span>
              <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="flex-1">
              <span className="block text-xs font-semibold text-gray-500 mb-1">
                {t(lang, 'ufExportTo')}
              </span>
              <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>

          <button
            onClick={generate}
            disabled={busy || !from || !to || from > to}
            className="btn-primary w-full !py-3 disabled:opacity-40"
          >
            {busy ? t(lang, 'ufExportBusy') : t(lang, 'ufExportGenerate')}
          </button>

          {error && <p className="text-sm text-red-600">{t(lang, error as never)}</p>}
        </div>
      </Group>

      {result && (
        <>
          <Group title={t(lang, 'ufExportFiles')}>
            <div className="p-4 flex gap-3">
              <button
                onClick={() => downloadBase64('INI.TXT', result.ini_base64, 'text/plain')}
                className="btn-secondary flex-1"
              >
                INI.TXT
              </button>
              <button
                onClick={() => downloadBase64('BKMVDATA.zip', result.bkmvdata_zip_base64, 'application/zip')}
                className="btn-secondary flex-1"
              >
                BKMVDATA.zip
              </button>
            </div>
            <p className="px-4 pb-3 text-xs text-gray-500">
              {t(lang, 'ufExportRecords')}: <span className="font-bold tabular-nums">{result.total_records}</span>
              {' · '}{result.range.from} — {result.range.to}
            </p>
          </Group>

          <Group title={t(lang, 'ufExportControlReport')}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-400 uppercase tracking-wide">
                  <th className="text-start px-4 py-2 font-semibold">{t(lang, 'ufExportDocType')}</th>
                  <th className="text-end px-4 py-2 font-semibold">{t(lang, 'ufExportCount')}</th>
                  <th className="text-end px-4 py-2 font-semibold">{t(lang, 'ufExportSum')}</th>
                </tr>
              </thead>
              <tbody>
                {result.control_report.map((row) => (
                  <tr key={row.docTypeCode} className="border-t border-gray-100">
                    <td className="px-4 py-2.5 text-gray-900">
                      {row.docTypeCode} · {DOC_TYPE_NAMES[row.docTypeCode] ?? ''}
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums text-gray-900">{row.count}</td>
                    <td className="px-4 py-2.5 text-end tabular-nums font-semibold text-gray-900">
                      {formatMoney(row.totalIncVat, lang)}
                    </td>
                  </tr>
                ))}
                {result.control_report.length === 0 && (
                  <tr className="border-t border-gray-100">
                    <td colSpan={3} className="px-4 py-4 text-center text-gray-500">
                      {t(lang, 'ufExportEmpty')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Group>
        </>
      )}
    </div>
  )
}
