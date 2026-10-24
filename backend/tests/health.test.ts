import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

describe('M0 scaffold', () => {
  it('HEALTH-01 health endpoint reports mock mode', async () => {
    const { app } = await createApp({ dbPath: ':memory:' });
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body).toEqual({ ok: true, integrationMode: 'mock' });
  });

  it('HEALTH-02 unknown routes return the documented error format', async () => {
    const { app } = await createApp({ dbPath: ':memory:' });
    const res = await request(app).get('/api/nope').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
