# Standalone digital products — ANGLE POS / Menu / Orders / Reserve

Продуктовая модель: четыре независимо продаваемых продукта — `pos`,
`menu`, `online_orders`, `reservations`. Любой может быть ПЕРВЫМ
standalone-продуктом организации и любой добавляется позже как add-on
(`product_catalog`, 103). Backend один: общий каталог, точки, столы,
RLS-tenant; добавление продукта не требует копирования или миграции
данных клиента.

## Модель (103–105)

Четыре разделённых понятия:

- **Продукт** — что покупает клиент (`product_catalog`);
- **Capability** — что технически разрешает продукт
  (`product_capabilities`): `catalog_manage`, `public_menu`,
  `online_orders`, `orders_desk`, `public_reservations`,
  `reservations_desk`, `pos_operate`, `pos_reports`. Ключевое:
  ANGLE Orders включает `public_menu` БЕЗ покупки Menu; POS даёт
  `catalog_manage`, но НЕ `public_menu`;
- **Entitlement** — что выдано организации (`organization_products` +
  lifecycle: `status` active/trialing/suspended/expired, `source`
  developer/manual/trial/subscription, `starts_at`/`expires_at`;
  просрочка оценивается в момент запроса, крона нет);
- **Операционная настройка** — тумблеры владельца в `locations.settings`;
  они НИКОГДА не заменяют entitlement (`module_disabled` ≠ `disabled`).

Серверные гейты — `org_has_capability`/`require_org_capability` (105),
стабильный код отказа `module_disabled`. Отключение продукта блокирует
его чтения и записи, но данные не удаляются: повторная выдача возвращает
доступ. Не гейтятся сознательно: закрытие открытой смены и фискальный
экспорт (`uf_export_*`).

Организация `orgs.account_type = 'developer'` (внутренний аккаунт) несёт
все продукты бессрочно строками `source='developer'`; такие гранты
защищены триггером от случайной деактивации (обход — `SET LOCAL
app.allow_developer_grant_change = 'on'` в той же транзакции). Runtime
не проверяет email — только org и обычные entitlement-строки.

## Слои

| Слой | Что | Где |
|---|---|---|
| Продукты/capabilities | `product_catalog`, `product_capabilities`, lifecycle, `org_has_capability`, developer-организация | 103 |
| Провижионинг | `grant_org_product`/`revoke_org_product` (только service_role), заявки `product_activation_requests`, `request_product_activation`, `attach_device_to_org` | 104 |
| Гейты | capability-гейты публичных/веб/POS-путей, `org_public_menu_gates`, контекст кабинета с capabilities | 105 |
| Entitlements (база) | `organization_products` + `org_has_product` | 100 |
| Digital-онбординг | `bootstrap_digital_org` — org+точка+членство без PIN и устройства; в JWT только `org_id`; продукты НЕ выдаёт — фиксирует заявки | 100/104 |
| Витрина меню | `public-menu` отдаёт `location.modules`; без `online_orders` гостевая страница — чистая витрина; `is_open` standalone-точки — по расписанию, не по сменам | 100/101 + фронт |
| Embed | `/order/*`, `/reserve/*` — `frame-ancestors *`; остальное `'self'` (vercel.json); сниппеты в кабинете | Phase 2 |
| Standalone-заказы | `online_fulfilment_mode`, `online_hours_open`, цикл new→accepted→preparing→ready→completed, `set_online_order_status_web` | 101 |
| Веб-стол хостес | терминальные `completed`/`no_show`, `set_reservation_status_web`; посаженные на кассе брони неприкасаемы | 102 |
| Кабинет | онбординг «под цель», module-aware навигация, инбокс Orders, стол Reservations, карточка модулей | репо `anglesite` |

## Инварианты

- Entitlements проверяются **сервером** (RPC/Edge), навигация кабинета —
  только видимость.
- Онбординги НЕ выдают продукты (104): device-путь (`bootstrap_org`) и
  digital-путь (`bootstrap_digital_org`) создают организацию и фиксируют
  заявку на активацию; браузерный список продуктов — интерес, не доступ.
  Организация без активного продукта — валидное состояние: кабинет
  показывает «Choose a product / Pending activation», касса — экран
  «ANGLE POS не активирован» (PosGuard, блокирует только уверенный
  отрицательный ответ; офлайн работает по кэшу).
- Клиент не может выдать продукт сам себе: у клиентских ролей нет ни
  грантов на `organization_products`, ни EXECUTE на операторские функции.
- Режимы не смешиваются: standalone-приёмка не создаёт POS `orders`
  (нет фискальных записей), веб не трогает заявки/брони с `order_id`;
  POS-путь (`accept_online_order`, `seat_reservation`) не изменился.
- Снапшоты позиций/цен в заявке неизменны с момента подачи (050).
- Активные arrived/seated у броней сознательно не вводились: движок
  доступности (063) считает занятость по `new`/`confirmed` — их
  добавление означает переделку exclusion-предикатов.

## Операторские процедуры (MVP — ручной провижионинг)

Все процедуры — SQL Editor производственного проекта под service_role;
клиентского пути выдачи не существует.

Выдать продукт (закрывает pending-заявку как approved):

```sql
SELECT grant_org_product('<org_id>', 'menu');                 -- бессрочно
SELECT grant_org_product('<org_id>', 'pos', 'trialing', 'trial',
                         NOW() + INTERVAL '14 days');          -- триал
```

Приостановить (доступ закрывается, данные сохраняются; повторный grant
возвращает всё):

```sql
SELECT revoke_org_product('<org_id>', 'online_orders');        -- suspended
SELECT revoke_org_product('<org_id>', 'menu', 'expired', 'не продлён');
```

Изменить developer-грант (защищён триггером):

```sql
BEGIN;
SET LOCAL app.allow_developer_grant_change = 'on';
-- ... UPDATE organization_products ...;
COMMIT;
```

Апгрейд digital → +POS (вторая организация НЕ создаётся, каталог/точки/
брони переиспользуются):

1. клиент создаёт новый device-аккаунт (email/пароль) на терминале, но НЕ
   проходит онбординг организации;
2. оператор: `SELECT attach_device_to_org('<auth_user_id>', '<org_id>',
   '<location_id>');` — обычный device-онбординг создал бы новую
   организацию, для апгрейда его не использовать;
3. оператор: `SELECT grant_org_product('<org_id>', 'pos');`;
4. на терминале — выход/вход для обновления JWT.

POS-организация → digital-режим заказов точки:
`settings.online_orders.fulfilment = 'standalone'`.

## Порядок деплоя

1. `db push` 103–105 (`MIN_SCHEMA_VERSION=105` — фронт кассы **после**
   миграций, иначе guard-экран). Миграция 103 сеет developer-организацию
   по `fairgvard@gmail.com`; прочитать NOTICE применения — если аккаунт
   не резолвится, выполнить проверочный запрос из NOTICE и выдать гранты
   вручную;
2. `supabase functions deploy public-menu` (гейт по
   `org_public_menu_gates`);
3. фронт кассы (Vercel, репо `pos`) — PosGuard;
4. бэкофис (репо `anglesite`) — capability-навигация и карточки продуктов;
5. смоук ниже.

Существующие организации не затронуты: их продукты выданы бэкфиллом 100
и остаются активными; гейты для них — no-op.

## Пилот-чеклист (смоук на проде)

Продуктовая модель (после 103–105):

- [ ] действующая POS-организация работает как раньше: смена, продажа,
      печать, витрина, заявки (бэкфилл 100 = полный набор продуктов);
- [ ] организация developer: кабинет показывает бейдж «Developer
      workspace», все продукты Active/Developer;
- [ ] новая регистрация в кабинете → заявки видны как Pending activation,
      операционные разделы не рендерятся; `grant_org_product` открывает
      разделы после перезагрузки контекста;
- [ ] `revoke_org_product('...', 'menu')` на тестовой организации →
      витрина 404 `module_disabled`; повторный grant возвращает;
- [ ] новый device-онбординг без выданного `pos` → экран «ANGLE POS не
      активирован»; после `grant_org_product(..., 'pos')` и «Повторить»
      касса работает.

Digital-контур:

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
`fulfilment='pos'` и `revoke_org_product` по нужным продуктам
(данные не удаляются, повторный grant возвращает доступ).

## Не сделано сознательно (за пределами MVP)

- биллинг/самостоятельная покупка модулей; гостевые платежи; WhatsApp/
  Telegram; headless catalog API; кастомные домены; JS-виджет;
- arrived/seated и назначение столов из веба; календарь/база гостей в
  кабинете (есть list-вид);
- live-прогон edge-runtime локально (CLI edge container не бутится —
  «failed to determine entrypoint»); DB-логика покрыта pgTAP, живой
  смоук функций — на деплое.
