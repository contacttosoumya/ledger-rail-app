-- RollCall Ops schema
-- Run with: npm run db:setup   (or: psql -d rollcall_ops -f db/schema.sql)

CREATE TABLE IF NOT EXISTS daily_sales (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  revenue NUMERIC(12,2) NOT NULL DEFAULT 0,
  food_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  labor_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catering_jobs (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  client TEXT NOT NULL,
  guest_count INTEGER DEFAULT 0,
  revenue NUMERIC(12,2) NOT NULL DEFAULT 0,
  food_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  labor_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  event_name TEXT NOT NULL,
  event_type TEXT DEFAULT 'Other',
  revenue NUMERIC(12,2) NOT NULL DEFAULT 0,
  food_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  labor_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Booking/operational fields for the Event Orders & Bookings submenu.
-- Added via ALTER so this stays safe to re-run against an existing database.
ALTER TABLE events ADD COLUMN IF NOT EXISTS customer_name TEXT DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS customer_contact TEXT DEFAULT '';
-- Multi-day events: NULL (or equal to `date`) means a single-day event, same as
-- before. Set to a later date to mark this booking as spanning multiple days —
-- food tagging and prep planning can then be assigned to specific days within
-- that range instead of just to the event as a whole.
ALTER TABLE events ADD COLUMN IF NOT EXISTS end_date DATE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS guest_count INTEGER DEFAULT 0;
ALTER TABLE events ADD COLUMN IF NOT EXISTS delivery_time TEXT DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'Inquiry';
ALTER TABLE events ADD COLUMN IF NOT EXISTS package_id BIGINT;

-- Event Catalog / Packages: fixed menu bundles you can quote a booking against.
CREATE TABLE IF NOT EXISTS event_packages (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  base_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  price_unit TEXT DEFAULT 'Full Tray',
  dietary_tags TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 'name' holds the Item Category (e.g. "Mains", "Appetizers"); item_name holds the specific dish.
ALTER TABLE event_packages ADD COLUMN IF NOT EXISTS item_name TEXT DEFAULT '';
-- What it actually costs to prepare this item — separate from base_price
-- (the selling price). base_price - prep_cost = profit per item, which is
-- what Food Prep Costing uses to show profit per event.
ALTER TABLE event_packages ADD COLUMN IF NOT EXISTS prep_cost NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Links a catalog item (event_packages) to a specific booking (events).
-- The catalog's base_price is the single source of truth for what an item costs —
-- this table never stores its own price, only a reference (package_id) plus an
-- optional per-event discount, so the same item can never accidentally end up
-- priced differently between two events except through an explicit, visible discount.
CREATE TABLE IF NOT EXISTS event_package_selections (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  package_id BIGINT NOT NULL REFERENCES event_packages(id) ON DELETE CASCADE,
  quantity NUMERIC(12,2) NOT NULL DEFAULT 1,
  discount_pct NUMERIC(6,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Guardrail: the same catalog item can only be assigned to a given event once.
-- If you need more of it, edit that row's quantity instead of adding a second one.
--
-- Safe to run against a database that already has duplicates (e.g. from testing,
-- or from before this constraint existed): first merge any duplicate rows for the
-- same (event_id, package_id) pair by summing their quantities into the earliest
-- row and removing the rest, THEN add the constraint — so this never fails on
-- pre-existing data.
DO $$
DECLARE
  dup RECORD;
BEGIN
  FOR dup IN
    SELECT event_id, package_id, MIN(id) AS keep_id, SUM(quantity) AS total_qty
    FROM event_package_selections
    GROUP BY event_id, package_id
    HAVING COUNT(*) > 1
  LOOP
    UPDATE event_package_selections SET quantity = dup.total_qty WHERE id = dup.keep_id;
    DELETE FROM event_package_selections
      WHERE event_id = dup.event_id AND package_id = dup.package_id AND id <> dup.keep_id;
  END LOOP;
END $$;

-- Multi-day events: which specific day of the event this item is tagged for.
-- Existing rows get backfilled to the event's start date, so pre-existing
-- single-day tagging keeps working exactly as it did before this column existed.
ALTER TABLE event_package_selections ADD COLUMN IF NOT EXISTS tag_date DATE;
UPDATE event_package_selections eps
SET tag_date = e.date
FROM events e
WHERE eps.event_id = e.id AND eps.tag_date IS NULL;
ALTER TABLE event_package_selections ALTER COLUMN tag_date SET NOT NULL;

-- The original guardrail only considered (event, item) — now that the same item
-- can legitimately be tagged on different days of a multi-day event, uniqueness
-- needs to include the date too, or two different days would collide as "duplicates".
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_package_selections_event_package_unique'
  ) THEN
    ALTER TABLE event_package_selections DROP CONSTRAINT event_package_selections_event_package_unique;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_package_selections_event_package_date_unique'
  ) THEN
    ALTER TABLE event_package_selections
      ADD CONSTRAINT event_package_selections_event_package_date_unique UNIQUE (event_id, package_id, tag_date);
  END IF;
END $$;

-- Stall Vendor: renting out stall space to vendors at festivals, gatherings,
-- and events — a separate line of business from catering a specific booking.
CREATE TABLE IF NOT EXISTS stall_vendors (
  id BIGSERIAL PRIMARY KEY,
  festival_name TEXT NOT NULL DEFAULT '',
  event_date DATE,
  location TEXT DEFAULT '',
  vendor_name TEXT NOT NULL DEFAULT '',
  vendor_contact TEXT DEFAULT '',
  stall_number TEXT DEFAULT '',
  stall_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_status TEXT DEFAULT 'Unpaid',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Multi-day festivals: NULL means single-day, matching the events.end_date pattern.
ALTER TABLE stall_vendors ADD COLUMN IF NOT EXISTS end_date DATE;

-- Inventory & Prep Planning: shopping/prep list items tied to a specific booking.
CREATE TABLE IF NOT EXISTS event_prep_items (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ingredient TEXT NOT NULL,
  quantity TEXT DEFAULT '',
  cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT DEFAULT 'To Buy',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Which day of a multi-day event this prep task is for. Nullable — unlike food
-- tagging, prep doesn't need a hard uniqueness guardrail, but new items default
-- to the event's start date so multi-day prep planning has something sensible
-- to group by from the start.
ALTER TABLE event_prep_items ADD COLUMN IF NOT EXISTS prep_date DATE;
UPDATE event_prep_items epi
SET prep_date = e.date
FROM events e
WHERE epi.event_id = e.id AND epi.prep_date IS NULL;

-- Invoicing & Billing: one invoice record per booking.
CREATE TABLE IF NOT EXISTS event_invoices (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  quote_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  deposit_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  final_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  staff_cost_addon NUMERIC(12,2) NOT NULL DEFAULT 0,
  delivery_cost_addon NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_status TEXT DEFAULT 'Unpaid',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS costing_items (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  servings INTEGER NOT NULL DEFAULT 1,
  ingredients JSONB NOT NULL DEFAULT '[]',
  labor NUMERIC(12,2) NOT NULL DEFAULT 0,
  overhead_pct NUMERIC(6,2) NOT NULL DEFAULT 0,
  target_pct NUMERIC(6,2) NOT NULL DEFAULT 30,
  total_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  per_serving NUMERIC(12,2) NOT NULL DEFAULT 0,
  suggested_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS partners (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contributions (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  partner_name TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  category TEXT DEFAULT 'Other',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loans (
  id BIGSERIAL PRIMARY KEY,
  lender TEXT NOT NULL,
  loan_type TEXT DEFAULT 'Term Loan',
  principal NUMERIC(12,2) NOT NULL DEFAULT 0,
  rate NUMERIC(6,3) NOT NULL DEFAULT 0,
  tenure INTEGER NOT NULL DEFAULT 0,
  start_date DATE NOT NULL,
  emi NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Which partner (if any) took out this specific loan — blank means a general
-- business loan not attributed to one person. A partner can have several loans.
ALTER TABLE loans ADD COLUMN IF NOT EXISTS partner_name TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS emi_payments (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  loan_id BIGINT NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS setup_costs (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  vendor TEXT DEFAULT '',
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_by TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Optional supporting document (bill/receipt/permit copy/invoice) — same
-- base64-in-DB pattern as monthly_expenses and important_documents.
ALTER TABLE setup_costs ADD COLUMN IF NOT EXISTS file_name TEXT DEFAULT '';
ALTER TABLE setup_costs ADD COLUMN IF NOT EXISTS file_type TEXT DEFAULT '';
ALTER TABLE setup_costs ADD COLUMN IF NOT EXISTS file_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE setup_costs ADD COLUMN IF NOT EXISTS file_data TEXT DEFAULT '';

-- Master list of setup-cost categories, grouped, in display order.
-- The frontend builds its category dropdown and sidebar submenu entirely
-- from this table — nothing about the taxonomy is hardcoded in the UI.
CREATE TABLE IF NOT EXISTS setup_cost_categories (
  id BIGSERIAL PRIMARY KEY,
  category TEXT NOT NULL UNIQUE,
  group_name TEXT NOT NULL,
  description TEXT DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO setup_cost_categories (category, group_name, description, sort_order) VALUES
  ('Building Lease', 'Real Estate & Construction', 'Security deposits, advance rent, and broker fees', 10),
  ('Renovations & Buildout', 'Real Estate & Construction', 'Architectural design, plumbing, electrical upgrades, and HVAC work', 11),
  ('Ventilation', 'Real Estate & Construction', 'Commercial kitchen exhaust hoods and fire suppression systems', 12),
  ('Kitchen Appliances', 'Equipment & Furnishings', 'Ovens, grills, fryers, refrigerators, freezers, and prep tables', 20),
  ('Smallwares', 'Equipment & Furnishings', 'Cookware, chef knives, plates, glassware, and silverware', 21),
  ('Front of House', 'Equipment & Furnishings', 'Tables, chairs, booths, bar stools, and interior décor', 22),
  ('Government Permits', 'Licenses, Permits & Legal', 'Health department permits, food handler certificates, and building permits', 30),
  ('Legal & Accounting', 'Licenses, Permits & Legal', 'Business formation, lease reviews, and payroll setup', 31),
  ('Initial Food & Beverage Stock', 'Inventory & Technology', 'Opening food supplies, bar stock, and dry goods', 40),
  ('Hardware & Software', 'Inventory & Technology', 'POS terminals, kitchen display systems, and scheduling software', 41),
  ('Uniforms & Signage', 'Inventory & Technology', 'Exterior branding, menus, and staff workwear', 42),
  ('Cash Reserve', 'Working Capital & Marketing', 'Three to six months of operating expenses to cover early losses', 50),
  ('Grand Opening Marketing', 'Working Capital & Marketing', 'Local advertising, social media promotions, and soft-launch events', 51),
  ('Other', 'Other', '', 60)
ON CONFLICT (category) DO NOTHING;

-- Generic small reference lists used to populate dropdowns elsewhere in the app
-- (contribution categories, event types, loan types, etc). Add a row here to
-- add an option to the matching dropdown — no code or file changes needed.
CREATE TABLE IF NOT EXISTS dropdown_options (
  id BIGSERIAL PRIMARY KEY,
  list_name TEXT NOT NULL,
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(list_name, value)
);

INSERT INTO dropdown_options (list_name, value, sort_order) VALUES
  ('contribution_category', 'Renovation', 10),
  ('contribution_category', 'Kitchen Equipment', 20),
  ('contribution_category', 'Furniture & Decor', 30),
  ('contribution_category', 'Licenses & Permits', 40),
  ('contribution_category', 'Initial Inventory', 50),
  ('contribution_category', 'Working Capital', 60),
  ('contribution_category', 'Other', 70),
  ('event_type', 'Wedding', 10),
  ('event_type', 'Private Party', 20),
  ('event_type', 'Corporate', 30),
  ('event_type', 'Ticketed Night', 40),
  ('event_type', 'Buy-out', 50),
  ('event_type', 'Other', 60),
  ('loan_type', 'Term Loan', 10),
  ('loan_type', 'Equipment Loan', 20),
  ('loan_type', 'Line of Credit', 30),
  ('loan_type', 'Partner Loan', 40),
  ('loan_type', 'Other', 50),
  ('booking_status', 'Inquiry', 10),
  ('booking_status', 'Confirmed', 20),
  ('booking_status', 'Prep', 30),
  ('booking_status', 'Delivered', 40),
  ('booking_status', 'Paid', 50),
  ('booking_status', 'Cancelled', 60),
  ('price_unit', 'Full Tray', 10),
  ('price_unit', 'Half Tray', 20),
  ('price_unit', 'Per Item', 30),
  ('price_unit', 'Flat Price', 40),
  ('payment_status', 'Unpaid', 10),
  ('payment_status', 'Deposit Paid', 20),
  ('payment_status', 'Partially Paid', 30),
  ('payment_status', 'Paid in Full', 40),
  ('prep_item_status', 'To Buy', 10),
  ('prep_item_status', 'Purchased', 20),
  ('prep_item_status', 'Prepped', 30),
  ('prep_item_status', 'Used', 40),
  ('prep_item_status', 'Wasted', 50)
ON CONFLICT (list_name, value) DO NOTHING;

-- Migration: price_unit options changed (Per Person removed; Full Tray / Half Tray added).
-- Safe to re-run: removes the old set and (re)inserts the correct one with the right order.
DELETE FROM dropdown_options WHERE list_name = 'price_unit' AND value NOT IN ('Full Tray', 'Half Tray', 'Per Item', 'Flat Price');
INSERT INTO dropdown_options (list_name, value, sort_order) VALUES
  ('price_unit', 'Full Tray', 10),
  ('price_unit', 'Half Tray', 20),
  ('price_unit', 'Per Item', 30),
  ('price_unit', 'Flat Price', 40)
ON CONFLICT (list_name, value) DO UPDATE SET sort_order = EXCLUDED.sort_order;

-- ===========================================================================
-- AUTHENTICATION & ROLE-BASED ACCESS CONTROL
-- ===========================================================================

CREATE TABLE IF NOT EXISTS roles (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One login per person. partner_id links a login to an existing business
-- partner (optional — an Owner/Manager/Staff account doesn't need one).
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  role_id BIGINT NOT NULL REFERENCES roles(id),
  partner_id BIGINT REFERENCES partners(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fine-grained permission matrix: for every role, what it can see/change
-- in each area of the app. "resource" values match the app's own module
-- keys (overview, daily, catering, costing, eventbookings, eventcatalog,
-- eventprep, eventinvoicing, eventsummary, contributions, setupcosts,
-- loans, ai, admin). Enforced server-side on every API request — this
-- table is the actual source of truth, not just a UI hint.
CREATE TABLE IF NOT EXISTS role_permissions (
  id BIGSERIAL PRIMARY KEY,
  role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  can_view BOOLEAN NOT NULL DEFAULT false,
  can_edit BOOLEAN NOT NULL DEFAULT false,
  can_delete BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(role_id, resource)
);

-- Session store for express-session (via connect-pg-simple).
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL PRIMARY KEY,
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

INSERT INTO roles (name, description) VALUES
  ('Super Admin', 'Full access everywhere, including creating/renaming/deleting roles and editing every permission rule'),
  ('Owner', 'Full access to every module, including Admin Panel'),
  ('Manager', 'Full day-to-day operations; view-only on capital & financing; no Admin'),
  ('Partner', 'View-only across financial reporting and capital; no operational edit access'),
  ('Staff', 'Event operations only — bookings, catalog, prep planning')
ON CONFLICT (name) DO NOTHING;

-- Default permission matrix. Every resource key below corresponds to a
-- sidebar module. All four booleans default false; only what's listed
-- here is granted.
DO $$
DECLARE
  superadmin_id BIGINT; owner_id BIGINT; manager_id BIGINT; partner_id BIGINT; staff_id BIGINT;
  resources TEXT[] := ARRAY['overview','daily','catering','costing',
    'eventbookings','eventcatalog','eventprep','eventinvoicing','eventsummary','stallvendor',
    'contributions','setupcosts','loans','ai','admin','menucatalog','importantdocs','monthlyexpenses'];
  r TEXT;
BEGIN
  SELECT id INTO superadmin_id FROM roles WHERE name = 'Super Admin';
  SELECT id INTO owner_id FROM roles WHERE name = 'Owner';
  SELECT id INTO manager_id FROM roles WHERE name = 'Manager';
  SELECT id INTO partner_id FROM roles WHERE name = 'Partner';
  SELECT id INTO staff_id FROM roles WHERE name = 'Staff';

  -- Super Admin: full access everywhere (same grant as Owner) — this is the
  -- role meant to actually create/rename/delete roles and edit the permission
  -- matrix itself, independent of whichever role manages day-to-day business data.
  FOREACH r IN ARRAY resources LOOP
    INSERT INTO role_permissions (role_id, resource, can_view, can_edit, can_delete)
    VALUES (superadmin_id, r, true, true, true)
    ON CONFLICT (role_id, resource) DO NOTHING;
  END LOOP;

  -- Owner: full access everywhere
  FOREACH r IN ARRAY resources LOOP
    INSERT INTO role_permissions (role_id, resource, can_view, can_edit, can_delete)
    VALUES (owner_id, r, true, true, true)
    ON CONFLICT (role_id, resource) DO NOTHING;
  END LOOP;

  -- Manager: full CRUD on day-to-day operations; view-only on capital/financing; no admin
  FOREACH r IN ARRAY ARRAY['overview','daily','catering','costing',
    'eventbookings','eventcatalog','eventprep','eventinvoicing','eventsummary','stallvendor','menucatalog','importantdocs','monthlyexpenses'] LOOP
    INSERT INTO role_permissions (role_id, resource, can_view, can_edit, can_delete)
    VALUES (manager_id, r, true, true, true)
    ON CONFLICT (role_id, resource) DO NOTHING;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['contributions','setupcosts','loans'] LOOP
    INSERT INTO role_permissions (role_id, resource, can_view, can_edit, can_delete)
    VALUES (manager_id, r, true, false, false)
    ON CONFLICT (role_id, resource) DO NOTHING;
  END LOOP;
  INSERT INTO role_permissions (role_id, resource, can_view, can_edit, can_delete)
  VALUES (manager_id, 'ai', true, false, false)
  ON CONFLICT (role_id, resource) DO NOTHING;

  -- Partner: view-only across financial reporting and capital, plus overview
  FOREACH r IN ARRAY ARRAY['overview','contributions','setupcosts','loans','ai','importantdocs','monthlyexpenses'] LOOP
    INSERT INTO role_permissions (role_id, resource, can_view, can_edit, can_delete)
    VALUES (partner_id, r, true, false, false)
    ON CONFLICT (role_id, resource) DO NOTHING;
  END LOOP;

  -- Staff: event operations only, full CRUD there, view-only on bookings (they select an
  -- existing booking to attach prep/invoice/catalog items to, but don't create bookings), nothing financial
  FOREACH r IN ARRAY ARRAY['eventcatalog','eventprep','eventinvoicing','eventsummary','stallvendor','menucatalog'] LOOP
    INSERT INTO role_permissions (role_id, resource, can_view, can_edit, can_delete)
    VALUES (staff_id, r, true, true, true)
    ON CONFLICT (role_id, resource) DO NOTHING;
  END LOOP;
  INSERT INTO role_permissions (role_id, resource, can_view, can_edit, can_delete)
  VALUES (staff_id, 'eventbookings', true, false, false)
  ON CONFLICT (role_id, resource) DO NOTHING;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_partner ON users(partner_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id);

-- Profile fields — self-service, any logged-in user can view/edit their own.
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT DEFAULT '';

-- Forces a password change on next login. Defaults false so this migration
-- never retroactively locks out an account that already has a real password —
-- it only applies going forward, to newly created accounts and to accounts
-- whose password an admin resets (both represent "here's a temp password").
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;

-- A second, optional username that logs into the SAME account — for a shared
-- seat (e.g. a couple who are jointly one partner in the business). The
-- primary `username` column already has its own UNIQUE constraint; this one
-- adds a second, independently unique login name. Application code checks
-- BOTH columns together for collisions (Postgres can't natively enforce
-- uniqueness across two different columns of the same table).
ALTER TABLE users ADD COLUMN IF NOT EXISTS username_alt TEXT UNIQUE;

-- Activity log: every create/edit/delete across the app, so partners can see
-- what everyone else changed. user_id can go null if that account is later
-- deleted, but username/display_name are kept as a permanent record either way.
CREATE TABLE IF NOT EXISTS activity_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  username TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  action TEXT NOT NULL,          -- 'create' | 'update' | 'delete'
  resource TEXT NOT NULL,        -- SQL table name
  record_id TEXT,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id);

-- Per-user menu access overrides. This is deliberately sparse: a row only
-- exists where a SPECIFIC person's access to a SPECIFIC menu should differ
-- from what their role normally grants — either explicitly showing them
-- something their role hides, or explicitly hiding something their role
-- shows. No row for a given (user, resource) means "just use the role
-- default" — removing an override reverts that person to their role's
-- normal behavior for that menu.
CREATE TABLE IF NOT EXISTS user_menu_overrides (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  can_view BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, resource)
);
-- Originally view-only. Extending to also independently override edit/delete —
-- otherwise granting someone a menu only lets them look at it, never use it.
-- Each column is nullable: NULL means "defer to role default" for that one
-- action specifically, so you can grant view without also granting edit/delete,
-- or vice versa.
ALTER TABLE user_menu_overrides ALTER COLUMN can_view DROP NOT NULL;
ALTER TABLE user_menu_overrides ADD COLUMN IF NOT EXISTS can_edit BOOLEAN;
ALTER TABLE user_menu_overrides ADD COLUMN IF NOT EXISTS can_delete BOOLEAN;
CREATE INDEX IF NOT EXISTS idx_user_menu_overrides_user ON user_menu_overrides(user_id);

-- Bootstrap account so there's always a way to log in on a fresh install.
-- Username: owner   Password: changeme123
-- CHANGE THIS PASSWORD IMMEDIATELY after first login (Admin Panel > Users & Roles,
-- or the "Change Password" option once logged in).
INSERT INTO users (username, password_hash, display_name, role_id, active)
SELECT 'owner', '$2a$10$YCdK8M/ZM7DIUpgEwjxgcuqVKxG3CNPmO2d5ahYz3CzCrFOqrfrRq', 'Owner', id, true
FROM roles WHERE name = 'Super Admin'
ON CONFLICT (username) DO NOTHING;

-- If this schema is being re-run against a database that already has the
-- bootstrap account on the old 'Owner' role (from before Super Admin existed),
-- promote it — the owner keeps full control either way, this just consolidates
-- onto the one role meant to also manage roles/permissions themselves.
UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'Super Admin')
WHERE username = 'owner'
  AND role_id = (SELECT id FROM roles WHERE name = 'Owner');

-- Add the activity log as its own permissioned module. View-only everywhere —
-- an audit trail that could itself be edited or deleted isn't much of one.
DO $$
DECLARE
  r_id BIGINT;
BEGIN
  FOR r_id IN SELECT id FROM roles WHERE name IN ('Super Admin','Owner','Manager','Partner') LOOP
    INSERT INTO role_permissions (role_id, resource, can_view, can_edit, can_delete)
    VALUES (r_id, 'activity', true, false, false)
    ON CONFLICT (role_id, resource) DO NOTHING;
  END LOOP;
  -- Staff doesn't get this by default (keeps it scoped to ownership/management),
  -- but any admin can turn it on for them in Admin Panel > Permissions.
  FOR r_id IN SELECT id FROM roles WHERE name = 'Staff' LOOP
    INSERT INTO role_permissions (role_id, resource, can_view, can_edit, can_delete)
    VALUES (r_id, 'activity', false, false, false)
    ON CONFLICT (role_id, resource) DO NOTHING;
  END LOOP;
END $$;


CREATE INDEX IF NOT EXISTS idx_daily_sales_date ON daily_sales(date);
CREATE INDEX IF NOT EXISTS idx_catering_jobs_date ON catering_jobs(date);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
CREATE INDEX IF NOT EXISTS idx_contributions_partner ON contributions(partner_name);
CREATE INDEX IF NOT EXISTS idx_emi_payments_loan ON emi_payments(loan_id);
CREATE INDEX IF NOT EXISTS idx_setup_costs_category ON setup_costs(category);
CREATE INDEX IF NOT EXISTS idx_setup_cost_categories_sort ON setup_cost_categories(sort_order);
CREATE INDEX IF NOT EXISTS idx_dropdown_options_list ON dropdown_options(list_name, sort_order);
CREATE INDEX IF NOT EXISTS idx_event_prep_items_event ON event_prep_items(event_id);
CREATE INDEX IF NOT EXISTS idx_event_package_selections_event ON event_package_selections(event_id);
CREATE INDEX IF NOT EXISTS idx_event_package_selections_package ON event_package_selections(package_id);
CREATE INDEX IF NOT EXISTS idx_event_invoices_event ON event_invoices(event_id);

-- ===========================================================================
-- MENU & PRICING ENGINE (Restaurant Store)
-- ===========================================================================

-- Category hierarchy — supports nesting via parent_id (e.g. "Mains" > "Grill Mains").
-- Built now so Item Catalog can reference it; the drag-and-drop manager and
-- Combo builder land in a later phase.
CREATE TABLE IF NOT EXISTS menu_categories (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id BIGINT REFERENCES menu_categories(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_items (
  id BIGSERIAL PRIMARY KEY,
  item_name TEXT NOT NULL,
  sku TEXT DEFAULT '',
  category_id BIGINT REFERENCES menu_categories(id) ON DELETE SET NULL,
  station_tag TEXT DEFAULT '',
  base_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_category TEXT DEFAULT '',
  image_data TEXT DEFAULT '',       -- base64, same pattern as user profile photos
  description TEXT DEFAULT '',      -- simple HTML from the built-in rich text editor
  is_vegan BOOLEAN NOT NULL DEFAULT false,
  is_vegetarian BOOLEAN NOT NULL DEFAULT false,
  is_gluten_free BOOLEAN NOT NULL DEFAULT false,
  is_halal BOOLEAN NOT NULL DEFAULT false,
  is_nut_free BOOLEAN NOT NULL DEFAULT false,
  -- Availability (86 List) — lives on the item now so Item Catalog and the
  -- 86 List page share one source of truth instead of drifting out of sync.
  availability_status TEXT NOT NULL DEFAULT 'In Stock', -- 'In Stock' | 'Low Stock' | '86'd'
  low_stock_qty NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial unique index: SKU should be unique when set, but many items may
-- legitimately have no SKU yet, and multiple blank SKUs shouldn't collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_items_sku_unique ON menu_items(sku) WHERE sku <> '';
CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category_id);
CREATE INDEX IF NOT EXISTS idx_menu_categories_parent ON menu_categories(parent_id);

INSERT INTO dropdown_options (list_name, value, sort_order) VALUES
  ('station_tag', 'Grill', 10),
  ('station_tag', 'Fryer', 20),
  ('station_tag', 'Bar', 30),
  ('station_tag', 'Salad', 40),
  ('station_tag', 'Dessert', 50),
  ('station_tag', 'Expo', 60),
  ('tax_category', 'Standard', 10),
  ('tax_category', 'Reduced Rate', 20),
  ('tax_category', 'Zero Rate', 30),
  ('tax_category', 'Exempt', 40)
ON CONFLICT (list_name, value) DO UPDATE SET sort_order = EXCLUDED.sort_order;

CREATE INDEX IF NOT EXISTS idx_menu_items_availability ON menu_items(availability_status);

-- Combo / Set Menu builder: a combo has one or more steps (e.g. "Choose 1
-- Main", "Choose 1 Side"), each step offers a set of eligible items, and any
-- item within a step can carry its own upcharge on top of the combo's base price.
CREATE TABLE IF NOT EXISTS menu_combos (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  base_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_combo_steps (
  id BIGSERIAL PRIMARY KEY,
  combo_id BIGINT NOT NULL REFERENCES menu_combos(id) ON DELETE CASCADE,
  step_name TEXT NOT NULL,
  min_select INTEGER NOT NULL DEFAULT 1,
  max_select INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_combo_step_items (
  id BIGSERIAL PRIMARY KEY,
  step_id BIGINT NOT NULL REFERENCES menu_combo_steps(id) ON DELETE CASCADE,
  menu_item_id BIGINT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  upcharge_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  UNIQUE(step_id, menu_item_id)
);

CREATE INDEX IF NOT EXISTS idx_menu_combo_steps_combo ON menu_combo_steps(combo_id);
CREATE INDEX IF NOT EXISTS idx_menu_combo_step_items_step ON menu_combo_step_items(step_id);
CREATE INDEX IF NOT EXISTS idx_menu_combo_step_items_item ON menu_combo_step_items(menu_item_id);

-- ===========================================================================
-- BACKUP LOG — written by scripts/backup-database.js after each daily backup
-- run, so the Admin Panel can show real backup status instead of just hoping
-- the cron job is working.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS backup_log (
  id BIGSERIAL PRIMARY KEY,
  status TEXT NOT NULL, -- 'success' | 'failed'
  detail TEXT DEFAULT '',
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_backup_log_ran_at ON backup_log(ran_at DESC);

-- ===========================================================================
-- CATERING MENU CATALOG — a separate, independent catalog for the Catering
-- business line, mirroring event_packages' structure exactly. Deliberately
-- its own table rather than sharing event_packages: Catering and Events are
-- kept as fully separate business lines everywhere else in this app (separate
-- jobs tables, separate revenue/cost tracking), so their catalogs stay
-- separate too rather than silently sharing data.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS catering_packages (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,             -- Item Category (e.g. "Mains", "Appetizers")
  item_name TEXT DEFAULT '',
  description TEXT DEFAULT '',
  base_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  price_unit TEXT DEFAULT 'Full Tray',
  dietary_tags TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===========================================================================
-- STALL VENDOR — full parallel system, same shape as the Events food module:
-- Menu Catalog (with prep cost), Stall Food Tagging (with per-day tagging for
-- multi-day festivals), Prep Cost Analysis, and Revenue Reports / Stall
-- Summaries computed from the same kind of tagged-item data as Events.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS stall_packages (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,             -- Item Category
  item_name TEXT DEFAULT '',
  description TEXT DEFAULT '',
  base_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  price_unit TEXT DEFAULT 'Full Tray',
  dietary_tags TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  prep_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stall_package_selections (
  id BIGSERIAL PRIMARY KEY,
  stall_vendor_id BIGINT NOT NULL REFERENCES stall_vendors(id) ON DELETE CASCADE,
  package_id BIGINT NOT NULL REFERENCES stall_packages(id) ON DELETE CASCADE,
  tag_date DATE NOT NULL,
  quantity NUMERIC(12,2) NOT NULL DEFAULT 1,
  discount_pct NUMERIC(6,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(stall_vendor_id, package_id, tag_date)
);

CREATE INDEX IF NOT EXISTS idx_stall_package_selections_vendor ON stall_package_selections(stall_vendor_id);
CREATE INDEX IF NOT EXISTS idx_stall_package_selections_package ON stall_package_selections(package_id);

-- ===========================================================================
-- IMPORTANT DOCS — licenses, permits, insurance, contracts, and any other
-- file worth keeping on hand. Stored as base64 in the DB, same pattern as
-- profile photos and menu item images elsewhere in this app.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS important_documents (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT DEFAULT '',
  file_name TEXT NOT NULL DEFAULT '',
  file_type TEXT DEFAULT '',
  file_size INTEGER NOT NULL DEFAULT 0,
  file_data TEXT NOT NULL DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_important_documents_category ON important_documents(category);

INSERT INTO dropdown_options (list_name, value, sort_order) VALUES
  ('document_category', 'License', 10),
  ('document_category', 'Permit', 20),
  ('document_category', 'Insurance', 30),
  ('document_category', 'Contract', 40),
  ('document_category', 'Certificate', 50),
  ('document_category', 'Lease', 60),
  ('document_category', 'Other', 70)
ON CONFLICT (list_name, value) DO UPDATE SET sort_order = EXCLUDED.sort_order;

-- ===========================================================================
-- MONTHLY EXPENSES — recurring operational bills (rent, electricity, water,
-- insurance, etc.), tracked month by month. Deliberately separate from
-- Setup Costs, which is one-time capital expenditure, not recurring bills.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS monthly_expenses (
  id BIGSERIAL PRIMARY KEY,
  category TEXT NOT NULL DEFAULT '',
  vendor TEXT DEFAULT '',
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  expense_month DATE NOT NULL, -- always the 1st of the month, e.g. 2026-08-01 means "August 2026"
  payment_status TEXT DEFAULT 'Unpaid',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_monthly_expenses_month ON monthly_expenses(expense_month DESC);
CREATE INDEX IF NOT EXISTS idx_monthly_expenses_category ON monthly_expenses(category);
-- Optional supporting document (bill/receipt/invoice) — same base64-in-DB
-- pattern as important_documents. All nullable/blank since it's optional.
ALTER TABLE monthly_expenses ADD COLUMN IF NOT EXISTS file_name TEXT DEFAULT '';
ALTER TABLE monthly_expenses ADD COLUMN IF NOT EXISTS file_type TEXT DEFAULT '';
ALTER TABLE monthly_expenses ADD COLUMN IF NOT EXISTS file_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monthly_expenses ADD COLUMN IF NOT EXISTS file_data TEXT DEFAULT '';

INSERT INTO dropdown_options (list_name, value, sort_order) VALUES
  ('expense_category', 'Rent', 10),
  ('expense_category', 'Electricity', 20),
  ('expense_category', 'Water', 30),
  ('expense_category', 'Gas', 40),
  ('expense_category', 'Internet', 50),
  ('expense_category', 'Phone', 60),
  ('expense_category', 'Insurance', 70),
  ('expense_category', 'Software & Subscriptions', 80),
  ('expense_category', 'Waste Disposal', 90),
  ('expense_category', 'Pest Control', 100),
  ('expense_category', 'Security', 110),
  ('expense_category', 'Other', 120)
ON CONFLICT (list_name, value) DO UPDATE SET sort_order = EXCLUDED.sort_order;