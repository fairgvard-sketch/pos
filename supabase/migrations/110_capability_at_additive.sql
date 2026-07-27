-- ============================================================
-- 110 CAPABILITY_AT ADDITIVE — org-грант больше не гасится первой
-- location-подпиской (исправление 108, forward-only).
--
-- Проблема 108:
--   org_has_capability_at пускал по org-уровневому entitlement'у только
--   при условии «у продукта НЕТ ни одной location-подписки». На проде
--   все организации живут на грантах бэкфилла 100 (org-уровень, без
--   подписок), поэтому пока всё работало. Но первая же продажа
--   подписки на ОДНУ точку сети снимала это условие и отключала
--   продукт во ВСЕХ остальных точках организации:
--
--     «Булочка», POS выдан бэкфиллом 100 на org.
--     grant_subscription(org, 'pos', Дизенгоф)  ← первая продажа
--     → Ротшильд теряет кассу, хотя за неё никто не переставал платить.
--
--   Тихая потеря доступа в горячем потоке — ровно то, чего вся модель
--   103–109 старается избежать.
--
-- Новая семантика — АДДИТИВНАЯ, но не всякая org-строка равна гранту.
--
--   `organization_products` совмещает две разные сущности, и их надо
--   различать по `source` (103):
--     * source IN ('developer','manual') — НАСТОЯЩИЙ грант на всю
--       организацию: выдан человеком, действует во всех точках;
--     * source IN ('trial','subscription') — АГРЕГАТ подписок, который
--       пишет sync_entitlement_from_subscription (108). Это отражение
--       того, что «продукт где-то оплачен», а НЕ право на всю сеть.
--
--   Наивное «пускать по любой org-строке» открыло бы продукт во всех
--   точках после первой же поточечной продажи: купил QR в киоске —
--   получил QR во всей сети. Поэтому агрегатные строки здесь
--   игнорируются, а точку покрывает только своя подписка.
--
--   Возможность есть, если действует org-ГРАНТ (developer/manual) ЛИБО
--   живая подписка на эту точку. Продажа подписки никогда не отнимает
--   ранее выданный грант; закрытие org-доступа — по-прежнему явная
--   операция (revoke_org_product, 104), а не побочный эффект.
--
-- Что это значит на практике:
--   * существующие организации (бэкфилл 100, source='manual')
--     продолжают работать во всех точках, сколько бы подписок им ни
--     выдали;
--   * НОВЫЕ организации (104 продукты не раздаёт) org-грантов не имеют,
--     поэтому у них работает ровно то, что оплачено поточечно;
--   * чтобы перевести старого клиента на потарифную модель, надо
--     осознанно снять org-грант: revoke_org_product(org, product),
--     затем выдать подписки на нужные точки.
--
-- ⚠️ ТРЕБУЕТ 108.
-- ============================================================

CREATE OR REPLACE FUNCTION org_has_capability_at(
  p_org        UUID,
  p_location   UUID,
  p_capability TEXT
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    -- 1) org-уровневый ГРАНТ действует во ВСЕХ точках организации
    --    (developer, manual, договорные выдачи, бэкфилл 100).
    --    Наличие подписок его не отменяет — только явный revoke.
    --    Агрегатные строки (trial/subscription) сюда не входят: они
    --    лишь отражают наличие подписок, право на сеть не дают.
    EXISTS (
      SELECT 1
      FROM organization_products op
      JOIN product_catalog pc       ON pc.key = op.product AND pc.is_active
      JOIN product_capabilities cap ON cap.product = op.product
      WHERE op.org_id = p_org
        AND cap.capability = p_capability
        AND op.source IN ('developer', 'manual')
        AND op.is_active
        AND op.status IN ('active', 'trialing')
        AND op.starts_at <= NOW()
        AND (op.expires_at IS NULL OR op.expires_at > NOW())
    )
    -- 2) живая подписка именно на эту точку (доступ до конца grace)
    OR EXISTS (
      SELECT 1
      FROM subscriptions s
      JOIN product_catalog pc       ON pc.key = s.product AND pc.is_active
      JOIN product_capabilities cap ON cap.product = s.product
      WHERE s.org_id = p_org
        AND s.location_id = p_location
        AND cap.capability = p_capability
        AND s.status IN ('trialing', 'active', 'past_due')
        AND (subscription_access_until(s.*) IS NULL
             OR subscription_access_until(s.*) > NOW())
    )
$$;

REVOKE ALL ON FUNCTION org_has_capability_at(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION org_has_capability_at(UUID, UUID, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION org_has_capability_at(UUID, UUID, TEXT) IS
  'Возможность в КОНКРЕТНОЙ точке (аддитивно, 110): org-грант source=developer/manual действует во всех точках и не гасится продажей подписки; location-подписка добавляет доступ своей точке. Агрегатные строки source=trial/subscription права на сеть не дают. Снятие org-доступа — только явный revoke_org_product. Fail closed.';
