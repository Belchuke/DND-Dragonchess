import type { Color, Coord, HistoryEntry, Move, MoveKind, Piece, State } from './types.js';

export const TYPE_ABBR: Record<string, string> = {
  sylph: 'S', griffon: 'G', dragon: 'R', warrior: 'W', oliphant: 'O',
  unicorn: 'U', hero: 'H', thief: 'T', cleric: 'C', mage: 'M', king: 'K',
  paladin: 'P', dwarf: 'D', basilisk: 'B', elemental: 'E',
};
export const ABBR_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(TYPE_ABBR).map(([k, v]) => [v, k]),
);
export const REALM_OF: Record<string, string> = {
  sylph: 'sky', griffon: 'sky', dragon: 'sky', warrior: 'ground', oliphant: 'ground',
  unicorn: 'ground', hero: 'ground', thief: 'ground', cleric: 'ground', mage: 'ground',
  king: 'ground', paladin: 'ground', dwarf: 'under', basilisk: 'under', elemental: 'under',
};
export const LEVEL_NAME: Record<number, string> = { 3: 'Sky', 2: 'Ground', 1: 'Underworld' };

export const TYPE_NAME: Record<string, string> = {
  sylph: 'Sylph', griffon: 'Griffon', dragon: 'Dragon', warrior: 'Warrior',
  oliphant: 'Oliphant', unicorn: 'Unicorn', hero: 'Hero', thief: 'Thief',
  cleric: 'Cleric', mage: 'Mage', king: 'King', paladin: 'Paladin',
  dwarf: 'Dwarf', basilisk: 'Basilisk', elemental: 'Elemental',
};

export function squareName(c: Coord): string {
  return String.fromCharCode(65 + c.file) + (c.rank + 1);
}

export function colourCode(color: Color): string {
  return color === 'gold' ? 'G' : 'S';
}

export const VALID_TYPES = new Set(Object.keys(TYPE_ABBR));

export const inBounds = (l: number, f: number, r: number): boolean =>
  l >= 1 && l <= 3 && f >= 0 && f <= 11 && r >= 0 && r <= 7;
export const key = (c: Coord): string => `${c.level},${c.file},${c.rank}`;
export const coordEq = (a: Coord, b: Coord): boolean =>
  a.level === b.level && a.file === b.file && a.rank === b.rank;
export const fwd = (color: Color): number => (color === 'gold' ? 1 : -1);
export const opp = (c: Color): Color => (c === 'gold' ? 'scarlet' : 'gold');
export const fileChar = (f: number): string => String.fromCharCode(97 + f);
export const rankChar = (r: number): string => String(r + 1);

export function coordToNotation(c: Coord): string {
  return c.level + fileChar(c.file) + rankChar(c.rank);
}
export function notationToCoord(s: string | undefined | null): Coord | null {
  const m = /^([123])([a-l])([1-8])$/.exec((s || '').trim());
  if (!m) return null;
  return { level: +m[1], file: m[2].charCodeAt(0) - 97, rank: +m[3] - 1 };
}

export function pieceAt(state: State, c: Coord): Piece | null {
  for (const id in state.pieces) {
    const p = state.pieces[id];
    if (p.level === c.level && p.file === c.file && p.rank === c.rank) return p;
  }
  return null;
}
export function findKing(state: State, color: Color): Piece | null {
  for (const id in state.pieces) {
    const p = state.pieces[id];
    if (p.type === 'king' && p.color === color) return p;
  }
  return null;
}

let pieceCounter: Record<string, number> = {};
function makeId(color: Color, type: string): string {
  const base = `${color}-${type}`;
  pieceCounter[base] = (pieceCounter[base] || 0) + 1;
  return `${base}-${pieceCounter[base]}`;
}
function place(arr: Coord[], pieces: Record<string, Piece>, color: Color, type: string): void {
  for (const c of arr) {
    const id = makeId(color, type);
    pieces[id] = { id, color, type, level: c.level, file: c.file, rank: c.rank };
  }
}
export function createInitialState(): State {
  pieceCounter = {};
  const pieces: Record<string, Piece> = {};
  const G: Color = 'gold', S: Color = 'scarlet';
  place([{ level: 3, file: 2, rank: 0 }, { level: 3, file: 10, rank: 0 }], pieces, G, 'griffon');
  place([{ level: 3, file: 6, rank: 0 }], pieces, G, 'dragon');
  place([{ level: 3, file: 0, rank: 1 }, { level: 3, file: 2, rank: 1 }, { level: 3, file: 4, rank: 1 }, { level: 3, file: 6, rank: 1 }, { level: 3, file: 8, rank: 1 }, { level: 3, file: 10, rank: 1 }], pieces, G, 'sylph');
  place([{ level: 3, file: 2, rank: 7 }, { level: 3, file: 10, rank: 7 }], pieces, S, 'griffon');
  place([{ level: 3, file: 6, rank: 7 }], pieces, S, 'dragon');
  place([{ level: 3, file: 0, rank: 6 }, { level: 3, file: 2, rank: 6 }, { level: 3, file: 4, rank: 6 }, { level: 3, file: 6, rank: 6 }, { level: 3, file: 8, rank: 6 }, { level: 3, file: 10, rank: 6 }], pieces, S, 'sylph');
  const back = ['oliphant', 'unicorn', 'hero', 'thief', 'cleric', 'mage', 'king', 'paladin', 'thief', 'hero', 'unicorn', 'oliphant'];
  for (let f = 0; f < 12; f++) {
    const gid = makeId(G, back[f]); pieces[gid] = { id: gid, color: G, type: back[f], level: 2, file: f, rank: 0 };
    const sid = makeId(S, back[f]); pieces[sid] = { id: sid, color: S, type: back[f], level: 2, file: f, rank: 7 };
  }
  for (let f = 0; f < 12; f++) {
    const gid = makeId(G, 'warrior'); pieces[gid] = { id: gid, color: G, type: 'warrior', level: 2, file: f, rank: 1 };
    const sid = makeId(S, 'warrior'); pieces[sid] = { id: sid, color: S, type: 'warrior', level: 2, file: f, rank: 6 };
  }
  place([{ level: 1, file: 2, rank: 0 }, { level: 1, file: 10, rank: 0 }], pieces, G, 'basilisk');
  place([{ level: 1, file: 6, rank: 0 }], pieces, G, 'elemental');
  place([{ level: 1, file: 1, rank: 1 }, { level: 1, file: 3, rank: 1 }, { level: 1, file: 5, rank: 1 }, { level: 1, file: 7, rank: 1 }, { level: 1, file: 9, rank: 1 }, { level: 1, file: 11, rank: 1 }], pieces, G, 'dwarf');
  place([{ level: 1, file: 2, rank: 7 }, { level: 1, file: 10, rank: 7 }], pieces, S, 'basilisk');
  place([{ level: 1, file: 6, rank: 7 }], pieces, S, 'elemental');
  place([{ level: 1, file: 1, rank: 6 }, { level: 1, file: 3, rank: 6 }, { level: 1, file: 5, rank: 6 }, { level: 1, file: 7, rank: 6 }, { level: 1, file: 9, rank: 6 }, { level: 1, file: 11, rank: 6 }], pieces, S, 'dwarf');

  const counts: Record<Color, number> = { gold: 0, scarlet: 0 };
  for (const id in pieces) counts[pieces[id].color]++;
  if (counts.gold !== 42 || counts.scarlet !== 42)
    throw new Error('Bad setup count gold=' + counts.gold + ' scarlet=' + counts.scarlet);

  return {
    schemaVersion: 1, version: 0, status: 'active', turn: 'gold', halfMove: 0,
    pieces, moveHistory: [], drawOfferBy: null, winner: null, resultReason: null, players: null,
  };
}

export function generatePseudoMoves(state: State, pieceId: string): Move[] {
  const piece = state.pieces[pieceId];
  if (!piece) return [];
  const moves: Move[] = [];
  const from: Coord = { level: piece.level, file: piece.file, rank: piece.rank };
  const f = fwd(piece.color);
  const promoRank = piece.color === 'gold' ? 7 : 0;
  const push = (to: Coord, occ: Piece | null, promotion: string | null, captureOnly: boolean, moveOnly: boolean): void => {
    if (!inBounds(to.level, to.file, to.rank)) return;
    if (!occ) {
      if (!captureOnly) moves.push({ kind: 'move', pieceId: piece.id, from: { ...from }, to: { ...to }, capturedPieceId: null, promotion: promotion || null });
    } else if (occ.color !== piece.color) {
      if (!moveOnly) moves.push({ kind: 'move', pieceId: piece.id, from: { ...from }, to: { ...to }, capturedPieceId: occ.id, promotion: promotion || null });
    }
  };
  const addAny = (to: Coord, occ: Piece | null, promo?: string | null): void => push(to, occ, promo || null, false, false);
  const addMove = (to: Coord, occ: Piece | null, promo?: string | null): void => push(to, occ, promo || null, false, true);
  const addCap = (to: Coord, occ: Piece | null, promo?: string | null): void => push(to, occ, promo || null, true, false);
  const leapAny = (df: number, dr: number, ld: number): void =>
    addAny({ level: piece.level + ld, file: piece.file + df, rank: piece.rank + dr }, pieceAt(state, { level: piece.level + ld, file: piece.file + df, rank: piece.rank + dr }));
  function rayAny(dirs: Array<[number, number]>): void {
    for (const [df, dr] of dirs) {
      let nf = piece.file + df, nr = piece.rank + dr;
      while (inBounds(piece.level, nf, nr)) {
        const occ = pieceAt(state, { level: piece.level, file: nf, rank: nr });
        addAny({ level: piece.level, file: nf, rank: nr }, occ);
        if (occ) break;
        nf += df; nr += dr;
      }
    }
  }
  const vertAny = (ld: number): void =>
    addAny({ level: piece.level + ld, file: piece.file, rank: piece.rank }, pieceAt(state, { level: piece.level + ld, file: piece.file, rank: piece.rank }));

  switch (piece.type) {
    case 'sylph': {
      if (piece.level === 3) {
        for (const df of [-1, 1]) addMove({ level: 3, file: piece.file + df, rank: piece.rank + f }, pieceAt(state, { level: 3, file: piece.file + df, rank: piece.rank + f }));
        addCap({ level: 3, file: piece.file, rank: piece.rank + f }, pieceAt(state, { level: 3, file: piece.file, rank: piece.rank + f }));
        addCap({ level: 2, file: piece.file, rank: piece.rank }, pieceAt(state, { level: 2, file: piece.file, rank: piece.rank }));
      } else if (piece.level === 2) {
        addMove({ level: 3, file: piece.file, rank: piece.rank }, pieceAt(state, { level: 3, file: piece.file, rank: piece.rank }));
        const starts = piece.color === 'gold'
          ? [[0, 1], [2, 1], [4, 1], [6, 1], [8, 1], [10, 1]]
          : [[0, 6], [2, 6], [4, 6], [6, 6], [8, 6], [10, 6]];
        for (const [sf, sr] of starts) if (sf !== piece.file || sr !== piece.rank) addMove({ level: 3, file: sf, rank: sr }, pieceAt(state, { level: 3, file: sf, rank: sr }));
      }
      break;
    }
    case 'griffon': {
      if (piece.level === 3) {
        for (const [df, dr] of [[3, 2], [3, -2], [-3, 2], [-3, -2], [2, 3], [2, -3], [-2, 3], [-2, -3]]) leapAny(df, dr, 0);
        for (const df of [-1, 1]) for (const dr of [-1, 1]) leapAny(df, dr, -1);
      } else if (piece.level === 2) {
        for (const df of [-1, 1]) for (const dr of [-1, 1]) leapAny(df, dr, 0);
        for (const df of [-1, 1]) for (const dr of [-1, 1]) leapAny(df, dr, 1);
      }
      break;
    }
    case 'dragon': {
      rayAny([[1, 1], [1, -1], [-1, 1], [-1, -1]]);
      for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) leapAny(df, dr, 0);
      for (const [df, dr] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const to: Coord = { level: 2, file: piece.file + df, rank: piece.rank + dr };
        if (!inBounds(to.level, to.file, to.rank)) continue;
        const occ = pieceAt(state, to);
        if (occ && occ.color !== piece.color) moves.push({ kind: 'remoteCapture', pieceId: piece.id, from: { ...from }, to: { ...to }, capturedPieceId: occ.id, promotion: null });
      }
      break;
    }
    case 'warrior': {
      addMove({ level: 2, file: piece.file, rank: piece.rank + f }, pieceAt(state, { level: 2, file: piece.file, rank: piece.rank + f }), piece.rank + f === promoRank ? 'hero' : null);
      for (const df of [-1, 1]) addCap({ level: 2, file: piece.file + df, rank: piece.rank + f }, pieceAt(state, { level: 2, file: piece.file + df, rank: piece.rank + f }), piece.rank + f === promoRank ? 'hero' : null);
      break;
    }
    case 'oliphant': rayAny([[1, 0], [-1, 0], [0, 1], [0, -1]]); break;
    case 'unicorn': for (const [df, dr] of [[1, 2], [1, -2], [-1, 2], [-1, -2], [2, 1], [2, -1], [-2, 1], [-2, -1]]) leapAny(df, dr, 0); break;
    case 'hero': {
      if (piece.level === 2) {
        for (const df of [-1, 1]) for (const dr of [-1, 1]) { leapAny(df, dr, 0); leapAny(2 * df, 2 * dr, 0); }
        for (const df of [-1, 1]) for (const dr of [-1, 1]) { leapAny(df, dr, -1); leapAny(df, dr, 1); }
      } else {
        const ld = piece.level === 1 ? 1 : -1;
        for (const df of [-1, 1]) for (const dr of [-1, 1]) leapAny(df, dr, ld);
      }
      break;
    }
    case 'thief': rayAny([[1, 1], [1, -1], [-1, 1], [-1, -1]]); break;
    case 'cleric': {
      for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) leapAny(df, dr, 0);
      for (const ld of [-1, 1]) if (piece.level + ld >= 1 && piece.level + ld <= 3) vertAny(ld);
      break;
    }
    case 'mage': {
      if (piece.level === 2) rayAny([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]);
      else for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) leapAny(df, dr, 0);
      for (const ld of [-1, 1, -2, 2]) {
        const lvl = piece.level + ld; if (lvl < 1 || lvl > 3) continue;
        if (Math.abs(ld) === 2) { const mid = piece.level + Math.sign(ld); if (pieceAt(state, { level: mid, file: piece.file, rank: piece.rank })) continue; }
        vertAny(ld);
      }
      break;
    }
    case 'king': {
      if (piece.level === 2) {
        for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) leapAny(df, dr, 0);
        for (const ld of [-1, 1]) if (piece.level + ld >= 1 && piece.level + ld <= 3) vertAny(ld);
      } else { vertAny(piece.level === 1 ? 1 : -1); }
      break;
    }
    case 'paladin': {
      if (piece.level === 2) {
        for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) leapAny(df, dr, 0);
        for (const [df, dr] of [[1, 2], [1, -2], [-1, 2], [-1, -2], [2, 1], [2, -1], [-2, 1], [-2, -1]]) leapAny(df, dr, 0);
      } else {
        for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) leapAny(df, dr, 0);
      }
      for (const ld of [-1, 1]) {
        const lvl = piece.level + ld; if (lvl < 1 || lvl > 3) continue;
        for (const [df, dr] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) leapAny(df, dr, ld);
      }
      for (const ld of [-2, 2]) {
        const lvl = piece.level + ld; if (lvl < 1 || lvl > 3) continue;
        for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) leapAny(df, dr, ld);
      }
      break;
    }
    case 'dwarf': {
      addMove({ level: piece.level, file: piece.file, rank: piece.rank + f }, pieceAt(state, { level: piece.level, file: piece.file, rank: piece.rank + f }));
      for (const df of [-1, 1]) addMove({ level: piece.level, file: piece.file + df, rank: piece.rank }, pieceAt(state, { level: piece.level, file: piece.file + df, rank: piece.rank }));
      for (const df of [-1, 1]) addCap({ level: piece.level, file: piece.file + df, rank: piece.rank + f }, pieceAt(state, { level: piece.level, file: piece.file + df, rank: piece.rank + f }));
      if (piece.level === 1) addCap({ level: 2, file: piece.file, rank: piece.rank }, pieceAt(state, { level: 2, file: piece.file, rank: piece.rank }));
      else if (piece.level === 2) addMove({ level: 1, file: piece.file, rank: piece.rank }, pieceAt(state, { level: 1, file: piece.file, rank: piece.rank }));
      break;
    }
    case 'basilisk': {
      addAny({ level: 1, file: piece.file, rank: piece.rank + f }, pieceAt(state, { level: 1, file: piece.file, rank: piece.rank + f }));
      for (const df of [-1, 1]) addAny({ level: 1, file: piece.file + df, rank: piece.rank + f }, pieceAt(state, { level: 1, file: piece.file + df, rank: piece.rank + f }));
      addMove({ level: 1, file: piece.file, rank: piece.rank - f }, pieceAt(state, { level: 1, file: piece.file, rank: piece.rank - f }));
      break;
    }
    case 'elemental': {
      if (piece.level === 1) {
        for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const s1: Coord = { level: 1, file: piece.file + df, rank: piece.rank + dr };
          if (!inBounds(s1.level, s1.file, s1.rank)) continue;
          const o1 = pieceAt(state, s1);
          addAny(s1, o1);
          if (!o1) {
            const s2: Coord = { level: 1, file: piece.file + 2 * df, rank: piece.rank + 2 * dr };
            if (inBounds(s2.level, s2.file, s2.rank)) addAny(s2, pieceAt(state, s2));
          }
        }
        for (const [df, dr] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) addMove({ level: 1, file: piece.file + df, rank: piece.rank + dr }, pieceAt(state, { level: 1, file: piece.file + df, rank: piece.rank + dr }));
        for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const mid: Coord = { level: 1, file: piece.file + df, rank: piece.rank + dr };
          if (!inBounds(mid.level, mid.file, mid.rank)) continue;
          if (pieceAt(state, mid)) continue;
          const tgt: Coord = { level: 2, file: piece.file + df, rank: piece.rank + dr };
          const occ = pieceAt(state, tgt);
          if (occ && occ.color !== piece.color) moves.push({ kind: 'move', pieceId: piece.id, from: { ...from }, to: { ...tgt }, capturedPieceId: occ.id, promotion: null });
        }
      } else {
        const inter = pieceAt(state, { level: 1, file: piece.file, rank: piece.rank });
        if (!inter) {
          for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) addAny({ level: 1, file: piece.file + df, rank: piece.rank + dr }, pieceAt(state, { level: 1, file: piece.file + df, rank: piece.rank + dr }));
        }
      }
      break;
    }
  }
  return moves;
}

export function getFrozenPieceIds(state: State): Set<string> {
  const frozen = new Set<string>();
  for (const id in state.pieces) {
    const b = state.pieces[id];
    if (b.type !== 'basilisk') continue;
    const above = pieceAt(state, { level: 2, file: b.file, rank: b.rank });
    if (above && above.color !== b.color) frozen.add(above.id);
  }
  return frozen;
}
export function isFrozen(state: State, pieceId: string): boolean {
  return getFrozenPieceIds(state).has(pieceId);
}

export function generateAttackSquares(state: State, color: Color): Set<string> {
  const set = new Set<string>();
  for (const id in state.pieces) {
    const p = state.pieces[id];
    if (p.color !== color) continue;
    if (isFrozen(state, id)) continue;
    for (const m of generatePseudoMoves(state, id)) {
      if (m.capturedPieceId || m.kind === 'remoteCapture') set.add(key(m.to));
    }
  }
  return set;
}
export function kingsMutuallyAttacking(state: State): boolean {
  const ks: Piece[] = [];
  for (const id in state.pieces) if (state.pieces[id].type === 'king') ks.push(state.pieces[id]);
  if (ks.length !== 2) return false;
  const [a, b] = ks;
  if (a.level === b.level) return Math.abs(a.file - b.file) <= 1 && Math.abs(a.rank - b.rank) <= 1 && !(a.file === b.file && a.rank === b.rank);
  if (Math.abs(a.level - b.level) === 1 && a.file === b.file && a.rank === b.rank) return true;
  return false;
}
export function isKingInCheck(state: State, color: Color): boolean {
  const k = findKing(state, color);
  if (!k) return false;
  return generateAttackSquares(state, opp(color)).has(key(k));
}

export function generateLegalMoves(state: State, pieceId: string): Move[] {
  const p = state.pieces[pieceId];
  if (!p) return [];
  if (state.turn !== p.color) return [];
  if (isFrozen(state, pieceId)) return [];
  const out: Move[] = [];
  for (const m of generatePseudoMoves(state, pieceId)) {
    const sim = applyMoveImmutable(state, m);
    if (isKingInCheck(sim, p.color)) continue;
    if (kingsMutuallyAttacking(sim)) continue;
    out.push(m);
  }
  return out;
}
export function getAllLegalMoves(state: State, color: Color): Move[] {
  const out: Move[] = [];
  for (const id in state.pieces) {
    const p = state.pieces[id];
    if (p.color !== color) continue;
    if (state.turn !== color) return out;
    if (isFrozen(state, id)) continue;
    for (const m of generateLegalMoves(state, id)) out.push(m);
  }
  return out;
}

export function cloneState(s: State): State {
  const np: Record<string, Piece> = {};
  for (const id in s.pieces) np[id] = { ...s.pieces[id] };
  return {
    schemaVersion: s.schemaVersion, version: s.version, status: s.status, turn: s.turn,
    halfMove: s.halfMove, pieces: np, moveHistory: s.moveHistory.slice(),
    drawOfferBy: s.drawOfferBy, winner: s.winner, resultReason: s.resultReason,
    players: s.players ? JSON.parse(JSON.stringify(s.players)) : null,
  };
}
export function applyMoveImmutable(state: State, move: Move): State {
  const next = cloneState(state);
  const p = next.pieces[move.pieceId];
  if (!p) return next;
  if (move.kind === 'remoteCapture') {
    if (move.capturedPieceId) delete next.pieces[move.capturedPieceId];
  } else {
    if (move.capturedPieceId) delete next.pieces[move.capturedPieceId];
    p.level = move.to.level; p.file = move.to.file; p.rank = move.to.rank;
    if (move.promotion) { p.type = move.promotion; p.promoted = true; }
  }
  next.turn = opp(next.turn);
  next.version = (next.version || 0) + 1;
  return next;
}
function safeLabel(s: string): string {
  return String(s || '').replace(/[ -]/g, '').trim() || 'Unknown';
}

export function formatMoveNotation(before: State, move: Move, moverUsername: string): string {
  const mover = before.pieces[move.pieceId];
  if (!mover) return '';
  const user = safeLabel(moverUsername);
  const colorName = mover.color === 'gold' ? 'Gold' : 'Scarlet';
  const pieceName = TYPE_NAME[mover.type] || mover.type;
  const fromSq = squareName(move.from);
  const toSq = squareName(move.to);
  const crossLayer = move.from.level !== move.to.level;
  const realm = crossLayer
    ? `${LEVEL_NAME[move.from.level]}→${LEVEL_NAME[move.to.level]}`
    : LEVEL_NAME[move.from.level];
  let s = `${user} (${colorName}) - ${realm} - ${pieceName} - ${fromSq} - ${toSq}`;
  if (move.capturedPieceId) {
    const cap = before.pieces[move.capturedPieceId];
    if (cap) s += ` = ${TYPE_NAME[cap.type] || cap.type}`;
  }
  if (move.promotion) {
    s += ` → ${TYPE_NAME[move.promotion] || move.promotion}`;
  }
  if (move.kind === 'remoteCapture') {
    s += ` (remote capture)`;
  }
  return s;
}

export function moveToNotation(state: State, move: Move): string {
  const p = state.pieces[move.pieceId];
  if (!p) return '?';
  const ab = TYPE_ABBR[p.type];
  const sep = move.capturedPieceId ? '×' : '-';
  let s = ab + ' ' + coordToNotation(move.from) + sep + coordToNotation(move.to);
  if (move.kind === 'remoteCapture') s += ' (remote)';
  if (move.promotion) s += '=' + TYPE_ABBR[move.promotion];
  return s;
}

export function formatLastMove(before: State, move: Move): string {
  const mover = before.pieces[move.pieceId];
  if (!mover) return '';
  const name = TYPE_NAME[mover.type] || mover.type;
  const col = colourCode(mover.color);
  const fromSq = squareName(move.from);
  const toSq = squareName(move.to);
  const crossLayer = move.from.level !== move.to.level;

  if (move.kind === 'remoteCapture') {
    const cap = move.capturedPieceId ? before.pieces[move.capturedPieceId] : null;
    const capName = cap ? (TYPE_NAME[cap.type] || cap.type) : 'piece';
    return `${name} – ${col} ${LEVEL_NAME[move.from.level]} ${fromSq} = remote capture ${capName} on ${LEVEL_NAME[move.to.level]} ${toSq}`;
  }

  let s: string;
  if (crossLayer) {
    s = `${name} – ${col} ${LEVEL_NAME[move.from.level]} ${fromSq} → ${LEVEL_NAME[move.to.level]} ${toSq}`;
  } else {
    s = `${name} – ${col} ${fromSq} → ${toSq}`;
  }
  if (move.capturedPieceId) {
    const cap = before.pieces[move.capturedPieceId];
    if (cap) s += ` = ${TYPE_NAME[cap.type] || cap.type}`;
  }
  if (move.promotion) {
    s += ` (promotes to ${TYPE_NAME[move.promotion] || move.promotion})`;
  }
  return s;
}

export interface GameOutcome {
  over: boolean;
  winner?: Color | null;
  reason?: string | null;
  inCheck?: boolean;
}

export function getGameOutcome(state: State): GameOutcome {
  if (state.winner) return { over: true, winner: state.winner, reason: state.resultReason };
  if (state.status === 'finished') return { over: true, winner: null, reason: state.resultReason || 'finished' };
  const side = state.turn;
  const inChk = isKingInCheck(state, side);
  const moves = getAllLegalMoves(state, side);
  if (moves.length === 0) {
    if (inChk) return { over: true, winner: opp(side), reason: 'checkmate' };
    return { over: true, winner: null, reason: 'stalemate (draw)' };
  }
  return { over: false, inCheck: inChk };
}

export function serializeState(state: State): State {
  return JSON.parse(JSON.stringify(state));
}
export function deserializeState(obj: any): State {
  if (!obj || typeof obj !== 'object') throw new Error('bad state');
  const s: State = {
    schemaVersion: obj.schemaVersion || 1, version: obj.version || 0, status: obj.status || 'active',
    turn: obj.turn || 'gold', halfMove: obj.halfMove || 0,
    pieces: {}, moveHistory: Array.isArray(obj.moveHistory) ? obj.moveHistory : [],
    drawOfferBy: obj.drawOfferBy || null, winner: obj.winner || null, resultReason: obj.resultReason || null,
    players: obj.players || null,
  };
  if (obj.pieces) {
    for (const id in obj.pieces) {
      const p = obj.pieces[id];
      if (p && typeof p === 'object') s.pieces[id] = { ...p };
    }
  }
  validateState(s);
  return s;
}

export function validateState(state: State, allowNoKing?: boolean): void {
  if (state.schemaVersion !== 1) throw new Error('bad schema ' + state.schemaVersion);
  if (state.turn !== 'gold' && state.turn !== 'scarlet') throw new Error('bad turn ' + state.turn);
  if (state.status !== 'active' && state.status !== 'lobby' && state.status !== 'finished') throw new Error('bad status ' + state.status);
  const coords = new Set<string>(), ids = new Set<string>(), kings: Record<Color, number> = { gold: 0, scarlet: 0 };
  for (const id in state.pieces) {
    const p = state.pieces[id];
    if (ids.has(id)) throw new Error('dup id ' + id); ids.add(id);
    if (!VALID_TYPES.has(p.type)) throw new Error('bad type ' + p.type);
    if (p.color !== 'gold' && p.color !== 'scarlet') throw new Error('bad color ' + p.color);
    if (!inBounds(p.level, p.file, p.rank)) throw new Error('oob ' + id);
    const ck = key(p); if (coords.has(ck)) throw new Error('dup coord ' + ck); coords.add(ck);
    if (p.type === 'king') kings[p.color]++;
  }
  if (!allowNoKing) {
    if (kings.gold !== 1) throw new Error('gold kings ' + kings.gold);
    if (kings.scarlet !== 1) throw new Error('scarlet kings ' + kings.scarlet);
  }
  if (!Array.isArray(state.moveHistory)) throw new Error('bad history');
}

export interface LocalCommitResult {
  ok: boolean;
  state?: State;
  reason?: string;
}
export function localCommitMove(state: State, move: Move, expectedVersion: number): LocalCommitResult {
  if (state.version !== expectedVersion) return { ok: false, reason: 'stale version' };
  const p = state.pieces[move.pieceId];
  if (!p || p.color !== state.turn) return { ok: false, reason: 'not your piece' };
  const legal = generateLegalMoves(state, move.pieceId).some(m =>
    m.kind === move.kind && m.pieceId === move.pieceId && coordEq(m.from, move.from) && coordEq(m.to, move.to),
  );
  if (!legal) return { ok: false, reason: 'illegal move' };
  const next = applyMoveImmutable(state, move);
  const entry: HistoryEntry = { color: state.turn, notation: moveToNotation(state, move), lastMove: formatLastMove(state, move), version: next.version, from: move.from, to: move.to };
  next.moveHistory = state.moveHistory.concat([entry]);
  const outcome = getGameOutcome(next);
  if (outcome.over) { next.status = 'finished'; next.winner = outcome.winner || null; next.resultReason = outcome.reason || null; }
  return { ok: true, state: next };
}

export type { MoveKind };