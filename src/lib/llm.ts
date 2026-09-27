// src/lib/llm.ts
//
// One chat-completion call for the features that write text: the meeting
// summary and AI chapter markers.
//
// By default this goes through Vercel AI Gateway, authenticated as this
// project with its Vercel OIDC token, so no provider account or key is
// needed and usage is billed to the Vercel team. The gateway speaks the
// OpenAI chat-completions format, with models named "openai/<model>".
// An OPENAI_API_KEY, if one is ever set, sends calls to OpenAI directly
// instead; AI_GATEWAY_API_KEY is for running the gateway path off Vercel.

import { getVercelOidcToken } from '@vercel/oidc';

const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/chat/completions';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export type LlmResult =
  | { ok: true; text: string; model: string }
  | { ok: false; error: 'ai_not_configured' | 'ai_failed'; status?: number; detail?: string };

/**
 * Whether a call can be attempted: a key is set, or this is running on
 * Vercel, where the project's OIDC token signs gateway calls.
 */
export function aiAvailable(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY || process.env.AI_GATEWAY_API_KEY || process.env.VERCEL
  );
}

async function route(model: string): Promise<{ url: string; auth: string; model: string } | null> {
  if (process.env.OPENAI_API_KEY) {
    return { url: OPENAI_URL, auth: process.env.OPENAI_API_KEY, model };
  }
  let auth = process.env.AI_GATEWAY_API_KEY || '';
  if (!auth) {
    try {
      auth = await getVercelOidcToken();
    } catch {
      return null;
    }
  }
  return auth ? { url: GATEWAY_URL, auth, model: 'openai/' + model } : null;
}

export async function chatCompletion(opts: {
  system: string;
  user: string;
  /** An OpenAI model name, e.g. "gpt-4o-mini". */
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask for a JSON object back. */
  json?: boolean;
}): Promise<LlmResult> {
  const r = await route(opts.model);
  if (!r) return { ok: false, error: 'ai_not_configured' };
  try {
    const res = await fetch(r.url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + r.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: r.model,
        temperature: opts.temperature ?? 0.3,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: 'ai_failed', status: res.status, detail: detail.slice(0, 400) };
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return { ok: true, text: j?.choices?.[0]?.message?.content?.trim() || '', model: r.model };
  } catch (e) {
    return { ok: false, error: 'ai_failed', detail: e instanceof Error ? e.message : String(e) };
  }
}
