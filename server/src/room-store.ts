import { createHash, randomBytes } from 'node:crypto';
import type {
  Color, GameStatus, HistoryEntry, PublicGameState, PublicPlayer, Seat, State,
} from './types.js';
import type { PublicUser } from './repo.js';
import {
  applyMoveImmutable, createInitialState, formatMoveNotation, generateLegalMoves,
  getGameOutcome, LEVEL_NAME, opp, serializeState,
} from './game-engine.js';
import type { Move } from './types.js';

export const SCHEMA_VERSION = 1;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LEN = 6;
const MAX_HISTORY = 1000;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

export interface SeatRecord {
  tokenHash: string | null;
  name: string;
  userId: number | null;
  username: string | null;
  rating: number;
  wins: number;
  draws: number;
  losses: number;
  connected: boolean;
  lastSeen: number;
  socketIds: Set<string>;
}

export interface Room {
  schemaVersion: number;
  code: string;
  createdAt: number;
  updatedAt: number;
  status: GameStatus;
  turn: Color;
  version: number;
  position: State;
  moveHistory: HistoryEntry[];
  drawOfferBy: Color | null;
  winner: Color | null;
  resultReason: string | null;
  rematchCount: number;
  rematchRequests: Record<Seat, boolean>;
  lastMove: string;
  gold: SeatRecord;
  scarlet: SeatRecord;
  gameId: number | null;
  rematchOf: number | null;
  rated: boolean;
}

export interface SanitizedRoom {
  room: Room;
  seat: Seat | null;
}

export interface SeatAuth {
  user: PublicUser | null;
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function generateRoomCode(existing: Set<string>): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let s = '';
    const bytes = randomBytes(ROOM_CODE_LEN);
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      s += ROOM_CODE_CHARS[bytes[i] % ROOM_CODE_CHARS.length];
    }
    if (!existing.has(s)) return s;
  }
  throw new Error('Could not generate a unique room code');
}

export function isValidRoomCode(code: string): boolean {
  return /^[A-Z2-9]{6}$/.test(code);
}

export function clampName(n: unknown): string {
  const s = (n == null ? '' : String(n)).replace(/\s+/g, ' ').trim().slice(0, 20);
  return s || 'Player';
}

const EMPTY_SEAT = (): SeatRecord => ({
  tokenHash: null, name: '—', userId: null, username: null,
  rating: 0, wins: 0, draws: 0, losses: 0,
  connected: false, lastSeen: 0, socketIds: new Set(),
});

function seatFromAuth(name: string, user: PublicUser | null): SeatRecord {
  const display = user ? user.username : clampName(name);
  return {
    tokenHash: null,
    name: display,
    userId: user ? user.id : null,
    username: user ? user.username : null,
    rating: user ? user.rating : 0,
    wins: user ? user.wins : 0,
    draws: user ? user.draws : 0,
    losses: user ? user.losses : 0,
    connected: false, lastSeen: Date.now(), socketIds: new Set(),
  };
}

export class RoomStore {
  private rooms = new Map<string, Room>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.evictStale(), 60 * 60 * 1000);
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref();
  }

  private codes(): Set<string> {
    return new Set(this.rooms.keys());
  }

  createRoom(name: string, auth: SeatAuth = { user: null }, rated: boolean = false): { room: Room; token: string; seat: Seat } {
    const code = generateRoomCode(this.codes());
    const token = generateToken();
    const now = Date.now();
    const init = createInitialState();
    const gold = seatFromAuth(name, auth.user);
    gold.tokenHash = hashToken(token);
    const room: Room = {
      schemaVersion: SCHEMA_VERSION, code, createdAt: now, updatedAt: now,
      status: 'lobby', turn: 'gold', version: 0, position: init, moveHistory: [],
      drawOfferBy: null, winner: null, resultReason: null, rematchCount: 0,
      rematchRequests: { gold: false, scarlet: false }, lastMove: '',
      gold, scarlet: EMPTY_SEAT(),
      gameId: null, rematchOf: null, rated,
    };
    this.rooms.set(code, room);
    return { room, token, seat: 'gold' };
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  resolveSeat(room: Room, rawToken: string): Seat | null {
    if (!rawToken) return null;
    const h = hashToken(rawToken);
    if (room.gold.tokenHash && room.gold.tokenHash === h) return 'gold';
    if (room.scarlet.tokenHash && room.scarlet.tokenHash === h) return 'scarlet';
    return null;
  }

  joinRoom(room: Room, name: string, auth: SeatAuth = { user: null }): { token: string; seat: Seat } {
    if (room.status !== 'lobby') throw new JoinError('room-started', 'Game already started.');
    if (room.scarlet.tokenHash) throw new JoinError('room-full', 'Room is full.');
    if (!auth.user) throw new JoinError('not-authenticated', 'Sign in required.');
    if (room.gold.userId === auth.user.id) {
      throw new JoinError('same-account', 'You are already in this room.');
    }
    const token = generateToken();
    const scarlet = seatFromAuth(name, auth.user);
    scarlet.tokenHash = hashToken(token);
    room.scarlet = scarlet;
    room.updatedAt = Date.now();
    return { token, seat: 'scarlet' };
  }

  connectSeat(room: Room, seat: Seat, socketId: string): void {
    const rec = room[seat];
    rec.socketIds.add(socketId);
    rec.connected = rec.socketIds.size > 0;
    rec.lastSeen = Date.now();
    room.updatedAt = Date.now();
  }

  disconnectSeat(room: Room, seat: Seat, socketId: string): void {
    const rec = room[seat];
    rec.socketIds.delete(socketId);
    rec.connected = rec.socketIds.size > 0;
    room.updatedAt = Date.now();
  }

  startGame(room: Room): void {
    if (room.status !== 'lobby') throw new StateError('not-in-lobby', 'Game is not in the lobby.');
    if (!room.gold.tokenHash || !room.scarlet.tokenHash) throw new StateError('not-ready', 'Both players must be present.');
    if (room.gold.userId == null || room.scarlet.userId == null) throw new StateError('not-authenticated', 'Both players must be signed in.');
    if (room.gold.userId === room.scarlet.userId) throw new StateError('same-account', 'Players must be different accounts.');
    room.status = 'active';
    room.updatedAt = Date.now();
  }

  applyMove(
    room: Room,
    seat: Seat,
    payload: { expectedVersion: number; pieceId: string; kind: string; from: { level: number; file: number; rank: number }; to: { level: number; file: number; rank: number } },
  ): { matched: Move } {
    if (room.status !== 'active') throw new StateError('not-active', 'Game is not active.');
    if (room.turn !== seat) throw new StateError('not-your-turn', 'It is not your turn.');
    if (room.version !== payload.expectedVersion) throw new StateError('stale-version', 'Game state changed; reload.');
    const piece = room.position.pieces[payload.pieceId];
    if (!piece) throw new StateError('bad-piece', 'No such piece.');
    if (piece.color !== seat) throw new StateError('not-your-piece', 'That is not your piece.');
    if (payload.kind !== 'move' && payload.kind !== 'remoteCapture') throw new StateError('bad-kind', 'Bad move kind.');
    const legal = generateLegalMoves(room.position, payload.pieceId);
    const match = legal.find(m =>
      m.kind === payload.kind &&
      m.from.level === payload.from.level && m.from.file === payload.from.file && m.from.rank === payload.from.rank &&
      m.to.level === payload.to.level && m.to.file === payload.to.file && m.to.rank === payload.to.rank,
    );
    if (!match) throw new StateError('illegal-move', 'Illegal move.');
    const moverSeat: Seat = room.position.turn;
    const moverUsername = room[moverSeat]?.username || room[moverSeat]?.name || 'Unknown';
    const moverUserId = room[moverSeat]?.userId != null ? String(room[moverSeat]!.userId) : null;
    const notation = formatMoveNotation(room.position, match, moverUsername);
    const moverPiece = room.position.pieces[match.pieceId];
    const capturedPiece = match.capturedPieceId ? room.position.pieces[match.capturedPieceId] : null;
    const next = applyMoveImmutable(room.position, match);
    const entry: HistoryEntry = {
      color: room.position.turn, notation, lastMove: notation, version: next.version, from: match.from, to: match.to,
      moverUserId, moverUsername,
      moverColor: room.position.turn,
      pieceType: moverPiece?.type || null,
      capturedType: capturedPiece?.type || null,
      moveKind: match.kind,
      promotion: match.promotion || null,
      realm: match.from.level !== match.to.level
        ? `${LEVEL_NAME[match.from.level]}→${LEVEL_NAME[match.to.level]}`
        : LEVEL_NAME[match.from.level],
      fromRealm: match.from.level,
      toRealm: match.to.level,
      at: Date.now(),
    };
    const history = room.moveHistory.concat([entry]);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    room.moveHistory = history;
    room.lastMove = notation;
    const outcome = getGameOutcome(next);
    if (outcome.over) {
      next.status = 'finished';
      next.winner = outcome.winner || null;
      next.resultReason = outcome.reason || null;
    }
    room.position = next;
    room.version = next.version;
    room.turn = next.turn;
    room.status = next.status;
    room.winner = next.winner || null;
    room.resultReason = next.resultReason || null;
    room.updatedAt = Date.now();
    return { matched: match };
  }

  resign(room: Room, seat: Seat): void {
    if (room.status !== 'active') throw new StateError('not-active', 'Game is not active.');
    room.status = 'finished';
    room.winner = opp(seat);
    room.resultReason = 'resignation';
    room.updatedAt = Date.now();
    room.position.status = 'finished';
    room.position.winner = room.winner;
    room.position.resultReason = room.resultReason;
  }

  offerDraw(room: Room, seat: Seat): void {
    if (room.status !== 'active') throw new StateError('not-active', 'Game is not active.');
    room.drawOfferBy = seat;
    room.updatedAt = Date.now();
  }

  answerDraw(room: Room, seat: Seat, accept: boolean): void {
    if (room.status !== 'active') throw new StateError('not-active', 'Game is not active.');
    if (!room.drawOfferBy || room.drawOfferBy === seat) throw new StateError('not-your-offer', 'No draw offer from the opponent to answer.');
    if (accept) {
      room.status = 'finished';
      room.winner = null;
      room.resultReason = 'draw by agreement';
      room.position.status = 'finished';
      room.position.winner = null;
      room.position.resultReason = 'draw by agreement';
    }
    room.drawOfferBy = null;
    room.updatedAt = Date.now();
  }

  requestRematch(room: Room, seat: Seat): boolean {
    if (room.status !== 'finished') throw new StateError('not-finished', 'Game is not finished.');
    room.rematchRequests[seat] = true;
    room.updatedAt = Date.now();
    if (room.rematchRequests.gold && room.rematchRequests.scarlet) {
      this.performRematch(room);
      return true;
    }
    return false;
  }

  cancelRematch(room: Room, seat: Seat): void {
    room.rematchRequests[seat] = false;
    room.updatedAt = Date.now();
  }

  private performRematch(room: Room): void {
    room.rematchOf = room.gameId;
    room.gameId = null;
    room.position = createInitialState();
    room.moveHistory = [];
    room.version = 0;
    room.status = 'active';
    room.turn = 'gold';
    room.drawOfferBy = null;
    room.winner = null;
    room.resultReason = null;
    room.lastMove = '';
    room.rematchCount += 1;
    room.rematchRequests = { gold: false, scarlet: false };
    const g = room.gold, s = room.scarlet;
    room.gold = s; room.scarlet = g;
    room.rated = false;
    room.updatedAt = Date.now();
  }

  leaveLobby(room: Room, seat: Seat): void {
    if (room.status !== 'lobby') throw new StateError('not-in-lobby', 'Cannot leave a started game from the lobby action.');
    room[seat] = EMPTY_SEAT();
    room.updatedAt = Date.now();
  }

  delete(code: string): void {
    this.rooms.delete(code);
  }

  maybeDeleteEmpty(room: Room): boolean {
    if (room.status === 'lobby' && !room.gold.tokenHash && !room.scarlet.tokenHash) {
      this.rooms.delete(room.code);
      return true;
    }
    return false;
  }

  toPublicState(room: Room): PublicGameState {
    const players: Record<Seat, PublicPlayer> = {
      gold: seatToPublicPlayer(room.gold),
      scarlet: seatToPublicPlayer(room.scarlet),
    };
    const pos = serializeState(room.position);
    pos.status = room.status;
    pos.version = room.version;
    pos.turn = room.turn;
    pos.drawOfferBy = room.drawOfferBy;
    pos.winner = room.winner;
    pos.resultReason = room.resultReason;
    pos.moveHistory = room.moveHistory;
    pos.players = players;
    return {
      schemaVersion: SCHEMA_VERSION,
      code: room.code,
      status: room.status,
      turn: room.turn,
      version: room.version,
      halfMove: pos.halfMove,
      pieces: pos.pieces,
      moveHistory: room.moveHistory,
      drawOfferBy: room.drawOfferBy,
      winner: room.winner,
      resultReason: room.resultReason,
      rematchCount: room.rematchCount,
      rated: room.rated,
      rematchRequests: { gold: room.rematchRequests.gold, scarlet: room.rematchRequests.scarlet },
      lastMove: room.lastMove,
      players,
    };
  }

  evictStale(now: number = Date.now()): number {
    let removed = 0;
    for (const [code, room] of this.rooms) {
      if (now - room.updatedAt > ROOM_TTL_MS) {
        this.rooms.delete(code);
        removed++;
      }
    }
    return removed;
  }

  size(): number { return this.rooms.size; }

  listCodes(): string[] { return Array.from(this.rooms.keys()); }

  close(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }
}

function seatToPublicPlayer(rec: SeatRecord): PublicPlayer {
  return {
    userId: rec.userId == null ? '' : String(rec.userId),
    username: rec.username || rec.name || 'Player',
    rating: rec.rating,
    wins: rec.wins,
    draws: rec.draws,
    losses: rec.losses,
    connected: rec.connected,
  };
}

export class JoinError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'JoinError'; }
}
export class StateError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'StateError'; }
}