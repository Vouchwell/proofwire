# Vouchwell verify — GitHub Action

Fail the build when a Vouchwell evidence bundle has been altered. Commit your
agent's log as a bundle (`vw export`, or `vw hook evidence` for Claude Code),
and every push checks it, with the result in the job summary.

```yaml
# .github/workflows/evidence.yml
name: Evidence
on: [push, pull_request]
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Vouchwell/vouchwell/verify@v0.7.0   # better: the release's full commit SHA
        with:
          log-keys: evidence/log-keys.json
```

It runs the verifier from the action's own source at the ref you pin. It
installs nothing, downloads nothing and needs no token. Node 20.11 or later
must be on the runner, as it is on GitHub-hosted ones.

## Pin your log key

A bundle on its own proves that *someone* signed a consistent history. Anyone
can make one of those with a fresh key. Pinning says it was *your* log:

```bash
vw keys                      # prints this log's kid and public key
```

Put it in a file next to the bundles, so a new key arrives as a reviewed change:

```json
[ { "kid": "pw1…", "publicKey": "7S5Z…" } ]
```

or inline, as `log-key: pw1…=7S5Z…`. With a key pinned, a bundle signed by
any other key fails. Without one, the action passes and warns, naming the key
to pin.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `bundles` | `evidence/*.json` | Glob patterns, space or newline separated. `*` and `?` match within a folder, `**` across folders. Files named by `log-keys` or `witness-keys` are skipped. |
| `log-key` | | `kid=publicKey`, comma-separated for several. |
| `log-keys` | | JSON file: `{ "kid": "publicKey" }` or a list of `{ kid, publicKey }`. |
| `witnesses` | `0` | Trusted witness signatures required on a checkpoint covering each bundle. |
| `witness-key` / `witness-keys` | | The witnesses you trust, in the same forms. Required when `witnesses` is above 0: a bundle cannot vouch for its own witnesses. Entries with `revokedAt` are skipped. |
| `allow-empty` | `false` | Pass when nothing matches. Off, so a renamed folder cannot silently turn the check off. |

Outputs: `verified` and `failed`, the number of bundles in each state.

## What a failure means

Each problem is annotated on the bundle file, for example *"entry 12: signature
does not verify"* or *"bundle is marked complete but holds 40 of 41 entries"*.
The bundle no longer matches what was signed. Check what changed it in git
history: an edit, a truncation, or an export from a different log.

The same check runs locally: `vw check <bundle> --log-key kid=publicKey`.
