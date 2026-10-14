/**
 * Cria (ou recria) uma empresa de demonstração.
 * Uso: DATABASE_URL=... DATA_ENCRYPTION_KEY=... tsx scripts/seed-demo.ts --phone-number-id 123 --token EAAG... [--calendar fake|google --calendar-id agenda@group.calendar.google.com --service-account ./sa.json]
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createPool, withTx } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { encryptSecret, sha256Hex } from '../src/lib/crypto.js';

const { values: a } = parseArgs({
  options: {
    slug: { type: 'string', default: 'studio-demo' },
    name: { type: 'string', default: 'Studio Demo' },
    'phone-number-id': { type: 'string' },
    token: { type: 'string' },
    calendar: { type: 'string', default: 'fake' },
    'calendar-id': { type: 'string', default: 'demo-calendar' },
    'service-account': { type: 'string' },
    'handoff-url': { type: 'string' },
    booking: { type: 'boolean', default: true },
  },
});
if (!a['phone-number-id'] || !a.token) throw new Error('Informe --phone-number-id e --token');
const key = process.env.DATA_ENCRYPTION_KEY!;
const db = createPool(process.env.DATABASE_URL!);
await migrate(db);

const adminKey = randomBytes(24).toString('hex');
await withTx(db, async (c) => {
  await c.query(`DELETE FROM tenants WHERE slug = $1`, [a.slug]);
  const t = await c.query(`INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING id`, [a.name, a.slug]);
  const id = t.rows[0].id;
  await c.query(
    `INSERT INTO tenant_settings (tenant_id, booking_enabled, business_info, business_hours, handoff_webhook_url) VALUES ($1,$2,$3,$4,$5)`,
    [
      id,
      a.booking,
      { address: 'Rua Exemplo, 123 — Centro', payment: 'Pix, débito e crédito', cancellation_policy: 'Cancelamentos com até 24h de antecedência' },
      { tue: [['09:00', '19:00']], wed: [['09:00', '19:00']], thu: [['09:00', '19:00']], fri: [['09:00', '19:00']], sat: [['09:00', '17:00']] },
      a['handoff-url'] ?? null,
    ],
  );
  await c.query(`INSERT INTO whatsapp_numbers (tenant_id, phone_number_id, access_token_ciphertext) VALUES ($1,$2,$3)`, [id, a['phone-number-id'], encryptSecret(a.token!, key)]);
  const services = [
    ['Corte feminino', 60, 'R$ 90'],
    ['Escova', 45, 'R$ 60'],
    ['Coloração', 120, 'a partir de R$ 180 (avaliação no salão)'],
  ];
  const r = await c.query(`INSERT INTO resources (tenant_id, name, external_calendar_id) VALUES ($1,'Ana',$2) RETURNING id`, [id, a['calendar-id']]);
  for (const [n, d, p] of services) {
    const s = await c.query(`INSERT INTO services (tenant_id, name, duration_min, price_text) VALUES ($1,$2,$3,$4) RETURNING id`, [id, n, d, p]);
    await c.query(`INSERT INTO resource_services (tenant_id, resource_id, service_id) VALUES ($1,$2,$3)`, [id, r.rows[0].id, s.rows[0].id]);
  }
  const creds = a['service-account'] ? encryptSecret(readFileSync(a['service-account'], 'utf8'), key) : null;
  await c.query(`INSERT INTO calendar_connections (tenant_id, provider, auth_type, credentials_ciphertext) VALUES ($1,$2,'service_account',$3)`, [
    id,
    a.calendar,
    creds,
  ]);
  await c.query(`INSERT INTO admin_api_keys (tenant_id, key_hash, label) VALUES ($1,$2,'seed')`, [id, sha256Hex(adminKey)]);
  console.log(JSON.stringify({ tenantId: id, adminKey }, null, 2));
});
await db.end();
