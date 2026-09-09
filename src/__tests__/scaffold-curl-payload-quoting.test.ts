// Regression test for CURLQUOTE909.
//
// Both curl examples the scaffold writes into every agent CLAUDE.md used to
// pass their JSON payload inside a DOUBLE-quoted shell string. zsh expands
// backticks and $(...) in that position, so a payload carrying a filename in
// backticks or a command substitution -- which fleet reports always do -- was
// silently emptied before the request left the shell. The dashboard answered
// 200, so nothing surfaced the loss.
//
// The stranger-sender example was the worse of the two: its payload quotes an
// excerpt of an UNKNOWN sender's message, i.e. the template itself instructed
// the agent to paste foreign text into an expanding shell string.
//
// These assertions lock the quoting shape, which no existing test covered.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { readFileSync as read } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-curlquote-test-'))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  AGENT_API_ORIGIN: '',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
  agentConfigRoot: () => join(tmpRoot, 'agents'),
  listAgentNames: () => ['agent-a', 'agent-b'],
  readAgentCapabilities: () => [],
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureAutonomySection } = await import('../web/agent-scaffold.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAFFOLD_PATH = join(__dirname, '..', 'web', 'agent-scaffold.ts')

describe('generated autonomy block: curl payload cannot be expanded by the shell', () => {
  it('the level 1 example passes its payload in single quotes, not double quotes', () => {
    const dir = join(tmpRoot, 'agents', 'quoting-agent')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'CLAUDE.md')
    writeFileSync(path, '# Agent\n', 'utf-8')

    ensureAutonomySection('quoting-agent')
    const written = readFileSync(path, 'utf-8')

    // The failing shape: -d "{ ... }" -- backticks and $(...) expand inside it.
    expect(written).not.toContain('-d "{')
    // The correct shape, already used by the level 2 example three lines below.
    expect(written).toContain(`-d '{"from":"quoting-agent"`)
    // The token read in the header is SUPPOSED to interpolate; do not break it.
    expect(written).toContain('$(cat ')
  })
})

describe('generateClaudeMd prompt: stranger-sender example is expansion-proof', () => {
  const src = read(SCAFFOLD_PATH, 'utf-8')
  const start = src.indexOf('export async function generateClaudeMd')
  const end = src.indexOf('export async function generateSoulMd')

  it('no curl example anywhere in the scaffold passes -d inside double quotes', () => {
    expect(src).not.toContain('-d "{')
  })

  it('the stranger-sender payload rides a quoted heredoc, so foreign text cannot expand', () => {
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const prompt = src.slice(start, end)
    const blockStart = prompt.indexOf('## Új ismeretlen sender első üzenete')
    expect(blockStart).toBeGreaterThan(0)
    const rest = prompt.slice(blockStart + 5)
    const nextHeader = rest.indexOf('\n## ')
    const block = prompt.slice(blockStart, blockStart + 5 + (nextHeader > 0 ? nextHeader : rest.length))

    // A quoted heredoc delimiter interpolates nothing -- this is the property
    // that makes the shape of the unknown sender's message irrelevant.
    expect(block).toContain("--data-binary @- <<'JSON'")
    // Single quotes alone would NOT do here: the payload quotes the sender's
    // excerpt and already contains apostrophes.
    expect(block).toContain("'[üzenet röviden]'")
  })
})
