import { useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  fetchSupplyDocs, fetchDocLines, fetchSuppliers, upsertSupplier, setSupplierActive,
  DOCS_PAGE, type Supplier, type SupplyDoc,
} from './api'
import { useLangStore } from '../../store/langStore'
import { t, formatTime } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'

/**
 * Поставки (077): лента приходных накладных — когда, от кого, на какую
 * сумму. Строки документа — строки журнала его batch_id, разворачиваются
 * по тапу. Отсюда же ведётся справочник поставщиков.
 */
export default function SupplyDocsTab({ canManage }: { canManage: boolean }) {
  const lang = useLangStore((s) => s.lang)
  const locale = lang === 'he' ? 'he-IL' : 'ru-RU'
  const [openDocId, setOpenDocId] = useState<string | null>(null)
  const [showSuppliers, setShowSuppliers] = useState(false)

  const docs = useInfiniteQuery({
    queryKey: ['supply_docs'],
    queryFn: ({ pageParam }) => fetchSupplyDocs(pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === DOCS_PAGE ? allPages.length * DOCS_PAGE : undefined,
  })
  const rows: SupplyDoc[] = (docs.data?.pages ?? []).flat()

  function docTime(iso: string): string {
    const d = new Date(iso)
    return `${d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} ${formatTime(iso, lang)}`
  }

  return (
    <div>
      {canManage && (
        <div className="mb-4">
          <button onClick={() => setShowSuppliers(true)} className="btn-secondary">
            {t(lang, 'suppliersTitle')}
          </button>
        </div>
      )}

      {rows.length === 0 && !docs.isLoading ? (
        <div className="text-center py-16 text-sm text-gray-500">{t(lang, 'docsEmpty')}</div>
      ) : (
        <div>
          {rows.map((d) => (
            <div key={d.id} className="border-b border-gray-100">
              <button
                onClick={() => setOpenDocId((v) => (v === d.id ? null : d.id))}
                className="w-full flex items-center gap-3 min-h-[48px] text-sm text-start"
              >
                <span className="w-28 shrink-0 text-gray-500 tabular-nums text-xs">{docTime(d.created_at)}</span>
                <span className="flex-1 min-w-0 truncate text-gray-900 font-semibold">
                  <bdi>{d.supplier?.name ?? t(lang, 'supplierNone')}</bdi>
                  {d.doc_no && <span className="font-normal text-gray-400"> · {d.doc_no}</span>}
                  {d.note && <span className="font-normal text-gray-400"> · {d.note}</span>}
                </span>
                <span className="w-24 shrink-0 text-end text-xs text-gray-400 truncate">{d.staff?.name ?? ''}</span>
                <span className="w-24 shrink-0 text-end font-bold tabular-nums text-gray-900">
                  {d.total > 0 ? formatMoney(d.total, lang) : '—'}
                </span>
              </button>
              {openDocId === d.id && <DocLines docId={d.id} />}
            </div>
          ))}
          {docs.hasNextPage && (
            <button
              onClick={() => docs.fetchNextPage()}
              disabled={docs.isFetchingNextPage}
              className="btn-secondary w-full mt-4 disabled:opacity-40"
            >
              {t(lang, 'loadMore')}
            </button>
          )}
        </div>
      )}

      {showSuppliers && <SuppliersSheet onClose={() => setShowSuppliers(false)} />}
    </div>
  )
}

/** Строки накладной: позиция, количество, цена закупки, сумма строки */
function DocLines({ docId }: { docId: string }) {
  const lang = useLangStore((s) => s.lang)
  const { data: lines = [], isLoading } = useQuery({
    queryKey: ['supply_doc_lines', docId],
    queryFn: () => fetchDocLines(docId),
  })
  if (isLoading) return null
  return (
    <div className="pb-2 ps-28">
      {lines.map((l) => (
        <div key={l.id} className="flex items-center gap-3 min-h-[36px] text-sm">
          <span className="flex-1 min-w-0 truncate text-gray-900"><bdi>{l.name}</bdi></span>
          <span className="w-20 shrink-0 text-end tabular-nums text-gray-900">+{l.qty_delta}</span>
          <span className="w-24 shrink-0 text-end tabular-nums text-xs text-gray-400">
            {l.unit_cost != null ? formatMoney(l.unit_cost, lang) : ''}
          </span>
          <span className="w-24 shrink-0 text-end tabular-nums text-gray-500">
            {l.value != null ? formatMoney(l.value, lang) : '—'}
          </span>
        </div>
      ))}
    </div>
  )
}

/** Справочник поставщиков: добавить, переименовать, скрыть */
function SuppliersSheet({ onClose }: { onClose: () => void }) {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const qc = useQueryClient()
  const { data: suppliers = [] } = useQuery({ queryKey: ['suppliers'], queryFn: fetchSuppliers })

  const [editing, setEditing] = useState<Supplier | null>(null)
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')

  const save = useMutation({
    mutationFn: (p: { id: string | null; name: string; phone: string | null }) =>
      upsertSupplier(p.id, p.name, p.phone),
    onSuccess: () => {
      setEditing(null)
      setNewName('')
      setNewPhone('')
      qc.invalidateQueries({ queryKey: ['suppliers'] })
    },
    onError: (e) => toast.error(e.message),
  })
  const deactivate = useMutation({
    mutationFn: (id: string) => setSupplierActive(id, false),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['suppliers'] }),
    onError: (e) => toast.error(e.message),
  })

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-md p-6 max-h-[92vh] overflow-y-auto animate-[rise-in_0.2s_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-4">
          <h2 className="flex-1 text-lg font-black text-gray-900">{t(lang, 'suppliersTitle')}</h2>
          <button
            onClick={onClose}
            aria-label={t(lang, 'close')}
            className="w-11 h-11 rounded-xl hover:bg-gray-100 active:scale-[0.97] flex items-center justify-center text-xl text-gray-500"
          >
            ✕
          </button>
        </div>

        {suppliers.length === 0 && (
          <div className="text-sm text-gray-400 py-2">{t(lang, 'suppliersEmpty')}</div>
        )}
        {suppliers.map((s) => (
          <div key={s.id} className="flex items-center gap-2 min-h-[48px] border-b border-gray-100">
            {editing?.id === s.id ? (
              <>
                <input
                  className="input !py-2 flex-1 text-sm"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  autoFocus
                />
                <input
                  className="input !py-2 !w-32 text-sm"
                  inputMode="tel"
                  placeholder={t(lang, 'supplierPhonePh')}
                  value={editing.phone ?? ''}
                  onChange={(e) => setEditing({ ...editing, phone: e.target.value })}
                />
                <button
                  onClick={() => save.mutate({ id: s.id, name: editing.name, phone: editing.phone })}
                  disabled={save.isPending || editing.name.trim() === ''}
                  className="btn-primary !py-2 !px-4 disabled:opacity-40"
                >
                  {t(lang, 'save')}
                </button>
              </>
            ) : (
              <>
                <span className="flex-1 min-w-0 truncate text-sm text-gray-900">
                  <bdi>{s.name}</bdi>
                  {s.phone && <span className="text-gray-400 tabular-nums"> · {s.phone}</span>}
                </span>
                <button
                  onClick={() => setEditing(s)}
                  aria-label={t(lang, 'edit')}
                  className="w-8 h-8 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-700"
                >
                  ✎
                </button>
                <button
                  onClick={() => { if (confirm(t(lang, 'supplierDeactivateConfirm'))) deactivate.mutate(s.id) }}
                  aria-label={t(lang, 'delete')}
                  className="w-8 h-8 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-red-600"
                >
                  ✕
                </button>
              </>
            )}
          </div>
        ))}

        <div className="flex items-center gap-2 mt-4">
          <input
            className="input !py-2 flex-1 text-sm"
            placeholder={t(lang, 'supplierNamePh')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            className="input !py-2 !w-32 text-sm"
            inputMode="tel"
            placeholder={t(lang, 'supplierPhonePh')}
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value)}
          />
          <button
            onClick={() => save.mutate({ id: null, name: newName.trim(), phone: newPhone.trim() || null })}
            disabled={save.isPending || newName.trim() === ''}
            className="btn-primary !py-2 !px-4 disabled:opacity-40"
          >
            {t(lang, 'add')}
          </button>
        </div>
      </div>
    </div>
  )
}
