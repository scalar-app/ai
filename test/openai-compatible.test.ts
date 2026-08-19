import { describe, expect, it, vi } from 'vitest';
import {
  ModelOutputError,
  ProviderUnavailableError,
  createModelProvider,
  OpenAICompatibleProvider,
  ProviderConfigurationError,
  toChatMessages,
  type ModelMessage,
} from '../src/index.js';

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

function mockFetch(responder: (call: Recorded) => Response) {
  const calls: Recorded[] = [];
  const fetchImpl: Fetcher = vi.fn((url: string, init?: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(responder(call));
  });
  return { fetchImpl, calls };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface SentBody {
  tools?: unknown;
  response_format?: unknown;
}

function sent(call: Recorded | undefined): SentBody {
  return JSON.parse(typeof call?.init?.body === 'string' ? call.init.body : '{}') as SentBody;
}

function chatResponse(over: Record<string, unknown> = {}) {
  return {
    model: 'test-model',
    choices: [{ message: { content: 'Hello.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
    ...over,
  };
}

function provider(fetchImpl: Fetcher, baseUrl = 'http://localhost:11434') {
  return new OpenAICompatibleProvider({
    baseUrl,
    model: 'test-model',
    apiKey: 'secret',
    fetch: fetchImpl,
  });
}

describe('toChatMessages', () => {
  it('puts the system prompt first and one message per tool result', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'What is due tomorrow?' },
      {
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'call_1', name: 'search_tasks', input: { limit: 5 } }],
      },
      { role: 'tool', results: [{ toolCallId: 'call_1', content: '[]' }] },
    ];

    const chat = toChatMessages('You are Scalar.', messages);

    expect(chat[0]).toEqual({ role: 'system', content: 'You are Scalar.' });
    expect(chat[2]).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_tasks' } }],
    });
    // Tool results are their own messages here, unlike Anthropic's user content blocks.
    expect(chat[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '[]' });
  });
});

describe('OpenAICompatibleProvider', () => {
  it('normalizes the base URL, so with or without /v1 both work', async () => {
    const withSuffix = mockFetch(() => json(chatResponse()));
    await provider(withSuffix.fetchImpl, 'http://localhost:11434/v1/').generate({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(withSuffix.calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions');

    const without = mockFetch(() => json(chatResponse()));
    await provider(without.fetchImpl, 'http://localhost:11434').generate({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(without.calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('sends tools in function shape and reads tool calls back', async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      json(
        chatResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'search_tasks', arguments: '{"limit":5}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      ),
    );

    const result = await provider(fetchImpl).generate({
      system: 's',
      messages: [{ role: 'user', content: 'what is due?' }],
      tools: [
        {
          name: 'search_tasks',
          description: 'Search tasks',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    expect(sent(calls[0]).tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'search_tasks',
          description: 'Search tasks',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'search_tasks', input: { limit: 5 } }]);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
  });

  it('survives a model that emits unparseable tool arguments', async () => {
    const { fetchImpl } = mockFetch(() =>
      json(
        chatResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: 'c1', function: { name: 'search_tasks', arguments: 'not json at all' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      ),
    );

    const result = await provider(fetchImpl).generate({
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
    });

    // Empty input rather than a thrown turn: tool input is validated downstream, and that
    // validation gives the model something it can act on.
    expect(result.toolCalls[0]).toEqual({ id: 'c1', name: 'search_tasks', input: {} });
  });

  it('maps finish reasons and refusals', async () => {
    const truncated = mockFetch(() =>
      json(
        chatResponse({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }),
      ),
    );
    const result = await provider(truncated.fetchImpl).generate({
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(result.stopReason).toBe('max_tokens');

    const refused = mockFetch(() =>
      json(
        chatResponse({
          choices: [{ message: { content: null, refusal: 'No.' }, finish_reason: 'stop' }],
        }),
      ),
    );
    const refusal = await provider(refused.fetchImpl).generate({
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(refusal.stopReason).toBe('refusal');
    expect(refusal.refusal?.explanation).toBe('No.');
  });

  it('sends no authorization header when there is no key, for a local server', async () => {
    const { fetchImpl, calls } = mockFetch(() => json(chatResponse()));
    const local = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      fetch: fetchImpl,
    });

    await local.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] });

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('authorization');
  });

  it('turns every provider failure into something the API can answer 503 with', async () => {
    const unreachable = mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(
      provider(unreachable.fetchImpl).generate({ system: 's', messages: [] }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    for (const status of [401, 429, 500]) {
      const failing = mockFetch(() => json({ error: 'nope' }, status));
      await expect(
        provider(failing.fetchImpl).generate({ system: 's', messages: [] }),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
    }
  });

  it('says which setting is wrong when the model is not there', async () => {
    const { fetchImpl } = mockFetch(() => json({ error: 'model not found' }, 404));
    await expect(provider(fetchImpl).generate({ system: 's', messages: [] })).rejects.toThrow(
      /AI_MODEL/,
    );
  });

  it('parses and validates structured output', async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      json(chatResponse({ choices: [{ message: { content: '{"title":"Read"}' } }] })),
    );

    const result = await provider(fetchImpl).structuredOutput<{ title: string }>({
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      schema: { type: 'object', properties: { title: { type: 'string' } } },
      parse: (value) => value as { title: string },
    });

    expect(sent(calls[0]).response_format).toMatchObject({ type: 'json_schema' });
    expect(result.value).toEqual({ title: 'Read' });
  });

  it('rejects structured output that is prose rather than JSON', async () => {
    const { fetchImpl } = mockFetch(() =>
      json(chatResponse({ choices: [{ message: { content: 'Sure! Here you go:' } }] })),
    );

    await expect(
      provider(fetchImpl).structuredOutput({
        system: 's',
        messages: [],
        schema: { type: 'object' },
        parse: (value) => value,
      }),
    ).rejects.toBeInstanceOf(ModelOutputError);
  });

  it('rejects structured output that does not match the schema', async () => {
    const { fetchImpl } = mockFetch(() =>
      json(chatResponse({ choices: [{ message: { content: '{"wrong":true}' } }] })),
    );

    await expect(
      provider(fetchImpl).structuredOutput({
        system: 's',
        messages: [],
        schema: { type: 'object' },
        parse: () => {
          throw new Error('missing title');
        },
      }),
    ).rejects.toBeInstanceOf(ModelOutputError);
  });

  it('embeds, and refuses a response with the wrong number of vectors', async () => {
    const good = mockFetch(() => json({ model: 'embed', data: [{ embedding: [0.1, 0.2] }] }));
    const result = await provider(good.fetchImpl).embed({ texts: ['one'] });
    expect(result.vectors).toEqual([[0.1, 0.2]]);

    const bad = mockFetch(() => json({ model: 'embed', data: [] }));
    await expect(provider(bad.fetchImpl).embed({ texts: ['one'] })).rejects.toBeInstanceOf(
      ModelOutputError,
    );
  });
});

describe('createModelProvider', () => {
  it('builds each provider', () => {
    expect(createModelProvider({ provider: 'anthropic', apiKey: 'k' }).name).toBe('anthropic');
    expect(createModelProvider({ provider: 'openai', apiKey: 'k' }).name).toBe('openai');
    expect(createModelProvider({ provider: 'ollama' }).name).toBe('ollama');
    expect(
      createModelProvider({
        provider: 'openai_compatible',
        baseUrl: 'http://box:8080',
        model: 'mistral',
      }).name,
    ).toBe('openai_compatible');
  });

  it('needs no key for a local model, because a local model has no key', () => {
    expect(() => createModelProvider({ provider: 'ollama' })).not.toThrow();
  });

  it('says what is missing rather than failing at the first request', () => {
    expect(() => createModelProvider({ provider: 'anthropic' })).toThrow(
      ProviderConfigurationError,
    );
    expect(() => createModelProvider({ provider: 'openai' })).toThrow(/AI_API_KEY/);
    expect(() => createModelProvider({ provider: 'openai_compatible', model: 'm' })).toThrow(
      /AI_BASE_URL/,
    );
    expect(() =>
      createModelProvider({ provider: 'openai_compatible', baseUrl: 'http://box' }),
    ).toThrow(/AI_MODEL/);
  });
});
