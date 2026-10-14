import { describe, expect, it } from 'vitest';
import { runAgent, type AgentLimits } from '../../src/ai/agent.js';
import { ScriptedLlm, llmText, llmTool, AnthropicClient } from '../../src/ai/llm.js';
import { toolDefinitions, ToolSchemas } from '../../src/ai/tools.js';
import { silentLog } from '../helpers/setup.js';
import type { TenantContext } from '../../src/tenant/context.js';

const tenant: TenantContext = {
  id: 't1',
  name: 'Studio Teste',
  timezone: 'America/Sao_Paulo',
  status: 'active',
  settings: {
    ai_enabled: true,
    booking_enabled: true,
    voice_reply_enabled: false,
    business_info: { address: 'Rua A, 1' },
    business_hours: {},
    slot_step_minutes: 30,
    min_notice_minutes: 60,
    booking_horizon_days: 30,
    daily_llm_budget_micros: 1_000_000,
    max_audio_seconds: 120,
    message_retention_days: 90,
    handoff_webhook_url: null,
  },
  services: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Corte', duration_min: 60, price_text: 'R$ 90' }],
  resources: [],
  channel: { phoneNumberId: 'pn', accessToken: 'x' },
};

const limits: AgentLimits = {
  maxIterations: 4,
  runTimeoutMs: 2_000,
  maxOutputTokens: 300,
  toolTimeoutMs: 1_000,
  remainingBudgetMicros: 1_000_000,
  inputMicrosPerMTok: 2_000_000,
  outputMicrosPerMTok: 10_000_000,
};

function tools(onHandoff: (reason: string, note?: string) => Promise<void> = async () => {}) {
  const booking = new Proxy({}, { get: () => async () => ({ ok: true }) }) as any;
  return { scope: { tenant, conversationId: 'c', contactId: 'k' }, booking, onHandoff };
}

describe('contratos das ferramentas', () => {
  it('gera JSON Schema para cada ferramenta e esconde as de agenda quando não autorizado', () => {
    const all = toolDefinitions({ bookingEnabled: true }).map((t) => t.name);
    const limited = toolDefinitions({ bookingEnabled: false }).map((t) => t.name);
    expect(all).toContain('confirm_proposal');
    expect(limited).toEqual(['get_business_info', 'list_services', 'handoff_to_human']);
    const cs = toolDefinitions({ bookingEnabled: true }).find((t) => t.name === 'check_availability')!;
    expect(cs.input_schema).toMatchObject({ type: 'object', required: ['service_id', 'date'], additionalProperties: false });
  });
  it('rejeita argumentos extras (ex.: tentar passar tenant_id)', () => {
    expect(ToolSchemas.list_my_bookings.safeParse({ tenant_id: 'outro' }).success).toBe(false);
    expect(ToolSchemas.check_availability.safeParse({ service_id: 'x', date: 'amanhã' }).success).toBe(false);
  });
});

describe('laço do agente', () => {
  it('executa ferramenta e devolve a resposta final', async () => {
    const llm = new ScriptedLlm([llmTool('list_services', {}), llmText('O corte custa R$ 90.')]);
    const r = await runAgent({ llm, system: 's', history: [{ role: 'user', content: 'preço?' }], bookingEnabled: true, tools: tools(), limits, log: silentLog });
    expect(r.outcome).toBe('reply');
    expect(r.reply).toBe('O corte custa R$ 90.');
    expect(r.toolCalls).toEqual([{ name: 'list_services', isError: false }]);
    // resultado da ferramenta volta como primeiro bloco da mensagem seguinte
    const second = llm.calls[1]!.messages.at(-1)!;
    expect((second.content as any[])[0].type).toBe('tool_result');
    expect(JSON.parse((second.content as any[])[0].content).services[0].price).toBe('R$ 90');
  });

  it('argumentos inválidos voltam como erro de ferramenta e o modelo pode corrigir', async () => {
    const llm = new ScriptedLlm([llmTool('check_availability', { service_id: 'nao-e-uuid', date: 'amanhã' }), llmText('Qual dia você prefere?')]);
    const r = await runAgent({ llm, system: 's', history: [{ role: 'user', content: 'oi' }], bookingEnabled: true, tools: tools(), limits, log: silentLog });
    expect(r.toolCalls[0]).toEqual({ name: 'check_availability', isError: true });
    const tr = (llm.calls[1]!.messages.at(-1)!.content as any[])[0];
    expect(tr.is_error).toBe(true);
    expect(tr.content).toMatch(/invalid_arguments/);
  });

  it('ferramenta não autorizada não é executada', async () => {
    const llm = new ScriptedLlm([llmTool('confirm_proposal', { proposal_id: '11111111-1111-4111-8111-111111111111' }), llmText('ok')]);
    const r = await runAgent({ llm, system: 's', history: [{ role: 'user', content: 'oi' }], bookingEnabled: false, tools: tools(), limits, log: silentLog });
    expect(r.toolCalls[0]).toEqual({ name: 'confirm_proposal', isError: true });
  });

  it('para no limite de iterações', async () => {
    const llm = new ScriptedLlm(Array.from({ length: 10 }, () => llmTool('list_services', {})));
    const r = await runAgent({ llm, system: 's', history: [{ role: 'user', content: 'oi' }], bookingEnabled: true, tools: tools(), limits, log: silentLog });
    expect(r.outcome).toBe('limit_iterations');
    expect(llm.calls).toHaveLength(4);
  });

  it('para no limite de custo', async () => {
    const llm = new ScriptedLlm(Array.from({ length: 10 }, () => ({ ...llmTool('list_services', {}), usage: { inputTokens: 200_000, outputTokens: 0 } })));
    const r = await runAgent({
      llm,
      system: 's',
      history: [{ role: 'user', content: 'oi' }],
      bookingEnabled: true,
      tools: tools(),
      limits: { ...limits, remainingBudgetMicros: 500_000 },
      log: silentLog,
    });
    expect(r.outcome).toBe('limit_budget');
    expect(r.usage.costMicros).toBeGreaterThanOrEqual(500_000);
    expect(llm.calls.length).toBeLessThan(4);
  });

  it('para no limite de tempo', async () => {
    const llm = new ScriptedLlm([
      (req) =>
        new Promise((_, rej) => {
          req.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    ]);
    const r = await runAgent({ llm, system: 's', history: [{ role: 'user', content: 'oi' }], bookingEnabled: true, tools: tools(), limits: { ...limits, runTimeoutMs: 100 }, log: silentLog });
    expect(r.outcome).toBe('limit_time');
  });

  it('handoff pela ferramenta encerra com outcome handoff', async () => {
    let called = '';
    const llm = new ScriptedLlm([llmTool('handoff_to_human', { reason: 'complaint' }), llmText('Vou chamar a equipe.')]);
    const r = await runAgent({
      llm,
      system: 's',
      history: [{ role: 'user', content: 'quero reclamar' }],
      bookingEnabled: true,
      tools: tools(async (reason: string) => {
        called = reason;
      }),
      limits,
      log: silentLog,
    });
    expect(r.outcome).toBe('handoff');
    expect(called).toBe('complaint');
  });
});

describe('cliente Anthropic', () => {
  it('monta a requisição da Messages API com cabeçalhos e ferramentas', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'oi' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 }, model: 'm' }),
        { status: 200 },
      );
    }) as any;
    const c = new AnthropicClient('key-123', 'claude-sonnet-5-5', 'https://api.anthropic.com', '2023-06-01', 1000, fetchImpl);
    const r = await c.complete({ system: 'sys', messages: [{ role: 'user', content: 'oi' }], tools: toolDefinitions({ bookingEnabled: false }), maxTokens: 100 });
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(captured!.url).toBe('https://api.anthropic.com/v1/messages');
    const h = captured!.init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('key-123');
    expect(h['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(captured!.init.body as string);
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 100, system: 'sys' });
    expect(body.tool_choice).toBeUndefined();
    expect(body.tools.map((t: any) => t.name)).toEqual(['get_business_info', 'list_services', 'handoff_to_human']);
  });

  it('erro 529/5xx é classificado como temporário', async () => {
    const c = new AnthropicClient('k', 'm', 'https://api.anthropic.com', '2023-06-01', 1000, (async () => new Response('overloaded', { status: 529 })) as any);
    const { isRetryable } = await import('../../src/lib/errors.js');
    const err = await c.complete({ system: '', messages: [], tools: [], maxTokens: 1 }).then(() => null, (e) => e);
    expect(err).not.toBeNull();
    expect(isRetryable(err)).toBe(true);
  });
});
