import type { Logger } from '../lib/logger.js';
import type { ContentBlock, LlmClient, LlmMessage, ToolUseBlock } from './llm.js';
import { executeTool, toolDefinitions, type ToolContext } from './tools.js';
import { sanitizeReply } from './guardrails.js';

export interface AgentLimits {
  maxIterations: number;
  runTimeoutMs: number;
  maxOutputTokens: number;
  toolTimeoutMs: number;
  /** orçamento restante do dia, em micro-dólares; a execução para se for ultrapassado */
  remainingBudgetMicros: number;
  inputMicrosPerMTok: number;
  outputMicrosPerMTok: number;
}

export interface AgentResult {
  outcome: 'reply' | 'handoff' | 'limit_iterations' | 'limit_time' | 'limit_budget' | 'error';
  reply: string | null;
  iterations: number;
  usage: { inputTokens: number; outputTokens: number; costMicros: number };
  toolCalls: { name: string; isError: boolean }[];
  error?: string;
}

export async function runAgent(params: {
  llm: LlmClient;
  system: string;
  history: LlmMessage[];
  bookingEnabled: boolean;
  tools: ToolContext;
  limits: AgentLimits;
  log: Logger;
}): Promise<AgentResult> {
  const { llm, limits, log } = params;
  const defs = toolDefinitions({ bookingEnabled: params.bookingEnabled });
  const allowed = new Set(defs.map((d) => d.name));
  const messages: LlmMessage[] = [...params.history];
  const usage = { inputTokens: 0, outputTokens: 0, costMicros: 0 };
  const toolCalls: AgentResult['toolCalls'] = [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), limits.runTimeoutMs);
  let handoff = false;

  const result = (outcome: AgentResult['outcome'], reply: string | null, iterations: number, error?: string): AgentResult => ({
    outcome,
    reply,
    iterations,
    usage,
    toolCalls,
    error,
  });

  try {
    for (let i = 1; i <= limits.maxIterations; i++) {
      if (usage.costMicros >= limits.remainingBudgetMicros) return result('limit_budget', null, i - 1);
      let res;
      try {
        res = await llm.complete({ system: params.system, messages, tools: defs, maxTokens: limits.maxOutputTokens, signal: ctrl.signal });
      } catch (err) {
        if (ctrl.signal.aborted) return result('limit_time', null, i - 1);
        throw err;
      }
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      usage.costMicros = Math.ceil(
        (usage.inputTokens * limits.inputMicrosPerMTok + usage.outputTokens * limits.outputMicrosPerMTok) / 1_000_000,
      );

      const toolUses = res.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      const text = res.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n')
        .trim();

      if (toolUses.length === 0) {
        if (handoff) return result('handoff', text ? sanitizeReply(text) : null, i);
        if (!text) return result('error', null, i, 'resposta vazia do modelo');
        return result('reply', sanitizeReply(text), i);
      }

      messages.push({ role: 'assistant', content: res.content as ContentBlock[] });
      const results: ContentBlock[] = [];
      for (const tu of toolUses) {
        let exec;
        try {
          exec = await withDeadline(executeTool(tu.name, tu.input, params.tools, allowed), limits.toolTimeoutMs, ctrl.signal);
        } catch (err) {
          log.warn({ tool: tu.name, err: (err as Error).message }, 'ferramenta falhou');
          exec = { content: JSON.stringify({ ok: false, error: 'tool_failed', message: 'Falha temporária. Não confirme nada ao cliente.' }), isError: true };
        }
        if (exec.handoff) handoff = true;
        toolCalls.push({ name: tu.name, isError: exec.isError });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: exec.content, ...(exec.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
    return result(handoff ? 'handoff' : 'limit_iterations', null, limits.maxIterations);
  } finally {
    clearTimeout(timer);
  }
}

async function withDeadline<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error('tempo limite da ferramenta')), ms);
      signal.addEventListener('abort', () => rej(new Error('execução abortada')), { once: true });
    }),
  ]).finally(() => clearTimeout(timer));
}
