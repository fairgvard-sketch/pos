-- ============================================================
-- 078 STOCK FLOW REPORT — оборотка: начальный/конечный остаток
-- и движение в деньгах (Poster «Отчёт по движению», но точнее).
--
-- stock_report расширяется, сигнатура прежняя:
--
--   * opening/closing — остаток на границах периода, ЯКОРЕНИЕ по
--     stock_after журнала (последняя строка до границы), а не
--     пересчёт назад от текущего остатка. Ретроактивные правки
--     каталога и прямые правки stock в карточке товара не искажают
--     прошлое; позиция без движений в периоде в отчёт не попадает.
--     opening позиции, чьё первое движение внутри периода, — это
--     stock_after − qty_delta её первой строки (0 для новой).
--   * *_value — суммы по типам из снапшотов value (077): деньги
--     движения зафиксированы в момент операции, отчёт исторический.
--   * closing_value — конечный остаток × ТЕКУЩАЯ себестоимость
--     (стоимость склада на конец периода в сегодняшних ценах).
--
-- Позиции сортируются по расходу, как раньше. Клиенты со старым
-- бандлом просто не читают новые поля.
--
-- Журналу добавляется монотонный seq: строки одной транзакции делят
-- created_at (NOW() транзакционный), и тай-брейк по случайному UUID
-- давал недетерминированные якоря. Существующие строки получают seq
-- при перезаписи таблицы — порядок исторических данных приближённый,
-- новых — точный.
-- ============================================================

ALTER TABLE stock_movements
  ADD COLUMN seq BIGINT GENERATED ALWAYS AS IDENTITY;

CREATE OR REPLACE FUNCTION stock_report(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH m AS (
    SELECT sm.menu_item_id, sm.supply_item_id, sm.name, sm.type, sm.qty_delta,
           sm.stock_after, sm.value, sm.created_at, sm.seq,
           sm.created_at >= p_from AS in_period
    FROM stock_movements sm
    WHERE sm.location_id = auth_location_id()
      AND sm.created_at < p_to
  ),
  agg AS (
    SELECT m.menu_item_id,
           m.supply_item_id,
           MAX(m.name) AS moved_name,
           -COALESCE(SUM(m.qty_delta) FILTER (WHERE in_period AND m.type = 'sale'), 0)            AS sold,
            COALESCE(SUM(m.qty_delta) FILTER (WHERE in_period AND m.type IN ('void', 'split')), 0) AS returned,
           -COALESCE(SUM(m.qty_delta) FILTER (WHERE in_period AND m.type = 'waste'), 0)           AS waste,
            COALESCE(SUM(m.qty_delta) FILTER (WHERE in_period AND m.type = 'receive'), 0)         AS received,
            COALESCE(SUM(m.qty_delta) FILTER (WHERE in_period AND m.type = 'count'), 0)           AS count_adj,
           -COALESCE(SUM(m.value) FILTER (WHERE in_period AND m.type = 'sale'), 0)            AS sold_value,
            COALESCE(SUM(m.value) FILTER (WHERE in_period AND m.type IN ('void', 'split')), 0) AS returned_value,
           -COALESCE(SUM(m.value) FILTER (WHERE in_period AND m.type = 'waste'), 0)           AS waste_value,
            COALESCE(SUM(m.value) FILTER (WHERE in_period AND m.type = 'receive'), 0)         AS received_value,
            COALESCE(SUM(m.value) FILTER (WHERE in_period AND m.type = 'count'), 0)           AS count_value,
           -- Якоря границ: последняя строка до p_from / первая в периоде / последняя до p_to
           (ARRAY_AGG(m.stock_after ORDER BY m.seq DESC) FILTER (WHERE NOT in_period))[1]      AS before_after,
           (ARRAY_AGG(m.stock_after - m.qty_delta ORDER BY m.seq) FILTER (WHERE in_period))[1] AS first_before,
           (ARRAY_AGG(m.stock_after ORDER BY m.seq DESC))[1]                                   AS closing,
           COUNT(*) FILTER (WHERE in_period)                                                   AS period_moves
    FROM m
    GROUP BY m.menu_item_id, m.supply_item_id
  )
  SELECT jsonb_build_object('items', COALESCE(jsonb_agg(
    jsonb_build_object(
      'menu_item_id',   a.menu_item_id,
      'supply_item_id', a.supply_item_id,
      'kind',           CASE WHEN a.supply_item_id IS NOT NULL THEN 'supply' ELSE 'menu' END,
      'name',           COALESCE(mi.name, si.name, a.moved_name),
      'unit',           si.unit,
      'opening',        COALESCE(a.before_after, a.first_before, 0),
      'sold',           a.sold,
      'returned',       a.returned,
      'waste',          a.waste,
      'received',       a.received,
      'count_adj',      a.count_adj,
      'sold_value',     a.sold_value,
      'returned_value', a.returned_value,
      'waste_value',    a.waste_value,
      'received_value', a.received_value,
      'count_value',    a.count_value,
      'closing',        a.closing,
      'closing_value',  CASE WHEN a.supply_item_id IS NOT NULL THEN movement_value(a.closing, si.cost, si.unit)
                             ELSE movement_value(a.closing, mi.cost, NULL) END,
      'stock_now',      CASE WHEN a.supply_item_id IS NOT NULL THEN si.stock
                             WHEN mi.track_inventory THEN mi.stock ELSE NULL END
    ) ORDER BY a.sold DESC, COALESCE(mi.name, si.name, a.moved_name)
  ), '[]'::jsonb))
  FROM agg a
  LEFT JOIN menu_items   mi ON mi.id = a.menu_item_id
  LEFT JOIN supply_items si ON si.id = a.supply_item_id
  WHERE a.period_moves > 0;
$$;

REVOKE EXECUTE ON FUNCTION stock_report FROM anon, public;
GRANT EXECUTE ON FUNCTION stock_report(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
