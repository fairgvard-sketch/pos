# Kassa v2 — POS для кофеен и пекарен

POS для specialty coffee / пекарен. Работает в бою на терминале **Sunmi T2 Mini**
(Android 7.1) через APK-обёртку с тихой печатью на встроенный термопринтер.
Приоритет №1 — скорость кассового потока (типовой заказ ≤3 тапа, optimistic UI,
офлайн-режим).

Подробные архитектурные инварианты и контекст — в [AGENTS.md](AGENTS.md) и
[CLAUDE.md](CLAUDE.md). Здесь — как запустить, тестировать и деплоить.

## Стек

- **Frontend**: React 19, TypeScript, Tailwind 3, React Query v5, Zustand v5, Vite 8
- **Backend**: Supabase (PostgreSQL + RLS + Realtime), Edge Functions (Deno)
- **APK-обёртка**: Kotlin WebView + Sunmi printerlibrary (`android/`)

## Запуск

```bash
npm install
npm run dev
```

`.env` (см. `.env.example`):

```env
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=...   # ТОЛЬКО anon-ключ (service_role во фронтенде запрещён)
```

## Скрипты

| Команда | Назначение |
|---------|-----------|
| `npm run dev` | Vite dev-сервер |
| `npm run build` | `tsc -b` + прод-бандл (легаси-бандл для Chrome ≥52) |
| `npm run lint` | ESLint |
| `npm run test` / `npm run test:run` | vitest (watch / один прогон) |
| `npm run check:ref` | сверить project-ref с `qgmnxrgtlpyqglwqmsej` |
| `npm run db:push` | миграции (после проверки ref) |
| `npm run functions:deploy` | Edge Functions (после проверки ref) |

## Архитектура (кратко)

- **Деньги — целые агороты** (`src/lib/money.ts`), никаких float.
- **Двухуровневая авторизация**: устройство = аккаунт Supabase Auth (org_id/
  location_id в JWT app_metadata → RLS); сотрудник = PIN (`authStore`,
  sessionStorage) + серверная staff-сессия для привилегированных RPC.
- **Финансовые записи не удаляются** — void/refund/скидка = новая запись.
- **Офлайн-слой** (`src/lib/offline/`): очередь мутаций (`outboxStore`,
  localStorage), движок replay (`drain.ts`), детекция сети (`net.ts`).
  Операции идемпотентны (client UUID → `op_log` на сервере).
  - Очередь изолирована по **scope** (`org:location:user`, `scope.ts`) —
    операции другого аккаунта карантинятся, не уходят под чужой сессией.
  - `blocked_auth` — привилегированная операция ждёт PIN, не роняет FIFO.
- **Per-device настройки** (`deviceStore` localStorage + фоновый синк в
  `devices` через `deviceSync.ts`, optimistic-first).
- **Гейт совместимости** (`capabilities.ts`) — старый WebView без Grid/flex-gap
  получает диагностический экран вместо сломанного POS.

Маршруты, роли, доменная модель — см. AGENTS.md.

## Тесты

**Frontend (vitest):**

```bash
npm run test:run
```

Покрыто: округления денег/`splitEvenly`, офлайн-идемпотентность и scope-карантин,
`drain` waiting_auth, гейт совместимости, длинный чек (высота canvas),
optimistic-откат очереди, per-device landing, паритет ключей i18n ru/he.

**SQL (pgTAP, локальный Supabase):**

```bash
supabase start && supabase db reset
supabase test db        # supabase/tests/*.sql
```

Покрыто: идемпотентность `op_log`, структура/RLS `devices`, наличие RPC 064/065.
Подробнее — [supabase/tests/README.md](supabase/tests/README.md).

## Миграции

Файлы — `supabase/migrations/NNN_*.sql`, применять **по порядку номеров** в
проект `qgmnxrgtlpyqglwqmsej` (в SQL Editor Dashboard или `npm run db:push`).
**Не редактировать уже применённые миграции** — только новые следующим номером.

`npm run db:push` / `npm run functions:deploy` сверяют project-ref перед
применением (guard `scripts/check-project-ref.mjs`).

## Android APK (Sunmi)

Обёртка в `android/`: WebView грузит прод-домен, мост `window.KassaAndroid`
печатает ESC/POS на встроенный принтер. Пересобирать APK только при изменении
моста — UI/логика обновляются деплоем Vercel.

- Сборка: GitHub Actions → **Android APK** (Gradle Wrapper, версия закреплена;
  `gradle-wrapper.jar` скачивается в CI).
- **debug ≠ release**: debug-артефакт помечен `-debug`; подписанный release
  собирается только при секретах `ANDROID_KEYSTORE_BASE64` /
  `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD`.
  Keystore **никогда** не коммитим.
- Безопасность моста: навигация только на прод-origin, внешние ссылки — во
  внешний браузер, `rawbt:` разрешён, `file:`/`content:` заблокированы.

## Печать

Чек рендерится в canvas (`printCanvas.ts`) → ESC/POS растр (`escpos.ts`).
Приоритет путей: мост APK → RawBT → браузер. Результат печати возвращается
колбэком (`printJobs.ts`): ошибка (нет бумаги/отключён) показывает тост с
кнопкой «повторить», второй экземпляр печатается только после успеха первого.

## Deployment checklist

1. `npm run lint && npm run test:run && npm run build` — зелёные.
2. **Новые миграции** применить в `qgmnxrgtlpyqglwqmsej` (`npm run db:push`)
   **до** деплоя фронтенда (новый клиент зовёт новые RPC).
3. Изменения Edge Functions — `npm run functions:deploy` (после ref-guard).
4. Фронтенд — push в `main` → Vercel (`pos-self-sigma.vercel.app`).
5. APK пересобирать только при изменении `android/` (мост).
6. На реальном T2 — прогнать [docs/t2-smoke-test.md](docs/t2-smoke-test.md).
