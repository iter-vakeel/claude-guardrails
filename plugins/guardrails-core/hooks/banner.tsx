// Session-start banner, drawn as a bordered, coloured box above the prompt. It stays until the
// developer presses Acknowledge or sends the first prompt of the session.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { BANNER } from './standards'
import type { Tone } from './standards'

const isAcknowledged = atom({ plugin: 'guardrails-core', key: 'bannerAcknowledged' } as const, false)

const TONE: Record<Tone, { color?: string; bold?: boolean; dimColor?: boolean }> = {
  normal:  { color: 'white' },
  alert:   { color: 'red', bold: true },
  caution: { color: 'yellow' },
  quiet:   { dimColor: true },
}

export const registerBanner = (on: Parameters<Register>[0]) => {
  on('prompt.submit', async ($, e, next) => {
    await update($, isAcknowledged, () => true)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isAcknowledged))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}>
        <Text color="cyan" bold>{BANNER.title}</Text>
        <Text color="red" bold>{BANNER.subtitle}</Text>
        <Box flexDirection="column" marginTop={1}>
          {BANNER.notices.map(n => (
            <Box flexDirection="row">
              <Text color="cyan">▸ </Text>
              <Text {...TONE[n.tone]}>{n.text}</Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="row" justifyContent="flex-end">
          <Button key="ack" label="Acknowledge" onPress={() => update($, isAcknowledged, () => true)} />
        </Box>
      </Box>
    )
  })
}
