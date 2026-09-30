import bcrypt from 'bcryptjs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DEV_PEPPER = 'dev-only-pepper-DO-NOT-USE-IN-PRODUCTION';
let devPepperWarned = false;

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function bcryptCost(): number {
  const raw = process.env.BCRYPT_COST;
  if (raw == null || raw === '') return 12;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`BCRYPT_COST must be an integer (got ${String(raw)})`);
  }
  if (n < 10) throw new Error(`BCRYPT_COST must be >= 10 (got ${n})`);
  if (n > 31) throw new Error(`BCRYPT_COST must be <= 31 (got ${n})`);
  return n;
}

export function getPepper(): string | null {
  const p = process.env.PASSWORD_PEPPER;
  if (typeof p === 'string' && p.length > 0) return p;
  if (isProduction()) return null;
  if (!devPepperWarned) {
    devPepperWarned = true;
    console.warn('[auth] PASSWORD_PEPPER not set: using a dev-only value. Do NOT use in production.');
  }
  return DEV_PEPPER;
}

export function assertProductionAuthConfig(): void {
  if (isProduction() && getPepper() == null) {
    throw new Error('PASSWORD_PEPPER is required in production. Set it in the environment.');
  }
  bcryptCost();
}

function pepperInput(password: string): string {
  const pepper = getPepper();
  if (pepper == null) {
    throw new Error('PASSWORD_PEPPER is required and not set.');
  }
  return createHmac('sha256', pepper).update(password, 'utf8').digest('base64url');
}

export async function hashPassword(password: string): Promise<string> {
  const cost = bcryptCost();
  const input = pepperInput(password);
  const salt = await bcrypt.genSalt(cost);
  return bcrypt.hash(input, salt);
}

export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  try {
    if (!isBcryptHash(encoded)) return false;
    const input = pepperInput(password);
    return await bcrypt.compare(input, encoded);
  } catch {
    return false;
  }
}

export function isBcryptHash(s: string): boolean {
  return typeof s === 'string' && /^\$2[aby]\$\d{2}\$.{53}$/.test(s);
}

export function isLegacyHash(s: string): boolean {
  return typeof s === 'string' && s.startsWith('$argon2');
}

export function bcryptSalt(encoded: string): string {
  if (!isBcryptHash(encoded)) return '';
  // $2b$cost$<22-char-salt><31-char-hash>
  return encoded.slice(0, 29);
}

export function bcryptCostOf(encoded: string): number {
  const m = /^\$2[aby]\$(\d{2})\$/.exec(encoded);
  return m ? Number(m[1]) : NaN;
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashSessionToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function tokenHashMatches(stored: string, candidate: string): boolean {
  if (stored.length !== candidate.length) return false;
  try {
    return timingSafeEqual(Buffer.from(stored), Buffer.from(candidate));
  } catch {
    return false;
  }
}

export const PROD_COOKIE_NAME = '__Host-dragonchess_session';
export const DEV_COOKIE_NAME = 'dragonchess_session';
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export function cookieName(): string {
  return isProduction() ? PROD_COOKIE_NAME : DEV_COOKIE_NAME;
}

export function parseCookies(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function readSessionCookie(cookieHeader: string | undefined | null): string | null {
  const c = parseCookies(cookieHeader);
  const raw = c[PROD_COOKIE_NAME] || c[DEV_COOKIE_NAME] || null;
  return raw || null;
}

export function sessionCookie(raw: string, opts: { maxAge?: number } = {}): string {
  const maxAge = opts.maxAge ?? SESSION_MAX_AGE;
  const parts = [`${cookieName()}=${raw}`, 'HttpOnly', `SameSite=Lax`, `Path=/`, `Max-Age=${maxAge}`];
  if (isProduction()) parts.push('Secure');
  return parts.join('; ');
}

export function expiredSessionCookie(): string {
  const parts = [`${cookieName()}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
  if (isProduction()) parts.push('Secure');
  return parts.join('; ');
}

export const USERNAME_RE = /^[A-Za-z0-9_-]+$/;
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function validateUsername(username: unknown): { ok: true; value: string } | { ok: false; code: string; message: string } {
  if (typeof username !== 'string') return { ok: false, code: 'bad-username', message: 'Username is required.' };
  const trimmed = username.trim();
  if (trimmed.length < USERNAME_MIN || trimmed.length > USERNAME_MAX)
    return { ok: false, code: 'bad-username', message: `Username must be ${USERNAME_MIN}–${USERNAME_MAX} characters.` };
  if (!USERNAME_RE.test(trimmed))
    return { ok: false, code: 'bad-username', message: 'Username may only contain letters, numbers, underscore, and hyphen.' };
  return { ok: true, value: trimmed };
}

export function validatePassword(password: unknown): { ok: true } | { ok: false; code: string; message: string } {
  if (typeof password !== 'string') return { ok: false, code: 'bad-password', message: 'Password is required.' };
  const len = [...password].length; // code points, not UTF-16 units
  if (len < PASSWORD_MIN || len > PASSWORD_MAX)
    return { ok: false, code: 'bad-password', message: `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.` };
  if (isCommonPassword(password))
    return { ok: false, code: 'bad-password', message: 'That password is too common. Choose another.' };
  return { ok: true };
}

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234',
  '12345678', '123456789', '1234567890', '11111111', '00000000',
  'qwerty12', 'qwerty123', 'iloveyou', 'letmein1', 'abc12345', 'abcd1234',
  'baseball', 'football', 'dragon12', 'monkey12', 'admin123', 'welcome1',
  'changeme1', 'passw0rd1', 'passw0rd',
]);

export function isCommonPassword(password: string): boolean {
  const norm = String(password).replace(/\s+/g, ' ').trim().toLowerCase();
  if (COMMON_PASSWORDS.has(norm)) return true;
  if (norm.length >= 8 && /^(.)\1{7,}$/.test(norm)) return true;
  return false;
}

export function passwordWarning(password: string): string | null {
  if (typeof password !== 'string' || password.length === 0) return null;
  if (password.length >= 12) return null;
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSym = /[^A-Za-z0-9]/.test(password);
  const classes = [hasLower, hasUpper, hasDigit, hasSym].filter(Boolean).length;
  if (password.length <= 10 && classes <= 1) {
    return 'That password is short and simple — consider a longer, more varied password.';
  }
  if (password.length <= 8 && classes <= 2) {
    return 'Eight-character passwords can be weak — consider a longer or more varied password.';
  }
  return null;
}

export const GENERIC_AUTH_ERROR = 'Invalid username or password';

interface Bucket { count: number; resetAt: number; }

export class RateLimiter {
  private map = new Map<string, Bucket>();
  constructor(private windowMs: number, private max: number) {}

  check(key: string): boolean {
    const now = Date.now();
    const b = this.map.get(key);
    if (!b || now >= b.resetAt) {
      this.map.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    b.count++;
    return b.count <= this.max;
  }

  peek(key: string): number {
    const b = this.map.get(key);
    if (!b || Date.now() >= b.resetAt) return 0;
    return b.count;
  }

  clear(): void { this.map.clear(); }
}