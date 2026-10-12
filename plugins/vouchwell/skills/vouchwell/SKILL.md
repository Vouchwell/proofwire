---
name: vouchwell
description: Show, verify or export the Vouchwell record of what Claude Code did in this project. Use when the user asks what you did, wants proof or an audit trail of tool calls, asks why a call was refused by Vouchwell, or wants an evidence bundle to share.
---

# Vouchwell: the record of this agent's tool calls

The Vouchwell plugin records every tool call in this session as a signed,
hash-chained receipt, and its policy can refuse a call or ask the user first.
A refusal reason that starts with "Vouchwell" or names a rule such as
`coding-agent.secret-files` came from that policy, not from Claude Code.

Run these commands exactly as written. They only read the log or write a copy
of it. Never open, edit, move or delete the log files directly: the policy
refuses it, and an edited log stops verifying.

```bash
VW='node "${CLAUDE_PLUGIN_ROOT}/scripts/vouchwell.mjs" --data "${CLAUDE_PLUGIN_DATA}"'
```

| The user wants | Run |
| :- | :- |
| What was done recently | `$VW log --tail 30` |
| Only what the policy refused | `$VW log --denied` |
| What monitor mode would have blocked | `$VW log --would-block` |
| Calls that started and never finished | `$VW log --unfinished` |
| Totals and busiest tools | `$VW stats` |
| Proof the log is intact | `$VW verify` |
| A bundle to give someone else | `$VW evidence <folder>` |
| Check a bundle someone gave them | `$VW check <file>` |
| An auditor's report (AI Act, SOC 2) | `$VW report --out <file>` |
| The public key to publish for verifiers | `$VW keys` |

When you report results:

- Say plainly whether `verify` passed. A failure is evidence of tampering or
  damage; never offer to "repair" the log.
- Evidence bundles include each call's arguments as a preview (commands, file
  paths). Tell the user before they share one outside their team. A project
  can keep commitments only by setting `"hook": { "previews": "none" }` in its
  `vouchwell.config.json`.
- A bundle proves order, count and integrity. Whose key signed it rests on
  the user publishing `$VW keys` somewhere a verifier trusts.

To change how the plugin behaves (enforce, monitor or off; the log folder; the
policy file), the user opens `/plugin`, selects Vouchwell, and edits its
options. A project with its own `vouchwell.config.json` uses that instead.
