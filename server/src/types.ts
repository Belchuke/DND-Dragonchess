export type Color = 'gold' | 'scarlet';
export type MoveKind = 'move' | 'remoteCapture';
export type GameStatus = 'lobby' | 'active' | 'finished';
export type Seat = Color;

export interface Coord {
  level: number;
  file: number;
  rank: number;
}

export interface Piece {
  id: string;
  color: Color;
  type: string;
  level: number;
  file: number;
  rank: number;
  promoted?: boolean;
}

export interface Move {
  kind: MoveKind;
  pieceId: string;
  from: Coord;
  to: Coord;
  capturedPieceId: string | null;
  promotion: string | null;
}

export interface HistoryEntry {
  color: Color;
  notation: string;
  lastMove: string;
  version: number;
  from: Coord;
  to: Coord;
  moverUserId?: string | null;
  moverUsername?: string;
  moverColor?: Color;
  pieceType?: string | null;
  capturedType?: string | null;
  moveKind?: MoveKind;
  promotion?: string | null;
  realm?: string;
  fromRealm?: number;
  toRealm?: number;
  at?: number;
}

export interface State {
  schemaVersion: number;
  version: number;
  status: GameStatus;
  turn: Color;
  halfMove: number;
  pieces: Record<string, Piece>;
  moveHistory: HistoryEntry[];
  drawOfferBy: Color | null;
  winner: Color | null;
  resultReason: string | null;
  players: Record<Seat, PublicPlayer> | null;
}

export interface PublicPlayer {
  userId: string;
  username: string;
  rating: number;
  wins: number;
  draws: number;
  losses: number;
  connected: boolean;
}

export interface PublicGameState {
  schemaVersion: number;
  code: string;
  status: GameStatus;
  turn: Color;
  version: number;
  halfMove: number;
  pieces: Record<string, Piece>;
  moveHistory: HistoryEntry[];
  drawOfferBy: Color | null;
  winner: Color | null;
  resultReason: string | null;
  rematchCount: number;
  rated: boolean;
  rematchRequests: Record<Seat, boolean>;
  lastMove: string;
  players: Record<Seat, PublicPlayer>;
}

export interface Success<T> {
  ok: true;
  data: T;
}
export interface Failure {
  ok: false;
  error: { code: string; message: string };
}
export type Result<T> = Success<T> | Failure;

export interface JoinAck {
  code: string;
  token: string;
  seat: Seat;
  state: PublicGameState;
}

export interface StateAck {
  state: PublicGameState;
  seat: Seat;
}

export interface ResumePayload {
  code?: unknown;
  token?: unknown;
}
export interface SeatPayload {
  code?: unknown;
  token?: unknown;
}
export interface MovePayload {
  code?: unknown;
  token?: unknown;
  expectedVersion?: unknown;
  pieceId?: unknown;
  kind?: unknown;
  from?: unknown;
  to?: unknown;
}
export interface DrawAnswerPayload extends SeatPayload {
  accept?: unknown;
}
export interface JoinPayload {
  code?: unknown;
}

export interface ProfilePayload {
  id: number;
  username: string;
  rating: number;
  gamesPlayed: number;
  wins: number;
  draws: number;
  losses: number;
}

export interface MatchedPayload extends JoinAck {
  rated: boolean;
}

export interface MatchmakingStatus {
  waiting: boolean;
  queueSize: number;
  elapsedMs: number;
}

export interface ServerToClientEvents {
  'game:state': (state: PublicGameState) => void;
  'game:error': (error: { code: string; message: string }) => void;
  'profile:refresh': (profile: ProfilePayload) => void;
  'matchmaking:status': (s: MatchmakingStatus) => void;
  'matchmaking:matched': (m: MatchedPayload) => void;
}

export interface ClientToServerEvents {
  'game:create': (ack: (r: Result<JoinAck>) => void) => void;
  'game:join': (p: JoinPayload, ack: (r: Result<JoinAck>) => void) => void;
  'game:resume': (p: ResumePayload, ack: (r: Result<JoinAck>) => void) => void;
  'game:move': (p: MovePayload, ack: (r: Result<StateAck>) => void) => void;
  'game:resign': (p: SeatPayload, ack: (r: Result<StateAck>) => void) => void;
  'draw:offer': (p: SeatPayload, ack: (r: Result<StateAck>) => void) => void;
  'draw:answer': (p: DrawAnswerPayload, ack: (r: Result<StateAck>) => void) => void;
  'game:rematch': (p: SeatPayload, ack: (r: Result<StateAck>) => void) => void;
  'game:rematch:cancel': (p: SeatPayload, ack: (r: Result<null>) => void) => void;
  'game:leave': (p: SeatPayload, ack: (r: Result<null>) => void) => void;
  'matchmaking:join': (ack: (r: Result<{ queued: boolean }>) => void) => void;
  'matchmaking:cancel': (ack: (r: Result<null>) => void) => void;
}