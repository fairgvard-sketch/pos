#!/usr/bin/env node
// Набор Единого формата 1.31 для официального симулятора налоговой.
//
// ТОЛЬКО ЛОКАЛЬНЫЙ СТЕК (supabase start). Шаги:
//   1. seed.sql проводит неделю продаж выдуманного бизнеса настоящими
//      функциями кассы (place_order / pay_order / issue_refund) и в той же
//      транзакции выгружает ленту той же функцией базы, что Edge Function
//      (uf_export_documents_for, постранично); транзакция откатывается;
//   2. сборка — тот же buildExport из supabase/functions/_shared/uniform-format;
//   3. validateExport проверяет готовые байты; при любой ошибке набор
//      не выдаётся (exit 1);
//   4. файлы кладутся по пути раздела 2.2: <out>/OPENFRMT/<8 цифр>.<ГГ>/<ММДДччмм>/
//      INI.TXT, BKMVDATA.TXT, BKMVDATA.zip + контрольная распечатка.
//
// Запуск:
//   UF_VENDOR_TAX_ID=<номер производителя> npm run uf:simulator -- [--out <каталог>]
// Номер производителя — личный номер владельца ANGLE, в репозиторий
// не пишется. UF_SOFTWARE_REGISTRATION — номер свидетельства, когда
// появится (до тех пор 99999999).
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildExport, generatePrimaryId } from '../../supabase/functions/_shared/uniform-format/build.ts'
import { softwareIdentity } from '../../supabase/functions/_shared/uniform-format/software.ts'
import { validateExport } from '../../supabase/functions/_shared/uniform-format/validate.ts'

const here = dirname(fileURLToPath(import.meta.url))
const DB_CONTAINER = 'supabase_db_kassa' // project_id из supabase/config.toml

const outArg = process.argv.indexOf('--out')
const outRoot = outArg > 0 ? process.argv[outArg + 1] : join(homedir(), 'Desktop', 'uf-simulator')

const env = { ...process.env, PATH: `${process.env.PATH}:${join(homedir(), '.local/bin')}` }

function psql(input) {
  return execFileSync(
    'docker',
    ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-q', '-v', 'ON_ERROR_STOP=1'],
    { env, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  ).trim()
}

// Номер производителя проверяем до любой работы с базой
const software = softwareIdentity((key) => process.env[key])

// 1–2. Тестовый бизнес, его эмитент и лента документов — одной транзакцией
// базы, которая откатывается (см. seed.sql): локальная база не меняется.
const output = psql(readFileSync(join(here, 'seed.sql'), 'utf8')).split('\n')
const seeded = JSON.parse(output.findLast((line) => line.startsWith('{')))
const { from, to, issuers } = seeded
if (issuers.count !== 1) throw new Error(`ожидался один эмитент, получено ${issuers.count}`)
const business = issuers.issuers[0]
const documents = seeded.documents.map((row) => ({ kind: row.kind, row }))

// 3. Сборка — как в Edge Function uniform-format-export
const taxId = Number(String(business.tax_id).replace(/\D/g, ''))
const result = buildExport(
  {
    taxId,
    primaryId: generatePrimaryId(),
    branchId: '',
    ...software,
    businessName: business.business_name ?? '',
    businessStreet: business.address ?? '',
    taxYear: Number(from.slice(0, 4)),
    rangeStart: from.replaceAll('-', ''),
    rangeEnd: to.replaceAll('-', ''),
    processedAt: new Date().toISOString(),
    archiverName: 'zip',
  },
  documents,
)

const check = validateExport(result.ini, result.bkmvdata)
if (!check.ok) {
  console.error(`Набор НЕ прошёл проверку (${check.errors.length} ошибок):`)
  for (const e of check.errors.slice(0, 50)) console.error('  ' + e)
  process.exit(1)
}

// 4. Файлы по пути раздела 2.2
const dir = join(outRoot, ...result.outputDir.split('\\'))
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'INI.TXT'), result.ini)
writeFileSync(join(dir, 'BKMVDATA.TXT'), result.bkmvdata)
execFileSync('zip', ['-q', '-j', '-X', join(dir, 'BKMVDATA.zip'), join(dir, 'BKMVDATA.TXT')])

const ddmmyyyy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
const shekels = (agorot) => (agorot / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })
const RECORD_NAMES = {
  A100: 'רשומת פתיחה', C100: 'כותרת מסמך', D110: 'פרטי מסמך', D120: 'פרטי קבלות', Z900: 'רשומת סיום',
}
const now = new Date()
const ilNow = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(now)

// Распечатки для заявки: приложение 4 (5.4) и контрольный отчёт 2.6
const report = [
  'הפקת קבצים במבנה אחיד עבור:',
  `מספר עוסק מורשה: ${String(taxId).padStart(9, '0')}`,
  `שם בית העסק: ${business.business_name}`,
  'ביצוע ממשק פתוח הסתיים בהצלחה.',
  `הנתונים נשמרו בנתיב הבא: ${result.outputDir}`,
  `טווח תאריכים: מתאריך ${ddmmyyyy(from)} ועד תאריך ${ddmmyyyy(to)}`,
  '',
  'פירוט סך סוגי הרשומות שנוצרו בקובץ BKMVDATA.TXT:',
  'קוד רשומה | תיאור רשומה | סך רשומות',
  ...Object.entries(result.recordCounts)
    .filter(([, n]) => n > 0)
    .map(([code, n]) => `${code} | ${RECORD_NAMES[code] ?? ''} | ${n}`),
  '',
  `הנתונים הופקו באמצעות תוכנת: ${software.softwareName} ${software.softwareVersion}, ` +
    `מספר תעודת הרישום: ${software.softwareRegistration}, בתאריך ${ilNow.replace(', ', ' בשעה: ')}`,
  '',
  '',
  'דוח בקרה — סעיף 2.6: כמות וסכום לכל סוג מסמך (נספח 1)',
  'מספר המסמך | סוג המסמך | סה"כ כמותי | סה"כ כספי (בש"ח)',
  ...result.controlReport.map((r) => `${r.docTypeCode} | ${r.name} | ${r.count} | ${shekels(r.totalIncVat)}`),
  '',
].join('\n')
writeFileSync(join(dir, 'דוח-בקרה.txt'), report)

const size = (b) => `${(b.length / 1024).toFixed(0)} KB`
console.log(`Набор готов и прошёл проверку: ${dir}`)
console.log(`  период ${from} … ${to}, бизнес ${business.business_name} (${taxId})`)
console.log(`  записей BKMVDATA: ${result.totalRecords} (${Object.entries(result.recordCounts).map(([k, v]) => `${k} ${v}`).join(', ')})`)
console.log(`  документов: ${Object.entries(check.documentCounts).map(([k, v]) => `${k}: ${v}`).join(', ')}`)
console.log(`  INI.TXT ${size(result.ini)}, BKMVDATA.TXT ${size(result.bkmvdata)}`)
