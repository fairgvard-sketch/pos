# Kassa — APK-обёртка для Sunmi

Тонкое Android-приложение: WebView открывает боевой веб-POS (Vercel),
JS-мост `window.KassaAndroid` печатает на **встроенный термопринтер Sunmi**
тихо, без диалогов и без RawBT — как у нативных POS.

UI/логика остаются вебом: деплой на Vercel обновляет кассу на всех
терминалах, APK пересобирать не нужно (только при изменении самого моста).

## Перед сборкой

В `app/src/main/res/values/strings.xml` замени `app_url` на URL деплоя:

```xml
<string name="app_url">https://твой-проект.vercel.app</string>
```

## Сборка

**Вариант А — GitHub Actions (без Android Studio):**
GitHub → Actions → «Android APK» → Run workflow. Для проверки скачай
`kassa-sunmi-apk-debug`; для боевой установки — подписанный
`kassa-sunmi-apk-release` (появляется только при настроенных signing secrets).
Debug APK не использовать как production-релиз.

**Вариант Б — Android Studio:** открой папку `android/`, Build → APK.

## Установка на терминал

1. Скопируй `app-debug.apk` на T2 (USB / скачай браузером).
2. Разреши установку из неизвестных источников, установи.
3. Открой «Kassa» — касса загрузится с Vercel, печать чека пойдёт
   сразу на встроенный принтер (мост перекрывает настройку печати).

## Как это устроено

- `MainActivity.kt` — WebView (localStorage/SW включены, экран не гаснет,
  ландшафт) + биндинг к принтеру через официальный `com.sunmi:printerlibrary`.
- Веб-сторона рендерит чек в canvas → ESC/POS растр → base64 →
  `KassaAndroid.printBase64()` → transaction buffer → chunked `sendRAWData` →
  `onPrintResult` встроенного принтера.
- Не Sunmi-устройство: мост отвечает `isAvailable() = false`, касса
  печатает как обычно (RawBT / браузер).

## WebView и политика таргета

Обёртка использует **системный WebView** устройства. На T2 (Android 7.1)
из коробки это может быть Chrome 52. Сборка транспилирует JavaScript под этот
таргет (`@vitejs/plugin-legacy`, полифиллы), но runtime-гейт дополнительно
требует Grid, CSS variables, Proxy, Map/Set и fetch. Для Chrome 57–83 без
`flex-gap` web-часть включает CSS-fallback; stock Chrome 52 обычно всё ещё не
проходит из-за отсутствия Grid. Цель сборки не означает полную поддержку
движка. Версию видно в кассе:
Настройки → Устройство → «Движок браузера».

- Если на устройстве есть Play Market — обнови «Android System WebView»
  (или Chrome: на Android 7+ он может быть провайдером WebView), касса
  сразу станет быстрее и безопаснее. На T2 без GMS такой опции нет.
- **Рекомендуемое железо для новых точек — Sunmi на Android 11+**
  (T2s/T3 и новее): свежий WebView из коробки и обновляемый.
- Chrome 52 остаётся целью транспиляции, пока в бою есть T2. Перед эксплуатацией
  обязательны обновление WebView, если оно доступно, и ручной smoke-test
  существующего flex-gap fallback на устройстве.
