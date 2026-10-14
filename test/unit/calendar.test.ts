import { describe, expect, it } from 'vitest';
import { freeSlots, withinBusinessHours } from '../../src/calendar/availability.js';
import { formatLocal, localDateString, zonedToUtc } from '../../src/calendar/time.js';
import { eventIdFromUuid } from '../../src/calendar/provider.js';
import { GoogleCalendarProvider } from '../../src/calendar/google.js';

const hours = { mon: [['09:00', '12:00'] as [string, string], ['13:00', '15:00'] as [string, string]] };

describe('fuso horário', () => {
  it('converte horário local de São Paulo (UTC-3) para UTC', () => {
    expect(zonedToUtc('2026-10-12', '09:00', 'America/Sao_Paulo').toISOString()).toBe('2026-10-12T12:00:00.000Z');
  });
  it('respeita horário de verão em fusos que o adotam', () => {
    expect(zonedToUtc('2026-07-01', '09:00', 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(zonedToUtc('2026-12-01', '09:00', 'America/New_York').toISOString()).toBe('2026-12-01T14:00:00.000Z');
  });
  it('data local muda na virada do dia', () => {
    expect(localDateString(new Date('2026-10-13T02:30:00Z'), 'America/Sao_Paulo')).toBe('2026-10-12');
    expect(formatLocal(new Date('2026-10-12T13:00:00Z'), 'America/Sao_Paulo')).toMatch(/segunda-feira.*10:00/);
  });
});

describe('horários livres', () => {
  const base = { date: '2026-10-12', durationMin: 60, stepMin: 30, timezone: 'America/Sao_Paulo', hours, busy: [], notBefore: new Date('2026-10-12T00:00:00Z') };
  it('gera horários dentro dos turnos sem ultrapassar o fechamento', () => {
    const s = freeSlots(base).map((x) => x.start.toISOString().slice(11, 16));
    // 09:00..11:00 e 13:00..14:00 locais = 12:00..14:00 e 16:00..17:00 UTC
    expect(s).toEqual(['12:00', '12:30', '13:00', '13:30', '14:00', '16:00', '16:30', '17:00']);
  });
  it('remove horários ocupados e respeita antecedência mínima', () => {
    const s = freeSlots({
      ...base,
      busy: [{ start: new Date('2026-10-12T12:30:00Z'), end: new Date('2026-10-12T13:30:00Z') }],
      notBefore: new Date('2026-10-12T12:10:00Z'),
    }).map((x) => x.start.toISOString().slice(11, 16));
    expect(s).toEqual(['13:30', '14:00', '16:00', '16:30', '17:00']);
  });
  it('filtra por período do dia', () => {
    expect(freeSlots({ ...base, partOfDay: 'afternoon' }).every((x) => x.start >= new Date('2026-10-12T15:00:00Z'))).toBe(true);
  });
  it('dia sem expediente não tem horários', () => {
    expect(freeSlots({ ...base, date: '2026-10-11' })).toEqual([]);
  });
  it('valida intervalo dentro do expediente', () => {
    const ok = { start: new Date('2026-10-12T12:00:00Z'), end: new Date('2026-10-12T13:00:00Z') };
    const lunch = { start: new Date('2026-10-12T14:30:00Z'), end: new Date('2026-10-12T15:30:00Z') };
    expect(withinBusinessHours(ok, '2026-10-12', 'America/Sao_Paulo', hours)).toBe(true);
    expect(withinBusinessHours(lunch, '2026-10-12', 'America/Sao_Paulo', hours)).toBe(false);
  });
});

describe('Google Calendar (requisições com fetch simulado)', () => {
  it('id de evento usa apenas caracteres base32hex (a–v, 0–9)', () => {
    const id = eventIdFromUuid('3f2b1c4d-1111-2222-3333-444455556666');
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
  });

  it('freeBusy envia timeMin/timeMax/items e trata erro de agenda como indisponível, sem derrubar as demais', async () => {
    const calls: any[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string), auth: (init.headers as any).Authorization });
      return new Response(JSON.stringify({ calendars: { a: { busy: [{ start: '2026-10-12T12:00:00Z', end: '2026-10-12T13:00:00Z' }] }, b: { errors: [{ reason: 'notFound' }] } } }));
    }) as any;
    const g = new GoogleCalendarProvider(async () => 'tok', fetchImpl);
    const from = new Date('2026-10-12T00:00:00Z');
    const to = new Date('2026-10-13T00:00:00Z');
    const r = await g.busy(['a', 'b'], from, to);
    expect(r.get('a')).toHaveLength(1);
    // agenda com erro: tratada como ocupada durante toda a janela (nunca como livre), sem lançar exceção
    // e sem afetar a resposta da agenda 'a', que funcionou normalmente.
    expect(r.get('b')).toEqual([{ start: from, end: to }]);
    expect(calls[0]).toMatchObject({
      url: 'https://www.googleapis.com/calendar/v3/freeBusy',
      auth: 'Bearer tok',
      body: { timeMin: from.toISOString(), items: [{ id: 'a' }, { id: 'b' }] },
    });
  });

  it('criação repetida com o mesmo id (409) é tratada como sucesso se o evento existe', async () => {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (init.method === 'POST') return new Response('{"error":{"code":409}}', { status: 409 });
      return new Response(JSON.stringify({ id: 'airabc', status: 'confirmed' }));
    }) as any;
    const g = new GoogleCalendarProvider(async () => 'tok', fetchImpl);
    const r = await g.createEvent('cal', { id: 'airabc', summary: 's', start: new Date(), end: new Date(Date.now() + 1), timeZone: 'America/Sao_Paulo' });
    expect(r.id).toBe('airabc');
  });

  it('remoção de evento inexistente (404/410) não é erro', async () => {
    const g = new GoogleCalendarProvider(async () => 'tok', (async () => new Response('', { status: 410 })) as any);
    await expect(g.deleteEvent('cal', 'x')).resolves.toBeUndefined();
  });
});
