import { JWT } from 'google-auth-library';
import { HttpError, PermanentError } from '../lib/errors.js';
import { httpJson, httpRequest, type FetchLike } from '../lib/http.js';
import type { CalendarEventInput, CalendarProvider, Interval } from './provider.js';

const BASE = 'https://www.googleapis.com/calendar/v3';

/**
 * Escopos mínimos usados:
 *  - calendar.events   -> criar, ler e remover eventos (events.insert / get / delete)
 *  - calendar.freebusy -> consultar disponibilidade (freeBusy.query)
 * Nenhum acesso a e-mail, contatos ou outras agendas além das compartilhadas com a conta de serviço.
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
];

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  /** e-mail a personificar (delegação em domínio Google Workspace); opcional */
  subject?: string;
}

export type TokenSource = () => Promise<string>;

export function serviceAccountTokenSource(creds: ServiceAccountCredentials): TokenSource {
  const jwt = new JWT({ email: creds.client_email, key: creds.private_key, scopes: GOOGLE_SCOPES, subject: creds.subject });
  return async () => {
    const { token } = await jwt.getAccessToken();
    if (!token) throw new PermanentError('não foi possível obter token do Google', 'google_auth');
    return token;
  };
}

export class GoogleCalendarProvider implements CalendarProvider {
  constructor(
    private readonly token: TokenSource,
    private readonly fetchImpl?: FetchLike,
    private readonly timeoutMs = 10_000,
  ) {}

  private async headers() {
    return { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' };
  }

  async busy(calendarIds: string[], from: Date, to: Date) {
    const res = await httpJson<{ calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }> }>(
      `${BASE}/freeBusy`,
      {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: calendarIds.map((id) => ({ id })) }),
      },
      { service: 'google-calendar', timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl },
    );
    const out = new Map<string, Interval[]>();
    for (const id of calendarIds) {
      const cal = res.calendars?.[id];
      if (!cal || cal.errors?.length) {
        // Sem informação confiável de disponibilidade: tratar como indisponível, nunca como livre.
        throw new PermanentError(`freeBusy sem dados para a agenda (${cal?.errors?.[0]?.reason ?? 'ausente'})`, 'freebusy_error');
      }
      out.set(id, (cal.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) })));
    }
    return out;
  }

  async createEvent(calendarId: string, ev: CalendarEventInput) {
    const body = {
      id: ev.id,
      summary: ev.summary,
      description: ev.description,
      start: { dateTime: ev.start.toISOString(), timeZone: ev.timeZone },
      end: { dateTime: ev.end.toISOString(), timeZone: ev.timeZone },
      extendedProperties: ev.privateProps ? { private: ev.privateProps } : undefined,
    };
    try {
      const res = await httpJson<{ id: string }>(
        `${BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
        { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) },
        { service: 'google-calendar', timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl },
      );
      return { id: res.id };
    } catch (err) {
      // Reenvio com o mesmo id após timeout: se o evento já existe, a criação anterior funcionou.
      if (err instanceof HttpError && err.status === 409) {
        const existing = await this.getEvent(calendarId, ev.id);
        if (existing && existing.status !== 'cancelled') return { id: existing.id };
      }
      throw err;
    }
  }

  async getEvent(calendarId: string, eventId: string) {
    try {
      return await httpJson<{ id: string; status?: string }>(
        `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: 'GET', headers: await this.headers() },
        { service: 'google-calendar', timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl },
      );
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return null;
      throw err;
    }
  }

  async deleteEvent(calendarId: string, eventId: string) {
    try {
      await httpRequest(
        `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
        { method: 'DELETE', headers: await this.headers() },
        { service: 'google-calendar', timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl },
      );
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return; // já removido
      throw err;
    }
  }
}
