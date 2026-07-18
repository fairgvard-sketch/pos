# Разработка

## Требования

- Node.js 22 и npm;
- Git;
- Supabase CLI и Docker — только для локального Postgres и pgTAP;
- Android Studio или JDK 17 — только при изменении APK-обёртки.

Node 22 рекомендуется потому, что он закреплён в GitHub Actions. Это уменьшает
расхождения между локальной и CI-сборкой.

## Первый запуск

```bash
git clone <repository-url>
cd kassa
npm install
cp .env.example .env
```

В `.env` нужны две frontend-переменные:

```env
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
```

Не добавляйте в `.env` и тем более в `VITE_*` переменные `service_role`.
Любая переменная Vite встраивается в клиентский bundle.

Запуск:

```bash
npm run dev
```

Production-сборка локально:

```bash
npm run build
npm run preview
```

## Структура репозитория

```text
src/
  components/          общие компоненты и error boundaries
  features/            пользовательские сценарии и их API
  lib/                 Supabase, деньги, offline, печать, i18n
  store/               Zustand stores
  types/               доменные и глобальные TypeScript-типы
supabase/
  migrations/          последовательная схема и RPC
  functions/           Deno Edge Functions
  tests/               pgTAP-интеграционные тесты
android/                Kotlin WebView-обёртка для Sunmi
docs/                   проектная и эксплуатационная документация
legacy/                 только справочник старой версии
```

`legacy/` не является зависимостью нового приложения. Не импортируйте оттуда
компоненты, stores или API; переносите только проверенные продуктовые идеи.

## Повседневные команды

```bash
npm run lint
npm run test:run
npm run build
npm run check:bundle
```

| Скрипт | Когда использовать |
|---|---|
| `npm run test` | разработка теста в watch-режиме |
| `npm run test:run` | перед коммитом и в CI |
| `npm run lint` | после изменений TS/TSX/скриптов |
| `npm run build` | проверка типов и обоих Vite bundles |
| `npm run check:bundle` | контроль startup JS после production build |
| `npm run check:ref` | перед любым удалённым изменением Supabase |

## Как устроен feature

Новый доменный сценарий обычно состоит из:

```text
src/features/example/
  ExamplePage.tsx       экран или контейнер
  ExampleSheet.tsx      локальный sheet/dialog, если нужен
  api.ts                Supabase reads и RPC-вызовы
```

Общие функции выносятся в `src/lib/` только если ими пользуются несколько
features. Доменные типы, совпадающие со схемой БД, добавляются в
`src/types/index.ts`. Локальное состояние экрана лучше держать в компоненте;
Zustand нужен для состояния между маршрутами или для persist.

## Доступ к данным

- Reads выполняются через React Query и функции `api.ts`.
- Денежные и составные записи выполняются RPC, а не цепочкой клиентских
  `insert/update/delete`.
- Query keys должны быть стабильны. После мутации инвалидируйте только
  связанные ключи.
- Для горячего потока используйте optimistic update и определите поведение
  при timeout/offline.
- Не вычисляйте исторические totals из каталога: используйте снапшоты заказа.
- Критический запрос, упавший **без кэша**, нельзя рисовать как пустоту
  («меню пусто», «смена не открыта», «все столы свободны» — это команды к
  неверным действиям). Проверяйте `failedNoCache()` из `src/lib/queryState.ts`
  и показывайте `<LoadErrorState>` с кнопкой повтора; ошибка при живом
  persist-кэше не блокирует — работаем по кэшу. Так сделаны каталог, смена,
  точка, зал, строки счёта стола и журнал операций.

Если изменение затрагивает `locations.settings`, используйте
`patch_location_settings` через `patchLocationSettings()`. Отправка целого
объекта настроек может затереть параллельные изменения.

Каталог сохраняется атомарно через `save_menu_item`, порядок — через
`reorder_menu`. Не заменяйте эти RPC серией независимых запросов.

## Деньги

Все входные и выходные суммы — целые агороты:

```ts
import { formatMoney, parseMoney } from '../lib/money'

const amount = parseMoney('12.50') // 1250
formatMoney(amount)                // отображение в валюте точки
```

Запрещено хранить `12.5` как цену, использовать float для процентов или
округлять деньги обычным `Math.round(price * rate)` вне денежных helper-ов.

## Мутации и offline

Перед добавлением мутации ответьте на четыре вопроса:

1. Нужна ли она в рабочем потоке без сети?
2. Какой клиентский UUID дедуплицирует повтор на сервере?
3. Что увидит пользователь до ответа сети?
4. Как безопасно повторить операцию после перезапуска?

Если мутация должна работать офлайн, добавьте типизированный `OutboxOp`, helper
enqueue, обработчик в `drain.ts`, server-side идемпотентность и тесты. Полный
чек-лист находится в [offline.md](offline.md).

## UI и доступность

- интерактивные элементы горячего POS-потока — не меньше `h-11`;
- основной текст — `text-gray-900`, вторичный — не светлее `text-gray-500`;
- отступы выбираются из Tailwind-шкалы 4/8/12/16/24/32 px;
- не используйте яркие градиенты, эмодзи и декоративные заливки;
- для RTL применяйте `ms-*`, `me-*`, `start`, `end`;
- не добавляйте тяжёлый blur/анимации на часто открываемые sheets: GPU старого
  терминала ограничен.

Проверяйте русский и иврит. Новый ключ должен существовать в обеих секциях
`src/lib/i18n.ts`; тест паритета не позволит оставить перевод только в одном
языке.

## Тесты

Frontend-тесты лежат рядом с кодом и выполняются Vitest:

```bash
npm run test:run
```

Сейчас проверяются денежные helpers, математика корзины (скидки, лояльность и
округление итога до шекеля — зеркало серверного `round_order_total`), варианты
чаевых, i18n, capability-gate, offline scope и drain, optimistic rollback
очереди, landing route, печать длинных чеков и callback заданий принтера.

SQL-тесты требуют локальный Supabase:

```bash
supabase start
supabase db reset
supabase test db
```

Они проверяют идемпотентность финансовых RPC и RLS/scope устройств. Детали —
в `supabase/tests/README.md`.

## Что проверять перед pull request

- [ ] `npm run lint` проходит;
- [ ] `npm run test:run` проходит;
- [ ] `npm run build` создаёт modern и legacy bundles;
- [ ] `npm run check:bundle` не превышает startup budget;
- [ ] новые суммы представлены агоротами;
- [ ] для мутаций определены optimistic и error states;
- [ ] ru/he и RTL проверены;
- [ ] touch targets подходят для планшета;
- [ ] при новой схеме добавлена следующая миграция, старые не изменены;
- [ ] документация обновлена, если изменился публичный процесс или deployment.

Изменения горячего потока, WebView или печати после автотестов обязательно
проверяются по [t2-smoke-test.md](t2-smoke-test.md).
