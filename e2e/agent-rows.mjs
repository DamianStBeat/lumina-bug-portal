// Rows 3 and 6: the real agent (`python3 -m lumina_bug_agent run-once`, DRY_RUN=0) against the real worker, with the
// outside faked: `claude` and `gh` first on PATH (e2e/fakes, answering from the round's scenario), a local bare repo as
// the fork, the fake red team and git-workspace. Real ffmpeg and ffprobe on a real tiny mp4.
// Run from harness.mjs, which passes its helpers (h): the browser, the API calls, the one-line assertions.
import { execFile } from 'node:child_process'
import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const FAKES = path.join(HERE, 'fakes')
const AGENT_DIR = path.join(ROOT, 'agent')

// Row 6 (and the agent's own failure handling) never needs one this long: a round that takes this long is hung.
const ROUND_MS = 240_000

// A Lumina2 of two files: enough for stage B's worktree and stage C's commit, push and PR. No network: `fork` is a bare
// repo on this disk, and the agent is only ever pointed at it.
async function makeLumina2(dir) {
  const fork = path.join(dir, 'fork.git')
  const repo = path.join(dir, 'Lumina2')
  const seed = path.join(dir, 'seed')
  const git = (args, cwd) => run('git', args, { cwd, env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' } })
  await git(['init', '-q', '--bare', '-b', 'main', fork])
  await git(['init', '-q', '-b', 'main', seed])
  await fs.mkdir(path.join(seed, 'src/Shared'), { recursive: true })
  await fs.writeFile(path.join(seed, 'src/Shared/Greeting.luau'), 'return "Hello"\n')
  await fs.writeFile(path.join(seed, 'default.project.json'), '{ "name": "Lumina2", "tree": { "$className": "DataModel" } }\n')
  await git(['add', '--', 'src/Shared/Greeting.luau', 'default.project.json'], seed)
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture'], seed)
  await git(['push', '-q', fork, 'main'], seed)
  await fs.rm(seed, { recursive: true, force: true })
  await git(['clone', '-q', '-o', 'fork', fork, repo])
  return { fork, repo, git }
}

async function makeRig(h) {
  const dir = path.join(h.STATE, 'agent')
  const home = path.join(dir, 'home')
  const tmp = path.join(dir, 'tmp')
  const worktrees = path.join(dir, 'worktrees')
  const stateDir = path.join(dir, 'state')
  for (const d of [home, tmp, worktrees, stateDir]) await fs.mkdir(d, { recursive: true })
  const { fork, repo, git } = await makeLumina2(dir)
  const envFile = path.join(h.STATE, 'agent.env')
  // Every optional path is pointed inside the run's temp folder: nothing here may fall back to a default in $HOME.
  await fs.writeFile(
    envFile,
    [
      `PORTAL_API_BASE=${h.API}`,
      `AGENT_KEY=${h.AGENT_KEY}`,
      `LUMINA2_REPO=${repo}`,
      'DAILY_TRIAGE_CAP=40',
      'DAILY_FIX_CAP=5',
      'POLL_SECONDS=120',
      'DRY_RUN=0',
      `STATE_DIR=${stateDir}`,
      `TMP_ROOT=${tmp}`,
      `WORKTREE_ROOT=${worktrees}`,
      `GIT_WORKSPACE=${path.join(FAKES, 'git-workspace')}`,
      `REDTEAM_SCRIPT=${path.join(FAKES, 'redteam.sh')}`,
      // One agent, one report per round (see `drain` below), so a scenario is that round's and no other report's.
      'MAX_REPORTS_PER_ROUND=50',
      'FORK_REMOTE=fork',
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
  let rounds = 0
  return {
    fork,
    git,
    /** One round: the scenario the fakes answer from, the real agent, its log. Resolves with the round's stderr text. */
    async round(name, scenario) {
      rounds++
      await fs.writeFile(path.join(home, 'scenario.json'), JSON.stringify(scenario))
      await fs.rm(path.join(home, 'calls.jsonl'), { force: true })
      const logFile = path.join(h.LOGS, `agent-${name}.log`)
      const log = createWriteStream(logFile)
      // HOME is the rig's: the fakes find the scenario through it (the agent gives them no other variable).
      const env = {
        PATH: `${FAKES}:${process.env.PATH}`,
        HOME: home,
        USER: process.env.USER ?? 'damian',
        LANG: 'C.UTF-8',
        TERM: 'dumb',
        TMPDIR: tmp,
        GIT_CONFIG_NOSYSTEM: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        E2E_RUN: process.env.E2E_RUN,
      }
      const child = execFile('python3', ['-m', 'lumina_bug_agent', '--env-file', envFile, 'run-once'], {
        cwd: AGENT_DIR,
        env,
        timeout: ROUND_MS,
        killSignal: 'SIGKILL',
      })
      let stderr = ''
      child.stderr.on('data', (c) => {
        stderr += c
        log.write(c)
      })
      child.stdout.on('data', (c) => log.write(c))
      const code = await new Promise((resolve) => child.on('close', resolve))
      await new Promise((resolve) => log.end(resolve))
      if (code !== 0) h.fail(`agent round ${name} exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`)
      return stderr
    },
    async calls() {
      const text = await fs.readFile(path.join(home, 'calls.jsonl'), 'utf8').catch(() => '')
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    },
  }
}

export function makeAgentRows(h) {
  const { API, must, eq, fail, until, gameReport, deskStatus, agentReport, openPage, deskSameSite } = h
  const agentHeaders = { Authorization: `Bearer ${h.AGENT_KEY}` }

  let rigPromise
  const rig = () => (rigPromise ??= makeRig(h))

  // Earlier rows leave `received` reports behind (row 9's waiting ones, row 8's): closed through the desk, so the only
  // report in the agent's queue during a round is the one the round is about, and the fakes' scenario is its own.
  async function drain() {
    for (;;) {
      const { reports } = await must('GET', `${API}/agent/queue?limit=50`, { headers: agentHeaders }, 200)
      if (reports.length === 0) return
      for (const r of reports) await deskStatus(r.code, { status: 'closed' })
    }
  }

  async function events(code) {
    const all = []
    for (let after = 0; ; ) {
      const page = await must('GET', `${API}/agent/events?after=${after}&limit=500`, { headers: agentHeaders }, 200)
      if (page.events.length === 0) return all.filter((e) => e.code === code)
      all.push(...page.events)
      after = page.last
    }
  }

  async function makeMp4() {
    const file = path.join(h.STATE, 'row3-clip.mp4')
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-threads', '2', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', file])
    return { path: file, bytes: await fs.readFile(file) }
  }

  // A site report as the form makes it (row 1 proves the form itself): its own CF-Connecting-IP, because a run's other
  // rows use 4 of the 5 hourly web creates per address (CONTRACT.md "Limits").
  async function siteReportWithVideo(what, ip) {
    const video = await makeMp4()
    const created = await must('POST', `${API}/reports`, {
      headers: { 'CF-Connecting-IP': ip },
      json: { what, where: 'match', device: 'phone', lang: 'en', turnstileToken: 'e2e-turnstile-token-row3' },
    }, 201)
    const token = { 'X-Report-Token': created.reportToken }
    const att = await must('POST', `${API}/reports/${created.code}/attachments`, {
      headers: token,
      json: { filename: 'clip.mp4', size: video.bytes.length, mime: 'video/mp4' },
    }, 201)
    eq(att.partCount, 1, 'parts of the tiny video')
    await must('PUT', `${API}/attachments/${att.attachmentId}/parts/1`, { headers: token, body: video.bytes }, 200)
    await must('POST', `${API}/attachments/${att.attachmentId}/complete`, { headers: token }, 200)
    return { code: created.code, attachmentId: att.attachmentId }
  }

  const STAGE_A = {
    what: 'The boss waits forever at the last waypoint of the bridge',
    where: 'match',
    when_in_video: '00:02',
    device: 'phone',
    steps: ['Start a match on the Bridge map', 'Reach the boss wave'],
    expected: 'The boss reaches the base',
    actual: 'The boss stops on the bridge',
    language: 'en',
    injection_suspected: false,
  }

  // Row 3: Report dal sito | giro dell'agente | fogli di fotogrammi caricati, triage visibile nel desk con le 5 righe.
  async function row3() {
    await drain()
    const r = await rig()
    // The report the AI names as the same bug: the agent offers only reports it has seen, so it is another real report.
    const sibling = await gameReport('Row 3 the same bug', 'The boss stopped on the bridge, an earlier report.')
    await deskStatus(sibling, { status: 'closed' })
    const { code } = await siteReportWithVideo('Row 3: the boss stopped on the bridge and the wave never ended.', '203.0.113.33')

    // Before the round the desk says so: no triage is not an empty triage.
    const desk = await openPage(`/desk?code=${code}`, { width: 1440, height: 900 })
    const { page } = desk
    try {
      await deskSameSite(page)
      await page.reload()
      await page.locator('.ai').waitFor()
      eq(await page.locator('.ai li').count(), 0, 'triage rows before the round')
      eq(await page.locator('.frames button').count(), 0, 'frames before the round')
      const empty = (await page.locator('.ai').textContent()).trim()
      if (!empty.includes('The AI has not looked at this report yet.')) fail(`the desk before the round says: ${empty}`)

      const stageB = {
        verdict: 'needs_person',
        confidence: 0.4,
        summary: 'The boss path expects one waypoint too many',
        likely_files: [{ path: 'src/Shared/Greeting.luau', line: 5, why: 'reads the waypoint count' }],
        risk_paths: [],
        duplicate_of: sibling,
        fix_size: 'small',
      }
      await r.round('row3', { stage_a: { object: STAGE_A }, stage_b: { object: stageB } })

      const report = await agentReport(code)
      eq(report.status, 'looking', 'status after the round')
      eq(report.verdict, 'needs_person', 'verdict after the round')
      const frames = report.attachments.filter((a) => a.kind === 'frames')
      if (frames.length === 0) fail(`no frames attachment on ${code}: ${JSON.stringify(report.attachments.map((a) => a.kind))}`)
      for (const f of frames) {
        eq(f.status, 'complete', `frame ${f.id} status`)
        const res = await fetch(`${API}/agent/attachments/${f.id}/download`, { headers: agentHeaders })
        if (res.status !== 200) fail(`download of frame ${f.id} answered ${res.status}`)
        const bytes = Buffer.from(await res.arrayBuffer())
        if (bytes.length < 500 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) fail(`frame ${f.id} is not a JPEG sheet (${bytes.length} bytes)`)
      }
      // The agent's own count of sheets for the video, in the triage it posted: what it says it made is what arrived.
      const entry = report.triage.files[0]
      eq(entry?.status, 'ok', 'video entry in the triage')
      eq(entry.kind, 'video', 'kind of the entry')
      eq(entry.sheets, frames.length, 'sheets the agent counted, against the frames on the worker')
      const stageACall = (await r.calls()).find((c) => c.stage === 'stage_a')
      eq(stageACall?.images, frames.length, 'sheets handed to stage A')

      await page.reload()
      await page.locator('.ai li').first().waitFor()
      const rows = (await page.locator('.ai li').allTextContents()).map((t) => t.trim())
      const labels = rows.map((t) => t.split(':')[0])
      eq(labels.join(','), 'What it is,Likely cause,Risk path,Same bug,Fix', 'the five triage rows of the preview')
      eq(rows[0], `What it is: ${STAGE_A.what}`, 'What it is')
      if (!rows[1].includes(stageB.summary) || !rows[1].includes('src/Shared/Greeting.luau:5')) fail(`Likely cause: ${rows[1]}`)
      eq(rows[2], 'Risk path: none', 'Risk path')
      eq(rows[3], `Same bug: ${sibling}`, 'Same bug')
      eq(rows[4], 'Fix: small', 'Fix')
      eq(await page.locator('.frames button').count(), frames.length, 'frames on the desk')
      await page.locator('.frames img').first().scrollIntoViewIfNeeded()
      await page.waitForFunction(() => {
        const img = document.querySelector('.frames img')
        return img?.complete && img.naturalWidth > 0
      }, null, { timeout: 15_000 })
      await page.screenshot({ path: path.join(h.LOGS, 'row3-desk-1440.png'), fullPage: true })
      return `${code}: ${frames.length} sheet(s) on the worker, ${entry.frames} frames, stage A saw ${stageACall.images}; desk rows: ${labels.join(', ')}`
    } finally {
      await desk.close()
    }
  }

  // Row 6: Una persona segna `fixed` mentre l'agente manda `looking` | giro | resta `fixed`; l'agente riceve
  // `status_changed` e lo annota. Two windows: the triage POST (stage A running) and the status POST of stage C.
  async function row6() {
    const r = await rig()

    // 6a: fixed lands while stage A runs: the agent's triage (expectedStatus "received") is refused.
    await drain()
    const a = await gameReport('Row 6a', 'A person fixes it while the agent reads it.')
    const stageB = {
      verdict: 'needs_person',
      confidence: 0.4,
      summary: 'A person should look',
      likely_files: [],
      risk_paths: [],
      duplicate_of: null,
      fix_size: 'unknown',
    }
    const logA = await r.round('row6a', {
      stage_a: { object: STAGE_A, desk_post: { url: `${API}/desk/reports/${a}/status`, body: { status: 'fixed' } } },
      stage_b: { object: stageB },
    })
    const reportA = await agentReport(a)
    eq(reportA.status, 'fixed', '6a: the row stays fixed')
    eq(reportA.verdict, null, '6a: the refused triage wrote no verdict')
    eq(reportA.triage, null, '6a: the refused triage wrote no triage')
    if (!logA.includes(`status superseded code=${a} current=fixed`)) fail(`6a: no "status superseded" in the agent's log: ${logA.trim().split('\n').slice(-3).join(' | ')}`)
    if (logA.includes(`triaged code=${a}`)) fail('6a: the agent logged a triage the worker refused')
    const evA = await events(a)
    eq(evA.map((e) => e.type).join(), 'created,status_changed', '6a: events of the report')
    eq(evA[1].data.to, 'fixed', '6a: the event is the fixed')
    eq(evA[1].data.by, 'desk', '6a: the person’s write')
    eq(reportA.discord_thread_id, null, '6a: nothing else moved')

    // 6b: fixed lands while the fake gh opens the PR: the status POST `looking` (expectedStatus "looking") is refused.
    await drain()
    const b = await gameReport('Row 6b', 'A person fixes it while the agent opens its PR.')
    const simple = { verdict: 'simple_fix', confidence: 0.9, summary: 'Greeting misses a mark', likely_files: [{ path: 'src/Shared/Greeting.luau', line: 1, why: 'the string' }], risk_paths: [], duplicate_of: null, fix_size: 'small' }
    const logB = await r.round('row6b', {
      stage_a: { object: STAGE_A },
      stage_b: { object: simple },
      builder: { object: { summary: 'edited' }, writes: { 'src/Shared/Greeting.luau': 'return "Hello!"\n' } },
      gh: { desk_post: { url: `${API}/desk/reports/${b}/status`, body: { status: 'fixed' } } },
    })
    const reportB = await agentReport(b)
    eq(reportB.status, 'fixed', '6b: the row stays fixed')
    eq(reportB.pr_url, null, '6b: the refused status left no PR link')
    eq(reportB.verdict, 'simple_fix', '6b: the triage before it stays')
    if (!logB.includes(`status superseded code=${b} current=fixed`)) fail(`6b: no "status superseded" in the agent's log: ${logB.trim().split('\n').slice(-3).join(' | ')}`)
    const evB = await events(b)
    const desk = evB.findIndex((e) => e.type === 'status_changed' && e.data.by === 'desk' && e.data.to === 'fixed')
    if (desk < 0) fail(`6b: no desk fixed event: ${JSON.stringify(evB.map((e) => e.type))}`)
    eq(evB.slice(desk + 1).length, 0, '6b: events after the person’s fixed (no agent write)')
    eq(evB.slice(0, desk).map((e) => e.type).join(), 'created,status_changed,triaged', '6b: the agent’s writes before it')

    // Stage C really reached gh on the local fork, so the refused POST is the one the row is about.
    await r.git(['--git-dir', r.fork, 'rev-parse', '--verify', `refs/heads/bugfix/${b.toLowerCase()}`])
    if (!(await r.calls()).some((c) => c.tool === 'gh')) fail('6b: gh was never called')
    return `${a}: triage refused, ${b}: status refused; both stayed fixed, both logged "status superseded", no agent event after the person's`
  }

  return { row3, row6 }
}
