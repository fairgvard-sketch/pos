# SQL-тесты (pgTAP)

Интеграционные проверки инвариантов БД против **локального** Supabase
(удалённый проект `qgmnxrgtlpyqglwqmsej` не трогаем).

## Запуск

```bash
supabase start                 # локальный стек (Docker)
supabase db reset              # применить все миграции с нуля
supabase test db               # прогнать pgTAP из supabase/tests/*.sql
```

`supabase test db` оборачивает каждый файл в транзакцию и откатывает —
данные не остаются.

## Что покрыто

- `idempotency.test.sql` — повтор `pay_order` с тем же `p_payment_uuid`
  возвращает ПЕРВЫЙ результат и НЕ тратит второй номер чека (op_log, 042).
- `rls_scope.test.sql` — устройство org A не видит и не меняет строки org B
  (RLS по `auth_org_id()`); device видит только свою строку (065).

## Почему не в общем `npm test`

pgTAP требует запущенного Postgres (Docker), поэтому не входит во фронтенд-CI
(`npm run test:run`). Гоняется отдельно локально/в отдельном джобе с сервисом
Postgres. Фронтенд-инварианты (округления денег, офлайн-идемпотентность,
scope-карантин, drain waiting_auth, длинный чек, optimistic rollback) покрыты
vitest-тестами в `src/`.
