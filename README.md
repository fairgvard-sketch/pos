# Kassa v2 — POS для кофеен и пекарен

Kassa — веб-касса для specialty coffee, кофеен и пекарен. Приложение покрывает
продажу у стойки и по столам, оплату, смены, очередь бариста, каталог, склад,
лояльность, отчёты, онлайн-заказы и бронирование.

Основное боевое устройство — терминал Sunmi-класса с Android и встроенным
термопринтером. Приоритет продукта — быстрый кассовый поток: типовой заказ
должен укладываться в три тапа, а сетевой сбой не должен останавливать работу.

Текущий технический baseline: версия `1.1.0`, миграции `001–094`.

## Возможности

- продажа у стойки: варианты, модификаторы, скидки, чаевые и смешанная оплата;
- зал: зоны, визуальный конструктор, открытые счета, дозаказ и перенос/объединение столов;
- смены, X/Z-отчёты, движение наличных и табель сотрудников;
- очередь бариста с Realtime и действием «1 тап = готово»;
- каталог, стоп-лист, складской журнал, приход, списание и инвентаризация;
- возвраты, частичные возвраты, фискальная нумерация и чеки на иврите;
- лояльность по штампам или баллам;
- онлайн-заказы и публичная страница `/order/:locId`;
- заявки и мгновенное бронирование на `/reserve/:locId`;
- офлайн-продажи с локальным чеком и идемпотентной синхронизацией;
- PWA и Android APK с тихой печатью на встроенный принтер Sunmi.

## Документация

| Документ | Что внутри |
|---|---|
| [Архитектура](docs/architecture.md) | слои приложения, модули, маршруты, авторизация и хранение состояния |
| [Разработка](docs/development.md) | локальный запуск, команды, соглашения, тесты и добавление новых функций |
| [База данных](docs/database.md) | таблицы, RLS, RPC, миграции, Edge Functions и правила финансовых данных |
| [Офлайн-режим](docs/offline.md) | read-кэш, outbox, replay, scope-изоляция и восстановление после ошибок |
| [Android и печать](docs/android-printing.md) | WebView-обёртка, ESC/POS, JS-мост, RawBT и совместимость терминалов |
| [Выпуск и эксплуатация](docs/deployment.md) | порядок деплоя, project-ref guard, CI/CD, откат и release checklist |
| [Бэкапы и восстановление](docs/backups.md) | PITR, логический дамп `db:dump`, runbook восстановления и журнал прогонов |
| [Онлайн-заказы](docs/online-orders.md) | гостевой сценарий и настройка приёма заказов |
| [Бронирование](docs/reservations.md) | ручные заявки, live-доступность и мгновенное подтверждение |
| [Smoke-test T2](docs/t2-smoke-test.md) | обязательный ручной прогон на реальном терминале |
| [План Cardcom](docs/cardcom-plan.md) | будущая EMV-интеграция и текущие ограничения |
| [Соответствие требованиям Израиля](docs/israel-compliance.md) | официальные источники, матрица пробелов, cash guard, Uniform Format и release-gates |

Правила для разработчиков и AI-агентов находятся в [AGENTS.md](AGENTS.md).
Каталог `legacy/` используется только как справочник — переносить оттуда код
напрямую нельзя.

## Стек

- frontend: React 19, TypeScript, Tailwind CSS 3, React Router 7;
- данные и состояние: React Query 5, Zustand 5;
- backend: Supabase PostgreSQL, Auth, RLS и Realtime;
- публичные API: Supabase Edge Functions на Deno;
- сборка: Vite 8, PWA и legacy-бандл;
- Android: Kotlin WebView и Sunmi printer library;
- тесты: Vitest, Testing Library и pgTAP.

## Быстрый запуск

Рекомендуется Node.js 22 — эта же версия используется в CI.

```bash
npm install
cp .env.example .env
npm run dev
```

Заполните `.env`:

```env
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
```

Во frontend разрешён только `anon`-ключ. `service_role` используется только
в серверных Edge Functions и никогда не попадает в Vite-переменные.

Перед коммитом:

```bash
npm run lint
npm run test:run
npm run build
npm run check:bundle
```

## Команды

| Команда | Назначение |
|---|---|
| `npm run dev` | локальный Vite-сервер |
| `npm run build` | проверка TypeScript и production-сборка |
| `npm run check:bundle` | лимит gzip-размера modern/legacy startup JS после build |
| `npm run preview` | локальный просмотр production-сборки |
| `npm run lint` | ESLint для `src/` и `scripts/` |
| `npm run test` | Vitest в watch-режиме |
| `npm run test:run` | один полный прогон Vitest |
| `npm run check:ref` | проверка целевого Supabase project ref |
| `npm run db:push` | проверка ref и применение миграций |
| `npm run functions:deploy` | проверка ref и деплой Edge Functions |

SQL-интеграционные тесты запускаются отдельно:

```bash
supabase start
supabase db reset
supabase test db
```

Подробнее: [supabase/tests/README.md](supabase/tests/README.md).

## Неподвижные правила

1. Все суммы хранятся целыми агоротами. Перевод в шекели выполняется только
   при отображении через `src/lib/money.ts`.
2. Финансовые записи не удаляются и не переписываются. Отмена, скидка и
   возврат оформляются отдельной операцией с сохранением аудита.
3. Каждая доменная запись скоупится по `org_id`; реальная граница доступа — RLS.
4. Итоги, НДС и скидки снапшотятся в заказ в момент операции.
5. Денежные мутации идемпотентны и используют UUID, созданный клиентом.
6. Интерфейс работает optimistic-first и не ждёт сеть в горячем потоке.

## Важные ограничения

- Legacy-бандл компилируется для Chrome 52, но runtime-гейт требует CSS Grid,
  CSS variables, Proxy, Map/Set и fetch. Для отсутствующего в Chrome 57–83
  `flex-gap` включается CSS-fallback. Stock Chrome 52 всё ещё обычно не проходит
  из-за Grid: перед эксплуатацией обязателен реальный smoke-test, а лучше
  обновление системного WebView.
- Cardcom ещё не интегрирован. `cardcom-payment` намеренно возвращает `503`/`501`
  и не является платёжным endpoint. Карточная оплата пока фиксируется после
  проведения на отдельном терминале.
- Не все административные действия доступны офлайн. Гарантированный offline
  scope перечислен в [документации офлайн-режима](docs/offline.md).

## Выпуск

Целевой Supabase-проект: `qgmnxrgtlpyqglwqmsej`. Миграции применяются строго
по порядку и до frontend-деплоя, если новый клиент использует новые RPC.

Короткая последовательность:

1. `npm run lint && npm run test:run && npm run build && npm run check:bundle`;
2. `npm run db:push` для новых миграций;
3. `npm run functions:deploy` для изменённых функций;
4. frontend-деплой;
5. ручной [smoke-test на терминале](docs/t2-smoke-test.md).

Полная процедура и правила отката описаны в [docs/deployment.md](docs/deployment.md).
