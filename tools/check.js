#!/usr/bin/env node
'use strict';

// CHECK A PULL REQUEST AGAINST THE REGISTRY'S RULES. MIT.
//
//   node tools/check.js [--base <ref>] [--author <github login>] [--repo <dir>]
//   node tools/check.js --all [--repo <dir>]
//
// Default (pull request) mode compares the working tree with --base (default
// origin/main) and checks every add-on the change touches:
//
//   - each new addons/<id>/<version>/ passes the add-on kit in registry mode
//     (manifest, declarative only, .json/.md only, no symlinks, size caps,
//     secure schemas with no pattern, SKILL.md and brief_line lint, an OSI
//     licence, author, homepage, platform), and its manifest id and version
//     match the folder names;
//   - the id is not reserved (reserved-ids.json as it is on the BASE branch,
//     so a pull request cannot unreserve an id and take it in one go);
//   - the first listing of an id claims it: addons/<id>/OWNER holds the
//     author's GitHub login, and from then on only that login may add
//     versions. OWNER never changes in a pull request;
//   - a version folder that exists on the base branch is never edited or
//     deleted: a fix is a new version;
//   - a new version is greater than every published one, and a minor or patch
//     version only widens the previous version's schemas;
//   - addons/<id>/LISTING.md is present and passes its lint.
//
// --all checks the whole tree the same way, without git history (no
// ownership or immutability). The build runs it before it packs anything.
//
// Without --author (or PR_AUTHOR in the environment) the ownership rule is
// reported as not checked. Exit 1 on any error.

const fs = require('fs');
const path = require('path');
const { validatePackage, lintListing } = require('./addon-kit/src/validate');
const { compareVersions, bumpKind, schemaWidening } = require('./addon-kit/src/widening');
const lib = require('./lib');

function parseArgs(argv) {
  const opts = { all: false, base: null, author: process.env.PR_AUTHOR || null, repo: path.resolve(__dirname, '..'), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--base') { opts.base = argv[i + 1]; i += 1; }
    else if (a === '--author') { opts.author = argv[i + 1] || null; i += 1; }
    else if (a === '--repo') { opts.repo = path.resolve(argv[i + 1]); i += 1; }
    else throw new Error(`unknown argument "${a}"`);
  }
  return opts;
}

function sameLogin(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function createReport() {
  const errors = [];
  const notices = [];
  return {
    errors,
    notices,
    error: (p, message) => errors.push({ path: p, message }),
    notice: (p, message) => notices.push({ path: p, message }),
  };
}

/** Validate one version folder in registry mode, plus the folder-name rules. Returns its files or null. */
function checkVersionDir(repo, id, version, reservedIds, report) {
  const rel = `addons/${id}/${version}`;
  if (!lib.VERSION.test(version)) {
    report.error(rel, `"${version}" is not a version folder name: use a semantic version such as 1.0.0 (no "+build" part)`);
    return null;
  }
  const result = validatePackage(path.join(repo, rel), { registry: true, reservedIds });
  for (const e of result.errors) report.error(`${rel}/${e.path === '.' ? '' : e.path}`.replace(/\/$/, ''), `${e.message} [${e.code}]`);
  for (const w of result.warnings) report.notice(`${rel}/${w.path}`, `${w.message} [${w.code}]`);
  if (result.manifest) {
    if (result.manifest.id !== id) report.error(`${rel}/addon.json`, `"id" is "${result.manifest.id}" but the folder is addons/${id}`);
    if (result.manifest.version !== version) report.error(`${rel}/addon.json`, `"version" is "${result.manifest.version}" but the folder is ${version}`);
  }
  return result.ok ? result.files : null;
}

function checkListing(repo, id, report) {
  const file = path.join(repo, 'addons', id, 'LISTING.md');
  const rel = `addons/${id}/LISTING.md`;
  if (!fs.existsSync(file)) { report.error(rel, 'every add-on needs a LISTING.md: the long description on its listing page'); return; }
  for (const f of lintListing(fs.readFileSync(file, 'utf8'))) report.error(rel, `${f.message} [${f.code}]`);
}

/**
 * Check a sequence of versions in order: each is greater than the one before,
 * and a minor or patch step only widens it.
 * @param {{version: string, files: object|null, rel: string}[]} chain  sorted ascending
 */
function checkChain(chain, report) {
  for (let i = 1; i < chain.length; i += 1) {
    const prev = chain[i - 1];
    const next = chain[i];
    if (!prev.files || !next.files || !next.isNew) continue;
    const bump = bumpKind(prev.version, next.version);
    if (bump === 'major') continue;
    const widening = schemaWidening(prev.files, next.files);
    for (const p of widening.problems) {
      report.error(next.rel, `${next.version} is a ${bump} version after ${prev.version}, but ${p.collection ? `collection "${p.collection}" ` : ''}${p.path}: ${p.message}. Make it a major version, or keep the old schema accepting every record it accepted.`);
    }
  }
}

function sortVersions(versions) {
  return [...versions].sort(compareVersions);
}

/** --all: the whole working tree, no history. */
function checkAll(repo) {
  const report = createReport();
  const reservedIds = lib.reservedIdsOf(lib.registryFile(repo, 'reserved-ids.json', { ids: [] }));
  const listing = lib.listWorkingTree(repo);
  for (const [id, versions] of Object.entries(listing)) {
    const base = `addons/${id}`;
    if (!lib.ID.test(id)) { report.error(base, 'ids are 2-40 characters: lowercase letters, digits and hyphens, starting with a letter'); continue; }
    if (reservedIds.includes(id)) report.error(base, `the id "${id}" is reserved`);
    if (!fs.existsSync(path.join(repo, base, 'OWNER'))) report.error(`${base}/OWNER`, 'missing: it records who owns the id');
    checkListing(repo, id, report);
    for (const name of fs.readdirSync(path.join(repo, base))) {
      if (!versions.includes(name) && !['LISTING.md', 'OWNER'].includes(name)) report.error(`${base}/${name}`, 'not expected here: an add-on folder holds version folders, LISTING.md and OWNER');
    }
    if (!versions.length) report.error(base, 'no version folders');
    const valid = versions.filter((v) => lib.VERSION.test(v));
    const chain = [];
    for (const v of versions) {
      const files = checkVersionDir(repo, id, v, reservedIds, report);
      if (lib.VERSION.test(v)) chain.push({ version: v, files, rel: `${base}/${v}`, isNew: true });
    }
    if (valid.length) checkChain(sortVersions(valid).map((v) => chain.find((c) => c.version === v)), report);
  }
  return report;
}

/** Pull request mode: what changed between `base` and the working tree. */
function checkDiff(repo, { base, author }) {
  const report = createReport();
  if (!lib.git(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { allowFail: true })) {
    report.error('.', `cannot find the base "${base}"; fetch it, or pass --base <ref>`);
    return report;
  }

  // Changed paths: tracked differences from base, plus new untracked files.
  const changes = [];
  const diff = lib.git(repo, ['diff', '--name-status', '--no-renames', base, '--']).toString('utf8');
  for (const line of diff.split('\n').filter(Boolean)) {
    const [status, ...rest] = line.split('\t');
    changes.push({ status: status[0], path: rest.join('\t') });
  }
  const untracked = lib.git(repo, ['ls-files', '--others', '--exclude-standard']).toString('utf8');
  for (const p of untracked.split('\n').filter(Boolean)) changes.push({ status: 'A', path: p });

  // Registry rules come from the base branch, and are only ever added to here.
  const reservedIds = [...new Set([
    ...lib.reservedIdsOf(lib.registryFileAt(repo, base, 'reserved-ids.json', { ids: [] })),
    ...lib.reservedIdsOf(lib.registryFile(repo, 'reserved-ids.json', { ids: [] })),
  ])];
  const revoked = lib.revokedOf(lib.registryFileAt(repo, base, 'revoked.json', { revoked: [] }));
  const { listing: baseListing, paths: basePaths } = lib.listAtRef(repo, base);

  const touched = new Map(); // id -> { versions: Set, owner: bool, listing: bool }
  const other = [];
  for (const c of changes) {
    const parts = c.path.split('/');
    if (parts[0] !== 'addons') { other.push(c.path); continue; }
    if (parts.length === 2) {
      if (parts[1] !== '.gitkeep') report.error(c.path, 'not expected here: addons/ holds one folder per add-on id');
      continue;
    }
    const id = parts[1];
    const t = touched.get(id) || { versions: new Set(), files: [] };
    touched.set(id, t);
    t.files.push(c);
    if (parts.length >= 4) t.versions.add(parts[2]);
  }
  if (other.length) {
    report.notice('.', `changes registry files a maintainer must review: ${other.join(', ')}`);
  }

  for (const [id, t] of touched) {
    const base_ = `addons/${id}`;
    if (!lib.ID.test(id)) { report.error(base_, 'ids are 2-40 characters: lowercase letters, digits and hyphens, starting with a letter'); continue; }
    const baseVersions = baseListing[id] || [];
    const baseOwnerRaw = lib.git(repo, ['show', `${base}:${base_}/OWNER`], { allowFail: true });
    const baseOwner = baseOwnerRaw ? baseOwnerRaw.toString('utf8').trim() : null;
    const ownerFile = path.join(repo, base_, 'OWNER');
    const owner = fs.existsSync(ownerFile) ? fs.readFileSync(ownerFile, 'utf8').trim() : null;

    // Files directly under addons/<id>/.
    for (const c of t.files) {
      const parts = c.path.split('/');
      if (parts.length !== 3) continue;
      if (!['LISTING.md', 'OWNER'].includes(parts[2])) report.error(c.path, 'not expected here: an add-on folder holds version folders, LISTING.md and OWNER');
      if (parts[2] === 'OWNER' && baseOwner !== null) report.error(c.path, 'OWNER never changes in a pull request; ask a maintainer to transfer an id');
      if (parts[2] === 'LISTING.md' && c.status === 'D') report.error(c.path, 'LISTING.md cannot be removed');
    }

    // Existing versions are immutable.
    const newVersions = [];
    for (const v of [...t.versions].sort()) {
      if (baseVersions.includes(v)) {
        const edits = t.files.filter((c) => c.path.startsWith(`${base_}/${v}/`)).map((c) => `${c.status} ${c.path.slice(base_.length + v.length + 2)}`);
        report.error(`${base_}/${v}`, `version ${v} is already published and can never be edited or deleted (${edits.join(', ')}); publish a new version instead`);
      } else if (fs.existsSync(path.join(repo, base_, v))) {
        newVersions.push(v);
      }
    }
    if (!newVersions.length) {
      if (t.files.some((c) => c.path.endsWith('/LISTING.md'))) {
        checkListing(repo, id, report);
        if (baseOwner && author && !sameLogin(author, baseOwner)) report.error(`${base_}/LISTING.md`, `only the owner (${baseOwner}) may change this listing`);
      }
      continue;
    }

    // Ownership.
    if (reservedIds.includes(id)) report.error(base_, `the id "${id}" is reserved`);
    if (revoked.some((r) => r && r.id === id && r.versions === '*')) report.error(base_, `"${id}" was revoked from the registry; ids are never reused`);
    if (baseOwner === null) {
      if (!owner) report.error(`${base_}/OWNER`, `the first listing claims the id: add addons/${id}/OWNER holding your GitHub login`);
      else if (author && !sameLogin(owner, author)) report.error(`${base_}/OWNER`, `OWNER says "${owner}" but this pull request is by "${author}"`);
      else if (!author) report.notice(`${base_}/OWNER`, `claims the id for "${owner}" (author not given, so not compared)`);
    } else if (author && !sameLogin(author, baseOwner)) {
      report.error(base_, `"${id}" is owned by ${baseOwner}; only they can publish new versions`);
    } else if (!author) {
      report.notice(base_, `owned by ${baseOwner} (author not given, so ownership was not checked)`);
    }
    checkListing(repo, id, report);

    // Each new version: valid, and later than everything published.
    const publishedSorted = sortVersions(baseVersions.filter((v) => lib.VERSION.test(v)));
    const latest = publishedSorted[publishedSorted.length - 1] || null;
    const chain = publishedSorted.map((v) => ({ version: v, rel: `${base_}/${v}`, isNew: false, files: null }));
    for (const v of newVersions) {
      const files = checkVersionDir(repo, id, v, reservedIds, report);
      if (!lib.VERSION.test(v)) continue;
      if (latest && compareVersions(v, latest) <= 0) {
        report.error(`${base_}/${v}`, `${v} must be greater than the latest published version, ${latest}`);
        continue;
      }
      chain.push({ version: v, rel: `${base_}/${v}`, isNew: true, files });
    }
    chain.sort((a, b) => compareVersions(a.version, b.version));
    // Only the newest published version is compared against; load its files from the base.
    for (const link of chain) {
      if (!link.isNew && link.version === latest) link.files = lib.versionFilesAt(repo, base, id, latest, basePaths);
    }
    checkChain(chain.filter((c) => c.isNew || c.version === latest), report);
  }
  return report;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  let report;
  if (opts.all) {
    report = checkAll(opts.repo);
  } else {
    const base = opts.base || 'origin/main';
    report = checkDiff(opts.repo, { base, author: opts.author });
    if (!opts.author) report.notice('.', 'no --author (or PR_AUTHOR): id ownership was not checked against the pull request author');
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: !report.errors.length, errors: report.errors, notices: report.notices }, null, 2)}\n`);
  } else {
    for (const e of report.errors) process.stdout.write(`error   ${e.path}: ${e.message}\n`);
    for (const n of report.notices) process.stdout.write(`notice  ${n.path}: ${n.message}\n`);
    process.stdout.write(report.errors.length ? `failed  ${report.errors.length} error(s)\n` : 'ok      the registry checks pass\n');
  }
  return report.errors.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { checkAll, checkDiff, main };
