import type { Queryable } from './pool.js';

export async function audit(
  q: Queryable,
  entry: { tenantId: string | null; actor: string; action: string; entity?: string; entityId?: string; data?: Record<string, unknown> },
): Promise<void> {
  await q.query(
    `INSERT INTO audit_log (tenant_id, actor, action, entity, entity_id, data) VALUES ($1,$2,$3,$4,$5,$6)`,
    [entry.tenantId, entry.actor, entry.action, entry.entity ?? null, entry.entityId ?? null, entry.data ?? {}],
  );
}
