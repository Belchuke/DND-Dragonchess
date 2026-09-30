import { describe, test, expect } from 'vitest';
import { STARTING_RATING, K_FACTOR, expectedScore, applyElo } from '../src/elo.js';

describe('elo', () => {
  test('starting rating is 1000 and K is 32', () => {
    expect(STARTING_RATING).toBe(1000);
    expect(K_FACTOR).toBe(32);
  });

  test('expected score is 0.5 for equal ratings', () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5, 10);
  });

  test('expected score approaches 1 for a much higher rating', () => {
    expect(expectedScore(2000, 1000)).toBeGreaterThan(0.99);
  });

  test('expected score approaches 0 for a much lower rating', () => {
    expect(expectedScore(1000, 2000)).toBeLessThan(0.01);
  });

  test('expected score is symmetric: E(A,B) + E(B,A) = 1', () => {
    const e = expectedScore(1400, 1100);
    expect(e + expectedScore(1100, 1400)).toBeCloseTo(1, 10);
  });

  test('a win gains roughly 32 * (1 - expected) rating', () => {
    const res = applyElo(1000, 1000, 1);
    expect(res.aAfter).toBe(1000 + 16);
    expect(res.bAfter).toBe(1000 - 16);
  });

  test('a loss loses the complement of a win', () => {
    const win = applyElo(1000, 1000, 1);
    const loss = applyElo(1000, 1000, 0);
    expect(win.aAfter + loss.aAfter).toBe(2000);
  });

  test('a draw against an equal opponent changes nothing', () => {
    const res = applyElo(1000, 1000, 0.5);
    expect(res.aAfter).toBe(1000);
    expect(res.bAfter).toBe(1000);
    expect(res.aChange).toBe(0);
    expect(res.bChange).toBe(0);
  });

  test('a draw transfers rating from the higher to the lower', () => {
    const res = applyElo(1400, 1000, 0.5);
    expect(res.aAfter).toBeLessThan(1400);
    expect(res.bAfter).toBeGreaterThan(1000);
  });

  test('ratings are rounded to whole numbers', () => {
    const res = applyElo(1015, 980, 1);
    expect(Number.isInteger(res.aAfter)).toBe(true);
    expect(Number.isInteger(res.bAfter)).toBe(true);
  });

  test('ratings never go negative (clamped at 0)', () => {
    const res = applyElo(5, 5, 0);
    expect(res.aAfter).toBeGreaterThanOrEqual(0);
    expect(res.aAfter).toBe(0);
  });

  test('before/after/change fields are consistent', () => {
    const res = applyElo(1200, 1100, 1);
    expect(res.aBefore).toBe(1200);
    expect(res.bBefore).toBe(1100);
    expect(res.aAfter).toBe(res.aBefore + res.aChange);
    expect(res.bAfter).toBe(res.bBefore + res.bChange);
  });

  test('a 400-point gap gives ~0.91 expected score', () => {
    expect(expectedScore(1400, 1000)).toBeCloseTo(0.909, 2);
  });

  test('change for A equals -change for B for a decisive game', () => {
    const res = applyElo(1500, 1500, 1);
    expect(res.aChange).toBe(-res.bChange);
  });

  test('two players starting at 1000 keep 1000 after a draw', () => {
    const res = applyElo(1000, 1000, 0.5);
    expect(res.aAfter).toBe(1000);
    expect(res.bAfter).toBe(1000);
  });
});