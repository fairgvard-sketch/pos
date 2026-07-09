import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import legacy from '@vitejs/plugin-legacy'
import { VitePWA } from 'vite-plugin-pwa'
import { version } from './package.json'

// https://vite.dev/config/
export default defineConfig({
  // Версия приложения доступна в коде как __APP_VERSION__ (см. src/types/global.d.ts)
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [
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
      includeAssets: ['favicon.svg', 'icons.svg'],
      manifest: {
        name: 'Kassa — POS',
        short_name: 'Kassa',
        description: 'POS для кофеен и пекарен',
        lang: 'ru',
        // Тач-касса, альбомная ориентация. standalone (не fullscreen!):
        // браузерный UI скрыт, но системная навигация Android (назад/домой)
        // остаётся — иначе с терминала нельзя свернуть кассу.
        display: 'standalone',
        orientation: 'landscape',
        background_color: '#eceef1',
        theme_color: '#111827',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Кэшируем весь бандл (уровень A): при коротком обрыве приложение
        // грузится из кэша и не белеет. Данные Supabase — офлайн-очередь фазы 7.
        globPatterns: ['**/*.{js,css,html,svg,woff,woff2}'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
})
