# Бронирование столов с сайта (053–063)

Гость бронирует стол на публичной странице. В обычном режиме касса подтверждает
заявку; в instant-режиме сервер проверяет доступность и подтверждает бронь сразу.
Система построена по образцу онлайн-заказов: staging-таблица, Edge Function под
service_role, realtime-уведомление в сайдбаре и настройки на уровне точки.

## Поток

```
Гость /reserve/<location_id>
  → форма: дата, время, гости (лимит задаёт точка), имя, телефон, комментарий
  → POST public-reserve {action:'submit'} → submit_reservation (service_role)
  → заявка в reservations (status='new'), client_uuid — секрет гостя
Касса (сайдбар, режим столов)
  → realtime: звонок playReservationChime + тост + бейдж «Брони»
  → /reservations: Подтвердить (опционально сразу стол) / Отклонить (причина)
Гость (поллинг 5с по client_uuid)
  → confirmed: «Бронь подтверждена» (+ стол) | rejected: причина
  → может отменить бронь (cancel) — касса получит тост «Гость отменил»
Instant-режим
  → GET live-доступности → submit_reservation сам подбирает стол
  → confirmed без ручного действия кассы | full_slot при гонке
План зала /hall
  → стол с confirmed-бронью в окне [now−30мин, now+2ч] — синий + время
    (вычисляется на клиенте, tables.status не трогаем)
```

## Ключевые решения

- **Тумблер default = ВЫКЛЮЧЕНО** (`locations.settings->reservations->enabled`,
  отсутствие ключа = выкл — в отличие от online_orders). Включается:
  Настройки → Обслуживание → «Бронирование». Enforced на сервере
  (`submit_reservation` → код `disabled`).
- **Открытая смена не нужна** ни для заявки, ни для подтверждения — бронь
  обычно на будущую дату. Вместо «часов приёма» окно времени:
  `NOW()+30 мин … NOW()+30 дней` (код `invalid_time`).
- **Статусы только вперёд**: `new → confirmed | rejected | cancelled`;
  `confirmed → rejected` (касса отменяет по звонку гостя) и
  `confirmed → cancelled` (гость сам). Статуса `expired` нет — прошедшие
  скрывает клиент фильтром по `reserved_at` (визит был >2ч назад → история).
- **Стол опционален**: назначается при подтверждении (пикер с подсказкой о
  конфликте ±2ч — не блокировка) или позже (`set_reservation_table`).
- **Анти-спам** в `submit_reservation`: ≤3 заявок с телефона за 15 мин
  (`rate_limited`), ≤30 необработанных на точку (`busy`).
- Идемпотентность: `client_uuid` UNIQUE, повторный POST → `duplicate:true`.
- Гостю наружу уходит только `settings->reservations` (флаг), не весь settings.

## Файлы

| Слой | Путь |
|------|------|
| Миграция | `supabase/migrations/053_reservations.sql` |
| Edge Function | `supabase/functions/public-reserve/index.ts` |
| Экран кассы `/reservations` | `src/features/reservations/ReservationsPage.tsx` |
| API кассы + realtime | `src/features/reservations/api.ts` |
| Гостевая `/reserve/:locId` | `src/features/reservations/PublicReservePage.tsx` |
| Клиент гостя | `src/features/reservations/publicReserveApi.ts` |
| Бейдж + звонок | `src/components/AppSidebar.tsx` (+ `src/lib/sound.ts`) |
| Подсветка зала | `src/features/tables/HallPage.tsx` (`['reservations_today']`) |
| Настройки | `src/features/settings/sections/ServiceSection.tsx` → `ReservationsBlock` |

## Деплой (строго по порядку!)

1. **Миграция** `053_reservations.sql` — SQL Editor Supabase Dashboard,
   проект `qgmnxrgtlpyqglwqmsej` (сверить ref с `VITE_SUPABASE_URL`).
2. **Edge Function**:
   ```bash
   npx supabase functions deploy public-reserve --project-ref qgmnxrgtlpyqglwqmsej
   ```
   Секреты не нужны — `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` инжектятся сами.
3. **Фронтенд** — пуш в `main` (Vercel). Порядок важен: сайдбар в режиме
   столов читает `reservations` — без миграции его запрос будет падать.

Ссылка для гостей: `https://pos-self-sigma.vercel.app/reserve/<location_id>`.
QR-флаер печатается из Настройки → Обслуживание → Бронирование.

## Проверка после деплоя

```bash
FN=https://qgmnxrgtlpyqglwqmsej.supabase.co/functions/v1
# 1. Инфо точки: accepting=false до включения тумблера
curl "$FN/public-reserve?loc=<LOC>" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
# 2. Заявка (после включения тумблера в настройках)
curl -X POST "$FN/public-reserve" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "Content-Type: application/json" \
  -d '{"action":"submit","loc":"<LOC>","client_uuid":"'$(uuidgen | tr A-Z a-z)'",
       "name":"Тест","phone":"0501234567","party_size":2,
       "reserved_at":"'$(date -u -v+2H +%Y-%m-%dT%H:%M:%SZ)'"}'
# 3. Статус по client_uuid
curl "$FN/public-reserve?id=<CLIENT_UUID>" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
```

Сценарий в двух вкладках: гость `/reserve/<loc>` отправляет форму → на кассе
звонок и бейдж «Брони» → Подтвердить со столом → у гостя ≤5с «Бронь
подтверждена · стол N» → в `/hall` стол синий с временем (если визит ≤2ч).
Отмена гостем → тост «Гость отменил бронь», стол снова зелёный.

---

## Мгновенная бронь + вместимость (063, «Ontopo»)

Платформенная надстройка: гость видит **live-доступность** и бронь
подтверждается **мгновенно** без хостес (как Ontopo). Всё за флагами
`settings.reservations`, дефолты консервативны — каждое кафе включает нужное.

### Что добавилось

| Слой | Изменения |
|------|-----------|
| Миграция `063_reservation_availability.sql` | `tables.seats`/`combinable`; поля брони `duration_min`/`auto`/`hold_table_ids`/`deposit_*`/`occupancy`; EXCLUDE `reservations_no_overlap`; RPC `reservation_availability`, `guest_history`, `_pick_tables`/`_table_free`; `submit_reservation`/`accept_reservation` v2 |
| Edge `public-reserve` | GET `?loc&date&party` → сетка `{time,free}`; info отдаёт `instant`; ошибка `full_slot` |
| Гость `PublicReservePage` | занятые слоты дизейбл/зачёркнуты, «Забронировать сейчас», мгновенное подтверждение |
| Касса `TableEditSheet` | поле «мест» + тумблер «можно объединять» |
| Касса `ReservationsPage` | CRM-бейдж гостя (постоянный/отмены) + бейдж «Авто» |
| Настройки `ReservationsDetail` → `InstantBlock` | тумблеры instant/combine, длительность/буфер, депозит-плейсхолдер |

### Модель доступности

`reservation_availability` идёт по слотам дня [open..close] шага slot_min и для
каждого зовёт `_pick_tables`: наименьший свободный стол с `seats>=party`, а при
`combine=true` — жадно набирает `combinable`-столы до суммарной вместимости.
Свободен = нет живой (new/confirmed) брони, чьё окно занятости
`[reserved_at, +duration_min)` (± `buffer_min`) пересекает слот. Гонку двух
инстант-гостей на один стол ловит EXCLUDE-констрейнт → `full_slot`.

### Флаги `settings.reservations` (все опциональны)

`instant` (мгновенное подтверждение, деф off) · `combine` (объединение столов) ·
`duration_min` (деф 90) · `buffer_min` (деф 0) · `deposit_required`/
`deposit_amount`(агороты)/`deposit_from_party` (ПЛЕЙСХОЛДЕР, без оплаты).

### Деплой 063 (строго по порядку)

1. **Миграция** `063_reservation_availability.sql` — SQL Editor (проект
   `qgmnxrgtlpyqglwqmsej`). ✅ применена 2026-07-13.
2. **Edge Function**: `npx supabase functions deploy public-reserve
   --project-ref qgmnxrgtlpyqglwqmsej` (нужен новый availability-эндпоинт).
3. **Фронтенд** — пуш в `main` (Vercel).

Включение у кафе: Настройки → Обслуживание → Бронирование → «Мгновенное
подтверждение». Обязательно проставить **число мест** у столов (иначе движок
считает по дефолту 2) в конструкторе `Настройки → План зала`.

### Известные ограничения

Оплата депозита — плейсхолдер (ждёт Cardcom Low Profile). SMS нет.
Объединённые столы хранятся (`hold_table_ids`), но план зала их визуально не
группирует. `set_reservation_table` при ручном переносе на занятый слот отдаёт
сырую ошибку exclusion (accept/submit — дружелюбный `table_busy`/`full_slot`).

## Оформление публичной страницы

Настройки бронирования также содержат:

- отдельное фото-шапку с fallback на шапку онлайн-заказов, затем логотип;
- адрес и необязательные координаты для точной кнопки навигации;
- свободный текст часов работы;
- ссылки Instagram, Facebook и Google Review.

Поля хранятся в `locations.settings.reservations` (JSONB), а `public-reserve`
возвращает наружу только этот allow-listed профиль. Отдельная schema migration
для новых JSON-ключей не требуется; текущий общий baseline миграций заканчивается
на `065_device_settings.sql`.
