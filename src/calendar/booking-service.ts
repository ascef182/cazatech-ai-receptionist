import { randomInt } from 'node:crypto';
import type pg from 'pg';
import type { Db } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { audit } from '../db/audit.js';
import type { Clock } from '../lib/clock.js';
import { isRetryable } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { TenantContext } from '../tenant/context.js';
import { freeSlots, withinBusinessHours } from './availability.js';
import { eventIdFromUuid, type CalendarProvider, type Interval } from './provider.js';
import { addDays, formatLocal, localDateString, zonedToUtc } from './time.js';

export interface BookingDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  calendarFor(tenantId: string): Promise<CalendarProvider | null>;
  retryDelayMs?: number;
}

export interface Scope {
  tenant: TenantContext;
  conversationId: string;
  contactId: string;
}

export type ToolOutcome<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; error: string; message: string };

const OFFER_TTL_MIN = 30;
const PROPOSAL_TTL_MIN = 30;
const MAX_SLOTS = 6;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function code(): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

const fail = (error: string, message: string) => ({ ok: false as const, error, message });

export class BookingService {
  constructor(private readonly d: BookingDeps) {}

  private async calendar(tenantId: string): Promise<CalendarProvider> {
    const c = await this.d.calendarFor(tenantId);
    if (!c) throw Object.assign(new Error('agenda não conectada'), { code: 'no_calendar' });
    return c;
  }

  // ------------------------------------------------------------------ disponibilidade
  async checkAvailability(
    s: Scope,
    input: { service_id: string; date: string; part_of_day?: 'morning' | 'afternoon' | 'evening' | 'any' },
  ): Promise<ToolOutcome<{ date: string; slots: { slot_code: string; when: string; professional: string }[] }>> {
    const t = s.tenant;
    const service = t.services.find((x) => x.id === input.service_id);
    if (!service) return fail('unknown_service', 'Serviço não encontrado. Use list_services.');
    const now = this.d.clock.now();
    const today = localDateString(now, t.timezone);
    const lastDay = addDays(today, t.settings.booking_horizon_days);
    if (input.date < today || input.date > lastDay)
      return fail('date_out_of_range', `Só é possível agendar entre ${today} e ${lastDay}.`);

    const resources = t.resources.filter((r) => r.external_calendar_id && r.service_ids.includes(service.id));
    if (!resources.length) return fail('no_resource', 'Nenhum profissional atende esse serviço pela agenda online.');

    const dayStart = zonedToUtc(input.date, '00:00', t.timezone);
    const dayEnd = zonedToUtc(addDays(input.date, 1), '00:00', t.timezone);
    let external: Map<string, Interval[]>;
    try {
      external = await (await this.calendar(t.id)).busy(resources.map((r) => r.external_calendar_id!), dayStart, dayEnd);
    } catch (err) {
      this.d.log.warn({ err: (err as Error).message }, 'falha ao consultar disponibilidade');
      return fail('calendar_unavailable', 'A agenda não respondeu agora. Não informe horários; ofereça encaminhar para a equipe.');
    }
    const internal = await this.d.db.query(
      `SELECT resource_id, starts_at, ends_at FROM bookings
       WHERE tenant_id = $1 AND status IN ('pending','confirmed') AND starts_at < $3 AND ends_at > $2`,
      [t.id, dayStart, dayEnd],
    );

    const notBefore = new Date(now.getTime() + t.settings.min_notice_minutes * 60_000);
    const candidates: { resourceId: string; name: string; slot: Interval }[] = [];
    for (const r of resources) {
      const busy = [
        ...(external.get(r.external_calendar_id!) ?? []),
        ...internal.rows.filter((b) => b.resource_id === r.id).map((b) => ({ start: b.starts_at, end: b.ends_at })),
      ];
      for (const slot of freeSlots({
        date: input.date,
        durationMin: service.duration_min,
        stepMin: t.settings.slot_step_minutes,
        timezone: t.timezone,
        hours: t.settings.business_hours,
        busy,
        notBefore,
        partOfDay: input.part_of_day,
      }))
        candidates.push({ resourceId: r.id, name: r.name, slot });
    }
    candidates.sort((a, b) => a.slot.start.getTime() - b.slot.start.getTime());
    const seen = new Set<number>();
    const picked = candidates.filter((c) => !seen.has(c.slot.start.getTime()) && seen.add(c.slot.start.getTime())).slice(0, MAX_SLOTS);

    const expires = new Date(now.getTime() + OFFER_TTL_MIN * 60_000);
    const slots = [];
    for (const p of picked) {
      let c = code();
      for (let i = 0; i < 3; i++) {
        const r = await this.d.db.query(
          `INSERT INTO slot_offers (code, tenant_id, conversation_id, service_id, resource_id, starts_at, ends_at, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [c, t.id, s.conversationId, service.id, p.resourceId, p.slot.start, p.slot.end, expires],
        );
        if (r.rowCount) break;
        c = code();
      }
      slots.push({ slot_code: c, when: formatLocal(p.slot.start, t.timezone), professional: p.name });
    }
    return { ok: true, date: input.date, slots };
  }

  // ------------------------------------------------------------------ propostas (exigem confirmação do cliente)
  async proposeCreate(s: Scope, input: { slot_code: string; customer_name: string }) {
    const offer = await this.offer(s, input.slot_code);
    if (!offer) return fail('invalid_slot', 'Código de horário inválido ou expirado. Consulte a disponibilidade de novo.');
    const p = await this.insertProposal(s, { action: 'create', ...offer, customer_name: input.customer_name });
    return { ok: true as const, proposal_id: p, summary: this.summary(s, offer), instruction: 'Peça ao cliente para confirmar explicitamente antes de chamar confirm_proposal.' };
  }

  async proposeReschedule(s: Scope, input: { booking_id: string; slot_code: string }) {
    const b = await this.ownBooking(s, input.booking_id);
    if (!b) return fail('unknown_booking', 'Reserva não encontrada para este cliente.');
    const offer = await this.offer(s, input.slot_code);
    if (!offer) return fail('invalid_slot', 'Código de horário inválido ou expirado. Consulte a disponibilidade de novo.');
    if (offer.service_id !== b.service_id) return fail('service_mismatch', 'O horário oferecido é de outro serviço.');
    const p = await this.insertProposal(s, { action: 'reschedule', ...offer, target_booking_id: b.id, customer_name: b.customer_name });
    return { ok: true as const, proposal_id: p, summary: `Remarcar de ${formatLocal(b.starts_at, s.tenant.timezone)} para ${this.summary(s, offer)}` };
  }

  async proposeCancel(s: Scope, input: { booking_id: string }) {
    const b = await this.ownBooking(s, input.booking_id);
    if (!b) return fail('unknown_booking', 'Reserva não encontrada para este cliente.');
    const p = await this.insertProposal(s, { action: 'cancel', target_booking_id: b.id, service_id: b.service_id, resource_id: b.resource_id });
    return { ok: true as const, proposal_id: p, summary: `Cancelar o horário de ${formatLocal(b.starts_at, s.tenant.timezone)}` };
  }

  async listUpcoming(s: Scope) {
    const r = await this.d.db.query(
      `SELECT b.id, b.starts_at, sv.name AS service, rs.name AS professional
       FROM bookings b JOIN services sv ON sv.id = b.service_id JOIN resources rs ON rs.id = b.resource_id
       WHERE b.tenant_id = $1 AND b.contact_id = $2 AND b.status = 'confirmed' AND b.starts_at > $3
       ORDER BY b.starts_at LIMIT 10`,
      [s.tenant.id, s.contactId, this.d.clock.now()],
    );
    return {
      ok: true as const,
      bookings: r.rows.map((b) => ({ booking_id: b.id, when: formatLocal(b.starts_at, s.tenant.timezone), service: b.service, professional: b.professional })),
    };
  }

  // ------------------------------------------------------------------ execução
  async confirmProposal(s: Scope, input: { proposal_id: string }): Promise<ToolOutcome> {
    const r = await this.d.db.query(
      `SELECT p.*, (SELECT max(m.created_at) FROM messages m
                    WHERE m.conversation_id = p.conversation_id AND m.tenant_id = p.tenant_id
                      AND m.direction = 'in') AS last_inbound
       FROM booking_proposals p
       WHERE p.id = $1 AND p.tenant_id = $2 AND p.conversation_id = $3 AND p.contact_id = $4`,
      [input.proposal_id, s.tenant.id, s.conversationId, s.contactId],
    );
    const p = r.rows[0];
    if (!p) return fail('unknown_proposal', 'Proposta não encontrada.');
    if (p.status === 'confirmed') return this.alreadyDone(s, p);
    if (p.status !== 'open') return fail('proposal_closed', 'Essa proposta não está mais válida. Faça uma nova.');
    if (p.expires_at < this.d.clock.now()) {
      await this.d.db.query(`UPDATE booking_proposals SET status = 'expired' WHERE id = $1`, [p.id]);
      return fail('proposal_expired', 'A proposta expirou. Consulte a disponibilidade de novo.');
    }
    // Confirmação verificável: precisa existir uma mensagem do cliente posterior à proposta.
    if (!p.last_inbound || p.last_inbound <= p.created_at)
      return fail('not_confirmed_by_customer', 'O cliente ainda não confirmou. Apresente o resumo e aguarde a resposta.');

    if (p.action === 'create') return this.execCreate(s, p);
    if (p.action === 'cancel') return this.execCancel(s, p);
    return this.execReschedule(s, p);
  }

  private async execCreate(s: Scope, p: any): Promise<ToolOutcome> {
    const t = s.tenant;
    const resource = t.resources.find((r) => r.id === p.resource_id);
    if (!resource?.external_calendar_id) return this.failProposal(p.id, 'no_resource', 'Profissional indisponível.');
    const date = localDateString(p.starts_at, t.timezone);
    const slot = { start: p.starts_at as Date, end: p.ends_at as Date };
    const now = this.d.clock.now();
    if (slot.start.getTime() < now.getTime() + t.settings.min_notice_minutes * 60_000 || !withinBusinessHours(slot, date, t.timezone, t.settings.business_hours))
      return this.failProposal(p.id, 'slot_not_allowed', 'Esse horário não pode mais ser reservado.');

    let cal: CalendarProvider;
    try {
      cal = await this.calendar(t.id);
    } catch {
      return this.failProposal(p.id, 'calendar_unavailable', 'Agenda não conectada.');
    }

    // 1) reserva local: a constraint de exclusão impede sobreposição mesmo com workers concorrentes
    let bookingId: string;
    try {
      const ins = await this.d.db.query(
        `INSERT INTO bookings (tenant_id, resource_id, service_id, contact_id, conversation_id, proposal_id,
                               starts_at, ends_at, status, customer_name, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,'ai')
         ON CONFLICT (proposal_id) DO UPDATE SET updated_at = now()
         RETURNING id, status, external_event_id`,
        [t.id, p.resource_id, p.service_id, s.contactId, s.conversationId, p.id, slot.start, slot.end, p.customer_name],
      );
      bookingId = ins.rows[0].id;
      if (ins.rows[0].status === 'confirmed') return this.alreadyDone(s, p);
    } catch (err) {
      if ((err as any).code === '23P01') return this.failProposal(p.id, 'slot_taken', 'Esse horário acabou de ser ocupado. Ofereça outras opções.');
      throw err;
    }

    // 2) revalida na agenda externa (eventos criados manualmente pela equipe)
    try {
      const busy = (await cal.busy([resource.external_calendar_id], slot.start, slot.end)).get(resource.external_calendar_id) ?? [];
      const ownEventId = eventIdFromUuid(bookingId);
      const conflict = busy.some((b) => b.start < slot.end && b.end > slot.start);
      if (conflict && !(await cal.getEvent(resource.external_calendar_id, ownEventId))) {
        await this.markBooking(bookingId, 'failed', 'slot_taken_external');
        return this.failProposal(p.id, 'slot_taken', 'Esse horário foi ocupado na agenda. Ofereça outras opções.');
      }
    } catch (err) {
      await this.markBooking(bookingId, 'failed', 'freebusy_failed');
      return this.failProposal(p.id, 'calendar_unavailable', 'Não consegui confirmar a disponibilidade agora.');
    }

    // 3) cria o evento com id determinístico (idempotente em caso de nova tentativa)
    const service = t.services.find((x) => x.id === p.service_id);
    const created = await this.createEventWithRetry(cal, resource.external_calendar_id, {
      id: eventIdFromUuid(bookingId),
      summary: `${service?.name ?? 'Atendimento'} — ${p.customer_name ?? 'Cliente'}`,
      description: 'Agendado pelo assistente virtual via WhatsApp.',
      start: slot.start,
      end: slot.end,
      timeZone: t.timezone,
      privateProps: { air_booking_id: bookingId, air_tenant_id: t.id },
    });
    if (!created.ok) {
      await this.markBooking(bookingId, 'failed', created.error);
      return this.failProposal(p.id, 'calendar_error', 'Não foi possível registrar na agenda. Não confirme o horário ao cliente.');
    }

    await withTx(this.d.db, async (c) => {
      await c.query(`UPDATE bookings SET status = 'confirmed', external_event_id = $2, updated_at = now() WHERE id = $1`, [bookingId, created.id]);
      await c.query(`UPDATE booking_proposals SET status = 'confirmed' WHERE id = $1`, [p.id]);
      await audit(c, { tenantId: t.id, actor: 'ai', action: 'booking.created', entity: 'booking', entityId: bookingId });
    });
    return { ok: true, booking_id: bookingId, when: formatLocal(slot.start, t.timezone), service: service?.name, confirmed_by_calendar: true };
  }

  private async execCancel(s: Scope, p: any): Promise<ToolOutcome> {
    const b = await this.ownBooking(s, p.target_booking_id);
    if (!b) return this.failProposal(p.id, 'unknown_booking', 'Reserva não encontrada.');
    const resource = s.tenant.resources.find((r) => r.id === b.resource_id);
    try {
      if (resource?.external_calendar_id && b.external_event_id) await (await this.calendar(s.tenant.id)).deleteEvent(resource.external_calendar_id, b.external_event_id);
    } catch (err) {
      return this.failProposal(p.id, 'calendar_error', 'Não consegui cancelar na agenda agora. Encaminhe para a equipe.');
    }
    await withTx(this.d.db, async (c) => {
      await c.query(`UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE id = $1`, [b.id]);
      await c.query(`UPDATE booking_proposals SET status = 'confirmed' WHERE id = $1`, [p.id]);
      await audit(c, { tenantId: s.tenant.id, actor: 'ai', action: 'booking.cancelled', entity: 'booking', entityId: b.id });
    });
    return { ok: true, cancelled_booking_id: b.id };
  }

  private async execReschedule(s: Scope, p: any): Promise<ToolOutcome> {
    const created = await this.execCreate(s, p);
    if (!created.ok) return created;
    const old = await this.ownBooking(s, p.target_booking_id);
    if (old) {
      const resource = s.tenant.resources.find((r) => r.id === old.resource_id);
      try {
        if (resource?.external_calendar_id && old.external_event_id) await (await this.calendar(s.tenant.id)).deleteEvent(resource.external_calendar_id, old.external_event_id);
        await this.d.db.query(`UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE id = $1`, [old.id]);
        await audit(this.d.db, { tenantId: s.tenant.id, actor: 'ai', action: 'booking.rescheduled', entity: 'booking', entityId: old.id, data: { new_booking_id: created.booking_id } });
      } catch {
        // novo horário confirmado, antigo ainda ativo: situação que exige pessoa da equipe
        return { ...created, warning: 'old_booking_not_cancelled', handoff_required: true };
      }
    }
    return created;
  }

  private async createEventWithRetry(cal: CalendarProvider, calendarId: string, ev: Parameters<CalendarProvider['createEvent']>[1]) {
    const base = this.d.retryDelayMs ?? 300;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await cal.createEvent(calendarId, ev);
        return { ok: true as const, id: r.id };
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) break;
        await new Promise((res) => setTimeout(res, base * 2 ** attempt));
      }
    }
    // Resposta perdida (timeout) pode esconder uma criação bem-sucedida: confere antes de declarar falha.
    try {
      const existing = await cal.getEvent(calendarId, ev.id);
      if (existing && existing.status !== 'cancelled') return { ok: true as const, id: existing.id };
    } catch {}
    this.d.log.warn({ err: (lastErr as Error)?.message }, 'falha ao criar evento na agenda');
    return { ok: false as const, error: (lastErr as Error)?.message?.slice(0, 200) ?? 'unknown' };
  }

  // ------------------------------------------------------------------ utilitários
  private summary(s: Scope, o: { service_id: string; resource_id: string; starts_at: Date }) {
    const sv = s.tenant.services.find((x) => x.id === o.service_id);
    const rs = s.tenant.resources.find((x) => x.id === o.resource_id);
    return `${sv?.name} com ${rs?.name}, ${formatLocal(o.starts_at, s.tenant.timezone)}`;
  }

  private async offer(s: Scope, slotCode: string) {
    const r = await this.d.db.query(
      `SELECT service_id, resource_id, starts_at, ends_at FROM slot_offers
       WHERE conversation_id = $1 AND tenant_id = $2 AND code = $3 AND expires_at > $4`,
      [s.conversationId, s.tenant.id, slotCode.trim().toUpperCase(), this.d.clock.now()],
    );
    return r.rows[0] as { service_id: string; resource_id: string; starts_at: Date; ends_at: Date } | undefined;
  }

  private async ownBooking(s: Scope, bookingId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(bookingId)) return undefined;
    const r = await this.d.db.query(
      `SELECT * FROM bookings WHERE id = $1 AND tenant_id = $2 AND contact_id = $3 AND status = 'confirmed'`,
      [bookingId, s.tenant.id, s.contactId],
    );
    return r.rows[0];
  }

  private async insertProposal(s: Scope, p: Record<string, unknown>): Promise<string> {
    return withTx(this.d.db, async (c: pg.PoolClient) => {
      await c.query(`UPDATE booking_proposals SET status = 'superseded' WHERE conversation_id = $1 AND tenant_id = $2 AND status = 'open'`, [
        s.conversationId,
        s.tenant.id,
      ]);
      const r = await c.query(
        `INSERT INTO booking_proposals (tenant_id, conversation_id, contact_id, action, service_id, resource_id, starts_at, ends_at,
                                        target_booking_id, customer_name, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          s.tenant.id,
          s.conversationId,
          s.contactId,
          p.action,
          p.service_id ?? null,
          p.resource_id ?? null,
          p.starts_at ?? null,
          p.ends_at ?? null,
          p.target_booking_id ?? null,
          p.customer_name ?? null,
          new Date(this.d.clock.now().getTime() + PROPOSAL_TTL_MIN * 60_000),
        ],
      );
      return r.rows[0].id as string;
    });
  }

  private async alreadyDone(s: Scope, p: any): Promise<ToolOutcome> {
    const b = await this.d.db.query(`SELECT id, starts_at FROM bookings WHERE proposal_id = $1 AND tenant_id = $2`, [p.id, s.tenant.id]);
    return { ok: true, already_confirmed: true, booking_id: b.rows[0]?.id, when: b.rows[0] ? formatLocal(b.rows[0].starts_at, s.tenant.timezone) : undefined };
  }

  private async markBooking(id: string, status: string, error: string) {
    await this.d.db.query(`UPDATE bookings SET status = $2, error = $3, updated_at = now() WHERE id = $1`, [id, status, error]);
  }

  private async failProposal(id: string, error: string, message: string) {
    await this.d.db.query(`UPDATE booking_proposals SET status = 'failed' WHERE id = $1 AND status = 'open'`, [id]);
    return fail(error, message);
  }
}
