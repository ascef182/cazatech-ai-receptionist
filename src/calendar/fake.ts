import { HttpError, RetryableError } from '../lib/errors.js';
import type { CalendarEventInput, CalendarProvider, Interval } from './provider.js';

/** Agenda em memória com injeção de falhas, para testes e demonstrações sem credenciais. */
export class FakeCalendarProvider implements CalendarProvider {
  events = new Map<string, Map<string, CalendarEventInput & { status: string }>>();
  externalBusy = new Map<string, Interval[]>();
  failCreate: 'none' | 'retryable_once' | 'permanent' | 'timeout_after_create' = 'none';
  failBusy = false;
  /** atraso artificial no freeBusy para reproduzir corridas entre workers */
  busyDelayMs = 0;
  calls: string[] = [];

  private cal(id: string) {
    let c = this.events.get(id);
    if (!c) this.events.set(id, (c = new Map()));
    return c;
  }

  async busy(calendarIds: string[], from: Date, to: Date) {
    this.calls.push('busy');
    if (this.failBusy) throw new RetryableError('freeBusy indisponível (simulado)');
    const out = new Map<string, Interval[]>();
    for (const id of calendarIds) {
      const list: Interval[] = [...(this.externalBusy.get(id) ?? [])];
      for (const e of this.cal(id).values()) if (e.status !== 'cancelled') list.push({ start: e.start, end: e.end });
      out.set(id, list.filter((i) => i.start < to && i.end > from));
    }
    // a resposta reflete o estado do momento da consulta, como numa API remota com latência
    if (this.busyDelayMs) await new Promise((r) => setTimeout(r, this.busyDelayMs));
    return out;
  }

  async createEvent(calendarId: string, ev: CalendarEventInput) {
    this.calls.push('create');
    const c = this.cal(calendarId);
    if (this.failCreate === 'retryable_once') {
      this.failCreate = 'none';
      throw new RetryableError('Calendar 503 (simulado)');
    }
    if (this.failCreate === 'permanent') throw new HttpError('google-calendar', 403, 'forbidden (simulado)');
    if (c.has(ev.id)) {
      if (c.get(ev.id)!.status !== 'cancelled') return { id: ev.id };
      throw new HttpError('google-calendar', 409, 'duplicate');
    }
    c.set(ev.id, { ...ev, status: 'confirmed' });
    if (this.failCreate === 'timeout_after_create') {
      this.failCreate = 'none';
      const e = new Error('timeout');
      e.name = 'TimeoutError';
      throw e; // o evento foi criado, mas a resposta "se perdeu"
    }
    return { id: ev.id };
  }

  async getEvent(calendarId: string, eventId: string) {
    const e = this.cal(calendarId).get(eventId);
    return e ? { id: eventId, status: e.status } : null;
  }

  async deleteEvent(calendarId: string, eventId: string) {
    this.calls.push('delete');
    const e = this.cal(calendarId).get(eventId);
    if (e) e.status = 'cancelled';
  }

  activeEvents(calendarId: string) {
    return [...this.cal(calendarId).values()].filter((e) => e.status !== 'cancelled');
  }
}
