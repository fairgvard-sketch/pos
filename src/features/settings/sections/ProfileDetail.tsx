import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { useLangStore } from '../../../store/langStore'
import { t } from '../../../lib/i18n'
import { updateLocationProfile, updateDevicePassword } from '../../auth/api'
import { uploadItemImage } from '../../menu/api'
import { supabase } from '../../../lib/supabase'
import { Group, Field, InputRow, NavRow } from '../ui'
import type { Location } from '../../../types'

/**
 * Профиль заведения (052): логотип (аватар), название заведения и точки.
 * Плюс аккаунт входа и смена его пароля (единственное место).
 * Открывается тапом по карточке точки. Логотип виден в карточке настроек
 * и на публичной странице заказа.
 */
export default function ProfileDetail({ location }: { location: Location | undefined }) {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)

  // Отображаемое имя (карточка настроек + гостевая страница). Живёт в
  // settings.display_name и НЕ трогает receipt_business_name (шапку чека) —
  // старое значение из чека подставляется как стартовое.
  const [bizName, setBizName] = useState(
    location?.settings?.display_name ?? location?.receipt_business_name ?? ''
  )
  // Аккаунт входа (email Supabase Auth) и смена его пароля — единственное место
  const [email, setEmail] = useState<string | null>(null)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user.email ?? null))
  }, [])
  const [pwOpen, setPwOpen] = useState(false)
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const pwValid = pw1.length >= 6 && pw1 === pw2
  const changePw = useMutation({
    mutationFn: () => updateDevicePassword(pw1),
    onSuccess: () => {
      setPwOpen(false); setPw1(''); setPw2('')
      toast.success(t(lang, 'passwordSaved'))
    },
    onError: (e) => toast.error((e as Error).message),
  })
  const [locName, setLocName] = useState(location?.name ?? '')

  const invalidate = () => qc.invalidateQueries({ queryKey: ['current_location'] })

  const saveNames = useMutation({
    mutationFn: () =>
      updateLocationProfile({
        name: locName.trim() || undefined,
        settings: { ...location?.settings, display_name: bizName.trim() || null },
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

      {/* Аккаунт и пароль входа — здесь, а не в «Устройстве» */}
      <section>
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2 px-1">
          {t(lang, 'devicePasswordTitle')}
        </h3>
        <Group>
          <InputRow label={t(lang, 'deviceAccount')}>
            <span className="text-sm text-gray-500 truncate max-w-[220px]">{email ?? '…'}</span>
          </InputRow>
          <div>
            <NavRow
              label={t(lang, 'changePassword')}
              hint={t(lang, 'devicePasswordHint')}
              onClick={() => { setPwOpen((v) => !v); setPw1(''); setPw2('') }}
            />
            {pwOpen && (
              <div className="px-4 pb-4 pt-1 space-y-2">
                <input
                  type="password" className="input !py-2" autoFocus autoComplete="new-password"
                  placeholder={t(lang, 'newPassword')} value={pw1}
                  onChange={(e) => setPw1(e.target.value)}
                />
                <input
                  type="password" className="input !py-2" autoComplete="new-password"
                  placeholder={t(lang, 'repeatPassword')} value={pw2}
                  onChange={(e) => setPw2(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && pwValid && changePw.mutate()}
                />
                {pw1.length > 0 && pw1.length < 6 && <p className="text-xs text-amber-600">{t(lang, 'passwordShort')}</p>}
                {pw2.length > 0 && pw1 !== pw2 && <p className="text-xs text-red-500">{t(lang, 'passwordMismatch')}</p>}
                <button
                  onClick={() => changePw.mutate()}
                  disabled={!pwValid || changePw.isPending}
                  className="btn-primary !py-2.5 !px-6"
                >
                  {t(lang, 'save')}
                </button>
              </div>
            )}
          </div>
        </Group>
      </section>
    </div>
  )
}
