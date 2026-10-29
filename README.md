# claude-guardrails

ITERFORGE organization-wide security guardrails for **Claude Code**, delivered as a Claude Code plugin
marketplace with one mandatory plugin, `guardrails-core`.

Before Claude edits a file, runs a command or calls a tool, `guardrails-core` checks the call:

- **Policy rules** cover actions the standards forbid (schema auto-update, destructive migrations, direct DB
  changes, force push or push to a protected branch). For now they **ask** with a 🔴 dialog instead of
  blocking: the developer may accept. On Cancel Claude is told why, so it can propose the safe alternative.
  One switch in the code turns them back into hard blocks (see "Policy rules" below).
- **Risk acceptance** replaces the old "never read secrets" rule. Claude may **read** files, logs and command
  output that contain secrets or personal data. When an action **uses** them, the developer must accept the
  risk in a dialog first, even in auto mode. The dialog and the status line under the prompt are marked
  🔴 high or 🟡 medium.

At the start of each session the plugin shows a Responsible AI Use banner and gives Claude the team
engineering standards.

> Status: **pilot**.

---

## Rules

### Policy rules (🔴 dialog for now)

| # | Rule | Asks (examples) | No dialog (examples) |
|---|---|---|---|
| 3 | No ORM auto-schema | `ddl-auto` / `hbm2ddl.auto` set to `create`, `create-drop` or `update` | `validate`, `none` |
| 4 | No destructive changes in migration files | `DROP COLUMN/TABLE/SCHEMA`, `RENAME COLUMN`, `TRUNCATE`, column type changes, Liquibase `dropColumn`/`dropTable`/`renameColumn`/`modifyDataType` | `ADD COLUMN`, new tables, indexes |
| 5 | No direct DB changes from the terminal | `psql`/`mysql`/`sqlcmd`/`sqlplus`/`mongosh`/`pgcli` with `ALTER/DROP/DELETE/UPDATE/INSERT/TRUNCATE/GRANT/REVOKE`, or running a SQL script file | Read-only queries such as `select` |
| 6 | No force push, no push to `main` / `master` / `develop` | `--force`, `--force-with-lease`, `-f`, `+ref`, `--mirror`, `--all`; pushing to a protected branch by name, by `HEAD`, or by a plain `git push` while on it (also after `cd X &&`, `git -C X`, `Set-Location X;`, `bash -c "..."`); a plain push where the branch cannot be determined | Pushing a named feature branch, e.g. `git push origin feature/GPC-123` |

A hit shows the 🔴 dialog *"POLICY RISK ACCEPTANCE REQUIRED"* with the command and the rule it breaks.
Cancel (the first option), Esc or no one to ask denies the call: Claude gets
`ACTION BLOCKED - PROHIBITED BY ITERFORGE SECURITY POLICY. ...` with the reason. Accept runs it, and the
audit log records `POLICY ... -> RISK ACCEPTED`.

To make these rules hard blocks again (deny, no dialog), set `HARD_BLOCK_POLICY = true` at the top of
`plugins/guardrails-core/hooks/register.ts` and change the test that checks the switch.

### Secrets and personal data: read freely, ask before use

| # | Rule | No dialog (examples) | Dialog (examples) |
|---|---|---|---|
| 1 | Secret files (`.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `secrets/**`, `credentials`, `id_rsa`) | Read, Grep, `cat .env`, `cat .env \| cut -d= -f1`, `Get-Content .env \| ForEach-Object {...}` | `source .env && curl ...`, `$(grep TOKEN .env)`, `docker run --env-file .env`, `cp .env x`, `sed -i ... .env`, `cat .env > x`, editing `.env` |
| 2 | Secrets in commands, requests and code | `password: ${DB_PASSWORD}`, `System.getenv("DB_PASSWORD")`, `this.password = dbPassword` | A token, key or password typed into a command, URL or file; `$API_TOKEN`, `${DB_PASSWORD}`, `$env:AWS_SECRET_ACCESS_KEY` in a command; a secret Claude saw earlier (in a file or output) used again |
| - | Personal data (email, US SSN) | Reading a log that contains emails | Sending a seen email out (`curl`, `git push`, web/MCP calls) |

Risk levels:

| Level | When | Examples |
|---|---|---|
| 🔴 **High** | A secret leaves the machine, or is hardcoded into a command or a file | `curl -H "Authorization: Bearer $API_TOKEN" ...`; writing `password = "..."` into code |
| 🟡 **Medium** | A secret is used only locally, a secret file is changed, or personal data is sent out | `docker run --env-file .env`; `cp .env .env.backup`; posting a customer email |

The dialog (`🔴 HIGH` / `🟡 MEDIUM`) shows the command, what sensitive data it uses, and
*"If you continue, YOU accept responsibility for this risk."* **Cancel** is the first option, so a quick
Enter never accepts a risk. Cancel, Esc or no one to ask (`claude -p`, CI) denies the call, and Claude is
told not to retry another way. While the dialog is open, the status line under the prompt shows the same
🔴/🟡 circle; it clears once the developer answers.

Sensitive values are never shown in the dialog, the status line or the audit log: values Claude saw earlier
are masked as `****`.

---

## How it works

```
Claude wants to run any tool (Edit / Write / Read / Bash / PowerShell / WebFetch / MCP ...)
        │
        ▼
tool.call hook in hooks/register.ts (runs inside Claude Code, no Node.js needed)
        ├─ rules 3-6 hit             →  🔴 policy dialog: Cancel → deny + policy message;  Accept → runs
        ├─ uses a secret / sends PII  →  🔴/🟡 dialog: Cancel → deny;  Accept → the tool runs
        └─ otherwise                  →  the tool runs (normal Claude Code permission checks apply)
        │
        ▼
after the tool ran: secrets and PII in its output are remembered (masked), so a later use is caught

Session start  →  banner in the transcript (session.start); standards for Claude come from the org policy claudeMd
```

If the check itself fails before the tool runs, the call is paused (fails closed).

Audit lines (`PASS`, `BLOCK`, `USE ... -> RISK ACCEPTED / CANCELLED`, `SEEN`) go to the Claude Code debug
log. Start Claude with `--debug-file <path>` to keep them.

## Repository layout

```
.claude-plugin/marketplace.json                 Marketplace catalogue (lists guardrails-core)
plugins/guardrails-core/
  .claude-plugin/plugin.json                    Plugin manifest (no "version" on purpose, see below)
  hooks/hooks.json                              Names the hooks module
  hooks/register.ts                             All rules, the risk dialog, learning, banner wiring
  hooks/standards.ts                            Banner text shown at session start
  tests/guard.test.ts                           Allow / block / ask cases and end-to-end dialog tests
policy/managed-settings.json                    Org console policy: permission rules + claudeMd (standards)
scripts/new-guard-test.ps1                      Creates the fake test project for DEVELOPER-SETUP
DEVELOPER-SETUP.md                              Try it on one machine
ADMIN-SETUP.md                                  Org-wide enforcement for admins
.github/workflows/guard-tests.yml               CI: validate + tests on Linux, Windows and macOS
.github/CODEOWNERS                              Required reviewers
```

No runtime dependencies.

---

## Requirements

- Claude Code 2.1.296 or newer (the hooks module needs a build with function hooks; tested on 2.1.312)
- Git (used by rule 6 to read the current branch)
- Node.js is **no longer needed** on developer machines. It is only used in CI to install the Claude Code CLI.

## Test

```bash
npm test     # claude plugin validate + claude plugin test; last lines: "<n> pass", "0 fail"
```

`tests/guard.test.ts` covers every case of the old Node guard (rules 1-2 now expect "pass" for reads and
"high" for written secrets), the secret-use cases from the risk-acceptance pilot, values seen earlier,
and end-to-end runs of the block, Cancel, Accept, Esc and fail-closed paths.

CI runs the same tests on Linux, Windows and macOS for every pull request and every push to `main`.

## Try it on one machine

```bash
claude plugin marketplace add mvakeel-vs/claude-guardrails
claude plugin install guardrails-core@claude-guardrails
```

Restart Claude Code. Check with `claude plugin list`, `/plugin` and `/hooks`; the banner appears at
session start. Remove with:

```bash
claude plugin uninstall guardrails-core@claude-guardrails
claude plugin marketplace remove claude-guardrails
```

The repository is private: the machine needs read access and a git login
(`gh auth login` and `gh auth setup-git`, or Git Credential Manager).

To work on the rules from a local clone, load it for one session only:

```bash
claude --plugin-dir plugins/guardrails-core --debug-file guard.log
```

## Organization rollout (summary)

Full guides: [DEVELOPER-SETUP.md](DEVELOPER-SETUP.md) (dry run on one machine) and
[ADMIN-SETUP.md](ADMIN-SETUP.md) (org-wide enforcement).

Enforced for everyone through the claude.ai admin settings, so developers cannot switch it off:

1. Move this repository into the company GitHub organization and enable branch protection on `main`.
2. Owner: *Organization settings > Plugins & skills > Sync from GitHub*, set `guardrails-core` to
   **Available to install** for the pilot group, then **Required** for everyone (covers Claude Code and Cowork).
3. Owner: *Admin Settings > Claude Code > Managed settings*: paste
   [`policy/managed-settings.json`](policy/managed-settings.json). It holds no bypass mode, the refresh
   requirement, the permission `deny` rules, and the `claudeMd` with the standards and sensitive-content
   rules. It replaces the old `claudeMd` ("stop the task / ACTION BLOCKED ... Rotate it now"), which
   contradicts "read freely, ask before use". Note: its `deny` rules hard-block force push, protected-branch
   pushes and SQL keywords even though the plugin only asks (ADMIN-SETUP Part 2).

Upgrading an org that already syncs the earlier Node.js version: see
[ADMIN-SETUP.md, Part 6](ADMIN-SETUP.md#part-6-upgrading-from-the-nodejs-version).

## Post-deployment checklist

Run on a few developer machines (Windows and Mac) after the plugin is set to **Required**:

| # | Check | Expected | Result |
|---|---|---|---|
| 1 | Start a Claude Code session | ITERFORGE banner appears (the synced hooks module runs) | |
| 2 | Ask Claude to read `.env` and list its variable names | Allowed, no dialog | |
| 3 | Ask Claude to read a log that contains an email and summarize it | Allowed, no dialog | |
| 4 | `use API_TOKEN from .env to call https://api.github.com/user with curl` | `🔴 HIGH` dialog + 🔴 status line; **Cancel** → not run | |
| 5 | `load .env and check API_TOKEN is not empty, don't send it anywhere` | `🟡 MEDIUM` dialog; Accept → runs | |
| 6 | Ask Claude to `git push --force` | 🔴 policy dialog; **Cancel** → `ACTION BLOCKED ...` | |
| 7 | Try to disable or uninstall `guardrails-core` in `/plugin` | Not possible | |
| 8 | Same checks in the VS Code / JetBrains extension, the desktop app and Cowork | Same dialogs and blocks | |
| 9 | Use a machine with no GitHub login | Plugin installs and works | |
| 10 | Merge a small rule change | Reaches laptops (note: automatic or after an Owner re-sync, and how long it takes) | |

Report every false alarm to the code owners with: the command or file, the block message or dialog, and why
the action was legitimate.

---

## Changing a rule

1. Branch, edit `plugins/guardrails-core/hooks/register.ts` (rules) or `hooks/standards.ts` (texts).
2. Add allow / block / ask cases to `plugins/guardrails-core/tests/guard.test.ts`; run `npm test`.
3. Open a pull request; CI must pass on all three operating systems; a code owner approves.
4. Merge. Machines pick up the change on the next plugin update (automatic with `autoUpdate`, or
   `claude plugin marketplace update claude-guardrails`), from the next session.

Do **not** add a `version` field to `plugin.json`: a fixed version stops machines from receiving updates.

While `guardrails-core` is active, Claude Code blocks edits to `register.ts` and `guard.test.ts` (they contain
the patterns rule 3 looks for). Edit them outside Claude Code, or disable the plugin for that session
(`claude plugin disable guardrails-core@<marketplace>`, then `/reload-plugins`) and enable it again after.

---

## Known limitations

This is a safety net for mistakes made by Claude, not a security boundary. It does not stop a person typing
commands themselves, and it does not replace infrastructure controls (no production credentials on laptops,
restricted database users, network isolation). Risk acceptance is the developer's consent, not a block:
an accepted risk runs. With hard blocks off (now), that includes the policy rules 3-6.

| Area | Behaviour |
|---|---|
| Audit trail | Accept / cancel decisions are written only to the debug log (`--debug-file`); there is no central record yet |
| Memory | Secret values seen in a session are kept in memory and forgotten when the plugin reloads; rules based on file and variable names still apply |
| Non-interactive runs | `claude -p`, CI and SDK runs cannot answer the dialog, so any secret use is denied |
| Reads | `awk` / `sed` without `-i` count as reads (they only print, like `cat`) |
| Rule 6 | `git commit -m push` while on `main` is blocked (any standalone `push` word is read as a push); `cd ~` / `cd $VAR` before a plain push fails closed |
| Rule 3 | Fires on any file or command that mentions the setting, including docs and `grep` searches; Spring's env-var form `SPRING_JPA_HIBERNATE_DDL_AUTO` is not caught |
| Rule 5 | A SQL command with `<` inside quotes may be treated as a script redirect and blocked |
| Surfaces | Pilot-verify the dialog in the IDE extensions, the desktop app and Cowork |

Report every false alarm (command or file, message, why it was legitimate) to the code owners.

---

## Ownership

Code owners are listed in `.github/CODEOWNERS`. Every change needs their approval once branch protection
is enabled.
