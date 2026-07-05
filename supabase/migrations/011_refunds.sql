create table if not exists refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  staff_id uuid not null references staff(id),
  amount numeric(10,2) not null,
  reason text,
  items jsonb not null default '[]',
  created_at timestamptz not null default now()
);

alter table refunds enable row level security;

create policy "staff can insert refunds"
  on refunds for insert
  with check (true);

create policy "staff can read refunds"
  on refunds for select
  using (true);
