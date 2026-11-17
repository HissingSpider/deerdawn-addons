'use strict';

// VENDORED from DeerDawn packages/addon-kit 0.2.0 (MIT), source commit
// 16920c7891a928d0ad8562c2b015d0401899ca44. Do not edit here: change it in DeerDawn and copy it
// again. Goes away once @deerdawn/addon-kit is on npm (tools/README.md).

// VALIDATE AN ADD-ON PACKAGE THE WAY A DEERDAWN SERVER AND THE REGISTRY WILL.
//
// Two levels:
//
//   - default: everything a server checks before it installs a package
//     (apps/api/src/addons/loader.js, compilePackage with untrusted:true, and
//     packageArchive.js unpackTarball). If this passes, the server accepts it.
//     The text lint below runs too, but only as warnings.
//   - registry: { registry: true } adds what the public registry's CI requires
//     on top: license (OSI), author, homepage and platform present; a SKILL.md;
//     the text lint as errors; the id not reserved.
//
// The server's checks are reproduced here rather than imported, because this
// package is MIT and must not import from the AGPL server. Where they differ,
// this side is stricter, never looser: a package this passes must never be one
// the server refuses. tests/validate.test.js runs the bundled add-ons and a
// set of hostile packages through both.
//
// Results are structured: { ok, errors: [{code, path, message}], warnings: [...] }.
// Nothing here throws on a bad package.

const Ajv = require('ajv');
const { validateManifest, GENERIC_ACTIONS, PLATFORM } = require('./index');
const { LIMITS, packFiles, tarSize, readPackageDir, normalizeEntryPath, sha256Hex, ALLOWED_FILE, MAX_PATH_BYTES } = require('./archive');
const { checkOsiLicense } = require('./licenses');

const KB = 1024;

/** The server's limits for a package from outside the image (loader.js UNTRUSTED). */
const UNTRUSTED = Object.freeze({
  maxCollections: 20,
  maxViews: 20,
  maxSchemaBytes: 32 * KB,
  maxSchemaDepth: 16,
  maxSchemaNodes: 2000,
  maxSkillBytes: 8 * KB,
});
const MAX_LISTING_BYTES = 16 * KB;

/**
 * Ids no registry listing may take: first-party add-ons, dashboard route names,
 * API path segments, and words that would read as official. The server keeps
 * the same list (apps/api/src/addons/reservedIds.js) and the registry repo keeps
 * reserved-ids.json; the registry CI reads that file, this copy is for authors.
 */
const RESERVED_IDS = Object.freeze([
  'wardrobe', 'notes-example', 'second-brain', 'marketplace',
  'browse', 'installed', 'view', 'new', 'settings', 'index',
  'install', 'packages', 'brief-lines', 'upload', 'catalog',
  'deerdawn', 'official', 'admin', 'system', 'help',
]);

const FORBIDDEN_SCHEMA_KEYS = new Set(['pattern', 'patternProperties', '$async', '$dynamicRef', '$recursiveRef']);
const SCHEMA_NAME_MAPS = new Set(['properties', 'definitions', '$defs', 'dependentSchemas', 'dependencies']);
const SCHEMA_DATA_KEYS = new Set(['enum', 'const', 'default', 'examples', 'required', 'title', 'description', '$comment', 'type']);
// The server's own brief-line rule (loader.js PLAIN_BRIEF_LINE).
const PLAIN_BRIEF_LINE = /^[\p{L}\p{N} .,:;!?()'"&/{}_-]+$/u;
const PLACEHOLDER = /\{\{\s*([^}]*?)\s*\}\}/g;

// Characters that hide text from a human reviewer: C0 controls other than tab
// and newline, zero-width characters, bidi overrides, the BOM.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F­​-‏‪-‮⁠-⁤⁦-⁩﻿]/u;

/**
 * DeerDawn's MCP tool names, current and retired. An add-on's SKILL.md may
 * name read_addon and use_addon and nothing else: the help text is read by the
 * agent, and an instruction to call another tool is the injection this exists
 * to catch.
 */
const DEERDAWN_TOOL_NAMES = Object.freeze([
  'apply_setup', 'archive_project', 'browse_skills', 'build_subagent_brief', 'cleanup_context',
  'complete_setup', 'confirm_claim', 'create_project', 'find_known_paths', 'get_auth_status',
  'get_context', 'get_next_best_context', 'get_project_map', 'get_setup_status', 'get_skill',
  'get_workspace_entities', 'get_workspace_overview', 'import_local_context', 'import_skill_from_github',
  'inspect_context_graph', 'list_context_map', 'list_projects', 'list_skills', 'manage_memory',
  'manage_projects', 'manage_skills', 'manage_tasks', 'manage_todos', 'mark_resolved', 'read_brief',
  'recall', 'record_debug_finding', 'record_hot_paths', 'rename_project', 'search_context',
  'set_project_parent', 'start_session', 'switch_subproject', 'sync_skills', 'update_brief',
  'update_context', 'upsert_workspace_entities', 'flush_session',
]);
const ALLOWED_TOOLS = new Set(['read_addon', 'use_addon']);
const ALLOWED_ACTIONS = new Set([...GENERIC_ACTIONS, 'help']);

// Anything with a scheme, a www. host, or a bare host on a common TLD.
const URL_WITH_SCHEME = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s<>()[\]"'`]*/gi;
// "data: {" in an example call is a field name, not a link: a scheme counts
// only when something other than a space or an opening bracket follows it.
const URL_SCHEMES_WITHOUT_SLASHES = /\b(?:mailto|javascript|data|file|vbscript|tel|sms):(?=[^\s{[("'`])/gi;
const WWW_HOST = /\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>()[\]"'`]*/gi;
const BARE_HOST = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|dev|app|co|xyz|me|info|link|sh|gg|ly|so|to|site|online|page|cc|us|uk|de)\b(?:\/[^\s<>()[\]"'`]*)?/gi;
const RISKY_HTML = /<\s*\/?\s*(?:script|iframe|img|a|object|embed|link|style|form|meta|svg|video|audio|source|base|input|button)\b/i;
const ANY_HTML = /<\s*\/?\s*[a-z][a-z0-9-]*(?:\s[^>]*)?>/i;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\s*\(/;
const OTHER_SCOPE = /\b(?:other|another|all|every|each)\s+(?:of\s+the\s+)?(?:user'?s\s+|your\s+|their\s+)?(?:projects?|add-?ons?|workspaces?|briefs?)\b/i;

function issue(code, file, message) {
  return { code, path: file, message };
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function trimUrl(raw) {
  return raw.replace(/[.,;:!?'")\]]+$/, '');
}

function sameUrl(a, b) {
  const norm = (u) => String(u || '').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return null; }
}

/**
 * Lint an add-on's SKILL.md: the text every agent that uses the add-on reads.
 * @param {string} text
 * @param {{id?: string, homepage?: string, kind?: string}} [context]
 * @returns {{code: string, message: string}[]}
 */
function lintSkill(text, { id = null, homepage = null, kind = 'declarative' } = {}) {
  const found = [];
  const add = (code, message, index) => found.push({ code, message: index === undefined ? message : `line ${lineOf(text, index)}: ${message}` });
  if (Buffer.byteLength(text, 'utf8') > UNTRUSTED.maxSkillBytes) add('skill_too_large', `SKILL.md is larger than ${UNTRUSTED.maxSkillBytes / KB}KB`);
  if (!text.trim()) add('skill_empty', 'SKILL.md is empty');
  const invisible = INVISIBLE.exec(text);
  if (invisible) add('invisible_characters', `holds a control or invisible character (U+${invisible[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`, invisible.index);

  const homeHost = homepage ? hostOf(homepage) : null;
  for (const match of text.matchAll(URL_WITH_SCHEME)) {
    const url = trimUrl(match[0]);
    if (!homepage || !sameUrl(url, homepage)) add('url', `"${url}": the only URL SKILL.md may contain is the manifest's homepage`, match.index);
  }
  for (const match of text.matchAll(URL_SCHEMES_WITHOUT_SLASHES)) add('url', `"${match[0]}" links are not allowed`, match.index);
  for (const match of text.matchAll(WWW_HOST)) {
    const before = text.slice(Math.max(0, match.index - 3), match.index);
    if (before.endsWith('://')) continue; // already judged as a URL above
    add('url', `"${trimUrl(match[0])}": the only URL SKILL.md may contain is the manifest's homepage`, match.index);
  }
  for (const match of text.matchAll(BARE_HOST)) {
    const before = text.slice(Math.max(0, match.index - 3), match.index);
    if (before.endsWith('://') || before.endsWith('.') || /www\.$/i.test(text.slice(Math.max(0, match.index - 4), match.index))) continue;
    const host = match[0].split('/')[0].toLowerCase();
    if (homeHost && host === homeHost && !match[0].includes('/')) continue; // naming the homepage's host is fine
    add('url', `"${trimUrl(match[0])}" looks like a web address; the only URL SKILL.md may contain is the manifest's homepage`, match.index);
  }

  for (const name of DEERDAWN_TOOL_NAMES) {
    const re = name.includes('_')
      ? new RegExp(`\\b${name}\\b`, 'g')
      : new RegExp(`(?:\`${name}\`|\\b${name}\\s*[({])`, 'g');
    for (const match of text.matchAll(re)) add('tool_name', `names the DeerDawn tool "${name}"; an add-on's instructions may use only read_addon and use_addon`, match.index);
  }
  for (const match of text.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*[({]/g)) {
    const name = match[1];
    if (ALLOWED_TOOLS.has(name) || DEERDAWN_TOOL_NAMES.includes(name)) continue;
    add('tool_name', `"${name} ${match[0].slice(-1)}" reads as a call to a tool other than read_addon or use_addon`, match.index);
  }
  for (const match of text.matchAll(/\baddon\s*:\s*["'`]([^"'`]+)["'`]/g)) {
    if (id && match[1] !== id) add('other_addon', `addresses the add-on "${match[1]}"; instructions may only use this add-on ("${id}")`, match.index);
  }
  if (kind === 'declarative') {
    for (const match of text.matchAll(/\baction\s*:\s*["'`]([^"'`]+)["'`]/g)) {
      if (!ALLOWED_ACTIONS.has(match[1])) add('unknown_action', `names the action "${match[1]}"; a declarative add-on has only ${[...ALLOWED_ACTIONS].join(', ')}`, match.index);
    }
  }
  const scope = OTHER_SCOPE.exec(text);
  if (scope) add('other_scope', `"${scope[0]}": instructions may be about this add-on's own data only, not other projects, add-ons or workspaces`, scope.index);
  const html = RISKY_HTML.exec(text);
  if (html) add('html', 'raw HTML is not allowed', html.index);
  const image = MARKDOWN_IMAGE.exec(text);
  if (image) add('image', 'images are not allowed', image.index);
  return found;
}

/**
 * Lint a brief_line for the registry: plain words, numbers, punctuation and
 * {{collection.count}}, at most 160 characters.
 * @returns {{code: string, message: string}[]}
 */
function lintBriefLine(line) {
  const found = [];
  if (typeof line !== 'string') return [{ code: 'brief_line', message: '"brief_line" must be a string' }];
  if (line.length > 160) found.push({ code: 'brief_line', message: '"brief_line" is longer than 160 characters' });
  if (!PLAIN_BRIEF_LINE.test(line) || /https?:|www\./i.test(line)) {
    found.push({ code: 'brief_line', message: '"brief_line" may hold only words, numbers, punctuation and {{collection.count}}' });
  }
  const rest = line.replace(PLACEHOLDER, ' ');
  if (/[{}]/.test(rest)) found.push({ code: 'brief_line', message: '"brief_line": braces are allowed only in {{collection.count}}' });
  if (/[a-z0-9]_[a-z0-9]/i.test(rest) || /[a-z0-9]\/[a-z0-9]/i.test(rest)) {
    found.push({ code: 'brief_line', message: '"brief_line" reads like a tool name or a path; keep it to plain words' });
  }
  if (BARE_HOST.test(rest)) found.push({ code: 'brief_line', message: '"brief_line" contains what looks like a web address' });
  BARE_HOST.lastIndex = 0;
  return found;
}

/**
 * Lint addons/<id>/LISTING.md (registry only): rendered on the listing page by
 * a sanitising renderer, but the registry still refuses what it would strip.
 * @returns {{code: string, message: string}[]}
 */
function lintListing(text) {
  const found = [];
  const add = (code, message) => found.push({ code, message });
  if (typeof text !== 'string' || !text.trim()) return [{ code: 'listing_missing', message: 'LISTING.md is missing or empty' }];
  if (Buffer.byteLength(text, 'utf8') > MAX_LISTING_BYTES) add('listing_too_large', `LISTING.md is larger than ${MAX_LISTING_BYTES / KB}KB`);
  if (INVISIBLE.test(text)) add('invisible_characters', 'LISTING.md holds a control or invisible character');
  if (ANY_HTML.test(text)) add('html', 'LISTING.md may not contain raw HTML');
  if (MARKDOWN_IMAGE.test(text)) add('image', 'LISTING.md may not contain images');
  for (const match of text.matchAll(URL_WITH_SCHEME)) {
    if (!/^https:\/\//i.test(match[0])) add('url', `"${trimUrl(match[0])}": links must be https`);
  }
  for (const match of text.matchAll(URL_SCHEMES_WITHOUT_SLASHES)) add('url', `"${match[0]}" links are not allowed`);
  return found;
}

let secureMetaValidate = null;
function secureMeta() {
  if (!secureMetaValidate) {
    const metaAjv = new Ajv({ strict: false, allErrors: true });
    secureMetaValidate = metaAjv.compile(require('ajv/lib/refs/json-schema-secure.json'));
  }
  return secureMetaValidate;
}

function formatAjvErrors(errors) {
  return (errors || []).slice(0, 5).map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
}

/**
 * The server's untrusted-schema walk (loader.js checkUntrustedSchema), as a
 * list of problems instead of a throw.
 */
function checkUntrustedSchema(schema) {
  const problems = [];
  if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > UNTRUSTED.maxSchemaBytes) {
    problems.push(`schema is larger than ${UNTRUSTED.maxSchemaBytes / KB}KB`);
  }
  let nodes = 0;
  const walk = (value, depth) => {
    if (depth > UNTRUSTED.maxSchemaDepth) throw new Error(`schema nests deeper than ${UNTRUSTED.maxSchemaDepth} levels`);
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      nodes += 1;
      if (nodes > UNTRUSTED.maxSchemaNodes) throw new Error(`schema has more than ${UNTRUSTED.maxSchemaNodes} keys`);
      if (FORBIDDEN_SCHEMA_KEYS.has(key)) throw new Error(`"${key}" is not allowed in an installed add-on's schema`);
      if (key === '$ref' && (typeof child !== 'string' || !child.startsWith('#'))) throw new Error('only local $ref ("#/...") is allowed');
      if (SCHEMA_DATA_KEYS.has(key)) continue;
      if (SCHEMA_NAME_MAPS.has(key) && child && typeof child === 'object' && !Array.isArray(child)) {
        for (const sub of Object.values(child)) {
          nodes += 1;
          if (sub && typeof sub === 'object' && !Array.isArray(sub)) walk(sub, depth + 2);
        }
        continue;
      }
      walk(child, depth + 1);
    }
  };
  try {
    walk(schema, 0);
  } catch (err) {
    problems.push(err.message);
  }
  if (!problems.length) {
    const validate = secureMeta();
    if (!validate(schema)) problems.push(`schema is not safe to compile: ${formatAjvErrors(validate.errors)}`);
  }
  return problems;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function toText(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return utf8.decode(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Validate a package held in memory.
 * @param {Object<string, string|Buffer>} files  path -> contents, paths relative to the package root
 * @param {object} [options]
 * @param {boolean} [options.registry]       apply the registry's rules too
 * @param {string[]} [options.reservedIds]   ids to refuse in registry mode (default RESERVED_IDS)
 * @returns {{ok: boolean, errors: object[], warnings: object[], manifest: object|null}}
 */
function validatePackageFiles(files, { registry = false, reservedIds = RESERVED_IDS } = {}) {
  const errors = [];
  const warnings = [];
  const lint = (code, file, message) => (registry ? errors : warnings).push(issue(code, file, message));
  const texts = {};

  // Files: the archive reader's rules.
  const names = Object.keys(files || {});
  let total = 0;
  for (const name of names) {
    const normal = normalizeEntryPath(name);
    const base = name.split('/').pop();
    if (normal !== name || Buffer.byteLength(name) > MAX_PATH_BYTES) { errors.push(issue('bad_path', name, `paths must be relative, normalised and at most ${MAX_PATH_BYTES} bytes`)); continue; }
    if (!ALLOWED_FILE.test(base)) { errors.push(issue('file_type', name, 'a declarative package holds only .json and .md files')); continue; }
    let text;
    try {
      text = toText(files[name]);
    } catch (_) {
      errors.push(issue('not_utf8', name, 'not valid UTF-8 text'));
      continue;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > LIMITS.maxFileBytes) errors.push(issue('file_too_large', name, `larger than ${LIMITS.maxFileBytes / KB}KB`));
    total += bytes;
    texts[name] = text;
  }
  if (names.length > LIMITS.maxFiles) errors.push(issue('too_many_files', '.', `a package may hold at most ${LIMITS.maxFiles} files`));
  if (total > LIMITS.maxTotalBytes) errors.push(issue('package_too_large', '.', `the files add up to more than ${LIMITS.maxTotalBytes / KB}KB`));
  if (!errors.length && names.length) {
    if (tarSize(texts) > LIMITS.maxTarBytes) errors.push(issue('package_too_large', '.', `the archive would unpack to more than ${LIMITS.maxTarBytes / KB}KB`));
    else if (packFiles(texts).length > LIMITS.maxCompressedBytes) errors.push(issue('package_too_large', '.', `the archive would be larger than ${LIMITS.maxCompressedBytes / KB}KB`));
  }

  // The manifest.
  if (!Object.prototype.hasOwnProperty.call(texts, 'addon.json')) {
    errors.push(issue('no_manifest', 'addon.json', 'addon.json is missing from the package root'));
    return { ok: false, errors, warnings, manifest: null };
  }
  let manifest;
  try {
    manifest = JSON.parse(texts['addon.json']);
  } catch (err) {
    errors.push(issue('manifest_json', 'addon.json', `not valid JSON: ${err.message}`));
    return { ok: false, errors, warnings, manifest: null };
  }
  const verdict = validateManifest(manifest);
  for (const message of verdict.errors) errors.push(issue('manifest', 'addon.json', message));
  if (!verdict.ok) return { ok: false, errors, warnings, manifest };

  if (manifest.kind !== 'declarative') {
    errors.push(issue('kind', 'addon.json', registry
      ? 'the registry lists declarative add-ons only ("kind": "declarative")'
      : 'a package must be declarative: server add-ons ship in the server image, never as a package'));
  }
  const collectionNames = Object.keys(manifest.collections);
  if (collectionNames.length > UNTRUSTED.maxCollections) errors.push(issue('too_many_collections', 'addon.json', `at most ${UNTRUSTED.maxCollections} collections`));
  if (Array.isArray(manifest.views) && manifest.views.length > UNTRUSTED.maxViews) errors.push(issue('too_many_views', 'addon.json', `at most ${UNTRUSTED.maxViews} views`));

  for (const field of ['name', 'description', 'author']) {
    if (typeof manifest[field] === 'string' && INVISIBLE.test(manifest[field])) lint('invisible_characters', 'addon.json', `"${field}" holds a control or invisible character`);
  }

  // Collection schemas: the server's untrusted compile.
  const referenced = new Set(['addon.json']);
  const ajv = new Ajv({ allErrors: false, strict: false, useDefaults: false, validateFormats: false });
  const schemaProps = {};
  for (const [name, def] of Object.entries(manifest.collections)) {
    const key = normalizeEntryPath(String(def.schema).replace(/\\/g, '/'));
    referenced.add(key);
    if (!key || !Object.prototype.hasOwnProperty.call(texts, key)) {
      errors.push(issue('schema_missing', def.schema, `collection "${name}": schema file is not in the package`));
      continue;
    }
    let schema;
    try {
      schema = JSON.parse(texts[key]);
    } catch (err) {
      errors.push(issue('schema_json', key, `collection "${name}": not valid JSON: ${err.message}`));
      continue;
    }
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || (schema.type && schema.type !== 'object')) {
      errors.push(issue('schema_not_object', key, `collection "${name}": schema must describe an object`));
      continue;
    }
    const { $id: _id, $schema: _schema, ...rest } = schema;
    const problems = checkUntrustedSchema(rest);
    for (const message of problems) errors.push(issue('schema_unsafe', key, `collection "${name}": ${message}`));
    if (problems.length) continue;
    try {
      ajv.compile(rest);
    } catch (err) {
      errors.push(issue('schema_compile', key, `collection "${name}": schema does not compile: ${err.message}`));
      continue;
    }
    schemaProps[name] = schema.properties && typeof schema.properties === 'object' ? new Set(Object.keys(schema.properties)) : null;
  }

  // Views that name fields the schema does not have render empty columns.
  for (const view of manifest.views || []) {
    const props = schemaProps[view.collection];
    if (!props) continue;
    for (const field of [...(view.fields || []), ...(view.title_field ? [view.title_field] : [])]) {
      if (!props.has(field)) warnings.push(issue('view_field', 'addon.json', `view "${view.id}" shows "${field}", which collection "${view.collection}" does not define`));
    }
  }

  // SKILL.md.
  if (manifest.skill !== undefined) {
    const key = normalizeEntryPath(String(manifest.skill).replace(/\\/g, '/'));
    referenced.add(key);
    if (!key || !Object.prototype.hasOwnProperty.call(texts, key)) {
      errors.push(issue('skill_missing', manifest.skill, 'the skill file is not in the package'));
    } else {
      const text = texts[key];
      if (Buffer.byteLength(text, 'utf8') > UNTRUSTED.maxSkillBytes) errors.push(issue('skill_too_large', key, `larger than ${UNTRUSTED.maxSkillBytes / KB}KB`));
      for (const found of lintSkill(text, { id: manifest.id, homepage: manifest.homepage, kind: manifest.kind })) {
        if (found.code !== 'skill_too_large') lint(found.code, key, found.message);
      }
    }
  } else if (registry) {
    errors.push(issue('skill_missing', 'addon.json', 'the registry requires a "skill" (SKILL.md) telling the agent how to use the add-on'));
  }

  // brief_line: the server's rule is an error everywhere; the rest is lint.
  if (manifest.brief_line !== undefined) {
    const line = String(manifest.brief_line);
    if (line.length > 160 || !PLAIN_BRIEF_LINE.test(line) || /https?:|www\./i.test(line)) {
      errors.push(issue('brief_line', 'addon.json', 'brief_line must be plain text (words, numbers, punctuation and {{collection.count}}), at most 160 characters'));
    } else {
      for (const found of lintBriefLine(line)) lint(found.code, 'addon.json', found.message);
    }
    if (INVISIBLE.test(line)) errors.push(issue('invisible_characters', 'addon.json', '"brief_line" holds a control or invisible character'));
  }

  for (const name of Object.keys(texts)) {
    if (!referenced.has(name)) warnings.push(issue('unreferenced', name, 'nothing in addon.json uses this file; it ships in the package anyway'));
    else if (name.endsWith('.json') && name !== 'addon.json' && INVISIBLE.test(texts[name].replace(/[\t\n\r]/g, ''))) {
      lint('invisible_characters', name, 'holds a control or invisible character');
    }
  }

  // The registry's own requirements.
  if (registry) {
    const license = checkOsiLicense(manifest.license);
    if (!license.ok) errors.push(issue('license', 'addon.json', license.message));
    if (manifest.author === undefined) errors.push(issue('author', 'addon.json', '"author" is required: your name or your organisation\'s'));
    if (manifest.homepage === undefined) errors.push(issue('homepage', 'addon.json', '"homepage" is required: an https URL where people can find you or the add-on'));
    if (manifest.platform === undefined) errors.push(issue('platform', 'addon.json', `"platform" is required: ${PLATFORM} for this version of the manifest`));
    else if (manifest.platform < 2) errors.push(issue('platform', 'addon.json', '"platform" must be at least 2: license, author, homepage and platform are platform 2 fields'));
    else if (manifest.platform > PLATFORM) errors.push(issue('platform', 'addon.json', `"platform" ${manifest.platform} is newer than this kit knows (${PLATFORM}); update @deerdawn/addon-kit`));
    if (Array.isArray(reservedIds) && reservedIds.includes(manifest.id)) {
      errors.push(issue('reserved_id', 'addon.json', `the id "${manifest.id}" is reserved`));
    }
    if (/[+]/.test(manifest.version)) errors.push(issue('version', 'addon.json', 'registry versions carry no build metadata ("+..."); it does not order versions'));
  } else if (['license', 'author', 'homepage'].some((k) => manifest[k] !== undefined) && manifest.platform === undefined) {
    warnings.push(issue('platform', 'addon.json', `uses platform 2 fields; set "platform": ${PLATFORM} so older servers skip it instead of failing`));
  }

  return { ok: errors.length === 0, errors, warnings, manifest };
}

/**
 * Validate an add-on directory.
 * @param {string} dir
 * @param {{registry?: boolean, reservedIds?: string[]}} [options]
 * @returns {{ok: boolean, errors: object[], warnings: object[], manifest: object|null, files: Object<string, Buffer>}}
 */
function validatePackage(dir, options = {}) {
  const read = readPackageDir(dir);
  const result = validatePackageFiles(read.files, options);
  const seen = new Set();
  const errors = [...read.errors, ...result.errors].filter((e) => {
    const key = `${e.code}\0${e.path}\0${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...result, ok: errors.length === 0, errors, files: read.files };
}

/**
 * Validate an add-on directory and pack it. Nothing is written: the caller
 * gets the bytes.
 * @param {string} dir
 * @param {{registry?: boolean, reservedIds?: string[]}} [options]
 * @returns {{ok: boolean, errors: object[], warnings: object[], manifest: object|null, buffer?: Buffer, sha256?: string, bytes?: number}}
 */
function pack(dir, options = {}) {
  const result = validatePackage(dir, options);
  if (!result.ok) return result;
  const buffer = packFiles(result.files);
  return { ...result, buffer, sha256: sha256Hex(buffer), bytes: buffer.length };
}

module.exports = {
  validatePackage,
  validatePackageFiles,
  pack,
  lintSkill,
  lintBriefLine,
  lintListing,
  checkUntrustedSchema,
  RESERVED_IDS,
  DEERDAWN_TOOL_NAMES,
  UNTRUSTED_LIMITS: UNTRUSTED,
  MAX_LISTING_BYTES,
};
