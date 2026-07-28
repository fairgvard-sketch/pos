/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // Палитры `primary` здесь намеренно нет. Она была синей (#3b82f6) и
      // не использовалась ни в одном файле — акцент всего продукта (POS,
      // бэкофис, гостевое меню) это near-black #111827 / gray-900. Живой
      // синий в конфиге провоцировал бы взять «фирменный цвет» и получить
      // синюю кнопку посреди чёрного интерфейса.
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

