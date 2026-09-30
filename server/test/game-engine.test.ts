import { describe, test, expect, beforeAll } from 'vitest';
import {
  applyMoveImmutable, cloneState, coordEq, coordToNotation, createInitialState,
  deserializeState, fwd, generateLegalMoves,
  generatePseudoMoves, getFrozenPieceIds, getGameOutcome, isKingInCheck,
  kingsMutuallyAttacking, localCommitMove, moveToNotation, notationToCoord,
  pieceAt, serializeState,
} from '../src/game-engine.js';
import type { Color, State } from '../src/types.js';

function eq(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function emptyState(turn: Color = 'gold'): State {
  return { schemaVersion: 1, version: 0, status: 'active', turn, halfMove: 0, pieces: {}, moveHistory: [], drawOfferBy: null, winner: null, resultReason: null, players: null };
}
function addP(s: State, id: string, color: Color, type: string, l: number, f: number, r: number): void {
  s.pieces[id] = { id, color, type, level: l, file: f, rank: r };
}
function findId(s: State, color: Color, type: string, notation: string): string | null {
  for (const id in s.pieces) { const p = s.pieces[id]; if (p.color === color && p.type === type && coordToNotation(p) === notation) return id; }
  return null;
}
function key(c: { level: number; file: number; rank: number }): string { return c.level + ',' + c.file + ',' + c.rank; }
function assert(cond: boolean, msg: string): void { expect(cond, msg).toBe(true); }

describe('Dragonchess rule engine (parity with browser)', () => {
  test('Initial 42/42', () => {
    const s = createInitialState(); let g = 0, sc = 0;
    for (const id in s.pieces) { s.pieces[id].color === 'gold' ? g++ : sc++; }
    expect(g).toBe(42); expect(sc).toBe(42);
  });

  test('Start coords', () => {
    const s = createInitialState();
    const expectMap: Record<string, string> = {
      'gold-griffon-1': '3c1', 'gold-griffon-2': '3k1', 'gold-dragon-1': '3g1', 'gold-sylph-1': '3a2', 'gold-sylph-6': '3k2',
      'scarlet-griffon-1': '3c8', 'scarlet-dragon-1': '3g8', 'scarlet-sylph-1': '3a7',
      'gold-king-1': '2g1', 'gold-paladin-1': '2h1', 'gold-oliphant-1': '2a1', 'gold-unicorn-1': '2b1', 'gold-mage-1': '2f1', 'gold-cleric-1': '2e1', 'gold-thief-1': '2d1',
      'scarlet-king-1': '2g8', 'gold-warrior-1': '2a2', 'gold-warrior-12': '2l2', 'scarlet-warrior-1': '2a7',
      'gold-basilisk-1': '1c1', 'gold-elemental-1': '1g1', 'gold-dwarf-1': '1b2', 'gold-dwarf-6': '1l2', 'scarlet-basilisk-1': '1c8', 'scarlet-dwarf-1': '1b7',
    };
    for (const id in expectMap) expect(coordToNotation(s.pieces[id])).toBe(expectMap[id]);
  });

  test('No duplicate coords', () => {
    const s = createInitialState(); const set = new Set<string>();
    for (const id in s.pieces) { const k = key(s.pieces[id]); expect(set.has(k)).toBe(false); set.add(k); }
    expect(set.size).toBe(84);
  });

  test('Notation roundtrip 288', () => {
    for (let l = 1; l <= 3; l++) for (let f = 0; f < 12; f++) for (let r = 0; r < 8; r++) {
      const c = { level: l, file: f, rank: r }; const n = coordToNotation(c); const b = notationToCoord(n);
      expect(b && eq(c, b)).toBe(true);
    }
  });

  test('Forward opposite', () => { expect(fwd('gold')).toBe(-fwd('scarlet')); });

  test('Warrior moves', () => {
    const s = emptyState('gold'); addP(s, 'w', 'gold', 'warrior', 2, 5, 3);
    const pm = generatePseudoMoves(s, 'w').map(m => coordToNotation(m.to)).sort();
    expect(pm).toContain('2f5');
    expect(pm).not.toContain('2e5'); expect(pm).not.toContain('2g5');
    addP(s, 'e', 'scarlet', 'warrior', 2, 6, 4);
    const pm2 = generatePseudoMoves(s, 'w').map(m => coordToNotation(m.to));
    expect(pm2).toContain('2g5');
  });

  test('Warrior promotion', () => {
    const s = emptyState('gold'); addP(s, 'w', 'gold', 'warrior', 2, 5, 6);
    const m = generatePseudoMoves(s, 'w').find(m => coordToNotation(m.to) === '2f8')!;
    expect(m.promotion).toBe('hero');
    const s3 = applyMoveImmutable(s, m);
    expect(s3.pieces['w'].type).toBe('hero'); expect(s3.pieces['w'].promoted).toBe(true);
  });

  test('Sylph moves', () => {
    const s = emptyState('gold'); addP(s, 's', 'gold', 'sylph', 3, 5, 1);
    const pm = generatePseudoMoves(s, 's').map(m => coordToNotation(m.to)).sort();
    expect(pm).toContain('3e3'); expect(pm).toContain('3g3');
    expect(pm).not.toContain('3f3');
    expect(pm).not.toContain('2f2');
    addP(s, 'e', 'scarlet', 'warrior', 2, 5, 1);
    const pm2 = generatePseudoMoves(s, 's').map(m => coordToNotation(m.to));
    expect(pm2).toContain('2f2');
    const s3 = emptyState('gold'); addP(s3, 's', 'gold', 'sylph', 2, 5, 4);
    const pm3 = generatePseudoMoves(s3, 's').map(m => coordToNotation(m.to)).sort();
    expect(pm3).toContain('3f5');
    expect(pm3).toContain('3a2');
  });

  test('Griffon zebra+transition', () => {
    const s = emptyState('gold'); addP(s, 'g', 'gold', 'griffon', 3, 5, 3);
    const pm = generatePseudoMoves(s, 'g').map(m => coordToNotation(m.to)).sort();
    expect(pm).toContain('3i6');
    expect(pm).toContain('2e3');
    const s2 = emptyState('gold'); addP(s2, 'g', 'gold', 'griffon', 2, 5, 3);
    const pm2 = generatePseudoMoves(s2, 'g').map(m => coordToNotation(m.to)).sort();
    expect(pm2).toContain('2e3');
    expect(pm2).toContain('3e3');
  });

  test('Dragon', () => {
    const s = emptyState('gold'); addP(s, 'd', 'gold', 'dragon', 3, 5, 3);
    const pm = generatePseudoMoves(s, 'd').map(m => coordToNotation(m.to)).sort();
    expect(pm).toContain('3e4');
    expect(pm).toContain('3h6');
    addP(s, 'e', 'scarlet', 'warrior', 2, 6, 3);
    const rc = generatePseudoMoves(s, 'd').find(m => m.kind === 'remoteCapture' && coordToNotation(m.to) === '2g4')!;
    expect(rc).toBeTruthy();
    const after = applyMoveImmutable(s, rc);
    expect(after.pieces['e']).toBeUndefined();
    expect(after.pieces['d']).toBeTruthy();
    expect(coordEq(after.pieces['d'], { level: 3, file: 5, rank: 3 })).toBe(true);
  });

  test('Oliphant path blocked', () => {
    const s = emptyState('gold'); addP(s, 'o', 'gold', 'oliphant', 2, 5, 3); addP(s, 'x', 'gold', 'dwarf', 2, 5, 5);
    const pm = generatePseudoMoves(s, 'o').map(m => coordToNotation(m.to)).sort();
    expect(pm).not.toContain('2f7');
    expect(pm).toContain('2f5');
    const s2 = emptyState('gold'); addP(s2, 'o', 'gold', 'oliphant', 2, 5, 3); addP(s2, 'e', 'scarlet', 'dwarf', 2, 5, 5);
    const pm2 = generatePseudoMoves(s2, 'o').map(m => coordToNotation(m.to));
    expect(pm2).toContain('2f6');
    expect(pm2).not.toContain('2f7');
  });

  test('Thief path blocked', () => {
    const s = emptyState('gold'); addP(s, 't', 'gold', 'thief', 2, 5, 3); addP(s, 'x', 'gold', 'dwarf', 2, 7, 5);
    const pm = generatePseudoMoves(s, 't').map(m => coordToNotation(m.to)).sort();
    expect(pm).not.toContain('2i7');
    expect(pm).toContain('2g5');
  });

  test('Unicorn knight', () => {
    const s = emptyState('gold'); addP(s, 'u', 'gold', 'unicorn', 2, 5, 3);
    const pm = generatePseudoMoves(s, 'u').map(m => coordToNotation(m.to)).sort();
    expect(pm.includes('2e2') || pm.includes('2h5')).toBe(true);
  });

  test('Hero', () => {
    const s = emptyState('gold'); addP(s, 'h', 'gold', 'hero', 2, 5, 3);
    const pm = generatePseudoMoves(s, 'h').map(m => coordToNotation(m.to)).sort();
    expect(pm).toContain('2h6');
    expect(pm).toContain('1e3');
    expect(pm).toContain('3e3');
    const s2 = emptyState('gold'); addP(s2, 'h', 'gold', 'hero', 3, 5, 4);
    const pm2 = generatePseudoMoves(s2, 'h').map(m => coordToNotation(m.to)).sort();
    expect(pm2).toContain('2e4');
    expect(pm2.some(n => n.startsWith('3'))).toBe(false);
  });

  test('Cleric', () => {
    const s = emptyState('gold'); addP(s, 'c', 'gold', 'cleric', 2, 5, 3);
    const pm = generatePseudoMoves(s, 'c').map(m => coordToNotation(m.to)).sort();
    expect(pm).toContain('1f4');
    expect(pm).toContain('3f4');
    expect(pm).toContain('2e4');
    const s2 = emptyState('gold'); addP(s2, 'c', 'gold', 'cleric', 1, 5, 3);
    const pm2 = generatePseudoMoves(s2, 'c').map(m => m.to);
    expect(pm2.some(t => t.level === 3)).toBe(false);
  });

  test('Mage', () => {
    const s = emptyState('gold'); addP(s, 'm', 'gold', 'mage', 2, 5, 3);
    const pm = generatePseudoMoves(s, 'm').map(m => coordToNotation(m.to)).sort();
    expect(pm).toContain('1f4');
    const s2 = emptyState('gold'); addP(s2, 'm', 'gold', 'mage', 3, 5, 4);
    const pm2 = generatePseudoMoves(s2, 'm').map(m => coordToNotation(m.to)).sort();
    expect(pm2).not.toContain('3e4'); expect(pm2).not.toContain('3g6');
    expect(pm2).toContain('3e5');
    const s3 = emptyState('gold'); addP(s3, 'm', 'gold', 'mage', 1, 5, 3); addP(s3, 'x', 'gold', 'dwarf', 2, 5, 3);
    const pm3 = generatePseudoMoves(s3, 'm').filter(m => m.to.level === 3);
    expect(pm3.length).toBe(0);
  });

  test('King outer restriction', () => {
    const s = emptyState('gold'); addP(s, 'k', 'gold', 'king', 2, 5, 3); addP(s, 'sk', 'scarlet', 'king', 2, 0, 0);
    const pm = generatePseudoMoves(s, 'k').map(m => coordToNotation(m.to)).sort();
    expect(pm).toContain('1f4');
    expect(pm).toContain('2e4');
    const s2 = emptyState('gold'); addP(s2, 'k', 'gold', 'king', 1, 5, 3); addP(s2, 'sk', 'scarlet', 'king', 2, 0, 0);
    const pm2 = generatePseudoMoves(s2, 'k').map(m => m.to);
    expect(pm2.some(t => t.level === 2 && t.file === 5 && t.rank === 3)).toBe(true);
    expect(pm2.some(t => t.level === 1 && !(t.file === 5 && t.rank === 3))).toBe(false);
    const s3 = emptyState('gold'); addP(s3, 'k', 'gold', 'king', 2, 5, 3); addP(s3, 'sk', 'scarlet', 'king', 2, 0, 0); addP(s3, 'ro', 'scarlet', 'oliphant', 2, 0, 4);
    const legal = generateLegalMoves(s3, 'k');
    expect(legal.some(m => coordToNotation(m.to) === '2f5')).toBe(false);
  });

  test('Paladin', () => {
    const s = emptyState('gold'); addP(s, 'p', 'gold', 'paladin', 2, 5, 3);
    const pm = generatePseudoMoves(s, 'p').map(m => coordToNotation(m.to)).sort();
    expect(pm).toContain('2e4');
    expect(pm).toContain('2h3');
    expect(pm).toContain('3d4');
    expect(pm).toContain('1d4');
    const s2 = emptyState('gold'); addP(s2, 'p', 'gold', 'paladin', 1, 5, 3);
    const pm2 = generatePseudoMoves(s2, 'p').map(m => m.to);
    expect(pm2.some(t => t.level === 1 && t.file === 4 && t.rank === 1)).toBe(false);
    expect(pm2.some(t => t.level === 1 && t.file === 4 && t.rank === 3)).toBe(true);
  });

  test('Dwarf', () => {
    const s = emptyState('gold'); addP(s, 'd', 'gold', 'dwarf', 2, 5, 3);
    const pm = generatePseudoMoves(s, 'd').map(m => coordToNotation(m.to)).sort();
    expect(pm).toContain('2f5');
    expect(pm).toContain('2e4');
    expect(pm).not.toContain('2e5');
    addP(s, 'e', 'scarlet', 'dwarf', 2, 6, 4);
    const pm2 = generatePseudoMoves(s, 'd').map(m => coordToNotation(m.to));
    expect(pm2).toContain('2g5');
    const s3 = emptyState('gold'); addP(s3, 'd', 'gold', 'dwarf', 2, 5, 3);
    const pm3 = generatePseudoMoves(s3, 'd').map(m => coordToNotation(m.to));
    expect(pm3).toContain('1f4');
    const s4 = emptyState('gold'); addP(s4, 'd', 'gold', 'dwarf', 1, 5, 3); addP(s4, 'e', 'scarlet', 'warrior', 2, 5, 3);
    const pm4 = generatePseudoMoves(s4, 'd').map(m => coordToNotation(m.to));
    expect(pm4).toContain('2f4');
    const s5 = emptyState('gold'); addP(s5, 'd', 'gold', 'dwarf', 1, 5, 3);
    const pm5 = generatePseudoMoves(s5, 'd').map(m => coordToNotation(m.to));
    expect(pm5).not.toContain('2f4');
  });

  test('Basilisk', () => {
    const s = emptyState('gold'); addP(s, 'b', 'gold', 'basilisk', 1, 5, 3);
    const pm = generatePseudoMoves(s, 'b').map(m => coordToNotation(m.to)).sort();
    expect(pm).toContain('1f5');
    expect(pm).toContain('1e5');
    expect(pm).toContain('1f3');
    const s2 = emptyState('gold'); addP(s2, 'b', 'gold', 'basilisk', 1, 5, 3); addP(s2, 'e', 'scarlet', 'dwarf', 1, 5, 2);
    const pm2 = generatePseudoMoves(s2, 'b').map(m => coordToNotation(m.to));
    expect(pm2).not.toContain('1f3');
    const s3 = emptyState('scarlet'); addP(s3, 'b', 'gold', 'basilisk', 1, 5, 3); addP(s3, 'e', 'scarlet', 'warrior', 2, 5, 3);
    const fr = getFrozenPieceIds(s3);
    expect(fr.has('e')).toBe(true);
    expect(generateLegalMoves(s3, 'e').length).toBe(0);
    const s4 = cloneState(s3); s4.pieces['b'].file = 4; s4.pieces['b'].rank = 3;
    expect(getFrozenPieceIds(s4).has('e')).toBe(false);
  });

  test('Elemental', () => {
    const s = emptyState('gold'); addP(s, 'e', 'gold', 'elemental', 1, 5, 3);
    const pm = generatePseudoMoves(s, 'e').map(m => coordToNotation(m.to)).sort();
    expect(pm).toContain('1f5');
    expect(pm).toContain('1f6');
    expect(pm).toContain('1e3');
    const s2 = emptyState('gold'); addP(s2, 'e', 'gold', 'elemental', 1, 5, 3); addP(s2, 'x', 'gold', 'dwarf', 1, 5, 4);
    const pm2 = generatePseudoMoves(s2, 'e').map(m => coordToNotation(m.to));
    expect(pm2).not.toContain('1f6');
    const s3 = emptyState('gold'); addP(s3, 'e', 'gold', 'elemental', 1, 5, 3); addP(s3, 't', 'scarlet', 'warrior', 2, 6, 3);
    const pm3 = generatePseudoMoves(s3, 'e').map(m => coordToNotation(m.to));
    expect(pm3).toContain('2g4');
    const s4 = emptyState('gold'); addP(s4, 'e', 'gold', 'elemental', 1, 5, 3); addP(s4, 't', 'scarlet', 'warrior', 2, 6, 3); addP(s4, 'x', 'gold', 'dwarf', 1, 6, 3);
    const pm4 = generatePseudoMoves(s4, 'e').map(m => coordToNotation(m.to));
    expect(pm4).not.toContain('2g4');
    const s5 = emptyState('gold'); addP(s5, 'e', 'gold', 'elemental', 2, 5, 3);
    const pm5 = generatePseudoMoves(s5, 'e').map(m => coordToNotation(m.to)).sort();
    expect(pm5).toContain('1e4');
    const s6 = cloneState(s5); addP(s6, 'x', 'gold', 'dwarf', 1, 5, 3);
    const pm6 = generatePseudoMoves(s6, 'e').map(m => coordToNotation(m.to));
    expect(pm6).not.toContain('1e4');
  });

  test('Pin', () => {
    const s = emptyState('gold');
    addP(s, 'gk', 'gold', 'king', 2, 5, 4);
    addP(s, 'gb', 'gold', 'oliphant', 2, 5, 5);
    addP(s, 'sr', 'scarlet', 'oliphant', 2, 5, 7);
    addP(s, 'sk', 'scarlet', 'king', 2, 0, 0);
    const legal = generateLegalMoves(s, 'gb');
    assert(!legal.some(m => coordToNotation(m.to) === '2a6'), 'pinned moved off line ' + legal.map(m => coordToNotation(m.to)));
    assert(legal.some(m => coordToNotation(m.to) === '2f8'), 'cannot capture attacker ' + legal.map(m => coordToNotation(m.to)));
  });

  test('Dragon remote check', () => {
    const s = emptyState('gold');
    addP(s, 'gd', 'gold', 'dragon', 3, 5, 4);
    addP(s, 'sk', 'scarlet', 'king', 2, 5, 4);
    expect(isKingInCheck(s, 'scarlet')).toBe(true);
  });

  test('Checkmate vs stalemate', () => {
    const cm = emptyState('scarlet');
    const P = (id: string, color: Color, type: string, l: number, f: number, r: number) => { cm.pieces[id] = { id, color, type, level: l, file: f, rank: r }; };
    P('gk', 'gold', 'king', 2, 11, 0);
    P('sk', 'scarlet', 'king', 2, 0, 7);
    P('o1', 'gold', 'oliphant', 2, 0, 0);
    P('o2', 'gold', 'oliphant', 2, 1, 0);
    P('b1', 'gold', 'basilisk', 1, 0, 6);
    P('gr1', 'gold', 'griffon', 3, 2, 4);
    const o = getGameOutcome(cm);
    expect(o.winner).toBe('gold'); expect(o.reason).toBe('checkmate');

    const sm = emptyState('scarlet');
    const Q = (id: string, color: Color, type: string, l: number, f: number, r: number) => { sm.pieces[id] = { id, color, type, level: l, file: f, rank: r }; };
    Q('gk', 'gold', 'king', 2, 11, 0);
    Q('sk', 'scarlet', 'king', 2, 0, 7);
    Q('h1', 'gold', 'hero', 2, 2, 4);
    Q('h2', 'gold', 'hero', 2, 3, 4);
    Q('u1', 'gold', 'unicorn', 2, 2, 5);
    Q('b1', 'gold', 'basilisk', 1, 0, 6);
    Q('gr1', 'gold', 'griffon', 3, 2, 4);
    expect(isKingInCheck(sm, 'scarlet')).toBe(false);
    const o2 = getGameOutcome(sm);
    expect(o2.winner).toBeNull(); expect(o2.reason).toBe('stalemate (draw)');
  });

  test('Serialization preserves ids', () => {
    const s = createInitialState(); const str = JSON.stringify(serializeState(s)); const d = deserializeState(JSON.parse(str));
    const a = Object.keys(s.pieces).sort().join(), b = Object.keys(d.pieces).sort().join();
    expect(a).toBe(b);
    for (const id in s.pieces) expect(coordToNotation(s.pieces[id])).toBe(coordToNotation(d.pieces[id]));
  });

  test('Stale version rejected', () => {
    const s = createInitialState(); const id = findId(s, 'gold', 'warrior', '2a2')!;
    const m = generateLegalMoves(s, id)[0];
    const r1 = localCommitMove(s, m, 0); expect(r1.ok).toBe(true);
    const r2 = localCommitMove(r1.state!, m, 0); expect(r2.ok).toBe(false);
  });

  test('kingsMutuallyAttacking + cloneState independence', () => {
    const s = emptyState('gold');
    addP(s, 'gk', 'gold', 'king', 2, 5, 4);
    addP(s, 'sk', 'scarlet', 'king', 2, 5, 5);
    expect(kingsMutuallyAttacking(s)).toBe(true);
    const c = cloneState(s);
    c.pieces['gk'].level = 9;
    expect(s.pieces['gk'].level).toBe(2);
    void pieceAt; void moveToNotation;
  });
});

describe('formatMoveNotation (authoritative server notation)', () => {
  let formatMoveNotation: typeof import('../src/game-engine.js').formatMoveNotation;
  beforeAll(async () => { ({ formatMoveNotation } = await import('../src/game-engine.js')); });
  function move(kind: any, pieceId: string, from: any, to: any, captured: string | null = null, promotion: string | null = null) {
    return { kind, pieceId, from, to, capturedPieceId: captured, promotion };
  }

  test('normal same-level move', () => {
    const s = emptyState('gold'); addP(s, 'w', 'gold', 'warrior', 2, 1, 1);
    const m = move('move', 'w', { level: 2, file: 1, rank: 1 }, { level: 2, file: 1, rank: 2 });
    expect(formatMoveNotation(s, m, 'Anna')).toBe('Anna (Gold) - Ground - Warrior - B2 - B3');
  });

  test('capture appends = <captured>', () => {
    const s = emptyState('gold');
    addP(s, 'w', 'gold', 'warrior', 2, 1, 1);
    addP(s, 't', 'scarlet', 'thief', 2, 2, 2);
    const m = move('move', 'w', { level: 2, file: 1, rank: 1 }, { level: 2, file: 2, rank: 2 }, 't');
    expect(formatMoveNotation(s, m, 'Anna')).toBe('Anna (Gold) - Ground - Warrior - B2 - C3 = Thief');
  });

  test('cross-level uses From→To realm', () => {
    const s = emptyState('scarlet'); addP(s, 'h', 'scarlet', 'hero', 2, 3, 4);
    const m = move('move', 'h', { level: 2, file: 3, rank: 4 }, { level: 3, file: 4, rank: 5 });
    expect(formatMoveNotation(s, m, 'Noah')).toBe('Noah (Scarlet) - Ground→Sky - Hero - D5 - E6');
  });

  test('remote capture keeps source/dest coords even when identical', () => {
    const s = emptyState('gold');
    addP(s, 'd', 'gold', 'dragon', 3, 5, 3);
    addP(s, 'x', 'scarlet', 'warrior', 2, 5, 3);
    const m = move('remoteCapture', 'd', { level: 3, file: 5, rank: 3 }, { level: 2, file: 5, rank: 3 }, 'x');
    expect(formatMoveNotation(s, m, 'Anna')).toBe('Anna (Gold) - Sky→Ground - Dragon - F4 - F4 = Warrior (remote capture)');
  });

  test('promotion appends → <piece> after capture, never overloading =', () => {
    const s = emptyState('gold');
    addP(s, 'w', 'gold', 'warrior', 2, 1, 6);
    addP(s, 't', 'scarlet', 'thief', 2, 2, 7);
    const m = move('move', 'w', { level: 2, file: 1, rank: 6 }, { level: 2, file: 2, rank: 7 }, 't', 'hero');
    expect(formatMoveNotation(s, m, 'Anna')).toBe('Anna (Gold) - Ground - Warrior - B7 - C8 = Thief → Hero');
  });

  test('promotion with no capture', () => {
    const s = emptyState('gold'); addP(s, 'w', 'gold', 'warrior', 2, 1, 6);
    const m = move('move', 'w', { level: 2, file: 1, rank: 6 }, { level: 2, file: 1, rank: 7 }, null, 'hero');
    expect(formatMoveNotation(s, m, 'Anna')).toBe('Anna (Gold) - Ground - Warrior - B7 - B8 → Hero');
  });

  test('missing username falls back to Unknown', () => {
    const s = emptyState('gold'); addP(s, 'w', 'gold', 'warrior', 2, 1, 1);
    const m = move('move', 'w', { level: 2, file: 1, rank: 1 }, { level: 2, file: 1, rank: 2 });
    expect(formatMoveNotation(s, m, '')).toBe('Unknown (Gold) - Ground - Warrior - B2 - B3');
  });
});

describe('Warrior move generation (area 6)', () => {
  const W = (id: string, color: Color, l: number, f: number, r: number): State => {
    const s = emptyState();
    addP(s, id, color, 'warrior', l, f, r);
    return s;
  };

  const ck = (m: any) => key(m.to);

  test('Gold: one forward move to an empty square, no capture', () => {
    const s = W('w1', 'gold', 2, 5, 3);
    const moves = generatePseudoMoves(s, 'w1');
    expect(moves.map(ck).sort()).toEqual(['2,5,4']);
    const fwd = moves.find((m) => m.to.file === 5 && m.to.rank === 4)!;
    expect(fwd.capturedPieceId).toBeNull();
    expect(fwd.promotion).toBeNull();
  });

  test('Gold: blocked forward square yields no forward move (forward cannot capture)', () => {
    const s = W('w1', 'gold', 2, 5, 3);
    addP(s, 'blk', 'scarlet', 'warrior', 2, 5, 4);
    const moves = generatePseudoMoves(s, 'w1');
    const fwd = moves.find((m) => m.to.file === 5 && m.to.rank === 4);
    expect(fwd).toBeUndefined();
    expect(moves.length).toBe(0);
  });

  test('Gold: both diagonal-forward squares capture enemies', () => {
    const s = W('w1', 'gold', 2, 5, 3);
    addP(s, 'e1', 'scarlet', 'warrior', 2, 4, 4);
    addP(s, 'e2', 'scarlet', 'warrior', 2, 6, 4);
    const moves = generatePseudoMoves(s, 'w1');
    const caps = moves.filter((m) => m.capturedPieceId);
    expect(caps.map(ck).sort()).toEqual(['2,4,4', '2,6,4']);
    expect(caps.map((m) => m.capturedPieceId).sort()).toEqual(['e1', 'e2']);
  });

  test('Gold: empty diagonal-forward squares produce no move (capture-only)', () => {
    const s = W('w1', 'gold', 2, 5, 3);
    const moves = generatePseudoMoves(s, 'w1');
    expect(moves.map(ck).sort()).toEqual(['2,5,4']);
  });

  test('Gold: no double-step forward', () => {
    const s = W('w1', 'gold', 2, 5, 3);
    const moves = generatePseudoMoves(s, 'w1');
    expect(moves.find((m) => m.to.rank === 5)).toBeUndefined();
  });

  test('Gold: never moves off the Ground (level 2) layer (no cross-level)', () => {
    const s = W('w1', 'gold', 2, 5, 3);
    const moves = generatePseudoMoves(s, 'w1');
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.to.level === 2)).toBe(true);
  });

  test('Gold: non-capturing promotion on the farthest rank (rank 7)', () => {
    const s = W('w1', 'gold', 2, 5, 6);
    const moves = generatePseudoMoves(s, 'w1');
    const fwd = moves.find((m) => m.to.file === 5 && m.to.rank === 7)!;
    expect(fwd).toBeDefined();
    expect(fwd.capturedPieceId).toBeNull();
    expect(fwd.promotion).toBe('hero');
  });

  test('Gold: capturing promotion on the farthest rank (diagonal-forward)', () => {
    const s = W('w1', 'gold', 2, 5, 6);
    addP(s, 'e1', 'scarlet', 'warrior', 2, 4, 7);
    const moves = generatePseudoMoves(s, 'w1');
    const cap = moves.find((m) => m.to.file === 4 && m.to.rank === 7)!;
    expect(cap).toBeDefined();
    expect(cap.capturedPieceId).toBe('e1');
    expect(cap.promotion).toBe('hero');
  });

  test('Scarlet: one forward move to an empty square (rank decreases)', () => {
    const s = W('s1', 'scarlet', 2, 5, 4);
    const moves = generatePseudoMoves(s, 's1');
    expect(moves.map(ck).sort()).toEqual(['2,5,3']);
  });

  test('Scarlet: both diagonal-forward squares capture enemies (rank decreases)', () => {
    const s = W('s1', 'scarlet', 2, 5, 4);
    addP(s, 'e1', 'gold', 'warrior', 2, 4, 3);
    addP(s, 'e2', 'gold', 'warrior', 2, 6, 3);
    const moves = generatePseudoMoves(s, 's1');
    const caps = moves.filter((m) => m.capturedPieceId);
    expect(caps.map(ck).sort()).toEqual(['2,4,3', '2,6,3']);
  });

  test('Scarlet: non-capturing promotion on the farthest rank (rank 0)', () => {
    const s = W('s1', 'scarlet', 2, 5, 1);
    const moves = generatePseudoMoves(s, 's1');
    const fwd = moves.find((m) => m.to.file === 5 && m.to.rank === 0)!;
    expect(fwd).toBeDefined();
    expect(fwd.promotion).toBe('hero');
  });

  test('Scarlet: capturing promotion on the farthest rank (diagonal-forward to rank 0)', () => {
    const s = W('s1', 'scarlet', 2, 5, 1);
    addP(s, 'e1', 'gold', 'warrior', 2, 6, 0);
    const moves = generatePseudoMoves(s, 's1');
    const cap = moves.find((m) => m.to.file === 6 && m.to.rank === 0)!;
    expect(cap).toBeDefined();
    expect(cap.capturedPieceId).toBe('e1');
    expect(cap.promotion).toBe('hero');
  });

  test('Pin: a diagonal capture that exposes the king is pseudo-legal but illegal', () => {
    const s = emptyState('gold');
    // warrior shields the king from the mage on file 5; capturing diagonally exposes it
    addP(s, 'kg', 'gold', 'king', 2, 5, 0);
    addP(s, 'wg', 'gold', 'warrior', 2, 5, 1);
    addP(s, 'ms', 'scarlet', 'mage', 2, 5, 7);
    addP(s, 'es', 'scarlet', 'warrior', 2, 4, 2);

    const pseudo = generatePseudoMoves(s, 'wg');
    const legal = generateLegalMoves(s, 'wg');

    const capPseudo = pseudo.find((m) => m.to.file === 4 && m.to.rank === 2);
    const capLegal = legal.find((m) => m.to.file === 4 && m.to.rank === 2);
    expect(capPseudo).toBeDefined();
    expect(capLegal).toBeUndefined();

    const fwdLegal = legal.find((m) => m.to.file === 5 && m.to.rank === 2);
    expect(fwdLegal).toBeDefined();
  });
});