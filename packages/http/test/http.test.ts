import { describe, expect, it } from 'vitest';
import { HttpClient, HttpError } from '../src/index.js';

const noSleep = async () => {};

function fakeFetch(responses: Array<() => Response | Promise<Response>>) {
  let i = 0;
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return next();
  }) as typeof fetch;
  return { impl, calls };
}

const base = { requestsPerSecond: 1000, concurrency: 2, timeoutMs: 1000, retries: 2, sleep: noSleep };

describe('HttpClient', () => {
  it('retries transient 503s then succeeds', async () => {
    const { impl, calls } = fakeFetch([
      () => new Response('busy', { status: 503 }),
      () => new Response('ok', { status: 200 }),
    ]);
    const client = new HttpClient({ ...base, fetchImpl: impl });
    const res = await client.get('https://example.com/a');
    expect(res.body).toBe('ok');
    expect(res.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(client.stats.retries).toBe(1);
  });

  it('does not retry a 404', async () => {
    const { impl, calls } = fakeFetch([() => new Response('nope', { status: 404 })]);
    const client = new HttpClient({ ...base, fetchImpl: impl });
    await expect(client.get('https://example.com/missing')).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
  });

  it('gives up after the retry budget', async () => {
    const { impl, calls } = fakeFetch([() => new Response('', { status: 500 })]);
    const client = new HttpClient({ ...base, fetchImpl: impl });
    await expect(client.get('https://example.com/x')).rejects.toThrow(/after 3 attempts/);
    expect(calls).toHaveLength(3);
    expect(client.stats.failures).toBe(1);
  });
});
