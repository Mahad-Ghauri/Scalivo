import { afterEach, describe, expect, it, vi } from 'vitest';
import { generate } from '../src/lib/gemini.js';

vi.mock('../src/config/env.js', () => ({
  env: { GEMINI_API_KEY: 'test-gemini-key', GEMINI_MODEL: 'test-model' },
}));

afterEach(() => vi.restoreAllMocks());

const request = {
  instruction: 'Extract booking details', input: 'tomorrow afternoon',
  temperature: 0, maxOutputTokens: 200, timeoutMs: 1000, purpose: 'booking-intent',
};

describe('Gemini transport', () => {
  it('keeps credentials out of the URL and attaches a bounded request signal', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"day":"tomorrow"}' }] } }],
    })));
    expect(await generate(request)).toBe('{"day":"tomorrow"}');
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
    expect(options?.headers).toMatchObject({ 'x-goog-api-key': 'test-gemini-key' });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns the menu fallback on quota refusal', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 429 }));
    expect(await generate(request)).toBeNull();
  });

  it('returns the menu fallback on a request timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));
    expect(await generate(request)).toBeNull();
  });
});
