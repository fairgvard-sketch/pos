# Kassa v2 — POS для кофеен, пекарен и specialty coffee

Перестройка с нуля (июль 2026). Старая ресторанная версия лежит в `legacy/` —
**только как референс** (модификаторы, лояльность, print-agent, i18n); не импортировать из неё код напрямую.

## Главный принцип

**Скорость рабочего процесса — приоритет №1.** Каждый экран проектируется от количества тапов:
- Типовой заказ: ≤3 тапа (товар → модификатор → оплата)
- Optimistic UI на все мутации — интерфейс никогда не ждёт сеть
- Экран бариста: 1 тап = готово, без диалогов подтверждения
- PIN-переключение сотрудника ≤2 сек (автоотправка на 4-й цифре)

## Стек

- **Frontend**: React 19, TypeScript, Tailwind CSS 3, React Query v5, Zustand v5
- **Backend**: Supabase (PostgreSQL, RLS, Realtime)
- **Сборка**: Vite 8

## Архитектурные инварианты (не нарушать)

1. **Деньги — целые агороты** (`src/lib/money.ts`). Никаких float. Конвертация в ₪ только при отображении.
2. **Никогда не удалять финансовые записи.** Void/refund/скидка — это новая запись, не UPDATE/DELETE. Аудит-трейл священен.
3. **Только anon-ключ во фронтенде.** service_role не существует для клиента. RLS — реальная защита, не декорация.
4. **org_id везде.** Каждая доменная таблица имеет org_id; RLS скоупит через `auth_org_id()` из JWT app_metadata. Схема готова к SaaS, работаем на одной точке.
5. **Totals снапшотятся в заказ** (сумма, НДС, скидки) в момент операции — не вычисляются заново из связей.
6. **Мутации идемпотентны** — client-generated UUID на операциях. Это заготовка под offline-очередь (фаза 7).

## Модель авторизации (двухуровневая)

1. **Устройство** = аккаунт Supabase Auth (email+password, вводится один раз при настройке кассы).
   `org_id`/`location_id` прописаны в `app_metadata` JWT функцией `bootstrap_org()` → их читает RLS.
2. **Сотрудник** = PIN внутри приложения. `verify_staff_pin()` (SECURITY DEFINER) сверяет bcrypt-хеш,
   PIN не покидает БД, `pin_hash` не читается клиентом (колоночные гранты).
   PIN-сессия живёт в sessionStorage (`authStore`) — закрыл браузер → касса заблокирована.

Известный компромисс: DB доверяет устройству (JWT), персональная роль сотрудника
enforced на клиенте. Ужесточение (staff-scoped токены) — после MVP.

## Доменная модель (кофейня, не ресторан)

Заказ — позиция в **очереди у стойки**, не стол:
- `daily_number` (#42 на сегодня), `type` (here/takeaway), `customer_name`
- Статусы: `open → paid → fulfilled` | `voided`
- Экран бариста — realtime-очередь по `paid`-заказам
- Номер чека — sequence в PostgreSQL (не в памяти агента!)

## Структура

```
src/
  features/
    auth/       # DeviceSetupPage (вход устройства + онбординг), PinLoginPage, ProtectedRoute, api.ts
    home/       # HomePage — хаб-плитки по ролям
  components/ui/  # LangToggle
  lib/
    supabase.ts # клиент (только anon)
    money.ts    # Agorot, formatMoney, parseMoney, percentOf
    i18n.ts     # ru/he, t(), formatDate()
  store/
    authStore.ts  # PIN-сессия сотрудника (sessionStorage)
    langStore.ts  # язык (localStorage)
  types/index.ts
supabase/migrations/
  001_foundation.sql  # orgs, locations, devices, staff; auth_org_id(); bootstrap_org(); verify_staff_pin(); create_staff(); set_staff_pin()
```

## Маршруты

| Путь | Доступ | Компонент |
|------|--------|-----------|
| `/` | — | RootRedirect (→ /setup или /pin) |
| `/setup` | — | DeviceSetupPage |
| `/pin` | сессия устройства | PinLoginPage |
| `/home` | PIN-сессия | HomePage |

## Роли

`owner` > `manager` > `barista`. Плитки menu/reports/settings видны только manager+.

## План фаз

1. ✅ Фундамент: схема, auth, каркас
2. Каталог: категории, товары, размеры, модификаторы + админка меню
3. Экран продажи (counter-flow, ≤3 тапа)
4. Оплата и смены (наличные/карта, чек, X/Z-отчёт, print-agent)
5. Очередь бариста (realtime)
6. Отчёты + лояльность
7. Offline-слой (очередь операций) + Cardcom

## Дизайн-система

Светлый минимализм (Linear/Notion-like), без ярких заливок/градиентов/эмодзи в UI.
Глобальные классы в `src/index.css`: `.btn-primary/-secondary/-danger/-success/-ghost`,
`.card`, `.card-hover`, `.input`, `.badge-*`, `.page-header`.
Шрифт Inter; карточки `rounded-2xl`; кнопки `rounded-xl`; нажатие `active:scale-[0.97]`.
Полная спека — `legacy/CLAUDE.md` раздел «Дизайн-система» (актуальна).

RTL: каждый экран оборачивается `dir={isRtl ? 'rtl' : 'ltr'}`; использовать
логические свойства (`ms-*`/`me-*`, `start`/`end`), не `ml-*`/`mr-*`.

## Запуск

```bash
npm install && npm run dev
```

```env
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Миграции применяются в SQL Editor Supabase Dashboard (или `supabase db push`) по порядку номеров.
