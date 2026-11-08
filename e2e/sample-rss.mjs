// Peak memory of each process of a run, and any socket it opens to the outside. A run's processes are the ones with
// E2E_RUN=<id> in their environment (see run.sh), found afresh every second: Chromium's and workerd's children come and
// go, and each keeps its last VmHWM after it exits.
// Chromium rewrites its environ area, so its processes are found by the state dir in their command line and by their
// parent chain.
//   node sample-rss.mjs <run id> <state dir> <table file> <outside sockets file>
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

const [run, stateDir, tableFile, outsideFile] = process.argv.slice(2)
const mark = `E2E_RUN=${run}`
const pids = new Map() // pid -> { name, hwmKb }
const outside = new Set()
const sh = promisify(execFile)

function read(path) {
  try {
    return readFileSync(path, 'latin1')
  } catch {
    return null
  }
}

function nameOf(pid) {
  const cmd = (read(`/proc/${pid}/cmdline`) ?? '').replaceAll('\0', ' ')
  if (cmd.includes('sample-rss.mjs')) return 'sampler (node)'
  if (cmd.includes('fake-siteverify')) return 'fake siteverify (node)'
  if (cmd.includes('harness.mjs')) return 'harness (node)'
  if (/^\S*bash /.test(cmd)) return 'bash (run.sh)'
  if (/workerd/.test(cmd.split(' ')[0] ?? '')) return 'workerd'
  if (/\bvite(\.js)?\b/.test(cmd)) return 'vite preview (node)'
  if (/wrangler/.test(cmd)) return 'wrangler (node)'
  if (/headless[_-]shell/.test(cmd)) {
    const type = /--type=([a-z-]+)/.exec(cmd)?.[1]
    return `chromium ${type ?? 'browser'}`
  }
  return cmd.split(' ').slice(0, 2).join(' ') || `pid ${pid}`
}

// Short-lived helpers run.sh spawns while waiting: not processes anybody needs a peak for.
const HELPERS = /^(sleep|curl|grep|ss|tee|cat|tr|sed|tail) /

function scan() {
  const all = readdirSync('/proc').filter((e) => /^\d+$/.test(e))
  const parent = new Map()
  const found = new Set()
  for (const pid of all) {
    const stat = read(`/proc/${pid}/stat`)
    const ppid = stat && /\) \S+ (\d+)/.exec(stat)?.[1]
    if (ppid) parent.set(pid, ppid)
    const env = read(`/proc/${pid}/environ`)
    const cmd = (read(`/proc/${pid}/cmdline`) ?? '').replaceAll('\0', ' ')
    if (env?.split('\0').includes(mark) || cmd.includes(stateDir)) found.add(pid)
  }
  // Renderer, GPU and utility processes carry neither mark: they are children of the browser that was just found.
  for (let grew = true; grew; ) {
    grew = false
    for (const [pid, ppid] of parent) {
      if (!found.has(pid) && found.has(ppid)) {
        found.add(pid)
        grew = true
      }
    }
  }
  for (const pid of found) {
    if (pid === String(process.pid)) continue
    const status = read(`/proc/${pid}/status`)
    const hwm = status && /VmHWM:\s+(\d+) kB/.exec(status)
    if (!hwm) continue
    const name = nameOf(pid)
    if (HELPERS.test(name)) continue
    const seen = pids.get(pid)
    const kb = Number(hwm[1])
    if (seen) seen.hwmKb = Math.max(seen.hwmKb, kb)
    else pids.set(pid, { name, hwmKb: kb })
  }
}

async function sockets() {
  // ss lists the sockets of every process that shows up; only the run's are kept. A short connection can slip between
  // two samples, so this is a net, not a proof (the browser's own counter in harness.mjs is exact).
  let out
  try {
    out = (await sh('ss', ['-tanpH'], { maxBuffer: 8 * 1024 * 1024 })).stdout
  } catch {
    return
  }
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 6 || cols[0] === 'LISTEN') continue
    const peer = cols[4]
    if (/^(127\.|\[::1\]|\[::ffff:127\.|0\.0\.0\.0:\*|\[::\]:\*|\*:\*)/.test(peer)) continue
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      if (pids.has(m[1])) outside.add(`${pids.get(m[1]).name} pid ${m[1]} -> ${peer} (${cols[0]})`)
    }
  }
}

const mb = (kb) => (kb / 1024).toFixed(0).padStart(6)
function report() {
  const byName = new Map()
  for (const { name, hwmKb } of pids.values()) {
    const g = byName.get(name) ?? { n: 0, max: 0, sum: 0 }
    g.n++
    g.max = Math.max(g.max, hwmKb)
    g.sum += hwmKb
    byName.set(name, g)
  }
  const rows = [...byName].sort(([, a], [, b]) => b.max - a.max)
  const lines = rows.map(([name, g]) => `${mb(g.max)} MB  ${name}${g.n > 1 ? ` (${g.n} processes, ${(g.sum / 1024).toFixed(0)} MB together)` : ''}`)
  writeFileSync(tableFile, lines.join('\n') + '\n')
  writeFileSync(outsideFile, outside.size ? [...outside].join('\n') + '\n' : '')
}

let stopping = false
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    if (stopping) return
    stopping = true
    scan()
    report()
    process.exit(0)
  })
}

setInterval(() => {
  scan()
  void sockets()
}, 1000)
scan()
