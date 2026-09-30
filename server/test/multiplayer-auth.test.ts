import { afterAll, afterEach, beforeAll, describe, test, expect } from 'vitest';
import { io as ioc, type Socket } from 'socket.io-client';
import { buildServer } from '../src/server.js';
import { Repo } from '../src/repo.js';
import { inMemoryDb } from '../src/db.js';
import { DEV_COOKIE_NAME } from '../src/auth.js';
import type { Server as IOServer } from 'socket.io';
import type {
  PublicGameState, Result, JoinAck, StateAck, ProfilePayload, MatchedPayload, MatchmakingStatus,
} from '../src/types.js';
import { RoomStore } from '../src/room-store.js';
import { generateLegalMoves } from '../src/game-engine.js';

interface Harness {
  port: number;
  io: IOServer;
  store: RoomStore;
  repo: Repo;
  matchQueue: { clear: () => void };
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const repo = new Repo(inMemoryDb());
  const { httpServer, io, store, matchQueue } = buildServer({ repo, authRateLimits: { ipMax: 10_000, userMax: 10_000 } });
  await new Promise<void>(res => httpServer.listen(0, '127.0.0.1', res));
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    port, io, store, repo, matchQueue,
    close: () => new Promise<void>(res => { io.close(); httpServer.close(() => res()); }),
  };
}

let userSeq = 0;
function connect(port: number, cookie?: string): Socket {
  const extra = cookie ? { Cookie: `${DEV_COOKIE_NAME}=${cookie}` } : undefined;
  return ioc(`http://127.0.0.1:${port}`, {
    path: '/socket.io/', transports: ['polling', 'websocket'], forceNew: true,
    extraHeaders: extra,
  });
}

function waitForConnect(socket: Socket): Promise<void> {
  return new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('connect timeout')), 2000);
    socket.once('connect', () => { clearTimeout(t); res(); });
    socket.once('connect_error', (e) => { clearTimeout(t); rej(e); });
  });
}

function ack<T>(p: Promise<T>): Promise<T> { return p; }

function once<T>(socket: Socket, event: string, timeout = 2500): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { socket.off(event, h); reject(new Error('timeout ' + event)); }, timeout);
    const h = (v: T) => { clearTimeout(t); socket.off(event, h); resolve(v); };
    socket.on(event, h);
  });
}

async function nextState(socket: Socket, timeout = 1500): Promise<PublicGameState> {
  return once<PublicGameState>(socket, 'game:state', timeout);
}

interface Profile { id: number; username: string; rating: number; gamesPlayed: number; wins: number; draws: number; losses: number; }

async function register(port: number, username?: string, password = 'Tr0ub4dor&3'): Promise<{ cookie: string; user: Profile }> {
  const name = username ?? `u${1000 + userSeq++}`;
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, password }),
  });
  expect(res.status).toBe(201);
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(new RegExp(`${DEV_COOKIE_NAME}=([^;]+)`));
  if (!m) throw new Error('no session cookie set');
  const body = await res.json() as { user: Profile };
  return { cookie: m[1], user: body.user };
}

async function login(port: number, username: string, password: string): Promise<{ cookie: string; user: Profile }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(new RegExp(`${DEV_COOKIE_NAME}=([^;]+)`));
  if (!m) throw new Error('no session cookie set');
  const body = await res.json() as { user: Profile };
  return { cookie: m[1], user: body.user };
}

async function me(port: number, cookie: string): Promise<Profile | null> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
    headers: { Cookie: `${DEV_COOKIE_NAME}=${cookie}` },
  });
  if (res.status === 401) return null;
  const body = await res.json() as { user: Profile };
  return body.user;
}

async function makeMatchedGame(h: Harness, a: { cookie: string; user: Profile }, b: { cookie: string; user: Profile }) {
  const sa = connect(h.port, a.cookie); const sb = connect(h.port, b.cookie);
  await waitForConnect(sa); await waitForConnect(sb);
  const ma = once<MatchedPayload>(sa, 'matchmaking:matched');
  const mb = once<MatchedPayload>(sb, 'matchmaking:matched');
  const ja = await ack(sa.emitWithAck('matchmaking:join') as Promise<Result<{ queued: boolean }>>);
  const jb = await ack(sb.emitWithAck('matchmaking:join') as Promise<Result<{ queued: boolean }>>);
  expect(ja.ok).toBe(true);
  expect(jb.ok).toBe(true);
  const [pa, pb] = await Promise.all([ma, mb]);
  expect(pa.rated).toBe(true);
  expect(pb.rated).toBe(true);
  expect(pa.code).toBe(pb.code);
  const code = pa.code;
  const goldSocket = pa.seat === 'gold' ? sa : sb;
  const scarletSocket = pa.seat === 'gold' ? sb : sa;
  const goldToken = pa.seat === 'gold' ? pa.token : pb.token;
  const scarletToken = pa.seat === 'gold' ? pb.token : pa.token;
  const goldUser = pa.seat === 'gold' ? a.user : b.user;
  const scarletUser = pa.seat === 'gold' ? b.user : a.user;
  return { sa, sb, goldSocket, scarletSocket, code, goldToken, scarletToken, goldUser, scarletUser };
}

async function makeHostedGame(h: Harness, a: { cookie: string; user: Profile }, b: { cookie: string; user: Profile }) {
  const sa = connect(h.port, a.cookie); const sb = connect(h.port, b.cookie);
  await waitForConnect(sa); await waitForConnect(sb);
  const cr = await ack(sa.emitWithAck('game:create') as Promise<Result<JoinAck>>);
  if (!cr.ok) throw new Error('create failed');
  const code = cr.data.code;
  const jr = await ack(sb.emitWithAck('game:join', { code }) as Promise<Result<JoinAck>>);
  if (!jr.ok) throw new Error('join failed: ' + jr.error.message);
  return {
    sa, sb, code,
    goldToken: cr.data.token, scarletToken: jr.data.token,
    goldUser: a.user, scarletUser: b.user,
  };
}

let h: Harness;

beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.close(); });
afterEach(() => {
  for (const code of h.store.listCodes()) h.store.delete(code);
  h.matchQueue.clear();
});

describe('HTTP auth API', () => {
  test('register sets a cookie and /me returns the profile', async () => {
    const { cookie, user } = await register(h.port);
    expect(user.rating).toBe(1000);
    const m = await me(h.port, cookie);
    expect(m).not.toBeNull();
    expect(m!.username).toBe(user.username);
  });

  test('login with correct password succeeds; wrong password fails with generic error', async () => {
    const username = `bob${1000 + userSeq++}`;
    await register(h.port, username, 'Tr0ub4dor&3');
    const good = await login(h.port, username, 'Tr0ub4dor&3');
    expect(good.user.username).toBe(username);
    const bad = await fetch(`http://127.0.0.1:${h.port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'wrongpassword1' }),
    });
    expect(bad.status).toBe(401);
    const body = await bad.json() as any;
    expect(body.error.message).toBe('Invalid username or password');
    expect(body.error.message.toLowerCase()).not.toContain('exist');
  });

  test('login for a nonexistent user returns the same generic error (no enumeration)', async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `ghost${1000 + userSeq++}`, password: 'Tr0ub4dor&3' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('bad-credentials');
  });

  test('a legacy (Argon2) account is reset-required and cannot log in', async () => {
    const db = (h.repo as any).db;
    db.prepare(
      'INSERT INTO users(username, username_normalized, password_hash, rating, games_played, wins, draws, losses, requires_reset, created_at, updated_at) VALUES (?,?,?,?,0,0,0,0,1,?,?)',
    ).run('legacy1', 'legacy1', '$argon2id$v=19$m=65536$abc$def', 1000, Date.now(), Date.now());
    const res = await fetch(`http://127.0.0.1:${h.port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'legacy1', password: 'Tr0ub4dor&3' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error.code).toBe('reset-required');
  });

  test('register rejects a duplicate username (case-insensitive)', async () => {
    const name = `carol${1000 + userSeq++}`;
    await register(h.port, name, 'Tr0ub4dor&3');
    const res = await fetch(`http://127.0.0.1:${h.port}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name.toUpperCase(), password: 'Tr0ub4dor&3' }),
    });
    expect(res.status).toBe(409);
  });

  test('register rejects short passwords (<8) and bad usernames', async () => {
    const shortPw = await fetch(`http://127.0.0.1:${h.port}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `v${1000 + userSeq++}`, password: 'short' }),
    });
    expect(shortPw.status).toBe(400);
    const badUser = await fetch(`http://127.0.0.1:${h.port}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ab', password: 'Tr0ub4dor&3' }),
    });
    expect(badUser.status).toBe(400);
  });

  test('register accepts an 8-character password (min length 8, no composition rules)', async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `eight${1000 + userSeq++}`, password: '12345678' }),
    });
    expect(res.status).toBe(400);
    const res2 = await fetch(`http://127.0.0.1:${h.port}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `eightb${1000 + userSeq++}`, password: '8charpw!' }),
    });
    expect(res2.status).toBe(201);
  });

  test('logout expires the cookie and clears the session', async () => {
    const { cookie } = await register(h.port);
    expect(await me(h.port, cookie)).not.toBeNull();
    await fetch(`http://127.0.0.1:${h.port}/api/auth/logout`, {
      method: 'POST', headers: { Cookie: `${DEV_COOKIE_NAME}=${cookie}` },
    });
    expect(await me(h.port, cookie)).toBeNull();
  });

  test('the session cookie is HttpOnly; dev cookie has no __Host- prefix', async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `edy${1000 + userSeq++}`, password: 'Tr0ub4dor&3' }),
    });
    const setCookie = res.headers.get('set-cookie') || '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie.startsWith('__Host-')).toBe(false);
  });
});

describe('Socket.IO cookie auth + online play (all play is authenticated)', () => {
  test('unauthenticated sockets cannot create, join, or queue', async () => {
    const g = connect(h.port); await waitForConnect(g);
    const cr = await ack(g.emitWithAck('game:create') as Promise<Result<JoinAck>>);
    expect(cr.ok).toBe(false);
    if (!cr.ok) expect(cr.error.code).toBe('not-authenticated');
    const jr = await ack(g.emitWithAck('game:join', { code: 'AAAAAA' }) as Promise<Result<JoinAck>>);
    expect(jr.ok).toBe(false);
    if (!jr.ok) expect(jr.error.code).toBe('not-authenticated');
    const mj = await ack(g.emitWithAck('matchmaking:join') as Promise<Result<{ queued: boolean }>>);
    expect(mj.ok).toBe(false);
    if (!mj.ok) expect(mj.error.code).toBe('not-authenticated');
    g.disconnect();
  });

  test('a logged-in user is shown by username (server-derived, never a client payload)', async () => {
    const acc = await register(h.port);
    const g = connect(h.port, acc.cookie); await waitForConnect(g);
    const cr = await ack(g.emitWithAck('game:create') as Promise<Result<JoinAck>>);
    expect(cr.ok).toBe(true);
    if (!cr.ok) throw new Error('create failed');
    if (cr.ok) {
      expect(cr.data.state.players.gold.username).toBe(acc.user.username);
      expect(cr.data.state.players.gold.username).not.toBe('Impersonator');
    }
    const room = h.store.get(cr.data.code)!;
    expect(room.gold.userId).toBe(acc.user.id);
    expect(room.gold.userId).not.toBe(999999);
    g.disconnect();
  });

  test('an authenticated account cannot hold both seats', async () => {
    const acc = await register(h.port);
    const g = connect(h.port, acc.cookie); await waitForConnect(g);
    const cr = await ack(g.emitWithAck('game:create') as Promise<Result<JoinAck>>);
    if (!cr.ok) throw new Error('create failed');
    const g2 = connect(h.port, acc.cookie); await waitForConnect(g2);
    const jr = await ack(g2.emitWithAck('game:join', { code: cr.data.code }) as Promise<Result<JoinAck>>);
    expect(jr.ok).toBe(false);
    if (!jr.ok) expect(jr.error.code).toBe('same-account');
    g.disconnect(); g2.disconnect();
  });

  test('Host/Join games are unranked; Find Match is rated', async () => {
    const a = await register(h.port);
    const b = await register(h.port);
    const hosted = await makeHostedGame(h, a, b);
    const hRoom = h.store.get(hosted.code)!;
    expect(hRoom.rated).toBe(false);
    hosted.sa.disconnect(); hosted.sb.disconnect();
    for (const code of h.store.listCodes()) h.store.delete(code);
    const m = await makeMatchedGame(h, a, b);
    const mRoom = h.store.get(m.code)!;
    expect(mRoom.rated).toBe(true);
    m.sa.disconnect(); m.sb.disconnect();
  });

  test('a queued player cannot host or join until they cancel', async () => {
    const a = await register(h.port);
    const g = connect(h.port, a.cookie); await waitForConnect(g);
    const q = await ack(g.emitWithAck('matchmaking:join') as Promise<Result<{ queued: boolean }>>);
    expect(q.ok).toBe(true);
    if (q.ok) expect(q.data.queued).toBe(true);
    const cr = await ack(g.emitWithAck('game:create') as Promise<Result<JoinAck>>);
    expect(cr.ok).toBe(false);
    if (!cr.ok) expect(cr.error.code).toBe('already-queued');
    const jr = await ack(g.emitWithAck('game:join', { code: 'AAAAAA' }) as Promise<Result<JoinAck>>);
    expect(jr.ok).toBe(false);
    if (!jr.ok) expect(jr.error.code).toBe('already-queued');
    const c = await ack(g.emitWithAck('matchmaking:cancel') as Promise<Result<null>>);
    expect(c.ok).toBe(true);
    const cr2 = await ack(g.emitWithAck('game:create') as Promise<Result<JoinAck>>);
    expect(cr2.ok).toBe(true);
    g.disconnect();
  });

  test('matchmaking:status is emitted while waiting, then matchmaking:matched', async () => {
    const a = await register(h.port);
    const b = await register(h.port);
    const sa = connect(h.port, a.cookie); await waitForConnect(sa);
    const sb = connect(h.port, b.cookie); await waitForConnect(sb);
    const statusP = once<MatchmakingStatus>(sa, 'matchmaking:status', 3000);
    const matchedA = once<MatchedPayload>(sa, 'matchmaking:matched', 3000);
    const matchedB = once<MatchedPayload>(sb, 'matchmaking:matched', 3000);
    await ack(sa.emitWithAck('matchmaking:join') as Promise<Result<{ queued: boolean }>>);
    const st = await statusP;
    expect(st.waiting).toBe(true);
    expect(st.queueSize).toBeGreaterThanOrEqual(1);
    await ack(sb.emitWithAck('matchmaking:join') as Promise<Result<{ queued: boolean }>>);
    const [pa, pb] = await Promise.all([matchedA, matchedB]);
    expect(pa.code).toBe(pb.code);
    expect(pa.seat).not.toBe(pb.seat);
    expect(pa.rated).toBe(true);
    sa.disconnect(); sb.disconnect();
  });

  test('matchmaking:join matches two players and starts a rated game', async () => {
    const a = await register(h.port);
    const b = await register(h.port);
    const sa = connect(h.port, a.cookie); const sb = connect(h.port, b.cookie);
    await waitForConnect(sa); await waitForConnect(sb);
    const ma = once<MatchedPayload>(sa, 'matchmaking:matched', 3000);
    const mb = once<MatchedPayload>(sb, 'matchmaking:matched', 3000);
    await ack(sa.emitWithAck('matchmaking:join') as Promise<Result<{ queued: boolean }>>);
    await ack(sb.emitWithAck('matchmaking:join') as Promise<Result<{ queued: boolean }>>);
    const [pa, pb] = await Promise.all([ma, mb]);
    expect(pa.code).toBe(pb.code);
    expect(pa.seat).not.toBe(pb.seat);
    expect(pa.rated).toBe(true);
    expect(h.store.get(pa.code)!.rated).toBe(true);
    sa.disconnect(); sb.disconnect();
  });

  test('a rated (Find Match) game applies Elo exactly once and emits profile:refresh', async () => {
    const a = await register(h.port);
    const b = await register(h.port);
    const { goldSocket, scarletSocket, code, goldToken, goldUser, scarletUser } = await makeMatchedGame(h, a, b);

    const refreshP = once<ProfilePayload>(goldSocket, 'profile:refresh', 3000);
    await ack(goldSocket.emitWithAck('game:resign', { code, token: goldToken }) as Promise<Result<StateAck>>);
    const refreshed = await refreshP;
    expect(refreshed.id).toBe(goldUser.id);
    expect(refreshed.losses).toBe(1);
    expect(refreshed.rating).toBeLessThan(1000);

    const winnerCookie = scarletUser.id === a.user.id ? a.cookie : b.cookie;
    const winnerProfile = await me(h.port, winnerCookie);
    expect(winnerProfile!.wins).toBe(1);
    expect(winnerProfile!.rating).toBeGreaterThan(1000);

    const goldCookie = goldUser.id === a.user.id ? a.cookie : b.cookie;
    const ratingAfter = (await me(h.port, goldCookie))!.rating;
    const games = h.repo.history(goldUser.id, 1, 10);
    const rated = games.games.find((x) => x.rated);
    expect(rated).toBeDefined();
    expect(rated!.ratingAfter).toBe(ratingAfter);
    expect(rated!.ratingBefore).toBe(1000);

    goldSocket.disconnect(); scarletSocket.disconnect();
  });

  test('a Host/Join (unranked) game does NOT change ratings', async () => {
    const a = await register(h.port);
    const b = await register(h.port);
    const { sa, sb, code, goldToken } = await makeHostedGame(h, a, b);
    await ack(sa.emitWithAck('game:resign', { code, token: goldToken }) as Promise<Result<StateAck>>);
    sa.disconnect(); sb.disconnect();
    expect((await me(h.port, a.cookie))!.rating).toBe(1000);
    expect((await me(h.port, b.cookie))!.rating).toBe(1000);
    expect((await me(h.port, a.cookie))!.gamesPlayed).toBe(0);
  });

  test('a rematch is unranked even after a rated game (no farming)', async () => {
    const a = await register(h.port);
    const b = await register(h.port);
    const { goldSocket, scarletSocket, code, goldToken, scarletToken } = await makeMatchedGame(h, a, b);
    await ack(goldSocket.emitWithAck('game:resign', { code, token: goldToken }) as Promise<Result<StateAck>>);
    const before = (await me(h.port, a.cookie))!.rating;
    await ack(goldSocket.emitWithAck('game:rematch', { code, token: goldToken }) as Promise<Result<StateAck>>);
    await ack(scarletSocket.emitWithAck('game:rematch', { code, token: scarletToken }) as Promise<Result<StateAck>>);
    expect(h.store.get(code)!.rated).toBe(false);
    // rematch swaps seats, so the old scarlet socket now holds gold's token
    await ack(scarletSocket.emitWithAck('game:resign', { code, token: scarletToken }) as Promise<Result<StateAck>>);
    const after = (await me(h.port, a.cookie))!.rating;
    expect(after).toBe(before);
    goldSocket.disconnect(); scarletSocket.disconnect();
  });

  test('a client-submitted user id in the payload is ignored (cookie identity only)', async () => {
    const acc = await register(h.port);
    const g = connect(h.port, acc.cookie); await waitForConnect(g);
    const cr = await ack(g.emitWithAck('game:create') as Promise<Result<JoinAck>>);
    expect(cr.ok).toBe(true);
    if (!cr.ok) throw new Error('create failed');
    const room = h.store.get(cr.data.code)!;
    expect(room.gold.userId).toBe(acc.user.id);
    expect(room.gold.userId).not.toBe(999999);
    g.disconnect();
  });

  test('history API returns completed games only for the authenticated user', async () => {
    const a = await register(h.port);
    const b = await register(h.port);
    const { goldSocket, scarletSocket, code, goldToken } = await makeMatchedGame(h, a, b);
    await ack(goldSocket.emitWithAck('game:resign', { code, token: goldToken }) as Promise<Result<StateAck>>);
    goldSocket.disconnect(); scarletSocket.disconnect();

    const cookie = a.cookie;
    const res = await fetch(`http://127.0.0.1:${h.port}/api/profile/history?pageSize=10`, {
      headers: { Cookie: `${DEV_COOKIE_NAME}=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.games[0].rated).toBe(true);

    const unauth = await fetch(`http://127.0.0.1:${h.port}/api/profile/history`);
    expect(unauth.status).toBe(401);

    const other = await register(h.port);
    const otherRes = await fetch(`http://127.0.0.1:${h.port}/api/profile/history?pageSize=10`, {
      headers: { Cookie: `${DEV_COOKIE_NAME}=${other.cookie}` },
    });
    const otherBody = await otherRes.json() as any;
    expect(otherBody.total).toBe(0);
  });

  test('game detail API returns moves + final state to a participant only', async () => {
    const a = await register(h.port);
    const b = await register(h.port);
    const { goldSocket, scarletSocket, code, goldToken } = await makeMatchedGame(h, a, b);
    const room = h.store.get(code)!;
    const w = Object.values(room.position.pieces).find(p => p.color === 'gold' && p.type === 'warrior')!;
    const legal = generateLegalMoves(room.position, w.id)[0];
    await ack(goldSocket.emitWithAck('game:move', { code, token: goldToken, expectedVersion: room.version, pieceId: w.id, kind: legal.kind, from: legal.from, to: legal.to }) as Promise<Result<StateAck>>);
    await ack(goldSocket.emitWithAck('game:resign', { code, token: goldToken }) as Promise<Result<StateAck>>);
    goldSocket.disconnect(); scarletSocket.disconnect();

    const participantCookie = a.cookie;
    const gameId = h.repo.history(a.user.id, 1, 10).games[0].gameId;
    const detailRes = await fetch(`http://127.0.0.1:${h.port}/api/games/${gameId}`, {
      headers: { Cookie: `${DEV_COOKIE_NAME}=${participantCookie}` },
    });
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json() as any;
    expect(detail.moves.length).toBeGreaterThanOrEqual(1);

    const other = await register(h.port);
    const blocked = await fetch(`http://127.0.0.1:${h.port}/api/games/${gameId}`, {
      headers: { Cookie: `${DEV_COOKIE_NAME}=${other.cookie}` },
    });
    expect(blocked.status).toBe(404);
  });
});