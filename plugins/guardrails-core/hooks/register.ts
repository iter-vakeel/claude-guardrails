// guardrails-core: ITERFORGE security guardrails for Claude Code, as one hooks module.
//
// Policy rules (3-6): ORM auto-schema, destructive migrations, direct DB changes, force push /
// protected branches. With HARD_BLOCK_POLICY on (now) they are denied; off, they ask with a 🔴 dialog.
// Either way a refusal gives Claude the policy message and the reason.
//
// Ask before use (rules 1-2): reading secrets and PII is allowed. An action that USES a secret, or
// sends PII out, waits for the developer to accept the risk in a dialog, even in auto mode.
//   🔴 high   = a secret leaves the machine, or is hardcoded into a command or a file
//   🟡 medium = a secret used locally (incl. editing a secret file), or PII sent outside
//
// Session start: Responsible AI Use banner for the developer (banner.tsx), team standards for Claude.
import type { Register } from 'claude-code'

import { registerBanner } from './banner'
import { classify, MASKED_TOOLS, redactResult } from './redact'

// ================= POLICY =================
const POLICY = 'ACTION BLOCKED - PROHIBITED BY ITERFORGE SECURITY POLICY. This action is not permitted. Do not try to work around this control. Reason: '
const ACCEPT = 'I accept the risk - run it'
const CANCEL = 'Cancel'
// Rules 3-6: false = ask with a 🔴 dialog (the developer may accept); true = hard block (deny, no dialog)
export const HARD_BLOCK_POLICY = true

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']
const OUTBOUND_TOOLS  = /^(WebFetch|WebSearch|mcp__.*)$/
const OUTBOUND_CMD    = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|scp|sftp|ssh|git\s+push|aws\s+s3\s+(cp|sync|mv)|gh\s+(gist|issue|pr|api))\b/i
const IGNORE_PII      = /@(example\.(com|org)|anthropic\.com)$|^noreply@/i

// commands that only READ (allowed freely, also when piped or chained after cd)
const READ_VERB  = /^\s*(cat|type|Get-Content|gc|head|tail|less|more|grep|rg|Select-String|sls|findstr|cut|awk|sed|wc|sort|uniq|ForEach-Object|Where-Object|Select-Object|Measure-Object|cd|Set-Location|ls|dir|Get-ChildItem)\b/i
// read verbs that can still write or execute
const WRITE_FORM = /\bsed\b[^|]*\s-[a-z]*i|\bawk\b[^|]*\bsystem\s*\(|\bSet-Content\b|\bOut-File\b/i

// secret files: by path (file tools) and by name inside a command (shell)
const SECRET_FILE        = /(^|\/)(\.env(\..*)?|secrets\/.*|.*\.(pem|key|p12|pfx|jks))$/i
const SECRET_FILE_SAFE   = /\.env\.(example|sample|template)$/i
const SENSITIVE_FILE_REF = /(^|[\s"'=\/\\(<])(\.env(\.(?!example|sample|template)[\w.-]+)?|application-prod\.(properties|ya?ml)|credentials|id_rsa|id_ed25519|secrets\/[\w.\/-]*|[\w.-]+\.(pem|key|pfx|p12|jks|keystore))(?=$|[\s"';|&)>])/i

// secret-looking variables: $API_TOKEN, ${DB_PASSWORD}, $env:AWS_SECRET_ACCESS_KEY
// application*.properties / .yml / .yaml (any profile): counts only in an outbound or substituting command
const APP_CONFIG_REF = /(^|[\s"'=\/\(<])application[\w.-]*\.(properties|ya?ml)(?=$|[\s"';|&)>])/i
const SUBSTITUTION   = /\$\(|`|</

const SECRET_VAR_REF = /\$(env:)?\{?[A-Za-z_0-9]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z_0-9]*\}?/i

// ================= DETECTORS =================
// (?<v>...) = the value we remember
const DETECTORS: [string, string, RegExp][] = [
  ['secret', 'AWS access key',        /\b(?<v>(?:AKIA|ASIA)[0-9A-Z]{16})\b/g],
  ['secret', 'AWS secret key',        /aws_secret_access_key\s*[=:]\s*["']?(?<v>[A-Za-z0-9\/+]{40})/gi],
  ['secret', 'GitHub token',          /\b(?<v>gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g],
  ['secret', 'API key',               /\b(?<v>sk-[A-Za-z0-9_-]{20,})/g],
  ['secret', 'Slack token',           /\b(?<v>xox[baprs]-[A-Za-z0-9-]{10,})/g],
  ['secret', 'JWT token',             /\b(?<v>eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g],
  ['secret', 'Private key',           /(?<v>-----BEGIN [A-Z ]*PRIVATE KEY-----)/g],
  ['secret', 'DB password in URL',    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:\/@]+:(?<v>[^\s@\/\\]{6,})@/gi],
  ['secret', 'JDBC password',         /jdbc:[a-z]+:\/\/[^\s"']*[?&]password=(?<v>[^&\s"'$]+)/gi],
  ['secret', 'Password/secret value', /\b[\w.-]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*["']?(?!\$\{)(?<v>[^\s"'$,;\\]{8,})/gi],
  ['pii',    'Email address',         /\b(?<v>[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g],
  ['pii',    'US SSN',                /\b(?<v>\d{3}-\d{2}-\d{4})\b/g],
  // 13-16 digits, first 3-6, optional single space/dash between digits; learn() applies the Luhn check
  ['pii',    'Card number',           /(?<!\d)(?<v>[3-6](?:[ -]?\d){12,15})(?!\d)/g],
  // US style with separators, or E.164; 10 bare digits (IDs) do not match
  ['pii',    'Phone number',          /(?<![\w+-])(?<v>(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}|\+\d{11,14})(?!\d)/g],
]

// ================= TYPES =================
export type Level = 'high' | 'medium'
export type Seen = { kind: string; label: string; source: string }
// what the session has seen: values are never logged or shown
export type Memory = { tracked: Map<string, Seen>; secretFiles: Map<string, string>; noticed: Set<string> }
// cwd: the session's folder; branchOf: the checked-out branch of a folder ('' when unknown)
export type Ctx = { cwd: string; branchOf: (dir: string) => Promise<string> }
export type Verdict =
  | { kind: 'block'; reason: string }
  | { kind: 'ask'; hits: string[]; level: Level }
  | { kind: 'pass' }

export const RISK = {
  high:   { dot: '🔴', name: 'High risk',   chip: 'HIGH' },
  medium: { dot: '🟡', name: 'Medium risk', chip: 'MEDIUM' },
}

export const newMemory = (): Memory => ({ tracked: new Map(), secretFiles: new Map(), noticed: new Set() })

// ================= THE CHECK =================
// One tool call in, one verdict out. Hard blocks first, then the secret-use question.
export async function evaluate(call: Record<string, any>, ctx: Ctx, mem: Memory): Promise<Verdict> {
  const tool: string = call.tool || ''
  const path = String(call.file_path || call.path || '').replace(/\\/g, '/')
  const edits = Array.isArray(call.edits) ? call.edits.map((e: any) => e.new_string || '').join('\n') : ''
  const content = [call.content, call.new_string, edits].filter(Boolean).join('\n')
  const cmd = String(call.command || '')
  const isShell = /^(Bash|PowerShell)$/.test(tool)
  const isWrite = /^(Edit|Write|MultiEdit)$/.test(tool)
  const block = (reason: string): Verdict => ({ kind: 'block', reason })

  // 3. No ORM auto-schema (Hibernate / Spring)
  const DDL = /(ddl-auto|hbm2ddl\.auto)[^a-z]{0,6}(create|create-drop|update)\b/i
  if ((content && DDL.test(content)) || DDL.test(cmd))
    return block('ddl-auto create/update lets the app change the schema itself; use validate/none + Flyway/Liquibase')

  // 4. No destructive schema changes in migration files
  const isMigration = /(db\/migration|db\/changelog|migrations?)\/|\.sql$/i.test(path)
  if (isWrite && isMigration && content) {
    const DESTRUCTIVE = /\b(drop\s+(column|table|schema)|rename\s+column|truncate(\s+table)?|alter\s+column\s+\S+\s+(set\s+data\s+)?type|modify\s+column|dropColumn|dropTable|renameColumn|modifyDataType)\b/i
    const m = content.match(DESTRUCTIVE)
    if (m) return block(`migration contains "${m[0]}"; destructive schema changes need a reviewed ticket`)
  }

  // 5. No direct DB changes from the terminal
  if (isShell) {
    const segments = splitSegments(cmd)
    const DB_CLIENT = /\b(psql|mysql|sqlcmd|sqlplus|mongosh|pgcli)\b/i
    if (DB_CLIENT.test(cmd) && /\b(alter|drop|delete|truncate|update|insert|grant|revoke)\s/i.test(cmd))
      return block('running ALTER/DROP/DELETE/UPDATE through a DB client is not allowed; use a migration in a PR')
    // SQL from a file can't be inspected here, so script runs are blocked outright
    for (const s of segments)
      if (DB_CLIENT.test(s) && /(\s(-f|--file|-i|--input-file)(\s|=)|<\s*\S|\bsource\s|\\i\s|\s@\S)/i.test(s))
        return block('running a SQL script through a DB client is not allowed; use a migration in a PR')
    if (segments.length > 1 && DB_CLIENT.test(segments[segments.length - 1]) && /\b(cat|type|get-content|gc)\b/i.test(cmd))
      return block('piping a SQL script into a DB client is not allowed; use a migration in a PR')
  }

  // 6. No force push / push to protected branches
  if (isShell) {
    const reason = await checkPush(cmd, ctx.cwd || null, ctx)
    if (reason) return block(reason)
  }

  // 1-2. Secrets and PII: reading is free, using asks
  const { hits, level } = secretUse(call, { tool, path, content, cmd, isWrite }, mem)
  return hits.length ? { kind: 'ask', hits, level } : { kind: 'pass' }
}

function secretUse(call: Record<string, any>, c: { tool: string; path: string; content: string; cmd: string; isWrite: boolean }, mem: Memory): { hits: string[]; level: Level } {
  if (READ_ONLY_TOOLS.includes(c.tool)) return { hits: [], level: 'medium' }
  const args = JSON.stringify(call)
  const outbound = OUTBOUND_TOOLS.test(c.tool) || OUTBOUND_CMD.test(c.cmd)
  const hits: string[] = []
  let secretUsed = false
  let hardcoded = false

  // values Claude saw earlier (in a file, a log, a command's output)
  for (const [v, info] of mem.tracked) {
    if (!args.includes(v)) continue
    if (info.kind === 'secret') {
      secretUsed = true
      if (c.isWrite) hardcoded = true // copying a seen secret into a file hardcodes it
    }
    if (info.kind === 'secret' || outbound) hits.push(info.label + ' (seen in ' + info.source + ')')
  }

  if (c.isWrite) {
    // secrets written into code; placeholders and env lookups pass
    for (const what of writtenSecrets(c.path, c.content)) {
      hits.push(what + ' (hardcoded in ' + c.path + ')')
      hardcoded = true
    }
    if (SECRET_FILE.test(c.path) && !SECRET_FILE_SAFE.test(c.path)) {
      hits.push('changes sensitive file ' + c.path)
      secretUsed = true
    }
  } else {
    // brand-new secrets typed straight into a command or a request
    for (const [kind, label, re] of DETECTORS) {
      if (kind === 'secret' && args.match(re) && !hits.some(h => h.startsWith(label))) {
        hits.push(label + ' (hardcoded in this action)')
        hardcoded = true
      }
    }
  }

  // indirect use: secret files / secret variables in a non-read command
  // (source .env, --env-file, $(grep ... .env), $API_TOKEN, $env:DB_PASSWORD)
  if (c.cmd && !isPureRead(c.cmd)) {
    for (const [name, full] of mem.secretFiles) if (c.cmd.includes(name)) { hits.push('values from ' + full); secretUsed = true }
    const f = c.cmd.match(SENSITIVE_FILE_REF)
    if (f) { hits.push('values from sensitive file ' + f[2]); secretUsed = true }
    const a = (outbound || SUBSTITUTION.test(c.cmd)) && c.cmd.match(APP_CONFIG_REF)
    if (a) { hits.push('values from sensitive file ' + a[0].replace(/^[\s"'=\/\(<]/, '')); secretUsed = true }
    const v = c.cmd.match(SECRET_VAR_REF)
    if (v) { hits.push('secret variable ' + v[0]); secretUsed = true }
  }

  const level: Level = hardcoded || (secretUsed && outbound) ? 'high' : 'medium'
  return { hits: [...new Set(hits)], level }
}

// Secrets in file content. A quoted literal counts in any file; an unquoted value only in config files,
// so code like `password = System.getenv("DB_PASSWORD")` or `password = dbPassword` passes.
function writtenSecrets(path: string, content: string): string[] {
  if (!content) return []
  const found: string[] = []
  for (const [kind, label, re] of DETECTORS)
    if (kind === 'secret' && label !== 'Password/secret value' && content.match(re)) found.push(label)
  const KEY = String.raw`\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\b["']?\s*[:=]\s*`
  const PLACEHOLDER = /^(\$\{|<|\*+$|changeme$|example$|x{3,}$|null$|none$)/i
  const isConfig = /\.(ya?ml|properties|conf|cfg|ini|xml|json|tf|tfvars)$/i.test(path)
  const quoted = new RegExp(KEY + String.raw`["']([^"'\n]{6,})["']`, 'gi')
  const unquoted = new RegExp(KEY + String.raw`(?!["'])([^\s"'#,;]{6,})`, 'gi')
  for (const m of content.matchAll(quoted))
    if (!PLACEHOLDER.test(m[1]) && !/\$\{/.test(m[1])) found.push('Password/secret value')
  if (isConfig)
    for (const m of content.matchAll(unquoted))
      if (!PLACEHOLDER.test(m[1])) found.push('Password/secret value')
  return [...new Set(found)]
}

export function isPureRead(cmd: string) {
  // single-quoted text is literal: its | ; $ & are not shell syntax
  const bare = cmd.replace(/'[^']*'/g, "''")
  if (/\$\(|`|<\(/.test(bare) || WRITE_FORM.test(cmd)) return false
  // harmless redirects only; any other > writes a file
  if (/>/.test(bare.replace(/\d?>\s*(\/dev\/null|\$null|NUL)\b|\d>&\d/gi, ''))) return false
  return bare.split(/&&|\|\||[|;]/).every(s => READ_VERB.test(s))
}

// ================= RULE 6 HELPERS =================
// Follows `cd X &&` / `Set-Location X;` / `git -C X` so a plain push is checked in the folder it runs in,
// and re-checks quoted commands such as bash -c "git push ...". Returns the block reason, or null.
async function checkPush(cmd: string, dir: string | null, ctx: Ctx): Promise<string | null> {
  const PROTECTED = /^(main|master|develop)$/i
  for (const s of splitSegments(cmd)) {
    const tokens = (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(t => t.replace(/^["']|["']$/g, ''))
    for (let i = 1; i < tokens.length; i++)
      if (/^(-[a-z]*c|\/[ck]|-command)$/i.test(tokens[i - 1])) {
        const inner = await checkPush(tokens[i], dir, ctx)
        if (inner) return inner
      }
    if (/^(cd|chdir|pushd|set-location|sl)$/i.test(tokens[0] || '')) {
      dir = changeDir(dir, tokens.slice(1).find(t => !/^(\/d|-(literal)?path)$/i.test(t)))
      continue
    }
    const gi = tokens.findIndex(t => /^git(\.exe)?$/i.test(t))
    const pi = tokens.indexOf('push', gi + 1)
    if (gi < 0 || pi < 0) continue
    let gitDir = dir // git -C <dir> runs git in another folder
    for (let i = gi + 1; i < pi; i++) if (tokens[i] === '-C') gitDir = changeDir(gitDir, tokens[++i])
    const args = tokens.slice(pi + 1)
    if (args.some(a => /^(--force(-with-lease|-if-includes)?(=.*)?|-[a-z]*f[a-z]*|--mirror)$/i.test(a) || /^\+/.test(a)))
      return 'git force push is not allowed'
    if (args.includes('--all')) return 'git push --all would push main/develop; push a feature branch and open a PR'
    const refs = args.filter(a => !a.startsWith('-')).slice(1) // first non-flag arg is the remote
    // Unknown branch (not a repo, detached HEAD, unresolvable cd) fails closed: the push could be to main
    let current: string | undefined
    const branchOf = async () => (current ??= gitDir ? await ctx.branchOf(gitDir) : '')
    const targets = refs.length ? refs.map(r => r.split(':').pop() || '') : [await branchOf()]
    for (let t of targets) {
      t = t.replace(/^refs\/heads\//, '')
      if (t === 'HEAD') t = await branchOf()
      if (!t) return 'could not tell which branch this git push targets; name it, e.g. git push origin feature/GPC-123'
      if (PROTECTED.test(t)) return `push to ${t} is not allowed; open a PR`
    }
  }
  return null
}

// Split on && || ; | and newlines outside quotes, so `grep "a|git push"` is not read as a command
function splitSegments(cmd: string) {
  return (cmd.match(/(?:"[^"]*"|'[^']*'|[^"'&|;\n]|&(?!&))+/g) || []).map(s => s.trim()).filter(Boolean)
}

// Resolve a cd target against the current folder; null when it can't be known here ($VAR, %VAR%, cd -, ~)
function changeDir(from: string | null, to?: string): string | null {
  if (!from || !to || /^~/.test(to) || /[$%]/.test(to) || to === '-') return null
  to = to.replace(/\\/g, '/')
  if (/^[A-Za-z]:/.test(from)) to = to.replace(/^\/([a-z])(\/|$)/i, '$1:/') // Git Bash /c/x -> c:/x
  return normalize(/^([A-Za-z]:)?\//.test(to) ? to : from + '/' + to)
}

function normalize(p: string) {
  const parts = p.replace(/\\/g, '/').split('/')
  const head = parts.shift() as string // '' for /x, 'C:' for C:/x
  const out: string[] = []
  for (const s of parts) {
    if (!s || s === '.') continue
    if (s === '..') out.pop()
    else out.push(s)
  }
  return head + '/' + out.join('/')
}

// ================= LEARNING (after a tool ran) =================
export function learn(text: string, source: string, mem: Memory) {
  const found: [string, string][] = []
  for (const [kind, label, re] of DETECTORS) {
    for (const m of text.matchAll(re)) {
      const v = (m.groups && m.groups.v) || m[0]
      if (!v || v.length < 6) continue
      if (kind === 'pii' && IGNORE_PII.test(v)) continue
      if (label === 'Card number' && !luhn(v)) continue
      if (!mem.tracked.has(v)) mem.tracked.set(v, { kind, label, source })
      found.push([kind, label])
    }
  }
  // personal-data fields: key: value, key=value, "key": "value" (also JSON-escaped); secret fields are in DETECTORS
  const FIELD = /(?<k>[A-Za-z_][\w.-]*)\\?["']?\s*[:=]\s*\\?["']?(?<v>[^\s"'\\,;]+)/g
  const PII_FIELD = /^(name|email|phone|address|card|dob|govid|zip)$/
  for (const m of text.matchAll(FIELD)) {
    const { k, v } = m.groups as { k: string; v: string }
    const cls = classify(k)
    if (!cls || !PII_FIELD.test(cls) || v.length < 6 || /^(\[|\$\{|null$|true$|false$)/i.test(v)) continue
    if (cls === 'email' && IGNORE_PII.test(v)) continue
    const label = 'Personal data (' + k + ')'
    if (!mem.tracked.has(v)) mem.tracked.set(v, { kind: 'pii', label, source })
    found.push(['pii', label])
  }
  return found
}

function luhn(v: string) {
  const d = v.replace(/\D/g, '')
  let sum = 0
  for (let i = 0; i < d.length; i++) {
    let n = +d[d.length - 1 - i]
    if (i % 2) { n *= 2; if (n > 9) n -= 9 }
    sum += n
  }
  return sum % 10 === 0
}

function summarize(found: [string, string][]) {
  const c: Record<string, number> = {}
  for (const [, label] of found) c[label] = (c[label] || 0) + 1
  return Object.entries(c).map(([l, n]) => (n > 1 ? n + 'x ' : '') + l).join(', ')
}

export function mask(text: string, mem: Memory) {
  let out = text
  for (const v of mem.tracked.keys()) out = out.split(v).join('****')
  return out
}

function sourceName(call: Record<string, any>, mem: Memory) {
  if (call.file_path) return call.file_path
  if (call.path) return call.path
  if (call.command) return 'output of: ' + mask(call.command, mem).slice(0, 60)
  return 'output of ' + call.tool
}

// ================= DIALOG + AUDIT =================
async function riskAsk($: any, question: string, tool: string, hits: string[], level: Level) {
  const { dot, name, chip } = RISK[level]
  // circle in the status area under the prompt; up only while the question is open
  $.ui.status(dot + ' ' + name + ': ' + tool + ' uses ' + hits.join('; ') + ' - choose carefully')
  let answer = CANCEL
  try {
    // Cancel first, so a quick Enter never accepts a risk
    answer = await $.ui.ask(dot + ' ' + question, { options: [CANCEL, ACCEPT], header: dot + ' ' + chip })
  } catch {
    // dismissed, or nobody to ask (claude -p, CI) -> cancel
  } finally {
    $.ui.status(undefined)
  }
  return answer === ACCEPT
}

function audit($: any, msg: string) {
  $.ui.log('[guardrails-core] ' + new Date().toISOString() + ' ' + msg, { to: 'debug' })
}

// ================= HOOKS =================
export const register: Register = on => {
  const mem = newMemory()

  on('tool.call', async ($, e, next) => {
    const call: any = e
    const ctx: Ctx = {
      cwd: await $.session.cwd(),
      branchOf: async dir => {
        try {
          // symbolic-ref (not rev-parse) also works on a branch with no commits yet
          const r = await $.process.run(['git', 'symbolic-ref', '--short', 'HEAD'], { cwd: dir, timeoutMs: 3000 })
          return r.exitCode === 0 ? r.stdout.trim() : ''
        } catch {
          return '' // not a repo / detached HEAD / git missing: the caller blocks
        }
      },
    }

    // ---- BEFORE ----
    const verdict = await evaluate(call, ctx, mem)
    const what = mask(String(call.command || call.file_path || call.url || call.tool), mem).slice(0, 300)
    if (verdict.kind === 'block') {
      if (HARD_BLOCK_POLICY) {
        audit($, 'BLOCK ' + call.tool + ': ' + verdict.reason)
        return { deny: POLICY + verdict.reason }
      }
      // policy rule hit: the developer decides, always 🔴
      const ok = await riskAsk($,
        'POLICY RISK ACCEPTANCE REQUIRED (High risk)\n' +
        'Claude wants to use ' + call.tool + ': ' + what + '\n' +
        'This action breaks ITERFORGE policy: ' + verdict.reason + '\n' +
        'If you continue, YOU accept responsibility for this risk.',
        call.tool, ['policy: ' + verdict.reason], 'high')
      audit($, 'POLICY ' + call.tool + ' HIGH [' + verdict.reason + '] -> ' + (ok ? 'RISK ACCEPTED' : 'CANCELLED'))
      if (!ok) return { deny: POLICY + verdict.reason + '. The user did not accept the risk. Do not retry the same thing another way; explain the safe alternative.' }
    } else if (verdict.kind === 'ask') {
      const { hits, level } = verdict
      const ok = await riskAsk($,
        'RISK ACCEPTANCE REQUIRED (' + RISK[level].name + ')\n' +
        'Claude wants to use ' + call.tool + ': ' + what + '\n' +
        'This action uses sensitive data: ' + hits.join('; ') + '\n' +
        'If you continue, YOU accept responsibility for this risk.',
        call.tool, hits, level)
      audit($, 'USE ' + call.tool + ' ' + level.toUpperCase() + ' [' + hits.join('; ') + '] -> ' + (ok ? 'RISK ACCEPTED' : 'CANCELLED'))
      if (!ok) {
        return { deny: 'The user did not accept the risk of using sensitive data (' + hits.join('; ') + ') in this action. Do not retry the same thing another way. Ask the user how they want to proceed.' }
      }
    } else {
      audit($, 'PASS ' + call.tool + ': ' + what.slice(0, 120))
    }

    // ---- run the tool ----
    const result: any = await next(e)

    // ---- AFTER: learn what sensitive data Claude just saw ----
    if (result && !result.deny && !result.isError) {
      const source = sourceName(call, mem)
      const found = learn(JSON.stringify(result), source, mem)
      if (found.some(([k]) => k === 'secret') && (call.file_path || call.path)) {
        const full: string = call.file_path || call.path
        mem.secretFiles.set(full.split(/[\\\/]/).pop() as string, full)
      }
      if (found.length && !mem.noticed.has(source)) {
        mem.noticed.add(source)
        $.ui.log('NOTICE: ' + source + ' contains ' + summarize(found) + '. Reading is fine; any action that uses it will ask you first.')
        audit($, 'SEEN in ' + source + ': ' + summarize(found))
      }
    }

    // ---- AFTER: mask secrets and personal data so Claude never reads the values ----
    // learn() above still saw the originals, so a later action that uses them is still caught.
    if (result && !result.deny && !result.isError && MASKED_TOOLS.test(call.tool || '')) {
      let masked
      try {
        masked = redactResult(call.tool, String(call.file_path || call.path || ''), result.result)
      } catch {
        // Fail closed: withhold the result rather than pass it on unmasked
        return { deny: 'guardrails-core could not mask this output, so it was withheld. Skip it and continue with the rest of the task.' }
      }
      const kinds = Object.entries(masked.counts).map(([k, n]) => `${n} ${k}`).join(', ')
      if (kinds) {
        audit($, 'MASKED in ' + sourceName(call, mem) + ': ' + kinds)
        return {
          result: masked.record,
          context: [...(result.context || []), `guardrails-core masked ${kinds} value(s) in this output. Carry on with the masked output; never try another route to the original values, and leave masked lines untouched when editing.`],
        }
      }
    }
    return result
  }).catch(async ($, e, next) =>
    // a failure before the tool ran pauses the call; after, the tool's own result stands
    next.called ? next(e) : { deny: POLICY + 'the guardrail check failed (' + next.error.kind + '), so this action was paused for safety. Try again or ask the user.' }
  )

  // ---- session start: banner for the developer (banner.tsx) ----
  // The standards for Claude come from the org policy's claudeMd (policy/managed-settings.json):
  // Claude Code's built-in security plugin passes classic.SessionStart and prompt.context on past
  // user plugins, so a plugin cannot add them to Claude's context itself.
  registerBanner(on)
}
