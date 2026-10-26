/**
 * Security review fixes for v0.5.1 (written first). No test reaches the network: name resolution is injected,
 * and the rebinding test fails at connect time before any socket opens.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { LanguageModel } from 'ai';
import { setup, reauth, Ctx } from '../helpers';
import { guardModel, invalidKey, type ModelCall } from './mocks';
import { checkBaseUrl, isPrivateAddress, pinnedLookup } from '../../src/models/baseUrl';

const KEY = 'sk-test-SECRET-abcdef123456-WXYZ';
const post = (ctx: Ctx, path: string, body: unknown) => ctx.user.post(path).set('X-CSRF-Token', ctx.csrf).send(body as object);

afterEach(() => vi.restoreAllMocks());

describe('SSRF: the checked address is the connected address', () => {
  it('MOD-BYO-22 the connect-time lookup refuses a name that resolves to a private address (DNS rebinding)', async () => {
    let calls = 0;
    // first answer public, then private: a check-then-fetch design would pass the check and connect to 10.0.0.7
    const lookup = pinnedLookup(false, async () => (calls++ === 0 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '10.0.0.7', family: 4 }]));
    const run = () => new Promise<unknown>((resolve, reject) => lookup('rebind.example.com', { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))));
    await expect(run()).resolves.toEqual([{ address: '93.184.216.34', family: 4 }]);
    await expect(run()).rejects.toThrow(/private/i);
    // a mix of public and private answers is refused too
    const mixed = pinnedLookup(false, async () => [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.5', family: 4 }]);
    await expect(new Promise((res, rej) => mixed('mixed.example.com', {}, (e, a) => (e ? rej(e) : res(a))))).rejects.toThrow(/private/i);
    // a localhost base URL may connect to loopback only
    const local = pinnedLookup(true, async () => [{ address: '127.0.0.1', family: 4 }]);
    await expect(new Promise((res, rej) => local('localhost', {}, (e, a) => (e ? rej(e) : res(a))))).resolves.toBe('127.0.0.1');
    const localToLan = pinnedLookup(true, async () => [{ address: '192.168.1.5', family: 4 }]);
    await expect(new Promise((res, rej) => localToLan('localhost', {}, (e, a) => (e ? rej(e) : res(a))))).rejects.toThrow(/private/i);
  });

  it('MOD-BYO-23 through the real provider, a public name that resolves to a private address is blocked before connecting', async () => {
    const ctx = await setup({ resolveHost: async () => [{ address: '10.0.0.7', family: 4 }] });   // default provider factory, injected DNS
    await reauth(ctx);
    const m = await post(ctx, '/api/models', { provider: 'custom', modelId: 'qwen3', apiKey: KEY, label: 'Rebind', baseUrl: 'https://rebind.example.com/v1' });
    expect(m.status).toBe(201);
    await reauth(ctx);
    const res = await post(ctx, `/api/models/${m.body.id}/test`, {});
    expect(res.body).toMatchObject({ ok: false, error: 'BLOCKED_URL' });
  });

  it('MOD-BYO-24 IPv4-compatible and other embedded private IPv6 forms count as private', () => {
    for (const ip of ['::a00:1', '::ffff:a00:1', '::ffff:10.0.0.1', '::127.0.0.1', '64:ff9b::a00:1', 'fd12::1', 'fe80::1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['2606:4700::1111', '93.184.216.34']) expect(isPrivateAddress(ip), ip).toBe(false);
    expect(checkBaseUrl('https://[::a00:1]/v1').ok).toBe(false);
  });
});

describe('keys never reach logs or audit', () => {
  it('MOD-BYO-25 a provider error during an Assistant chat is not logged (it may echo the key), and the user sees a safe message', async () => {
    const logged: string[] = [];
    for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logged.push(a.map(x => (x instanceof Error ? `${x.message} ${JSON.stringify(x)}` : String(x))).join(' ')); });
    const make = (cfg: ModelCall): LanguageModel => {
      const model = guardModel(cfg);
      if (cfg.modelId === 'broken-chat') model.doStream = async () => { throw invalidKey(cfg.apiKey ?? ''); };
      return model;
    };
    const ctx = await setup({ modelFactory: make });
    await reauth(ctx);
    const m = (await post(ctx, '/api/models', { provider: 'openai', modelId: 'broken-chat', apiKey: KEY, label: 'Chat' }).expect(201)).body;
    await reauth(ctx);
    expect((await post(ctx, `/api/models/${m.id}/test`, {})).body.ok).toBe(true);
    expect((await ctx.user.put('/api/models/roles').set('X-CSRF-Token', ctx.csrf).send({ agent: m.id, guard: null })).status).toBe(200);

    const res = await post(ctx, '/api/assistant/chat', { messages: [{ role: 'user', content: 'hello there' }] }).buffer(true).parse((r, cb) => {
      let data = ''; r.setEncoding('utf8'); r.on('data', (c: string) => { data += c; }); r.on('end', () => cb(null, data));
    });
    const events = String(res.body).split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'INVALID_KEY' }));
    expect(String(res.body)).not.toContain('SECRET');
    for (const line of logged) expect(line).not.toContain('SECRET');
  });

  it('MOD-BYO-26 a base URL may not carry a query string or fragment (where a key could hide in clear)', async () => {
    for (const url of ['https://my-llm.example.com/v1?key=sk-SECRET', 'https://my-llm.example.com/v1#sk-SECRET', 'http://localhost:11434/v1?api_key=x']) {
      expect(checkBaseUrl(url).ok, url).toBe(false);
    }
    const ctx = await setup({ modelFactory: guardModel });
    await reauth(ctx);
    const res = await post(ctx, '/api/models', { provider: 'custom', modelId: 'qwen3', label: 'Q', baseUrl: 'https://my-llm.example.com/v1?key=sk-SECRET' });
    expect(res.status).toBe(400);
    const audit = (ctx.db.prepare('SELECT data FROM audit_events').all() as { data: string }[]).map(r => r.data).join('\n');
    expect(audit).not.toContain('SECRET');
  });
});
