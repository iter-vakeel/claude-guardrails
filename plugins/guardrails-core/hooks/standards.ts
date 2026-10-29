// Banner shown to the developer at session start (the transcript). Edit here; it reaches every
// machine with the next plugin update. The standards for Claude live in the org policy's claudeMd
// (policy/managed-settings.json), because a plugin cannot add them to Claude's context.

export const BANNER = [
  '╔══════════════════════════════════════════════════════════════════════════════╗',
  '║  ITERFORGE ENGINEERING                                                       ║',
  '║  CONFIDENTIAL  ·  AUTHORISED USE ONLY                                        ║',
  '╠══════════════════════════════════════════════════════════════════════════════╣',
  '║  ▸  Claude Code acts with your identity and your privileges.                 ║',
  '║     Its actions are yours.                                                   ║',
  '║  ▸  Never expose confidential or personal information.                       ║',
  '║     One disclosure is a breach.                                              ║',
  '║  ▸  Grant permissions deliberately. Convenience is no defence.               ║',
  '║  ▸  Consequences are reputational, contractual and legal,                    ║',
  '║     for you, the company and our clients.                                    ║',
  '║  ▸  A red or yellow risk dialog means an action uses secrets or personal     ║',
  '║     data or breaks policy. Read it before you accept: the risk is then yours.║',
  '╚══════════════════════════════════════════════════════════════════════════════╝',
].join('\n')
