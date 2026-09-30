export const STARTING_RATING = 1000;
export const K_FACTOR = 32;

export interface EloResult {
  aBefore: number;
  bBefore: number;
  aAfter: number;
  bAfter: number;
  aChange: number;
  bChange: number;
}

export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

function clampRound(r: number): number {
  return Math.max(0, Math.round(r));
}

export function applyElo(ratingA: number, ratingB: number, scoreA: number): EloResult {
  const ea = expectedScore(ratingA, ratingB);
  const eb = expectedScore(ratingB, ratingA);
  const aAfter = clampRound(ratingA + K_FACTOR * (scoreA - ea));
  const bAfter = clampRound(ratingB + K_FACTOR * (1 - scoreA - eb));
  return {
    aBefore: ratingA, bBefore: ratingB,
    aAfter, bAfter,
    aChange: aAfter - ratingA,
    bChange: bAfter - ratingB,
  };
}