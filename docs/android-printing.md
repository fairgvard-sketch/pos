# Android, WebView и печать

## Варианты запуска

Kassa может работать тремя способами:

| Режим | UI | Печать |
|---|---|---|
| обычный браузер/PWA | production URL | системный `window.print()` |
| браузер + RawBT | production URL | `rawbt:` URL с ESC/POS payload |
| Kassa APK на Sunmi | WebView с production URL | тихий JS-мост во встроенный принтер |

Для боевого Sunmi предпочтителен APK: он не показывает системный print dialog и
получает асинхронный результат задания от принтера.

## Что находится в `android/`

Android-проект — тонкая обёртка, а не отдельная реализация POS:

- `MainActivity.kt` создаёт WebView и грузит стабильный production URL;
- localStorage, cache и JavaScript включены;
- экран не гаснет, ориентация приложения — landscape;
- Sunmi `InnerPrinterManager` подключает встроенный принтер;
- `window.KassaAndroid` передаёт ESC/POS bytes из веб-приложения;
- обновление frontend не требует нового APK.

Пересборка APK нужна при изменении нативного моста, Android security settings,
production origin, package version или зависимости printer library.

## Поток печати

```text
Receipt data
  └─ printCanvas.ts: layout + Hebrew/RTL → HTMLCanvasElement
       └─ escpos.ts: 1-bit raster + GS v 0 + feed/cut
            ├─ KassaAndroid.printBase64(base64, jobId)
            │    └─ Sunmi transaction buffer → RAW chunks → commit callback
            ├─ rawbt:base64,...
            └─ window.print() для ручного browser fallback
```

Чек отправляется картинкой. Это намеренно: шрифт, иврит и bidi-порядок не
зависят от кодовой страницы конкретного ESC/POS-принтера.

Длинные payload делятся APK на chunks по 100 KiB, чтобы не упереться в лимит
Android Binder. Все chunks попадают в transaction buffer; настоящий результат
приходит через `exitPrinterBufferWithCallback()` → `onPrintResult` после commit.

Совместимость с прошивками Sunmi (v1.3):

- если transaction API бросает (старый сервис печати), мост печатает напрямую
  `sendRAWData`-чанками с колбэком на последнем чанке;
- часть прошивок не шлёт `onPrintResult` вовсе: после успешного `onRunResult`
  мост ждёт 5 секунд и подтверждает `success` сам (`run-result-only`) —
  иначе web-часть считала бы каждую физически успешную печать проваленной
  по своему 15-секундному timeout;
- финальный статус задания отправляется один раз: реальный
  `onPrintResult`/`onRaiseException` выигрывает у отложенного подтверждения.

## Приоритет путей

Для ручной печати:

1. доступный `window.KassaAndroid`;
2. RawBT, если он выбран в настройках устройства;
3. браузерный print dialog.

Для автопечати используются только тихие пути — APK или разрешённый RawBT.
Открывать browser dialog после каждой продажи нельзя: это ломает кассовый поток.

## Результат задания

`printBase64()` возвращает только факт принятия. Настоящий результат приходит в:

```ts
window.__kassaPrintResult(jobId, status, message)
```

Статусы:

- `queued` — промежуточный;
- `success` — принтер завершил задание;
- `no-paper` — закончилась/недоступна бумага;
- `disconnected` — принтер не подключён;
- `error` — другая ошибка.

Если APK версии моста 2 принял задание, но не прислал финальный callback за
15 секунд, web-часть возвращает `timeout`, а не ложный успех.

`src/lib/printJobs.ts` превращает callback в Promise. При ошибке автопечати UI
показывает ненавязчивый toast с повтором; в тосте и `console.warn('[print]')`
виден диагностический код (`status · message` от моста) — по нему причина
определяется без гаданий. Второй экземпляр чека печатается только после
успеха первого.

Если мост отклонил задание синхронно (`accepted=false`), web-часть ждёт 500 мс
настоящую причину от моста (например, `disconnected`) и только потом ставит
generic `not-accepted` — иначе точный статус терялся.

Result-aware путь используется для автопечати, ручной печати из preview,
возвратов, Z-отчёта, QR-листов и тестовой печати. Ошибка не теряется: доступен
повтор, а зависимая вторая копия не отправляется до успеха первой.

Для старого моста без callback действует совместимость: через 15 секунд принятое
задание считается успешным. Это не подтверждение физической печати, а fallback
для предыдущих APK.

## Безопасность WebView-моста

Мост имеет доступ к физическому принтеру, поэтому `MainActivity` ограничивает
его точным origin из `app_url`:

- внутренне открывается только совпадающий scheme + host;
- чужие `http/https` ссылки передаются внешнему браузеру;
- `rawbt:` передаётся внешнему приложению;
- `file:`, `content:`, `intent:` и неизвестные схемы блокируются;
- file/content access и mixed content выключены;
- `isAvailable()` и `printBase64()` отказывают вне доверенного origin.

При смене production-домена обязательно обновите `app_url` и выпустите новый
APK. Redirect с нового домена сам по себе не расширяет allow-list.

## Совместимость WebView

Здесь важно различать два уровня:

1. Vite legacy bundle транспилирует JavaScript для `Chrome >= 52` и добавляет
   SystemJS/core-js;
2. ранний `checkCapabilities()` требует платформенные возможности, которые
   сборка не может полифиллить: CSS Grid, CSS variables, Promise, Proxy,
   Map/Set и fetch.

`flex-gap` появился только в Chrome 84. На Chrome 57–83 runtime добавляет класс
`no-flex-gap`, а `index.css` эмулирует отступы margins и старым `grid-gap`, в
том числе для RTL и flex-wrap. Это позволяет запустить типичный WebView Android
7.1, но не заменяет визуальную проверку. Stock Chrome 52 всё ещё обычно не имеет
CSS Grid и получает экран «Браузер устарел».

Перед вводом терминала в работу:

- обновите Android System WebView/Chrome, если устройство это позволяет;
- проверьте `Настройки → Устройство → Движок браузера`;
- выполните [t2-smoke-test.md](t2-smoke-test.md) на реальном железе;
- если обновление невозможно, проверьте существующий flex-gap fallback на всех
  горячих экранах ru/he и не отключайте гейт для отсутствующего Grid.

Транспиляция синтаксиса не исправляет CSS и не добавляет нативные Web API.

## Per-device настройки

Настройки конкретного терминала живут optimistic-first в `deviceStore`, а затем
фоново синхронизируются в `devices.settings`:

- имя кассы;
- стартовый экран;
- ориентация;
- ширина ленты 58/80 мм;
- режим печати;
- автопечать, вопрос о чеке, кухонный тикет;
- звук и автоблокировка;
- порядок способов оплаты и быстрые суммы;
- настройки чаевых.

`device_uuid` создаётся один раз для физического браузера. Один Supabase account
может использоваться на нескольких терминалах; строки устройств различаются по
`(org_id, device_uuid)`.

`initDeviceSync()` запускается после auth scope, регистрирует терминал и
синхронизирует изменения с debounce. Если локальный snapshot есть, он считается
более свежим и отправляется в БД. Если storage новый или очищен, настройки
восстанавливаются из `devices.settings`. После `SIGNED_IN` синхронизация
запускается без reload; reconnect и кнопка повтора в разделе устройства
восстанавливают неудачную отправку.

## Сборка APK

### GitHub Actions

Workflow `Android APK` запускается вручную или при изменениях `android/**` в
`main`.

- debug job всегда создаёт `kassa-sunmi-apk-debug`;
- release job выполняется только вручную и при наличии signing secrets;
- debug APK нельзя выдавать за production release.

Секреты release:

- `ANDROID_KEYSTORE_BASE64`;
- `ANDROID_KEYSTORE_PASSWORD`;
- `ANDROID_KEY_ALIAS`;
- `ANDROID_KEY_PASSWORD`.

Keystore не хранится в репозитории.

### Локально

Требуется JDK 17:

```bash
cd android
./gradlew assembleDebug
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`.

## Диагностика печати

1. В настройках устройства проверьте статус APK-моста.
2. Запустите тестовую печать.
3. Убедитесь, что `isAvailable()` возвращает true только на production origin.
4. Проверьте ленту и крышку, затем повторите задание из toast.
5. Для RawBT убедитесь, что приложение установлено и выбран встроенный принтер.
6. Для длинного чека проверьте последнюю строку и отрез — canvas не должен быть
   обрезан по высоте.
7. Для иврита проверяйте физический чек, а не только preview.

Подробная инструкция по установке APK находится в `android/README.md`.
