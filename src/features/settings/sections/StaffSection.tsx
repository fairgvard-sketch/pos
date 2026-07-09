import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchStaffList, createStaffMember, setStaffPin, updateStaffMember, isValidPin } from '../api'
import { useAuthStore } from '../../../store/authStore'
import { useLangStore } from '../../../store/langStore'
import { t } from '../../../lib/i18n'
import { Group, NavRow } from '../ui'
import type { DetailId } from '../registry'
import type { Role, Staff } from '../../../types'

/**
 * Категория «Сотрудники»: список, добавление (имя+роль+PIN), смена PIN,
 * деактивация + drill-down «Права доступа».
 * Ролевые правила (клиентские, модель авторизации доверяет устройству):
 * - владельца может править только владелец;
 * - менеджер создаёт бариста и менеджеров, роль owner доступна только владельцу;
 * - себя деактивировать нельзя.
 */
export default function StaffSection({ openDetail }: { openDetail: (id: DetailId) => void }) {
  const lang = useLangStore((s) => s.lang)
  const me = useAuthStore((s) => s.staff)
  const qc = useQueryClient()

  const { data: staff = [] } = useQuery({ queryKey: ['staff'], queryFn: fetchStaffList })

  const iAmOwner = me?.role === 'owner'
  const assignableRoles: Role[] = iAmOwner ? ['barista', 'manager', 'owner'] : ['barista', 'manager']

  // ── Форма добавления ──
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('barista')
  const [pin, setPin] = useState('')

  const create = useMutation({
    mutationFn: () => createStaffMember(name.trim(), role, pin),
    onSuccess: () => {
      setName(''); setPin(''); setRole('barista')
      qc.invalidateQueries({ queryKey: ['staff'] })
      toast.success(t(lang, 'staffAdded'))
    },
    onError: (e) => toast.error(e.message),
  })
  const canCreate = name.trim().length > 0 && isValidPin(pin) && !create.isPending

  // ── Смена PIN (одна открытая строка за раз) ──
  const [pinFor, setPinFor] = useState<string | null>(null)
  const [newPin, setNewPin] = useState('')

  const changePin = useMutation({
    mutationFn: (staffId: string) => setStaffPin(staffId, newPin),
    onSuccess: () => {
      setPinFor(null); setNewPin('')
      toast.success(t(lang, 'pinChanged'))
    },
    onError: (e) => toast.error(e.message),
  })

  const toggleActive = useMutation({
    mutationFn: (s: Staff) => updateStaffMember(s.id, { is_active: !s.is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff'] }),
    onError: (e) => toast.error(e.message),
  })

  /** Можно ли текущему пользователю править эту строку */
  function canEdit(s: Staff): boolean {
    if (s.role === 'owner' && !iAmOwner) return false
    return true
  }

  return (
    <div className="space-y-6">
      <Group>
        <NavRow label={t(lang, 'permsTitle')} hint={t(lang, 'permsHint')} onClick={() => openDetail('perms')} />
      </Group>

      <section>
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2 px-1">
          {t(lang, 'staffTitle')}
        </h3>
        <p className="text-sm text-gray-500 mb-3 px-1">{t(lang, 'staffHint')}</p>

        {/* Список */}
        <div className="space-y-2 mb-6">
          {staff.map((s) => {
            const isMe = s.id === me?.id
            const editable = canEdit(s)
            return (
              <div
                key={s.id}
                className={`rounded-2xl border border-gray-200 p-4 ${s.is_active ? '' : 'opacity-60'}`}
              >
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-gray-900 truncate">
                      {s.name}
                      {isMe && <span className="text-gray-400 font-medium text-sm"> · {t(lang, 'itsYou')}</span>}
                    </div>
                    <div className="text-sm text-gray-500 flex items-center gap-2">
                      {t(lang, s.role)}
                      {!s.is_active && (
                        <span className="badge-gray">{t(lang, 'staffInactive')}</span>
                      )}
                    </div>
                  </div>

                  {editable && (
                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={() => { setPinFor(pinFor === s.id ? null : s.id); setNewPin('') }}
                        className="btn-secondary !py-2 !px-3 !text-xs"
                      >
                        {t(lang, 'changePin')}
                      </button>
                      {!isMe && (
                        <button
                          onClick={() => toggleActive.mutate(s)}
                          disabled={toggleActive.isPending}
                          className={`!py-2 !px-3 !text-xs ${s.is_active ? 'btn-ghost' : 'btn-secondary'}`}
                        >
                          {s.is_active ? t(lang, 'deactivate') : t(lang, 'activate')}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Инлайн-форма смены PIN */}
                {pinFor === s.id && (
                  <div className="flex gap-2 mt-3 pt-3 border-t border-gray-100">
                    <input
                      className="input !py-2 max-w-[160px] tabular-nums"
                      inputMode="numeric"
                      autoFocus
                      placeholder={`${t(lang, 'newPin')} · ${t(lang, 'pinFormatHint')}`}
                      value={newPin}
                      onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                      onKeyDown={(e) => e.key === 'Enter' && isValidPin(newPin) && changePin.mutate(s.id)}
                    />
                    <button
                      onClick={() => changePin.mutate(s.id)}
                      disabled={!isValidPin(newPin) || changePin.isPending}
                      className="btn-primary !py-2 !px-4"
                    >
                      {t(lang, 'save')}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Добавление */}
        <h3 className="text-sm font-bold text-gray-900 mb-3">{t(lang, 'addStaff')}</h3>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">
              {t(lang, 'staffName')}
            </span>
            <input className="input !py-2 max-w-[180px]" value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <label className="block">
            <span className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">
              {t(lang, 'staffRole')}
            </span>
            <div className="flex rounded-xl border border-gray-100 bg-gray-50 p-0.5 gap-0.5 h-[42px]">
              {assignableRoles.map((r) => (
                <button
                  key={r}
                  onClick={() => setRole(r)}
                  className={`px-3 rounded-lg text-xs font-semibold transition-all ${
                    role === r
                      ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {t(lang, r)}
                </button>
              ))}
            </div>
          </label>

          <label className="block">
            <span className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">
              {t(lang, 'staffPin')} · {t(lang, 'pinFormatHint')}
            </span>
            <input
              className="input !py-2 max-w-[140px] tabular-nums"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
              onKeyDown={(e) => e.key === 'Enter' && canCreate && create.mutate()}
            />
          </label>

          <button onClick={() => create.mutate()} disabled={!canCreate} className="btn-primary !py-2.5 !px-5">
            {t(lang, 'addStaff')}
          </button>
        </div>
      </section>
    </div>
  )
}
