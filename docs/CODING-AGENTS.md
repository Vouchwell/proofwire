# Coding agents: record and gate Claude Code, Codex and Cursor

`vw proxy` sees the MCP servers an agent calls. A coding agent does most of its
work without them: it runs shell commands, reads and edits files, and fetches
pages with tools built into the agent. `vw hook` covers those. Claude Code,
OpenAI's Codex CLI and Cursor each run a command before and after every tool
call (their hooks), and `vw hook` is that command.

| Agent | Set up | Can ask a person? |
|---|---|---|
| Claude Code | the plugin (below), or `vw hook install` | yes |
| Codex CLI | `vw hook install --client codex` | no: an escalation is refused, with the reason |
| Cursor | `vw hook install --client cursor` | yes |

## The Claude Code plugin

The plugin needs no global install and no settings to edit. In Claude Code:

```
/plugin marketplace add Vouchwell/vouchwell
/plugin install vouchwell@vouchwell
```

When the next session starts, the plugin installs the `vouchwell` npm package
of its own version into its data folder. It is a fixed, registry-verified build,
not whatever `vw` is on your PATH. From then on, every tool call goes through
`vw hook`:

- **Where receipts go.** A project with its own `vouchwell.config.json` keeps
  full control: its log, policy and monitor setting. Every other project is
  recorded in one log for you, `~/.vouchwell/claude-code`. That folder is
  outside every repository, so a signing key can't be committed by accident.
  It is also outside the plugin's own folder, so uninstalling the plugin never
  deletes an audit trail.
- **What it enforces.** The bundled policy is the `coding-agent` and
  `shell-safety` templates.
- **Options** (in `/plugin`, select Vouchwell):
  - `mode`: `enforce` (the default), `monitor` (record everything, block
    nothing) or `off`;
  - `log_dir`: where the log is kept;
  - `policy`: a policy file to use instead of the bundled one.
- **Fails closed when enforcing.** If the CLI isn't installed yet, for
  example with no network at session start, calls are refused with a reason
  telling you to restart or switch to `monitor`.
- **Asking about the log.** The plugin runs `vw mcp` as an MCP server, so
  Claude Code has native tools: `log_entries`, `verify_log`, `log_stats`,
  `check_bundle` and `export_evidence`. None can change the log. Its skill
  uses them for questions like "what did you do?", "prove the log is intact"
  and "export the evidence".

## The CLI, per project

```bash
npm install -g vouchwell
vw policy template coding-agent shell-safety secrets --out vouchwell.policy.json
vw hook install            # this project: .claude/settings.json
```

The hooks load when a Claude Code session starts. From then on every tool call
is checked against `vouchwell.policy.json` and recorded in `.vouchwell/`. Use
`vw log` to see what the agent did and `vw verify` to prove nothing has been
removed.

## Codex CLI and Cursor

```bash
npm install -g vouchwell
vw policy template coding-agent shell-safety secrets --out vouchwell.policy.json
vw hook install --client codex     # this project: .codex/hooks.json  (--user: ~/.codex/hooks.json)
vw hook install --client cursor    # this project: .cursor/hooks.json (--user: ~/.cursor/hooks.json)
```

Both work like Claude Code, with differences that come from each agent:

- **Codex** sends the same events and fields as Claude Code. A Codex hook
  cannot answer "ask the user", so a call the policy escalates is refused
  instead, and the reason says a person is needed. Codex has no
  failure or permission-denied events: a call that never reports back is
  closed as `not_run` when the session ends. Codex asks you to review and
  trust new hooks before it runs them. Receipts are named `codex.<tool>`
  (`codex.Bash`, `codex.apply_patch`, MCP tools by their names).
- **Cursor** hooks are wired to its general `preToolUse`, `postToolUse`,
  `postToolUseFailure` and `sessionEnd` events. Cursor also fires
  shell- and MCP-specific events for the same call, which are deliberately
  not wired, so nothing is recorded twice. Cursor lets a call through when a
  hook crashes unless told otherwise, so the installed `preToolUse` hook is
  marked `failClosed` (except with `--monitor`). Cursor may start hooks from
  outside the project, so `vw hook` works in the workspace root the event
  names. Receipts are named `cursor.<tool>`, and each Cursor conversation is
  a session. It needs a Cursor version with `preToolUse` and `postToolUse`.

Run each agent's hooks with its own `--client`. Without it, events are read
as Claude Code's.

## What happens to each call

| Claude Code event | What `vw hook` does |
|---|---|
| `PreToolUse` | The policy decides. **Allowed:** an `intent` receipt, written to disk before the tool runs. Claude Code's own permission prompts still apply as usual. **Refused:** one receipt, and Claude Code is told to deny the call, with the policy's reason. **Escalated:** Claude Code asks its user, who is the approver. |
| `PostToolUse` | An `outcome` receipt, linked to its intent by hash. For an escalated call, the intent is written now, recording that the person approved it. |
| `PostToolUseFailure` | The same, as an error: `tool_error`, or `interrupted`. |
| `PermissionDenied` | Claude Code's permission check refused the call: `permission_denied`. |
| `SessionEnd` | Calls that never reported back are closed as `not_run`, escalations nobody approved are recorded as declined, and the log is checkpointed. |

Tool names are recorded as `claude-code.<Tool>`, e.g. `claude-code.Bash` and
`claude-code.Edit`, so policy rules can match them. Each Claude Code session is
its own `actor.session` (`cc_<session id>`).

## The policy

Every template works here. These three are written for coding agents:

- **`coding-agent`** refuses reading or writing secret files (`.env`, private
  keys, credential files) and touching the agent's own audit log. A person must
  approve shell commands that name a secret file, and skipping git hooks
  (`--no-verify`).
- **`shell-safety`** refuses `rm -rf`, force-pushes, disk formatting and piping
  a download into a shell.
- **`secrets`** refuses any call whose arguments contain a credential.

Check a policy against what the agent has already done before it can block
anything:

```bash
vw hook install --monitor          # record what would be blocked, block nothing
# … a few days of normal work …
vw policy test                     # which past calls the policy would change
vw hook install                    # then enforce
```

## Settings

In `vouchwell.config.json`:

```json
{
  "hook": {
    "principal": "you@example.com",
    "previews": "params",
    "monitor": false,
    "evidence": "evidence"
  }
}
```

- **`previews`** sets how much of each call is copied into its receipt, beside
  the commitment that proves what it was:
  - `"params"` (the default) copies the tool's arguments, with secrets masked;
  - `"all"` also copies its output;
  - `"none"` keeps only the commitments.

  Use `"none"` for a log you will publish: it shows which tools ran, when, and
  what the policy decided, and none of what they touched.
- **`principal`** is who the agent works for. Defaults to `actor.principal`.
- **`monitor`**: `true` records what the policy would block without blocking
  it. `--enforce` on the command overrides it.
- **`evidence`**: a folder. At the end of every session the log is written
  there as `<log id>.json`, a checkpointed bundle, so publishing it is just
  committing that file. Leave it out to write bundles only when you run
  `vw hook evidence`.

`vw hook install` flags:
- `--user` writes to `~/.claude/settings.json`, so the hooks apply in every project.
- `--local` writes to `.claude/settings.local.json`, which is not shared.
- `--command` sets the exact command Claude Code runs.

`vw hook uninstall` removes only the entries `vw hook install` added.

## To publish the log

```bash
vw hook evidence            # checkpoint, then write evidence/<log id>.json
vw keys                     # this log's signing key, to publish
vw check evidence/<log id>.json --log-key <kid>=<publicKey>   # what anyone can run against it
```

To check it on every push, use the [GitHub Action](../verify/README.md) with the
key pinned in `evidence/log-keys.json`.

The bundle holds no payloads and no salts.

## Guarantees and limits

- **When enforcing, a call that cannot be recorded is refused.** If the log
  cannot be written, the call is denied and Claude Code shows why. This is
  deliberate: a gate that opens whenever the log breaks is not a gate. To turn
  recording off, start Claude Code with `VOUCHWELL_HOOK=off`. The agent's own
  shell cannot set this: hooks get the environment Claude Code started with.
- **Parallel tool calls keep one chain.** Claude Code runs the hooks of
  parallel calls at the same time. Each takes a lock on the log first, so the
  chain never forks.
- **A large log does not slow the agent down.** A hook call reads only what
  it needs:
  - where the last call left off, from `append-state.json` beside the log;
  - the receipts inside the policy's longest budget or rate-limit window.

  On a 5,000-receipt log a call takes about 100 ms, the same as on an empty
  one. Reading the whole log took 0.5 s. The state file is rebuilt from the
  entries whenever it disagrees with them, and `vw verify` never uses it.
- **A hook sees what the agent reports, and nothing else.** A tool that runs
  outside the agent's tool calls is not recorded: Codex hooks cover its
  shell, `apply_patch` and MCP tools, and some actions in each agent fire no
  hook at all. A subprocess started by a
  recorded shell command is recorded only as that command.
- **A pattern list is not a sandbox.** A shell can reach a file by another
  name. What the policy does guarantee is a signed record of every attempt it
  saw, including the refused ones.
