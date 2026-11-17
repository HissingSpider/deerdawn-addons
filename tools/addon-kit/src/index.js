'use strict';

// VENDORED from DeerDawn packages/addon-kit 0.2.0 (MIT), source commit
// 16920c7891a928d0ad8562c2b015d0401899ca44. Do not edit here: change it in DeerDawn and copy it
// again. Goes away once @deerdawn/addon-kit is on npm (tools/README.md).

// THE DEERDAWN ADD-ON INTERFACE. MIT, like the other client packages.
//
// Everything an add-on author needs to describe an add-on: the manifest JSON
// Schema, a validator for it, and JSDoc typedefs for the objects a server
// add-on's actions receive and return. Nothing in here may import from the
// AGPL server (apps/api): this package is the boundary that lets an add-on be
// written without touching server code.
//
// This file has no dependencies on purpose: the server requires it at boot.
// The authoring tools (validatePackage, pack, schemaWidening) live in their own
// files and are loaded on first use, because the package validator needs Ajv
// and the server must not start depending on this package's node_modules.

const manifestSchema = require('./manifestSchema.json');

/**
 * The add-on platform version this kit describes. 1: the original manifest.
 * 2: adds license, author, homepage and platform. A server on platform N
 * refuses a manifest with fields from N+1 (unknown fields are an error), so
 * the registry index tells it which listings it can load.
 */
const PLATFORM = 2;

/**
 * @typedef {'declarative' | 'server'} AddonKind
 * @typedef {'thumb' | 'view' | 'original'} AttachmentVariant
 * @typedef {'mcp-hosted' | 'mcp-local' | 'http'} AddonTransport
 */

/**
 * @typedef {Object} AddonCollection
 * @property {string} schema       Relative path to the collection's JSON Schema.
 * @property {boolean} [attachments] Records in this collection may carry files.
 */

/**
 * @typedef {Object} AddonView
 * @property {string} id
 * @property {'gallery' | 'table' | 'detail'} type
 * @property {string} collection
 * @property {string} [title]
 * @property {string[]} [fields]      Top-level data fields to show (table, detail).
 * @property {string} [title_field]   The data field used as a card title (gallery).
 */

/**
 * @typedef {Object} AddonManifest
 * @property {string} id
 * @property {string} name
 * @property {string} version
 * @property {string} [description]
 * @property {string} [license]     One SPDX id (platform 2). Required by the registry, which also wants it OSI-approved.
 * @property {string} [author]      Who wrote it (platform 2). Required by the registry.
 * @property {string} [homepage]    An https URL (platform 2). Required by the registry; the only URL SKILL.md may contain.
 * @property {number} [platform]    The platform version the manifest needs (platform 2). Required by the registry.
 * @property {AddonKind} kind
 * @property {Object<string, AddonCollection>} collections
 * @property {string} [skill]       Relative path to a markdown file of agent instructions.
 * @property {string} [brief_line]  `{{<collection>.count}}` is the only substitution. It counts every
 *   record the person has in that collection, with no filter.
 * @property {AddonView[]} [views]
 * @property {'personal'} [default_visibility]
 */

/**
 * @typedef {Object} AddonRecord
 * @property {string} id
 * @property {Object} data
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} AddonListOptions
 * @property {Object<string, *>} [where]  Flat map of top-level data fields to a value, or an array of values (any-of).
 * @property {number} [limit]
 * @property {string} [cursor]
 * @property {'created_at' | '-created_at' | 'updated_at' | '-updated_at'} [order]
 */

/**
 * @typedef {Object} AddonRecordsApi  Every call is scoped to the calling person and workspace.
 * @property {(collection: string, options?: AddonListOptions) => Promise<{rows: AddonRecord[], next_cursor: string|null}>} list
 * @property {(collection: string, id: string) => Promise<AddonRecord|null>} get
 * @property {(collection: string, data: Object) => Promise<AddonRecord>} create
 * @property {(collection: string, id: string, patch: Object) => Promise<AddonRecord|null>} update
 * @property {(collection: string, id: string) => Promise<boolean>} remove
 * @property {(collection: string, where?: Object<string, *>) => Promise<number>} count
 */

/**
 * @typedef {Object} AddonAttachmentRow
 * @property {string} id
 * @property {string} mime
 * @property {number} bytes
 * @property {number|null} width
 * @property {number|null} height
 */

/**
 * @typedef {Object} AddonAttachmentsApi
 * @property {(collection: string, recordId: string) => Promise<AddonAttachmentRow[]>} listFor
 * @property {(attachmentId: string, variant: AttachmentVariant) => Promise<Buffer>} read
 * @property {(attachmentId: string, variant: AttachmentVariant, ttlSeconds?: number) => Promise<string>} signedUrl
 * @property {(options: {collection: string, ttlSeconds?: number}) => Promise<{url: string, expires_at: string}>} createUploadLink
 * @property {(options: {collection: string, recordId?: string, buffer: Buffer, filename?: string}) => Promise<AddonAttachmentRow>} ingest
 */

/**
 * @typedef {Object} AddonContext
 * @property {Object} actor
 * @property {string} ownerKey
 * @property {string} personId
 * @property {string} addonId
 * @property {AddonTransport} transport
 * @property {AddonRecordsApi} records
 * @property {AddonAttachmentsApi} attachments
 * @property {{describeImage: (buffer: Buffer, prompt?: string) => Promise<string>} | null} llm
 * @property {(message: string, fields?: Object) => void} log
 */

/**
 * @typedef {Object} AddonResult
 * @property {string} text
 * @property {Object} [data]
 * @property {{mime: string, base64: string}[]} [images]
 */

/**
 * @typedef {Object} AddonAction
 * @property {'read' | 'write'} mode
 * @property {string} description
 * @property {Object} input   JSON Schema for the action's args.
 * @property {(ctx: AddonContext, args: Object) => Promise<AddonResult>} handler
 */

const ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
const COLLECTION_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const VIEW_ID_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const TOP_LEVEL_KEYS = new Set(Object.keys(manifestSchema.properties));
const VIEW_TYPES = new Set(['gallery', 'table', 'detail']);
const PLACEHOLDER = /\{\{\s*([^}]*?)\s*\}\}/g;
const LICENSE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;

/** An https URL with a host and no credentials, at most 300 characters. */
function isHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 300 || !value.startsWith('https://')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch (_) {
    return false;
  }
}

/** Built-in action names an add-on may not define itself. */
const RESERVED_ACTIONS = Object.freeze(['help']);
/** The generic actions every declarative add-on gets for each collection. */
const GENERIC_ACTIONS = Object.freeze(['list', 'get', 'create', 'update', 'remove', 'count']);

/** A path inside the add-on directory: relative, no `..`, no drive letters. */
function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[\\/]+/).some((part) => part === '..');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate an addon.json object. Never throws.
 * @param {*} manifest
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateManifest(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) return { ok: false, errors: ['manifest must be a JSON object'] };

  for (const key of Object.keys(manifest)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`unknown field "${key}"`);
  }
  for (const key of manifestSchema.required) {
    if (manifest[key] === undefined) errors.push(`"${key}" is required`);
  }

  if (manifest.id !== undefined && !(typeof manifest.id === 'string' && ID_PATTERN.test(manifest.id))) {
    errors.push('"id" must be 2-40 characters: lowercase letters, digits and hyphens, starting with a letter');
  }
  if (manifest.name !== undefined && !(typeof manifest.name === 'string' && manifest.name.trim() && manifest.name.length <= 60)) {
    errors.push('"name" must be a non-empty string of at most 60 characters');
  }
  if (manifest.version !== undefined && !(typeof manifest.version === 'string' && VERSION_PATTERN.test(manifest.version))) {
    errors.push('"version" must be a semantic version such as 0.1.0');
  }
  if (manifest.description !== undefined && !(typeof manifest.description === 'string' && manifest.description.length <= 500)) {
    errors.push('"description" must be a string of at most 500 characters');
  }
  if (manifest.kind !== undefined && !['declarative', 'server'].includes(manifest.kind)) {
    errors.push('"kind" must be "declarative" or "server"');
  }
  if (manifest.license !== undefined && !(typeof manifest.license === 'string' && LICENSE_PATTERN.test(manifest.license))) {
    errors.push('"license" must be one SPDX licence id, such as MIT');
  }
  if (manifest.author !== undefined && !(typeof manifest.author === 'string' && manifest.author.trim() && manifest.author.length <= 100)) {
    errors.push('"author" must be a non-empty string of at most 100 characters');
  }
  if (manifest.homepage !== undefined && !isHttpsUrl(manifest.homepage)) {
    errors.push('"homepage" must be an https URL of at most 300 characters, with no user name or password');
  }
  if (manifest.platform !== undefined && !(Number.isInteger(manifest.platform) && manifest.platform >= 1 && manifest.platform <= 1000)) {
    errors.push('"platform" must be a whole number, 1 or more');
  }

  const collectionNames = new Set();
  if (manifest.collections !== undefined) {
    if (!isPlainObject(manifest.collections) || !Object.keys(manifest.collections).length) {
      errors.push('"collections" must be an object with at least one collection');
    } else {
      for (const [name, def] of Object.entries(manifest.collections)) {
        if (!COLLECTION_PATTERN.test(name)) {
          errors.push(`collection "${name}": name must be lowercase letters, digits and underscores, starting with a letter`);
          continue;
        }
        collectionNames.add(name);
        if (!isPlainObject(def)) { errors.push(`collection "${name}" must be an object`); continue; }
        for (const key of Object.keys(def)) {
          if (!['schema', 'attachments'].includes(key)) errors.push(`collection "${name}": unknown field "${key}"`);
        }
        if (!isSafeRelativePath(def.schema)) errors.push(`collection "${name}": "schema" must be a relative path inside the add-on`);
        if (def.attachments !== undefined && typeof def.attachments !== 'boolean') {
          errors.push(`collection "${name}": "attachments" must be true or false`);
        }
      }
    }
  }

  if (manifest.skill !== undefined && !isSafeRelativePath(manifest.skill)) {
    errors.push('"skill" must be a relative path inside the add-on');
  }

  if (manifest.brief_line !== undefined) {
    if (typeof manifest.brief_line !== 'string' || manifest.brief_line.length > 160) {
      errors.push('"brief_line" must be a string of at most 160 characters');
    } else {
      for (const match of manifest.brief_line.matchAll(PLACEHOLDER)) {
        const [collection, field, extra] = match[1].split('.');
        if (field !== 'count' || extra !== undefined || !collectionNames.has(collection)) {
          errors.push(`"brief_line": {{${match[1]}}} is not allowed; the only substitution is {{<collection>.count}}`);
        }
      }
    }
  }

  if (manifest.views !== undefined) {
    if (!Array.isArray(manifest.views)) {
      errors.push('"views" must be an array');
    } else {
      const seen = new Set();
      manifest.views.forEach((view, i) => {
        if (!isPlainObject(view)) { errors.push(`views[${i}] must be an object`); return; }
        if (!(typeof view.id === 'string' && VIEW_ID_PATTERN.test(view.id))) errors.push(`views[${i}]: "id" is missing or malformed`);
        else if (seen.has(view.id)) errors.push(`views[${i}]: duplicate id "${view.id}"`);
        else seen.add(view.id);
        if (!VIEW_TYPES.has(view.type)) errors.push(`views[${i}]: "type" must be gallery, table or detail`);
        if (!collectionNames.has(view.collection)) errors.push(`views[${i}]: "collection" must name a declared collection`);
        if (view.fields !== undefined && !(Array.isArray(view.fields) && view.fields.every((f) => typeof f === 'string'))) {
          errors.push(`views[${i}]: "fields" must be an array of strings`);
        }
        if (view.title !== undefined && typeof view.title !== 'string') errors.push(`views[${i}]: "title" must be a string`);
        if (view.title_field !== undefined && typeof view.title_field !== 'string') errors.push(`views[${i}]: "title_field" must be a string`);
      });
    }
  }

  if (manifest.default_visibility !== undefined && manifest.default_visibility !== 'personal') {
    errors.push('"default_visibility" must be "personal" (the only visibility add-on data has in v1)');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a server add-on's exported `actions` map. Never throws.
 * @param {*} actions
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateActions(actions) {
  const errors = [];
  if (!isPlainObject(actions)) return { ok: false, errors: ['index.js must export { actions } as an object'] };
  for (const [name, def] of Object.entries(actions)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name)) errors.push(`action "${name}": malformed name`);
    if (RESERVED_ACTIONS.includes(name)) errors.push(`action "${name}" is reserved by the platform`);
    if (!isPlainObject(def)) { errors.push(`action "${name}" must be an object`); continue; }
    if (!['read', 'write'].includes(def.mode)) errors.push(`action "${name}": "mode" must be "read" or "write"`);
    if (typeof def.description !== 'string' || !def.description.trim()) errors.push(`action "${name}": "description" is required`);
    if (def.input !== undefined && !isPlainObject(def.input)) errors.push(`action "${name}": "input" must be a JSON Schema object`);
    if (typeof def.handler !== 'function') errors.push(`action "${name}": "handler" must be a function`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Render a manifest's brief_line. `counts` maps collection name to a number.
 * Unknown placeholders render as empty text (validateManifest rejects them).
 */
function renderBriefLine(template, counts = {}) {
  if (typeof template !== 'string' || !template) return '';
  return template.replace(PLACEHOLDER, (_, expr) => {
    const [collection, field] = String(expr).split('.');
    if (field !== 'count') return '';
    const n = Number(counts[collection]);
    return String(Number.isFinite(n) ? n : 0);
  }).replace(/\s+/g, ' ').trim();
}

/** The collections a brief_line template reads counts for. */
function briefLineCollections(template) {
  if (typeof template !== 'string') return [];
  const names = new Set();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const [collection, field] = match[1].split('.');
    if (field === 'count' && collection) names.add(collection);
  }
  return [...names];
}

// The authoring tools, loaded on first use (see the top of this file).
/** Validate an add-on directory. See src/validate.js. */
function validatePackage(dir, options) { return require('./validate').validatePackage(dir, options); }
/** Validate a package already in memory ({ path: text|Buffer }). See src/validate.js. */
function validatePackageFiles(files, options) { return require('./validate').validatePackageFiles(files, options); }
/** Validate and pack an add-on directory into the server's tarball format. See src/validate.js. */
function pack(dir, options) { return require('./validate').pack(dir, options); }
/** Pack a { path: contents } map without validating it. See src/archive.js. */
function packFiles(files, options) { return require('./archive').packFiles(files, options); }
/** Does a minor or patch version only widen the previous version's schemas? See src/widening.js. */
function schemaWidening(oldFiles, newFiles) { return require('./widening').schemaWidening(oldFiles, newFiles); }

module.exports = {
  manifestSchema,
  validateManifest,
  validateActions,
  renderBriefLine,
  briefLineCollections,
  isSafeRelativePath,
  isHttpsUrl,
  validatePackage,
  validatePackageFiles,
  pack,
  packFiles,
  schemaWidening,
  RESERVED_ACTIONS,
  GENERIC_ACTIONS,
  PLATFORM,
};
