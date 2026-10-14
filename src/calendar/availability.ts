import type { BusinessHours } from '../tenant/context.js';
import type { Interval } from './provider.js';
import { weekdayOf, zonedToUtc } from './time.js';

export interface SlotQuery {
  date: string; // YYYY-MM-DD no fuso da empresa
  durationMin: number;
  stepMin: number;
  timezone: string;
  hours: BusinessHours;
  busy: Interval[];
  notBefore: Date; // agora + antecedência mínima
  partOfDay?: 'morning' | 'afternoon' | 'evening' | 'any';
}

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/** Gera horários livres para um recurso num dia, respeitando expediente, duração e ocupação. */
export function freeSlots(q: SlotQuery): Interval[] {
  const ranges = q.hours[weekdayOf(q.date)] ?? [];
  const out: Interval[] = [];
  for (const [open, close] of ranges) {
    const openAt = zonedToUtc(q.date, open, q.timezone);
    const closeAt = zonedToUtc(q.date, close, q.timezone);
    for (let t = openAt.getTime(); t + q.durationMin * 60_000 <= closeAt.getTime(); t += q.stepMin * 60_000) {
      const slot = { start: new Date(t), end: new Date(t + q.durationMin * 60_000) };
      if (slot.start < q.notBefore) continue;
      if (q.busy.some((b) => overlaps(slot, b))) continue;
      if (!inPartOfDay(slot.start, q)) continue;
      out.push(slot);
    }
  }
  return out;
}

function inPartOfDay(start: Date, q: SlotQuery): boolean {
  if (!q.partOfDay || q.partOfDay === 'any') return true;
  const noon = zonedToUtc(q.date, '12:00', q.timezone);
  const evening = zonedToUtc(q.date, '18:00', q.timezone);
  if (q.partOfDay === 'morning') return start < noon;
  if (q.partOfDay === 'afternoon') return start >= noon && start < evening;
  return start >= evening;
}

/** Verifica se um intervalo cabe inteiramente dentro do expediente do dia. */
export function withinBusinessHours(slot: Interval, date: string, tz: string, hours: BusinessHours): boolean {
  return (hours[weekdayOf(date)] ?? []).some(([o, c]) => {
    return slot.start >= zonedToUtc(date, o, tz) && slot.end <= zonedToUtc(date, c, tz);
  });
}
