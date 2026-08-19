import type { ScalarModelProvider } from '../provider.js';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

/**
 * Which vendor a Scalar installation talks to.
 *
 * `openai` and `ollama` are the same wire format with different defaults; they are separate names
 * because "AI_PROVIDER=ollama" is what a self hoster means, and making them work out the base URL
 * for a local Ollama is the difference between one env var and three.
 */
export const AI_PROVIDERS = ['anthropic', 'openai', 'openai_compatible', 'ollama'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-5';
export const DEFAULT_OLLAMA_MODEL = 'llama3.1';

export interface ModelProviderConfig {
  provider: AiProviderName;
  model?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
}

/** Raised for configuration that cannot produce a working provider. */
export class ProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigurationError';
  }
}

export function isAiProviderName(value: string): value is AiProviderName {
  return (AI_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Builds the configured provider, or explains what is missing.
 *
 * The rule this encodes: a hosted provider needs a key, a local one does not. Ollama running on
 * the same machine has no authentication to speak of, and demanding a key for it would make the
 * simplest self hosted setup the most annoying one.
 */
export function createModelProvider(config: ModelProviderConfig): ScalarModelProvider {
  switch (config.provider) {
    case 'anthropic': {
      if (!config.apiKey) {
        throw new ProviderConfigurationError('AI_PROVIDER=anthropic needs AI_API_KEY.');
      }
      return new AnthropicProvider({
        apiKey: config.apiKey,
        model: config.model ?? DEFAULT_ANTHROPIC_MODEL,
      });
    }
    case 'openai': {
      if (!config.apiKey) {
        throw new ProviderConfigurationError('AI_PROVIDER=openai needs AI_API_KEY.');
      }
      return new OpenAICompatibleProvider({
        name: 'openai',
        baseUrl: config.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
        model: config.model ?? DEFAULT_OPENAI_MODEL,
        apiKey: config.apiKey,
      });
    }
    case 'ollama': {
      return new OpenAICompatibleProvider({
        name: 'ollama',
        baseUrl: config.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
        model: config.model ?? DEFAULT_OLLAMA_MODEL,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      });
    }
    case 'openai_compatible': {
      if (!config.baseUrl) {
        throw new ProviderConfigurationError(
          'AI_PROVIDER=openai_compatible needs AI_BASE_URL, and usually AI_MODEL.',
        );
      }
      if (!config.model) {
        throw new ProviderConfigurationError('AI_PROVIDER=openai_compatible needs AI_MODEL.');
      }
      return new OpenAICompatibleProvider({
        baseUrl: config.baseUrl,
        model: config.model,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      });
    }
  }
}
