import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Registration-completeness lint for scripts/hooks/.
//
// The recurring defect class this pins: a hook ships fully unit-tested but is
// registered NOWHERE, so it never fires in production while its suite stays
// green -- the reply-guard before #1028 registered its decision logic but not
// the Stop wiring, skill-usage-capture (#607) captured nothing for six weeks,
// and the ledger-live-drain never ran while its docs promised a schedule.
// Each was found by hand. This test finds the next one mechanically: every
// shipped hook script must be referenced by at least one REGISTRATION surface,
// or carry an explicit, reasoned exemption below.
//
// Two directions are enforced:
//   - UNWIRED: a hook that is neither registered nor exempted fails the build,
//     so a new hook cannot ship dead.
//   - STALE EXEMPTION: an exempted hook that IS now registered fails the
//     build, so the exemption list cannot rot into a blind spot -- when an
//     in-flight wiring PR lands, its entry must be deleted here.

const ROOT = join(__dirname, '..', '..')
const HOOKS_DIR = join(ROOT, 'scripts', 'hooks')

// Everywhere a hook can legitimately be wired into production, split by WHO
// the surface configures (TGSABLONHOOK921, 2026-09-21):
//
//   SEEDING surfaces configure every agent this install creates from now on:
//   the settings template each agent is seeded from, the code-side
//   registrations (agent-scaffold), and the two installer scripts.
//
//   CHECKOUT surfaces configure exactly ONE agent -- the one whose session cwd
//   is this checkout, i.e. the main agent -- through the repo's own project
//   settings.
//
//   TREEWIDE surfaces configure EVERY agent whose session cwd is anywhere
//   inside this checkout. There is exactly one, and it is the sibling of the
//   checkout surface, which is why it reads like one: measured on Claude Code
//   2.1.261 (BROWSERSCOPE922), `.claude/settings.json` is resolved from the
//   session's cwd, but `.claude/settings.local.json` is resolved from the
//   CANONICAL GIT ROOT. A fleet whose agents live in subdirectories of this
//   repo therefore shares one settings.local.json, while each agent keeps its
//   own settings.json. It is gitignored, so it ships with no install and is
//   not a registration surface here -- but what an operator puts in it reaches
//   every agent, and the test at the bottom of this file pins the one shape
//   that silently breaks when it does.
//
// The two are not interchangeable, and the single concatenated corpus this
// lint used to build treated them as if they were: telegram-reply-directive.py
// was registered in .claude/settings.json (one agent) and absent from the
// template (every seeded agent), and the lint stayed green because "somewhere"
// was satisfied by the main agent's own file. Every newly seeded Telegram
// agent started without the hook: it composed its reply, wrote it into its
// tmux pane, never called the reply tool, and the owner saw nothing. An
// external install measured this on two agents (2026-09-11/12 and again after
// a 2026-09-14 image swap wiped a hand wiring the template had never carried).
const SEEDING_SURFACES = [
  'templates/settings.json.template',
  'src/web/agent-scaffold.ts',
  'scripts/install-telegram-progress-hook.sh',
  'scripts/install-channel-image-hook.sh',
]
const CHECKOUT_SURFACES = ['.claude/settings.json']
const TREEWIDE_SURFACES = ['.claude/settings.local.json']
const REGISTRATION_SURFACES = [...SEEDING_SURFACES, ...CHECKOUT_SURFACES]

// name -> why it is allowed to be unregistered. Keep every reason concrete;
// "misc" entries defeat the lint.
const EXEMPT: Record<string, string> = {
  'ledger_lib.py':
    'shared library imported by the ledger hooks; not itself a hook',
  'clearstate_lib.py':
    'shared library imported by clear-capture.py / clear-replay.py; not itself a hook',
  'email_extract.py':
    'shared library imported by outgoing-copy-gate.py (and the level-2 email approval gate, EMAILKAPU901 PR2); not itself a hook',
  'memory-save.sh':
    'legacy: referenced only by a historical rebuild prompt, wired nowhere; kept pending a maintainer decision to remove it',
  'telegram-ack.py':
    'unreferenced anywhere in the repo; dead code kept pending a maintainer decision to remove it',
  'telegram_fallback_send.py':
    'agent-invoked CLI (manual Bot API fallback sender, see scripts/lib/send-telegram.sh), not a settings hook; since #1305 the progress installer no longer copies or names it',
  'channel-process-gate.py':
    'scheduled/CLI gate (--only / --notify / --json), not a settings hook: it compares the channels a session DECLARES against the plugin processes actually alive under it, which is a periodic check rather than a per-tool-call one',
  'telegram-image-resize.sh':
    'legacy predecessor of channel-image-resize.sh; only its old installer migration path named it, and since #1305 that installer is a no-op stub -- kept pending a maintainer decision to remove it',
  'browser-content-notice.py':
    'OPT-IN by construction (BROWSERNOTICE920): it envelopes browser-MCP / WebSearch payloads as untrusted content, and an install without a browser MCP server gains nothing from it, so no SHIPPED surface wires it and this entry stays. What BROWSERSCOPE922 corrected is the second half of the old reason, "operators add it to their own PostToolUse hooks": the natural place for that, this checkout\'s gitignored .claude/settings.local.json, is a TREEWIDE surface (see the header) -- it fires on every agent whose cwd is inside the repo, not just the one that wired it. So the opt-in is repo-wide, and its command must be an absolute path; the $CLAUDE_PROJECT_DIR form the docs used to prescribe resolved to each sub-agent\'s own directory and died there silently, on 78 measured browser calls across two sub-agents in one day (2026-09-21). Procedure: docs/security-hardening.md.',
  'mio-orszem-precheck.sh':
    'scheduler preCheck for the HOST-LOCAL marveen-io-kozosseg-orszem task (ORSICTX912): the mio community sentinel is this install\'s own and deliberately NOT seeded (a repo seed would ship it to every customer install), so its registration lives in the host ~/.claude/scheduled-tasks task-config -- outside this corpus by design. Wiring is gated on the ORSICTX912 activation order (host restart -> verify -> merge -> build+restart); the hermetic fail-direction tests are scripts/__tests__/mio-orszem-precheck.test.py.',
}

function readSurfaces(rels: readonly string[]): string {
  let corpus = ''
  for (const rel of rels) {
    const p = join(ROOT, rel)
    if (existsSync(p)) corpus += readFileSync(p, 'utf-8')
  }
  return corpus
}

// The seeded scheduled tasks count as a registration too (a script may be
// driven by a schedule instead of a hook event), and they reach every install,
// so they sit in the general corpus -- but they are not a settings surface, so
// they play no part in the checkout-vs-seeding comparison below.
function scheduledTasksCorpus(): string {
  let corpus = ''
  const tasksDir = join(ROOT, 'scheduled-tasks')
  if (existsSync(tasksDir)) {
    for (const task of readdirSync(tasksDir)) {
      const skill = join(tasksDir, task, 'SKILL.md')
      if (existsSync(skill)) corpus += readFileSync(skill, 'utf-8')
      // A task's preCheck script is a schedule registration too: the scheduler
      // runs it on every tick (ledger-live-drain-precheck.sh).
      const config = join(tasksDir, task, 'task-config.json')
      if (existsSync(config)) corpus += readFileSync(config, 'utf-8')
    }
  }
  return corpus
}

function registrationCorpus(): string {
  return readSurfaces(REGISTRATION_SURFACES) + scheduledTasksCorpus()
}

// Hooks wired ONLY in the checkout's own project settings, each with the
// verified reason it is main-agent-only by design and must NOT be seeded to
// every agent. Keep every reason concrete and sourced (docstring, docs, PR):
// a "misc" entry here would re-open exactly the blind spot this split closes.
const CHECKOUT_ONLY: Record<string, string> = {
  'email-approval-gate.py':
    'level-aware email gate for the MAIN agent (EMAILKAPU901 PR2, #1149): its docstring scopes it to sessions rooted at PROJECT_ROOT, and sub-agents keep their unconditional hard-deny (email-send-gate.mjs), behind which this gate would be a no-op',
  'inbox-drain.py':
    'main-agent inbox PULL (#506): sub-agents are fed by the message router\'s tmux-push path, and draining them here too would double-deliver (docstring: "Main-agent ONLY")',
  'ledger-capture.py':
    'conversation-continuity ledger: docs/conversation-continuity.md wires the ledger trio in the PROJECT settings for the main channels session ("NOT user scope"); the sub-agent path is the clear-capture/clear-replay pair, which IS in the template',
  'ledger-outbound.py':
    'conversation-continuity ledger: same design as ledger-capture.py (docs/conversation-continuity.md, project settings only)',
  'ledger-replay.py':
    'conversation-continuity ledger: same design as ledger-capture.py; the docs state it is "wired in the repo\'s project settings only (the main agent)"',
  'telegram-reply-guard.py':
    'the Stop-hook half of the Telegram reply enforcement (#856) decides from ledger_lib.open_question_with_age, i.e. the conversation_log the main-only ledger trio writes; seeded alone it would read an empty ledger and allow every stop, a silent no-op -- seeding it means seeding the ledger trio with it, a separate design decision',
}

// The direction that was blind: a hook the checkout's own settings wire, which
// no seeding surface carries and no entry explains. Pure so the mechanism can
// be tested on synthetic corpora, independent of the repo's current state.
export function unseededCheckoutHooks(
  names: readonly string[],
  checkoutCorpus: string,
  seedingCorpus: string,
  checkoutOnly: Record<string, string>,
): string[] {
  return names.filter(
    (name) => isRegistered(checkoutCorpus, name) && !(name in checkoutOnly) && !isRegistered(seedingCorpus, name),
  )
}

// A reference is a PATH ("/name") or a quoted token ("'name'" / "\"name\"") --
// never a bare substring, so "channel-inbox-drain.py" cannot satisfy
// "inbox-drain.py".
function isRegistered(corpus: string, name: string): boolean {
  return corpus.includes(`/${name}`) || corpus.includes(`'${name}'`) || corpus.includes(`"${name}"`)
}

function hookScripts(): string[] {
  return readdirSync(HOOKS_DIR)
    .filter((f) => f.endsWith('.py') || f.endsWith('.mjs') || f.endsWith('.sh'))
    .sort()
}

describe('hook registration completeness (scripts/hooks/)', () => {
  const corpus = registrationCorpus()

  it('every shipped hook is registered on some production surface, or reasoned-exempt', () => {
    const unwired = hookScripts().filter(
      (name) => !(name in EXEMPT) && !isRegistered(corpus, name),
    )
    expect(unwired, `unregistered hooks with no exemption: ${unwired.join(', ')} -- wire them or add a reasoned EXEMPT entry`).toEqual([])
  })

  it('no exemption has gone stale (an exempted hook that is now registered must drop its entry)', () => {
    const stale = Object.keys(EXEMPT).filter((name) => isRegistered(corpus, name))
    expect(stale, `stale exemptions (now registered): ${stale.join(', ')} -- delete their EXEMPT entries`).toEqual([])
  })

  it('every exemption points at a file that still exists (no ghost entries)', () => {
    const ghosts = Object.keys(EXEMPT).filter((name) => !existsSync(join(HOOKS_DIR, name)))
    expect(ghosts).toEqual([])
  })

  it('the boundary rule rejects substring matches (the channel-inbox-drain trap)', () => {
    expect(isRegistered('scripts/hooks/channel-inbox-drain.py', 'inbox-drain.py')).toBe(false)
    expect(isRegistered('scripts/hooks/inbox-drain.py', 'inbox-drain.py')).toBe(true)
    expect(isRegistered("join(PROJECT_ROOT, 'scripts', 'hooks', 'egress-gate.mjs')", 'egress-gate.mjs')).toBe(true)
  })
})

describe('seeding vs checkout surfaces (TGSABLONHOOK921: the main agent\'s own settings must not vouch for every other agent)', () => {
  const seeding = readSurfaces(SEEDING_SURFACES)
  const checkout = readSurfaces(CHECKOUT_SURFACES)

  it('every hook wired in the checkout\'s own settings is also on a SEEDING surface, or reasoned CHECKOUT_ONLY', () => {
    const unseeded = unseededCheckoutHooks(hookScripts(), checkout, seeding, CHECKOUT_ONLY)
    expect(
      unseeded,
      `hooks wired only for the checkout's own agent, so every newly seeded agent starts without them: ${unseeded.join(', ')} -- add them to templates/settings.json.template (or agent-scaffold), or add a reasoned CHECKOUT_ONLY entry`,
    ).toEqual([])
  })

  it('no CHECKOUT_ONLY entry has gone stale (a hook that is now seeded must drop its entry)', () => {
    const stale = Object.keys(CHECKOUT_ONLY).filter((name) => isRegistered(seeding, name))
    expect(stale, `stale CHECKOUT_ONLY entries (now seeded): ${stale.join(', ')}`).toEqual([])
  })

  it('every CHECKOUT_ONLY entry names a hook that exists AND is actually wired in the checkout settings', () => {
    const ghosts = Object.keys(CHECKOUT_ONLY).filter((name) => !existsSync(join(HOOKS_DIR, name)))
    expect(ghosts, `CHECKOUT_ONLY entries with no file: ${ghosts.join(', ')}`).toEqual([])
    const unwired = Object.keys(CHECKOUT_ONLY).filter((name) => !isRegistered(checkout, name))
    expect(unwired, `CHECKOUT_ONLY entries not wired in .claude/settings.json at all: ${unwired.join(', ')}`).toEqual([])
  })

  it('the mechanism flags a checkout-only hook on synthetic corpora, and stops flagging it once seeded', () => {
    // Independent of the repo's current state: this is what makes the
    // template revocation red (see the PR's gate), not the current file set.
    const names = ['a.py', 'b.py', 'c.py']
    const checkoutCorpus = 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/a.py"\nscripts/hooks/b.py\n'
    const seededA = "bash -c '[ -f {{PROJECT_ROOT}}/scripts/hooks/a.py ] && exec python3 {{PROJECT_ROOT}}/scripts/hooks/a.py; exit 0'"
    expect(unseededCheckoutHooks(names, checkoutCorpus, '', {})).toEqual(['a.py', 'b.py'])
    expect(unseededCheckoutHooks(names, checkoutCorpus, seededA, {})).toEqual(['b.py'])
    expect(unseededCheckoutHooks(names, checkoutCorpus, seededA, { 'b.py': 'main-only by design' })).toEqual([])
    // A hook the checkout does not wire is nobody's problem here (c.py).
    expect(unseededCheckoutHooks(names, checkoutCorpus, '', { 'a.py': 'x', 'b.py': 'y' })).toEqual([])
  })
})

// A TREEWIDE surface reaches every agent in the tree, but each hook process
// still gets CLAUDE_PROJECT_DIR = its OWN session cwd. A command that resolves
// its script through that variable therefore works only for the agent rooted at
// the checkout and breaks for every other one -- silently, because a failed
// PostToolUse hook is an execution-error record, not part of the tool result
// the model sees. Pure, so the mechanism is pinned on synthetic input rather
// than on whether the machine running the suite happens to have the file.
export function projectDirBoundCommands(commands: readonly string[]): string[] {
  return commands.filter((c) => c.includes('scripts/hooks/') && /\$\{?CLAUDE_PROJECT_DIR\b/.test(c))
}

function treewideHookCommands(): string[] {
  const commands: string[] = []
  for (const rel of TREEWIDE_SURFACES) {
    const path = join(ROOT, rel)
    if (!existsSync(path)) continue
    // Not wrapped in try/catch on purpose: a settings file this checkout
    // cannot parse is a finding, not something to skip past quietly.
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    const hooks = (parsed as { hooks?: unknown }).hooks
    if (typeof hooks !== 'object' || hooks === null) continue
    for (const matchers of Object.values(hooks as Record<string, unknown>)) {
      if (!Array.isArray(matchers)) continue
      for (const matcher of matchers) {
        const entries = (matcher as { hooks?: unknown }).hooks
        if (!Array.isArray(entries)) continue
        for (const entry of entries) {
          const command = (entry as { command?: unknown }).command
          if (typeof command === 'string') commands.push(command)
        }
      }
    }
  }
  return commands
}

describe('tree-wide surface (BROWSERSCOPE922: settings.local.json is read from the GIT ROOT, so it configures every agent in the tree)', () => {
  it('the mechanism flags a $CLAUDE_PROJECT_DIR-bound hook command, and clears an absolute one', () => {
    const bound = 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/browser-content-notice.py"'
    const braced = 'python3 "${CLAUDE_PROJECT_DIR}/scripts/hooks/browser-content-notice.py"'
    const absolute = "bash -c '[ -f /srv/marveen/scripts/hooks/browser-content-notice.py ] && exec python3 /srv/marveen/scripts/hooks/browser-content-notice.py; exit 0'"
    expect(projectDirBoundCommands([bound, braced, absolute])).toEqual([bound, braced])
    expect(projectDirBoundCommands([absolute])).toEqual([])
    // The variable is only a problem for a script this repo ships; an
    // operator's own unrelated command is none of this lint's business.
    expect(projectDirBoundCommands(['echo "$CLAUDE_PROJECT_DIR"'])).toEqual([])
  })

  it('this checkout wires no scripts/hooks script through $CLAUDE_PROJECT_DIR in a tree-wide surface', () => {
    // Vacuously true on a fresh clone (the file is gitignored and absent);
    // it bites on the installs that actually wire the opt-in hook.
    const bound = projectDirBoundCommands(treewideHookCommands())
    expect(
      bound,
      `tree-wide hook commands bound to $CLAUDE_PROJECT_DIR: ${bound.join(' | ')} -- ${TREEWIDE_SURFACES.join(', ')} is read from the git root, so this resolves to each agent's OWN directory and the hook dies silently for every agent but the checkout's. Use an absolute path, guarded: bash -c '[ -f <abs> ] && exec python3 <abs>; exit 0'`,
    ).toEqual([])
  })
})
