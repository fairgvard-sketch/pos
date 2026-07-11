import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { useLangStore } from '../../../store/langStore'
import { t } from '../../../lib/i18n'
import { updateLocationProfile, updateDevicePassword } from '../../auth/api'
import { uploadItemImage } from '../../menu/api'
import { Group, Field } from '../ui'
import type { Location } from '../../../types'

/**
 * Профиль заведения (052): логотип (аватар), название заведения и точки,
 * пароль аккаунта устройства. Открывается тапом по карточке точки.
 * Логотип виден в карточке настроек и на публичной странице заказа.
 */
export default function ProfileDetail({ location }: { location: Location | undefined }) {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)

  const [bizName, setBizName] = useState(location?.receipt_business_name ?? '')
  const [locName, setLocName] = useState(location?.name ?? '')
  const [pass1, setPass1] = useState('')
  const [pass2, setPass2] = useState('')

  const invalidate = () => qc.invalidateQueries({ queryKey: ['current_location'] })

  const saveNames = useMutation({
    mutationFn: () =>
      updateLocationProfile({
        name: locName.trim() || undefined,
        receipt_business_name: bizName.trim() || null,
      }),
    onSuccess: () => {
      invalidate()
      toast.success(t(lang, 'saved'))
    },
    onError: (e) => toast.error((e as Error).message),
  })

  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      const url = await uploadItemImage(file) // тот же бакет и компрессия, что у фото товаров
      await updateLocationProfile({ logo_url: url })
    },
    onSuccess: () => {
      invalidate()
      toast.success(t(lang, 'saved'))
    },
    onError: (e) => toast.error((e as Error).message),
  })

  const removeLogo = useMutation({
    mutationFn: () => updateLocationProfile({ logo_url: null }),
    onSuccess: invalidate,
    onError: (e) => toast.error((e as Error).message),
  })

  const savePassword = useMutation({
    mutationFn: () => updateDevicePassword(pass1),
    onSuccess: () => {
      setPass1('')
      setPass2('')
      toast.success(t(lang, 'passwordSaved'))
    },
    onError: (e) => toast.error((e as Error).message),
  })

  function submitPassword() {
    if (pass1.length < 6) return toast.error(t(lang, 'passwordShort'))
    if (pass1 !== pass2) return toast.error(t(lang, 'passwordMismatch'))
    savePassword.mutate()
  }

  const letter = (bizName || location?.name || '?').slice(0, 1).toUpperCase()

  return (
    <div className="space-y-6">
      {/* Логотип */}
      <section className="flex items-center gap-4">
        {location?.logo_url ? (
          <img src={location.logo_url} alt="" className="w-20 h-20 rounded-full object-cover border border-gray-100 shrink-0" />
        ) : (
          <div className="w-20 h-20 rounded-full bg-gray-900 text-white text-3xl font-bold flex items-center justify-center shrink-0">
            {letter}
          </div>
        )}
        <div>
          <div className="flex gap-2">
            <button className="btn-secondary h-11 px-4" disabled={uploadLogo.isPending} onClick={() => fileRef.current?.click()}>
              {uploadLogo.isPending ? t(lang, 'loading') : t(lang, 'uploadLogo')}
            </button>
            {location?.logo_url && (
              <button className="btn-ghost h-11 px-4" onClick={() => removeLogo.mutate()}>
                {t(lang, 'removeLogo')}
              </button>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-2">{t(lang, 'logoHint')}</p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) uploadLogo.mutate(f)
            e.target.value = ''
          }}
        />
      </section>

      {/* Названия */}
      <Group>
        <div className="px-4 py-3 space-y-3">
          <Field label={t(lang, 'bizNameLabel')} value={bizName} onChange={setBizName} />
          <p className="text-xs text-gray-500 -mt-2">{t(lang, 'bizNameHint')}</p>
          <Field label={t(lang, 'locNameLabel')} value={locName} onChange={setLocName} />
          <p className="text-xs text-gray-500 -mt-2">{t(lang, 'locNameHint')}</p>
          <button className="btn-primary h-11 px-6" disabled={saveNames.isPending} onClick={() => saveNames.mutate()}>
            {t(lang, 'save')}
          </button>
        </div>
      </Group>

      {/* Пароль аккаунта устройства */}
      <section>
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2 px-1">
          {t(lang, 'devicePasswordTitle')}
        </h3>
        <Group>
          <div className="px-4 py-3 space-y-3">
            <p className="text-xs text-gray-500">{t(lang, 'devicePasswordHint')}</p>
            <input
              className="input w-full"
              type="password"
              autoComplete="new-password"
              placeholder={t(lang, 'newPassword')}
              value={pass1}
              onChange={(e) => setPass1(e.target.value)}
            />
            <input
              className="input w-full"
              type="password"
              autoComplete="new-password"
              placeholder={t(lang, 'repeatPassword')}
              value={pass2}
              onChange={(e) => setPass2(e.target.value)}
            />
            <button className="btn-secondary h-11 px-6" disabled={savePassword.isPending || !pass1} onClick={submitPassword}>
              {t(lang, 'changePassword')}
            </button>
            <p className="text-xs text-gray-500">{t(lang, 'pinsElsewhereHint')}</p>
          </div>
        </Group>
      </section>
    </div>
  )
}
