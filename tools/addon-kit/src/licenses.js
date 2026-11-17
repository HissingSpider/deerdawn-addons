'use strict';

// VENDORED from DeerDawn packages/addon-kit 0.2.0 (MIT), source commit
// 16920c7891a928d0ad8562c2b015d0401899ca44. Do not edit here: change it in DeerDawn and copy it
// again. Goes away once @deerdawn/addon-kit is on npm (tools/README.md).

// OSI-APPROVED LICENCES THE REGISTRY ACCEPTS, BY SPDX ID.
//
// The registry requires every listing to carry an OSI-approved licence
// (decision 8, 2026-11-16). This is a short embedded list of the common ones,
// not the full OSI catalogue: a licence that is OSI-approved but missing here
// is refused until somebody adds it, which is the safe direction. Ids are the
// current SPDX spellings; the deprecated bare "GPL-3.0" style is refused with a
// hint, because it does not say "only" or "or later".

const OSI_LICENSES = Object.freeze([
  '0BSD',
  'AFL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'Apache-2.0',
  'Artistic-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CDDL-1.0',
  'CECILL-2.1',
  'ECL-2.0',
  'EPL-2.0',
  'EUPL-1.2',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'ISC',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'LPPL-1.3c',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'MS-PL',
  'MulanPSL-2.0',
  'NCSA',
  'OSL-3.0',
  'PostgreSQL',
  'UPL-1.0',
  'Unlicense',
  'Zlib',
]);

const BY_LOWER = new Map(OSI_LICENSES.map((id) => [id.toLowerCase(), id]));

/**
 * @param {*} id
 * @returns {{ok: boolean, message?: string}}
 */
function checkOsiLicense(id) {
  if (typeof id !== 'string' || !id.trim()) return { ok: false, message: '"license" is required: an SPDX id such as MIT or Apache-2.0' };
  if (OSI_LICENSES.includes(id)) return { ok: true };
  const exact = BY_LOWER.get(id.toLowerCase());
  if (exact) return { ok: false, message: `"license": write the SPDX id exactly, "${exact}"` };
  if (/^(A|L)?GPL-\d\.\d\+?$/i.test(id)) {
    return { ok: false, message: `"license": "${id}" is a deprecated SPDX id; use the "-only" or "-or-later" form` };
  }
  if (/\s(OR|AND|WITH)\s/.test(id)) return { ok: false, message: '"license": give one SPDX id, not an expression' };
  return { ok: false, message: `"license": "${id}" is not on the registry's list of OSI-approved licences (${OSI_LICENSES.length} common ones; ask for one to be added)` };
}

module.exports = { OSI_LICENSES, checkOsiLicense };
