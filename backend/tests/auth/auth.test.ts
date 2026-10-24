/** Auth cases from docs/TEST_CASES.md §4. */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';

const creds = { email: 'owner@test.dev', password: 'Owner#12345' };

describe('AUTH', () => {
  it('AUTH-01 session cookie is HttpOnly and SameSite=Strict, on signup and on login', async () => {
    const { app } = await createApp({ dbPath: ':memory:' });
    const signup = await request(app).post('/api/auth/signup').send(creds).expect(201);
    const login = await request(app).post('/api/auth/login').send(creds).expect(200);
    for (const res of [signup, login]) {
      const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find(c => c.startsWith('ag_session='));
      expect(cookie).toBeTruthy();
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
    }
  });

  it('AUTH-02 five wrong passwords lock the account with 429', async () => {
    const { app } = await createApp({ dbPath: ':memory:' });
    await request(app).post('/api/auth/signup').send(creds).expect(201);
    for (let i = 1; i <= 4; i++) await request(app).post('/api/auth/login').send({ ...creds, password: 'wrong-password' }).expect(401);
    await request(app).post('/api/auth/login').send({ ...creds, password: 'wrong-password' }).expect(429);
    // even the right password is refused while locked
    const locked = await request(app).post('/api/auth/login').send(creds);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('RATE_LIMITED');
  });

  it('AUTH-05 new accounts start on Plus and can choose another plan (DECISIONS A)', async () => {
    const { app } = await createApp({ dbPath: ':memory:' });
    expect((await request(app).post('/api/auth/signup').send(creds).expect(201)).body.plan).toBe('plus');
    expect((await request(app).post('/api/auth/signup').send({ email: 's@test.dev', password: 'Starter#12345', plan: 'starter' }).expect(201)).body.plan).toBe('starter');
  });

  it('AUTH-06 csrf and me need a session; logout needs the CSRF token', async () => {
    const { app } = await createApp({ dbPath: ':memory:' });
    await request(app).get('/api/auth/csrf').expect(401);
    const user = request.agent(app);
    await user.post('/api/auth/signup').send(creds).expect(201);
    const { token } = (await user.get('/api/auth/csrf').expect(200)).body;
    expect((await user.get('/api/me').expect(200)).body.plan).toBe('plus');
    await user.post('/api/auth/logout').send({}).expect(403);
    await user.post('/api/auth/logout').set('X-CSRF-Token', token).send({}).expect(200);
    await user.get('/api/me').expect(401);
  });

  it('AUTH-07 re-auth checks the password', async () => {
    const { app } = await createApp({ dbPath: ':memory:' });
    const user = request.agent(app);
    await user.post('/api/auth/signup').send(creds).expect(201);
    const { token } = (await user.get('/api/auth/csrf')).body;
    await user.post('/api/auth/reauth').set('X-CSRF-Token', token).send({ password: 'nope' }).expect(401);
    await user.post('/api/auth/reauth').set('X-CSRF-Token', token).send({ password: creds.password }).expect(200);
  });
});
