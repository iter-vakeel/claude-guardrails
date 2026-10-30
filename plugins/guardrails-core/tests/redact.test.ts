import { expect, test } from 'claude-code/testing'

import { classify, redactResult } from '../hooks/redact'

// Test data only: built at run time so no secret-looking literal sits in the repository
const PW = ['pass', 'word'].join('')
const FAKE = 'Xq7' + 'fake9'
const bash = (stdout: string) => ({ stdout, stderr: '', interrupted: false, isImage: false })
const masked = (tool: string, record: unknown, filePath = '') => redactResult(tool, filePath, record).record as any

test('field names are classified in any project and spelling', () => {
  for (const k of ['firstName', 'CUSTOMER_FIRST_NAME', 'last_name_lowercase', 'emailId', 'mobileNumber', 'lineAddress1', 'streetAddr', 'zipCode', 'postalCode', 'dateOfBirth'])
    expect(classify(k)).not.toBeNull()
  for (const k of ['tvsProfileId', 'cart_id', 'ORDER_NUMBER', 'eventId', 'emailTypeCode', 'addressType', 'ipAddress', 'phoneVerified', 'displayName', 'passwordLastModifiedDate'])
    expect(classify(k)).toBeNull()
})

test('a properties file keeps its shape: secrets and usernames masked, other keys and placeholders kept', () => {
  const content = [`spring.datasource.${PW}=${FAKE}`, 'spring.datasource.username=app_user', 'server.port=8080', `db.${PW}=\${DB_PW}`].join('\n')
  const out = masked('Read', { type: 'text', file: { filePath: 'application.properties', content, numLines: 4 } }, 'application.properties')
  expect(out.file.content).not.toContain(FAKE)
  expect(out.file.content).not.toContain('app_user')
  expect(out.file.content).toContain('server.port=8080')
  expect(out.file.content).toContain('${DB_PW}')
  expect(out.file.numLines).toBe(4)
})

test('a log record: personal data masked with its shape, every ID and description kept', () => {
  const rec = { tvsProfileId: 'u1234567890', cart_id: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b', ORDER_NUMBER: 'WO12345678', eventId: 'evt-77',
    lineAddress1: '12 oak lane apt 4', emailId: 'jane@example.com', mobileNumber: '5551234567', CUSTOMER_FIRST_NAME: 'Jane',
    zipCode: '10001', emailTypeCode: 'PRIMARY', ipAddress: '10.0.0.1', addressId: '48213' }
  const out = masked('mcp__datadog__search_datadog_logs', [{ type: 'text', text: JSON.stringify(rec) }])[0].text
  for (const leak of ['12 oak lane', 'jane@', '5551234567', '"Jane"', '10001']) expect(out).not.toContain(leak)
  for (const kept of ['u1234567890', '0f1e2d3c-4b5a', 'WO12345678', 'evt-77', 'PRIMARY', '10.0.0.1', '48213']) expect(out).toContain(kept)
  expect(out).toContain('[email @example.com]')
  expect(out).toContain('[phone 10 digits]')
  expect(out).toContain('[zip 5 digits]')
})

test('DB result tables and CSV exports are masked by column header', () => {
  const table = ' order_id   | first_name | phone      | address_1\n------------+------------+------------+-----------\n WO12345678 | Jane       | 5551234567 | 12 oak lane apt 4'
  const csv = 'id,firstName,lastName,email,phone\n7,Jane,Doe,jane@x.io,5551234567'
  for (const text of [table, csv]) {
    const out = masked('Bash', bash(text)).stdout
    for (const leak of ['Jane', 'Doe', '5551234567', 'oak lane', 'jane@']) expect(out).not.toContain(leak)
  }
  expect(masked('Bash', bash(table)).stdout).toContain('WO12345678')
})

test('a card keeps brand and last 4; XML and kubeconfig credentials are masked', () => {
  const txt = `paid with 4111 1111 1111 1111\n<server><username>svc_build</username><${PW}>${FAKE}</${PW}></server>\nclient-key-data: LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQo=`
  const out = masked('Bash', bash(txt)).stdout
  expect(out).toContain('[card visa …1111]')
  for (const leak of ['4111 1111', 'svc_build', FAKE, 'LS0tLS1CRUdJTi']) expect(out).not.toContain(leak)
})

test('source code stays readable: code expressions kept, a hard-coded literal masked', () => {
  const content = `${PW} = request.getP();\nString ${PW} = "${FAKE}";`
  const out = masked('Read', { type: 'text', file: { filePath: 'A.java', content } }, 'A.java').file.content
  expect(out).toContain('request.getP()')
  expect(out).not.toContain(FAKE)
})

test('nothing sensitive: the record comes back unchanged', () => {
  const r = redactResult('Bash', '', bash('origin git@github.com:org/repo.git (fetch)\nBUILD SUCCESSFUL in 3s'))
  expect(r.counts).toEqual({})
})

test('through the hook: Claude reads the masked result, and gets a note saying so', async ($, on) => {
  // These hooks stand for the engine: the session's folder, and a tool that "ran" and returned customer data
  on('session.cwd', () => ({ value: '/' }))
  on('tool.call', () => ({ result: bash('Customer(firstName=Jane Doe, orderId=WO12345678) email=jane@x.io status=OK') }))
  const r: any = await $.tool.call({ tool: 'Bash', command: 'kubectl logs cart-service' })
  expect(r.result.stdout).not.toContain('Jane')
  expect(r.result.stdout).not.toContain('jane@x.io')
  expect(r.result.stdout).toContain('orderId=WO12345678')
  expect(r.result.stdout).toContain('status=OK')
  expect(r.context?.join(' ')).toContain('masked')
})
