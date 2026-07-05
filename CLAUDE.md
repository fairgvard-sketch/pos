# Kassa — POS-система для ресторана

## Стек

- **Frontend**: React 18, TypeScript, Tailwind CSS, React Query v5, Zustand v5, Recharts
- **Backend**: Supabase (PostgreSQL, RLS, Realtime, Edge Functions)
- **Сборка**: Vite 8, ESLint, TypeScript 6
- **Локальные сервисы**: Node.js print-agent (`print-agent/`)

## Дизайн-система

**Стиль**: светлый минимализм (Linear/Notion-like). Никаких ярких заливок, градиентов, эмодзи в интерфейсе.

### Цвета
| Роль | Значение |
|------|----------|
| Фон страниц | `#f8f9fb` |
| Поверхность (карточки, хедер) | `#ffffff` |
| Граница | `border-gray-100` / `border-gray-200` |
| Основной текст | `text-gray-900` |
| Вторичный текст | `text-gray-400` / `text-gray-500` |
| Акцент / CTA | `bg-gray-900` (тёмная кнопка) |
| Успех | `emerald-500` |
| Предупреждение | `amber-400` |
| Ошибка / счёт | `red-500` |

### Типографика
- Шрифт: **Inter** (Google Fonts, weights 300–800)
- Заголовки: `font-bold` / `font-black`, `text-gray-900`
- Мелкий текст: `text-xs`, `text-gray-400`
- Числа/суммы: `font-bold` / `font-black`, tabular-nums

### Компоненты (глобальные классы в `index.css`)
```
.btn-primary    — bg-gray-900, белый текст, rounded-xl
.btn-secondary  — bg-white, border-gray-200
.btn-danger     — bg-red-500
.btn-success    — bg-emerald-500
.btn-ghost      — прозрачный, hover:bg-gray-100
.card           — bg-white, border-gray-100, shadow мягкая
.card-hover     — card + hover тень
.input          — border-gray-200, focus:ring-gray-900/10
.badge-green/yellow/red/blue/gray — pill-бейджи
```

### Геометрия
- Карточки: `rounded-2xl` (16px)
- Кнопки: `rounded-xl` (12px)
- Инпуты: `rounded-xl`
- Хедер: высота `h-14` (56px), `sticky top-0 z-10`
- Тени: `shadow-[0_1px_3px_rgba(0,0,0,0.06)]` — почти невидимые

### Интерактивность
- Нажатие: `active:scale-[0.97]`
- Переходы: `transition-all duration-150`
- Анимация pulse только для критических статусов (ожидание счёта)

### Правила
- Никаких эмодзи в UI-элементах (кнопках, лейблах) — только в тостах
- Статус столов — цветная точка + текст, не заливка карточки
- Кухонные карточки — цветная левая полоса (`border-l-4`), фон белый
- `LangToggle` — segment control стиль (не таб с синей заливкой)

## Архитектура

```
src/
  features/
    auth/         # PIN-авторизация (PinLogin, ProtectedRoute, api.ts)
    tables/       # Карта зала (TablesPage, TableCard, useTablesRealtime, api.ts)
    orders/       # Создание и ведение заказов (OrderPage, CartPanel, api.ts)
    menu/         # Карточки меню + модификаторы (MenuItemCard, ModifierModal, api.ts, modifiers.ts)
    kitchen/      # Экран кухни с realtime (KitchenPage)
    payments/     # Оплата, скидки, лояльность (PaymentPage, api.ts)
    analytics/    # Менеджер: аналитика, меню, смена, гости, настройки (ManagerPage, api.ts)
    loyalty/      # Карты гостей, баллы, история (api.ts)
  store/
    authStore.ts    # Текущий сотрудник (persist)
    orderStore.ts   # Корзина: CartItem с cartKey, guest (seat-based), guestCount, overridePrice, discountPct, discountAbs
    langStore.ts    # Язык (ru | he)
    settingsStore.ts # Настройки интерфейса (persist): cartItemActions — видимость кнопок в корзине
  lib/
    supabase.ts   # Supabase client
    i18n.ts       # Переводы ru/he + t(), formatCurrency(), formatDate()
    printer.ts    # ESC/POS агент клиент — sendToPrinter(), graceful fallback
  types/
    index.ts      # Все TypeScript типы
  components/
    ui/LangToggle.tsx  # Segment control переключатель языка
```

## Маршруты

| Путь | Роли | Компонент |
|------|------|-----------|
| `/` | — | PinLogin |
| `/tables` | waiter, manager | TablesPage |
| `/order/:tableId` | waiter, manager | OrderPage |
| `/payment/:orderId` | waiter, manager | PaymentPage |
| `/kitchen` | kitchen, manager | KitchenPage |
| `/manager` | manager | ManagerPage |

## База данных (Supabase)

### Миграции
| Файл | Содержимое |
|------|-----------|
| `001_initial_schema.sql` | staff, tables, menu_categories, menu_items, orders, order_items, payments, shifts; RLS; триггеры total + table status |
| `002_seed_data.sql` | Тестовые данные |
| `003_rls_helper.sql` | Вспомогательные RLS функции |
| `004_modifiers.sql` | modifier_groups, modifiers, menu_item_modifier_groups, order_item_modifiers |
| `005_loyalty.sql` | guests, guest_visits |
| `006_loyalty_rpc.sql` | `update_guest_points(p_guest_id, p_earned, p_spent)` |
| `007_image_urls.sql` | image_url для menu_items |
| `008_ask_modifiers.sql` | флаг ask_modifiers на menu_items |
| `009_customer_name.sql` | `customer_name text` на orders — имя на чеке |

### Ключевые SQL-функции
- `current_staff_role()` — роль из session variable `app.current_staff_role`
- `current_staff_id()` — UUID из `app.current_staff_id`
- `update_order_total()` — триггер, пересчитывает `orders.total`
- `update_table_status()` — триггер, обновляет `tables.status`
- `update_guest_points()` — атомарное обновление баллов

### RLS
Аутентификация через `set_config('app.current_staff_role', ...)` в `auth/api.ts`. Все таблицы защищены.

## Фичи

### 1. ESC/POS печать
- **Агент**: `print-agent/server.js` — Node.js на `localhost:6543`
- `printerType`: `"usb"` | `"network"` | `"file"` (тест)
- Запуск: `cd print-agent && npm install && npm start`
- **Клиент**: `src/lib/printer.ts` — таймаут 2с, graceful fallback на `window.print()`
- Кухонный тикет → автоматически при "На кухню"
- Чек → кнопка "Печать" на PaymentPage
- На чеке выводится `customer_name` (если задано) жирным шрифтом

### 2. Seat-based (разделение по гостям)
- `CartItem.guest: number` — 0 = общее, 1..N = гость
- `CartPanel` — счётчик гостей + кнопки Г1/Г2/...
- `PaymentPage` — чек сгруппирован по гостям с промежуточными суммами
- `orderStore.guestCount` + `updateGuest(cartKey, guest)`

### 3. Программа лояльности
- Таблицы: `guests` (points, visits), `guest_visits`
- 1₪ = 1 балл, списание от 100 баллов
- Поиск по телефону → слайдер баллов → начисление после оплаты
- Менеджер → вкладка "Гости": список, история, создание

### 4. Скидки (PaymentPage)
- Нет / % / фиксированная ₪ на весь заказ
- Применяется до вычета баллов, отражается в чеке и на принтере

### 5. Эквайринг (заготовка)
- Edge Function: `supabase/functions/cardcom-payment/index.ts`
- Env: `CARDCOM_TERMINAL`, `CARDCOM_API_KEY` (в Supabase Dashboard)
- Деплой: `supabase functions deploy cardcom-payment`

### 6. Редактирование позиций в заказе (CartPanel)
Клик по позиции в корзине раскрывает панель быстрых действий. Работает для новых позиций (ещё не отправлены) и для уже сохранённых (`order_items`).

**Кнопки (каждая включается/выключается в настройках менеджера):**
- **Цена** — ввести произвольную цену (перебивает `menu_item.price + extraPrice`)
- **Скидка %** — процентная скидка на позицию
- **Скидка ₪** — фиксированная скидка в шекелях на позицию
- **Сброс** — убрать все ценовые изменения (появляется только если цена изменена)
- **Допы** — открыть модификаторы

Для новых позиций изменения хранятся в `CartItem.overridePrice / discountPct / discountAbs`.  
Для сохранённых — `updateOrderItem(itemId, { price })` → запись в БД.  
Финальная цена считается через `cartItemEffectivePrice(c)` из `orderStore.ts`.

### 7. Имя на чеке (`customer_name`)
- Поле в хедере CartPanel (под номером заказа) — сохраняется сразу в `orders.customer_name`
- Поле на PaymentPage — сохраняется при blur и при проведении оплаты
- Отображается в превью чека и печатается на принтере (жирным, без префикса)

### 8. Перенос позиций между столами
- Кнопка "Перенести" в футере CartPanel (только если есть сохранённые позиции)
- Режим выбора: галочки на позициях в секции "Уже в заказе"
- После выбора — шторка снизу с сеткой всех столов (текущий скрыт, занятые выделены)
- Логика в `moveOrderItems()` (`orders/api.ts`):
  - Если на целевом столе нет активного заказа — создаётся новый
  - Позиции переносятся через `UPDATE order_items SET order_id = ...`
  - Если в исходном заказе позиций не осталось — заказ удаляется, стол освобождается

### 9. Настройки интерфейса (ManagerPage → вкладка "Настройки")
- `settingsStore.ts` (Zustand persist → `localStorage` ключ `kassa-settings`)
- `cartItemActions`: объект с булевыми флагами `price`, `discountPct`, `discountAbs`, `modifiers`
- Переключатели в ManagerPage влияют на все сессии на устройстве сразу

## Валюта и язык
- ₪ (шекели, ILS)
- ru / he с RTL (`dir={isRtl ? 'rtl' : 'ltr'}`)
- Переводы в `src/lib/i18n.ts`, функция `t(lang, key)`

## Запуск

```bash
npm install && npm run dev          # фронтенд

cd print-agent
npm install
cp config.example.json config.json  # настроить принтер
npm start                           # ESC/POS агент
```

```env
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```
