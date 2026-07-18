# База данных и Supabase

## Целевой проект

Боевой project ref: `qgmnxrgtlpyqglwqmsej`.

Перед миграциями и деплоем функций `scripts/check-project-ref.mjs` сверяет:

1. ref из `VITE_SUPABASE_URL` в `.env`;
2. `supabase/.temp/project-ref`, если CLI уже привязан.

Несовпадение останавливает команду. Guard появился после инцидента с применением
миграций не в тот проект и не должен обходиться ручным вызовом без проверки.

## Миграции

Схема хранится в `supabase/migrations/` и на текущем baseline состоит из
`001_foundation.sql` … `071_explicit_grants_baseline.sql`.

Правила:

- применять строго по номеру;
- не редактировать миграцию, которая уже могла попасть в окружение;
- любое исправление — новый файл со следующим номером;
- сначала миграция, затем frontend, который вызывает новый RPC;
- финансовые данные не удалять даже в миграциях исправления;
- SECURITY DEFINER функции всегда скоупить по организации и явно выдавать
  минимальные grants;
- каждый новый объект (таблица/функция) обязан получать ЯВНЫЙ `GRANT`
  нужным app-ролям — см. «Default privileges» ниже;
- вместе с новой миграцией обновлять `MIN_SCHEMA_VERSION` в
  `src/lib/schemaVersion.ts` — CI (`npm run check:schema`) требует равенства
  константы номеру последней миграции.

### Версия схемы для фронтенда (081)

`get_schema_version()` (SECURITY DEFINER, только `authenticated`) возвращает
максимальный номер из журнала миграций CLI
(`supabase_migrations.schema_migrations`) — отдельного счётчика, который можно
забыть обновить, нет. Фронт на старте рабочих экранов сверяет его с
`MIN_SCHEMA_VERSION`: отстающая база даёт экран «Требуется обновление базы
данных» (`SchemaGuard`), а не тихо пустой каталог. Ошибка сети/офлайн трактуется
как `unknown` и работу не блокирует — POS живёт по локальному кэшу.

## Default privileges: legacy production vs новые стеки

Новые стеки Supabase (локальный CLI, CI и свежесозданные проекты) поставляются
с ужесточёнными default privileges: объекты, созданные ролью `postgres` в
`public`, НЕ получают автоматических DML/EXECUTE грантов для
`anon`/`authenticated`. Действующий production (`qgmnxrgtlpyqglwqmsej`) создан
на старых дефолтах (полный DML + EXECUTE), поэтому исторические миграции с
паттерном «`REVOKE ... FROM anon, public`, полагаясь на неявный базовый грант»
там работают.

Следствия:

- pgTAP на чистом стеке ловит отсутствие грантов (так был найден красный CI,
  исправление devices/device-RPC — миграция 070);
- миграция 071 — baseline: механический перенос фактической модели доступа
  production (`supabase db dump`, фильтр authenticated/service_role, без
  anon — гостевые потоки идут через Edge Functions). Эквивалентность
  доказана диффом грантов свежего стека с production: 0 расхождений;
- каждый НОВЫЙ объект после 071 обязан выдавать явные GRANT в своей
  миграции — автоматики больше нет ни локально, ни на новых проектах.

Применение:

```bash
npm run check:ref
npm run db:push
```

Для локального полного прогона:

```bash
supabase start
supabase db reset
supabase test db
```

## Основные таблицы

### Tenant и доступ

| Таблица | Назначение |
|---|---|
| `orgs` | организация-tenant |
| `locations` | точка, валюта, НДС, реквизиты и JSONB-настройки |
| `devices` | физические терминалы и их настройки |
| `staff` | сотрудники без доступного клиенту `pin_hash` |
| `staff_sessions` | короткоживущая серверная PIN-сессия и права |

### Каталог

`stations`, `menu_categories`, `menu_items`, `item_variants`,
`modifier_groups`, `modifiers`, `menu_item_modifier_groups`.

Цены товаров, вариантов и модификаторов — целые агороты. `save_menu_item()`
сохраняет товар, варианты, привязки групп и упаковку (`p_supplies`, 075) одной
транзакцией. `reorder_menu()` атомарно обновляет порядок.

`variant_supplies` (075) — рецепт и упаковка: связка «товар/вариант →
расходник» (`qty` за единицу, `takeaway_only`). Продажа списывает расходники
в триггерах `order_items` по типу заказа (`takeaway`/`delivery` либо любой);
компенсации void/split возвращают ровно списанное по журналу `stock_movements`
(`order_item_id`), поэтому правки каталога между продажей и void не искажают
остатки. `variant_id` пересоздаются при каждом сохранении товара; клиент
адресует варианты позиционно (`variant_index`), а сохранение без `p_supplies`
(старый клиент) переносит variant-связки на новые варианты по имени.

Рецептуры (076): ингредиенты — те же `supply_items`, склад ведётся в
БАЗОВЫХ единицах (`г`/`мл`/`шт`) целыми числами, float запрещён (мешок муки
25 кг = 25000 г). Конвенция стоимости: для `г`/`мл` `supply_items.cost` —
агороты за 1000 базовых единиц (кг/л), для штучных — за единицу; сервер
стоимость не перемножает, конвенция живёт в UI (`costDivisor`).
`modifier_supplies` — расход модификатора (сироп 20 мл, овсяное молоко
180 мл), списывается триггером на `order_item_modifiers` без условия по типу
заказа; CRUD прямой (RLS, как у `modifiers`), `WITH CHECK` дополнительно
привязывает модификатор и расходник к организации. Дефолтные модификаторы
попадают в заказ автоматически, поэтому замена молока — это расход на
модификаторах группы «Молоко», а не рецепт товара. Компенсации те же:
журнал по `order_item_id` охватывает строки модификаторов без отдельного
кода. Лимиты `receive_stock`/`stock_take`/`add_waste` для `kind='supply'`
подняты под граммы (1 000 000 / 10 000 000 / 1 000 000), для товаров меню —
прежние.

### Заказы и деньги

| Таблица | Назначение |
|---|---|
| `orders` | заказ и снапшоты итогов/НДС/скидок |
| `order_items` | снапшоты позиций заказа |
| `order_item_modifiers` | снапшоты модификаторов |
| `payments` | неизменяемые оплаты и способы оплаты |
| `refunds` | полные и частичные возвраты |
| `order_counters` | дневная нумерация заказов |
| `receipt_counters` | фискальная нумерация чеков |
| `refund_counters` | нумерация документов возврата |
| `op_log` | результаты идемпотентных клиентских операций |

Платёжные способы: `cash`, `card`, `cibus`, `tenbis`, `bit`. Карта и кошельки
сейчас являются учётными каналами; Cardcom ещё не проводит транзакцию из кассы.

Начиная с `068`, публичный `pay_order` валидирует стандартный израильский лимит
наличной части и точное равенство суммы payment rows сумме к оплате. Прежняя
реализация переименована в `pay_order_unchecked`, её `EXECUTE` отозван у
клиентских ролей. Трактовки и внешние release-gates описаны в
[israel-compliance.md](israel-compliance.md).

### Операционная работа

- `shifts`, `cash_movements`, `z_counters` — смены и касса;
- `table_zones` — зоны плана зала и их порядок;
- `tables` — столы, ссылка на зону, координаты, статус, вместимость и объединяемость;
- `time_entries` — табель;
- `guests`, `loyalty_events` — клиентская база и лояльность;
- `stock_movements`, `supply_items`, `waste_entries` — склад; каждая строка
  журнала несёт снапшот себестоимости `unit_cost` и денежную оценку `value`
  (077), а также монотонный `seq` (078) — тай-брейк порядка строк одной
  транзакции;
- `variant_supplies` — рецепт/упаковка товара: авто-списание продажей (075);
- `modifier_supplies` — расход модификаторов: сиропы, молоко, доп. шоты (076);
- `suppliers`, `supply_docs`, `supply_packagings` — поставщики, приходные
  накладные и фасовки (077). Накладная неизменяема, её `id` = `batch_id`
  строк журнала; `total` — снапшот суммы строк в агоротах;
- `online_orders` — входящие гостевые заказы;
- `reservations` — заявки и подтверждённые брони;
- `client_errors` — журнал клиентских ошибок телеметрии (074): дедупликация по
  `fingerprint` в пределах дня, retention 30 дней, закрыта для клиентов
  целиком (как `op_log`) — запись только через `report_client_errors`.

## Tenant-изоляция и RLS

Каждая доменная таблица скоупится по `org_id`. Функции `auth_org_id()` и
`auth_location_id()` читают значения из JWT `app_metadata`. Клиент не выбирает
организацию параметром запроса и не может расширить scope фильтром.

Для `devices` модель строже на запись:

- чтение возможно в пределах организации для менеджерского списка;
- изменение своей строки связано с `auth.uid()`;
- `register_device` идемпотентен по `(org_id, device_uuid)`;
- `update_device_settings` обновляет только устройство текущего auth-user.

RLS — защита, а не вспомогательный UI-фильтр. Любой новый table/RPC должен
проверяться под двумя организациями. Базовые проверки находятся в
`supabase/tests/rls_scope.test.sql`.

## Двухуровневая авторизация

Устройство проходит Supabase Auth. `bootstrap_org()` создаёт initial data и
обновляет JWT metadata.

Сотрудник проходит `verify_staff_pin()`. Хеш PIN не читается клиентом благодаря
колоночным grants. Успешная проверка создаёт `staff_sessions`; токен передаётся
в привилегированные RPC как `p_staff_session`. `require_staff_perm()` проверяет
сессию, организацию, активность сотрудника и требуемый уровень права.

Горячий поток (`place_order`, `pay_order`, `open_or_get_table_order`,
`append_to_order`, `mark_item_ready`, `mark_order_ready`) с 086 тоже принимает
`p_staff_session` и проверяет её `require_staff_session()` в МЯГКОМ режиме:
NULL пропускается (старые клиенты, хвост офлайн-очереди), переданный битый
токен даёт `staff session invalid`. Автор операции остаётся `p_staff_id` из
payload — сессия лишь подтверждает живого сотрудника за кассой. Прежние
реализации переименованы в `*_impl` и закрыты от клиентов (приём 068).
Строгий режим — отдельной миграцией после раскатки клиентов и опустошения
офлайн-очередей (зеркало пары 044/045).

## Ключевые RPC

### Продажа и зал

- `place_order`, `pay_order`;
- `open_or_get_table_order`, `append_to_order`;
- `move_table_order`, `merge_table_orders`, `split_order`;
- `set_order_discount`, `void_order_item`, `void_table_order`;
- `mark_item_ready`, `mark_order_ready`;
- `issue_refund`, `set_order_buyer`, `apply_loyalty`.

### Смены и учёт

- `open_shift`, `current_shift`, `shift_report`, `close_shift`;
- `add_cash_movement`;
- `punch_by_pin`, `clock_out`, `save_time_entry`, `time_entries_report`;
- `sales_report`.

### Склад

- `receive_stock` — приход как накладная (077): опциональные
  `p_supplier_id`/`p_doc_no` и клиентский `p_doc_id` — повтор того же
  документа после timeout идемпотентен (PRIMARY KEY `supply_docs`, не
  `op_log`). Цена прихода пересчитывает себестоимость средневзвешенно;
  `update_cost` = ручное «установить точно»;
- `stock_take` — инвентаризация; возвращает `shortage_value` и
  `surplus_value` (079) — расхождение по себестоимости в агоротах;
- `add_waste`;
- `stock_report` — оборотка (078): `opening`/`closing` по якорям
  `stock_after`+`seq` журнала (ретроактивные правки каталога не искажают
  прошлое), деньги движений из снапшотов `value`, `closing_value` — остаток
  на конец × текущая себестоимость; `counts` (085) — число count-строк
  периода: отчёт «теория vs факт» отличает «инвентаризация сошлась в ноль»
  от «позицию не проверяли»;
- `upsert_supply_item`, `set_supply_item_active`;
- `upsert_supplier`, `set_supplier_active` — право `stock_receive`;
- `movement_value(qty, cost, unit)` — денежная оценка движения; конвенция
  единиц 076: для `г`/`мл` cost — агороты за 1000 базовых единиц.

### Фискальный экспорт (Единый формат 1.31)

- `uf_export_info` — реквизиты точки для набора выгрузки;
- `uf_export_documents` — постраничная хронологическая лента оплаченных
  заказов и возвратов периода (границы дней — по Asia/Jerusalem).

Оба требуют staff-сессию с правом `manage`; вызываются Edge Function
`uniform-format-export` под JWT устройства (не `service_role`).

### Онлайн и бронь

- `submit_online_order`, `get_online_order_status`, `accept_online_order`,
  `reject_online_order`, `set_online_pause`, `set_online_prep_range`;
- `submit_reservation`, `reservation_availability`, `create_reservation`,
  `accept_reservation`, `reject_reservation`, `set_reservation_table`,
  `seat_reservation`, `cancel_reservation`, `guest_history`.

### Настройки и каталог

- `patch_location_settings` — server-side JSONB merge; известные
  разделы-объекты (в т.ч. `interface`, 069) мержатся поключево, прочие
  верхнеуровневые ключи присваиваются целиком;
- `save_menu_item` — атомарное сохранение товара, вариантов, групп и
  упаковки (075: `p_supplies`, вариант адресуется `variant_index`);
- `reorder_menu` — атомарная сортировка;
- `register_device`, `update_device_settings` — per-device конфигурация.

### Телеметрия (074)

- `device_heartbeat` — лёгкий периодический апдейт собственной строки
  `devices`: версия приложения/моста печати, здоровье offline-очереди
  (`outbox_pending`, `outbox_oldest_at`, `outbox_failed`), `last_seen_at`.
  Heartbeat до `register_device` — тихий no-op: телеметрия не роняет кассу;
- `report_client_errors` — приём пакета ошибок с клиента: не более 20 за
  вызов, не более 100 новых fingerprint на устройство в день, все поля
  обрезаются на входе, повтор fingerprint наращивает `count`. Источники:
  `window|promise|react|outbox|print|shift` (082: `shift` — событие
  `shift_overdue`, когда открытая смена пересекла границу операционного
  дня `settings.shift.day_cutoff`, дефолт 04:00); неизвестный source
  клампится в `window`;
- операторские view `ops_fleet` и `ops_errors` — только для
  `service_role`/SQL Editor (см. [deployment.md](deployment.md),
  «Наблюдаемость парка»).

## Идемпотентность и время клиента

Миграция `042_offline_idempotency.sql` добавляет `op_log` и UUID-параметры для
денежных/составных операций. Повтор с тем же UUID возвращает первый результат,
а не создаёт второй заказ, платёж или строки.

Время, пришедшее от клиента, проходит через `clamp_client_ts()`: честное время
офлайн-операции сохраняется, но явно некорректные часы терминала не могут
безгранично исказить отчёты.

UUID должен создаваться до первой попытки запроса и повторно использоваться
после timeout. Новый UUID на retry разрушает гарантию идемпотентности.

## Edge Functions

| Функция | Назначение | Статус |
|---|---|---|
| `public-menu` | безопасная публичная витрина каталога | production |
| `public-order` | приём заказа и чтение статуса по client UUID | production |
| `public-reserve` | профиль точки, слоты, создание/отмена брони | production |
| `uniform-format-export` | набор Единого формата 1.31 за период (INI/BKMVDATA) | построена, деплой pending |
| `cardcom-payment` | будущая платёжная интеграция | карантин, `503`/`501` |

Публичные функции используют `service_role` только внутри Deno runtime и
возвращают allow-listed поля. Они не отдают гостю внутренние settings, staff,
RLS-токены или service key.

Деплой:

```bash
npm run functions:deploy
```

`cardcom-payment` нельзя считать готовой даже при наличии функции в проекте.
Текущий код намеренно не проводит оплату. См. [cardcom-plan.md](cardcom-plan.md).

## Проверка изменения схемы

- [ ] создан новый номер миграции;
- [ ] все новые доменные таблицы имеют `org_id` и RLS;
- [ ] grants не открывают `pin_hash` или server-only данные;
- [ ] RPC проверяет org/location из JWT, а не доверяет client org id;
- [ ] финансовая операция не делает UPDATE/DELETE исторической записи;
- [ ] повтор того же UUID возвращает тот же результат;
- [ ] totals и названия/цены позиций снапшотятся;
- [ ] локальный `supabase db reset` проходит;
- [ ] pgTAP дополнен для нового security/financial инварианта;
- [ ] project ref проверен до удалённого применения.
