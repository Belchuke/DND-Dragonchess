import { randomBytes } from 'node:crypto';

export interface QueueEntry {
  userId: number;
  rating: number;
  socketId: string;
  joinedAt: number;
}

export interface MatchPair {
  a: QueueEntry;
  b: QueueEntry;
}

export class MatchmakingQueue {
  private entries = new Map<number, QueueEntry>();

  size(): number {
    return this.entries.size;
  }

  has(userId: number): boolean {
    return this.entries.has(userId);
  }

  add(userId: number, rating: number, socketId: string, now: number = Date.now()): boolean {
    if (this.entries.has(userId)) return false;
    this.entries.set(userId, { userId, rating, socketId, joinedAt: now });
    return true;
  }

  relink(userId: number, socketId: string): boolean {
    const e = this.entries.get(userId);
    if (!e) return false;
    e.socketId = socketId;
    return true;
  }

  remove(userId: number): boolean {
    return this.entries.delete(userId);
  }

  entry(userId: number): QueueEntry | undefined {
    return this.entries.get(userId);
  }

  bestCandidate(userId: number): QueueEntry | null {
    let best: QueueEntry | null = null;
    let bestDiff = Infinity;
    for (const e of this.entries.values()) {
      if (e.userId === userId) continue;
      const diff = Math.abs(e.rating - (this.entries.get(userId)?.rating ?? 0));
      if (diff < bestDiff || (diff === bestDiff && best && e.joinedAt < best.joinedAt)) {
        best = e;
        bestDiff = diff;
      }
    }
    return best;
  }

  tryMatch(userId: number): MatchPair | null {
    const a = this.entries.get(userId);
    if (!a) return null;
    const b = this.bestCandidate(userId);
    if (!b) return null;
    this.entries.delete(a.userId);
    this.entries.delete(b.userId);
    return { a, b };
  }

  snapshot(): { userId: number; rating: number; joinedAt: number }[] {
    return Array.from(this.entries.values()).map((e) => ({
      userId: e.userId, rating: e.rating, joinedAt: e.joinedAt,
    }));
  }

  clear(): void {
    this.entries.clear();
  }
}

export function randomColour(): 'gold' | 'scarlet' {
  return randomBytes(1)[0] % 2 === 0 ? 'gold' : 'scarlet';
}