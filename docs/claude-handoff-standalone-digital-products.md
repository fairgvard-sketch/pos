# Claude handoff: standalone ANGLE Menu and ANGLE Reserve

## Objective

Turn the existing QR menu, online orders, and reservations into independently
sellable ANGLE modules that work without ANGLE POS, while keeping one shared
platform, tenant model, catalog, locations, tables, guests, and upgrade path to
POS.

The target product model is:

- `ANGLE Menu` — can work without POS;
- `ANGLE Orders` — can work without POS through a web inbox;
- `ANGLE Reserve` — can work without POS through a web host desk;
- `ANGLE POS` — optional operational integration;
- an organisation can enable any combination of these modules.

This is not a request to build a second disconnected backend or duplicate the
catalog. The products must be commercially independent and technically
integrated.

## User decisions and scope locks

- QR menu and reservations must be usable without POS.
- A restaurant must be able to integrate the menu into its existing website.
- POS remains an optional add-on/integration.
- No guest payments in this project.
- No WhatsApp or Telegram integration in this project.
- Do not introduce subscription billing yet. Product entitlements may be
  provisioned manually for the MVP.
- Work in small, verifiable phases and atomic commits. Do not attempt a
  big-bang rewrite.
- Do not deploy migrations, Edge Functions, frontend builds, DNS, or production
  changes without explicit user approval for the concrete payload.

## Repositories

### POS and shared backend

Path: `/Users/enotov/Desktop/kassa`

Contains:

- React/Vite POS frontend;
- shared Supabase migrations, RLS, RPCs, and Edge Functions;
- guest routes `/order/:locId` and `/reserve/:locId`;
- current PWA manifests and POS integration.

Before changing anything, read completely:

- `AGENTS.md`
- `CLAUDE.md`
- `README.md`
- `docs/architecture.md`
- `docs/development.md`
- `docs/database.md`
- `docs/online-orders.md`
- `docs/reservations.md`
- `docs/deployment.md`

Current user-owned untracked files that must not be modified, staged, deleted,
renamed, or included in commits:

- `.claude/launch.json`
- `src/assets/drinks/capuccino2.png`

At handoff time the working branch is `feat/backoffice-fleet-devices`. Commit
`d9ce0fb` is already on `origin/main`. Resolve current Git state read-only
before choosing a branch. Never use destructive reset/checkout commands.

### Marketing site and owner back office

Path: `/Users/enotov/Desktop/anglesite`

Contains:

- marketing website;
- authenticated owner back office under `backoffice/`;
- production output for `/account/`;
- existing menu editor, online-channel settings, QR generation, location
  settings, team and device management.

Before changing anything, inspect repository instructions and read:

- `README.md`
- `backoffice/src/App.jsx`
- `backoffice/src/MenuManager.jsx`
- `backoffice/src/QrChannels.jsx`
- `backoffice/src/online.js`
- `backoffice/src/settings.js`
- `backoffice/src/supabase.js`
- `backoffice/src/styles.css`

The repository was clean on `main` at handoff time. Re-check before edits.

## Existing implementation — do not rediscover from scratch

### Already available

- Public guest menu: `src/features/online/PublicOrderPage.tsx`.
- Public reservation flow:
  `src/features/reservations/PublicReservePage.tsx`.
- Public API Edge Functions:
  `supabase/functions/public-menu`,
  `supabase/functions/public-order`,
  and the reservation public function.
- Online-order staging table and RPCs in migrations starting at `050`.
- Reservation tables, availability, table selection, and public RPCs in
  migrations `053` and `063`.
- Organisation/location tenant model with `org_id` and RLS.
- Owner web identities through `organization_members` from migration `088`.
- Back-office/server write foundation from migrations `091+`, including
  `get_backoffice_context`, `require_backoffice_or_staff`,
  `assert_backoffice_location`, and `patch_location_settings_web`.
- Web menu management already exists in
  `/Users/enotov/Desktop/anglesite/backoffice/src/MenuManager.jsx`.
- Web QR and channel settings already exist in
  `/Users/enotov/Desktop/anglesite/backoffice/src/QrChannels.jsx`.
- Per-location/table PWA identity is implemented by commit `d9ce0fb`.

### Current coupling that must be removed safely

1. `supabase/functions/public-menu/index.ts` derives `location.is_open` from an
   open row in `shifts`.
2. `submit_online_order` rejects with `closed` unless an ANGLE POS shift is
   open.
3. POS acceptance converts an `online_orders` row into a normal POS `orders`
   row and therefore depends on staff/PIN, a shift, and POS operations.
4. `OnlineOrdersPage` and `ReservationsPage` are behind
   `ProtectedRoute`, which requires a device Supabase session plus a POS PIN
   session.
5. `DeviceSetupPage` onboarding creates a POS-oriented device context and owner
   PIN.
6. Guest URLs are currently generated on `https://pos.angle.co.il` in
   `anglesite/backoffice/src/online.js`.

Reservations are already more independent than orders at the data layer, but
the staff management screen and actions still assume POS identity and offer
POS-specific actions such as seating a guest into an order.

## Target architecture

Use one backend and separate user surfaces:

- `app.angle.co.il` or the existing `/account/` — owner/operator dashboard;
- `menu.angle.co.il` — guest menu and ordering;
- `book.angle.co.il` — guest booking;
- `pos.angle.co.il` — POS only.

Domain/DNS changes require separate approval. The MVP may continue using the
current host while routes and boundaries are made domain-ready.

Split authentication/route guards conceptually:

- public guest routes: no account;
- back-office routes: Supabase Auth + active `organization_members`;
- POS routes: device session + staff PIN, as today.

Do not weaken existing POS RLS or privileged RPC checks to make the web
dashboard work.

## Proposed delivery phases

### Phase 0 — audit and architecture record

Before implementation:

1. Verify the latest migrations and production schema version.
2. Trace current bootstrap, JWT `app_metadata`, membership, RLS, public Edge
   Functions, and back-office API calls.
3. Write a concise architecture decision record covering entitlements,
   digital-only onboarding, service availability, and standalone order states.
4. Identify which work belongs in `kassa` versus `anglesite`.

Acceptance:

- no code mutation before the cross-repository dependency map is clear;
- no existing applied migration is edited;
- every schema change has a new forward-only migration.

### Phase 1 — module entitlements and digital identity

Add a server-enforced organisation/location product model, for example
`organization_products` or an equivalent normalized entitlement structure.
Expected module keys:

- `menu`
- `online_orders`
- `reservations`
- `pos`

Requirements:

- entitlements are checked server-side in public and privileged mutations;
- existing POS organisations are backfilled without feature regression;
- manual provisioning is sufficient for MVP;
- an owner can belong to and manage a digital-only organisation without
  registering a POS device;
- onboarding must not require a PIN for a digital-only account;
- preserve audit attribution through `organization_members`.

Do not simply reuse client-side navigation visibility as authorization.

Acceptance:

- an email/password owner can create/access an organisation and location with
  `menu` enabled and no device, staff PIN, or shift;
- a tenant cannot read or mutate another tenant;
- existing POS login and PIN flows still work unchanged.

### Phase 2 — standalone menu management and publishing

Use the existing back-office menu editor instead of creating another catalog.
Add a focused digital-product onboarding and publishing experience:

- create/edit catalog, variants, modifiers, images, video, availability;
- branding preview;
- public URL;
- location QR download;
- table QR download;
- copyable website button;
- responsive iframe embed code;
- install-to-home-screen behavior;
- module-aware navigation that hides POS-only concepts.

The view-only menu must remain available independently from POS shift state.
Ordering controls may be disabled while the catalog remains visible.

For website integration, ship the low-risk options first:

1. direct URL;
2. normal “Open menu” link/button;
3. responsive iframe/embed route with an explicit CSP/frame-ancestor policy.

A headless public catalog API, custom domains, and advanced JavaScript widget
are later milestones, not MVP blockers.

Acceptance:

- a restaurant with no POS can publish and embed its live menu;
- menu edits appear in the guest menu;
- multiple locations and multiple table QR contexts remain isolated;
- mobile, Hebrew RTL, and install-to-home-screen flows work.

### Phase 3 — standalone online-order operations

Separate “the venue accepts digital orders” from “an ANGLE POS shift is open”.

Introduce an explicit service/fulfilment mode, such as:

- dashboard standalone;
- ANGLE POS;
- external integration (future only).

For standalone mode:

- availability comes from configured business/order hours plus manual pause;
- accepting an order does not create a fiscal/POS `orders` record;
- the web dashboard supports the lifecycle:
  `new -> accepted -> preparing -> ready -> completed`, plus rejection/cancel;
- guest status polling works for both standalone and POS-backed orders;
- menu price and item snapshots remain immutable on the submitted order;
- rate limiting, idempotency, and tenant scope remain enforced;
- realtime and audible web notification are supported;
- there is no payment step.

For POS mode:

- preserve the existing acceptance/conversion into the POS flow;
- continue requiring the appropriate shift and staff authorization;
- do not change financial or fiscal invariants.

Acceptance:

- a no-POS restaurant can receive and complete an order entirely in the owner
  dashboard without an open shift;
- a POS restaurant keeps the current queue/kitchen behavior;
- one mode cannot accidentally create the other mode’s financial records.

### Phase 4 — standalone reservations desk

Add the owner/host web experience using the existing reservation backend:

- today list and calendar;
- new/confirmed/arrived/seated/completed/cancelled/no-show states as justified
  by the audited schema;
- availability schedule, visit duration, buffers, party-size limits;
- floor plan/table assignment and combined tables;
- manual and automatic confirmation;
- guest notes and visit history.

POS-only actions must be capability-gated:

- with POS: optional “seat and open order” path;
- without POS: mark arrival/seating/completion without creating a POS order.

Acceptance:

- full booking lifecycle works from the back office with no POS device/PIN;
- guest availability and race-free overlap protection remain correct;
- table assignment is tenant/location scoped.

### Phase 5 — product UX and upgrade path

Make the dashboard reflect enabled products:

- menu-only customers see Menu, Appearance, QR/Publish, and Settings;
- reservation customers see Today, Calendar, Tables, Guests, and Settings;
- POS-only navigation is absent when POS is not enabled;
- add-on activation is clear but does not block existing work;
- enabling POS later connects the existing catalog, locations, tables, orders,
  and reservations without migration by the customer.

Do not create separate customer accounts or duplicate catalog data during an
upgrade.

### Phase 6 — hardening and pilot

Required:

- frontend unit tests;
- Edge/RPC tests;
- pgTAP tenant/RLS and entitlement tests;
- invalid entitlement and cross-tenant negative cases;
- rate-limit/idempotency tests;
- timezone and schedule edge cases;
- multi-location tests;
- mobile and RTL QA;
- build and bundle checks for both repositories;
- documentation updates;
- a pilot checklist and rollback plan.

Production release order remains:

1. migrations;
2. Edge Functions;
3. back office and guest frontend;
4. POS frontend if changed;
5. production smoke tests.

## UX constraints

- Keep guest flows mobile-first and visually independent from the POS shell.
- Do not expose `pos.angle.co.il` branding as the long-term guest identity.
- Hebrew RTL is the commercial production default.
- Use existing ANGLE design language; no gradients, decorative clutter, emoji,
  or tiny touch targets.
- Digital-only onboarding must ask for the customer’s goal, not for terminal
  setup:
  “Publish menu”, “Accept orders”, “Take reservations”, “Use POS”.
- Do not show shifts, cash, receipts, staff PINs, or devices to a menu-only
  customer.

## Mandatory verification

For `kassa` changes:

```bash
npm run lint
npm run test:run
npm run build
npm run check:bundle
npm run check:schema
```

For DB/security work:

```bash
supabase start
supabase db reset
supabase test db
```

For `anglesite` changes, run its documented build and relevant tests/checks.
Visually inspect the back office and public guest flows at mobile and desktop
sizes without claiming production success from compilation alone.

Before every commit:

- run `git diff --check`;
- stage only task files;
- re-check that the two user-owned untracked Kassa files remain untouched;
- update affected documentation;
- report exact tests run and any test that could not be run.

## Requested first response from Claude

Do not start with broad implementation. First:

1. confirm both repository states and instructions;
2. produce the concrete cross-repository dependency map;
3. propose the exact Phase 1 schema/API/UI file list and migration number;
4. identify backward-compatibility and rollout risks;
5. then implement Phase 1 only, verify it fully, and hand it back for review
   before proceeding to Phase 2.

