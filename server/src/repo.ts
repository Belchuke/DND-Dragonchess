import type { Database as DB } from 'better-sqlite3';
import { STARTING_RATING, applyElo, type EloResult } from './elo.js';
import {
  generateSessionToken, hashSessionToken, tokenHashMatches,
} from './auth.js';

export interface PublicUser {
  id: number;
  username: string;
  rating: number;
  gamesPlayed: number;
  wins: number;
  draws: number;
  losses: number;
  createdAt: number;
}

export interface SessionRecord {
  tokenHash: string;
  userId: number;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

export interface GameRow {
  id: number;
  roomCode: string;
  goldUserId: number | null;
  scarletUserId: number | null;
  goldDisplayName: string;
  scarletDisplayName: string;
  status: string;
  rated: number;
  winnerColour: string | null;
  resultReason: string | null;
  goldRatingBefore: number | null;
  goldRatingAfter: number | null;
  scarletRatingBefore: number | null;
  scarletRatingAfter: number | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  finalStateJson: string | null;
  ratingAppliedAt: number | null;
  rematchOf: number | null;
}

export interface MoveRow {
  id: number;
  gameId: number;
  ply: number;
  colour: string;
  notation: string | null;
  lastMove: string | null;
  moveJson: string | null;
  stateVersion: number;
  createdAt: number;
}

export class Repo {
  constructor(private db: DB) {}

  createUser(username: string, normalized: string, passwordHash: string): PublicUser {
    const now = Date.now();
    const info = this.db.prepare(
      'INSERT INTO users(username, username_normalized, password_hash, rating, games_played, wins, draws, losses, created_at, updated_at) VALUES (?,?,?,?,0,0,0,0,?,?)',
    ).run(username, normalized, passwordHash, STARTING_RATING, now, now);
    return this.publicUserById(Number(info.lastInsertRowid))!;
  }

  publicUserById(id: number): PublicUser | null {
    const r = this.db.prepare(
      'SELECT id, username, rating, games_played, wins, draws, losses, created_at FROM users WHERE id = ?',
    ).get(id) as any;
    return r ? this.toPublicUser(r) : null;
  }

  private userByNormalized(normalized: string): { id: number; username: string; username_normalized: string; password_hash: string; rating: number; requires_reset: number } | undefined {
    return this.db.prepare(
      'SELECT id, username, username_normalized, password_hash, rating, requires_reset FROM users WHERE username_normalized = ?',
    ).get(normalized) as any;
  }

  getCredentials(normalized: string): { id: number; passwordHash: string; requiresReset: boolean } | null {
    const r = this.userByNormalized(normalized);
    return r ? { id: r.id, passwordHash: r.password_hash, requiresReset: !!r.requires_reset } : null;
  }

  resetPassword(normalized: string, newHash: string): boolean {
    const info = this.db.prepare(
      'UPDATE users SET password_hash=?, requires_reset=0, updated_at=? WHERE username_normalized=?',
    ).run(newHash, Date.now(), normalized);
    return info.changes > 0;
  }

  updatePasswordHash(userId: number, newHash: string): boolean {
    const info = this.db.prepare(
      'UPDATE users SET password_hash=?, requires_reset=0, updated_at=? WHERE id=?',
    ).run(newHash, Date.now(), userId);
    return info.changes > 0;
  }

  usernameExists(normalized: string): boolean {
    return !!this.userByNormalized(normalized);
  }

  private toPublicUser(r: any): PublicUser {
    return {
      id: r.id, username: r.username, rating: r.rating,
      gamesPlayed: r.games_played, wins: r.wins, draws: r.draws, losses: r.losses,
      createdAt: r.created_at,
    };
  }

  createSession(userId: number, ttlMs: number): { raw: string; record: SessionRecord } {
    const raw = generateSessionToken();
    const tokenHash = hashSessionToken(raw);
    const now = Date.now();
    const record: SessionRecord = { tokenHash, userId, createdAt: now, lastUsedAt: now, expiresAt: now + ttlMs };
    this.db.prepare(
      'INSERT INTO sessions(token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?,?,?,?,?)',
    ).run(tokenHash, userId, now, now, record.expiresAt);
    return { raw, record };
  }

  resolveSession(rawToken: string, ttlMs: number): { user: PublicUser; session: SessionRecord } | null {
    if (!rawToken) return null;
    const candidate = hashSessionToken(rawToken);
    const row = this.db.prepare('SELECT * FROM sessions').all() as any[];
    let match: any = null;
    for (const s of row) {
      if (tokenHashMatches(s.token_hash, candidate)) { match = s; break; }
    }
    if (!match) return null;
    const now = Date.now();
    if (match.expires_at < now) {
      this.deleteSession(match.token_hash);
      return null;
    }
    const user = this.publicUserById(match.user_id);
    if (!user) return null;
    const expiresAt = now + ttlMs;
    this.db.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?')
      .run(now, expiresAt, match.token_hash);
    const session: SessionRecord = {
      tokenHash: match.token_hash, userId: match.user_id,
      createdAt: match.created_at, lastUsedAt: now, expiresAt,
    };
    return { user, session };
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteExpiredSessions(now: number = Date.now()): number {
    const info = this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    return info.changes;
  }

  startGame(opts: {
    roomCode: string; goldUserId: number | null; scarletUserId: number | null;
    goldName: string; scarletName: string; rated: boolean; rematchOf?: number | null;
  }): number {
    const now = Date.now();
    const info = this.db.prepare(
      `INSERT INTO games(room_code, gold_user_id, scarlet_user_id, gold_display_name, scarlet_display_name,
        status, rated, created_at, started_at, rematch_of)
       VALUES (?,?,?,?,?, 'active', ?, ?, ?, ?)`,
    ).run(opts.roomCode, opts.goldUserId, opts.scarletUserId, opts.goldName, opts.scarletName,
      opts.rated ? 1 : 0, now, now, opts.rematchOf ?? null);
    return Number(info.lastInsertRowid);
  }

  recordMove(gameId: number, ply: number, colour: string, notation: string, lastMove: string, moveJson: string, stateVersion: number): void {
    this.db.prepare(
      'INSERT INTO game_moves(game_id, ply, colour, notation, last_move, move_json, state_version, created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(gameId, ply, colour, notation, lastMove, moveJson, stateVersion, Date.now());
  }

  finishGame(gameId: number, winnerColour: string | null, reason: string, finalStateJson: string): void {
    this.db.prepare(
      `UPDATE games SET status='completed', winner_colour=?, result_reason=?, completed_at=?,
        final_state_json=? WHERE id=? AND status='active'`,
    ).run(winnerColour, reason, Date.now(), finalStateJson, gameId);
  }

  abandonGame(gameId: number): void {
    this.db.prepare(`UPDATE games SET status='abandoned', completed_at=COALESCE(completed_at, ?) WHERE id=? AND status='active'`)
      .run(Date.now(), gameId);
  }

  private getGameForUpdate(gameId: number): GameRow | null {
    const r = this.db.prepare('SELECT * FROM games WHERE id = ?').get(gameId) as any;
    return r ? this.toGameRow(r) : null;
  }

  applyRatingIfEligible(gameId: number): { applied: boolean; result: EloResult | null } {
    const game = this.getGameForUpdate(gameId);
    if (!game) return { applied: false, result: null };
    if (game.rated !== 1) return { applied: false, result: null };
    if (game.ratingAppliedAt != null) return { applied: false, result: null };
    if (game.status !== 'completed') return { applied: false, result: null };
    if (!game.goldUserId || !game.scarletUserId) return { applied: false, result: null };
    if (game.goldUserId === game.scarletUserId) return { applied: false, result: null };

    const gold = this.publicUserById(game.goldUserId);
    const scarlet = this.publicUserById(game.scarletUserId);
    if (!gold || !scarlet) return { applied: false, result: null };

    const goldUserId = game.goldUserId;
    const scarletUserId = game.scarletUserId;
    const scoreA = game.winnerColour === 'gold' ? 1 : game.winnerColour === 'scarlet' ? 0 : 0.5;
    const res = applyElo(gold.rating, scarlet.rating, scoreA);
    const now = Date.now();

    const tx = this.db.transaction(() => {
      // re-check inside the tx in case another finish raced us
      const re =this.db.prepare('SELECT rating_applied_at, status FROM games WHERE id=?').get(gameId) as any;
      if (re.rating_applied_at != null || re.status !== 'completed') return;
      if (scoreA === 1) this.setRatingAndRecord(goldUserId, res.aAfter, true, false, false);
      else if (scoreA === 0.5) this.setRatingAndRecord(goldUserId, res.aAfter, false, true, false);
      else this.setRatingAndRecord(goldUserId, res.aAfter, false, false, true);
      if (scoreA === 1) this.setRatingAndRecord(scarletUserId, res.bAfter, false, false, true);
      else if (scoreA === 0.5) this.setRatingAndRecord(scarletUserId, res.bAfter, false, true, false);
      else this.setRatingAndRecord(scarletUserId, res.bAfter, true, false, false);
      this.db.prepare('UPDATE games SET gold_rating_before=?, gold_rating_after=?, scarlet_rating_before=?, scarlet_rating_after=?, rating_applied_at=? WHERE id=?')
        .run(res.aBefore, res.aAfter, res.bBefore, res.bAfter, now, gameId);
    });
    tx();
    const after = this.getGameForUpdate(gameId);
    return { applied: after?.ratingAppliedAt != null, result: res };
  }

  private setRatingAndRecord(userId: number, newRating: number, win: boolean, draw: boolean, loss: boolean): void {
    const now = Date.now();
    this.db.prepare(
      `UPDATE users SET rating=?, wins=wins+?, draws=draws+?, losses=losses+?, games_played=games_played+1, updated_at=? WHERE id=?`,
    ).run(newRating, win ? 1 : 0, draw ? 1 : 0, loss ? 1 : 0, now, userId);
  }

  historyCount(userId: number): number {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS c FROM games WHERE status='completed' AND (gold_user_id=? OR scarlet_user_id=?)`,
    ).get(userId, userId) as any;
    return r.c;
  }

  history(userId: number, page: number, pageSize: number): { total: number; games: HistoryItem[] } {
    const total = this.historyCount(userId);
    const p = Math.max(1, page | 0);
    const ps = Math.min(100, Math.max(1, pageSize | 0));
    const offset = (p - 1) * ps;
    const rows = this.db.prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM game_moves m WHERE m.game_id=g.id) AS move_count
       FROM games g
       WHERE g.status='completed' AND (g.gold_user_id=? OR g.scarlet_user_id=?)
       ORDER BY g.completed_at DESC, g.id DESC
       LIMIT ? OFFSET ?`,
    ).all(userId, userId, ps, offset) as any[];
    const games = rows.map((r) => this.toHistoryItem(r, userId));
    return { total, games };
  }

  private toHistoryItem(r: any, userId: number): HistoryItem {
    const isGold = r.gold_user_id === userId;
    const before = isGold ? r.gold_rating_before : r.scarlet_rating_before;
    const after = isGold ? r.gold_rating_after : r.scarlet_rating_after;
    let result: 'win' | 'draw' | 'loss';
    if (r.winner_colour == null) result = 'draw';
    else if (r.winner_colour === 'gold') result = isGold ? 'win' : 'loss';
    else result = isGold ? 'loss' : 'win';
    return {
      gameId: r.id,
      opponentName: isGold ? r.scarlet_display_name : r.gold_display_name,
      opponentIsGuest: !(isGold ? r.scarlet_user_id : r.gold_user_id),
      colour: isGold ? 'gold' : 'scarlet',
      result,
      resultReason: r.result_reason,
      rated: r.rated === 1,
      ratingBefore: before ?? null,
      ratingAfter: after ?? null,
      ratingChange: before != null && after != null ? after - before : null,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      moveCount: r.move_count,
    };
  }

  gameForUser(gameId: number, userId: number): GameDetail | null {
    const g = this.getGameForUpdate(gameId);
    if (!g) return null;
    if (g.goldUserId !== userId && g.scarletUserId !== userId) return null;
    const moves = this.db.prepare(
      'SELECT id, game_id, ply, colour, notation, last_move, move_json, state_version, created_at FROM game_moves WHERE game_id=? ORDER BY ply ASC',
    ).all(gameId) as any[];
    return {
      game: g,
      moves: moves.map((m) => this.toMoveRow(m)),
      finalState: g.finalStateJson ? JSON.parse(g.finalStateJson) : null,
    };
  }

  private toGameRow(r: any): GameRow {
    return {
      id: r.id, roomCode: r.room_code, goldUserId: r.gold_user_id, scarletUserId: r.scarlet_user_id,
      goldDisplayName: r.gold_display_name, scarletDisplayName: r.scarlet_display_name,
      status: r.status, rated: r.rated, winnerColour: r.winner_colour, resultReason: r.result_reason,
      goldRatingBefore: r.gold_rating_before, goldRatingAfter: r.gold_rating_after,
      scarletRatingBefore: r.scarlet_rating_before, scarletRatingAfter: r.scarlet_rating_after,
      createdAt: r.created_at, startedAt: r.started_at, completedAt: r.completed_at,
      finalStateJson: r.final_state_json, ratingAppliedAt: r.rating_applied_at,
      rematchOf: r.rematch_of ?? null,
    };
  }
  private toMoveRow(r: any): MoveRow {
    return {
      id: r.id, gameId: r.game_id, ply: r.ply, colour: r.colour, notation: r.notation,
      lastMove: r.last_move, moveJson: r.move_json, stateVersion: r.state_version, createdAt: r.created_at,
    };
  }
}

export interface HistoryItem {
  gameId: number;
  opponentName: string;
  opponentIsGuest: boolean;
  colour: 'gold' | 'scarlet';
  result: 'win' | 'draw' | 'loss';
  resultReason: string | null;
  rated: boolean;
  ratingBefore: number | null;
  ratingAfter: number | null;
  ratingChange: number | null;
  startedAt: number | null;
  completedAt: number | null;
  moveCount: number;
}

export interface GameDetail {
  game: GameRow;
  moves: MoveRow[];
  finalState: any;
}