'use strict';

// VENDORED from DeerDawn packages/addon-kit 0.2.0 (MIT), source commit
// 16920c7891a928d0ad8562c2b015d0401899ca44. Do not edit here: change it in DeerDawn and copy it
// again. Goes away once @deerdawn/addon-kit is on npm (tools/README.md).

// PACKING AN ADD-ON DIRECTORY INTO THE TARBALL A DEERDAWN SERVER ACCEPTS.
//
// The writer below is the server's own (apps/api/src/addons/packageArchive.js,
// packTarball), copied here because this package must not import from the
// AGPL server. tests/pack.test.js packs the same files with both and compares
// the bytes, so the two cannot drift apart unnoticed.
//
// One deliberate difference: byte 9 of a gzip header names the operating
// system that wrote it, and Node writes 19 on macOS and 3 on Linux. Everything
// after the header is the same on both (checked on darwin-arm64, linux-arm64
// and linux-x64), so this writer always stamps 3. The same files then give the
// same sha256 on an author's Mac as in the registry's Linux CI, and on Linux
// the output is byte-identical to the server's.
//
// The format: a gzipped ustar archive, entries sorted by path, files only (no
// directory entries), mode 0644, owner 0, mtime 0, files at the archive root
// (addon.json, SKILL.md, schemas/x.json). The server also accepts one wrapping
// directory, but the registry never writes one.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const KB = 1024;
/** The server's caps (packageArchive.js LIMITS). A package over any of them is refused at install. */
const LIMITS = Object.freeze({
  maxCompressedBytes: 512 * KB,
  maxTarBytes: 2 * 1024 * KB,
  maxFiles: 64,
  maxFileBytes: 64 * KB,
  maxTotalBytes: 256 * KB,
});

const BLOCK = 512;
const GZIP_OS_UNIX = 3;
const ALLOWED_FILE = /^[A-Za-z0-9._-]+\.(json|md)$/;
const ALLOWED_DIR = /^[A-Za-z0-9_-]+$/;
const MAX_PATH_BYTES = 100; // the ustar name field; the writer uses no prefix field

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** A safe relative POSIX path, normalised (no "./", no trailing "/"), or null. Same rule as the server. */
function normalizeEntryPath(raw) {
  if (typeof raw !== 'string' || !raw || raw.includes('\0') || raw.includes('\\')) return null;
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) return null;
  return parts.join('/');
}

/** Files macOS leaves behind; never part of a package, and the server skips them too. */
function isPlatformJunk(name) {
  return name.startsWith('._') || name === '.DS_Store';
}

function writeOctal(header, value, start, length) {
  const text = value.toString(8).padStart(length - 1, '0');
  header.write(text, start, length - 1, 'ascii');
  header[start + length - 1] = 0;
}

/**
 * Write files as a deterministic gzipped ustar archive. Byte for byte the
 * server's packTarball, except gzip header byte 9 (see the top of this file).
 * @param {Object<string, string|Buffer|object>} files  objects are JSON-encoded
 * @param {{prefix?: string}} [options]
 * @returns {Buffer}
 */
function packFiles(files, { prefix = '' } = {}) {
  const blocks = [];
  for (const name of Object.keys(files).sort()) {
    const value = files[name];
    const data = Buffer.isBuffer(value) ? value
      : Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    const fullName = prefix ? `${prefix.replace(/\/+$/, '')}/${name}` : name;
    if (Buffer.byteLength(fullName) > MAX_PATH_BYTES) throw new Error(`path too long for this writer: ${fullName}`);
    const header = Buffer.alloc(BLOCK, 0);
    header.write(fullName, 0, 100, 'utf8');
    writeOctal(header, 0o644, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, data.length, 124, 12);
    writeOctal(header, 0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = 48; // '0'
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < BLOCK; i += 1) sum += header[i];
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(BLOCK * 2, 0));
  const tar = Buffer.concat(blocks);
  const gz = zlib.gzipSync(tar, { level: 9 });
  gz[9] = GZIP_OS_UNIX;
  return gz;
}

/** The size of the uncompressed tar packFiles would write, without writing it. */
function tarSize(files) {
  let total = BLOCK * 2;
  for (const value of Object.values(files)) {
    const len = Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value));
    total += BLOCK + Math.ceil(len / BLOCK) * BLOCK;
  }
  return total;
}

function issue(code, file, message) {
  return { code, path: file, message };
}

/**
 * Read an add-on directory into { path: Buffer }, refusing anything a package
 * may not hold. Never throws for a problem in the directory: problems come
 * back in `errors`. Symlinks are refused, not followed.
 * @param {string} dir
 * @param {{limits?: object}} [options]
 * @returns {{files: Object<string, Buffer>, errors: object[]}}
 */
function readPackageDir(dir, { limits = LIMITS } = {}) {
  const files = {};
  const errors = [];
  let root;
  try {
    root = fs.lstatSync(dir);
  } catch (err) {
    return { files, errors: [issue('dir_unreadable', '.', `cannot read ${dir}: ${err.code || err.message}`)] };
  }
  if (root.isSymbolicLink()) return { files, errors: [issue('symlink', '.', 'the add-on directory is a symlink')] };
  if (!root.isDirectory()) return { files, errors: [issue('dir_unreadable', '.', `${dir} is not a directory`)] };

  let count = 0;
  let total = 0;
  const walk = (abs, rel) => {
    const names = fs.readdirSync(abs).sort();
    for (const name of names) {
      if (isPlatformJunk(name)) continue;
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(childAbs);
      if (st.isSymbolicLink()) { errors.push(issue('symlink', childRel, 'symlinks are not allowed in a package')); continue; }
      if (st.isDirectory()) {
        if (!ALLOWED_DIR.test(name)) { errors.push(issue('bad_path', childRel, 'folder names may use only letters, digits, "-" and "_"')); continue; }
        walk(childAbs, childRel);
        continue;
      }
      if (!st.isFile()) { errors.push(issue('not_a_file', childRel, 'only regular files are allowed')); continue; }
      if (!ALLOWED_FILE.test(name)) {
        errors.push(issue('file_type', childRel, 'a declarative package holds only .json and .md files'));
        continue;
      }
      if (!normalizeEntryPath(childRel) || Buffer.byteLength(childRel) > MAX_PATH_BYTES) {
        errors.push(issue('bad_path', childRel, `paths must be relative and at most ${MAX_PATH_BYTES} bytes`));
        continue;
      }
      count += 1;
      if (st.size > limits.maxFileBytes) {
        errors.push(issue('file_too_large', childRel, `larger than ${Math.round(limits.maxFileBytes / KB)}KB`));
        continue;
      }
      total += st.size;
      files[childRel] = fs.readFileSync(childAbs);
    }
  };
  try {
    walk(dir, '');
  } catch (err) {
    errors.push(issue('dir_unreadable', '.', `cannot read ${dir}: ${err.code || err.message}`));
  }
  if (count > limits.maxFiles) errors.push(issue('too_many_files', '.', `a package may hold at most ${limits.maxFiles} files (this one has ${count})`));
  if (total > limits.maxTotalBytes) errors.push(issue('package_too_large', '.', `the files add up to more than ${Math.round(limits.maxTotalBytes / KB)}KB`));
  if (!count) errors.push(issue('empty', '.', 'the directory holds no .json or .md files'));
  return { files, errors };
}

module.exports = {
  LIMITS,
  packFiles,
  tarSize,
  readPackageDir,
  normalizeEntryPath,
  sha256Hex,
  ALLOWED_FILE,
  MAX_PATH_BYTES,
};
