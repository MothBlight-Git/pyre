/**
 * Which model answers `> …` in the talk lane.
 *
 * Two wire protocols cover everything worth supporting:
 *   - `anthropic`  the Anthropic Messages API
 *   - `openai`     the OpenAI chat-completions shape, which Gemini, OpenRouter,
 *                  Groq, Ollama and LM Studio all speak
 *
 * A preset is just a base URL, a default model and a place to get a key. Users
 * can pick `custom` and point at anything OpenAI-shaped, including a local
 * model with no key at all.
 */
export type ProviderKind = 'anthropic' | 'openai';

export interface Preset {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Undefined means the SDK default (api.anthropic.com / api.openai.com). */
  baseUrl?: string;
  defaultModel: string;
  /** False for local runtimes that accept any key or none. */
  needsKey: boolean;
  /** Shown under the key field. */
  hint: string;
  /**
   * OpenAI renamed the output cap for newer models; Ollama, Gemini's compat
   * layer and most others still accept only `max_tokens`. Sending the wrong
   * one is a 400 on some endpoints and silently ignored on others, so it is
   * per-provider rather than guessed.
   */
  tokenParam?: 'max_tokens' | 'max_completion_tokens';
}

export const PRESETS: Preset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    defaultModel: 'claude-opus-5',
    needsKey: true,
    hint: 'Key from console.anthropic.com',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'openai',
    // Google ships an OpenAI-compatible surface alongside its native API.
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-2.5-flash',
    needsKey: true,
    hint: 'Key from aistudio.google.com/apikey',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    defaultModel: 'gpt-5',
    needsKey: true,
    hint: 'Key from platform.openai.com',
    tokenParam: 'max_completion_tokens',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    needsKey: true,
    hint: 'One key, many models — openrouter.ai/keys',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'phi4-mini',
    needsKey: false,
    hint: 'Runs on this machine — no key, no bill. phi4-mini works but is inconsistent; qwen2.5 or llama3.1 call tools more reliably. Plain phi4 can talk but cannot change notes.',
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    kind: 'openai',
    defaultModel: '',
    needsKey: false,
    hint: 'Any OpenAI-shaped endpoint. Leave the key empty if it does not need one.',
  },
];

export function preset(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

/** Providers share one encrypted store, keyed by preset id. */
export function keyName(providerId: string): string {
  return preset(providerId).id;
}
