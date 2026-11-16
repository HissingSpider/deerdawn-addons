# DeerDawn add-ons registry

The public list of add-ons for [DeerDawn](https://deerdawn.com). A DeerDawn
server reads `index.json` from this repo's GitHub Pages site, checks its
signature, and offers the add-ons it names.

**Status: not open for submissions yet.** This is the empty skeleton. The CI
that reviews, packs and signs listings comes next; until then the index is
empty and nothing can be installed from it.

## Layout

```
addons/<id>/<version>/   addon.json, SKILL.md, schemas/*.json (one folder per version, never edited after merge)
addons/<id>/LISTING.md   the long description shown on the listing page
reserved-ids.json        ids no listing may take
revoked.json             versions or whole add-ons pulled from the registry
index.json               the generated index (signed: index.json.sig)
keys/                    public keys the index is signed with
tools/                   the registry CI scripts (MIT)
```

## What can be listed

Declarative add-ons only: JSON schemas and markdown, no code. Every listing
needs an OSI-approved licence in its `addon.json`. Each add-on keeps its
author's licence; the tooling in this repo is MIT (see `LICENSE`).

## Signing

`index.json` is signed with Ed25519. The signature (`index.json.sig`, base64)
covers the exact bytes of `index.json`, and the index carries each package's
sha256, so one signature vouches for every package. The current key id is
`registry-2026`; its public key is `keys/registry-2026.pub.pem`.
