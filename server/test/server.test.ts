import { afterAll, afterEach, beforeAll, describe, test, expect } from 'vitest';
import { io as ioc, type Socket } from 'socket.io-client';
import { buildServer, resolveConfig } from '../src/server.js';
import type { Server as IOServer } from 'socket.io';
import type { PublicGameState, Result, JoinAck, StateAck } from '../src/types.js';
import { RoomStore } from '../src/room-store.js';
import { createInitialState, localCommitMove, generateLegalMoves } from '../src/game-engine.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

interface Harness {
  port: number;
  io: IOServer;
  store: RoomStore;
  matchQueue: { clear: () => void };
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const { httpServer, io, store, matchQueue } = buildServer({ authRateLimits: { ipMax: 10_000, userMax: 10_000 } });
  await new Promise<void>(res => httpServer.listen(0, '127.0.0.1', res));
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    port, io, store, matchQueue,
    close: () => new Promise<void>(res => { io.close(); httpServer.close(() => res()); }),
  };
}

let userSeq = 0;
function nextName(prefix: string): string {
  return `${prefix}${1000 + userSeq++}`;
}

async function register(h: Harness, username?: string, password = 'Tr0ub4dor&3') {
  const name = username ?? nextName('u');
  const res = await fetch(`http://127.0.0.1:${h.port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, password }),
  });
  expect(res.status).toBe(201);
  const cookies = (res.headers as any).getSetCookie ? (res.headers as any).getSetCookie() : [];
  const cookie = (cookies as string[]).find(c => c.startsWith('dragonchess_session=')) || (cookies as string[])[0] || '';
  const body = await res.json() as { user: any };
  return { cookie, user: body.user, name };
}

function authedConnect(h: Harness, cookie: string): Socket {
  return ioc(`http://127.0.0.1:${h.port}`, {
    path: '/socket.io/', transports: ['polling', 'websocket'], forceNew: true,
    extraHeaders: { Cookie: cookie },
  });
}

function connect(port: number): Socket {
  return ioc(`http://127.0.0.1:${port}`, { path: '/socket.io/', transports: ['polling', 'websocket'], forceNew: true });
}

function ack<T>(p: Promise<T>): Promise<T> { return p; }

function nextState(socket: Socket, timeout = 1000): Promise<PublicGameState> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('game:state', handler); reject(new Error('timeout game:state')); }, timeout);
    const handler = (s: PublicGameState) => { clearTimeout(timer); socket.off('game:state', handler); resolve(s); };
    socket.on('game:state', handler);
  });
}

function nextStateAfter(socket: Socket, baseVersion: number, timeout = 1500): Promise<PublicGameState> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('game:state', handler); reject(new Error('timeout game:state after ' + baseVersion)); }, timeout);
    const handler = (s: PublicGameState) => {
      if (s.version > baseVersion) { clearTimeout(timer); socket.off('game:state', handler); resolve(s); }
    };
    socket.on('game:state', handler);
  });
}

async function waitForConnect(socket: Socket): Promise<void> {
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('connect timeout')), 2000);
    socket.once('connect', () => { clearTimeout(t); res(); });
    socket.once('connect_error', (e) => { clearTimeout(t); rej(e); });
  });
}

async function makeGame(h: Harness) {
  const gold = await register(h, nextName('gold'));
  const scarlet = await register(h, nextName('scarlet'));
  const g = authedConnect(h, gold.cookie); const s = authedConnect(h, scarlet.cookie);
  await waitForConnect(g); await waitForConnect(s);
  const cr = await ack(g.emitWithAck('game:create') as Promise<Result<JoinAck>>);
  if (!cr.ok) throw new Error('create failed');
  const code = cr.data.code;
  const jr = await ack(s.emitWithAck('game:join', { code }) as Promise<Result<JoinAck>>);
  if (!jr.ok) throw new Error('join failed: ' + jr.error.message);
  return { g, s, code, goldToken: cr.data.token, scarletToken: jr.data.token, gold, scarlet };
}

let h: Harness;

beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.close(); });

afterEach(() => {
  for (const code of h.store.listCodes()) h.store.delete(code);
  h.matchQueue.clear();
});

describe('Dragonchess server', () => {
  test('health endpoint returns ok', async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('defaults to 127.0.0.1:3543', () => {
    const saved = { HOST: process.env.HOST, PORT: process.env.PORT };
    delete process.env.HOST; delete process.env.PORT;
    const cfg = resolveConfig();
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(3543);
    process.env.HOST = saved.HOST; process.env.PORT = saved.PORT;
  });

  test('unauthenticated sockets cannot create or join a game', async () => {
    const c = connect(h.port); await waitForConnect(c);
    const cr = await ack(c.emitWithAck('game:create') as Promise<Result<JoinAck>>);
    expect(cr.ok).toBe(false);
    if (!cr.ok) expect(cr.error.code).toBe('not-authenticated');
    const jr = await ack(c.emitWithAck('game:join', { code: 'AAAAAA' }) as Promise<Result<JoinAck>>);
    expect(jr.ok).toBe(false);
    if (!jr.ok) expect(jr.error.code).toBe('not-authenticated');
    c.disconnect();
  });

  test('create assigns Gold and reflects the authenticated username', async () => {
    const gold = await register(h, nextName('a'));
    const c = authedConnect(h, gold.cookie); await waitForConnect(c);
    const r = await ack(c.emitWithAck('game:create') as Promise<Result<JoinAck>>);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.seat).toBe('gold');
      expect(r.data.state.players.gold.username).toBe(gold.user.username);
    }
    c.disconnect();
  });

  async function rawRegister(h: Harness, username: string, password: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${h.port}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  }
  async function rawLogin(h: Harness, username: string, password: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${h.port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  }
  async function changePassword(h: Harness, cookie: string, currentPassword: string, newPassword: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`http://127.0.0.1:${h.port}/api/auth/change-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    return { status: res.status, body: await res.json() as any };
  }

  test('register rejects 7-char password, accepts 8-char', async () => {
    const short = await rawRegister(h, nextName('pw'), '1234567');
    expect(short.status).toBe(400);
    const ok8 = await rawRegister(h, nextName('pw'), 'goodpw88');
    expect(ok8.status).toBe(201);
  });

  test('change-password requires auth and verifies current password', async () => {
    const name = nextName('pw'); const old = 'Tr0ub4dor&3'; const next = 'N3wPassw0rd!';
    const reg = await register(h, name, old);
    const noAuth = await changePassword(h, '', old, next);
    expect(noAuth.status).toBe(401);
    const wrong = await changePassword(h, reg.cookie, 'wrongpassword', next);
    expect(wrong.status).toBe(401);
    const tooShort = await changePassword(h, reg.cookie, old, '1234567');
    expect(tooShort.status).toBe(400);
    const same = await changePassword(h, reg.cookie, old, old);
    expect(same.status).toBe(400);
    const good = await changePassword(h, reg.cookie, old, next);
    expect(good.status).toBe(200);
    const oldLogin = await rawLogin(h, name, old);
    expect(oldLogin.status).toBe(401);
    const newLogin = await rawLogin(h, name, next);
    expect(newLogin.status).toBe(200);
  });

  test('change-password rotates the session cookie', async () => {
    const reg = await register(h, nextName('pw'), 'Tr0ub4dor&3');
    const res = await fetch(`http://127.0.0.1:${h.port}/api/auth/change-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: reg.cookie },
      body: JSON.stringify({ currentPassword: 'Tr0ub4dor&3', newPassword: 'Rotated123!' }),
    });
    expect(res.status).toBe(200);
    const cookies = (res.headers as any).getSetCookie ? (res.headers as any).getSetCookie() : [];
    const set = (cookies as string[]).find(c => c.startsWith('dragonchess_session=')) || '';
    expect(set).toBeTruthy();
  });

  test('join assigns Scarlet and auto-starts (no ready/start phase)', async () => {
    const { g, s, scarletToken, code } = await makeGame(h);
    expect(scarletToken).toBeTruthy();
    const room = h.store.get(code)!;
    expect(room.status).toBe('active');
    expect(room.gold.userId).toBeGreaterThan(0);
    expect(room.scarlet.userId).toBeGreaterThan(0);
    g.disconnect(); s.disconnect();
  });

  test('a third player cannot join an active game', async () => {
    const { g, s, code } = await makeGame(h);
    const t = await register(h, nextName('t'));
    const tc = authedConnect(h, t.cookie); await waitForConnect(tc);
    const r = await ack(tc.emitWithAck('game:join', { code }) as Promise<Result<JoinAck>>);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('room-started');
    tc.disconnect(); g.disconnect(); s.disconnect();
  });

  test('one account cannot hold both seats', async () => {
    const me = await register(h, nextName('both'));
    const g = authedConnect(h, me.cookie); await waitForConnect(g);
    const cr = await ack(g.emitWithAck('game:create') as Promise<Result<JoinAck>>);
    if (!cr.ok) throw new Error('create failed');
    const s = authedConnect(h, me.cookie); await waitForConnect(s);
    const jr = await ack(s.emitWithAck('game:join', { code: cr.data.code }) as Promise<Result<JoinAck>>);
    expect(jr.ok).toBe(false);
    if (!jr.ok) expect(jr.error.code).toBe('same-account');
    g.disconnect(); s.disconnect();
  });

  test('only the correct player may move (out-of-turn rejected)', async () => {
    const { g, s, code, scarletToken } = await makeGame(h);
    const state = h.store.get(code)!;
    const scarletWarrior = Object.values(state.position.pieces).find(p => p.color === 'scarlet' && p.type === 'warrior')!;
    const r = await ack(s.emitWithAck('game:move', {
      code, token: scarletToken, expectedVersion: 0, pieceId: scarletWarrior.id, kind: 'move',
      from: { level: 2, file: scarletWarrior.file, rank: scarletWarrior.rank },
      to: { level: 2, file: scarletWarrior.file, rank: scarletWarrior.rank - 1 },
    }) as Promise<Result<StateAck>>);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not-your-turn');
    g.disconnect(); s.disconnect();
  });

  test('illegal move rejected', async () => {
    const { g, s, code, goldToken } = await makeGame(h);
    const state = h.store.get(code)!;
    const w = Object.values(state.position.pieces).find(p => p.color === 'gold' && p.type === 'warrior')!;
    const r = await ack(g.emitWithAck('game:move', {
      code, token: goldToken, expectedVersion: 0, pieceId: w.id, kind: 'move',
      from: { level: 2, file: w.file, rank: w.rank },
      to: { level: 2, file: w.file, rank: w.rank + 3 },
    }) as Promise<Result<StateAck>>);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('illegal-move');
    g.disconnect(); s.disconnect();
  });

  test('stale version rejected', async () => {
    const { g, s, code, goldToken, scarletToken } = await makeGame(h);
    const st0 = h.store.get(code)!;
    const gw = Object.values(st0.position.pieces).find(p => p.color === 'gold' && p.type === 'warrior')!;
    const glegal = generateLegalMoves(st0.position, gw.id)[0];
    await ack(g.emitWithAck('game:move', {
      code, token: goldToken, expectedVersion: 0, pieceId: gw.id, kind: glegal.kind,
      from: glegal.from, to: glegal.to,
    }) as Promise<Result<StateAck>>);
    const st1 = h.store.get(code)!;
    const sw = Object.values(st1.position.pieces).find(p => p.color === 'scarlet' && p.type === 'warrior')!;
    const slegal = generateLegalMoves(st1.position, sw.id)[0];
    await ack(s.emitWithAck('game:move', {
      code, token: scarletToken, expectedVersion: 1, pieceId: sw.id, kind: slegal.kind,
      from: slegal.from, to: slegal.to,
    }) as Promise<Result<StateAck>>);
    const r2 = await ack(g.emitWithAck('game:move', {
      code, token: goldToken, expectedVersion: 0, pieceId: gw.id, kind: glegal.kind,
      from: glegal.from, to: glegal.to,
    }) as Promise<Result<StateAck>>);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('stale-version');
    g.disconnect(); s.disconnect();
  });

  test('legal move increments version exactly once', async () => {
    const { g, s, code, goldToken } = await makeGame(h);
    const before = h.store.get(code)!.version;
    const state = h.store.get(code)!;
    const w = Object.values(state.position.pieces).find(p => p.color === 'gold' && p.type === 'warrior')!;
    const legal = generateLegalMoves(state.position, w.id)[0];
    const r = await ack(g.emitWithAck('game:move', {
      code, token: goldToken, expectedVersion: before, pieceId: w.id, kind: legal.kind,
      from: legal.from, to: legal.to,
    }) as Promise<Result<StateAck>>);
    expect(r.ok).toBe(true);
    expect(h.store.get(code)!.version).toBe(before + 1);
    g.disconnect(); s.disconnect();
  });

  test('both clients receive identical broadcast state', async () => {
    const { g, s, code, goldToken } = await makeGame(h);
    const state = h.store.get(code)!;
    const baseVersion = state.version;
    const w = Object.values(state.position.pieces).find(p => p.color === 'gold' && p.type === 'warrior')!;
    const legal = generateLegalMoves(state.position, w.id)[0];
    const pg = nextStateAfter(g, baseVersion); const ps = nextStateAfter(s, baseVersion);
    await ack(g.emitWithAck('game:move', {
      code, token: goldToken, expectedVersion: state.version, pieceId: w.id, kind: legal.kind,
      from: legal.from, to: legal.to,
    }) as Promise<Result<StateAck>>);
    const [ag, as_] = await Promise.all([pg, ps]);
    expect(JSON.stringify(ag)).toBe(JSON.stringify(as_));
    g.disconnect(); s.disconnect();
  });

  test('client capture/promotion/notation/winner ignored (server-derived)', async () => {
    const { g, s, code, goldToken } = await makeGame(h);
    const state = h.store.get(code)!;
    const w = Object.values(state.position.pieces).find(p => p.color === 'gold' && p.type === 'warrior')!;
    const legal = generateLegalMoves(state.position, w.id)[0];
    const payload = {
      code, token: goldToken, expectedVersion: state.version, pieceId: w.id, kind: legal.kind,
      from: legal.from, to: legal.to,
      capturedPieceId: 'LIES', promotion: 'dragon', notation: 'CHEAT', winner: 'scarlet',
    };
    const r = await ack(g.emitWithAck('game:move', payload) as Promise<Result<StateAck>>);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const hist = r.data.state.moveHistory;
      const last = hist[hist.length - 1];
      expect(last.notation).toMatch(/\(Gold\) - Ground - Warrior - A2 - A3$/);
      expect(last.notation).toBe(last.lastMove);
      expect(last.moverColor).toBe('gold');
      expect(last.pieceType).toBe('warrior');
      expect(last.moveKind).toBe(legal.kind);
      expect(last.realm).toBe('Ground');
      expect(last.capturedType).toBeNull();
      expect(r.data.state.status).toBe('active');
      expect(r.data.state.winner).toBeNull();
    }
    g.disconnect(); s.disconnect();
  });

  test('reconnect via token (seat identity is token-based, not socket.id)', async () => {
    const { g, s, code, goldToken } = await makeGame(h);
    const codeCopy = code; const tokenCopy = goldToken;
    g.disconnect();
    await new Promise(r => setTimeout(r, 50));
    const g2 = authedConnect(h, (await register(h, nextName('x'))).cookie);
    await waitForConnect(g2);
    const r = await ack(g2.emitWithAck('game:resume', { code: codeCopy, token: tokenCopy }) as Promise<Result<JoinAck>>);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.seat).toBe('gold');
    g2.disconnect(); s.disconnect();
  });

  test('invalid token cannot steal a seat', async () => {
    const { g, s, code } = await makeGame(h);
    const thief = connect(h.port); await waitForConnect(thief);
    const r = await ack(thief.emitWithAck('game:resume', { code, token: '0'.repeat(64) }) as Promise<Result<JoinAck>>);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('bad-token');
    const r2 = await ack(thief.emitWithAck('game:join', { code }) as Promise<Result<JoinAck>>);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('not-authenticated');
    thief.disconnect(); g.disconnect(); s.disconnect();
  });

  test('tokens / hashes / socket ids never appear in public state', async () => {
    const { g, s, code, goldToken } = await makeGame(h);
    const state = h.store.get(code)!;
    const w = Object.values(state.position.pieces).find(p => p.color === 'gold' && p.type === 'warrior')!;
    const legal = generateLegalMoves(state.position, w.id)[0];
    const ps = nextState(s);
    await ack(g.emitWithAck('game:move', {
      code, token: goldToken, expectedVersion: state.version, pieceId: w.id, kind: legal.kind,
      from: legal.from, to: legal.to,
    }) as Promise<Result<StateAck>>);
    const pub = await ps;
    const json = JSON.stringify(pub);
    expect(json).not.toContain('tokenHash');
    expect(json).not.toContain('socketId');
    expect(json).not.toContain('password');
    expect(json).not.toContain(goldToken);
    for (const k of Object.keys(pub)) expect(/token|hash/i.test(k)).toBe(false);
    g.disconnect(); s.disconnect();
  });

  test('public player payload is sanitized (userId/username/rating/w/d/l/connected only)', async () => {
    const { g, s, code } = await makeGame(h);
    const room = h.store.get(code)!;
    const pub = room;
    const state = h.store.toPublicState(room);
    const gp = state.players.gold;
    expect(typeof gp.userId).toBe('string');
    expect(gp).toHaveProperty('username');
    expect(gp).toHaveProperty('rating');
    expect(gp).toHaveProperty('wins');
    expect(gp).toHaveProperty('draws');
    expect(gp).toHaveProperty('losses');
    expect(gp).toHaveProperty('connected');
    const keys = Object.keys(gp);
    for (const k of keys) expect(/token|hash|password|socket|pepper/i.test(k)).toBe(false);
    g.disconnect(); s.disconnect();
  });

  test('disconnect keeps the seat claimed but marks it disconnected', async () => {
    const { g, s, code } = await makeGame(h);
    void code;
    // the auto-start broadcast (scarlet still connected) can arrive first
    const ev = new Promise<PublicGameState>((resolve, reject) => {
      const t = setTimeout(() => { g.off('game:state', h); reject(new Error('timeout disconnect')); }, 2000);
      const h = (s2: PublicGameState) => {
        if (!s2.players.scarlet.connected) { clearTimeout(t); g.off('game:state', h); resolve(s2); }
      };
      g.on('game:state', h);
    });
    s.disconnect();
    const pub = await ev;
    expect(pub.players.scarlet.username).toBeTruthy();
    expect(pub.players.scarlet.connected).toBe(false);
    g.disconnect();
  });

  test('draw only answered by the opponent', async () => {
    const { g, s, code, goldToken, scarletToken } = await makeGame(h);
    const offer = await ack(g.emitWithAck('draw:offer', { code, token: goldToken }) as Promise<Result<StateAck>>);
    expect(offer.ok).toBe(true);
    if (offer.ok) expect(offer.data.state.drawOfferBy).toBe('gold');
    const self = await ack(g.emitWithAck('draw:answer', { code, token: goldToken, accept: true }) as Promise<Result<StateAck>>);
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error.code).toBe('not-your-offer');
    const ans = await ack(s.emitWithAck('draw:answer', { code, token: scarletToken, accept: true }) as Promise<Result<StateAck>>);
    expect(ans.ok).toBe(true);
    if (ans.ok) {
      expect(ans.data.state.status).toBe('finished');
      expect(ans.data.state.winner).toBeNull();
      expect(ans.data.state.resultReason).toBe('draw by agreement');
    }
    g.disconnect(); s.disconnect();
  });

  test('resignation awards the opponent the win', async () => {
    const { g, s, code, goldToken } = await makeGame(h);
    const r = await ack(g.emitWithAck('game:resign', { code, token: goldToken }) as Promise<Result<StateAck>>);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.state.status).toBe('finished');
      expect(r.data.state.winner).toBe('scarlet');
      expect(r.data.state.resultReason).toBe('resignation');
    }
    g.disconnect(); s.disconnect();
  });

  test('rematch requires both players to confirm', async () => {
    const { g, s, code, goldToken, scarletToken } = await makeGame(h);
    await ack(g.emitWithAck('game:resign', { code, token: goldToken }) as Promise<Result<StateAck>>);
    const r1 = await ack(g.emitWithAck('game:rematch', { code, token: goldToken }) as Promise<Result<StateAck>>);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.data.state.status).toBe('finished');
    const r2 = await ack(s.emitWithAck('game:rematch', { code, token: scarletToken }) as Promise<Result<StateAck>>);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.data.state.status).toBe('active');
      expect(r2.data.state.version).toBe(0);
      expect(r2.data.state.moveHistory.length).toBe(0);
      expect(r2.data.state.winner).toBeNull();
    }
    g.disconnect(); s.disconnect();
  });

  test('rematch swaps colours and is always unranked', async () => {
    const { g, s, code, goldToken, scarletToken, gold, scarlet } = await makeGame(h);
    const st0 = h.store.get(code)!;
    // st0 is a live reference, copy the id before it changes
    const origGameId = st0.gameId;
    expect(st0.gold.userId).toBe(gold.user.id);
    expect(st0.scarlet.userId).toBe(scarlet.user.id);
    await ack(g.emitWithAck('game:resign', { code, token: goldToken }) as Promise<Result<StateAck>>);
    await ack(g.emitWithAck('game:rematch', { code, token: goldToken }) as Promise<Result<StateAck>>);
    await ack(s.emitWithAck('game:rematch', { code, token: scarletToken }) as Promise<Result<StateAck>>);
    const st1 = h.store.get(code)!;
    expect(st1.scarlet.userId).toBe(gold.user.id);
    expect(st1.gold.userId).toBe(scarlet.user.id);
    expect(st1.rated).toBe(false);
    expect(st1.rematchOf).toBe(origGameId);
    g.disconnect(); s.disconnect();
  });

  test('cancel rematch clears a pending request', async () => {
    const { g, s, code, goldToken, scarletToken } = await makeGame(h);
    await ack(g.emitWithAck('game:resign', { code, token: goldToken }) as Promise<Result<StateAck>>);
    await ack(g.emitWithAck('game:rematch', { code, token: goldToken }) as Promise<Result<StateAck>>);
    await ack(g.emitWithAck('game:rematch:cancel', { code, token: goldToken }) as Promise<Result<null>>);
    const r = await ack(s.emitWithAck('game:rematch', { code, token: scarletToken }) as Promise<Result<StateAck>>);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.state.status).toBe('finished');
    g.disconnect(); s.disconnect();
  });

  test('engine commit parity smoke (local, no network fallback)', () => {
    let s = createInitialState();
    const w = Object.values(s.pieces).find(p => p.color === 'gold' && p.type === 'warrior')!;
    const legal = generateLegalMoves(s, w.id);
    expect(legal.length).toBeGreaterThan(0);
    const r1 = localCommitMove(s, legal[0], 0);
    expect(r1.ok).toBe(true);
    expect(r1.state!.version).toBe(1);
    expect(r1.state!.turn).toBe('scarlet');
    s = r1.state!;
    const sw = Object.values(s.pieces).find(p => p.color === 'scarlet' && p.type === 'warrior')!;
    const legal2 = generateLegalMoves(s, sw.id);
    const r2 = localCommitMove(s, legal2[0], 1);
    expect(r2.ok).toBe(true);
    expect(r2.state!.version).toBe(2);
    expect(r2.state!.turn).toBe('gold');
  });

  test('initial position has 42 pieces per side on unique squares', () => {
    const s = createInitialState();
    const counts = { gold: 0, scarlet: 0 };
    for (const id in s.pieces) counts[s.pieces[id].color === 'gold' ? 'gold' : 'scarlet']++;
    expect(counts.gold).toBe(42); expect(counts.scarlet).toBe(42);
    const set = new Set<string>();
    for (const id in s.pieces) { const k = s.pieces[id].level + ',' + s.pieces[id].file + ',' + s.pieces[id].rank; expect(set.has(k)).toBe(false); set.add(k); }
    expect(set.size).toBe(84);
  });

  test('no Firebase URL/import/config/instruction remains in server source', () => {
    const files = ['src/server.ts', 'src/game-engine.ts', 'src/room-store.ts', 'src/types.ts', 'src/auth.ts', 'src/matchmaking.ts'];
    for (const f of files) {
      const src = readFileSync(join(here, '..', f), 'utf8');
      expect(src.toLowerCase(), `${f} references firebase`).not.toContain('firebase');
      expect(src.toLowerCase(), `${f} references gstatic`).not.toContain('gstatic');
      expect(src.toLowerCase(), `${f} references firebaseio`).not.toContain('firebaseio');
    }
  });

  test('no MD5 is used for password storage in server source', () => {
    const files = ['src/auth.ts', 'src/server.ts'];
    for (const f of files) {
      const src = readFileSync(join(here, '..', f), 'utf8');
      expect(src).not.toMatch(/createHash\(\s*['"]md5['"]/i);
      expect(src).not.toMatch(/crypto\.createHash\(\s*['"]md5['"]/i);
      expect(src).not.toMatch(/require\(\s*['"]md5['"]/i);
      expect(src).not.toMatch(/import.*['"]md5['"]/i);
    }
  });
});