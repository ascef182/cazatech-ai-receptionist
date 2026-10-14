// Conversões de fuso horário com Intl (sem dependência externa).

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
}

export function toLocalParts(d: Date, tz: string): LocalParts {
  const parts = Object.fromEntries(dtf(tz).formatToParts(d).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: String(parts.weekday).toLowerCase().slice(0, 3) as LocalParts['weekday'],
  };
}

function offsetMs(d: Date, tz: string): number {
  const p = toLocalParts(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** "2026-10-14" + "15:30" no fuso tz -> instante UTC. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, mo, da] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  let ts = guess - offsetMs(new Date(guess), tz);
  // segunda passada cobre mudanças de offset (horário de verão)
  ts = guess - offsetMs(new Date(ts), tz);
  return new Date(ts);
}

export function localDateString(d: Date, tz: string): string {
  const p = toLocalParts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function formatLocal(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): LocalParts['weekday'] {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const)[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}
