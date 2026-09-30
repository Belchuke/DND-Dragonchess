import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  hashPassword, verifyPassword, isBcryptHash, bcryptSalt, bcryptCostOf,
  isLegacyHash, generateSessionToken, hashSessionToken, tokenHashMatches,
  PROD_COOKIE_NAME, DEV_COOKIE_NAME, SESSION_MAX_AGE,
  cookieName, sessionCookie, expiredSessionCookie, parseCookies, readSessionCookie,
  validateUsername, validatePassword, normalizeUsername, passwordWarning,
  isCommonPassword, assertProductionAuthConfig, bcryptCost,
  GENERIC_AUTH_ERROR, RateLimiter,
  USERNAME_MIN, USERNAME_MAX, PASSWORD_MIN, PASSWORD_MAX,
} from '../src/auth.js';

beforeEach(() => { process.env.BCRYPT_COST = '10'; });
afterEach(() => { delete process.env.BCRYPT_COST; });

describe('password hashing (bcrypt + pepper)', () => {
  test('hash is a bcrypt string, not MD5/SHA-1/SHA-256', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(isBcryptHash(h)).toBe(true);
    expect(h.startsWith('$2')).toBe(true);
    expect(h.toLowerCase()).not.toContain('md5');
    expect(h.toLowerCase()).not.toContain('sha1');
    expect(h.toLowerCase()).not.toContain('sha256');
    expect(h.toLowerCase()).not.toContain('argon2');
  });

  test('each hash has a unique salt (two hashes of the same password differ)', async () => {
    const a = await hashPassword('same-password-1');
    const b = await hashPassword('same-password-1');
    expect(a).not.toBe(b);
    expect(bcryptSalt(a)).not.toBe(bcryptSalt(b));
  });

  test('the encoded cost matches the configured BCRYPT_COST', async () => {
    process.env.BCRYPT_COST = '11';
    const h = await hashPassword('some-password-99');
    expect(bcryptCostOf(h)).toBe(11);
    expect(bcryptCost()).toBe(11);
  });

  test('verify accepts the correct password', async () => {
    const h = await hashPassword('hunter2hunter2');
    expect(await verifyPassword(h, 'hunter2hunter2')).toBe(true);
  });

  test('verify rejects the wrong password', async () => {
    const h = await hashPassword('hunter2hunter2');
    expect(await verifyPassword(h, 'wrong-password-x')).toBe(false);
  });

  test('verify returns false (not throws) for a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything-at-all')).toBe(false);
  });

  test('a legacy Argon2id hash is recognized as legacy (not verifiable)', () => {
    const legacy = '$argon2id$v=19$m=65536,t=3,p=4$abc$def';
    expect(isLegacyHash(legacy)).toBe(true);
    expect(isBcryptHash(legacy)).toBe(false);
  });
});

describe('production pepper gating', () => {
  const origNodeEnv = process.env.NODE_ENV;
  const origPepper = process.env.PASSWORD_PEPPER;

  afterEach(() => {
    process.env.NODE_ENV = origNodeEnv;
    if (origPepper == null) delete process.env.PASSWORD_PEPPER; else process.env.PASSWORD_PEPPER = origPepper;
  });

  test('assertProductionAuthConfig throws in production without PASSWORD_PEPPER', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.PASSWORD_PEPPER;
    expect(() => assertProductionAuthConfig()).toThrow(/PASSWORD_PEPPER/);
  });

  test('assertProductionAuthConfig passes in production with PASSWORD_PEPPER', () => {
    process.env.NODE_ENV = 'production';
    process.env.PASSWORD_PEPPER = 'test-pepper-for-vitest';
    expect(() => assertProductionAuthConfig()).not.toThrow();
  });

  test('assertProductionAuthConfig passes in dev without PASSWORD_PEPPER', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.PASSWORD_PEPPER;
    expect(() => assertProductionAuthConfig()).not.toThrow();
  });

  test('BCRYPT_COST below 10 is rejected', () => {
    process.env.BCRYPT_COST = '9';
    expect(() => bcryptCost()).toThrow();
  });
});

describe('password validation + warnings', () => {
  test('password min/max enforced', () => {
    expect(validatePassword('short')!.ok ?? false).toBe(false);
    expect(validatePassword('a'.repeat(PASSWORD_MAX + 1))!.ok ?? false).toBe(false);
    expect(validatePassword('longenoughpw')!.ok ?? true).toBe(true);
    expect(validatePassword('8charpw!')!.ok ?? true).toBe(true);
    expect(validatePassword('12345678')!.ok ?? false).toBe(false);
  });

  test('common passwords are blocked even at valid length', () => {
    expect(isCommonPassword('password')).toBe(true);
    expect(isCommonPassword('12345678')).toBe(true);
    expect(isCommonPassword('aaaaaaaa')).toBe(true);
    expect(isCommonPassword('correct-horse-battery')).toBe(false);
  });

  test('passwordWarning warns for short/simple, null for strong', () => {
    expect(passwordWarning('abcdefgh')).toBeTruthy();
    expect(passwordWarning('Tr0ub4dor&3-extra-long')).toBeNull();
  });
});

describe('session tokens', () => {
  test('raw token is >=32 bytes (64 hex chars)', () => {
    const t = generateSessionToken();
    expect(t.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(t)).toBe(true);
  });

  test('two generated tokens differ', () => {
    expect(generateSessionToken()).not.toBe(generateSessionToken());
  });

  test('hashSessionToken is a sha256 hex digest, not the raw token', () => {
    const raw = generateSessionToken();
    const h = hashSessionToken(raw);
    expect(h).not.toBe(raw);
    expect(/^[0-9a-f]{64}$/.test(h)).toBe(true);
  });

  test('tokenHashMatches is true for the matching hash, false otherwise', () => {
    const raw = generateSessionToken();
    const h = hashSessionToken(raw);
    expect(tokenHashMatches(h, h)).toBe(true);
    expect(tokenHashMatches(h, hashSessionToken(generateSessionToken()))).toBe(false);
  });

  test('tokenHashMatches handles mismatched lengths without throwing', () => {
    expect(tokenHashMatches('short', 'a-much-longer-candidate')).toBe(false);
  });
});

describe('cookies', () => {
  const origEnv = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = origEnv; });

  test('production cookie name has the __Host- prefix', () => {
    process.env.NODE_ENV = 'production';
    expect(cookieName()).toBe(PROD_COOKIE_NAME);
    expect(PROD_COOKIE_NAME.startsWith('__Host-')).toBe(true);
  });

  test('dev cookie name has no __Host- prefix', () => {
    process.env.NODE_ENV = 'development';
    expect(cookieName()).toBe(DEV_COOKIE_NAME);
    expect(DEV_COOKIE_NAME.startsWith('__Host-')).toBe(false);
  });

  test('session cookie includes HttpOnly, SameSite=Lax, Path=/, Max-Age', () => {
    process.env.NODE_ENV = 'development';
    const c = sessionCookie('abc');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
    expect(c).toContain(`Max-Age=${SESSION_MAX_AGE}`);
    expect(c).not.toContain('Domain=');
  });

  test('production session cookie adds Secure (required by __Host-)', () => {
    process.env.NODE_ENV = 'production';
    const c = sessionCookie('abc');
    expect(c).toContain('Secure');
    expect(c).not.toContain('Domain=');
  });

  test('dev session cookie omits Secure', () => {
    process.env.NODE_ENV = 'development';
    expect(sessionCookie('abc')).not.toContain('Secure');
  });

  test('expired cookie has Max-Age=0 and an Expires in the past', () => {
    process.env.NODE_ENV = 'production';
    const c = expiredSessionCookie();
    expect(c).toContain('Max-Age=0');
    expect(c).toContain('1970');
  });

  test('parseCookies reads name=value pairs', () => {
    const c = parseCookies('a=1; b=2; dragonchess_session=tok');
    expect(c.a).toBe('1');
    expect(c.b).toBe('2');
    expect(c.dragonchess_session).toBe('tok');
  });

  test('parseCookies handles missing/empty header', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });

  test('readSessionCookie returns the raw token from either cookie name', () => {
    process.env.NODE_ENV = 'development';
    expect(readSessionCookie('dragonchess_session=rawtok')).toBe('rawtok');
    process.env.NODE_ENV = 'production';
    expect(readSessionCookie('__Host-dragonchess_session=rawtok')).toBe('rawtok');
  });

  test('readSessionCookie returns null when absent', () => {
    expect(readSessionCookie('other=1')).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
  });

  test('SESSION_MAX_AGE is 30 days in seconds', () => {
    expect(SESSION_MAX_AGE).toBe(30 * 24 * 60 * 60);
  });
});

describe('input validation', () => {
  test('username min/max enforced', () => {
    expect(validateUsername('ab')!.ok ?? false).toBe(false);
    expect(validateUsername('a'.repeat(USERNAME_MAX + 1))!.ok ?? false).toBe(false);
    expect(validateUsername('abc')!.ok ?? true).toBe(true);
    expect(validateUsername('User_Name-1')!.ok ?? true).toBe(true);
  });

  test('username charset rejects spaces and special chars', () => {
    expect(validateUsername('has space')!.ok ?? false).toBe(false);
    expect(validateUsername('user@name')!.ok ?? false).toBe(false);
  });

  test('username is trimmed', () => {
    const r = validateUsername('  alice  ') as any;
    expect(r.ok).toBe(true);
    expect(r.value).toBe('alice');
  });

  test('normalizeUsername lowercases and trims', () => {
    expect(normalizeUsername('  Alice  ')).toBe('alice');
    expect(normalizeUsername('BoB')).toBe('bob');
  });

  test('generic auth error does not reveal the username', () => {
    expect(GENERIC_AUTH_ERROR.toLowerCase()).not.toContain('exist');
    expect(GENERIC_AUTH_ERROR.toLowerCase()).not.toContain('found');
  });
});

describe('rate limiter', () => {
  test('allows up to max requests per window then blocks', () => {
    const rl = new RateLimiter(1000, 3);
    expect(rl.check('k')).toBe(true);
    expect(rl.check('k')).toBe(true);
    expect(rl.check('k')).toBe(true);
    expect(rl.check('k')).toBe(false);
  });

  test('separate keys have separate buckets', () => {
    const rl = new RateLimiter(1000, 2);
    expect(rl.check('a')).toBe(true);
    expect(rl.check('b')).toBe(true);
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(false);
    expect(rl.check('b')).toBe(true);
  });

  test('peek reports the current count', () => {
    const rl = new RateLimiter(1000, 5);
    rl.check('k'); rl.check('k');
    expect(rl.peek('k')).toBe(2);
  });

  test('clear resets', () => {
    const rl = new RateLimiter(1000, 1);
    rl.check('k');
    rl.clear();
    expect(rl.peek('k')).toBe(0);
  });
});