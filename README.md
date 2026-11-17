# DeerDawn add-ons registry

The public list of add-ons for [DeerDawn](https://deerdawn.com). A DeerDawn
server reads `index.json` from this repo's GitHub Pages site, checks its
signature, and offers the add-ons it names.

The site is generated: on every merge to `main`, CI packs each add-on version
into a tarball, writes `index.json`, signs it, and publishes the lot to Pages.
Nothing under the published site is committed here.

## Layout

```
addons/<id>/<version>/   addon.json, SKILL.md, schemas/*.json (one folder per version, never edited after merge)
addons/<id>/LISTING.md   the long description shown on the listing page
addons/<id>/OWNER        the GitHub login that owns the id (set by the first listing)
reserved-ids.json        ids no listing may take
revoked.json             versions or whole add-ons pulled from the registry
tiers.json               which ids are "official" (set by the maintainers)
keys/                    public keys the index is signed with
tools/                   the registry CI scripts (MIT)
```

## What can be listed

Declarative add-ons only: JSON schemas and markdown, no code. Every listing
needs an OSI-approved licence in its `addon.json`. Each add-on keeps its
author's licence; the tooling in this repo is MIT (see `LICENSE`).

## Submitting an add-on

1. Write the add-on: `addon.json`, `SKILL.md` and one JSON Schema per
   collection. `addons/reading-list/1.0.0/` is a complete example. The
   manifest needs `license` (an OSI-approved SPDX id such as `MIT`), `author`,
   `homepage` (https) and `"platform": 2`.
2. Fork this repo and add:
   - `addons/<id>/<version>/` with the add-on's files;
   - `addons/<id>/LISTING.md`, a plain description for the listing page (no
     HTML, no images);
   - `addons/<id>/OWNER` holding your GitHub login, on the first listing of
     an id. From then on only you can publish versions of it.
3. Check it locally (Node 20 or later):
   ```sh
   cd tools && npm ci && cd ..
   node tools/check.js --author <your GitHub login>
   ```
   This compares your branch with `origin/main` and runs the same checks as CI
   on the pull request. `node tools/check.js --all` checks every listing
   without git history.
4. Open a pull request. CI runs the checks; a maintainer reviews every
   version that changes `SKILL.md` or `brief_line`, because that text reaches
   people's agents.

What the checks refuse, in short:

- anything but `.json` and `.md` files, symlinks, more than 64 files, a file
  over 64KB, or a package over 256KB;
- a collection schema that fails Ajv's secure meta-schema, uses `pattern` or
  `patternProperties`, refers outside itself with `$ref`, or is too deep or
  too large;
- a `SKILL.md` over 8KB, that names any tool other than `read_addon` and
  `use_addon`, addresses another add-on, names an action a declarative add-on
  does not have, mentions other projects, or holds a URL other than the
  manifest's `homepage`;
- a `brief_line` that is not plain words, numbers, punctuation and
  `{{collection.count}}`, or is longer than 160 characters;
- a reserved id, or an id somebody else owns;
- any change to a version that is already published (publish a new version);
- a version that is not greater than the latest one, or a minor or patch
  version whose schemas do not only widen the previous version's (new
  optional fields, more enum values and looser limits are fine; new required
  fields, removed fields or collections and tighter limits need a major
  version).

## Updates and revocation

Versions are immutable: a fix is a new version. Servers pin the version a
workspace installed and offer updates; they never rewrite anybody's records.
A version or add-on in `revoked.json` stops working on every server that
reads the index, and its data is kept for its users to export.

## Signing

`index.json` is signed with Ed25519. The signature (`index.json.sig`, base64)
covers the exact bytes of `index.json`, and the index carries each package's
sha256, so one signature vouches for every package. The current key id is
`registry-2026`; its public key is `keys/registry-2026.pub.pem`.
