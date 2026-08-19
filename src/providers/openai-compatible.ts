import {
  ModelOutputError,
  ProviderUnavailableError,
  type EmbedInput,
  type EmbedResult,
  type GenerateInput,
  type GenerateResult,
  type GenerateStopReason,
  type ModelMessage,
  type ModelToolCall,
  type ScalarModelProvider,
  type StructuredOutputInput,
  type StructuredOutputResult,
} from '../provider.js';

/**
 * Anything that speaks the OpenAI chat completions shape.
 *
 * That is OpenAI itself, Ollama, llama.cpp, vLLM, LM Studio, OpenRouter and most things a self
 * hoster is likely to point Scalar at. One implementation covers them because the wire format is
 * the same; what differs is the base URL, whether a key is needed, and how good the model is.
 *
 * Written against `fetch` rather than a vendor SDK on purpose: it is a small amount of JSON, and a
 * dependency that assumes it is talking to OpenAI is the wrong shape for a provider whose whole
 * point is that it might be talking to a laptop.
 */

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 120_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OpenAICompatibleProviderOptions {
  /** Origin of the API, with or without a trailing `/v1`. */
  baseUrl: string;
  model: string;
  /** Omitted for a local server that does not want one. */
  apiKey?: string | undefined;
  /** Reported as the provider name, so logs say `ollama` rather than `openai_compatible`. */
  name?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Injected for tests. */
  fetch?: FetchLike;
}

interface ChatToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatChoice {
  message?: {
    content?: string | null;
    tool_calls?: ChatToolCall[] | null;
    refusal?: string | null;
  };
  finish_reason?: string | null;
}

interface ChatResponse {
  model?: string;
  choices?: ChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface EmbeddingResponse {
  model?: string;
  data?: { embedding?: number[] }[];
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  tools?: {
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }[];
  response_format?: {
    type: 'json_schema';
    json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
  };
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Scalar's transcript in chat completions shape.
 *
 * The difference that matters: Anthropic carries tool results as user content blocks, while this
 * API wants one message per result with the call id on it.
 */
export function toChatMessages(system: string, messages: ModelMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      const assistant: ChatMessage = {
        role: 'assistant',
        content: message.text.length > 0 ? message.text : null,
      };
      if (message.toolCalls.length > 0) {
        assistant.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
        }));
      }
      out.push(assistant);
      continue;
    }
    for (const result of message.results) {
      out.push({ role: 'tool', tool_call_id: result.toolCallId, content: result.content });
    }
  }
  return out;
}

function mapFinishReason(
  raw: string | null | undefined,
  hasToolCalls: boolean,
): GenerateStopReason {
  if (hasToolCalls || raw === 'tool_calls' || raw === 'function_call') return 'tool_use';
  if (raw === 'length') return 'max_tokens';
  if (raw === 'content_filter') return 'refusal';
  return 'end_turn';
}

/** Normalizes `http://host`, `http://host/`, and `http://host/v1` to one form. */
function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export class OpenAICompatibleProvider implements ScalarModelProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.name = options.name ?? 'openai_compatible';
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const globalFetch: FetchLike | undefined =
      typeof globalThis.fetch === 'function'
        ? (url, init) => globalThis.fetch(url, init)
        : undefined;
    const resolved = options.fetch ?? globalFetch;
    if (!resolved) throw new Error('No fetch implementation available for the model provider.');
    this.fetchImpl = resolved;
  }

  /**
   * One place where every provider failure becomes a `ProviderUnavailableError`.
   *
   * The caller's contract is that an unreachable or unhappy provider is a 503 and the rest of
   * Scalar keeps working, so a local server that is simply not running has to look the same as a
   * hosted one that is rate limiting.
   */
  private async post<T>(path: string, body: unknown, signal: AbortSignal | undefined): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    signal?.addEventListener('abort', () => {
      controller.abort();
    });

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ProviderUnavailableError(`Could not reach the model provider at ${this.baseUrl}.`, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const trimmed = detail.slice(0, 500);
      if (response.status === 401 || response.status === 403) {
        throw new ProviderUnavailableError('The model provider rejected the API key.');
      }
      if (response.status === 429) {
        throw new ProviderUnavailableError('The model provider is rate limiting requests.');
      }
      if (response.status === 404) {
        throw new ProviderUnavailableError(
          `The model provider has no ${this.model} at ${this.baseUrl}. Check AI_MODEL and AI_BASE_URL.`,
        );
      }
      if (response.status >= 500) {
        throw new ProviderUnavailableError('The model provider returned a server error.');
      }
      throw new ProviderUnavailableError(
        `The model provider refused the request (${String(response.status)}). ${trimmed}`,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new ModelOutputError('The model provider returned a response that is not JSON.', {
        cause: error,
      });
    }
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const body: ChatRequest = {
      model: this.model,
      messages: toChatMessages(input.system, input.messages),
      max_tokens: input.maxTokens ?? this.maxTokens,
    };
    if (input.tools && input.tools.length > 0) {
      body.tools = input.tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }

    const response = await this.post<ChatResponse>('/chat/completions', body, input.signal);
    const choice = response.choices?.[0];
    const rawCalls = choice?.message?.tool_calls ?? [];

    const toolCalls: ModelToolCall[] = [];
    for (const call of rawCalls) {
      const name = call.function?.name;
      if (!name) continue;
      let parsed: unknown = {};
      const args = call.function?.arguments;
      if (args && args.trim().length > 0) {
        try {
          parsed = JSON.parse(args);
        } catch {
          // A model that emits unparseable arguments has failed this call, not the whole turn.
          // Tool input is validated downstream anyway, and an empty object fails that validation
          // with a message the model can act on.
          parsed = {};
        }
      }
      toolCalls.push({ id: call.id ?? name, name, input: parsed });
    }

    const refusal = choice?.message?.refusal;
    const stopReason = refusal
      ? 'refusal'
      : mapFinishReason(choice?.finish_reason, toolCalls.length > 0);

    return {
      text: choice?.message?.content ?? '',
      toolCalls,
      stopReason,
      ...(stopReason === 'refusal'
        ? { refusal: { category: null, explanation: refusal ?? null } }
        : {}),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model ?? this.model,
    };
  }

  /**
   * Structured output through `response_format: json_schema`.
   *
   * Servers that do not implement it tend to fall back to plain JSON rather than erroring, so the
   * result is parsed and validated regardless. A local model that produces prose here fails with
   * a clear message instead of quietly returning something wrong.
   */
  async structuredOutput<T>(input: StructuredOutputInput<T>): Promise<StructuredOutputResult<T>> {
    const response = await this.post<ChatResponse>(
      '/chat/completions',
      {
        model: this.model,
        messages: toChatMessages(input.system, input.messages),
        max_tokens: input.maxTokens ?? this.maxTokens,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'scalar_response', strict: true, schema: input.schema },
        },
      },
      input.signal,
    );

    const choice = response.choices?.[0];
    if (choice?.message?.refusal) {
      throw new ModelOutputError('The model declined this request.');
    }
    const text = choice?.message?.content;
    if (!text || text.trim().length === 0) {
      throw new ModelOutputError('The model returned no structured output.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ModelOutputError('The model returned output that is not valid JSON.', {
        cause: error,
      });
    }

    try {
      return {
        value: input.parse(parsed),
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
        model: response.model ?? this.model,
      };
    } catch (error) {
      throw new ModelOutputError('The model output did not match the expected schema.', {
        cause: error,
      });
    }
  }

  async embed(input: EmbedInput): Promise<EmbedResult> {
    const response = await this.post<EmbeddingResponse>(
      '/embeddings',
      { model: this.model, input: input.texts },
      input.signal,
    );
    const vectors = (response.data ?? []).map((entry) => entry.embedding ?? []);
    if (vectors.length !== input.texts.length) {
      throw new ModelOutputError('The model provider returned the wrong number of embeddings.');
    }
    return { vectors, model: response.model ?? this.model };
  }
}
