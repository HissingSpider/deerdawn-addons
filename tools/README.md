# tools

The registry's CI scripts. MIT, so anyone can run a registry of their own
with them. Node 20 or later; `npm ci` here installs their one dependency
(Ajv).

| File | What it does |
|---|---|
| `check.js` | Checks a pull request (or `--all`, the whole tree) against the registry's rules. |
| `build.js` | Packs every version, writes `index.json`, signs it, and writes the site to `_site/`. |
| `lib.js` | Shared helpers. |
| `addon-kit/` | A vendored copy of DeerDawn's `@deerdawn/addon-kit` 0.2.0: the validator, the tarball writer and the schema-widening check. Not edited here (the source commit is in each file's header). Once the kit is on npm, `package.json` depends on it and this folder goes. |
| `tests/` | `npm test`. They build with a throwaway key pair; no real key is ever read. |

```sh
node tools/check.js --author <login>      # this branch against origin/main
node tools/check.js --base <ref> --author <login> --repo <dir>
node tools/check.js --all                 # every listing, no history
REGISTRY_SIGNING_KEY="$(cat key.pem)" node tools/build.js --out _site
node tools/build.js --unsigned --out /tmp/site   # a local preview, no signature
node tools/addon-kit/bin/addon-kit.js validate addons/<id>/<version>
```

`build.js` output is a function of the git checkout: `generated_at` is the
HEAD commit's time and each version's `published_at` is the time of the commit
that added it, so rebuilding a commit gives the same bytes.
