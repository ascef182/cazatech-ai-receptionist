import { z } from 'zod';
import type { BookingService, Scope } from '../calendar/booking-service.js';
import type { ToolDefinition } from './llm.js';

export const HANDOFF_REASONS = ['customer_requested', 'complaint', 'health_or_sensitive', 'out_of_scope', 'booking_problem', 'uncertain', 'other'] as const;

/**
 * Contrato de cada ferramenta: schema de entrada (zod) é a fonte única para
 * (1) o JSON Schema enviado ao modelo e (2) a validação dos argumentos que o modelo devolve.
 * tenant, contato e conversa NUNCA vêm do modelo: são injetados a partir do contexto do job.
 */
export const ToolSchemas = {
  get_business_info: z.object({}).strict(),
  list_services: z.object({}).strict(),
  check_availability: z
    .object({
      service_id: z.uuid().describe('id retornado por list_services'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('data no formato AAAA-MM-DD, no fuso da empresa'),
      part_of_day: z.enum(['morning', 'afternoon', 'evening', 'any']).optional(),
    })
    .strict(),
  propose_booking: z
    .object({
      slot_code: z.string().regex(/^[A-Za-z0-9]{4,8}$/).describe('código retornado por check_availability'),
      customer_name: z.string().min(2).max(80).describe('nome informado pelo próprio cliente'),
    })
    .strict(),
  list_my_bookings: z.object({}).strict(),
  propose_reschedule: z.object({ booking_id: z.uuid(), slot_code: z.string().regex(/^[A-Za-z0-9]{4,8}$/) }).strict(),
  propose_cancellation: z.object({ booking_id: z.uuid() }).strict(),
  confirm_proposal: z.object({ proposal_id: z.uuid() }).strict(),
  handoff_to_human: z
    .object({ reason: z.enum(HANDOFF_REASONS), note: z.string().max(300).optional().describe('resumo curto para a equipe, sem dados sensíveis') })
    .strict(),
} as const;

export type ToolName = keyof typeof ToolSchemas;

const DESCRIPTIONS: Record<ToolName, string> = {
  get_business_info: 'Retorna informações aprovadas pela empresa: endereço, horário de funcionamento, formas de pagamento e políticas. Use antes de responder sobre esses assuntos.',
  list_services: 'Lista os serviços ativos com id, duração e preço aprovado. Nunca informe preços que não venham daqui.',
  check_availability: 'Consulta horários livres de um serviço em uma data. Retorna códigos de horário (slot_code) válidos por 30 minutos.',
  propose_booking: 'Cria uma proposta de agendamento a partir de um slot_code. NÃO agenda: depois apresente o resumo e peça confirmação explícita ao cliente.',
  list_my_bookings: 'Lista os próximos agendamentos confirmados deste cliente.',
  propose_reschedule: 'Cria proposta de remarcação de uma reserva do cliente para um novo slot_code. Exige confirmação do cliente.',
  propose_cancellation: 'Cria proposta de cancelamento de uma reserva do cliente. Exige confirmação do cliente.',
  confirm_proposal: 'Executa uma proposta SOMENTE depois que o cliente confirmou explicitamente na mensagem mais recente. Só diga que está agendado se o resultado vier com ok=true.',
  handoff_to_human: 'Transfere a conversa para a equipe humana. Depois disso o assistente para de responder nesta conversa.',
};

const BOOKING_TOOLS: ToolName[] = ['check_availability', 'propose_booking', 'list_my_bookings', 'propose_reschedule', 'propose_cancellation', 'confirm_proposal'];

export function toolDefinitions(opts: { bookingEnabled: boolean }): ToolDefinition[] {
  return (Object.keys(ToolSchemas) as ToolName[])
    .filter((n) => opts.bookingEnabled || !BOOKING_TOOLS.includes(n))
    .map((name) => {
      const schema = z.toJSONSchema(ToolSchemas[name]) as Record<string, unknown>;
      delete schema.$schema;
      return { name, description: DESCRIPTIONS[name], input_schema: schema };
    });
}

export interface ToolContext {
  scope: Scope;
  booking: BookingService;
  onHandoff(reason: string, note?: string): Promise<void>;
}

export interface ToolExecution {
  content: string;
  isError: boolean;
  handoff?: boolean;
}

export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext, allowed: Set<string>): Promise<ToolExecution> {
  if (!allowed.has(name)) return { content: JSON.stringify({ ok: false, error: 'tool_not_available' }), isError: true };
  const schema = ToolSchemas[name as ToolName];
  const parsed = schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      content: JSON.stringify({ ok: false, error: 'invalid_arguments', details: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) }),
      isError: true,
    };
  }
  const input = parsed.data as any;
  const t = ctx.scope.tenant;
  let out: unknown;
  switch (name as ToolName) {
    case 'get_business_info':
      out = { ok: true, name: t.name, timezone: t.timezone, business_hours: t.settings.business_hours, info: t.settings.business_info };
      break;
    case 'list_services':
      out = { ok: true, services: t.services.map((s) => ({ service_id: s.id, name: s.name, duration_min: s.duration_min, price: s.price_text ?? 'consultar a equipe' })) };
      break;
    case 'check_availability':
      out = await ctx.booking.checkAvailability(ctx.scope, input);
      break;
    case 'propose_booking':
      out = await ctx.booking.proposeCreate(ctx.scope, input);
      break;
    case 'list_my_bookings':
      out = await ctx.booking.listUpcoming(ctx.scope);
      break;
    case 'propose_reschedule':
      out = await ctx.booking.proposeReschedule(ctx.scope, input);
      break;
    case 'propose_cancellation':
      out = await ctx.booking.proposeCancel(ctx.scope, input);
      break;
    case 'confirm_proposal':
      out = await ctx.booking.confirmProposal(ctx.scope, input);
      break;
    case 'handoff_to_human':
      await ctx.onHandoff(input.reason, input.note);
      return { content: JSON.stringify({ ok: true, transferred: true }), isError: false, handoff: true };
  }
  const isError = (out as { ok?: boolean })?.ok === false;
  return { content: JSON.stringify(out), isError };
}
