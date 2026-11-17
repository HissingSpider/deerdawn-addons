'use strict';

// VENDORED from DeerDawn packages/addon-kit 0.2.0 (MIT), source commit
// 16920c7891a928d0ad8562c2b015d0401899ca44. Do not edit here: change it in DeerDawn and copy it
// again. Goes away once @deerdawn/addon-kit is on npm (tools/README.md).

// DOES A NEW VERSION ONLY WIDEN THE OLD ONE'S SCHEMAS?
//
// An update never rewrites anybody's records (a declarative add-on has no
// migration code), so a minor or patch version must accept every record the
// previous version accepted: new optional properties, more enum values, looser
// limits. Anything else needs a major version.
//
// This is deliberately conservative. It proves widening for the keywords it
// understands and treats everything else as "changed, cannot prove it widens":
// a keyword it does not model must be identical in both versions, or the
// change is reported as needing a major. A false "needs a major" costs an
// author a version number; a false "fine" breaks people's records.

const ANNOTATIONS = new Set(['title', 'description', '$comment', 'default', 'examples', '$schema', '$id', 'readOnly', 'writeOnly', 'deprecated', 'format']);
const LOWER_BOUNDS = ['minLength', 'minItems', 'minProperties', 'minimum', 'exclusiveMinimum', 'minContains'];
const UPPER_BOUNDS = ['maxLength', 'maxItems', 'maxProperties', 'maximum', 'exclusiveMaximum', 'maxContains'];
const MODELLED = new Set([
  ...ANNOTATIONS, ...LOWER_BOUNDS, ...UPPER_BOUNDS,
  'type', 'required', 'properties', 'additionalProperties', 'enum', 'const', 'items', 'uniqueItems', 'multipleOf',
]);
const ALL_TYPES = ['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'];

function isObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function same(a, b) {
  return canonical(a) === canonical(b);
}

/** A schema with every annotation removed, for "is anything else different?". */
function stripAnnotations(schema) {
  if (!isObject(schema)) return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) if (!ANNOTATIONS.has(k)) out[k] = v;
  return out;
}

/** The set of JSON types a schema's `type` admits; null means "any". integer is inside number. */
function typeSet(schema) {
  if (!isObject(schema) || schema.type === undefined) return null;
  const list = Array.isArray(schema.type) ? schema.type : [schema.type];
  const set = new Set(list);
  if (set.has('number')) set.add('integer');
  return set;
}

/** Does `schema` accept anything at all (true, {} or only annotations)? */
function acceptsAll(schema) {
  if (schema === true) return true;
  return isObject(schema) && Object.keys(stripAnnotations(schema)).length === 0;
}

/**
 * Compare two JSON Schemas. Returns the reasons `next` might refuse something
 * `prev` accepted; an empty list means `next` provably accepts everything
 * `prev` did (for the keywords modelled here).
 */
function compareSchemas(prev, next, where = '') {
  const at = where || '(root)';
  const problems = [];
  const add = (message) => problems.push({ path: at, message });

  if (prev === false) return problems; // accepted nothing; anything is wider
  if (acceptsAll(next)) return problems;
  if (acceptsAll(prev)) { add('was unconstrained and now has rules'); return problems; }
  if (!isObject(prev) || !isObject(next)) { add('schema changed shape'); return problems; }
  if (same(stripAnnotations(prev), stripAnnotations(next))) return problems;

  // Keywords this does not model must not change at all.
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (MODELLED.has(key)) continue;
    if (!same(prev[key], next[key])) add(`"${key}" changed, and this check cannot prove that only widens`);
  }

  // type: the new set must contain the old one.
  const pt = typeSet(prev);
  const nt = typeSet(next);
  if (nt) {
    const before = pt || new Set(ALL_TYPES);
    for (const t of before) if (!nt.has(t)) add(pt ? `type no longer allows "${t}"` : `now restricts type to ${[...nt].join(', ')}`);
  }

  // required: only ever fewer.
  const pr = new Set(Array.isArray(prev.required) ? prev.required : []);
  for (const name of Array.isArray(next.required) ? next.required : []) {
    if (!pr.has(name)) add(`"${name}" is newly required`);
  }

  // enum / const: only ever more values.
  if (next.enum !== undefined) {
    if (!Array.isArray(next.enum)) add('"enum" is not an array');
    else if (prev.enum === undefined && prev.const === undefined) add('now restricts values with "enum"');
    else {
      const allowed = new Set(next.enum.map(canonical));
      const before = prev.enum !== undefined ? prev.enum : [prev.const];
      for (const v of before) if (!allowed.has(canonical(v))) add(`enum value ${JSON.stringify(v)} was removed`);
    }
  }
  if (next.const !== undefined && !(prev.const !== undefined && same(prev.const, next.const))) {
    add(prev.const !== undefined ? '"const" changed' : 'now restricts the value with "const"');
  }

  // numeric and size limits: only ever looser.
  for (const key of LOWER_BOUNDS) {
    if (next[key] === undefined) continue;
    if (typeof next[key] !== 'number' || typeof prev[key] !== 'number') { add(`"${key}" was added`); continue; }
    if (next[key] > prev[key]) add(`"${key}" went up from ${prev[key]} to ${next[key]}`);
  }
  for (const key of UPPER_BOUNDS) {
    if (next[key] === undefined) continue;
    if (typeof next[key] !== 'number' || typeof prev[key] !== 'number') { add(`"${key}" was added`); continue; }
    if (next[key] < prev[key]) add(`"${key}" went down from ${prev[key]} to ${next[key]}`);
  }
  if (next.multipleOf !== undefined && next.multipleOf !== prev.multipleOf) add('"multipleOf" changed');
  if (next.uniqueItems === true && prev.uniqueItems !== true) add('now requires unique items');

  // properties: none removed, each one widening; new ones only where the old
  // schema refused unknown properties outright.
  const pp = isObject(prev.properties) ? prev.properties : {};
  const np = isObject(next.properties) ? next.properties : {};
  for (const [name, schema] of Object.entries(pp)) {
    if (!Object.prototype.hasOwnProperty.call(np, name)) { add(`property "${name}" was removed`); continue; }
    problems.push(...compareSchemas(schema, np[name], `${where}/properties/${name}`));
  }
  const closedBefore = prev.additionalProperties === false;
  for (const [name, schema] of Object.entries(np)) {
    if (Object.prototype.hasOwnProperty.call(pp, name)) continue;
    if (closedBefore || acceptsAll(schema)) continue;
    if (isObject(prev.additionalProperties)) {
      problems.push(...compareSchemas(prev.additionalProperties, schema, `${where}/properties/${name}`));
    } else {
      add(`new property "${name}" has rules, and the old version accepted any value under that name`);
    }
  }

  // additionalProperties: false -> anything is wider; open -> must stay open.
  if (prev.additionalProperties !== false && next.additionalProperties !== undefined && next.additionalProperties !== true) {
    if (next.additionalProperties === false) add('no longer accepts unknown properties');
    else if (isObject(prev.additionalProperties)) problems.push(...compareSchemas(prev.additionalProperties, next.additionalProperties, `${where}/additionalProperties`));
    else if (!acceptsAll(next.additionalProperties)) add('now restricts unknown properties');
  }

  // items: one schema for every item is compared; anything else must not change.
  if (next.items !== undefined && !same(prev.items, next.items)) {
    if (prev.items === undefined) {
      if (!acceptsAll(next.items)) add('now restricts array items');
    } else if (isObject(prev.items) && isObject(next.items) || typeof prev.items === 'boolean' || typeof next.items === 'boolean') {
      problems.push(...compareSchemas(prev.items, next.items, `${where}/items`));
    } else {
      add('"items" changed, and this check cannot prove that only widens');
    }
  }
  return problems;
}

function parseJson(files, key) {
  if (!files || !Object.prototype.hasOwnProperty.call(files, key)) return { error: `${key} is missing` };
  const value = files[key];
  try {
    return { value: typeof value === 'string' ? JSON.parse(value) : JSON.parse(Buffer.from(value).toString('utf8')) };
  } catch (err) {
    return { error: `${key} is not valid JSON: ${err.message}` };
  }
}

function schemaKey(def) {
  return String(def && def.schema).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.').join('/');
}

/**
 * Does the package in `newFiles` only widen the package in `oldFiles`?
 * Both are { path: text|Buffer } maps of a whole package.
 * @returns {{ok: boolean, problems: {collection: string|null, path: string, message: string}[]}}
 */
function schemaWidening(oldFiles, newFiles) {
  const problems = [];
  const add = (collection, path, message) => problems.push({ collection, path, message });
  const oldManifest = parseJson(oldFiles, 'addon.json');
  const newManifest = parseJson(newFiles, 'addon.json');
  if (oldManifest.error || newManifest.error) {
    add(null, 'addon.json', oldManifest.error || newManifest.error);
    return { ok: false, problems };
  }
  const om = oldManifest.value;
  const nm = newManifest.value;
  if (om.id !== nm.id) add(null, 'addon.json', `the id changed from "${om.id}" to "${nm.id}"`);
  if (om.kind !== nm.kind) add(null, 'addon.json', `"kind" changed from "${om.kind}" to "${nm.kind}"`);
  const oc = (om && om.collections) || {};
  const nc = (nm && nm.collections) || {};
  for (const [name, def] of Object.entries(oc)) {
    if (!Object.prototype.hasOwnProperty.call(nc, name)) { add(name, 'addon.json', `collection "${name}" was removed`); continue; }
    if (def.attachments === true && nc[name].attachments !== true) add(name, 'addon.json', `collection "${name}" no longer takes attachments`);
    const before = parseJson(oldFiles, schemaKey(def));
    const after = parseJson(newFiles, schemaKey(nc[name]));
    if (before.error || after.error) { add(name, schemaKey(nc[name]), before.error || after.error); continue; }
    for (const p of compareSchemas(before.value, after.value)) add(name, p.path, p.message);
  }
  return { ok: problems.length === 0, problems };
}

// ─── Versions ───────────────────────────────────────────────────────────────

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(version) {
  const m = SEMVER.exec(String(version));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

/** Semver precedence: -1, 0 or 1. Throws on something that is not a version. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a semantic version: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : (x.pre.length ? -1 : 1);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const xn = /^\d+$/.test(x.pre[i]);
    const yn = /^\d+$/.test(y.pre[i]);
    if (xn && yn) { const d = Number(x.pre[i]) - Number(y.pre[i]); if (d) return d < 0 ? -1 : 1; continue; }
    if (xn !== yn) return xn ? -1 : 1;
    if (x.pre[i] !== y.pre[i]) return x.pre[i] < y.pre[i] ? -1 : 1;
  }
  return 0;
}

/** 'major' when the major number goes up, else 'minor' or 'patch' (a pre-release step counts as patch). */
function bumpKind(from, to) {
  const x = parseVersion(from);
  const y = parseVersion(to);
  if (!x || !y) throw new Error('not a semantic version');
  if (y.major !== x.major) return 'major';
  if (y.minor !== x.minor) return 'minor';
  return 'patch';
}

module.exports = { schemaWidening, compareSchemas, compareVersions, parseVersion, bumpKind };
