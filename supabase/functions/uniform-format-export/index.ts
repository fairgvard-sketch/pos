/**
 * uniform-format-export — формирование набора Единого формата 1.31
 * (INI.TXT + BKMVDATA.TXT в zip) за период. Генерация только
 * server-side: старый WebView кассы для этого непригоден
 * (docs/israel-compliance.md).
 *
 * POST { staff_session, from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
 *   → { ini_base64, bkmvdata_zip_base64, control_report, total_records,
 *       record_counts, business, range } | { error }
 *
 * Авторизация: запрос выполняется под JWT устройства (заголовок
 * Authorization пробрасывается в PostgREST) + staff-сессия с правом
 * 'manage' проверяется в БД (require_staff_perm). service_role здесь
 * не используется — данные скоупит RLS/auth_org_id().
 *
 * Деплой: supabase functions deploy uniform-format-export
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts'
import { zipSync } from 'npm:fflate@0.8.2'
import { buildExport } from '../_shared/uniform-format/build.ts'
import type { ExportConfig, ExportDocument } from '../_shared/uniform-format/build.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const PAGE_LIMIT = 200
/** Предохранитель: больше этого числа документов за одну выгрузку не собираем. */
const MAX_DOCUMENTS = 100_000

/** 15-значный уникальный ID набора (מספר מזהה קבוע ואחיד). */
function generatePrimaryId(): number {
  const buf = new Uint32Array(2)
  crypto.getRandomValues(buf)
  // Стабильно 15 знаков в пределах safe integer: 1 + 7 + 7 случайных цифр
  return 100_000_000_000_000 + (buf[0] % 9_000_000) * 10_000_000 + (buf[1] % 10_000_000)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)

  let body: { staff_session?: string; from?: string; to?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad_request' }, 400)
  }
  const { staff_session, from, to } = body
  if (!staff_session || !DATE_RE.test(from ?? '') || !DATE_RE.test(to ?? '')) {
    return json({ error: 'bad_request' }, 400)
  }

  // Клиент под JWT устройства: RLS и auth_org_id() работают как на кассе
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  )

  // Реквизиты бизнеса (заодно проверяет staff-право до тяжёлой выборки)
  const info = await supabase.rpc('uf_export_info', { p_staff_session: staff_session })
  if (info.error) {
    const forbidden =
      info.error.message.includes('forbidden') || info.error.message.includes('staff session')
    return json({ error: forbidden ? 'forbidden' : 'info_failed' }, forbidden ? 403 : 500)
  }
  const business = info.data as {
    business_name: string | null
    address: string | null
    tax_id: string | null
    location_id: string
  }
  const taxId = Number((business.tax_id ?? '').replace(/\D/g, ''))
  if (!taxId) return json({ error: 'missing_tax_id' }, 422) // заполнить в Настройки → Чек

  // Постраничная выборка ленты документов
  const documents: ExportDocument[] = []
  let afterTs: string | null = null
  let afterId: string | null = null
  for (;;) {
    const page = await supabase.rpc('uf_export_documents', {
      p_staff_session: staff_session,
      p_from: from,
      p_to: to,
      p_after_ts: afterTs,
      p_after_id: afterId,
      p_limit: PAGE_LIMIT,
    })
    if (page.error) return json({ error: 'query_failed' }, 500)
    const rows = (page.data?.documents ?? []) as ({ kind: string; ts: string; id: string } & Record<
      string,
      unknown
    >)[]
    for (const row of rows) {
      documents.push(
        row.kind === 'order'
          ? ({ kind: 'order', row } as unknown as ExportDocument)
          : ({ kind: 'refund', row } as unknown as ExportDocument),
      )
    }
    if (rows.length < PAGE_LIMIT) break
    if (documents.length > MAX_DOCUMENTS) return json({ error: 'range_too_large' }, 422)
    afterTs = rows[rows.length - 1].ts
    afterId = rows[rows.length - 1].id
  }

  const cfg: ExportConfig = {
    taxId,
    primaryId: generatePrimaryId(),
    branchId: '', // одна точка в наборе — филиалы не размечаем
    softwareRegistration: 0, // до получения свидетельства регистрации
    softwareName: 'Kassa',
    softwareVersion: '1.1.0',
    vendorTaxId: taxId,
    vendorName: business.business_name ?? 'Kassa',
    businessName: business.business_name ?? '',
    businessStreet: business.address ?? '',
    taxYear: Number(from!.slice(0, 4)),
    rangeStart: from!.replaceAll('-', ''),
    rangeEnd: to!.replaceAll('-', ''),
    processedAt: new Date().toISOString(),
    outputPath: 'OPENFRMT',
    archiverName: 'zip',
  }

  try {
    const result = buildExport(cfg, documents)
    const zip = zipSync({ 'BKMVDATA.TXT': result.bkmvdata })
    return json({
      ini_base64: encodeBase64(result.ini),
      bkmvdata_zip_base64: encodeBase64(zip),
      control_report: result.controlReport,
      total_records: result.totalRecords,
      record_counts: result.recordCounts,
      business: { name: business.business_name, tax_id: taxId },
      range: { from, to },
    })
  } catch (e) {
    // Съедаем детали: в записях — фискальные данные, в лог им нельзя
    const message = e instanceof Error && e.message.startsWith('uf_') ? e.message : 'build_failed'
    return json({ error: message }, 500)
  }
})
