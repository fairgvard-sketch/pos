import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { version } from './package.json'

// Отдельный конфиг тестов (не тянет legacy/PWA-плагины из vite.config).
// __APP_VERSION__ определяем так же, как в проде — код под тестом его читает.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // supabase.ts бросает на импорте без env, а тесты его тянут по цепочке
    // api.ts/telemetry.ts. Плейсхолдеры нужны всем прогонам, не только CI:
    // .env не в репозитории, поэтому чистый клон падал бы так же.
    // Сеть не задействована — клиент только создаётся, запросы замоканы.
    env: {
      VITE_SUPABASE_URL: 'https://placeholder.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'placeholder-anon-key',
    },
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      // Серверная логика Единого формата (Edge Functions) — чистые функции,
      // тестируются тем же vitest, что и frontend.
      'supabase/functions/_shared/**/*.{test,spec}.ts',
    ],
    css: false,
  },
})
