// Banner shown to the developer at session start (above the prompt, until acknowledged or the first
// prompt). Edit here; it reaches every machine with the next plugin update. The standards for Claude
// live in the org policy's claudeMd (policy/managed-settings.json), because a plugin cannot add them
// to Claude's context.

export type Tone = 'normal' | 'alert' | 'caution' | 'quiet'

export const BANNER: { title: string; subtitle: string; notices: { tone: Tone; text: string }[] } = {
  title: 'ITERFORGE ENGINEERING',
  subtitle: 'CONFIDENTIAL  ·  AUTHORISED USE ONLY',
  notices: [
    { tone: 'normal',  text: 'Claude Code acts with your identity and your privileges. Its actions are yours.' },
    { tone: 'alert',   text: 'Never expose confidential or personal information. One disclosure is a breach.' },
    { tone: 'caution', text: 'Grant permissions deliberately. Convenience is no defence.' },
    { tone: 'normal',  text: 'Consequences are reputational, contractual and legal, for you, the company and our clients.' },
    { tone: 'quiet',   text: 'A 🔴 or 🟡 risk dialog means an action uses secrets or personal data or breaks policy. Read it before you accept: the risk is then yours.' },
  ],
}
