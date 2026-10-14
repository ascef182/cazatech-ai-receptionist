import { HttpError } from '../lib/errors.js';
import { httpJson, type FetchLike } from '../lib/http.js';

export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: ToolDefinition[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  content: (TextBlock | ToolUseBlock)[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface LlmClient {
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * Messages API da Anthropic (POST /v1/messages) com ferramentas definidas pelo cliente.
 * Cabeçalhos: x-api-key e anthropic-version. tool_choice fica em "auto" (o padrão quando há ferramentas),
 * que é o modo recomendado pela documentação para os modelos atuais.
 */
export class AnthropicClient implements LlmClient {
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl: string,
    private readonly version: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl?: FetchLike,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await httpJson<{
      content: (TextBlock | ToolUseBlock | { type: string })[];
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
      model: string;
    }>(
      `${this.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': this.version, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: req.messages,
          tools: req.tools,
        }),
      },
      { service: 'anthropic', timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl, signal: req.signal },
    );
    return {
      content: res.content.filter((b): b is TextBlock | ToolUseBlock => b.type === 'text' || b.type === 'tool_use'),
      stopReason: res.stop_reason,
      usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
      model: res.model ?? this.model,
    };
  }
}

/** LLM roteirizado para testes: cada chamada devolve a próxima resposta (ou função) da lista. */
export class ScriptedLlm implements LlmClient {
  readonly model = 'scripted';
  calls: LlmRequest[] = [];
  constructor(private script: (LlmResponse | ((req: LlmRequest) => LlmResponse | Promise<LlmResponse>) | Error)[]) {}

  push(...steps: (LlmResponse | ((req: LlmRequest) => LlmResponse | Promise<LlmResponse>) | Error)[]) {
    this.script.push(...steps);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(structuredClone({ ...req, signal: undefined }));
    const step = this.script.shift();
    if (!step) throw new Error('ScriptedLlm: roteiro esgotado');
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(req) : step;
  }
}

export const llmText = (text: string, usage = { inputTokens: 100, outputTokens: 20 }): LlmResponse => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage,
  model: 'scripted',
});

export const llmTool = (name: string, input: unknown, id = `toolu_${name}_${Math.random().toString(36).slice(2, 8)}`): LlmResponse => ({
  content: [{ type: 'tool_use', id, name, input }],
  stopReason: 'tool_use',
  usage: { inputTokens: 100, outputTokens: 20 },
  model: 'scripted',
});

export function isRetryableLlmError(err: unknown): boolean {
  return err instanceof HttpError && err.retryable;
}

/**
 * LLM de demonstração (LLM_PROVIDER=fake): permite subir a pilha inteira sem chave de API.
 * Responde de forma fixa; não usa ferramentas. Nunca use em produção.
 */
export class DemoLlm implements LlmClient {
  readonly model = 'demo';
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const last = req.messages.at(-1);
    const text = typeof last?.content === 'string' ? last.content : '';
    const clean = text.replace(/<\/?cliente>/g, '').trim().slice(0, 200);
    return llmText(`(modo demonstração) Recebi sua mensagem: "${clean}". Em produção, a IA responderia aqui.`);
  }
}
