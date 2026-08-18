import Anthropic from '@anthropic-ai/sdk';
import {
  ModelOutputError,
  ProviderUnavailableError,
  type EmbedResult,
  type GenerateInput,
  type GenerateResult,
  type GenerateStopReason,
  type ModelEffort,
  type ModelMessage,
  type ModelToolCall,
  type ScalarModelProvider,
  type StructuredOutputInput,
  type StructuredOutputResult,
} from '../provider.js';

/** Anthropic's most capable generally available model. Override per deployment if needed. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

const DEFAULT_MAX_TOKENS = 8192;

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  /** Default max output tokens. Thinking counts against this, so leave room. */
  maxTokens?: number;
  /** Injected for tests. */
  client?: Anthropic;
}

type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
type MessageParam = Anthropic.Messages.MessageParam;

/** Converts Scalar's transcript into the Messages API shape. */
export function toAnthropicMessages(messages: ModelMessage[]): MessageParam[] {
  return messages.map((message): MessageParam => {
    if (message.role === 'user') {
      return { role: 'user', content: message.content };
    }
    if (message.role === 'assistant') {
      const blocks: ContentBlockParam[] = [];
      if (message.text.trim().length > 0) blocks.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.input as Record<string, unknown>,
        });
      }
      return { role: 'assistant', content: blocks };
    }
    return {
      role: 'user',
      content: message.results.map((result): ContentBlockParam => ({
        type: 'tool_result',
        tool_use_id: result.toolCallId,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      })),
    };
  });
}

function mapStopReason(raw: string | null): GenerateStopReason {
  switch (raw) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

function effortConfig(effort: ModelEffort | undefined): { effort: ModelEffort } | undefined {
  return effort ? { effort } : undefined;
}

function wrapError(error: unknown, context: string): Error {
  if (
    error instanceof Anthropic.APIConnectionError ||
    error instanceof Anthropic.APIConnectionTimeoutError
  ) {
    return new ProviderUnavailableError(`${context}: could not reach the model provider`, {
      cause: error,
    });
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new ProviderUnavailableError(`${context}: the model provider rejected the API key`, {
      cause: error,
    });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderUnavailableError(
      `${context}: the model provider is rate limiting requests`,
      { cause: error },
    );
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new ProviderUnavailableError(`${context}: the model provider returned a server error`, {
      cause: error,
    });
  }
  return error instanceof Error ? error : new Error(`${context}: ${String(error)}`);
}

/**
 * Anthropic implementation. Thinking is adaptive (the model decides how much to think) and depth is
 * steered with `effort`; sampling parameters are not sent because current models reject them.
 */
export class AnthropicProvider implements ScalarModelProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: AnthropicProviderOptions) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    let response: Anthropic.Messages.Message;
    try {
      const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
        model: this.model,
        max_tokens: input.maxTokens ?? this.maxTokens,
        system: input.system,
        messages: toAnthropicMessages(input.messages),
      };
      if (input.tools && input.tools.length > 0) {
        params.tools = input.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Messages.Tool.InputSchema,
        }));
      }
      const effort = effortConfig(input.effort);
      if (effort) params.output_config = effort;
      response = await this.client.messages.create(
        params,
        input.signal ? { signal: input.signal } : {},
      );
    } catch (error) {
      throw wrapError(error, 'generate');
    }

    const stopReason = mapStopReason(response.stop_reason);
    let text = '';
    const toolCalls: ModelToolCall[] = [];
    // A refusal can arrive with empty or partial content, so read blocks defensively.
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
      }
    }

    return {
      text,
      toolCalls,
      stopReason,
      ...(stopReason === 'refusal'
        ? {
            refusal: {
              category: response.stop_details?.category ?? null,
              explanation: response.stop_details?.explanation ?? null,
            },
          }
        : {}),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      model: response.model,
    };
  }

  async *stream(input: GenerateInput): AsyncIterable<string> {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: input.maxTokens ?? this.maxTokens,
      system: input.system,
      messages: toAnthropicMessages(input.messages),
    };
    const effort = effortConfig(input.effort);
    if (effort) params.output_config = effort;
    const stream = this.client.messages.stream(
      params,
      input.signal ? { signal: input.signal } : {},
    );
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield event.delta.text;
        }
      }
    } catch (error) {
      throw wrapError(error, 'stream');
    }
  }

  async structuredOutput<T>(input: StructuredOutputInput<T>): Promise<StructuredOutputResult<T>> {
    let response: Anthropic.Messages.Message;
    try {
      response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: input.maxTokens ?? this.maxTokens,
          system: input.system,
          messages: toAnthropicMessages(input.messages),
          output_config: {
            ...effortConfig(input.effort),
            format: { type: 'json_schema', schema: input.schema },
          },
        },
        input.signal ? { signal: input.signal } : {},
      );
    } catch (error) {
      throw wrapError(error, 'structuredOutput');
    }

    if (response.stop_reason === 'refusal') {
      throw new ModelOutputError('The model declined this request.');
    }
    const text = response.content.find((block) => block.type === 'text')?.text;
    if (!text) throw new ModelOutputError('The model returned no structured output.');

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
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        model: response.model,
      };
    } catch (error) {
      throw new ModelOutputError('The model output did not match the expected schema.', {
        cause: error,
      });
    }
  }

  embed(): Promise<EmbedResult> {
    // Anthropic does not offer an embeddings endpoint. Semantic search will use a dedicated
    // provider when it lands; deterministic search does not need this today.
    return Promise.reject(
      new ProviderUnavailableError('The Anthropic provider does not support embeddings.'),
    );
  }
}
