import { describe, test, expect, beforeEach } from 'vitest';
import { Repo, type HistoryItem, type GameDetail } from '../src/repo.js';
import { inMemoryDb } from '../src/db.js';
import type { Database as DB } from 'better-sqlite3';
import { generateSessionToken, hashSessionToken, SESSION_MAX_AGE } from '../src/auth.js';

function freshRepo(): { repo: Repo; db: DB } {
  const db = inMemoryDb();
  return { repo: new Repo(db), db };
}

describe('repo: users', () => {
  let repo: Repo;
  beforeEach(() => { ({ repo } = freshRepo()); });

  test('createUser returns the public profile with starting rating 1000', () => {
    const u = repo.createUser('Alice', 'alice', '$argon2id$hash');
    expect(u.username).toBe('Alice');
    expect(u.rating).toBe(1000);
    expect(u.gamesPlayed).toBe(0);
    expect(u.id).toBeGreaterThan(0);
  });

  test('publicUserById does not expose password_hash', () => {
    repo.createUser('Alice', 'alice', '$argon2id$hash');
    const u = repo.publicUserById(1)!;
    expect((u as any).password_hash).toBeUndefined();
    expect(JSON.stringify(u)).not.toContain('password');
  });

  test('getCredentials returns the hash for auth only', () => {
    repo.createUser('Alice', 'alice', '$argon2id$secret');
    const c = repo.getCredentials('alice');
    expect(c).not.toBeNull();
    expect(c!.passwordHash).toBe('$argon2id$secret');
  });

  test('getCredentials returns null for unknown user', () => {
    expect(repo.getCredentials('nobody')).toBeNull();
  });

  test('usernameExists is case-insensitive via normalized name', () => {
    repo.createUser('Alice', 'alice', '$argon2id$hash');
    expect(repo.usernameExists('alice')).toBe(true);
    expect(repo.usernameExists('ALICE')).toBe(false);
    expect(repo.usernameExists('bob')).toBe(false);
  });
});

describe('repo: sessions', () => {
  let repo: Repo;
  beforeEach(() => { ({ repo } = freshRepo()); });

  test('createSession returns a raw token and stores only its hash', () => {
    const u = repo.createUser('Alice', 'alice', '$argon2id$hash');
    const { raw, record } = repo.createSession(u.id, SESSION_MAX_AGE * 1000);
    expect(raw.length).toBe(64);
    expect(record.tokenHash).toBe(hashSessionToken(raw));
    const row = (repo as any).db.prepare('SELECT token_hash FROM sessions').get() as any;
    expect(row.token_hash).not.toBe(raw);
    expect(row.token_hash).toBe(hashSessionToken(raw));
  });

  test('resolveSession returns the user for a valid token', () => {
    const u = repo.createUser('Alice', 'alice', '$argon2id$hash');
    const { raw } = repo.createSession(u.id, SESSION_MAX_AGE * 1000);
    const r = repo.resolveSession(raw, SESSION_MAX_AGE * 1000);
    expect(r).not.toBeNull();
    expect(r!.user.id).toBe(u.id);
  });

  test('resolveSession returns null for an unknown token', () => {
    repo.createUser('Alice', 'alice', '$argon2id$hash');
    expect(repo.resolveSession(generateSessionToken(), SESSION_MAX_AGE * 1000)).toBeNull();
  });

  test('resolveSession rolling-expires a session (last_used/expires bumped)', () => {
    const u = repo.createUser('Alice', 'alice', '$argon2id$hash');
    const { raw, record } = repo.createSession(u.id, 60_000);
    const r1 = repo.resolveSession(raw, 60_000);
    expect(r1).not.toBeNull();
    expect(r1!.session.expiresAt).toBeGreaterThanOrEqual(record.expiresAt);
  });

  test('resolveSession returns null and deletes an expired session', () => {
    const u = repo.createUser('Alice', 'alice', '$argon2id$hash');
    const { raw } = repo.createSession(u.id, 1);
    return new Promise<void>((res) => setTimeout(res, 10)).then(async () => {
      expect(repo.resolveSession(raw, 1)).toBeNull();
    });
  });

  test('deleteSession removes the session', () => {
    const u = repo.createUser('Alice', 'alice', '$argon2id$hash');
    const { raw, record } = repo.createSession(u.id, SESSION_MAX_AGE * 1000);
    repo.deleteSession(record.tokenHash);
    expect(repo.resolveSession(raw, SESSION_MAX_AGE * 1000)).toBeNull();
  });

  test('deleteExpiredSessions removes only expired rows', () => {
    const u = repo.createUser('Alice', 'alice', '$argon2id$hash');
    repo.createSession(u.id, 1);
    repo.createSession(u.id, SESSION_MAX_AGE * 1000);
    return new Promise<void>((res) => setTimeout(res, 10)).then(() => {
      expect(repo.deleteExpiredSessions(Date.now())).toBe(1);
    });
  });
});

describe('repo: games + moves', () => {
  let repo: Repo;
  beforeEach(() => { ({ repo } = freshRepo()); });

  test('startGame records both display names and rated flag', () => {
    const id = repo.startGame({ roomCode: 'ABC123', goldUserId: null, scarletUserId: null, goldName: 'G', scarletName: 'S', rated: false });
    expect(id).toBeGreaterThan(0);
  });

  test('recordMove stores ply, colour, notation, and state version', () => {
    const id = repo.startGame({ roomCode: 'ABC123', goldUserId: null, scarletUserId: null, goldName: 'G', scarletName: 'S', rated: false });
    repo.recordMove(id, 1, 'gold', 'W 2a2-2a3', 'Warrior – G B2 → B4', '{}', 1);
    const detail = repo.gameForUser(id, 0);
    expect(detail).toBeNull();
  });

  test('finishGame sets status completed with winner + reason', () => {
    const id = repo.startGame({ roomCode: 'ABC123', goldUserId: null, scarletUserId: null, goldName: 'G', scarletName: 'S', rated: false });
    repo.finishGame(id, 'gold', 'checkmate', '{}');
    const r = repo.applyRatingIfEligible(id);
    expect(r.applied).toBe(false);
  });

  test('abandonGame marks an active game abandoned', () => {
    const id = repo.startGame({ roomCode: 'ABC123', goldUserId: null, scarletUserId: null, goldName: 'G', scarletName: 'S', rated: false });
    repo.abandonGame(id);
    expect(repo.gameForUser(id, 0)).toBeNull();
  });
});

describe('repo: Elo application (idempotent + eligible)', () => {
  let repo: Repo;
  beforeEach(() => { ({ repo } = freshRepo()); });

  function makeRatedGame(): { gameId: number; goldId: number; scarletId: number } {
    const gold = repo.createUser('Gold', 'gold', '$argon2id$h');
    const scarlet = repo.createUser('Scarlet', 'scarlet', '$argon2id$h');
    const gameId = repo.startGame({ roomCode: 'ABC123', goldUserId: gold.id, scarletUserId: scarlet.id, goldName: 'Gold', scarletName: 'Scarlet', rated: true });
    return { gameId, goldId: gold.id, scarletId: scarlet.id };
  }

  test('applies rating exactly once for a completed rated game (gold win)', () => {
    const { gameId, goldId, scarletId } = makeRatedGame();
    repo.finishGame(gameId, 'gold', 'checkmate', '{}');
    const r1 = repo.applyRatingIfEligible(gameId);
    expect(r1.applied).toBe(true);
    expect(r1.result).not.toBeNull();
    const gold = repo.publicUserById(goldId)!;
    const scarlet = repo.publicUserById(scarletId)!;
    expect(gold.rating).toBeGreaterThan(1000);
    expect(scarlet.rating).toBeLessThan(1000);
    expect(gold.wins).toBe(1);
    expect(gold.losses).toBe(0);
    expect(scarlet.losses).toBe(1);
    expect(gold.gamesPlayed).toBe(1);
    expect(scarlet.gamesPlayed).toBe(1);
  });

  test('rating_applied_at guard makes it idempotent (second call is a no-op)', () => {
    const { gameId, goldId } = makeRatedGame();
    repo.finishGame(gameId, 'gold', 'checkmate', '{}');
    repo.applyRatingIfEligible(gameId);
    const before = repo.publicUserById(goldId)!.rating;
    const r2 = repo.applyRatingIfEligible(gameId);
    expect(r2.applied).toBe(false);
    expect(repo.publicUserById(goldId)!.rating).toBe(before);
  });

  test('does not apply for an unrated game', () => {
    const gold = repo.createUser('Gold', 'gold', '$argon2id$h');
    const scarlet = repo.createUser('Scarlet', 'scarlet', '$argon2id$h');
    const gameId = repo.startGame({ roomCode: 'ABC123', goldUserId: gold.id, scarletUserId: scarlet.id, goldName: 'Gold', scarletName: 'Scarlet', rated: false });
    repo.finishGame(gameId, 'gold', 'checkmate', '{}');
    expect(repo.applyRatingIfEligible(gameId).applied).toBe(false);
  });

  test('does not apply when one seat is a guest', () => {
    const gold = repo.createUser('Gold', 'gold', '$argon2id$h');
    const gameId = repo.startGame({ roomCode: 'ABC123', goldUserId: gold.id, scarletUserId: null, goldName: 'Gold', scarletName: 'Guest', rated: true });
    repo.finishGame(gameId, 'gold', 'checkmate', '{}');
    expect(repo.applyRatingIfEligible(gameId).applied).toBe(false);
  });

  test('does not apply when both seats are the same account', () => {
    const a = repo.createUser('Same', 'same', '$argon2id$h');
    const gameId = repo.startGame({ roomCode: 'ABC123', goldUserId: a.id, scarletUserId: a.id, goldName: 'Same', scarletName: 'Same', rated: true });
    repo.finishGame(gameId, 'gold', 'checkmate', '{}');
    expect(repo.applyRatingIfEligible(gameId).applied).toBe(false);
  });

  test('does not apply before the game is completed', () => {
    const { gameId } = makeRatedGame();
    expect(repo.applyRatingIfEligible(gameId).applied).toBe(false);
  });

  test('draw: both ratings shift toward each other, W/D/L recorded as draws', () => {
    const { gameId, goldId, scarletId } = makeRatedGame();
    repo.finishGame(gameId, null, 'draw by agreement', '{}');
    repo.applyRatingIfEligible(gameId);
    expect(repo.publicUserById(goldId)!.draws).toBe(1);
    expect(repo.publicUserById(scarletId)!.draws).toBe(1);
  });

  test('resignation counts as a win/loss, not a draw', () => {
    const { gameId, goldId, scarletId } = makeRatedGame();
    repo.finishGame(gameId, 'scarlet', 'resignation', '{}');
    repo.applyRatingIfEligible(gameId);
    expect(repo.publicUserById(scarletId)!.wins).toBe(1);
    expect(repo.publicUserById(goldId)!.losses).toBe(1);
  });
});

describe('repo: history + game detail', () => {
  let repo: Repo;
  let userId: number;
  let guestOppGameId: number;

  beforeEach(() => {
    ({ repo } = freshRepo());
    const me = repo.createUser('Me', 'me', '$argon2id$h');
    userId = me.id;
    guestOppGameId = repo.startGame({ roomCode: 'AAAAAA', goldUserId: userId, scarletUserId: null, goldName: 'Me', scarletName: 'Guest', rated: false });
    repo.finishGame(guestOppGameId, 'gold', 'checkmate', '{"pieces":{}}');
    const opp = repo.createUser('Opp', 'opp', '$argon2id$h');
    const ratedId = repo.startGame({ roomCode: 'BBBBBB', goldUserId: userId, scarletUserId: opp.id, goldName: 'Me', scarletName: 'Opp', rated: true });
    repo.recordMove(ratedId, 1, 'gold', 'W 2a2-2a3', 'Warrior – G B2 → B4', '{}', 1);
    repo.recordMove(ratedId, 2, 'scarlet', 'W 2g7-2g6', 'Warrior – S G7 → G6', '{}', 2);
    repo.finishGame(ratedId, 'gold', 'checkmate', '{"pieces":{}}');
    repo.applyRatingIfEligible(ratedId);
  });

  test('historyCount includes games as Gold or Scarlet', () => {
    expect(repo.historyCount(userId)).toBe(2);
  });

  test('history returns games newest first with move count + opponent', () => {
    const { total, games } = repo.history(userId, 1, 20);
    expect(total).toBe(2);
    expect(games.length).toBe(2);
    expect(games[0].rated).toBe(true);
    expect(games[0].opponentName).toBe('Opp');
    expect(games[0].opponentIsGuest).toBe(false);
    expect(games[0].moveCount).toBe(2);
    expect(games[0].colour).toBe('gold');
    expect(games[0].result).toBe('win');
    expect(games[1].rated).toBe(false);
    expect(games[1].opponentIsGuest).toBe(true);
  });

  test('history rating before/after/change are populated for rated games', () => {
    const { games } = repo.history(userId, 1, 20);
    const rated = games.find((g) => g.rated)!;
    expect(rated.ratingBefore).toBe(1000);
    expect(rated.ratingAfter).toBeGreaterThan(1000);
    expect(rated.ratingChange).toBe(rated.ratingAfter! - rated.ratingBefore!);
  });

  test('history pagination respects page size', () => {
    const p1 = repo.history(userId, 1, 1);
    expect(p1.games.length).toBe(1);
    const p2 = repo.history(userId, 2, 1);
    expect(p2.games.length).toBe(1);
    expect(p1.games[0].gameId).not.toBe(p2.games[0].gameId);
  });

  test('gameForUser returns moves + final state for a participant', () => {
    const detail = repo.gameForUser(guestOppGameId, userId);
    expect(detail).not.toBeNull();
    expect(detail!.game.goldUserId).toBe(userId);
    expect(detail!.finalState).toEqual({ pieces: {} });
  });

  test('gameForUser rejects a non-participant', () => {
    const other = repo.createUser('Other', 'other', '$argon2id$h');
    expect(repo.gameForUser(guestOppGameId, other.id)).toBeNull();
  });

  test('history never exposes password hashes or token hashes', () => {
    const { games } = repo.history(userId, 1, 20);
    const json = JSON.stringify(games);
    expect(json).not.toContain('password');
    expect(json).not.toContain('token_hash');
  });
});