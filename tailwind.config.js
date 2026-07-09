/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eff6ff',
          100: '#dbeafe',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      spacing: {
        // 52px — крупная сенсорная мишень для полей/кнопок мастера входа (Square-стиль)
        13: '3.25rem',
      },
      screens: {
        // Компактный режим для невысоких экранов (POS-терминалы Sunmi ~720–768px)
        short: { raw: '(max-height: 800px)' },
      },
    },
  },
  plugins: [],
}

