import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { statSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { Server } from 'socket.io';
import type {
  ClientToServerEvents, ServerToClientEvents, JoinAck, Result, StateAck, Seat, ProfilePayload,
  MatchedPayload,
} from './types.js';
import { JoinError, RoomStore, StateError, isValidRoomCode, type SeatAuth } from './room-store.js';
import { opp } from './game-engine.js';
import { Repo, type PublicUser } from './repo.js';
import { openDb, inMemoryDb } from './db.js';
import { MatchmakingQueue, randomColour } from './matchmaking.js';
import {
  GENERIC_AUTH_ERROR, RateLimiter, SESSION_MAX_AGE,
  bcryptCost, bcryptCostOf, expiredSessionCookie, hashPassword, isProduction,
  normalizeUsername, readSessionCookie, sessionCookie, validatePassword, validateUsername,
  verifyPassword, passwordWarning, assertProductionAuthConfig,
} from './auth.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3543);
const NODE_ENV = process.env.NODE_ENV || 'development';
const PUBLIC_DIR = process.env.PUBLIC_DIR || '';
const PRODUCTION_ORIGIN = 'https://dragonchess.belch.dk';

// constant-time login for unknown users
const DUMMY_BCRYPT_HASH = '$2b$12$cntYbVxO/Qq2zZnbRABaweBXLZviz1svzcti6woyQbJ5wcxbXglcK';

const MATCHMAKING_DISCONNECT_GRACE_MS = 15_000;

export function resolveConfig(): { host: string; port: number; nodeEnv: string } {
  return {
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 3543),
    nodeEnv: process.env.NODE_ENV || 'development',
  };
}

const ALLOWED_ORIGINS: string[] = [PRODUCTION_ORIGIN];
if (NODE_ENV !== 'production') {
  ALLOWED_ORIGINS.push(
    'http://localhost:3543', 'http://127.0.0.1:3543',
    'http://localhost:5173', 'http://localhost:3000', 'http://localhost:8000',
    'http://127.0.0.1:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:8000',
  );
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export interface BuildServerOptions {
  store?: RoomStore;
  repo?: Repo;
  authRateLimits?: { ipMax?: number; userMax?: number };
}

export function buildServer(opts: BuildServerOptions = {}) {
  const store = opts.store ?? new RoomStore();
  const repo = opts.repo ?? new Repo(inMemoryDb());

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (url.startsWith('/api/')) {
      await apiRouter(req, res, url);
      return;
    }
    if (PUBLIC_DIR && (url === '/' || /\.[a-zA-Z0-9]+$/.test(url))) {
      serveStatic(req, res, url);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    path: '/socket.io/',
    cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'], credentials: true },
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: true,
    },
  });

  const ok = <T>(data: T): Result<T> => ({ ok: true, data });
  const fail = (code: string, message: string): Result<never> => ({ ok: false, error: { code, message } });

  const RL_WINDOW = 10_000;
  const RL_MAX = 6;
  const attempts = new WeakMap<object, number[]>();
  function rateLimited(socket: object): boolean {
    const now = Date.now();
    const arr = (attempts.get(socket) || []).filter(t => now - t < RL_WINDOW);
    arr.push(now);
    attempts.set(socket, arr);
    return arr.length > RL_MAX;
  }

  function broadcastState(roomCode: string, room: ReturnType<RoomStore['get']>) {
    if (!room) return;
    io.to(`room:${roomCode}`).emit('game:state', store.toPublicState(room));
  }

  function authSeat(code: unknown, token: unknown): { room: NonNullable<ReturnType<RoomStore['get']>>; seat: Seat } | { error: Result<never> } {
    if (typeof code !== 'string' || !isValidRoomCode(code)) return { error: fail('bad-code', 'Invalid room code.') };
    if (typeof token !== 'string' || token.length < 32) return { error: fail('bad-token', 'Invalid session token.') };
    const room = store.get(code);
    if (!room) return { error: fail('no-room', 'Room does not exist.') };
    const seat = store.resolveSeat(room, token);
    if (!seat) return { error: fail('bad-token', 'Invalid or expired session.') };
    return { room, seat };
  }

  const userSockets = new Map<number, Set<string>>();
  function trackUserSocket(userId: number, socketId: string) {
    let set = userSockets.get(userId);
    if (!set) { set = new Set(); userSockets.set(userId, set); }
    set.add(socketId);
  }
  function untrackUserSocket(userId: number, socketId: string) {
    const set = userSockets.get(userId);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) userSockets.delete(userId);
  }
  function emitProfileRefresh(user: PublicUser) {
    const set = userSockets.get(user.id);
    if (!set) return;
    const payload: ProfilePayload = {
      id: user.id, username: user.username, rating: user.rating,
      gamesPlayed: user.gamesPlayed, wins: user.wins, draws: user.draws, losses: user.losses,
    };
    for (const sid of set) io.to(sid).emit('profile:refresh', payload);
  }

  io.use((socket, next) => {
    try {
      const raw = readSessionCookie(socket.handshake.headers.cookie);
      if (raw) {
        const resolved = repo.resolveSession(raw, SESSION_MAX_AGE * 1000);
        if (resolved) {
          socket.data.userId = resolved.user.id;
          socket.data.username = resolved.user.username;
          socket.data.user = resolved.user;
          trackUserSocket(resolved.user.id, socket.id);
        }
      }
    } catch {}
    next();
  });

  const matchQueue = new MatchmakingQueue();
  const matchRemovalTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let statusTimer: ReturnType<typeof setInterval> | null = null;

  function emitMatchStatus(userId: number) {
    const e = matchQueue.entry(userId);
    if (!e) return;
    const sid = e.socketId;
    io.to(sid).emit('matchmaking:status', {
      waiting: true,
      queueSize: matchQueue.size(),
      elapsedMs: Date.now() - e.joinedAt,
    });
  }

  function clearMatchRemoval(userId: number) {
    const t = matchRemovalTimers.get(userId);
    if (t) { clearTimeout(t); matchRemovalTimers.delete(userId); }
  }

  function createMatchedGame(a: { userId: number; socketId: string }, b: { userId: number; socketId: string }) {
    const userA = repo.publicUserById(a.userId);
    const userB = repo.publicUserById(b.userId);
    if (!userA || !userB) return;
    const goldIsA = randomColour() === 'gold';
    const goldUser = goldIsA ? userA : userB;
    const scarletUser = goldIsA ? userB : userA;
    const goldSid = goldIsA ? a.socketId : b.socketId;
    const scarletSid = goldIsA ? b.socketId : a.socketId;

    const { room, token: goldToken } = store.createRoom(goldUser.username, { user: goldUser }, true);
    const { token: scarletToken } = store.joinRoom(room, scarletUser.username, { user: scarletUser });
    store.startGame(room);
    persistGameStart(room);

    const goldSocket = io.sockets.sockets.get(goldSid);
    const scarletSocket = io.sockets.sockets.get(scarletSid);
    if (goldSocket) { goldSocket.join(`room:${room.code}`); store.connectSeat(room, 'gold', goldSid); }
    if (scarletSocket) { scarletSocket.join(`room:${room.code}`); store.connectSeat(room, 'scarlet', scarletSid); }

    const state = store.toPublicState(room);
    const goldPayload: MatchedPayload = { code: room.code, token: goldToken, seat: 'gold', state, rated: true };
    const scarletPayload: MatchedPayload = { code: room.code, token: scarletToken, seat: 'scarlet', state, rated: true };
    io.to(goldSid).emit('matchmaking:matched', goldPayload);
    io.to(scarletSid).emit('matchmaking:matched', scarletPayload);
  }

  statusTimer = setInterval(() => {
    for (const e of matchQueue.snapshot()) emitMatchStatus(e.userId);
  }, 1000);
  if (typeof statusTimer.unref === 'function') statusTimer.unref();

  function persistGameStart(room: ReturnType<RoomStore['get']>) {
    if (!room) return;
    const gameId = repo.startGame({
      roomCode: room.code,
      goldUserId: room.gold.userId,
      scarletUserId: room.scarlet.userId,
      goldName: room.gold.name,
      scarletName: room.scarlet.name,
      rated: room.rated,
      rematchOf: room.rematchOf,
    });
    room.gameId = gameId;
  }

  function persistMove(room: NonNullable<ReturnType<RoomStore['get']>>, colour: Seat, notation: string, lastMove: string, moveJson: string) {
    if (room.gameId == null) return;
    repo.recordMove(room.gameId, room.moveHistory.length - 1, colour, notation, lastMove, moveJson, room.version);
  }

  function persistGameFinish(room: NonNullable<ReturnType<RoomStore['get']>>) {
    if (room.gameId == null) return;
    const finalStateJson = JSON.stringify(store.toPublicState(room));
    repo.finishGame(room.gameId, room.winner, room.resultReason || '', finalStateJson);
    const { applied, result } = repo.applyRatingIfEligible(room.gameId);
    console.log(JSON.stringify({
      event: 'rating',
      gameId: room.gameId,
      rated: room.rated,
      winner: room.winner,
      goldUserId: room.gold.userId,
      scarletUserId: room.scarlet.userId,
      applied,
      result: result ? { aBefore: result.aBefore, aAfter: result.aAfter, bBefore: result.bBefore, bAfter: result.bAfter } : null,
    }));
    if (applied) {
      if (room.gold.userId != null) { const u = repo.publicUserById(room.gold.userId); if (u) emitProfileRefresh(u); }
      if (room.scarlet.userId != null) { const u = repo.publicUserById(room.scarlet.userId); if (u) emitProfileRefresh(u); }
    }
  }

  io.on('connection', (socket) => {
    const user: PublicUser | null = typeof socket.data.user === 'object' ? socket.data.user : null;
    const seatAuth: SeatAuth = { user };

    socket.on('game:create', (ack) => {
      if (typeof ack !== 'function') return;
      if (!user) { ack(fail('not-authenticated', 'Sign in required.')); return; }
      if (matchQueue.has(user.id)) { ack(fail('already-queued', 'Cancel matchmaking first.')); return; }
      if (rateLimited(socket)) { ack(fail('rate-limited', 'Too many requests. Slow down.')); return; }
      try {
        const { room, token, seat } = store.createRoom(user.username, seatAuth, false);
        socket.join(`room:${room.code}`);
        store.connectSeat(room, 'gold', socket.id);
        const data: JoinAck = { code: room.code, token, seat, state: store.toPublicState(room) };
        ack(ok(data));
        broadcastState(room.code, store.get(room.code));
      } catch {
        ack(fail('server-error', 'Could not create room.'));
      }
    });

    socket.on('game:join', (p, ack) => {
      if (typeof ack !== 'function') return;
      if (!user) { ack(fail('not-authenticated', 'Sign in required.')); return; }
      if (matchQueue.has(user.id)) { ack(fail('already-queued', 'Cancel matchmaking first.')); return; }
      if (rateLimited(socket)) { ack(fail('rate-limited', 'Too many requests. Slow down.')); return; }
      const code = typeof p?.code === 'string' ? p.code.toUpperCase().trim() : '';
      if (!isValidRoomCode(code)) { ack(fail('bad-code', 'Enter a 6-character game code.')); return; }
      const room = store.get(code);
      if (!room) { ack(fail('no-room', 'Room does not exist.')); return; }
      try {
        const { token, seat } = store.joinRoom(room, user.username, seatAuth);
        socket.join(`room:${room.code}`);
        store.connectSeat(room, seat, socket.id);
        if (room.status === 'lobby' && room.gold.tokenHash && room.scarlet.tokenHash) {
          store.startGame(room);
          persistGameStart(room);
        }
        const data: JoinAck = { code: room.code, token, seat, state: store.toPublicState(room) };
        ack(ok(data));
        broadcastState(room.code, store.get(room.code));
      } catch (e) {
        const c = e instanceof JoinError ? e.code : 'cannot-join';
        const msg = e instanceof Error ? e.message : 'Cannot join room.';
        ack(fail(c, msg));
      }
    });

    socket.on('game:resume', (p, ack) => {
      if (typeof ack !== 'function') return;
      const res = authSeat(p?.code, p?.token);
      if ('error' in res) { ack(res.error); return; }
      const { room, seat } = res;
      store.connectSeat(room, seat, socket.id);
      socket.join(`room:${room.code}`);
      const data: JoinAck = { code: room.code, token: typeof p?.token === 'string' ? p.token : '', seat, state: store.toPublicState(room) };
      ack(ok(data));
      broadcastState(room.code, store.get(room.code));
    });

    socket.on('game:move', (p, ack) => {
      if (typeof ack !== 'function') return;
      const res = authSeat(p?.code, p?.token);
      if ('error' in res) { ack(res.error); return; }
      const { room, seat } = res;
      if (typeof p?.expectedVersion !== 'number' || !Number.isFinite(p.expectedVersion)) { ack(fail('bad-version', 'Missing expected version.')); return; }
      if (typeof p?.pieceId !== 'string' || !p.pieceId) { ack(fail('bad-piece', 'Missing piece id.')); return; }
      if (p?.kind !== 'move' && p?.kind !== 'remoteCapture') { ack(fail('bad-kind', 'Bad move kind.')); return; }
      const from = p?.from, to = p?.to;
      if (!isCoord(from) || !isCoord(to)) { ack(fail('bad-coord', 'Bad from/to.')); return; }
      try {
        const { matched } = store.applyMove(room, seat, { expectedVersion: p.expectedVersion, pieceId: p.pieceId, kind: p.kind, from: from!, to: to! });
        const last = room.moveHistory[room.moveHistory.length - 1];
        // turn has already flipped to the opponent
        const moverColour: Seat = room.turn === 'gold' ? 'scarlet' : 'gold';
        const notation = last ? last.notation : '';
        const lastMove = last ? last.lastMove : notation;
        persistMove(room, moverColour, notation, lastMove, last ? JSON.stringify(last) : JSON.stringify(matched));
        if (room.status === 'finished') persistGameFinish(room);
        const data: StateAck = { state: store.toPublicState(room), seat };
        ack(ok(data));
        broadcastState(room.code, store.get(room.code));
      } catch (e) {
        const c = e instanceof StateError ? e.code : 'illegal-move';
        const msg = e instanceof Error ? e.message : 'Move rejected.';
        ack(fail(c, msg));
      }
    });

    socket.on('game:resign', (p, ack) => {
      if (typeof ack !== 'function') return;
      const res = authSeat(p?.code, p?.token);
      if ('error' in res) { ack(res.error); return; }
      const { room, seat } = res;
      try {
        store.resign(room, seat);
        persistGameFinish(room);
        const data: StateAck = { state: store.toPublicState(room), seat };
        ack(ok(data));
        broadcastState(room.code, store.get(room.code));
      } catch (e) {
        const c = e instanceof StateError ? e.code : 'cannot-resign';
        ack(fail(c, e instanceof Error ? e.message : 'Cannot resign.'));
      }
    });

    socket.on('draw:offer', (p, ack) => {
      if (typeof ack !== 'function') return;
      const res = authSeat(p?.code, p?.token);
      if ('error' in res) { ack(res.error); return; }
      const { room, seat } = res;
      try {
        store.offerDraw(room, seat);
        const data: StateAck = { state: store.toPublicState(room), seat };
        ack(ok(data));
        broadcastState(room.code, store.get(room.code));
      } catch (e) {
        ack(fail(e instanceof StateError ? e.code : 'cannot-offer', e instanceof Error ? e.message : 'Cannot offer draw.'));
      }
    });

    socket.on('draw:answer', (p, ack) => {
      if (typeof ack !== 'function') return;
      const res = authSeat(p?.code, p?.token);
      if ('error' in res) { ack(res.error); return; }
      const { room, seat } = res;
      const accept = p?.accept === true;
      try {
        store.answerDraw(room, seat, accept);
        if (room.status === 'finished') persistGameFinish(room);
        const data: StateAck = { state: store.toPublicState(room), seat };
        ack(ok(data));
        broadcastState(room.code, store.get(room.code));
      } catch (e) {
        ack(fail(e instanceof StateError ? e.code : 'cannot-answer', e instanceof Error ? e.message : 'Cannot answer draw.'));
      }
    });

    socket.on('game:rematch', (p, ack) => {
      if (typeof ack !== 'function') return;
      const res = authSeat(p?.code, p?.token);
      if ('error' in res) { ack(res.error); return; }
      const { room, seat } = res;
      try {
        const started = store.requestRematch(room, seat);
        if (started) {
          persistGameStart(room);
        }
        const newSeat: Seat = started ? opp(seat) : seat;
        const data: StateAck = { state: store.toPublicState(room), seat: newSeat };
        ack(ok(data));
        broadcastState(room.code, store.get(room.code));
      } catch (e) {
        ack(fail(e instanceof StateError ? e.code : 'cannot-rematch', e instanceof Error ? e.message : 'Cannot rematch.'));
      }
    });

    socket.on('game:rematch:cancel', (p, ack) => {
      if (typeof ack !== 'function') return;
      const res = authSeat(p?.code, p?.token);
      if ('error' in res) { ack(res.error); return; }
      const { room, seat } = res;
      store.cancelRematch(room, seat);
      broadcastState(room.code, store.get(room.code));
      ack(ok(null));
    });

    socket.on('game:leave', (p, ack) => {
      if (typeof ack !== 'function') return;
      const res = authSeat(p?.code, p?.token);
      if ('error' in res) { ack(res.error); return; }
      const { room, seat } = res;
      try { store.leaveLobby(room, seat); } catch {}
      socket.leave(`room:${room.code}`);
      const maybeEmpty = store.get(room.code);
      if (maybeEmpty && store.maybeDeleteEmpty(maybeEmpty)) {
        // room gone
      } else if (maybeEmpty) {
        broadcastState(room.code, maybeEmpty);
      }
      ack(ok(null));
    });

    socket.on('matchmaking:join', (ack) => {
      if (typeof ack !== 'function') return;
      if (!user) { ack(fail('not-authenticated', 'Sign in required.')); return; }
      if (matchQueue.has(user.id)) {
        matchQueue.relink(user.id, socket.id);
        clearMatchRemoval(user.id);
        ack(ok({ queued: true }));
        emitMatchStatus(user.id);
        return;
      }
      if (rateLimited(socket)) { ack(fail('rate-limited', 'Too many requests. Slow down.')); return; }
      matchQueue.add(user.id, user.rating, socket.id);
      const pair = matchQueue.tryMatch(user.id);
      if (pair) {
        createMatchedGame(pair.a, pair.b);
        ack(ok({ queued: false }));
      } else {
        ack(ok({ queued: true }));
        emitMatchStatus(user.id);
      }
    });

    socket.on('matchmaking:cancel', (ack) => {
      if (typeof ack !== 'function') return;
      if (user) {
        matchQueue.remove(user.id);
        clearMatchRemoval(user.id);
      }
      ack(ok(null));
    });

    socket.on('disconnect', () => {
      if (user) {
        untrackUserSocket(user.id, socket.id);
        if (matchQueue.has(user.id)) {
          const t = setTimeout(() => {
            matchQueue.remove(user.id);
            matchRemovalTimers.delete(user.id);
          }, MATCHMAKING_DISCONNECT_GRACE_MS);
          if (typeof t.unref === 'function') t.unref();
          matchRemovalTimers.set(user.id, t);
        }
      }
      for (const room of iterRooms(store)) {
        if (room.gold.socketIds.delete(socket.id)) store.disconnectSeat(room, 'gold', socket.id);
        if (room.scarlet.socketIds.delete(socket.id)) store.disconnectSeat(room, 'scarlet', socket.id);
        if (room.gold.socketIds.size === 0 || room.scarlet.socketIds.size === 0) {
          broadcastState(room.code, store.get(room.code));
        }
      }
    });
  });

  const authIpLimiter = new RateLimiter(60_000, opts.authRateLimits?.ipMax ?? 20);
  const authUserLimiter = new RateLimiter(60_000, opts.authRateLimits?.userMax ?? 10);

  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  function readJsonBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 8192) { (req as any).destroy(); resolve(null); } });
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }

  function authedUser(req: IncomingMessage): PublicUser | null {
    const raw = readSessionCookie(req.headers.cookie);
    if (!raw) return null;
    try {
      const resolved = repo.resolveSession(raw, SESSION_MAX_AGE * 1000);
      return resolved ? resolved.user : null;
    } catch {
      return null;
    }
  }

  function publicUserJson(u: PublicUser) {
    return {
      id: u.id, username: u.username, rating: u.rating,
      gamesPlayed: u.gamesPlayed, wins: u.wins, draws: u.draws, losses: u.losses,
    };
  }

  async function apiRouter(req: IncomingMessage, res: ServerResponse, url: string) {
    const method = req.method || 'GET';

    if (url === '/api/auth/register' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body) return json(res, 400, { error: { code: 'bad-request', message: 'Invalid JSON.' } });
      const ip = clientIp(req);
      if (!authIpLimiter.check(`ip:${ip}`)) return json(res, 429, { error: { code: 'rate-limited', message: 'Too many attempts. Try again later.' } });
      const u = validateUsername(body.username);
      if (!u.ok) return json(res, 400, { error: { code: u.code, message: u.message } });
      const p = validatePassword(body.password);
      if (!p.ok) return json(res, 400, { error: { code: p.code, message: p.message } });
      const normalized = normalizeUsername(u.value);
      if (!authUserLimiter.check(`user:${normalized}`)) return json(res, 429, { error: { code: 'rate-limited', message: 'Too many attempts. Try again later.' } });
      if (repo.usernameExists(normalized)) return json(res, 409, { error: { code: 'username-taken', message: 'That username is taken.' } });
      try {
        const hash = await hashPassword(body.password);
        const user = repo.createUser(u.value, normalized, hash);
        const { raw } = repo.createSession(user.id, SESSION_MAX_AGE * 1000);
        res.setHeader('Set-Cookie', sessionCookie(raw));
        const warning = passwordWarning(body.password);
        return json(res, 201, { user: publicUserJson(user), ...(warning ? { warning } : {}) });
      } catch {
        return json(res, 500, { error: { code: 'server-error', message: 'Could not create account.' } });
      }
    }

    if (url === '/api/auth/login' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body) return json(res, 400, { error: { code: 'bad-request', message: 'Invalid JSON.' } });
      const ip = clientIp(req);
      if (!authIpLimiter.check(`ip:${ip}`)) return json(res, 429, { error: { code: 'rate-limited', message: 'Too many attempts. Try again later.' } });
      const u = validateUsername(body.username);
      const p = validatePassword(body.password);
      if (!u.ok || !p.ok) return json(res, 400, { error: { code: 'bad-credentials', message: GENERIC_AUTH_ERROR } });
      const normalized = normalizeUsername(u.value);
      if (!authUserLimiter.check(`user:${normalized}`)) return json(res, 429, { error: { code: 'rate-limited', message: 'Too many attempts. Try again later.' } });
      const creds = repo.getCredentials(normalized);
      const valid = creds ? await verifyPassword(creds.passwordHash, body.password) : await verifyPassword(DUMMY_BCRYPT_HASH, body.password);
      if (!creds) return json(res, 401, { error: { code: 'bad-credentials', message: GENERIC_AUTH_ERROR } });
      if (creds.requiresReset) return json(res, 403, { error: { code: 'reset-required', message: 'Your password must be reset by an administrator.' } });
      if (!valid) return json(res, 401, { error: { code: 'bad-credentials', message: GENERIC_AUTH_ERROR } });
      const user = repo.publicUserById(creds.id);
      if (!user) return json(res, 401, { error: { code: 'bad-credentials', message: GENERIC_AUTH_ERROR } });
      try {
        const storedCost = bcryptCostOf(creds.passwordHash);
        if (Number.isFinite(storedCost) && storedCost < bcryptCost()) {
          const upgraded = await hashPassword(body.password);
          repo.updatePasswordHash(creds.id, upgraded);
        }
      } catch {}
      const { raw } = repo.createSession(user.id, SESSION_MAX_AGE * 1000);
      res.setHeader('Set-Cookie', sessionCookie(raw));
      return json(res, 200, { user: publicUserJson(user) });
    }

    if (url === '/api/auth/logout' && method === 'POST') {
      const raw = readSessionCookie(req.headers.cookie);
      if (raw) {
        try {
          const resolved = repo.resolveSession(raw, SESSION_MAX_AGE * 1000);
          if (resolved) repo.deleteSession(resolved.session.tokenHash);
        } catch {}
      }
      res.setHeader('Set-Cookie', expiredSessionCookie());
      return json(res, 200, { ok: true });
    }

    if (url === '/api/auth/me' && method === 'GET') {
      const user = authedUser(req);
      if (!user) return json(res, 401, { error: { code: 'not-authenticated', message: 'Not signed in.' } });
      return json(res, 200, { user: publicUserJson(user) });
    }

    if (url === '/api/auth/change-password' && method === 'POST') {
      const user = authedUser(req);
      if (!user) return json(res, 401, { error: { code: 'not-authenticated', message: 'Sign in to change your password.' } });
      const body = await readJsonBody(req);
      if (!body) return json(res, 400, { error: { code: 'bad-request', message: 'Invalid JSON.' } });
      const ip = clientIp(req);
      if (!authIpLimiter.check(`ip:${ip}`)) return json(res, 429, { error: { code: 'rate-limited', message: 'Too many attempts. Try again later.' } });
      if (typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
        return json(res, 400, { error: { code: 'bad-request', message: 'Missing current or new password.' } });
      }
      const np = validatePassword(body.newPassword);
      if (!np.ok) return json(res, 400, { error: { code: np.code, message: np.message } });
      if (body.newPassword === body.currentPassword) {
        return json(res, 400, { error: { code: 'same-password', message: 'New password must differ from the current one.' } });
      }
      const creds = repo.getCredentials(user.username.toLowerCase());
      const valid = creds ? await verifyPassword(creds.passwordHash, body.currentPassword) : await verifyPassword(DUMMY_BCRYPT_HASH, body.currentPassword);
      if (!creds || creds.requiresReset || !valid) {
        return json(res, 401, { error: { code: 'bad-credentials', message: 'Current password is incorrect.' } });
      }
      try {
        const newHash = await hashPassword(body.newPassword);
        repo.updatePasswordHash(creds.id, newHash);
        const { raw } = repo.createSession(creds.id, SESSION_MAX_AGE * 1000);
        res.setHeader('Set-Cookie', sessionCookie(raw));
        const warning = passwordWarning(body.newPassword);
        return json(res, 200, { ok: true, ...(warning ? { warning } : {}) });
      } catch {
        return json(res, 500, { error: { code: 'server-error', message: 'Could not update password.' } });
      }
    }

    if (url === '/api/profile/history' && method === 'GET') {
      const user = authedUser(req);
      if (!user) return json(res, 401, { error: { code: 'not-authenticated', message: 'Not signed in.' } });
      const qp = new URL(req.url || '', 'http://localhost').searchParams;
      const page = Math.max(1, parseInt(qp.get('page') || '1', 10) || 1);
      const pageSize = Math.max(1, Math.min(100, parseInt(qp.get('pageSize') || '20', 10) || 20));
      const { total, games } = repo.history(user.id, page, pageSize);
      return json(res, 200, { total, page, pageSize, games });
    }

    if (url.startsWith('/api/games/') && method === 'GET') {
      const user = authedUser(req);
      if (!user) return json(res, 401, { error: { code: 'not-authenticated', message: 'Not signed in.' } });
      const gameId = parseInt(url.slice('/api/games/'.length), 10);
      if (!Number.isFinite(gameId) || gameId <= 0) return json(res, 400, { error: { code: 'bad-game-id', message: 'Invalid game id.' } });
      const detail = repo.gameForUser(gameId, user.id);
      if (!detail) return json(res, 404, { error: { code: 'not-found', message: 'Game not found.' } });
      return json(res, 200, { game: detail.game, moves: detail.moves, finalState: detail.finalState });
    }

    return json(res, 404, { error: { code: 'not-found', message: 'Unknown API endpoint.' } });
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, url: string) {
    let rel = url === '/' ? 'index.html' : url.slice(1);
    rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const abs = join(PUBLIC_DIR, rel);
    if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
    try {
      const stat = statSync(abs);
      if (stat.isDirectory()) { serveStatic(req, res, '/'); return; }
      const body = readFileSync(abs);
      res.writeHead(200, { 'Content-Type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  }

  return { httpServer, io, store, repo, matchQueue };
}

function isCoord(v: unknown): v is { level: number; file: number; rank: number } {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return typeof c.level === 'number' && typeof c.file === 'number' && typeof c.rank === 'number'
    && Number.isFinite(c.level) && Number.isFinite(c.file) && Number.isFinite(c.rank);
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd && !isProduction()) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function* iterRooms(store: RoomStore): Generator<NonNullable<ReturnType<RoomStore['get']>>> {
  for (const code of store.listCodes()) {
    const room = store.get(code);
    if (room) yield room;
  }
}

export function startServer() {
  assertProductionAuthConfig();
  const repo = new Repo(openDb());
  const { httpServer, store } = buildServer({ repo });
  httpServer.listen(PORT, HOST, () => {
    console.log(`dragonchess-server listening on http://${HOST}:${PORT} (${NODE_ENV})`);
  });
  const shutdown = () => { store.close(); httpServer.close(() => process.exit(0)); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return { httpServer, store, repo };
}

const invoked = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();
if (invoked) startServer();