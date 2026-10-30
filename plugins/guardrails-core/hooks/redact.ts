// Masks secret values and personal data in a tool's result before Claude reads it.
// Every string in the tool's record is rewritten in place, so the record keeps the shape core validates.
//
// Field names are classified by meaning in any project and any spelling (lower-cased, separators
// stripped, then searched for a personal-data stem). IDs, codes, statuses and timestamps stay visible,
// and masks keep the shape that debugging needs: [email @gmail.com], [phone 10 digits], [card visa …1111].

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '')
// Postal codes end in "code" but are personal; checked before the describes-the-data rule below
const ZIP = /zip|postal|postcode/
// Fields that describe the data rather than hold it: emailTypeCode, addressType, phoneVerified, tokenUrl
const DESCRIBES = /(type|code|status|flag|verified|enabled|count|length|lenght|regex|format|template|valid|required|optin|optout|pref|exists|url|uri|endpoint|path|ttl|date|timestamp|time|option|policy)$/
const NETWORK = /(ip|mac|remote|host|server|bind|proxy|socket|inet|network|local|web)addr/
const CLASSES: [string, RegExp][] = [
  ['secret', /password|passwd|pwd$|secret|token|apikey|accesskey|privatekey|keydata|credential|username|authorization/],
  // A bare "name"/"displayName" is usually a product, store or shipping method, so only person-name stems count
  ['name', /(first|last|middle|full|given|family|sur|nick|customer|recipient|contact|cardholder|billing|shipping)name|^[fl]name$/],
  ['card', /cardnumber|cardno|creditcardnum|^pan$|cvv|cvc|card(exp|expiry|expiration)|ccexp/],
  ['email', /email/],
  ['phone', /phone|mobile|telephone|^tel$|fax|cellnumber/],
  ['address', /address|street|addr\d*$|^line\d$|city/],
  ['dob', /dob$|^dob|birth/],
  ['govid', /ssn|socialsecurity|taxid|passport|driverslicen[cs]e|nationalid/],
]
export function classify(key: string): string | null {
  const n = norm(key)
  if (!n) return null
  if (ZIP.test(n)) return 'zip'
  if (DESCRIBES.test(n) || NETWORK.test(n)) return null
  for (const [cls, re] of CLASSES) if (re.test(n)) return cls
  return null
}

const digits = (v: string) => v.replace(/\D/g, '')
// A field named like an ID (addressId, addressKey, emailId) is masked only when its value looks like the
// personal data itself: addressId 48213 stays visible for debugging, emailId jane@x.io is masked
const ID_FIELD = /(id|ids|key|ref|no)$/
const LOOKS_LIKE: Record<string, (v: string) => boolean> = {
  email: v => v.includes('@'),
  phone: v => digits(v).length >= 7 && !/[a-z]/i.test(v),
  card: v => digits(v).length >= 12,
  address: v => /\s/.test(v.trim()),
  name: v => /^[A-Za-z][A-Za-z' .-]*$/.test(v.trim()),
}
const idOnly = (key: string, cls: string, v: string) => ID_FIELD.test(norm(key)) && !!LOOKS_LIKE[cls] && !LOOKS_LIKE[cls](v)

const BRAND: Record<string, string> = { 3: 'amex', 4: 'visa', 5: 'mastercard', 6: 'discover' }
// Masks keep the shape so format bugs stay debuggable; a card keeps its last 4 digits
function mask(cls: string, v: string): string {
  const d = digits(v)
  if (cls === 'email') { const dom = v.match(/@([\w.-]+\.[a-z]{2,})/i); return dom ? `[email @${dom[1]}]` : '[email]' }
  if (cls === 'phone' && d.length >= 7) return `[phone ${d.length} digits]`
  if (cls === 'zip') return `[zip ${d.length || v.length} ${d.length ? 'digits' : 'chars'}]`
  if (cls === 'card' && d.length >= 12) return `[card ${BRAND[d[0]] || ''} …${d.slice(-4)}]`.replace('  ', ' ')
  return `[${cls}]`
}

// key = value / key: value / "key": "value" / \"key\":\"value\" (JSON escaped inside a string)
const KEY = String.raw`((?<![\w.@-])([A-Za-z_][\w.@-]*)(?:\\?["'])?\s*[:=]\s*)`
// Unquoted value: a run of words, stopping before the next key= (so "name=Jane Doe status=OK" keeps status)
const VALUE = String.raw`(\\"[^"\n]*?\\"|"[^"\n]*"|'[^'\n]*'|[^\s,;&}\]"'<]+(?: (?![\w.-]+\s*[:=])[^\s,;&}\]"'<=:]+)*)`
const KV = new RegExp(KEY + VALUE, 'g')
const XML = /<([A-Za-z_][\w.-]*)>([^<\n]{1,500})<\/\1>/g
// ${KEY}, an already-masked [label], <placeholder>, ***, booleans, null, empty
const PLACEHOLDER = /^(\\?["'])?(\$\{|\[|<|(\*+|null|none|true|false)?(\\?["'])?$)/i
// Outside config files, an unquoted value that is code (request.getPassword(), props.pw) is kept
const CODE_LIKE = /\(|^[A-Za-z_$][\w$]*(\.[\w$]+)+$/

const TEXT: [string, RegExp, (...m: string[]) => string][] = [
  ['secret', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => '[secret]'],
  ['secret', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bsk-[A-Za-z0-9_-]{20,}|\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, () => '[secret]'],
  ['secret', /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, (_, a) => `${a} [secret]`],
  ['secret', /(\b[a-z][\w+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, (_, a) => `${a}[secret]@`],
  // git@github.com:org/repo is a remote, not an email
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![\w.:-])/g, m => mask('email', m)],
  ['govid', /\b\d{3}-\d{2}-\d{4}\b/g, () => '[govid]'],
  ['phone', /(?<![\w-])(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w-])|(?<![\w+])\+\d{11,14}\b/g, m => mask('phone', m)],
  ['address', /\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Ter|Pkwy|Parkway|Hwy|Highway)\b\.?/g, () => '[address]'],
]
// Luhn + Visa/MC/Amex/Discover prefix, 13-16 digits, so 19-digit trace IDs pass; about 1 in 10 numeric
// IDs of card length starting 3-6 is masked too
const CARD = /\b[3-6]\d{3}(?:[ -]?\d){9,12}\b/g
const luhn = (s: string) => [...digits(s)].reverse().reduce((t, d, i) => t + (i % 2 ? [0, 2, 4, 6, 8, 1, 3, 5, 7, 9][+d] : +d), 0) % 10 === 0
const CONFIG = /\.(properties|ya?ml|env|conf|cfg|ini|json|xml|toml|tfvars|tf|txt|log|csv|tsv|sql)$|(^|\/)\.env(\.|$)/i

type Header = { cols: (string | null)[]; names: string[]; sep: string; width: number }
// A row of field names, at least one of them personal data. A row like that below a header is a new
// header, not data, so a printed list of field names never gets masked as if it were values.
function header(line: string): Header | null {
  for (const sep of ['|', '\t', ',']) {
    const cells = line.split(sep)
    if (cells.length < 2) continue
    const names = cells.map(c => c.trim().replace(/^["']|["']$/g, ''))
    // Up to three words per header ("First Name" in a spreadsheet export), never a sentence
    if (!names.every(n => /^[A-Za-z_][\w.-]*( [A-Za-z][\w.-]*){0,2}$/.test(n) && n.length <= 60)) continue
    const cols = names.map(classify)
    if (cols.some(Boolean)) return { cols, names, sep, width: cells.length }
  }
  return null
}
// Tables and CSV: a header row marks which columns hold personal data; rows below with the same number
// of cells get those columns masked. Separator rows (----+----) are skipped. A plain split, so a quoted
// CSV cell holding the delimiter ends the table early (the free-text rules still apply to it).
function maskTables(s: string, hit: (cls: string) => void): string {
  const lines = s.split('\n')
  let h: Header | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const next = header(line)
    if (next) { h = next; continue }
    if (!h) continue
    if (line.trim() && /^[\s\-+|=]*$/.test(line)) continue
    const cells = line.split(h.sep)
    if (cells.length !== h.width) { h = null; continue }
    const t = h
    lines[i] = cells.map((c, j) => {
      const v = c.trim().replace(/^"(.*)"$/, '$1')
      const cls = t.cols[j]
      if (!cls || !v || PLACEHOLDER.test(v) || idOnly(t.names[j], cls, v)) return c
      hit(cls)
      return c.replace(c.trim(), mask(cls, v))
    }).join(t.sep)
  }
  return lines.join('\n')
}

export function redactText(s: string, strict: boolean, counts: Record<string, number>): string {
  const hit = (cls: string) => { counts[cls] = (counts[cls] || 0) + 1 }
  s = maskTables(s, hit)
  s = s.replace(KV, (m, pre: string, key: string, v: string) => {
    const cls = classify(key)
    if (!cls || PLACEHOLDER.test(v) || (!strict && !/^\\?["']/.test(v) && CODE_LIKE.test(v))) return m
    const q = (v.match(/^\\?["']/) || [''])[0]
    const inner = q ? v.slice(q.length, -q.length) : v
    if (idOnly(key, cls, inner)) return m
    hit(cls)
    return pre + q + mask(cls, inner) + q
  })
  s = s.replace(XML, (m, tag: string, v: string) => {
    const cls = classify(tag)
    if (!cls || PLACEHOLDER.test(v) || idOnly(tag, cls, v)) return m
    hit(cls)
    return `<${tag}>${mask(cls, v)}</${tag}>`
  })
  for (const [cls, re, fn] of TEXT) s = s.replace(re, (...m: any[]) => { hit(cls); return fn(...m) })
  return s.replace(CARD, m => (luhn(m) ? (hit('card'), mask('card', m)) : m))
}

// Base64 blobs (images, binaries) are left alone
const walk = (v: any, f: (s: string) => string): any => typeof v === 'string' ? (v.length > 1000 && /^[A-Za-z0-9+/=\s]+$/.test(v) ? v : f(v))
  : Array.isArray(v) ? v.map(x => walk(x, f))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, f)])) : v

// Tools whose result Claude reads as data. Edits and writes are left out: their result echoes what
// Claude itself sent, and core checks that shape strictly.
export const MASKED_TOOLS = /^(Read|Grep|Glob|LS|NotebookRead|Bash|PowerShell|WebFetch|WebSearch|mcp__.*)$/

// The tool's record with every string masked, and how many values of each kind were masked
export function redactResult(tool: string, filePath: string, record: unknown): { record: unknown; counts: Record<string, number> } {
  const strict = tool === 'Read' && CONFIG.test(filePath.replace(/\\/g, '/'))
  const counts: Record<string, number> = {}
  return { record: walk(record, s => redactText(s, strict, counts)), counts }
}
