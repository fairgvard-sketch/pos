import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import legacy from '@vitejs/plugin-legacy'
import { VitePWA } from 'vite-plugin-pwa'
import { version } from './package.json'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const appSurface = env.VITE_APP_SURFACE === 'menu' ? 'menu' : 'pos'
  const appTitle = appSurface === 'menu' ? 'Angle — Digital Menu' : 'Angle — POS'
  // Гостевая поверхность уходит ссылкой в мессенджеры, поэтому у неё есть
  // осмысленное описание; POS — внутренний экран, ему хватает названия.
  const appDescription = appSurface === 'menu'
    ? 'תפריט דיגיטלי והזמנת מקום'
    : 'Angle POS'

  return {
    // Версия приложения доступна в коде как __APP_VERSION__ (см. src/types/global.d.ts)
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
    plugins: [
      {
        name: 'angle-app-surface',
        transformIndexHtml(html) {
          return html
            .replace('__ANGLE_APP_SURFACE_VALUE__', appSurface)
            .replaceAll('__ANGLE_APP_TITLE__', appTitle)
            .replaceAll('__ANGLE_APP_DESCRIPTION__', appDescription)
        },
      },
      react(),
      // Целевое железо: Sunmi T2 mini, Android 7.1 → системный WebView ~Chrome 52-58.
      // Он не знает ES-модули (нужен Chrome 61+), поэтому получает nomodule-бандл:
      // SystemJS + транспиляция + core-js полифиллы. Современные браузеры берут
      // обычный модульный бандл — для них ничего не меняется.
      legacy({
        targets: ['chrome >= 52'],
      }),
      VitePWA({
        // SW обновляется сам, без диалогов — касса всегда на свежей версии
        registerType: 'autoUpdate',
        includeAssets: [
          'favicon.svg',
          'icons.svg',
          'manifest.webmanifest',
          'menu.webmanifest',
          'install-manifest.js',
        ],
        // Манифест выбирается синхронно в install-manifest.js:
        // внутренние маршруты получают статический POS manifest, /order/:locId —
        // динамический manifest конкретной точки/стола. Плагин не должен вставлять
        // второй <link rel="manifest"> с start_url="/".
        manifest: false,
        workbox: {
          // Кэшируем весь бандл (уровень A): при коротком обрыве приложение
          // грузится из кэша и не белеет. Данные Supabase — офлайн-очередь фазы 7.
          globPatterns: ['**/*.{js,css,html,svg,webmanifest,woff,woff2}'],
          navigateFallback: '/index.html',
          /**
           * Гостевые страницы идут в сеть, а не из precache.
           *
           * `/order/*` и `/reserve/*` отдаются с `frame-ancestors *`
           * (vercel.json) — их встраивают в сайт ресторана и в превью
           * кабинета. Закешированный же `/index.html` несёт
           * `frame-ancestors 'self'`, и в браузере с установленным SW
           * навигация внутри iframe получала именно его: Chrome
           * блокировал кадр («refused to connect»). Заголовок ответа —
           * часть контракта страницы, поэтому подменять её оболочкой
           * из кэша здесь нельзя.
           *
           * Ассеты гостевой страницы остаются в precache, offline от
           * этого не страдает: без сети меню всё равно нечем наполнить.
           */
          navigateFallbackDenylist: [/^\/order\//, /^\/reserve\//],
          cleanupOutdatedCaches: true,
        },
      }),
    ],
  }
})
