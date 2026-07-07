/**
 * Thin OpenRouter client for the AI Tax Advisor.
 * OpenRouter exposes an OpenAI-compatible API — one key works for Claude,
 * GPT-4o, Gemini, and 400+ other models. Supports streaming via SSE.
 * Docs: https://openrouter.ai/docs
 */

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Models available in the UI picker, ordered by capability. */
export const AI_MODELS: { id: string; label: string; note: string }[] = [
  { id: 'anthropic/claude-opus-4-5', label: 'Claude Sonnet 4.5', note: 'Best quality — recommended' },
  { id: 'anthropic/claude-opus-4', label: 'Claude Opus 4', note: 'Highest quality, slower' },
  { id: 'openai/gpt-4o', label: 'GPT-4o', note: 'Great alternative' },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', note: 'Fast & cheap' },
  { id: 'anthropic/claude-3.5-haiku', label: 'Claude Haiku 3.5', note: 'Fastest Claude' }
];

export const DEFAULT_AI_MODEL = AI_MODELS[0].id;

/** Single non-streaming completion — used for structured tasks like CSV column mapping. */
export async function completeChat(
  apiKey: string,
  model: string,
  messages: ChatMessage[]
): Promise<string> {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'https://sololedger.app',
      'X-Title': 'SoloLedger CSV Import'
    },
    body: JSON.stringify({ model, messages, stream: false, temperature: 0.1 })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => `HTTP ${res.status}`);
    let friendly = `OpenRouter error ${res.status}`;
    if (res.status === 401) friendly = 'Invalid API key — check Settings → AI Advisor.';
    else if (res.status === 402) friendly = 'Insufficient credits on OpenRouter.';
    else if (res.status === 429) friendly = 'Rate limited — try again in a moment.';
  else {
      try {
        const parsed = JSON.parse(errText);
        if (parsed?.error?.message) friendly = parsed.error.message;
      } catch { /* ignore */ }
    }
    throw new Error(friendly);
  }

  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error('Empty response from AI.');
  return content;
}

/**
 * Streams a chat completion from OpenRouter.
 * Yields text chunks as they arrive (SSE / streaming).
 */
export async function* streamChatCompletion(
  apiKey: string,
  model: string,
  messages: ChatMessage[]
): AsyncGenerator<string, void, unknown> {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'https://sololedger.app',
      'X-Title': 'SoloLedger AI Tax Advisor'
    },
    body: JSON.stringify({ model, messages, stream: true })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => `HTTP ${res.status}`);
    let friendly = `OpenRouter error ${res.status}`;
    if (res.status === 401) friendly = 'Invalid API key — check Settings → AI Advisor.';
    else if (res.status === 402) friendly = 'Insufficient credits on OpenRouter.';
    else if (res.status === 429) friendly = 'Rate limited — try again in a moment.';
    else {
      try {
        const parsed = JSON.parse(errText);
        if (parsed?.error?.message) friendly = parsed.error.message;
      } catch { /* ignore */ }
    }
    throw new Error(friendly);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No readable stream from OpenRouter.');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') return;
      try {
        const parsed = JSON.parse(data);
        const chunk: string = parsed?.choices?.[0]?.delta?.content ?? '';
        if (chunk) yield chunk;
      } catch { /* malformed SSE chunk — skip */ }
    }
  }
}
