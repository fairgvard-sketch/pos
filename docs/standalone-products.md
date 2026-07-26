# Standalone digital products — ANGLE Menu / Orders / Reserve без POS

Продуктовая модель: организация включает любую комбинацию модулей
`menu`, `online_orders`, `reservations`, `pos` (миграция 100). Backend
один: общий каталог, точки, столы, RLS-tenant; продукты коммерчески
независимы, но технически интегрированы — включение POS позже подключает
существующий каталог без миграции данных клиентом.

## Слои

| Слой | Что | Где |
|---|---|---|
| Entitlements | `organization_products` + `org_has_product`; провижионинг ручной (биллинга нет) | 100 |
| Digital-онбординг | `bootstrap_digital_org` — org+точка+членство без PIN и устройства; в JWT только `org_id` | 100 |
| Витрина меню | `public-menu` отдаёт `location.modules`; без `online_orders` гостевая страница — чистая витрина; `is_open` standalone-точки — по расписанию, не по сменам | 100/101 + фронт |
| Embed | `/order/*`, `/reserve/*` — `frame-ancestors *`; остальное `'self'` (vercel.json); сниппеты в кабинете | Phase 2 |
| Standalone-заказы | `online_fulfilment_mode`, `online_hours_open`, цикл new→accepted→preparing→ready→completed, `set_online_order_status_web` | 101 |
| Веб-стол хостес | терминальные `completed`/`no_show`, `set_reservation_status_web`; посаженные на кассе брони неприкасаемы | 102 |
| Кабинет | онбординг «под цель», module-aware навигация, инбокс Orders, стол Reservations, карточка модулей | репо `anglesite` |

## Инварианты

- Entitlements проверяются **сервером** (RPC/Edge), навигация кабинета —
  только видимость.
- Режимы не смешиваются: standalone-приёмка не создаёт POS `orders`
  (нет фискальных записей), веб не трогает заявки/брони с `order_id`;
  POS-путь (`accept_online_order`, `seat_reservation`) не изменился.
- Снапшоты позиций/цен в заявке неизменны с момента подачи (050).
- Активные arrived/seated у броней сознательно не вводились: движок
  доступности (063) считает занятость по `new`/`confirmed` — их
  добавление означает переделку exclusion-предикатов.

## Upgrade path (MVP — ручной провижионинг)

- Digital-only → +POS: оператор добавляет строку `pos` в
  `organization_products` и регистрирует устройство с `org_id` организации
  в `app_metadata` (обычный device-онбординг создаёт НОВУЮ организацию —
  для апгрейда не использовать). Каталог/точки/брони уже на месте.
- POS-организация → digital-режим заказов точки:
  `settings.online_orders.fulfilment = 'standalone'`.

## Порядок деплоя

1. `db push` 101–102 (100 уже в ветке; `MIN_SCHEMA_VERSION=102` — фронт
   кассы **после** миграций, иначе guard-экран);
2. `supabase functions deploy public-menu`;
3. фронт кассы (Vercel, репо `pos`);
4. бэкофис (репо `anglesite`);
5. смоук ниже.

## Пилот-чеклист (смоук на проде)

- [ ] регистрация email/пароль в кабинете → онбординг «Publish menu» →
      кабинет без PIN/устройства/смен, навигация без POS-разделов;
- [ ] меню создаётся в кабинете, гостевая `/order/<loc>` — витрина без
      корзины и баннера «закрыто»; iframe-сниппет работает на стороннем
      домене (frame-ancestors);
- [ ] включить `online_orders` оператором → корзина появилась; заявка
      гостя без открытой смены проходит; расписание `hours` закрывает
      приём вне окон;
- [ ] инбокс Orders: realtime + звук, цикл до completed, статусы видны
      гостю; отказ с причиной;
- [ ] Reserve: заявка → подтверждение из кабинета → completed/no_show;
      гостевой статус корректен;
- [ ] POS-организация: касса работает как раньше (смены, приёмка заявок,
      посадка броней), веб-переводы для pos-точек отклоняются `pos_mode`;
- [ ] cross-tenant: чужая организация не видна и не мутируется.

Откат: фронты откатываются деплоем предыдущей сборки; миграции
forward-only — функциональный откат для standalone-контура =
`fulfilment='pos'` и деактивация строк в `organization_products`
(данные не удалять).

## Не сделано сознательно (за пределами MVP)

- биллинг/самостоятельная покупка модулей; гостевые платежи; WhatsApp/
  Telegram; headless catalog API; кастомные домены; JS-виджет;
- arrived/seated и назначение столов из веба; календарь/база гостей в
  кабинете (есть list-вид);
- live-прогон edge-runtime локально (CLI edge container не бутится —
  «failed to determine entrypoint»); DB-логика покрыта pgTAP, живой
  смоук функций — на деплое.
