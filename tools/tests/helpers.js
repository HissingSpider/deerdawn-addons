'use strict';
// Throwaway registry repos for the tools tests. Nothing here reads a real key.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REAL_REPO = path.resolve(__dirname, '..', '..');

let clock = Date.parse('2026-11-20T10:00:00Z');

function git(repo, args, extraEnv = {}) {
  const when = new Date(clock).toISOString();
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when,
      ...extraEnv,
    },
  }).toString('utf8');
}

function commit(repo, message) {
  clock += 60 * 60 * 1000;
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
  return new Date(clock).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function write(repo, rel, contents) {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    if (fs.statSync(src).isDirectory()) copyDir(src, path.join(to, name));
    else fs.copyFileSync(src, path.join(to, name));
  }
}

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey,
  };
}

/**
 * A new registry repo on branch main: the real reserved ids, empty revoked and
 * tiers, a throwaway public key, and (unless empty) the real reading-list
 * add-on owned by `owner`. Returns { repo, keys }.
 */
function makeRegistry({ owner = 'alice', withReadingList = true, official = ['reading-list'] } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
  git(repo, ['init', '-q', '-b', 'main']);
  const keys = keyPair();
  fs.copyFileSync(path.join(REAL_REPO, 'reserved-ids.json'), path.join(repo, 'reserved-ids.json'));
  write(repo, 'revoked.json', '{\n  "format": 1,\n  "revoked": []\n}\n');
  write(repo, 'tiers.json', `${JSON.stringify({ format: 1, official }, null, 2)}\n`);
  write(repo, 'keys/registry-2026.pub.pem', keys.publicPem);
  write(repo, 'addons/.gitkeep', '');
  if (withReadingList) {
    copyDir(path.join(REAL_REPO, 'addons', 'reading-list'), path.join(repo, 'addons', 'reading-list'));
    write(repo, 'addons/reading-list/OWNER', `${owner}\n`);
  }
  commit(repo, 'base');
  return { repo, keys };
}

/** The real reading-list 1.0.0 files, as { rel: text }, for building variants. */
function readingListFiles() {
  const dir = path.join(REAL_REPO, 'addons', 'reading-list', '1.0.0');
  const out = {};
  const walk = (abs, rel) => {
    for (const name of fs.readdirSync(abs)) {
      const p = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(p).isDirectory()) walk(p, r);
      else out[r] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

/** Write a version folder: reading-list's files with manifest/schema edits. */
function writeVersion(repo, id, version, { manifest = {}, schema = null, files = {} } = {}) {
  const base = readingListFiles();
  const m = { ...JSON.parse(base['addon.json']), id, version, ...manifest };
  base['addon.json'] = `${JSON.stringify(m, null, 2)}\n`;
  base['SKILL.md'] = base['SKILL.md'].split('"reading-list"').join(`"${id}"`);
  if (schema) base['schemas/item.json'] = `${JSON.stringify(schema(JSON.parse(base['schemas/item.json'])), null, 2)}\n`;
  for (const [rel, text] of Object.entries({ ...base, ...files })) {
    if (text === undefined) continue;
    write(repo, `addons/${id}/${version}/${rel}`, text);
  }
}

module.exports = { git, commit, write, makeRegistry, writeVersion, keyPair, readingListFiles, REAL_REPO };
