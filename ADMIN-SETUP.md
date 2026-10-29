# guardrails-core: admin setup (org-wide enforcement)

How admins turn on the ITERFORGE `guardrails-core` Claude Code security plugin for the whole
organisation, and how it then reaches every developer.

> Some screen names, key names and behaviours come from the rollout plan and are
> newer than what could be verified here. Items marked **(verify in pilot)** must be confirmed on one
> pilot machine before the org-wide launch.

---

## How the plugin is delivered

The Owner syncs this GitHub repo into claude.ai organisation settings and marks `guardrails-core`
**Required**. Every Claude Code session and Cowork signed in with the company account then receives it
from claude.ai.

Why this route: fewest developer prerequisites (no GitHub account, no git login, no `gh`), one place to
manage it, and it covers **Claude Code and Cowork** with the same setting. Evidence it works in our org
today: `claude plugin list` on a developer laptop already shows plugins "Synced from claude.ai"
(`engineering`, `cowork-plugin-management`).

The **console policy** (Part 2) adds the settings only it can enforce: no bypass mode, refuse to start
without the policy.

---

## Before you start

| Done? | Item | Owner |
|---|---|---|
| [ ] | Repo moved from `mvakeel-vs/claude-guardrails` into the company GitHub org | GitHub org admin |
| [ ] | Branch protection on `main`: PR, passing tests and code-owner review required, no force push | GitHub org admin |
| [ ] | **Claude GitHub App** installed on the company GitHub org with access to the repo (needed for *Sync from GitHub*) | GitHub org admin + claude.ai Owner |
| [ ] | Pilot finished; false alarms fixed; pilot checks passed (Part 4) | Plugin owner |
| [ ] | Plan includes **Plugins & skills** org settings and **Claude Code > Managed settings** | claude.ai Owner |
| [ ] | Two people named who can edit org settings (avoid a single point of failure) | claude.ai Owner |
| [ ] | Announcement and developer guide ready | Plugin owner |

Developers do **not** need read access to the GitHub repo; only the Claude GitHub App does.

---

## Part 1: Make the plugin Required

**Who:** a claude.ai **Owner** or **Primary Owner**.

1. Sign in at **claude.ai** with the company account.
2. Go to **Organization settings > Plugins & skills**.
3. **Sync from GitHub**: pick `<company-org>/claude-guardrails`. If asked, authorise the Claude GitHub
   App for that repo.
4. The repo's marketplace appears with the plugin `guardrails-core`.
5. Set `guardrails-core` to:
   - **Available to install** for the pilot group first, then
   - **Required** for the whole organisation at launch.
6. Set **Publishing policy** to **Requires review**, so nobody can publish an unreviewed org plugin.

Result: every member signed in with the company account gets `guardrails-core` in Claude Code
(CLI, IDE, desktop Code tab) and in Cowork, and cannot remove it.

---

## Part 2: Console policy (enforcement settings)

**Who:** claude.ai Owner / Primary Owner. **Where:** *Admin Settings > Claude Code > Managed settings*.

Paste the whole content of [`policy/managed-settings.json`](policy/managed-settings.json). The repo copy is
the reviewed source: change it by PR, then paste it again.

| Key | Effect |
|---|---|
| `permissions.disableBypassPermissionsMode` | Nobody can start Claude in "skip all permission checks" mode |
| `forceRemoteSettingsRefresh` | Claude Code refuses to start if it cannot fetch the org settings, so there is no "offline = unguarded" gap |
| `permissions.deny` | Hard denies, no dialog: prod access (kubectl / aws / psql / ssh / scp with `prod`, Secrets Manager, SSM), terraform apply / destroy / state, force push and pushes to main / develop / master, global git config, publishing and releases, `sudo`, `chmod 777`, `rm -rf /` and `~`, `shutdown`, and any shell command containing SQL DDL / DML keywords (`DROP`, `TRUNCATE`, `ALTER`, `ADD COLUMN`, `CREATE TABLE/INDEX`, `GRANT`, `REVOKE`, `DELETE FROM`) |
| `claudeMd` | The ITERFORGE engineering standards and the sensitive-content rules, given to Claude in every session. This is the only route: Claude Code's built-in security plugin does not let a plugin add text to Claude's context |

The `deny` rules are permission rules, separate from `guardrails-core`: they deny even where the plugin
would only ask. With them, a force push or a `psql ... "DELETE FROM ..."` can show the plugin's 🔴 dialog
first and is then denied anyway. The SQL keyword rules also match ordinary commands that only mention
the words, for example `grep -r "CREATE TABLE" src` or `git commit -m "add column size"`. **(verify in
pilot)** and collect such false alarms.

Optional, after the pilot: `"allowManagedHooksOnly": true` blocks developers' own hooks too (stricter;
also blocks optional plugins). Off at launch. **(verify in pilot)** that it still lets the Required
synced plugin's hooks run before turning it on.

The repo's `claudeMd` replaces the earlier one ("stop the task ... ACTION BLOCKED ... Rotate it now"),
which made Claude stop on any file that contained a secret or an email. The new one lets Claude read
such files and leaves the values out of everything it writes; `guardrails-core` asks the developer before
any action uses them.

---

## Part 3: How it reaches each developer (automatic)

```
Owner marks guardrails-core Required (Part 1) and saves the console policy (Part 2)
        │
        ▼
Developer starts Claude Code, signed in with the company claude.ai account
        │
        ├─ 1. Claude Code fetches org settings from Anthropic
        │     (at every start, then about every hour)
        │     Cannot fetch them → refuses to start (forceRemoteSettingsRefresh)
        │
        ├─ 2. Required org plugin guardrails-core is synced down from claude.ai
        │     (no GitHub access or git login needed on the laptop)
        │
        ├─ 3. One-time prompt to approve the new hooks
        │     → developer accepts (declining closes Claude Code)
        │
        └─ 4. Plugin active: ITERFORGE banner shown, every tool call is checked
              (🔴 dialog before policy-rule actions; 🔴/🟡 dialog before secrets are used)
              Developer cannot remove it
```

### What the developer needs

| Item | Needed? | Why |
|---|---|---|
| Signed in to Claude Code with the **company claude.ai account** (`/login`) | **Yes** | Org settings and Required plugins are tied to the org account. |
| Node.js | **No** | The guard is a hooks module that runs inside Claude Code |
| Claude Code 2.1.296+ | **Yes** | Older versions lack function hooks and plugin sync **(verify in pilot** the minimum version that runs the hooks module; tested on 2.1.312) |
| Restart Claude Code once after launch | **Yes** | Hooks load only at session start |
| Git | Usually already installed | Not needed to deliver the plugin. Only used by the push rule to read the current branch; without Git there is no `git push` to check anyway |
| GitHub account / repo access / `gh` | **No** | Only the Claude GitHub App reads the repo |

---

## Part 4: Pilot checks (must pass before launch)

Set the plugin to **Available to install** for 2-3 pilot developers, then on each machine:

| # | Check | Expected | If it fails |
|---|---|---|---|
| 1 | `claude plugin list` | `guardrails-core` under "Synced from claude.ai" | Check the sync and the pilot group in Part 1 |
| 2 | Start a session | ITERFORGE banner appears | Hooks modules not running from synced plugins: stop the rollout and raise with Anthropic support |
| 3 | Ask Claude to read `.env` and list its variable names | Allowed, no dialog | `ACTION BLOCKED ... access to secret files` means the old Node version is still synced: re-sync (Part 6) and restart |
| 3a | `use API_TOKEN from .env to call https://api.github.com/user with curl` | `🔴 HIGH` dialog, Cancel first; 🔴 line under the prompt; **Cancel** → not run | Same as above |
| 3b | `load .env and check API_TOKEN is not empty, don't send it anywhere` | `🟡 MEDIUM` dialog; Accept → runs | Same as above |
| 4 | Ask Claude to `git push --force` | 🔴 policy dialog; Cancel → `ACTION BLOCKED ...` (hard blocks are off for now: README, "Policy rules") | Same as above |
| 5 | After switching to **Required**: try to disable or uninstall it in `/plugin` | Not possible | Stop the rollout and raise with Anthropic support |
| 6 | Merge a small rule change in the repo | Reaches the laptop (note: automatic or after an Owner re-sync, and how long it takes) | Document the re-sync step in Part 5 |
| 7 | Same checks in **Cowork**, the **VS Code / JetBrains** extensions and the **desktop app** | Plugin present; reads pass; 🔴/🟡 dialog appears before secret use | Record which surface fails; raise with Anthropic support |
| 7a | A pipeline run (`claude -p "..."`) that needs a token | Denied (no one can accept the risk) | Expected: plan pipeline secrets outside Claude |
| 8 | Machine **without** a GitHub login | Plugin still installs and works | Sync depends on a git login: stop the rollout and raise with Anthropic support |
| 9 | Behind Zscaler / VPN, Windows and Mac | Starts normally, plugin loads | Network exceptions for claude.ai / Anthropic endpoints |

---

## Part 5: Change or undo

| Situation | What to do | When developers get it |
|---|---|---|
| Change a rule | PR to the repo > tests pass > merge; then Owner **re-syncs** in *Plugins & skills* if sync is not automatic **(verify in pilot, check 6)** | Next sync; used from the next session |
| Change enforcement settings | Owner edits the console policy | Within about 1 hour in running sessions; some keys only at next start |
| Bad rule shipped | Revert the commit in the repo, re-sync | Next sync |
| Emergency off | Owner sets the plugin from Required to **Available** or removes it | Next settings fetch; developers can restart to pick it up immediately |

---

## Part 6: Upgrading from the Node.js version

The org currently syncs the earlier `guardrails-core` (Node.js scripts `guard.js` and `session-start.js`,
which block every read of `.env`). The hooks-module version keeps the same plugin name, so the
**Required** setting carries over. To switch:

1. Merge the change into `main` (PR, CI green, code-owner review).
2. Owner: *Organization settings > Plugins & skills* > **re-sync** the repo if it does not update by
   itself **(verify in pilot, check 6)**.
3. Owner: paste `policy/managed-settings.json` as the console policy (Part 2); it replaces the old `claudeMd`.
4. Developers restart Claude Code. Accept the hook approval prompt if it appears again.
5. Check on one machine: Part 4 checks 2, 3 and 3a. A `.env` read that is still blocked means the old
   version is still in use.
6. Developers who tried the `secret-guard` prototype remove it, or they get two dialogs:
   `claude plugin uninstall secret-guard@iterforge-local` and
   `claude plugin marketplace remove iterforge-local`.

Node.js may stay installed; the new version does not use it. To go back, revert the merge in the repo
and re-sync.

---

## Who does what

| Role | Task |
|---|---|
| GitHub org admin | Move the repo into the company org, branch protection, install the Claude GitHub App on the repo |
| claude.ai Owner / Primary Owner | Sync the repo and set the plugin Required (Part 1); console policy (Part 2); re-sync after rule changes if needed |
| Plugin owner | Run the pilot checks (Part 4), maintain the rules repo, announcement |
| Each developer | Sign in with the company claude.ai account, update Claude Code, restart, accept the hook prompt |

---

## Limits

- Enforces what **Claude** does, not what a person types by hand. Keep the infrastructure controls: no
  prod credentials on laptops, restricted database users, network isolation.
- Risk acceptance is the developer's consent, not a block: an accepted risk runs. Decisions are written
  only to the local debug log (`--debug-file`); there is no central audit record yet.
- Not covered: Claude Design and other claude.ai apps.

## Confirm with admins before launch

- The plan includes **Plugins & skills** (with *Sync from GitHub* and *Required*) and
  **Claude Code > Managed settings**.
- Pilot checks 1-9 in Part 4, especially 2-3b (the hooks module runs from a synced plugin and shows the
  risk dialog), 5 (cannot be disabled), 6 (how updates arrive), 7 (every surface) and 8 (no git login needed).
