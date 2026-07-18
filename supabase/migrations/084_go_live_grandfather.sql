-- 084: go-live wizard (P3-13) — grandfather точек, работавших до фичи.
--
-- Фронт (MIN_SCHEMA_VERSION = 84) блокирует ПЕРВУЮ продажу точки при
-- критических пробелах запуска (нет имени бизнеса/ИНН в реквизитах чека,
-- пустой каталог), пока менеджер не подтвердит запуск в чек-листе
-- (settings.go_live.confirmed_at, пишется через patch_location_settings).
--
-- Точки, у которых уже есть оплаченные заказы, работают в бою — помечаем их
-- подтверждёнными, чтобы деплой фронта ничего не остановил. Порядок релиза
-- строгий: сначала эта миграция, затем фронт (guard 081 это гарантирует).

update public.locations l
set settings = jsonb_set(
  coalesce(l.settings, '{}'::jsonb),
  '{go_live}',
  coalesce(l.settings -> 'go_live', '{}'::jsonb) || jsonb_build_object(
    'confirmed_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'source', 'grandfather'
  )
)
where (l.settings -> 'go_live' ->> 'confirmed_at') is null
  and exists (
    select 1
    from public.orders o
    where o.location_id = l.id
      and o.paid_at is not null
  );
