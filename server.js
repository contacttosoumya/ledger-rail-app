require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { Pool, types } = require('pg');
const pgSessionFactory = require('connect-pg-simple');

// By default pg returns NUMERIC as strings (to avoid float precision surprises)
// and DATE as JS Date objects (which serialize to full ISO timestamps).
// This app just needs plain numbers and plain YYYY-MM-DD strings.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val))); // NUMERIC
types.setTypeParser(1082, (val) => val); // DATE -> keep as 'YYYY-MM-DD' string

const PORT = process.env.PORT || 3000;

// Every module in the app that can be independently permissioned.
// Used to auto-provision a full (all-false) set of permission rows
// whenever a new role is created, so it shows up ready to configure.
const ALL_RESOURCES = [
  'overview', 'daily', 'catering', 'costing',
  'eventbookings', 'eventcatalog', 'eventprep', 'eventinvoicing', 'eventsummary', 'stallvendor',
  'contributions', 'setupcosts', 'loans', 'ai', 'admin', 'activity', 'menucatalog', 'importantdocs', 'monthlyexpenses', 'importantcontacts',
];

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in first.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set in .env — using an insecure default. Set one before relying on this for real use.');
}

const app = express();
app.use(express.json({ limit: '20mb' })); // generous enough for base64-encoded photos and scanned PDF documents
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That upload is too large. Please use a smaller image.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed request.' });
  }
  next(err);
});

const PgSession = pgSessionFactory(session);
app.use(session({
  store: new PgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7, httpOnly: true, sameSite: 'lax' }, // 7 days
}));

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Auth / permission helpers
// Every permission check re-reads role_permissions live from the database
// rather than trusting anything cached on the session, so a permission
// change made in Admin Panel takes effect for that user's very next request
// — no stale cached grants.
// ---------------------------------------------------------------------------
async function getPermissionsForRole(roleId) {
  const { rows } = await pool.query(
    'SELECT resource, can_view, can_edit, can_delete FROM role_permissions WHERE role_id = $1',
    [roleId]
  );
  const perms = {};
  rows.forEach((r) => {
    perms[r.resource] = { view: r.can_view, edit: r.can_edit, delete: r.can_delete };
  });
  return perms;
}

// Role permissions are the baseline; per-user overrides adjust ONLY the view
// (menu visibility) dimension for that one person, on top of it. Edit/delete
// stay role-only — this is specifically a "which menus can this person see" control.
async function getEffectivePermissions(userId, roleId) {
  const perms = await getPermissionsForRole(roleId);
  const { rows: overrides } = await pool.query(
    'SELECT resource, can_view, can_edit, can_delete FROM user_menu_overrides WHERE user_id = $1',
    [userId]
  );
  overrides.forEach((o) => {
    if (!perms[o.resource]) perms[o.resource] = { view: false, edit: false, delete: false };
    if (o.can_view !== null) perms[o.resource].view = o.can_view;
    if (o.can_edit !== null) perms[o.resource].edit = o.can_edit;
    if (o.can_delete !== null) perms[o.resource].delete = o.can_delete;
  });
  return perms;
}

function requirePermission(resource, action) {
  const column = action === 'view' ? 'can_view' : action === 'edit' ? 'can_edit' : 'can_delete';
  return async (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    if (resource === '*') return next(); // shared reference data — any logged-in user may view
    try {
      const ov = await pool.query(
        `SELECT ${column} AS val FROM user_menu_overrides WHERE user_id = $1 AND resource = $2`,
        [req.session.user.id, resource]
      );
      if (ov.rows[0] && ov.rows[0].val !== null) {
        // Explicit per-user override for this specific action always wins, whichever direction it goes.
        if (!ov.rows[0].val) {
          return res.status(403).json({ error: `Not authorized to ${action} ${resource}` });
        }
        return next();
      }
      const { rows } = await pool.query(
        `SELECT ${column} AS allowed FROM role_permissions WHERE role_id = $1 AND resource = $2`,
        [req.session.user.roleId, resource]
      );
      if (!rows[0] || !rows[0].allowed) {
        return res.status(403).json({ error: `Not authorized to ${action} ${resource}` });
      }
      next();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

// ---------------------------------------------------------------------------
// Generic CRUD factory
// Each resource maps camelCase JS field names <-> snake_case DB columns,
// so the frontend can keep using the same field names throughout.
// ---------------------------------------------------------------------------
const TABLE_LABELS = {
  daily_sales: 'Daily Sale', catering_jobs: 'Catering Job', events: 'Event Booking',
  costing_items: 'Costing Item', partners: 'Partner', contributions: 'Contribution',
  loans: 'Loan', emi_payments: 'EMI Payment', setup_costs: 'Setup Cost',
  setup_cost_categories: 'Setup Cost Category', dropdown_options: 'Dropdown Option',
  event_packages: 'Catalog Item', event_package_selections: 'Event Item Assignment',
  event_prep_items: 'Prep Item', event_invoices: 'Invoice', stall_vendors: 'Stall Vendor',
  users: 'User', roles: 'Role', role_permissions: 'Permission Rule',
};

async function logActivity(req, action, table, recordId, snapshot) {
  if (!req.session || !req.session.user) return;
  try {
    await pool.query(
      `INSERT INTO activity_log (user_id, username, display_name, action, resource, record_id, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        req.session.user.id, req.session.user.loginUsername || req.session.user.username, req.session.user.displayName || '',
        action, table, String(recordId), JSON.stringify(snapshot || {}),
      ]
    );
  } catch (err) {
    console.error('Failed to log activity:', err);
  }
}

function crudRouter(table, fields, orderBy = 'id DESC', resource, writeResource, duplicateMessage) {
  const viewResource = resource;
  const editResource = writeResource || resource;
  const router = express.Router();

  const rowToJs = (row) => {
    const out = { id: row.id };
    for (const f of fields) out[f.js] = row[f.db];
    return out;
  };

  router.get('/', requirePermission(viewResource, 'view'), async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
      res.json(rows.map(rowToJs));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load ' + table });
    }
  });

  const mapValue = (f, v) => {
    if (f.json) return JSON.stringify(v ?? []);
    if (f.type === 'number') return v === '' || v === undefined || v === null ? 0 : Number(v);
    if (f.type === 'dateOrNull') return v === '' || v === undefined ? null : v;
    if (f.type === 'boolean') return !!v;
    if (f.type === 'numberOrNull') return (v === '' || v === undefined || v === null) ? null : Number(v);
    return v ?? '';
  };

  router.post('/', requirePermission(editResource, 'edit'), async (req, res) => {
    try {
      const cols = fields.map((f) => f.db);
      const placeholders = fields.map((_, i) => `$${i + 1}`);
      const values = fields.map((f) => mapValue(f, req.body[f.js]));
      const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING *`;
      const { rows } = await pool.query(sql, values);
      const created = rowToJs(rows[0]);
      logActivity(req, 'create', table, created.id, created);
      res.status(201).json(created);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: duplicateMessage || 'That already exists — duplicate not allowed.' });
      }
      if (err.code === '22007' || err.code === '22008') {
        return res.status(400).json({ error: 'A required date field is missing or invalid. Please check every date field and try again.' });
      }
      console.error(err);
      res.status(400).json({ error: 'Failed to create record in ' + table, detail: err.message });
    }
  });

  router.delete('/:id', requirePermission(editResource, 'delete'), async (req, res) => {
    try {
      const before = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
      await pool.query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
      if (before.rows[0]) logActivity(req, 'delete', table, req.params.id, rowToJs(before.rows[0]));
      res.status(204).end();
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: 'Failed to delete record in ' + table });
    }
  });

  router.put('/:id', requirePermission(editResource, 'edit'), async (req, res) => {
    try {
      const cols = fields.map((f) => f.db);
      const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const values = fields.map((f) => mapValue(f, req.body[f.js]));
      values.push(req.params.id);
      const sql = `UPDATE ${table} SET ${setClause} WHERE id = $${values.length} RETURNING *`;
      const { rows } = await pool.query(sql, values);
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      const updated = rowToJs(rows[0]);
      logActivity(req, 'update', table, updated.id, updated);
      res.json(updated);
    } catch (err) {
      if (err.code === '22007' || err.code === '22008') {
        return res.status(400).json({ error: 'A required date field is missing or invalid. Please check every date field and try again.' });
      }
      console.error(err);
      res.status(400).json({ error: 'Failed to update record in ' + table, detail: err.message });
    }
  });

  return router;
}

const F = {
  string: (js, db) => ({ js, db, type: 'string' }),
  number: (js, db) => ({ js, db, type: 'number' }),
  json: (js, db) => ({ js, db, type: 'string', json: true }),
  dateOrNull: (js, db) => ({ js, db, type: 'dateOrNull' }),
  boolean: (js, db) => ({ js, db, type: 'boolean' }),
  numberOrNull: (js, db) => ({ js, db, type: 'numberOrNull' }),
};

app.use('/api/daily-sales', crudRouter('daily_sales', [
  F.string('date', 'date'), F.number('revenue', 'revenue'), F.number('foodCost', 'food_cost'),
  F.number('laborCost', 'labor_cost'), F.number('otherCost', 'other_cost'), F.string('notes', 'notes'),
], 'id DESC', 'daily'));

app.use('/api/catering', crudRouter('catering_jobs', [
  F.string('date', 'date'), F.string('client', 'client'), F.number('guestCount', 'guest_count'),
  F.number('revenue', 'revenue'), F.number('foodCost', 'food_cost'), F.number('laborCost', 'labor_cost'),
  F.number('otherCost', 'other_cost'), F.string('notes', 'notes'),
], 'id DESC', 'catering'));

app.use('/api/catering-packages', crudRouter('catering_packages', [
  F.string('name', 'name'), F.string('itemName', 'item_name'), F.string('description', 'description'),
  F.number('basePrice', 'base_price'), F.string('priceUnit', 'price_unit'), F.string('dietaryTags', 'dietary_tags'),
  F.string('notes', 'notes'),
], 'id DESC', 'catering'));

app.use('/api/events', crudRouter('events', [
  F.string('date', 'date'), F.dateOrNull('endDate', 'end_date'), F.string('eventName', 'event_name'), F.string('eventType', 'event_type'),
  F.number('revenue', 'revenue'), F.number('foodCost', 'food_cost'), F.number('laborCost', 'labor_cost'),
  F.number('otherCost', 'other_cost'), F.string('notes', 'notes'),
  F.string('customerName', 'customer_name'), F.string('customerContact', 'customer_contact'),
  F.number('guestCount', 'guest_count'), F.string('deliveryTime', 'delivery_time'), F.string('status', 'status'),
], 'id DESC', '*', 'eventbookings'));

app.use('/api/costing', crudRouter('costing_items', [
  F.string('name', 'name'), F.number('servings', 'servings'), F.json('ingredients', 'ingredients'),
  F.number('labor', 'labor'), F.number('overheadPct', 'overhead_pct'), F.number('targetPct', 'target_pct'),
  F.number('totalCost', 'total_cost'), F.number('perServing', 'per_serving'), F.number('suggestedPrice', 'suggested_price'),
], 'id DESC', 'costing'));

app.use('/api/partners', crudRouter('partners', [
  F.string('name', 'name'),
], 'id DESC', '*', 'contributions'));

app.use('/api/contributions', crudRouter('contributions', [
  F.string('date', 'date'), F.string('partnerName', 'partner_name'), F.number('amount', 'amount'),
  F.string('category', 'category'), F.string('notes', 'notes'),
], 'id DESC', 'contributions'));

app.use('/api/loans', crudRouter('loans', [
  F.string('lender', 'lender'), F.string('loanType', 'loan_type'), F.number('principal', 'principal'),
  F.number('rate', 'rate'), F.number('tenure', 'tenure'), F.string('startDate', 'start_date'),
  F.number('emi', 'emi'), F.string('notes', 'notes'), F.string('partnerName', 'partner_name'),
], 'id DESC', 'loans'));

app.use('/api/emi-payments', crudRouter('emi_payments', [
  F.string('date', 'date'), F.number('loanId', 'loan_id'), F.number('amount', 'amount'), F.string('notes', 'notes'),
], 'id DESC', 'loans'));

app.use('/api/setup-costs', crudRouter('setup_costs', [
  F.string('date', 'date'), F.string('category', 'category'), F.string('vendor', 'vendor'),
  F.number('amount', 'amount'), F.string('paidBy', 'paid_by'), F.string('notes', 'notes'),
  F.string('fileName', 'file_name'), F.string('fileType', 'file_type'), F.number('fileSize', 'file_size'), F.string('fileData', 'file_data'),
], 'id DESC', 'setupcosts'));

app.use('/api/setup-cost-categories', crudRouter('setup_cost_categories', [
  F.string('category', 'category'), F.string('groupName', 'group_name'),
  F.string('description', 'description'), F.number('sortOrder', 'sort_order'),
], 'sort_order ASC, id ASC', '*', 'admin'));

app.use('/api/dropdown-options', crudRouter('dropdown_options', [
  F.string('listName', 'list_name'), F.string('value', 'value'), F.number('sortOrder', 'sort_order'),
], 'list_name ASC, sort_order ASC, id ASC', '*', 'admin'));

app.use('/api/event-packages', crudRouter('event_packages', [
  F.string('name', 'name'), F.string('itemName', 'item_name'), F.string('description', 'description'),
  F.number('basePrice', 'base_price'), F.number('prepCost', 'prep_cost'), F.string('priceUnit', 'price_unit'), F.string('dietaryTags', 'dietary_tags'),
  F.string('notes', 'notes'),
], 'id DESC', 'eventcatalog'));

app.use('/api/event-package-selections', crudRouter('event_package_selections', [
  F.number('eventId', 'event_id'), F.number('packageId', 'package_id'), F.string('tagDate', 'tag_date'), F.number('quantity', 'quantity'),
  F.number('discountPct', 'discount_pct'), F.number('discountAmount', 'discount_amount'), F.string('notes', 'notes'),
], 'id DESC', 'eventcatalog', undefined, 'This item is already assigned to this event on that date — edit its quantity instead of adding it again, or pick a different date.'));

app.use('/api/event-prep-items', crudRouter('event_prep_items', [
  F.number('eventId', 'event_id'), F.dateOrNull('prepDate', 'prep_date'), F.string('ingredient', 'ingredient'), F.string('quantity', 'quantity'),
  F.number('cost', 'cost'), F.string('status', 'status'), F.string('notes', 'notes'),
], 'id DESC', 'eventprep'));

app.use('/api/event-invoices', crudRouter('event_invoices', [
  F.number('eventId', 'event_id'), F.number('quoteAmount', 'quote_amount'), F.number('depositAmount', 'deposit_amount'),
  F.number('finalAmount', 'final_amount'), F.number('staffCostAddon', 'staff_cost_addon'),
  F.number('deliveryCostAddon', 'delivery_cost_addon'), F.string('paymentStatus', 'payment_status'),
  F.string('notes', 'notes'),
], 'id DESC', 'eventinvoicing'));

app.use('/api/stall-vendors', crudRouter('stall_vendors', [
  F.string('festivalName', 'festival_name'), F.dateOrNull('eventDate', 'event_date'), F.dateOrNull('endDate', 'end_date'), F.string('location', 'location'),
  F.string('vendorName', 'vendor_name'), F.string('vendorContact', 'vendor_contact'), F.string('stallNumber', 'stall_number'),
  F.number('stallFee', 'stall_fee'), F.string('paymentStatus', 'payment_status'), F.string('notes', 'notes'),
], 'id DESC', 'stallvendor'));

app.use('/api/stall-packages', crudRouter('stall_packages', [
  F.string('name', 'name'), F.string('itemName', 'item_name'), F.string('description', 'description'),
  F.number('basePrice', 'base_price'), F.number('prepCost', 'prep_cost'), F.string('priceUnit', 'price_unit'),
  F.string('dietaryTags', 'dietary_tags'), F.string('notes', 'notes'),
], 'id DESC', 'stallvendor'));

app.use('/api/stall-package-selections', crudRouter('stall_package_selections', [
  F.number('stallVendorId', 'stall_vendor_id'), F.number('packageId', 'package_id'), F.string('tagDate', 'tag_date'),
  F.number('quantity', 'quantity'), F.number('discountPct', 'discount_pct'), F.number('discountAmount', 'discount_amount'),
  F.string('notes', 'notes'),
], 'id DESC', 'stallvendor', undefined, 'This item is already assigned to this stall on that date — edit its quantity instead, or pick a different date.'));

app.use('/api/important-documents', crudRouter('important_documents', [
  F.string('title', 'title'), F.string('category', 'category'), F.string('fileName', 'file_name'),
  F.string('fileType', 'file_type'), F.number('fileSize', 'file_size'), F.string('fileData', 'file_data'),
  F.string('notes', 'notes'),
], 'id DESC', 'importantdocs'));

app.use('/api/monthly-expenses', crudRouter('monthly_expenses', [
  F.string('category', 'category'), F.string('vendor', 'vendor'), F.number('amount', 'amount'),
  F.string('expenseMonth', 'expense_month'), F.string('paymentStatus', 'payment_status'), F.string('notes', 'notes'),
  F.string('fileName', 'file_name'), F.string('fileType', 'file_type'), F.number('fileSize', 'file_size'), F.string('fileData', 'file_data'),
], 'expense_month DESC, id DESC', 'monthlyexpenses'));

app.use('/api/important-contacts', crudRouter('important_contacts', [
  F.string('name', 'name'), F.string('category', 'category'), F.string('company', 'company'),
  F.string('phone', 'phone'), F.string('email', 'email'), F.string('address', 'address'), F.string('notes', 'notes'),
  F.string('fileName', 'file_name'), F.string('fileType', 'file_type'), F.number('fileSize', 'file_size'), F.string('fileData', 'file_data'),
], 'id DESC', 'importantcontacts'));

app.use('/api/menu-categories', crudRouter('menu_categories', [
  F.string('name', 'name'), F.numberOrNull('parentId', 'parent_id'), F.number('sortOrder', 'sort_order'),
], 'sort_order ASC, id ASC', 'menucatalog'));

app.use('/api/menu-items', crudRouter('menu_items', [
  F.string('itemName', 'item_name'), F.string('sku', 'sku'), F.numberOrNull('categoryId', 'category_id'),
  F.string('stationTag', 'station_tag'), F.number('basePrice', 'base_price'), F.string('taxCategory', 'tax_category'),
  F.string('imageData', 'image_data'), F.string('description', 'description'),
  F.boolean('isVegan', 'is_vegan'), F.boolean('isVegetarian', 'is_vegetarian'), F.boolean('isGlutenFree', 'is_gluten_free'),
  F.boolean('isHalal', 'is_halal'), F.boolean('isNutFree', 'is_nut_free'),
], 'id DESC', 'menucatalog', undefined, 'That SKU is already used by another menu item.'));

app.use('/api/menu-combos', crudRouter('menu_combos', [
  F.string('name', 'name'), F.string('description', 'description'), F.number('basePrice', 'base_price'),
], 'id DESC', 'menucatalog'));

app.use('/api/menu-combo-steps', crudRouter('menu_combo_steps', [
  F.number('comboId', 'combo_id'), F.string('stepName', 'step_name'), F.number('minSelect', 'min_select'),
  F.number('maxSelect', 'max_select'), F.number('sortOrder', 'sort_order'),
], 'sort_order ASC, id ASC', 'menucatalog'));

app.use('/api/menu-combo-step-items', crudRouter('menu_combo_step_items', [
  F.number('stepId', 'step_id'), F.number('menuItemId', 'menu_item_id'), F.number('upchargeAmount', 'upcharge_amount'),
], 'id ASC', 'menucatalog', undefined, 'This item is already in that step.'));

// ---------------------------------------------------------------------------
// AI Insights — thin proxy to the Anthropic API so the API key never
// reaches the browser. Requires ANTHROPIC_API_KEY in .env.
// ---------------------------------------------------------------------------
async function askClaude(prompt) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('ANTHROPIC_API_KEY is not set on the server. Add it to .env to use AI Insights.');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${text}`);
  }
  const data = await response.json();
  return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

app.post('/api/ai/analyze', requirePermission('ai', 'view'), async (req, res) => {
  try {
    const { summary } = req.body;
    const prompt = `You are a restaurant financial analyst. Here is a restaurant owner's accounting data as JSON, covering daily restaurant sales, catering jobs, event food, costed menu items, and setup capital (partner contributions and loans). Analyze it and respond in plain, direct language (no jargon) organized under these headers using ## markdown: "## Segment Performance", "## What's Working", "## What's Bleeding Money", "## Capital & Debt", "## Three Actions To Take This Week". Be specific and reference actual numbers from the data. Keep it under 450 words total.\n\nDATA:\n${JSON.stringify(summary)}`;
    const text = await askClaude(prompt);
    res.json({ text });
  } catch (err) {
    console.error(err);
    res.status(err.code === 'NO_API_KEY' ? 400 : 502).json({ error: err.message });
  }
});

app.post('/api/ai/ask', requirePermission('ai', 'view'), async (req, res) => {
  try {
    const { summary, question } = req.body;
    const prompt = `You are a restaurant financial analyst. Here is a restaurant owner's accounting data as JSON (daily sales, catering, events, costed menu items, partner contributions, and loans).\n\nDATA:\n${JSON.stringify(summary)}\n\nThe owner asks: "${question}"\n\nAnswer directly and specifically using the numbers in the data where relevant. Keep it under 250 words. Use ## markdown headers only if it genuinely helps organize a multi-part answer.`;
    const text = await askClaude(prompt);
    res.json({ text });
  } catch (err) {
    console.error(err);
    res.status(err.code === 'NO_API_KEY' ? 400 : 502).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Activity log — every create/edit/delete across the app, for transparency
// among partners. View-only; nothing here can be edited or deleted via API.
// ---------------------------------------------------------------------------
app.get('/api/activity-log', requirePermission('activity', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, username, display_name, action, resource, record_id, details, created_at
       FROM activity_log ORDER BY created_at DESC LIMIT 300`
    );
    res.json(rows.map((r) => ({
      id: r.id, userId: r.user_id, username: r.username, displayName: r.display_name,
      action: r.action, resource: r.resource, recordId: r.record_id, details: r.details, createdAt: r.created_at,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load activity log' });
  }
});

app.get('/api/backup-log', requirePermission('admin', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, status, detail, ran_at FROM backup_log ORDER BY ran_at DESC LIMIT 30`
    );
    res.json(rows.map((r) => ({ id: r.id, status: r.status, detail: r.detail, ranAt: r.ran_at })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load backup log' });
  }
});

// ---------------------------------------------------------------------------
// Self-service profile — any logged-in user can view/edit their own.
// No permission gate beyond being authenticated; you can only ever touch
// your own row (req.session.user.id), never someone else's.
// ---------------------------------------------------------------------------
app.get('/api/profile/me', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { rows } = await pool.query(
      `SELECT u.username, u.display_name, u.bio, u.avatar_data, u.phone, u.email,
              r.name AS role_name, p.name AS partner_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN partners p ON p.id = u.partner_id
       WHERE u.id = $1`,
      [req.session.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];
    res.json({
      username: u.username, displayName: u.display_name, bio: u.bio, avatarData: u.avatar_data,
      phone: u.phone, email: u.email, roleName: u.role_name, partnerName: u.partner_name,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

app.put('/api/profile/me', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { displayName, bio, avatarData, phone, email } = req.body || {};
    // A base64 photo can get large — keep it sane rather than silently accepting anything.
    if (avatarData && avatarData.length > 2_000_000) {
      return res.status(400).json({ error: 'That image is too large. Please use a smaller photo (under ~1.5MB).' });
    }
    await pool.query(
      `UPDATE users SET display_name=$1, bio=$2, avatar_data=$3, phone=$4, email=$5 WHERE id=$6`,
      [displayName || '', bio || '', avatarData || '', phone || '', email || '', req.session.user.id]
    );
    req.session.user.displayName = displayName || req.session.user.username;
    logActivity(req, 'update', 'users', req.session.user.id, { profileUpdated: true, displayName: displayName || '' });
    res.json({ user: req.session.user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                  // 10 attempts per IP per window — enough for real typos, not for guessing
  standardHeaders: true,
  legacyHeaders: false,
  // This is a local, single-machine app — there's no real reverse proxy in front of it.
  // Some local setups (VPNs, browser extensions, dev proxies) still add an
  // X-Forwarded-For header, which express-rate-limit otherwise refuses to trust
  // and throws on. Since we're not relying on that header for anything security-
  // critical here, disable just that validation rather than crash the request.
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many login attempts from this device. Please wait a few minutes and try again.' },
});

async function logFailedLogin(usernameAttempted) {
  try {
    await pool.query(
      `INSERT INTO activity_log (user_id, username, display_name, action, resource, record_id, details)
       VALUES (NULL, $1, '', 'login_failed', 'auth', NULL, $2)`,
      [usernameAttempted || '(blank)', JSON.stringify({ attemptedUsername: usernameAttempted || '' })]
    );
  } catch (err) {
    console.error('Failed to log failed login attempt:', err);
  }
}

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.username_alt, u.password_hash, u.display_name, u.active, u.partner_id, u.must_change_password,
              r.id AS role_id, r.name AS role_name
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.username = $1 OR u.username_alt = $1`,
      [username]
    );
    const user = rows[0];
    if (!user || !user.active) {
      await logFailedLogin(username);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      await logFailedLogin(username);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    let partnerName = null;
    if (user.partner_id) {
      const p = await pool.query('SELECT name FROM partners WHERE id = $1', [user.partner_id]);
      partnerName = p.rows[0] ? p.rows[0].name : null;
    }

    req.session.user = {
      id: user.id, username: user.username, usernameAlt: user.username_alt,
      // The exact name typed to log in this time — could be either alias on a shared account.
      // Used to attribute activity log entries to whichever person actually acted.
      loginUsername: username,
      displayName: user.display_name || user.username,
      roleId: user.role_id, roleName: user.role_name, partnerId: user.partner_id, partnerName,
      mustChangePassword: user.must_change_password,
    };

    const permissions = await getEffectivePermissions(user.id, user.role_id);
    res.json({ user: req.session.user, permissions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.status(204).end());
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  try {
    const permissions = await getEffectivePermissions(req.session.user.id, req.session.user.roleId);
    res.json({ user: req.session.user, permissions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load permissions' });
  }
});

app.post('/api/auth/change-password', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(currentPassword || '', rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [newHash, req.session.user.id]);
    req.session.user.mustChangePassword = false;
    res.json({ user: req.session.user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ---------------------------------------------------------------------------
// Admin: users, roles, and the fine-grained permission matrix
// ---------------------------------------------------------------------------
app.get('/api/users', requirePermission('admin', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.username_alt, u.display_name, u.active, u.partner_id, u.role_id, u.must_change_password,
             r.name AS role_name, p.name AS partner_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN partners p ON p.id = u.partner_id
      ORDER BY u.id`);
    res.json(rows.map((r) => ({
      id: r.id, username: r.username, usernameAlt: r.username_alt, displayName: r.display_name, active: r.active,
      partnerId: r.partner_id, partnerName: r.partner_name, roleId: r.role_id, roleName: r.role_name,
      mustChangePassword: r.must_change_password,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

async function usernameCollisionExists(primary, alt, excludeUserId) {
  const names = [primary, alt].filter(Boolean);
  if (!names.length) return false;
  let sql = `SELECT id FROM users WHERE (username = ANY($1::text[]) OR username_alt = ANY($1::text[]))`;
  const params = [names];
  if (excludeUserId) { sql += ` AND id != $2`; params.push(excludeUserId); }
  const { rows } = await pool.query(sql, params);
  return rows.length > 0;
}

app.post('/api/users', requirePermission('admin', 'edit'), async (req, res) => {
  try {
    const { username, usernameAlt, password, displayName, roleId, partnerId, active, mustChangePassword } = req.body || {};
    if (!username || !password || !roleId) {
      return res.status(400).json({ error: 'Username, password, and role are required' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (usernameAlt && usernameAlt === username) {
      return res.status(400).json({ error: 'Alternate username must be different from the primary username' });
    }
    if (await usernameCollisionExists(username, usernameAlt)) {
      return res.status(409).json({ error: 'One of those usernames is already taken (as a primary or alternate login on another account)' });
    }
    const hash = await bcrypt.hash(password, 10);
    const requireChange = mustChangePassword !== false; // default true — new accounts get a temp password
    const { rows } = await pool.query(
      `INSERT INTO users (username, username_alt, password_hash, display_name, role_id, partner_id, active, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [username, usernameAlt || null, hash, displayName || '', roleId, partnerId || null, active !== false, requireChange]
    );
    logActivity(req, 'create', 'users', rows[0].id, { username, usernameAlt: usernameAlt || null, displayName: displayName || '', roleId, partnerId: partnerId || null });
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.code === '23505' ? 'That username is already taken' : 'Failed to create user' });
  }
});

app.put('/api/users/:id', requirePermission('admin', 'edit'), async (req, res) => {
  try {
    const { displayName, roleId, partnerId, active, password, username, usernameAlt } = req.body || {};
    if (usernameAlt && username && usernameAlt === username) {
      return res.status(400).json({ error: 'Alternate username must be different from the primary username' });
    }
    if (username || usernameAlt) {
      if (await usernameCollisionExists(username, usernameAlt, req.params.id)) {
        return res.status(409).json({ error: 'One of those usernames is already taken (as a primary or alternate login on another account)' });
      }
    }
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        'UPDATE users SET display_name=$1, role_id=$2, partner_id=$3, active=$4, password_hash=$5, must_change_password=true, username_alt=$6 WHERE id=$7',
        [displayName || '', roleId, partnerId || null, active !== false, hash, usernameAlt || null, req.params.id]
      );
      logActivity(req, 'update', 'users', req.params.id, { displayName: displayName || '', roleId, partnerId: partnerId || null, active: active !== false, usernameAlt: usernameAlt || null, passwordReset: true });
    } else {
      await pool.query(
        'UPDATE users SET display_name=$1, role_id=$2, partner_id=$3, active=$4, username_alt=$5 WHERE id=$6',
        [displayName || '', roleId, partnerId || null, active !== false, usernameAlt || null, req.params.id]
      );
      logActivity(req, 'update', 'users', req.params.id, { displayName: displayName || '', roleId, partnerId: partnerId || null, active: active !== false, usernameAlt: usernameAlt || null });
    }
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.code === '23505' ? 'That alternate username is already taken' : 'Failed to update user' });
  }
});

app.delete('/api/users/:id', requirePermission('admin', 'delete'), async (req, res) => {
  try {
    if (req.session.user && String(req.session.user.id) === String(req.params.id)) {
      return res.status(400).json({ error: "You can't delete the account you're currently logged in as." });
    }
    const before = await pool.query('SELECT username, display_name FROM users WHERE id = $1', [req.params.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    if (before.rows[0]) logActivity(req, 'delete', 'users', req.params.id, before.rows[0]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Failed to delete user' });
  }
});

app.get('/api/roles', requirePermission('admin', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, description FROM roles ORDER BY id');
    res.json(rows.map((r) => ({ id: r.id, name: r.name, description: r.description })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load roles' });
  }
});

app.post('/api/roles', requirePermission('admin', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, description } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Role name is required' });
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO roles (name, description) VALUES ($1,$2) RETURNING id',
      [name.trim(), description || '']
    );
    const roleId = rows[0].id;
    // New role starts with everything unchecked — safest default, admin turns on what it needs.
    for (const resource of ALL_RESOURCES) {
      await client.query(
        `INSERT INTO role_permissions (role_id, resource, can_view, can_edit, can_delete)
         VALUES ($1,$2,false,false,false) ON CONFLICT (role_id, resource) DO NOTHING`,
        [roleId, resource]
      );
    }
    await client.query('COMMIT');
    logActivity(req, 'create', 'roles', roleId, { name: name.trim(), description: description || '' });
    res.status(201).json({ id: roleId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(400).json({ error: err.code === '23505' ? 'A role with that name already exists' : 'Failed to create role' });
  } finally {
    client.release();
  }
});

app.put('/api/roles/:id', requirePermission('admin', 'edit'), async (req, res) => {
  try {
    const { name, description } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Role name is required' });
    await pool.query('UPDATE roles SET name=$1, description=$2 WHERE id=$3', [name.trim(), description || '', req.params.id]);
    logActivity(req, 'update', 'roles', req.params.id, { name: name.trim(), description: description || '' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.code === '23505' ? 'A role with that name already exists' : 'Failed to update role' });
  }
});

app.delete('/api/roles/:id', requirePermission('admin', 'delete'), async (req, res) => {
  try {
    const inUse = await pool.query('SELECT COUNT(*) FROM users WHERE role_id = $1', [req.params.id]);
    if (parseInt(inUse.rows[0].count, 10) > 0) {
      return res.status(400).json({ error: 'This role still has users assigned to it. Reassign or remove them first.' });
    }
    const before = await pool.query('SELECT name FROM roles WHERE id = $1', [req.params.id]);
    await pool.query('DELETE FROM roles WHERE id = $1', [req.params.id]);
    if (before.rows[0]) logActivity(req, 'delete', 'roles', req.params.id, before.rows[0]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Failed to delete role' });
  }
});

app.get('/api/role-permissions', requirePermission('admin', 'view'), async (req, res) => {
  try {
    // Every role should have a row for every resource in the matrix, even if
    // it was never explicitly granted at seed time — otherwise a combination
    // like "Partner + a newly added module" simply has nothing to show and
    // nothing to toggle. This fills in any gaps as false/false/false, safe
    // to run every time (ON CONFLICT DO NOTHING), before reading the matrix.
    await pool.query(
      `INSERT INTO role_permissions (role_id, resource, can_view, can_edit, can_delete)
       SELECT r.id, res.resource, false, false, false
       FROM roles r
       CROSS JOIN unnest($1::text[]) AS res(resource)
       ON CONFLICT (role_id, resource) DO NOTHING`,
      [ALL_RESOURCES]
    );

    const { rows } = await pool.query(`
      SELECT rp.id, rp.role_id, r.name AS role_name, rp.resource, rp.can_view, rp.can_edit, rp.can_delete
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      ORDER BY r.id, rp.resource`);
    res.json(rows.map((r) => ({
      id: r.id, roleId: r.role_id, roleName: r.role_name, resource: r.resource,
      canView: r.can_view, canEdit: r.can_edit, canDelete: r.can_delete,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load permissions' });
  }
});

app.put('/api/role-permissions/:id', requirePermission('admin', 'edit'), async (req, res) => {
  try {
    const { canView, canEdit, canDelete } = req.body || {};
    const { rows } = await pool.query(
      'UPDATE role_permissions SET can_view=$1, can_edit=$2, can_delete=$3 WHERE id=$4 RETURNING *',
      [!!canView, !!canEdit, !!canDelete, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    logActivity(req, 'update', 'role_permissions', rows[0].id, {
      roleId: rows[0].role_id, resource: rows[0].resource,
      canView: rows[0].can_view, canEdit: rows[0].can_edit, canDelete: rows[0].can_delete,
    });
    res.json({
      id: rows[0].id, roleId: rows[0].role_id, resource: rows[0].resource,
      canView: rows[0].can_view, canEdit: rows[0].can_edit, canDelete: rows[0].can_delete,
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Failed to update permission' });
  }
});

// ---------------------------------------------------------------------------
// Per-user menu access overrides — the Super Admin control panel for
// individually granting or revoking specific menus for specific people,
// layered on top of their role.
// ---------------------------------------------------------------------------
app.get('/api/user-menu-overrides/:userId', requirePermission('admin', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT resource, can_view, can_edit, can_delete FROM user_menu_overrides WHERE user_id = $1',
      [req.params.userId]
    );
    res.json(rows.map((r) => ({ resource: r.resource, canView: r.can_view, canEdit: r.can_edit, canDelete: r.can_delete })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load menu access overrides' });
  }
});

app.put('/api/user-menu-overrides/:userId/:resource', requirePermission('admin', 'edit'), async (req, res) => {
  try {
    const { canView, canEdit, canDelete } = req.body || {};
    const v = canView === undefined ? null : canView;
    const e = canEdit === undefined ? null : canEdit;
    const d = canDelete === undefined ? null : canDelete;
    await pool.query(
      `INSERT INTO user_menu_overrides (user_id, resource, can_view, can_edit, can_delete) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, resource) DO UPDATE SET can_view = EXCLUDED.can_view, can_edit = EXCLUDED.can_edit, can_delete = EXCLUDED.can_delete`,
      [req.params.userId, req.params.resource, v, e, d]
    );
    logActivity(req, 'update', 'user_menu_overrides', req.params.userId, {
      resource: req.params.resource, canView: v, canEdit: e, canDelete: d,
    });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Failed to update menu access' });
  }
});

app.delete('/api/user-menu-overrides/:userId/:resource', requirePermission('admin', 'delete'), async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM user_menu_overrides WHERE user_id = $1 AND resource = $2',
      [req.params.userId, req.params.resource]
    );
    logActivity(req, 'delete', 'user_menu_overrides', req.params.userId, { resource: req.params.resource, revertedToDefault: true });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Failed to revert menu access' });
  }
});

app.listen(PORT, () => {
  console.log(`RollCall Ops running at http://localhost:${PORT}`);
});