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

- `idempotency.test.sql` — дважды вызывает настоящий `pay_order` с одним
  `p_payment_uuid` и проверяет один payment, один номер чека и один op_log.
- `rls_scope.test.sql` — под ролью `authenticated` и JWT org A проверяет
  cross-org SELECT, запрет UPDATE чужого устройства и UPDATE собственной строки.

## CI

pgTAP требует локальный Supabase и Docker, поэтому не входит в `npm test`.
Workflow `.github/workflows/ci.yml` поднимает отдельный локальный стек,
применяет миграции с нуля и запускает эти тесты на каждый push/PR. Удалённый
проект при этом не затрагивается. Фронтенд-инварианты (округления денег, офлайн-идемпотентность,
scope-карантин, drain waiting_auth, длинный чек, optimistic rollback) покрыты
vitest-тестами в `src/`.
