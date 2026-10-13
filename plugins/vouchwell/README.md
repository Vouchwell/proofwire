# Vouchwell for Claude Code

Every tool call Claude Code makes leaves a signed, hash-chained receipt:
shell commands, file reads and edits, web fetches, MCP tools. Before a call
runs, a policy can refuse it or ask you first. Anyone can check the record
offline, and an edited, reordered or truncated log stops verifying.

## Install

```
/plugin marketplace add Vouchwell/vouchwell
/plugin install vouchwell@vouchwell
```

Start a new session. Nothing else to install or configure.

## What it does

- **Records** every tool call: one receipt when it is about to run, one when
  it finishes, fails or is refused. A call that started and never finished
  shows up as unfinished.
- **Gates** calls with a bundled policy (the `coding-agent` and
  `shell-safety` templates):
  - refuses reading or writing secret files (`.env`, private keys,
    credentials), touching its own audit log, and destructive shell commands;
  - asks you first before deleting or moving files, before a shell command
    that names a secret file, and before skipping git hooks (`--no-verify`).
- **Answers "what did you do?"** with five read-only MCP tools: `log_entries`,
  `verify_log`, `log_stats`, `check_bundle` and `export_evidence`, plus a skill
  that tells Claude when to use them.

## Options

Open `/plugin`, select Vouchwell and edit its options:

| Option | Default | |
| :- | :- | :- |
| Mode | `enforce` | `monitor` records and blocks nothing; `off` does nothing |
| Log folder | `~/.vouchwell/claude-code` | where receipts are kept |
| Policy file | bundled | your own policy, e.g. from `vw policy template` |

A project with its own `vouchwell.config.json` uses that instead.

## Where your data goes

Nowhere. Receipts and the signing key stay on your machine, in the log
folder. The plugin carries no copy of Vouchwell: on the first session it
runs `npm install vouchwell@<its own version>` (with `--ignore-scripts`) into
the plugin's data folder. That is its only network access. Nothing is sent
to Vouchwell or anyone else unless you configure an outside witness
yourself.

Requires Node.js 20.11 or later, with npm.

## Limits

A hook sees what Claude Code reports about a call. A pattern policy is a
guard rail, not a sandbox: a determined command can be written in a way no
pattern list foresees. The record is what makes such a call visible
afterwards.

## More

- Documentation: [docs/CODING-AGENTS.md](../../docs/CODING-AGENTS.md)
- Website: <https://vouchwell.axonscape.com>
- License: Apache-2.0
