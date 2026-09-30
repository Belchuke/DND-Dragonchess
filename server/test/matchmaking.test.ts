import { describe, test, expect } from 'vitest';
import { MatchmakingQueue, randomColour } from '../src/matchmaking.js';

describe('MatchmakingQueue', () => {
  test('bestCandidate picks the closest Elo', () => {
    const q = new MatchmakingQueue();
    q.add(1, 1000, 's1', 100);
    q.add(2, 1500, 's2', 200);
    q.add(3, 1010, 's3', 300);
    expect(q.bestCandidate(3)!.userId).toBe(1);
    expect(q.bestCandidate(2)!.userId).toBe(3);
  });

  test('ties break by longest wait (earliest joinedAt)', () => {
    const q = new MatchmakingQueue();
    q.add(1, 1000, 's1', 100);
    q.add(2, 1000, 's2', 200);
    q.add(3, 1000, 's3', 300);
    expect(q.bestCandidate(3)!.userId).toBe(1);
  });

  test('a player never matches itself', () => {
    const q = new MatchmakingQueue();
    q.add(1, 1000, 's1', 100);
    expect(q.bestCandidate(1)).toBeNull();
  });

  test('tryMatch atomically removes both and returns the pair', () => {
    const q = new MatchmakingQueue();
    q.add(1, 1000, 's1', 100);
    q.add(2, 1000, 's2', 200);
    const pair = q.tryMatch(2);
    expect(pair).not.toBeNull();
    expect(pair!.a.userId).toBe(2);
    expect(pair!.b.userId).toBe(1);
    expect(q.size()).toBe(0);
  });

  test('add refuses a duplicate account; relink updates the socket id', () => {
    const q = new MatchmakingQueue();
    expect(q.add(1, 1000, 's1')).toBe(true);
    expect(q.add(1, 1000, 's2')).toBe(false);
    expect(q.relink(1, 's3')).toBe(true);
    expect(q.entry(1)!.socketId).toBe('s3');
  });

  test('snapshot omits socket ids', () => {
    const q = new MatchmakingQueue();
    q.add(1, 1000, 'secret-socket-id', 100);
    const snap = q.snapshot();
    expect(snap.length).toBe(1);
    expect(JSON.stringify(snap)).not.toContain('secret-socket-id');
  });

  test('randomColour returns gold or scarlet only', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(randomColour());
    expect(seen.has('gold') || seen.has('scarlet')).toBe(true);
    for (const c of seen) expect(c === 'gold' || c === 'scarlet').toBe(true);
  });
});