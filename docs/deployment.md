# Выпуск и эксплуатация

Kassa состоит из трёх независимо выпускаемых частей:

1. Supabase schema/RPC и Edge Functions;
2. frontend на Vercel;
3. Android APK для Sunmi.

Изменение веб-интерфейса не требует нового APK. Изменение JS-моста, origin или
Android-конфигурации требует.

## Окружения и идентификаторы

- production Supabase project ref: `qgmnxrgtlpyqglwqmsej`;
- production frontend: `https://pos-self-sigma.vercel.app`;
- APK `app_url` должен указывать на этот стабильный origin;
- frontend использует только Supabase anon key.

Если production URL меняется, обновите Vercel, CORS/redirect assumptions,
`android/app/src/main/res/values/strings.xml` и выпустите новый APK.

## CI

`.github/workflows/ci.yml` выполняет на push в `main` и pull request:

```text
frontend: npm ci → lint → test:run → build → bundle budget
database: local Supabase → migrations from zero → pgTAP
```

Сборка использует Node 22 и placeholder Supabase variables: она проверяет типы
и bundle, но не обращается к production DB. Отдельная database job через Docker
проверяет RLS и финансовую идемпотентность только на локальной БД.

`.github/workflows/android-apk.yml` собирает debug APK и, при ручном запуске с
секретами, подписанный release APK.

## Порядок релиза

### 1. Проверить рабочее дерево и качество

```bash
git status --short
npm ci
npm run lint
npm run test:run
npm run build
npm run check:bundle
```

Если менялись SQL-инварианты:

```bash
supabase start
supabase db reset
supabase test db
```

### 2. Применить миграции

Миграции нужны раньше frontend, если новый клиент вызывает новые RPC/колонки.

```bash
npm run check:ref
npm run db:push
```

Guard должен вывести ref `qgmnxrgtlpyqglwqmsej`. Если `.env` или linked project
не совпадает, остановитесь и исправьте привязку:

```bash
supabase link --project-ref qgmnxrgtlpyqglwqmsej
```

Не применяйте миграции вручную в другом Dashboard «для проверки». Для локальной
проверки предназначен `supabase db reset`.

### 3. Выпустить Edge Functions

Если функция менялась:

```bash
npm run functions:deploy
```

После деплоя проверьте:

- `public-menu` возвращает только публичные поля;
- `public-order` принимает заказ и читает статус;
- `public-reserve` возвращает профиль/слоты и создаёт бронь;
- `cardcom-payment` остаётся закрытой (`503` или `501`), пока безопасный поток
  не реализован полностью.

### 4. Выпустить frontend

Push в `main` запускает production deployment Vercel. После публикации:

- откройте `/setup` или `/pin` в чистом браузере;
- проверьте, что manifest и service worker обновились;
- откройте ленивый менеджерский route после деплоя;
- проверьте публичные `/order/:locId` и `/reserve/:locId`, если они затронуты.

Service worker обновляется автоматически. `lazyWithRetry` помогает старым
вкладкам пережить смену chunk hashes, но не заменяет smoke-test.

### 5. Выпустить APK при необходимости

Новый APK нужен, если изменилось что-то в `android/`, включая `app_url`.

1. Увеличьте `versionCode` и `versionName`.
2. Запустите GitHub Actions → `Android APK` → `Run workflow`.
3. Используйте артефакт `kassa-sunmi-apk-release`.
4. Установите поверх предыдущей версии и убедитесь, что подпись совпадает.
5. Не используйте debug artifact в production.

## Release checklist

- [ ] версия и changelog/описание релиза подготовлены;
- [ ] lint, Vitest и build зелёные;
- [ ] pgTAP зелёный для DB/security изменений;
- [ ] project ref проверен;
- [ ] новые миграции применены по порядку;
- [ ] изменённые Edge Functions задеплоены;
- [ ] frontend опубликован после schema/API;
- [ ] новый и старый lazy route открываются после деплоя;
- [ ] офлайн-продажа и последующий replay проверены при изменении мутаций;
- [ ] оригинал/копия/возврат и длинный чек проверены при изменении печати;
- [ ] ru/he и RTL проверены;
- [ ] пройден [smoke-test T2](t2-smoke-test.md);
- [ ] версия WebView и модель терминала записаны в результат проверки.

## Откат

### Frontend

Переопубликуйте предыдущий успешный deployment Vercel. Учитывайте, что новый
service worker может уже находиться на устройствах; проверяйте reload и lazy
chunks после rollback.

### Edge Function

Задеплойте предыдущую проверенную версию конкретной функции. Секреты не
встраиваются в код и должны оставаться в Supabase Secrets.

### База данных

Не делайте destructive down migration и не переписывайте применённый SQL.
Исправление выпускается новой forward-only миграцией. Если frontend уже
откачен, новая схема должна по возможности оставаться обратно совместимой до
завершения инцидента.

Финансовые записи нельзя удалять ради отката. Ошибочные операции исправляются
компенсирующей записью и отдельным аудитом.

### APK

Android обычно не позволяет установить APK с меньшим `versionCode` поверх
нового. Выпустите исправленную сборку с более высоким кодом и той же release
подписью.

## Минимальный post-deploy smoke

1. Вход устройства и PIN.
2. Открытие стартового рабочего экрана.
3. Продажа наличными и получение серверного номера чека.
4. Тихая печать оригинала на Sunmi.
5. Перепечать с пометкой копии.
6. Авиарежим → локальная продажа `K-n` → сеть → sync.
7. Очередь бариста и действие «готово».
8. Открытие менеджерского lazy route.
9. Проверка публичных страниц, если менялись функции/настройки.

## Наблюдение за инцидентом

При проблеме зафиксируйте:

- commit и version приложения;
- Supabase migration number;
- URL/версию deployment;
- модель терминала, Android и Chrome/WebView major;
- online/offline состояние и содержимое offline sheet без персональных данных;
- тип печати: APK, RawBT или browser;
- server error code и client UUID проблемной операции.

Не копируйте в тикет access token, anon/service keys, PIN или полный payload с
телефоном гостя.
