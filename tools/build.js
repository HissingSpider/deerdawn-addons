#!/usr/bin/env node
'use strict';

// BUILD THE PUBLISHED REGISTRY: TARBALLS, index.json AND ITS SIGNATURE. MIT.
//
//   REGISTRY_SIGNING_KEY="$(cat key.pem)" node tools/build.js [--repo <dir>] [--out <dir>]
//   node tools/build.js --unsigned        (a local preview; never published)
//
// 1. Runs the --all checks of check.js and stops on any error.
// 2. Packs every addons/<id>/<version>/ into dist/<id>-<version>.tgz with the
//    add-on kit's deterministic writer (the format a DeerDawn server reads).
// 3. Writes index.json, the contract the DeerDawn API reads:
//      { format: 1, generated_at, key_id, addons: { <id>: { name, author,
//        license, homepage, kind, tier, latest, description, versions: {
//        <x.y.z>: { url, sha256, bytes, requires_platform, published_at } } } },
//        revoked: [...revoked.json] }
//    tier comes from tiers.json (maintained here), never from the author.
//    Revoked versions are left out of `versions` (and an add-on with none left
//    is left out of `addons`); `revoked` still names them, for servers that
//    installed one.
// 4. Signs the exact bytes of index.json with Ed25519 (REGISTRY_SIGNING_KEY,
//    a PKCS8 PEM), checks the signature against keys/<key_id>.pub.pem, and
//    writes index.json.sig (base64 and a newline).
//
// Output: <out>/index.json, index.json.sig, dist/, keys/, .nojekyll.
//
// Every byte is a function of the git checkout, so two builds of one commit
// are identical: generated_at is the HEAD commit's time and each version's
// published_at is the time of the commit that added it, not the build's.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readPackageDir, packFiles, sha256Hex } = require('./addon-kit/src/archive');
const { compareVersions, parseVersion } = require('./addon-kit/src/widening');
const { checkAll } = require('./check');
const lib = require('./lib');

const DEFAULT_KEY_ID = 'registry-2026';
const DEFAULT_PLATFORM = 2;

function parseArgs(argv) {
  const opts = { repo: path.resolve(__dirname, '..'), out: null, unsigned: false, keyId: process.env.REGISTRY_KEY_ID || DEFAULT_KEY_ID };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo') { opts.repo = path.resolve(argv[i + 1]); i += 1; }
    else if (a === '--out') { opts.out = path.resolve(argv[i + 1]); i += 1; }
    else if (a === '--unsigned') opts.unsigned = true;
    else if (a === '--key-id') { opts.keyId = argv[i + 1]; i += 1; }
    else throw new Error(`unknown argument "${a}"`);
  }
  if (!opts.out) opts.out = path.join(opts.repo, '_site');
  return opts;
}

/** The commit time of HEAD, or of the first commit that added `pathspec`; null outside git. */
function commitTime(repo, pathspec) {
  const args = pathspec
    ? ['log', '--diff-filter=A', '--format=%cI', '--', pathspec]
    : ['log', '-1', '--format=%cI'];
  const out = lib.git(repo, args, { allowFail: true });
  if (!out) return null;
  const lines = out.toString('utf8').split('\n').filter(Boolean);
  return lines.length ? lib.isoSeconds(lines[lines.length - 1]) : null;
}

function loadSigningKey(pem) {
  if (!pem || !pem.trim()) throw new Error('REGISTRY_SIGNING_KEY is not set: the index cannot be signed (use --unsigned for a local preview)');
  const text = pem.includes('\n') ? pem : pem.replace(/\\n/g, '\n');
  let key;
  try {
    key = crypto.createPrivateKey({ key: text, format: 'pem' });
  } catch (err) {
    throw new Error(`REGISTRY_SIGNING_KEY is not a readable PEM private key: ${err.message}`);
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`REGISTRY_SIGNING_KEY is a ${key.asymmetricKeyType} key; the registry signs with Ed25519`);
  return key;
}

/** Highest stable version, or the highest of all when every one is a pre-release. */
function latestOf(versions) {
  const sorted = [...versions].sort(compareVersions);
  const stable = sorted.filter((v) => !parseVersion(v).pre.length);
  const pool = stable.length ? stable : sorted;
  return pool[pool.length - 1];
}

/**
 * Build the registry into `out`. Returns { index, indexBytes, signature }.
 * Throws on any problem; writes nothing until everything has passed.
 */
function build({ repo, out, unsigned = false, keyId = DEFAULT_KEY_ID, signingKeyPem = process.env.REGISTRY_SIGNING_KEY } = {}) {
  const report = checkAll(repo);
  if (report.errors.length) {
    const lines = report.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
    throw new Error(`the registry does not pass its checks:\n${lines}`);
  }

  const official = new Set(lib.officialIdsOf(lib.registryFile(repo, 'tiers.json', { official: [] })));
  const revoked = lib.revokedOf(lib.registryFile(repo, 'revoked.json', { revoked: [] }));
  const generatedAt = commitTime(repo, null) || lib.isoSeconds(Date.now());

  const tarballs = {};
  const addons = {};
  for (const [id, versions] of Object.entries(lib.listWorkingTree(repo))) {
    const live = versions.filter((v) => !lib.isRevoked(revoked, id, v)).sort(compareVersions);
    if (!live.length) continue;
    const entries = {};
    const manifests = {};
    for (const v of live) {
      const rel = `addons/${id}/${v}`;
      const { files, errors } = readPackageDir(path.join(repo, rel));
      if (errors.length) throw new Error(`${rel}: ${errors.map((e) => e.message).join('; ')}`);
      const buffer = packFiles(files);
      const name = `${id}-${v}.tgz`;
      tarballs[name] = buffer;
      manifests[v] = JSON.parse(files['addon.json'].toString('utf8'));
      entries[v] = {
        url: `dist/${name}`,
        sha256: sha256Hex(buffer),
        bytes: buffer.length,
        requires_platform: Number.isInteger(manifests[v].platform) ? manifests[v].platform : DEFAULT_PLATFORM,
        published_at: commitTime(repo, `${rel}/addon.json`) || generatedAt,
      };
    }
    const latest = latestOf(live);
    const m = manifests[latest];
    addons[id] = {
      name: m.name,
      author: m.author,
      license: m.license,
      homepage: m.homepage,
      kind: 'declarative',
      tier: official.has(id) ? 'official' : 'reviewed',
      latest,
      description: typeof m.description === 'string' ? m.description : '',
      versions: entries,
    };
  }

  const index = { format: 1, generated_at: generatedAt, key_id: keyId, addons, revoked };
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, 'utf8');

  let signature = null;
  if (!unsigned) {
    const privateKey = loadSigningKey(signingKeyPem);
    const pubFile = path.join(repo, 'keys', `${keyId}.pub.pem`);
    if (!fs.existsSync(pubFile)) throw new Error(`keys/${keyId}.pub.pem is missing: servers could not check this signature`);
    const publicKey = crypto.createPublicKey(fs.readFileSync(pubFile, 'utf8'));
    const sig = crypto.sign(null, indexBytes, privateKey);
    if (!crypto.verify(null, indexBytes, publicKey, sig)) {
      throw new Error(`REGISTRY_SIGNING_KEY does not match keys/${keyId}.pub.pem: refusing to publish an index servers would reject`);
    }
    signature = `${sig.toString('base64')}\n`;
  }

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(out, 'keys'), { recursive: true });
  for (const [name, buffer] of Object.entries(tarballs)) fs.writeFileSync(path.join(out, 'dist', name), buffer);
  for (const name of fs.readdirSync(path.join(repo, 'keys')).filter((n) => n.endsWith('.pem')).sort()) {
    fs.copyFileSync(path.join(repo, 'keys', name), path.join(out, 'keys', name));
  }
  fs.writeFileSync(path.join(out, 'index.json'), indexBytes);
  if (signature) fs.writeFileSync(path.join(out, 'index.json.sig'), signature);
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  return { index, indexBytes, signature };
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  try {
    const { index, signature } = build({ repo: opts.repo, out: opts.out, unsigned: opts.unsigned, keyId: opts.keyId });
    for (const [id, a] of Object.entries(index.addons)) {
      for (const [v, e] of Object.entries(a.versions)) process.stdout.write(`packed  ${id}@${v}  ${e.sha256}  ${e.bytes} bytes\n`);
    }
    process.stdout.write(`wrote   ${opts.out} (${Object.keys(index.addons).length} add-on(s), ${signature ? `signed with ${opts.keyId}` : 'UNSIGNED preview'})\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`build failed: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { build, main, latestOf, loadSigningKey };
