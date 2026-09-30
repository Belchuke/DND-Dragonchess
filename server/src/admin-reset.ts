#!/usr/bin/env node
import { openDb } from './db.js';
import { Repo } from './repo.js';
import {
  assertProductionAuthConfig, hashPassword, normalizeUsername,
  validatePassword, validateUsername, passwordWarning,
} from './auth.js';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length !== 2) {
    console.error('Usage: npm run admin:reset -- <username> <newPassword>');
    console.error('Note: set PASSWORD_PEPPER in the environment first.');
    return 2;
  }
  const [rawName, rawPass] = argv;

  const u = validateUsername(rawName);
  if (!u.ok) { console.error(`Username: ${u.message}`); return 1; }
  const p = validatePassword(rawPass);
  if (!p.ok) { console.error(`Password: ${p.message}`); return 1; }

  assertProductionAuthConfig();

  const normalized = normalizeUsername(rawName);

  const repo = new Repo(openDb());
  if (!repo.usernameExists(normalized)) {
    console.error(`No such user: ${rawName}`);
    return 1;
  }

  const hash = await hashPassword(rawPass);
  const ok = repo.resetPassword(normalized, hash);
  if (!ok) { console.error('Reset failed: no rows updated.'); return 1; }

  const warning = passwordWarning(rawPass);
  console.log(`Password reset for "${rawName}".`);
  if (warning) console.warn(`Warning: ${warning}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});