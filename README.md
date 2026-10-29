# 🛡️ claude-guardrails

**ITERFORGE security guardrails for Claude Code.** One mandatory plugin, `guardrails-core`, checks every
tool call Claude makes and asks the developer before anything risky happens.

![status](https://img.shields.io/badge/status-pilot-orange)
![runtime deps](https://img.shields.io/badge/runtime%20deps-none-brightgreen)
![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1.296%2B-blueviolet)
![CI](https://img.shields.io/badge/CI-Linux%20%7C%20Windows%20%7C%20macOS-blue)

| 📖 Read freely | 🟡 Ask before local use | 🔴 Ask before it leaves / breaks things |
|:---:|:---:|:---:|
| Secrets, logs, personal data | `.env` used locally, secret file changed | Secret sent out or hardcoded, policy rules 3-6 |

---

## 🔄 How it works

```mermaid
flowchart TD
    A["🤖 Claude wants to use a tool<br/>Edit · Write · Bash · PowerShell · WebFetch · MCP"] --> H{"🛡️ guardrails-core<br/>tool.call hook"}
    H -->|"Policy rule 3-6 hit"| P["🔴 POLICY RISK ACCEPTANCE dialog"]
    H -->|"Uses a secret / sends PII"| R["🔴 HIGH or 🟡 MEDIUM dialog"]
    H -->|"Nothing risky"| OK["✅ Tool runs"]
    H -->|"Check itself crashes"| FC["⏸️ Paused (fails closed)"]
    P -->|"Cancel / Esc"| B1["⛔ ACTION BLOCKED + reason to Claude"]
    P -->|"I accept"| OK
    R -->|"Cancel / Esc"| B2["⛔ Denied, Claude must not retry"]
    R -->|"I accept the risk"| OK
    OK --> L["🧠 Secrets and PII in the output are remembered (masked)<br/>so a later use is caught"]

    style P fill:#fdd,stroke:#c00,color:#000
    style R fill:#ffe9b3,stroke:#c90,color:#000
    style OK fill:#dfd,stroke:#090,color:#000
    style B1 fill:#eee,stroke:#666,color:#000
    style B2 fill:#eee,stroke:#666,color:#000
    style FC fill:#eee,stroke:#666,color:#000
```

At session start the plugin shows a **Responsible AI Use** banner. The team engineering standards reach
Claude through the org policy (`claudeMd`).

---

## 📏 The rules

```mermaid
mindmap
  root(("🛡️ guardrails-core"))
    🔴 Policy rules
      3 · No ORM auto-schema
        ddl-auto create / update
      4 · No destructive migrations
        DROP · RENAME · TRUNCATE · type change
      5 · No direct DB changes
        psql / mysql / sqlcmd with ALTER, DELETE...
      6 · No force push / protected push
        --force · main · master · develop
    🔐 Secrets
      1 · Secret files
        .env · *.pem · *.key · id_rsa
      2 · Secrets in commands and code
        $API_TOKEN · hardcoded password
    👤 Personal data
      Email · US SSN sent out
```

### Policy rules (🔴 dialog for now)

| # | Asks for | Passes |
|---|---|---|
| 3 | `ddl-auto` / `hbm2ddl.auto` = `create`, `create-drop`, `update` | `validate`, `none` |
| 4 | `DROP`, `RENAME COLUMN`, `TRUNCATE`, type changes, Liquibase `drop*` / `modifyDataType` | `ADD COLUMN`, new tables, indexes |
| 5 | DB CLIs with `ALTER/DROP/DELETE/UPDATE/INSERT/TRUNCATE/GRANT/REVOKE` or a SQL script | `select` |
| 6 | `--force`, `-f`, `+ref`, `--mirror`, `--all`, any push to `main`/`master`/`develop` | `git push origin feature/GPC-123` |

> 🔧 To make them **hard blocks** again: set `HARD_BLOCK_POLICY = true` at the top of
> `plugins/guardrails-core/hooks/register.ts` and update the test that checks the switch.

### Secrets: read freely, ask before use

```mermaid
flowchart LR
    S["🔐 Secret or 👤 PII"] --> Q1{"What does<br/>Claude do?"}
    Q1 -->|"Read · grep · list names"| G["✅ No dialog"]
    Q1 -->|"Use locally<br/>docker --env-file · cp .env · sed -i .env"| M["🟡 MEDIUM"]
    Q1 -->|"Send personal data out"| M
    Q1 -->|"Send a secret out<br/>curl -H Bearer $TOKEN"| H["🔴 HIGH"]
    Q1 -->|"Hardcode it<br/>password = '...'"| H

    style G fill:#dfd,stroke:#090,color:#000
    style M fill:#ffe9b3,stroke:#c90,color:#000
    style H fill:#fdd,stroke:#c00,color:#000
```

### What the developer sees

```mermaid
sequenceDiagram
    autonumber
    actor Dev as 👩‍💻 Developer
    participant C as 🤖 Claude
    participant G as 🛡️ guardrails-core
    participant T as 🧰 Tool

    C->>G: curl -H "Bearer $API_TOKEN" ...
    G->>Dev: 🔴 HIGH dialog (value masked as ****)<br/>status line shows 🔴
    alt 1 · Cancel (default) / Esc / no one to ask
        G-->>C: ⛔ denied, do not retry another way
    else 2 · I accept the risk
        G->>T: run
        T-->>C: result
    end
    Note over G: Audit line → debug log<br/>RISK ACCEPTED / CANCELLED
```

**Cancel is option 1**, so a quick Enter never accepts a risk. Values are never shown in the dialog, the
status line or the audit log.

---

## 🚀 Get started

| I want to... | Go to |
|---|---|
| 🧪 Try it on my machine | [DEVELOPER-SETUP.md](DEVELOPER-SETUP.md) |
| 🏢 Enforce it for the whole org | [ADMIN-SETUP.md](ADMIN-SETUP.md) |

Quick install:

```bash
claude plugin marketplace add mvakeel-vs/claude-guardrails
claude plugin install guardrails-core@claude-guardrails
```

Needs Claude Code **2.1.296+** (tested on 2.1.312) and Git. **No Node.js** on developer machines. The repo
is private: the machine needs a git login (`gh auth login` + `gh auth setup-git`).

### Org rollout at a glance

```mermaid
flowchart LR
    A["📦 Repo in company<br/>GitHub org"] --> B["🔒 Branch protection<br/>on main"]
    B --> C["🧪 Pilot group<br/>Available to install"]
    C --> D["✅ Required<br/>for everyone"]
    D --> E["📜 Managed settings<br/>policy/managed-settings.json"]
    E --> F["💻 Every laptop<br/>Code + Cowork"]
```

---

## 🛠️ Changing a rule

```mermaid
flowchart LR
    A["🌿 Branch"] --> B["✏️ Edit register.ts<br/>or standards.ts"]
    B --> C["🧪 Add cases to<br/>guard.test.ts"]
    C --> D["▶️ npm test"]
    D --> E["🔀 Pull request<br/>CI on 3 OSes + code owner"]
    E --> F["🚢 Merge → laptops<br/>update next session"]
```

```bash
npm test     # claude plugin validate + claude plugin test → "<n> pass", "0 fail"
```

- ⚠️ **No `version` in `plugin.json`**: a fixed version stops machines from getting updates.
- ⚠️ While the plugin is active, Claude Code blocks edits to `register.ts` and `guard.test.ts` (they contain
  rule 3 patterns). Edit them outside Claude, or `claude plugin disable guardrails-core@<marketplace>` +
  `/reload-plugins` for that session.
- Work on a local clone for one session: `claude --plugin-dir plugins/guardrails-core --debug-file guard.log`

### Repository layout

```
.claude-plugin/marketplace.json        marketplace catalogue
plugins/guardrails-core/
  hooks/register.ts                    all rules, dialogs, learning, banner wiring
  hooks/standards.ts                   banner text
  tests/guard.test.ts                  allow / block / ask + end-to-end dialog tests
policy/managed-settings.json           org console policy (deny rules + claudeMd)
scripts/new-guard-test.ps1             fake test project for DEVELOPER-SETUP
.github/workflows/guard-tests.yml      CI on Linux, Windows, macOS
```

---

## ⚠️ Known limitations

This is a **safety net for Claude's mistakes, not a security boundary**. It does not stop a person typing
commands, and it does not replace infrastructure controls. An accepted risk runs.

| Area | Behaviour |
|---|---|
| 📝 Audit | Only in the local debug log (`--debug-file`); no central record yet |
| 🧠 Memory | Seen secret values are forgotten when the plugin reloads; name-based rules still apply |
| 🤖 `claude -p` / CI | No one can answer the dialog → secret use is denied |
| 6️⃣ Rule 6 | `git commit -m push` on `main` triggers; `cd ~` / `cd $VAR` before a plain push fails closed |
| 3️⃣ Rule 3 | Also fires on docs and `grep` that mention the setting; misses `SPRING_JPA_HIBERNATE_DDL_AUTO` |
| 5️⃣ Rule 5 | A quoted `<` in SQL may look like a script redirect |

Report every false alarm (command or file, message, why it was legitimate) to the code owners in
`.github/CODEOWNERS`.
