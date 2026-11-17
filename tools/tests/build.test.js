'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { build, latestOf } = require('../build');
const { commit, write, makeRegistry, writeVersion, keyPair, REAL_REPO } = require('./helpers');

function outDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'registry-site-'));
}

function treeOf(dir) {
  const out = {};
  const walk = (abs, rel) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const p = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(p).isDirectory()) walk(p, r);
      else out[r] = fs.readFileSync(p);
    }
  };
  walk(dir, '');
  return out;
}

test('build writes a signed index in the API contract format', () => {
  const { repo, keys } = makeRegistry();
  const out = outDir();
  build({ repo, out, signingKeyPem: keys.privatePem });

  const indexBytes = fs.readFileSync(path.join(out, 'index.json'));
  const sig = fs.readFileSync(path.join(out, 'index.json.sig'), 'utf8');
  assert.match(sig, /^[A-Za-z0-9+/]+=*\n$/);
  assert.ok(crypto.verify(null, indexBytes, keys.publicKey, Buffer.from(sig.trim(), 'base64')), 'signature verifies');
  assert.ok(indexBytes.toString('utf8').endsWith('}\n'));

  const index = JSON.parse(indexBytes);
  assert.deepStrictEqual(Object.keys(index), ['format', 'generated_at', 'key_id', 'addons', 'revoked']);
  assert.strictEqual(index.format, 1);
  assert.strictEqual(index.key_id, 'registry-2026');
  assert.match(index.generated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const entry = index.addons['reading-list'];
  assert.deepStrictEqual(Object.keys(entry), ['name', 'author', 'license', 'homepage', 'kind', 'tier', 'latest', 'description', 'versions']);
  assert.strictEqual(entry.tier, 'official');
  assert.strictEqual(entry.kind, 'declarative');
  assert.strictEqual(entry.latest, '1.0.0');
  assert.strictEqual(entry.author, 'DeerDawn');
  const v = entry.versions['1.0.0'];
  assert.deepStrictEqual(Object.keys(v), ['url', 'sha256', 'bytes', 'requires_platform', 'published_at']);
  assert.strictEqual(v.url, 'dist/reading-list-1.0.0.tgz');
  assert.strictEqual(v.requires_platform, 2);
  const tgz = fs.readFileSync(path.join(out, v.url));
  assert.strictEqual(v.sha256, crypto.createHash('sha256').update(tgz).digest('hex'));
  assert.strictEqual(v.bytes, tgz.length);
  assert.strictEqual(tgz[9], 3, 'gzip OS byte is Unix on every platform');
  // Files at the archive root.
  const tar = zlib.gunzipSync(tgz);
  assert.strictEqual(tar.subarray(0, 100).toString('utf8').replace(/\0+$/, ''), 'SKILL.md');
  assert.ok(fs.existsSync(path.join(out, 'keys', 'registry-2026.pub.pem')));
  assert.ok(fs.existsSync(path.join(out, '.nojekyll')));
  assert.deepStrictEqual(index.revoked, []);
});

test('two builds of one commit are byte-identical, and published_at stays put', () => {
  const { repo, keys } = makeRegistry();
  const a = outDir();
  const b = outDir();
  build({ repo, out: a, signingKeyPem: keys.privatePem });
  build({ repo, out: b, signingKeyPem: keys.privatePem });
  const ta = treeOf(a);
  const tb = treeOf(b);
  assert.deepStrictEqual(Object.keys(ta), Object.keys(tb));
  for (const name of Object.keys(ta)) assert.ok(ta[name].equals(tb[name]), `${name} differs between builds`);

  // A later commit moves generated_at but not the first version's published_at or bytes.
  const first = JSON.parse(ta['index.json']);
  writeVersion(repo, 'reading-list', '1.1.0', { schema: (s) => ({ ...s, properties: { ...s.properties, isbn: { type: 'string', maxLength: 20 } } }) });
  const added = commit(repo, 'reading-list 1.1.0');
  const c = outDir();
  build({ repo, out: c, signingKeyPem: keys.privatePem });
  const next = JSON.parse(fs.readFileSync(path.join(c, 'index.json')));
  assert.notStrictEqual(next.generated_at, first.generated_at);
  assert.strictEqual(next.generated_at, added);
  assert.deepStrictEqual(next.addons['reading-list'].versions['1.0.0'], first.addons['reading-list'].versions['1.0.0']);
  assert.strictEqual(next.addons['reading-list'].versions['1.1.0'].published_at, added);
  assert.strictEqual(next.addons['reading-list'].latest, '1.1.0');
});

test('tier comes from tiers.json, never from the author', () => {
  const { repo, keys } = makeRegistry({ official: [] });
  const out = outDir();
  build({ repo, out, signingKeyPem: keys.privatePem });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(out, 'index.json'))).addons['reading-list'].tier, 'reviewed');
});

test('revoked versions are left out of versions and named in revoked', () => {
  const { repo, keys } = makeRegistry();
  writeVersion(repo, 'reading-list', '1.1.0');
  const revoked = { format: 1, revoked: [{ id: 'reading-list', versions: ['1.1.0'], reason: 'Test revocation.' }] };
  write(repo, 'revoked.json', `${JSON.stringify(revoked, null, 2)}\n`);
  commit(repo, 'revoke');
  const out = outDir();
  build({ repo, out, signingKeyPem: keys.privatePem });
  const index = JSON.parse(fs.readFileSync(path.join(out, 'index.json')));
  assert.deepStrictEqual(Object.keys(index.addons['reading-list'].versions), ['1.0.0']);
  assert.strictEqual(index.addons['reading-list'].latest, '1.0.0');
  assert.deepStrictEqual(index.revoked, revoked.revoked);
  assert.ok(!fs.existsSync(path.join(out, 'dist', 'reading-list-1.1.0.tgz')));
});

test('a wrong, missing or non-Ed25519 key fails the build and writes nothing', () => {
  const { repo } = makeRegistry();
  const other = keyPair();
  const out = path.join(outDir(), 'site');
  assert.throws(() => build({ repo, out, signingKeyPem: other.privatePem }), /does not match keys\/registry-2026\.pub\.pem/);
  assert.throws(() => build({ repo, out, signingKeyPem: '' }), /REGISTRY_SIGNING_KEY is not set/);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => build({ repo, out, signingKeyPem: rsa }), /is a rsa key/);
  assert.ok(!fs.existsSync(out));
});

test('a PEM pasted with literal \\n sequences still works', () => {
  const { repo, keys } = makeRegistry();
  const out = outDir();
  build({ repo, out, signingKeyPem: keys.privatePem.trim().split('\n').join('\\n') });
  assert.ok(fs.existsSync(path.join(out, 'index.json.sig')));
});

test('the build refuses a registry that fails its checks', () => {
  const { repo, keys } = makeRegistry();
  writeVersion(repo, 'reading-list', '1.1.0', { manifest: { kind: 'server' } });
  commit(repo, 'bad');
  assert.throws(() => build({ repo, out: outDir(), signingKeyPem: keys.privatePem }), /the registry does not pass its checks/);
});

test('an empty registry builds an empty, signed index', () => {
  const { repo, keys } = makeRegistry({ withReadingList: false });
  const out = outDir();
  const { index } = build({ repo, out, signingKeyPem: keys.privatePem });
  assert.deepStrictEqual(index.addons, {});
  assert.ok(fs.existsSync(path.join(out, 'index.json.sig')));
});

// A published version's sha256 is in every index since, and servers key
// installed packages by it, so its bytes must never move. They come from Node's
// zlib, which could in principle change between Node versions: this pins the
// first listing's hash (the same on Node 20, 22 and 24, macOS and Linux).
test('published bytes never move: reading-list 1.0.0 packs to its published sha256', () => {
  const { readPackageDir, packFiles, sha256Hex } = require('../addon-kit/src/archive');
  const { files, errors } = readPackageDir(path.join(REAL_REPO, 'addons', 'reading-list', '1.0.0'));
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(sha256Hex(packFiles(files)), 'ee0c1c8933e62386c7757244d6b1fee657ab5aed29e3fd6df1bb9304ff77d0c3');
});

test('latestOf prefers the highest stable version', () => {
  assert.strictEqual(latestOf(['1.0.0', '1.1.0-beta.1', '1.0.1']), '1.0.1');
  assert.strictEqual(latestOf(['1.0.0-rc.1', '1.0.0-rc.2']), '1.0.0-rc.2');
  assert.strictEqual(latestOf(['2.0.0', '10.0.0']), '10.0.0');
});
