import { fileURLToPath } from 'node:url'
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
  resolve: {
    alias: {
      // Виртуальный модуль отдаёт PWA-плагин, которого здесь нет: без
      // заглушки любой тест, тянущий lib/swUpdate, падал бы на резолве
      // импорта ещё до vi.mock.
      'virtual:pwa-register': fileURLToPath(new URL('./src/test/pwaRegisterStub.ts', import.meta.url)),
    },
  },
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
    coverage: {
      // Vitest 3 по умолчанию считал весь репозиторий (`all: true`), Vitest 5 —
      // только файлы, загруженные тестами. Из-за этого одно лишь обновление
      // пакета меняет знаменатель метрики. Целевые файлы фиксируем явно;
      // алгоритм подсчёта и известный пропуск Deno описаны в docs/development.md.
      include: [
        'src/**/*.{ts,tsx}',
        'scripts/**/*.mjs',
        'api/**/*.ts',
        'supabase/functions/**/*.ts',
        'postcss.config.js',
        'tailwind.config.js',
      ],
      // `legacy/` — продуктовый референс, а не зависимость приложения
      // (AGENTS.md), `public/` — статика: в метрику приложения не входят.
      // Сами тесты и тестовые заглушки не измеряют покрытие кода продукта.
      exclude: [
        'src/test/**',
        'src/**/*.d.ts',
        '**/*.{test,spec}.{ts,tsx}',
      ],
    },
  },
})
