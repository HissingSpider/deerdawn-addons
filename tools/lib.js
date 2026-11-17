'use strict';

// Shared helpers for check.js and build.js. MIT.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ID = /^[a-z][a-z0-9-]{1,39}$/;
// Registry versions: semver without build metadata (it does not order versions).
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function git(repo, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (allowFail) return null;
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** A registry file (reserved-ids.json, tiers.json, revoked.json) from the working tree. */
function registryFile(repo, name, fallback) {
  return readJsonFile(path.join(repo, name), fallback);
}

/** The same file as it was at a git ref, or `fallback` when it did not exist there. */
function registryFileAt(repo, ref, name, fallback) {
  const out = git(repo, ['show', `${ref}:${name}`], { allowFail: true });
  return out ? JSON.parse(out.toString('utf8')) : fallback;
}

function reservedIdsOf(json) {
  return Array.isArray(json && json.ids) ? json.ids : [];
}

function officialIdsOf(json) {
  return Array.isArray(json && json.official) ? json.official : [];
}

function revokedOf(json) {
  return Array.isArray(json && json.revoked) ? json.revoked : [];
}

/** Is <id>@<version> revoked? `versions` is "*", one version, or a list. */
function isRevoked(revoked, id, version) {
  return revoked.some((r) => r && r.id === id && (
    r.versions === '*' || r.versions === version || (Array.isArray(r.versions) && r.versions.includes(version))
  ));
}

/** Every add-on id in the working tree, and its version directories. */
function listWorkingTree(repo) {
  const root = path.join(repo, 'addons');
  const out = {};
  if (!fs.existsSync(root)) return out;
  for (const id of fs.readdirSync(root).sort()) {
    const dir = path.join(root, id);
    if (id.startsWith('.') || !fs.lstatSync(dir).isDirectory()) continue;
    out[id] = fs.readdirSync(dir).filter((v) => {
      const st = fs.lstatSync(path.join(dir, v));
      return st.isDirectory() && !v.startsWith('.');
    }).sort();
  }
  return out;
}

/** The same listing at a git ref: { id: [version, ...] }, plus every path under addons/. */
function listAtRef(repo, ref) {
  const out = git(repo, ['ls-tree', '-r', '--name-only', ref, '--', 'addons'], { allowFail: true });
  const paths = out ? out.toString('utf8').split('\n').filter(Boolean) : [];
  const versions = {};
  for (const p of paths) {
    const parts = p.split('/');
    if (parts.length < 3) continue;
    const [, id, second] = parts;
    versions[id] = versions[id] || new Set();
    if (parts.length >= 4) versions[id].add(second);
  }
  const listing = {};
  for (const [id, set] of Object.entries(versions)) listing[id] = [...set].sort();
  return { listing, paths };
}

/** The files of addons/<id>/<version>/ at a git ref, as { relative path: Buffer }. */
function versionFilesAt(repo, ref, id, version, paths) {
  const prefix = `addons/${id}/${version}/`;
  const files = {};
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    files[p.slice(prefix.length)] = git(repo, ['show', `${ref}:${p}`]);
  }
  return files;
}

/** An ISO time without milliseconds, in UTC. */
function isoSeconds(date) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

module.exports = {
  ID,
  VERSION,
  git,
  readJsonFile,
  registryFile,
  registryFileAt,
  reservedIdsOf,
  officialIdsOf,
  revokedOf,
  isRevoked,
  listWorkingTree,
  listAtRef,
  versionFilesAt,
  isoSeconds,
};
