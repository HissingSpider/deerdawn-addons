#!/usr/bin/env node
'use strict';

// VENDORED from DeerDawn packages/addon-kit 0.2.0 (MIT), source commit
// 16920c7891a928d0ad8562c2b015d0401899ca44. Do not edit here: change it in DeerDawn and copy it
// again. Goes away once @deerdawn/addon-kit is on npm (tools/README.md).

// addon-kit: check and pack a DeerDawn add-on.
//
//   addon-kit validate <dir> [--local] [--json]
//   addon-kit pack <dir> [-o out.tgz] [--registry] [--json]
//   addon-kit widening <old-dir> <new-dir> [--json]
//
// validate runs the public registry's checks by default (the same ones its CI
// runs on a pull request). --local runs only what a DeerDawn server checks
// before installing a package, for an add-on you upload to your own server.
// pack validates the way a server does (add --registry for the registry's
// rules) and writes the tarball. Exit codes: 0 fine, 1 the add-on has
// problems, 2 the command was used wrongly.

const fs = require('fs');
const path = require('path');
const { validatePackage, pack } = require('../src/validate');
const { readPackageDir } = require('../src/archive');
const { schemaWidening, bumpKind } = require('../src/widening');
const { version } = require('../package.json');

const USAGE = `addon-kit ${version}

Usage:
  addon-kit validate <dir> [--local] [--json]
      Check an add-on directory. By default this runs the registry's checks;
      --local runs only what a DeerDawn server checks before installing it.
  addon-kit pack <dir> [-o <file.tgz>] [--registry] [--json]
      Validate and write the package tarball (default: <id>-<version>.tgz).
  addon-kit widening <old-dir> <new-dir> [--json]
      Say whether <new-dir> only widens <old-dir>'s schemas, as a minor or
      patch version must.
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-o' || arg === '--out') { flags.out = argv[i + 1]; i += 1; continue; }
    if (arg.startsWith('--out=')) { flags.out = arg.slice(6); continue; }
    if (arg.startsWith('-')) { flags[arg.replace(/^-+/, '')] = true; continue; }
    positional.push(arg);
  }
  return { positional, flags };
}

function printIssues(result, out) {
  for (const e of result.errors || []) out.write(`error   ${e.path}: ${e.message} [${e.code}]\n`);
  for (const w of result.warnings || []) out.write(`warning ${w.path}: ${w.message} [${w.code}]\n`);
}

function strip(result) {
  const { files: _files, buffer: _buffer, ...rest } = result;
  return rest;
}

function main(argv, { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  const { positional, flags } = parseArgs(argv);
  const [command, ...args] = positional;
  if (!command || flags.help || flags.h) { stdout.write(USAGE); return command ? 0 : 2; }
  const resolve = (p) => path.resolve(cwd, p);

  if (command === 'validate') {
    if (args.length !== 1) { stderr.write(USAGE); return 2; }
    const registry = !flags.local;
    const result = validatePackage(resolve(args[0]), { registry });
    if (flags.json) stdout.write(`${JSON.stringify(strip(result), null, 2)}\n`);
    else {
      printIssues(result, stdout);
      const what = result.manifest && result.manifest.id ? `${result.manifest.id}@${result.manifest.version}` : args[0];
      stdout.write(result.ok
        ? `ok      ${what} passes the ${registry ? 'registry' : 'server'} checks\n`
        : `failed  ${what}: ${result.errors.length} error(s)\n`);
    }
    return result.ok ? 0 : 1;
  }

  if (command === 'pack') {
    if (args.length !== 1) { stderr.write(USAGE); return 2; }
    const result = pack(resolve(args[0]), { registry: Boolean(flags.registry) });
    if (!result.ok) {
      if (flags.json) stdout.write(`${JSON.stringify(strip(result), null, 2)}\n`);
      else { printIssues(result, stdout); stdout.write(`failed  nothing written: ${result.errors.length} error(s)\n`); }
      return 1;
    }
    const out = resolve(typeof flags.out === 'string' ? flags.out : `${result.manifest.id}-${result.manifest.version}.tgz`);
    try {
      fs.writeFileSync(out, result.buffer);
    } catch (err) {
      stdout.write(`failed  cannot write ${out}: ${err.code || err.message}\n`);
      return 1;
    }
    if (flags.json) stdout.write(`${JSON.stringify({ ...strip(result), file: out }, null, 2)}\n`);
    else {
      printIssues(result, stdout);
      stdout.write(`wrote   ${out}\nsha256  ${result.sha256}\nbytes   ${result.bytes}\n`);
    }
    return 0;
  }

  if (command === 'widening') {
    if (args.length !== 2) { stderr.write(USAGE); return 2; }
    const before = readPackageDir(resolve(args[0]));
    const after = readPackageDir(resolve(args[1]));
    const readErrors = [...before.errors, ...after.errors];
    if (readErrors.length) {
      for (const e of readErrors) stdout.write(`error   ${e.path}: ${e.message} [${e.code}]\n`);
      return 1;
    }
    const result = schemaWidening(before.files, after.files);
    let bump = null;
    try {
      bump = bumpKind(JSON.parse(before.files['addon.json']).version, JSON.parse(after.files['addon.json']).version);
    } catch (_) { /* reported by schemaWidening or validate */ }
    const allowed = result.ok || bump === 'major';
    if (flags.json) stdout.write(`${JSON.stringify({ ...result, bump, allowed }, null, 2)}\n`);
    else {
      for (const p of result.problems) stdout.write(`${result.ok ? '' : 'narrows '}${p.collection ? `${p.collection} ` : ''}${p.path}: ${p.message}\n`);
      stdout.write(result.ok
        ? 'ok      only widens: fine for a minor or patch version\n'
        : `${bump === 'major' ? 'ok      ' : 'failed  '}needs a major version${bump ? ` (this is a ${bump} bump)` : ''}\n`);
    }
    return allowed ? 0 : 1;
  }

  stderr.write(`unknown command "${command}"\n\n${USAGE}`);
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };
