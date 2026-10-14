export interface Interval {
  start: Date;
  end: Date;
}

export interface CalendarEventInput {
  /** id determinístico (base32hex, 5–1024 chars) para tornar a criação idempotente */
  id: string;
  summary: string;
  description?: string;
  start: Date;
  end: Date;
  timeZone: string;
  privateProps?: Record<string, string>;
}

export interface CalendarProvider {
  /** Intervalos ocupados por agenda no período [from, to). */
  busy(calendarIds: string[], from: Date, to: Date): Promise<Map<string, Interval[]>>;
  createEvent(calendarId: string, ev: CalendarEventInput): Promise<{ id: string }>;
  getEvent(calendarId: string, eventId: string): Promise<{ id: string; status?: string } | null>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

/** uuid -> id de evento aceito pelo Google (hex já é subconjunto do alfabeto base32hex a–v, 0–9). */
export function eventIdFromUuid(uuid: string): string {
  return 'air' + uuid.replace(/-/g, '').toLowerCase();
}
