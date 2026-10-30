/*
 * dsh-buddy-control — DSH as the supervisor of local CodeBuddy / WorkBuddy work.
 *
 * `dsh-console` hands one task to a worker and returns the answer. This bundle
 * adds the half that actually keeps quality up:
 *
 *   buddy_run        dispatch one supervised attempt: model pinned to the newest
 *                    DeepSeek id the worker CLI advertises, task wrapped in the
 *                    acceptance criteria, transcript reduced to one compact JSON.
 *   buddy_review     record DSH's verdict. On reject it sends the revision
 *                    directions back into the SAME worker session (`--resume`),
 *                    so the worker repairs its own output instead of restarting.
 *   buddy_gaps       read the attempt for missing capabilities: auth, executable,
 *                    node package, tool, MCP server, permissions, model, context.
 *   buddy_provision  apply the safe remedies to the worker's own config: MCP
 *                    server, Buddy plugin, trusted directory, model pin, npm pkg.
 *   buddy_status     availability + resolved model + config drift + ledger.
 *
 * Every attempt is persisted under ~/.dsh/buddy-control/runs so a revision can
 * resume the worker's own session and re-run the declared acceptance checks.
 *
 * Token discipline: each tool returns ONE compact JSON object; result text is
 * capped by `maxOutputChars` and transcripts are never forwarded.
 */
import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-buddy-control'

/** Services this plugin consumes from the Cordis context. */
export const inject = ['tools']

const HOME = homedir()
const APP = process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming')

/** Machine-specific defaults; every field is overridable from the profile patch. */
const DEFAULTS = {
  /** Official CodeBuddy CLI installed with `npm i -g @tencent-ai/codebuddy-code`. */
  codebuddyEntry: join(APP, 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
  /** Node used to launch the CodeBuddy JS entry (not the Electron binary). */
  nodePath: process.env.DSH_CONSOLE_NODE ?? 'node',
  /** Per-user CodeBuddy dir holding settings.json / mcp.json / plugins. */
  codebuddyHome: join(HOME, '.codebuddy'),
  /**
   * Optional overrides. Leave empty on purpose: buddy_discover reads the real
   * install location from the registry / candidate roots / PATH, so the same
   * package works on a device that keeps these apps on another drive. A value
   * here only wins when the file actually exists.
   */
  workbuddyExe: '',
  /** WorkBuddy's bundled agent CLI (derived from the discovered app dir). */
  workbuddyEntry: '',
  /** Node shipped inside WorkBuddy (empty = auto-detect the newest one). */
  workbuddyNode: '',
  /** WorkBuddy per-user data dir (login state, plugins, sessions). */
  workbuddyHome: join(HOME, '.workbuddy'),
  /** Permission mode passed to both CodeBuddy-family CLIs. */
  permissionMode: 'acceptEdits',
  /** 'latest' asks the CLI which DeepSeek ids it supports and takes the newest. */
  model: 'latest',
  fallbackModel: 'deepseek-v4.1-flash',
  /** Human-facing snapshot label reported with every run (the "V4.1-1017" name). */
  modelLabel: 'V4.1-1017',
  /** A run is only model-compliant when the observed id matches this pattern. */
  requiredModelPattern: 'deepseek-v4\\.1',
  /** Hard cap on result text returned to the model. */
  maxOutputChars: 6000,
  /** Hard cap on captured stdout/stderr before truncation. */
  maxCaptureChars: 200000,
  /** How much of an attempt is scanned for capability gaps. */
  scanChars: 40000,
  /** Default worker timeout in seconds. */
  defaultTimeoutSec: 900,
  /** Default revision budget per run. */
  defaultMaxRounds: 4,
  /** Ledger root. */
  stateDir: join(HOME, '.dsh', 'buddy-control'),
  /** Fallback working directory when a call omits `cwd`; `apply` upgrades it. */
  defaultCwd: process.cwd(),
  /** Winget ids used by buddy_deploy when a component is missing. */
  nodePackageId: 'OpenJS.NodeJS.LTS',
  workbuddyPackageId: 'Tencent.WorkBuddy',
  /** npm package that provides the CodeBuddy CLI. */
  codebuddyNpmPackage: '@tencent-ai/codebuddy-code',
}

const PERMISSION_MODES = ['acceptEdits', 'bypassPermissions', 'default', 'plan', 'dontAsk', 'auto']
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const CHECK_KINDS = [
  'file-exists',
  'file-missing',
  'file-contains',
  'file-not-contains',
  'json-valid',
  'command',
]

/* ------------------------------------------------------------------ process */

/**
 * Run a child process to completion with output caps and an abort-aware timeout.
 * @param {string} command executable path or (with `shell`) a command line
 * @param {string[]} args argv (no shell quoting)
 * @param {{cwd?: string, env?: Record<string,string>, timeoutMs?: number, signal?: AbortSignal, captureChars?: number, shell?: boolean}} options
 * @returns {Promise<{code: number|null, timedOut: boolean, stdout: string, stderr: string, spawnError?: string}>}
 */
function run(command, args, options = {}) {
  const { cwd, env, timeoutMs = 300_000, signal, captureChars = DEFAULTS.maxCaptureChars, shell = false } = options
  return new Promise((done) => {
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        shell,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      done({ code: null, timedOut: false, stdout: '', stderr: '', spawnError: String(error?.message ?? error) })
      return
    }

    const cap = captureChars
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const add = (current, chunk) => {
      if (current.length >= cap) return current
      const next = current + chunk.toString('utf8')
      return next.length > cap ? `${next.slice(0, cap)}\n[... output truncated at ${cap} chars]` : next
    }
    child.stdout?.on('data', (chunk) => { stdout = add(stdout, chunk) })
    child.stderr?.on('data', (chunk) => { stderr = add(stderr, chunk) })

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      done({ timedOut, stdout, stderr, ...result })
    }

    const killTree = () => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, Math.max(1000, timeoutMs))

    const onAbort = () => {
      timedOut = true
      killTree()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (error) => finish({ code: null, spawnError: String(error?.message ?? error) }))
    child.on('close', (code) => finish({ code: code ?? null }))
  })
}

/* -------------------------------------------------------------------- text */

/** Drop `undefined` keys so the tool result is lossless JSON (the registry rejects holes). */
function clean(value) {
  return JSON.parse(JSON.stringify(value))
}

/** Trim text for the model and record whether anything was dropped. */
function clip(text, limit) {
  const value = String(text ?? '').trim()
  if (value.length <= limit) return { text: value, truncated: false }
  return { text: `${value.slice(0, limit)}\n[... ${value.length - limit} more chars]`, truncated: true }
}

/** First non-empty line matching `pattern`, clipped, for gap evidence. */
function evidenceOf(text, pattern) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (pattern.test(line)) return clip(line.replace(/\s+/g, ' '), 260).text
  }
  return undefined
}

function nowIso() {
  return new Date().toISOString()
}

/* -------------------------------------------------------------- json files */

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** Write via a temp file + rename so a crash never leaves a half-written JSON. */
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

/** Copy `path` to `<path>.bak-<stamp>` once per provisioning call. */
function backupFile(path, stamp) {
  if (!existsSync(path)) return undefined
  const target = `${path}.bak-${stamp}`
  if (existsSync(target)) return target
  copyFileSync(path, target)
  return target
}

/* ------------------------------------------------------------------ ledger */

function runsDir(cfg) {
  return join(cfg.stateDir, 'runs')
}

function newRunId() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `b-${stamp}-${Math.random().toString(36).slice(2, 6)}`
}

function runFile(cfg, runId) {
  if (!/^b-[0-9]{8}-[0-9]{6}-[a-z0-9]+$/.test(String(runId ?? ''))) {
    throw new Error(`not a runId: ${runId}. Use the id buddy_run returned.`)
  }
  return join(runsDir(cfg), `${runId}.json`)
}

function loadRun(cfg, runId) {
  const file = runFile(cfg, runId)
  if (!existsSync(file)) throw new Error(`unknown run: ${runId} (ledger: ${runsDir(cfg)})`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function saveRun(cfg, record) {
  record.updatedAt = nowIso()
  writeJsonAtomic(runFile(cfg, record.runId), record)
  return record
}

/** Newest runs first, summaries only. */
function listRuns(cfg, limit = 8) {
  const dir = runsDir(cfg)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => {
        const file = join(dir, entry)
        try {
          return { file, at: statSync(file).mtimeMs, record: JSON.parse(readFileSync(file, 'utf8')) }
        } catch {
          return undefined
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.max(1, limit))
      .map(({ record }) => clean({
        runId: record.runId,
        worker: record.worker,
        status: record.status,
        rounds: record.rounds,
        model: record.model?.used ?? record.model?.requested,
        at: record.createdAt,
        task: clip(record.task, 90).text,
      }))
  } catch {
    return []
  }
}

/* ---------------------------------------------------------------- discovery */

/** Pick the newest node.exe WorkBuddy ships under ~/.workbuddy/binaries/node/versions. */
function findWorkbuddyNode() {
  const root = join(HOME, '.workbuddy', 'binaries', 'node', 'versions')
  if (!existsSync(root)) return ''
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, 'node.exe'))
      .filter((file) => existsSync(file))
      .sort()
      .at(-1) ?? ''
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ device */

/**
 * Nothing below assumes one machine's layout. The install root of WorkBuddy and
 * CodeBuddy differs per device (this host keeps WorkBuddy on D:), so every path
 * is either read from the registry, asked from the OS, or probed as a candidate.
 */

/** Run a PowerShell snippet and parse its JSON stdout; undefined when anything fails. */
async function pwshJson(script, timeoutMs = 30_000) {
  const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeoutMs,
    captureChars: 120_000,
  })
  if (out.code !== 0) return undefined
  const text = String(out.stdout ?? '').replace(/^\uFEFF/, '')
  const start = text.search(/[[{]/)
  if (start < 0) return undefined
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return undefined
  }
}

/** Installed applications from the three uninstall hives, filtered to this stack. */
async function registryApps() {
  if (process.platform !== 'win32') return []
  const value = await pwshJson([
    "$roots = @(",
    "  'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "  'Registry::HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "  'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    ')',
    '$rows = @()',
    'foreach ($root in $roots) {',
    '  Get-ItemProperty $root -ErrorAction SilentlyContinue |',
    "    Where-Object { $_.DisplayName -match 'WorkBuddy|CodeBuddy|Node\\.js|npm|Python|Git|Blender' } |",
    '    ForEach-Object { $rows += [pscustomobject]@{',
    '      name = $_.DisplayName; version = $_.DisplayVersion;',
    '      location = $_.InstallLocation; icon = $_.DisplayIcon; uninstall = $_.UninstallString } }',
    '}',
    '$rows | ConvertTo-Json -Compress -Depth 3',
  ].join('\n'))
  const rows = Array.isArray(value) ? value : value ? [value] : []
  return rows
    .filter((row) => row && typeof row.name === 'string')
    .map((row) => clean({
      name: row.name.trim(),
      version: typeof row.version === 'string' ? row.version.trim() : undefined,
      location: typeof row.location === 'string' && row.location.trim() ? row.location.trim() : undefined,
      // DisplayIcon carries "<path>,<index>" — the only reliable install path
      // for a per-user app whose InstallLocation is empty.
      icon: typeof row.icon === 'string' && row.icon.trim()
        ? row.icon.trim().replace(/^"|"$/g, '').replace(/,\d+$/, '').replace(/^"(.*)"$/, '$1')
        : undefined,
      uninstall: typeof row.uninstall === 'string'
        ? row.uninstall.trim().replace(/^"(.*?)"(.*)$/, '$1$2').replace(/^"|"$/g, '')
        : undefined,
    }))
}

/** First existing path from a candidate list. */
function firstExisting(candidates) {
  for (const candidate of candidates ?? []) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return undefined
}

/** Every fixed-drive Program Files root plus the per-user app dirs. */
function programRoots() {
  const roots = new Set()
  for (const env of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
    const value = process.env[env]
    if (value) roots.add(value)
  }
  for (const env of ['LOCALAPPDATA', 'APPDATA']) {
    const value = process.env[env]
    if (value) roots.add(join(value, 'Programs'))
  }
  for (const letter of 'CDEFGH') {
    roots.add(`${letter}:\\Program Files`)
    roots.add(`${letter}:\\Program Files (x86)`)
  }
  roots.add('C:\\Program Files')
  return [...roots]
}

/** `where <exe>` as a path list; empty when the tool is on no PATH entry. */
async function whereExe(exe) {
  const out = await run('where', [exe], { timeoutMs: 15_000, captureChars: 8000 })
  if (out.code !== 0) return []
  return out.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** The node executable a worker should be launched with. */
async function resolveNodeExe(cfg) {
  const explicit = String(cfg.nodePath ?? '')
  if (isAbsolute(explicit) && existsSync(explicit)) return explicit
  const fromPath = firstExisting(await whereExe('node'))
  if (fromPath) return fromPath
  const system = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')
  if (existsSync(system)) return system
  const bundled = findWorkbuddyNode()
  return bundled || explicit || 'node'
}

/** Locate the CodeBuddy CLI. The npm global root differs per device, so probe the known roots. */
async function scanCodebuddy(cfg) {
  const fromPath = await whereExe('codebuddy')
  const npmRoots = [
    join(APP, 'npm', 'node_modules'),
    join(process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local'), 'npm', 'node_modules'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node_modules'),
    join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules'),
  ]
  const npmGlobal = npmRoots.find((root) => existsSync(join(root, '@tencent-ai', 'codebuddy-code')))
    ?? npmRoots[0]
  const entry = firstExisting([
    cfg.codebuddyEntry,
    ...npmRoots.map((root) => join(root, '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy')),
  ])
  return clean({ entry, npmGlobal, onPath: fromPath.length > 0 })
}

/** Locate the WorkBuddy app, its bundled CLI and the node that should run it. */
async function scanWorkbuddy(cfg, apps) {
  const fromRegistry = (apps ?? []).filter((app) => /workbuddy/i.test(app.name))
  const exe = firstExisting([
    cfg.workbuddyExe,
    ...fromRegistry.map((app) => app.icon).filter(Boolean),
    ...programRoots().flatMap((root) => [join(root, 'WorkBuddy', 'WorkBuddy.exe'), join(root, 'WorkBuddy', 'WorkBuddy', 'WorkBuddy.exe')]),
  ])
  const appDir = exe ? dirname(exe) : undefined
  const bundledCli = firstExisting([
    cfg.workbuddyEntry,
    ...(appDir ? [join(appDir, 'resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-lite-wb.mjs')] : []),
  ])
  const nodeExe = firstExisting([cfg.workbuddyNode, findWorkbuddyNode()])
  return clean({
    exe,
    appDir,
    entry: bundledCli,
    node: nodeExe,
    version: fromRegistry.find((app) => app.version)?.version,
    registryName: fromRegistry[0]?.name,
  })
}

/** Cached device inventory; `refresh` re-probes. */
let inventory

/**
 * Identify what this device actually has installed.
 * @param {{refresh?: boolean}} options
 */
async function discover(cfg, options = {}) {
  if (!options.refresh && inventory) return inventory
  const started = Date.now()
  const apps = await registryApps()
  const [nodeExe, codebuddy, workbuddy] = await Promise.all([
    resolveNodeExe(cfg),
    scanCodebuddy(cfg),
    scanWorkbuddy(cfg, apps),
  ])
  const nodeVersion = await run(nodeExe, ['--version'], { timeoutMs: 12_000, captureChars: 2000 })
    .then((out) => (out.code === 0 ? String(out.stdout).trim() || String(out.stderr).trim() : undefined))
    .catch(() => undefined)
  const winget = await run('winget', ['--version'], { timeoutMs: 20_000, captureChars: 2000 })
    .then((out) => (out.code === 0 ? String(out.stdout).trim() || undefined : undefined))
    .catch(() => undefined)
  const npm = await run('npm', ['--version'], { timeoutMs: 25_000, shell: true, captureChars: 2000 })
    .then((out) => (out.code === 0 ? String(out.stdout).trim() || undefined : undefined))
    .catch(() => undefined)

  const components = {
    node: { id: 'node', present: Boolean(nodeExe), path: nodeExe, version: nodeVersion ?? undefined },
    winget: { id: 'winget', present: Boolean(winget), version: winget },
    npm: { id: 'npm', present: Boolean(npm), version: npm },
    'codebuddy-cli': {
      id: 'codebuddy-cli',
      present: Boolean(codebuddy.entry),
      path: codebuddy.entry,
      onPath: codebuddy.onPath,
      npmGlobal: codebuddy.npmGlobal,
    },
    workbuddy: {
      id: 'workbuddy',
      present: Boolean(workbuddy.exe),
      path: workbuddy.exe,
      version: workbuddy.version,
      cli: workbuddy.entry,
      node: workbuddy.node,
      headlessLogin: 'interactive /login only',
    },
  }

  const installPlan = []
  if (!components.node.present) {
    installPlan.push({ component: 'node', method: 'winget', command: `winget install --id ${cfg.nodePackageId} -e --silent --accept-package-agreements --accept-source-agreements` })
  }
  if (!components['codebuddy-cli'].present) {
    installPlan.push({ component: 'codebuddy-cli', method: 'npm', command: `npm install -g ${cfg.codebuddyNpmPackage}` })
  }
  if (!components.workbuddy.present) {
    installPlan.push({ component: 'workbuddy', method: 'winget', command: `winget install --id ${cfg.workbuddyPackageId} -e --silent --accept-package-agreements --accept-source-agreements` })
  }

  inventory = clean({
    device: {
      host: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown',
      platform: process.platform,
      arch: process.arch,
      user: process.env.USERNAME ?? process.env.USER ?? 'unknown',
      home: HOME,
      node: process.version,
    },
    components,
    installPlan,
    missing: installPlan.map((plan) => plan.component),
    registry: apps.filter((app) => /workbuddy|codebuddy/i.test(app.name)),
    probedMs: Date.now() - started,
    at: nowIso(),
  })
  return inventory
}

/** Where this device's inventory is remembered. */
function deviceFile(cfg) {
  const host = String(process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown').replace(/[^\w.-]/g, '_')
  return join(cfg.stateDir, 'devices', `${host}.json`)
}

/** Remember the inventory so a second device shows up as its own profile. */
function saveDevice(cfg, snapshot) {
  const file = deviceFile(cfg)
  try {
    writeJsonAtomic(file, snapshot)
    return file
  } catch {
    return undefined
  }
}

/** Every device profile on disk, newest first. */
function listDevices(cfg) {
  const dir = join(cfg.stateDir, 'devices')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      const file = join(dir, entry)
      try {
        const record = JSON.parse(readFileSync(file, 'utf8'))
        return clean({
          profile: entry.replace(/\.json$/, ''),
          host: record.device?.host,
          at: record.at,
          missing: record.missing,
          codebuddy: record.components?.['codebuddy-cli']?.present,
          workbuddy: record.components?.workbuddy?.present,
        })
      } catch {
        return undefined
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

/** Resolve a user-supplied working directory, falling back to the session directory. */
function resolveCwd(cwd, fallback) {
  if (!cwd) {
    const base = fallback && existsSync(fallback) ? fallback : process.cwd()
    return base
  }
  const full = isAbsolute(cwd) ? cwd : resolve(fallback ?? process.cwd(), cwd)
  if (!existsSync(full) || !statSync(full).isDirectory()) {
    throw new Error(`cwd is not an existing directory: ${full}`)
  }
  return full
}

/**
 * The calling Session's working directory, so a call that omits `cwd` lands
 * where the user actually is instead of the Host process cwd.
 */
function sessionCwd(exec) {
  try {
    const agent = exec?.agent
    const directory = agent?.session ? thisContext?.get?.('workingDirectory')?.get(agent.session) : undefined
    if (typeof directory === 'string' && existsSync(directory)) return directory
  } catch {
    /* optional service; fall back to the configured default */
  }
  return undefined
}

/** Resolve a check path against the run's working directory. */
function absPath(path, cwd) {
  const value = String(path ?? '').trim()
  if (!value) throw new Error('check is missing `path`')
  return isAbsolute(value) ? value : resolve(cwd, value)
}

/** Cache of `codebuddy --help` because it costs ~1s per call. */
let modelCache

/** The CLI entry the running device actually has, configured or discovered. */
async function cliEntry(cfg) {
  return firstExisting([cfg.codebuddyEntry, (await discover(cfg)).components?.['codebuddy-cli']?.path])
}

/** Model ids the installed CodeBuddy CLI advertises, parsed from `--help`. */
async function supportedModels(cfg) {
  const entry = await cliEntry(cfg)
  if (!entry) return []
  if (modelCache && modelCache.entry === entry && Date.now() - modelCache.at < 600_000) {
    return modelCache.models
  }
  const out = await run(await resolveNodeExe(cfg), [entry, '--help'], {
    timeoutMs: 30_000,
    captureChars: 140_000,
    env: { CODEBUDDY_SKIP_GIT_BASH_CHECK: '1' },
  })
  const raw = `${out.stdout}\n${out.stderr}`
  const match = raw.match(/Currently supported:\s*\(([^)]*)\)/i)
  const models = match
    ? match[1].split(',').map((id) => id.trim()).filter(Boolean)
    : []
  modelCache = { entry, at: Date.now(), models }
  return models
}

/** Highest DeepSeek version in a model list, preferring the flash tier on a tie. */
function pickLatestDeepSeek(models) {
  const rank = (id) => {
    const m = /v(\d+)(?:\.(\d+))?/i.exec(id)
    return [m ? Number(m[1]) : 0, m ? Number(m[2] ?? 0) : 0, /flash/i.test(id) ? 1 : 0]
  }
  const candidates = (models ?? [])
    .filter((id) => /^deepseek/i.test(id))
    .filter((id) => !/preview|vision-exp|:batch|exp$/i.test(id))
  if (candidates.length === 0) return undefined
  return candidates
    .map((id) => ({ id, rank: rank(id) }))
    .sort((a, b) => (b.rank[0] - a.rank[0]) || (b.rank[1] - a.rank[1]) || (b.rank[2] - a.rank[2]) || a.id.localeCompare(b.id))[0].id
}

/**
 * Resolve the model this plugin pins.
 * `latest` interrogates the CLI; an explicit id or the `model` config wins.
 */
async function resolveModel(cfg, explicit) {
  const wanted = String(explicit ?? cfg.model ?? '').trim()
  if (wanted && wanted.toLowerCase() !== 'latest') return { id: wanted, policy: 'pinned' }
  try {
    const latest = pickLatestDeepSeek(await supportedModels(cfg))
    if (latest) return { id: latest, policy: 'latest', discovered: true }
  } catch {
    /* an unhelpful CLI is not fatal: fall back to the configured id */
  }
  return { id: cfg.fallbackModel, policy: 'fallback' }
}

/* ---------------------------------------------------------------- attempts */

/**
 * Normalize CodeBuddy's `--output-format json` payload into one compact record.
 * The payload is an event array ending in a `result` envelope, or that envelope
 * alone on older builds. Returns the model the worker actually requested, which
 * is the only trustworthy evidence that the newest DeepSeek id was used.
 */
function parsePayload(stdout, maxChars) {
  const trimmed = String(stdout ?? '').trim()
  let payload
  try {
    payload = JSON.parse(trimmed)
  } catch {
    const last = trimmed.split(/\r?\n/).filter(Boolean).pop() ?? ''
    try { payload = JSON.parse(last) } catch { payload = undefined }
  }
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      unparseable: true,
      text: clip(`[unparseable worker output — tail]\n${trimmed.slice(-1500)}`, maxChars),
    }
  }

  const events = Array.isArray(payload) ? payload : [payload]
  const envelope = events.filter((event) => event?.type === 'result').at(-1)
  const assistantText = events
    .filter((event) => event?.role === 'assistant' || (event?.type === 'message' && event.role === 'assistant'))
    .map((event) => (Array.isArray(event.content) ? event.content : []).map((part) => part?.text ?? '').join(' '))
    .filter((text) => typeof text === 'string' && text.trim().length > 0)
    .at(-1)
  const answer = typeof envelope?.result === 'string' ? envelope.result : assistantText
  if (answer === undefined) {
    return {
      ok: false,
      unparseable: true,
      text: clip('[worker finished without a result envelope and produced no assistant text]', maxChars),
    }
  }

  const model = events
    .map((event) => event?.providerData)
    .filter((data) => data && typeof data.requestModelId === 'string')
    .at(-1)

  const isError = envelope?.is_error === true || envelope?.subtype === 'error' || envelope?.type === 'error'

  return {
    ok: !isError,
    text: clip(answer, maxChars),
    usage: envelope?.usage,
    costUsd: envelope?.total_cost_usd,
    sessionId: envelope?.session_id,
    turns: envelope?.num_turns,
    denials: Array.isArray(envelope?.permission_denials) ? envelope.permission_denials.filter(Boolean) : [],
    stopReason: envelope?.stop_reason ?? envelope?.subtype ?? (envelope ? undefined : 'no-result-envelope'),
    model: model
      ? { id: model.requestModelId, name: model.requestModelName ?? model.requestModelId }
      : undefined,
  }
}

/** Signatures of a worker that is missing a capability rather than a solution. */
const GAP_RULES = [
  {
    kind: 'auth',
    sources: ['stderr', 'text'],
    re: /authentication required|not logged in|please use \/login|invalid api key|unauthorized|\b401\b/i,
    hint: 'The worker is not signed in; run it once in a terminal and use /login.',
    autoFixable: false,
  },
  {
    kind: 'model',
    sources: ['stderr', 'text'],
    re: /(model|modelId)[^\n]{0,48}(not found|unsupported|invalid|unavailable)|unknown model/i,
    hint: 'The pinned model id is not accepted by this build; re-resolve it or set `model` explicitly.',
    autoFixable: false,
  },
  {
    kind: 'missing-mcp',
    sources: ['stderr', 'text'],
    re: /mcp[^\n]{0,48}(fail|error|not connected|disconnected|unavailable)|failed to connect[^\n]{0,24}mcp/i,
    hint: 'An MCP server the worker needs is down or unconfigured; add it with buddy_provision mcp.',
  },
  {
    kind: 'missing-tool',
    sources: ['text', 'stderr'],
    re: /no such tool|tool[^\n]{0,32}(not found|not available|is not defined)|unknown tool|is not defined/i,
    hint: 'The worker called a tool it does not have; enable the owning Buddy plugin or allow the tool.',
  },
  {
    kind: 'permission',
    sources: ['text', 'stderr'],
    re: /permission denied|requires approval|not allowed by|denied by permission|EACCES/i,
    hint: 'A tool call was blocked by the permission layer; raise permissionMode or trust the directory.',
  },
  {
    kind: 'missing-node-package',
    sources: ['text', 'stderr'],
    re: /cannot find package|MODULE_NOT_FOUND|npm ERR! 404|is not recognized as an internal/i,
    hint: 'A node package the command needs is not installed; install it with buddy_provision npmPackage.',
  },
  {
    kind: 'missing-executable',
    sources: ['text', 'stderr'],
    re: /command not found|not recognized as an internal or external command|不是内部或外部命令|spawn [^\n]{0,80}ENOENT|\bENOENT\b/i,
    hint: 'An executable the worker tried to run is missing from PATH; install it or point at an absolute path.',
  },
  {
    kind: 'context',
    sources: ['stderr', 'text'],
    re: /context (window|length)[^\n]{0,40}(exceed|too|over)|maximum context length|prompt is too long/i,
    hint: 'The task exceeded the worker context window; split it or let the worker compact.',
    autoFixable: false,
  },
  {
    kind: 'timeout',
    sources: ['stderr'],
    re: /timed out|ETIMEDOUT|deadline exceeded/i,
    hint: 'The worker ran out of time; raise timeoutSec or split the task.',
  },
  {
    kind: 'crash',
    sources: ['stderr'],
    re: /heap out of memory|out of memory|segmentation fault|fatal error/i,
    hint: 'The worker process died; retry with a smaller task or more memory.',
    autoFixable: false,
  },
]

/** Detect the capabilities an attempt was missing, one entry per kind. */
function scanGaps(cfg, pool) {
  const sources = {
    text: String(pool.text ?? '').slice(0, cfg.scanChars),
    stderr: String(pool.stderr ?? '').slice(0, cfg.scanChars),
  }
  const gaps = []
  for (const rule of GAP_RULES) {
    const haystack = rule.sources.map((source) => sources[source] ?? '').join('\n')
    const evidence = evidenceOf(haystack, rule.re)
    if (!evidence) continue
    gaps.push({
      kind: rule.kind,
      evidence,
      hint: rule.hint,
      autoFixable: rule.autoFixable !== false,
    })
  }
  if (pool.timedOut) {
    gaps.push({
      kind: 'timeout',
      evidence: 'the worker process hit the tool timeout',
      hint: 'Raise timeoutSec, or split the task into smaller runs.',
      autoFixable: true,
    })
  }
  if (pool.unparseable) {
    gaps.push({
      kind: 'no-result',
      evidence: 'the worker exited without a parseable result envelope',
      hint: 'Usually an early crash or a max-turns exit; retry with a higher maxTurns and read the stderr tail.',
      autoFixable: false,
    })
  }
  return gaps
}

/**
 * Resolve the executable + env for one worker.
 * Configured paths win; when they are wrong for this device the crawler result
 * from buddy_discover stands in, so a fresh machine needs no config edit.
 */
async function resolveWorker(cfg, worker) {
  const nodeExe = await resolveNodeExe(cfg)
  if (worker === 'codebuddy') {
    const entry = firstExisting([
      cfg.codebuddyEntry,
      (await discover(cfg)).components?.['codebuddy-cli']?.path,
    ])
    if (!entry) {
      throw new Error(
        `CodeBuddy CLI not found on this device. Run buddy_deploy({install:{codebuddyCli:true}, apply:true, acceptInstall:true}) to install it, or set codebuddyEntry in the plugin config.`,
      )
    }
    return { command: nodeExe, prefix: [entry], env: { CODEBUDDY_SKIP_GIT_BASH_CHECK: '1' } }
  }
  if (worker !== 'workbuddy') throw new Error(`unknown worker: ${worker}`)

  const found = (await discover(cfg)).components?.workbuddy
  const entry = firstExisting([cfg.workbuddyEntry, found?.cli])
  if (!entry) {
    throw new Error(
      `WorkBuddy CLI bundle not found on this device. Run buddy_discover to see what is installed, then buddy_deploy({install:{workbuddy:true}, apply:true, acceptInstall:true}).`,
    )
  }
  const workerNode = firstExisting([cfg.workbuddyNode, found?.node])
  if (workerNode) {
    return {
      command: workerNode,
      prefix: [entry],
      env: { CODEBUDDY_SKIP_GIT_BASH_CHECK: '1', WORKBUDDY_CONFIG_DIR: cfg.workbuddyHome },
    }
  }
  const exe = firstExisting([cfg.workbuddyExe, found?.path])
  if (!exe) throw new Error(`WorkBuddy CLI bundle found at ${entry} but no node/WorkBuddy executable runs it`)
  return {
    command: exe,
    prefix: [entry],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      WORKBUDDY_CONFIG_DIR: cfg.workbuddyHome,
      CODEBUDDY_SKIP_GIT_BASH_CHECK: '1',
    },
  }
}

/**
 * Run one worker attempt.
 * @returns {Promise<object>} the ledger-shaped attempt
 */
async function spawnAttempt(cfg, request, signal) {
  const target = await resolveWorker(cfg, request.worker)
  const argv = [
    ...target.prefix,
    '-p',
    request.prompt,
    '--output-format',
    'json',
    '--permission-mode',
    request.permissionMode,
  ]
  if (request.maxTurns) argv.push('--max-turns', String(request.maxTurns))
  if (request.effort) argv.push('--effort', request.effort)
  if (request.model) argv.push('--model', request.model)
  if (request.resumeSessionId) argv.push('--resume', request.resumeSessionId)

  const started = Date.now()
  const result = await run(target.command, argv, {
    cwd: request.cwd,
    env: target.env,
    timeoutMs: Math.max(10_000, request.timeoutSec * 1000),
    signal,
    captureChars: cfg.maxCaptureChars,
  })
  const payload = parsePayload(result.stdout, cfg.maxOutputChars)
  const combined = `${payload.text?.text ?? ''}\n${result.stderr}`
  const gaps = scanGaps(cfg, {
    text: payload.text?.text,
    stderr: result.stderr,
    timedOut: result.timedOut,
    unparseable: payload.unparseable,
  })
  const needsLogin = gaps.some((gap) => gap.kind === 'auth')
  const modelOk = payload.model ? payload.model.id === request.model : undefined

  return clean({
    round: request.round,
    at: nowIso(),
    sec: Math.round((Date.now() - started) / 1000),
    ok: payload.ok && !result.timedOut && !needsLogin,
    exitCode: result.code,
    timedOut: result.timedOut || undefined,
    needsLogin: needsLogin || undefined,
    text: payload.text?.text,
    truncated: payload.text?.truncated || undefined,
    usage: payload.usage ? { in: payload.usage.input_tokens, out: payload.usage.output_tokens } : undefined,
    costUsd: payload.costUsd,
    turns: payload.turns,
    denials: payload.denials?.length ? payload.denials : undefined,
    stopReason: payload.stopReason,
    sessionId: payload.sessionId,
    model: {
      requested: request.model,
      used: payload.model?.id,
      name: payload.model?.name,
      verified: modelOk,
    },
    gaps,
    stderr: payload.ok ? undefined : clip(result.stderr || result.stdout, 1200).text,
    spawnError: result.spawnError,
    combinedHint: payload.ok ? undefined : clip(combined, 600).text,
  })
}

/* ------------------------------------------------------------------ checks */

function checkResult(kind, target, ok, detail, extra) {
  return clean({ kind, target: target === undefined ? undefined : String(target), ok, detail: clip(detail, 400).text, ...extra })
}

/** Run the deterministic acceptance checks a DSH verdict is based on. */
async function runChecks(cfg, checks, cwd, signal) {
  const results = []
  for (const check of Array.isArray(checks) ? checks : []) {
    const kind = String(check?.kind ?? '')
    try {
      if (kind === 'file-exists' || kind === 'file-missing') {
        const present = existsSync(absPath(check.path, cwd))
        results.push(checkResult(kind, check.path, kind === 'file-exists' ? present : !present, present ? 'present' : 'absent'))
      } else if (kind === 'file-contains' || kind === 'file-not-contains') {
        const full = absPath(check.path, cwd)
        if (!existsSync(full)) {
          results.push(checkResult(kind, check.path, false, 'file is missing'))
          continue
        }
        const body = readFileSync(full, 'utf8').slice(0, 400_000)
        const hit = new RegExp(String(check.pattern ?? ''), 'm').test(body)
        results.push(checkResult(kind, check.path, kind === 'file-contains' ? hit : !hit, hit ? 'pattern matched' : 'pattern absent'))
      } else if (kind === 'json-valid') {
        const full = absPath(check.path, cwd)
        try {
          JSON.parse(readFileSync(full, 'utf8'))
          results.push(checkResult(kind, check.path, true, 'valid JSON'))
        } catch (error) {
          results.push(checkResult(kind, check.path, false, String(error?.message ?? error)))
        }
      } else if (kind === 'command') {
        const line = String(check.line ?? '').trim()
        const argv = Array.isArray(check.argv) ? check.argv.map(String) : undefined
        if (!line && !argv?.length) {
          results.push(checkResult(kind, check.line, false, 'command check needs `line` or `argv`'))
          continue
        }
        const timeoutSec = Math.min(600, Math.max(5, Number(check.timeoutSec ?? 120)))
        const out = line
          ? await run(line, [], { cwd: absPath(check.cwd ?? cwd, cwd), timeoutMs: timeoutSec * 1000, shell: true, signal })
          : await run(argv[0], argv.slice(1), { cwd: absPath(check.cwd ?? cwd, cwd), timeoutMs: timeoutSec * 1000, signal })
        const haystack = `${out.stdout}\n${out.stderr}`
        const wanted = check.expectContains === undefined ? undefined : String(check.expectContains)
        const passed = out.code === 0
          && !out.timedOut
          && (wanted === undefined || haystack.includes(wanted))
        results.push(checkResult(
          kind,
          line || argv.join(' '),
          passed,
          passed ? 'exit 0' : clip(`exit=${out.code}${out.timedOut ? ' timedOut' : ''} ${clip(haystack, 300).text}`, 320).text,
        ))
      } else {
        results.push(checkResult(kind || 'unknown', check?.path, false, `unsupported check kind (${CHECK_KINDS.join(', ')})`))
      }
    } catch (error) {
      results.push(checkResult(kind || 'unknown', check?.path, false, String(error?.message ?? error)))
    }
  }
  return results
}

function describeCheck(check) {
  switch (check?.kind) {
    case 'command': return `command: ${check.line ?? (check.argv ?? []).join(' ')}`
    case 'file-contains': return `file-contains: ${check.path} ~ /${check.pattern}/`
    case 'file-not-contains': return `file-not-contains: ${check.path} ~ /${check.pattern}/`
    default: return `${check?.kind}: ${check?.path ?? ''}`.trim()
  }
}

/* ----------------------------------------------------------------- prompts */

function initialPrompt(task, acceptance, cwd) {
  const blocks = [String(task).trim()]
  if (acceptance) blocks.push(`## 验收标准（DSH 会逐条检查）\n${String(acceptance).trim()}`)
  blocks.push(
    `## 交付约定\n- 只在 ${cwd} 内改动。\n- 完成后按验收标准自检；做不到的项必须写明原因和阻塞点，不要假称完成。`,
  )
  return blocks.join('\n\n')
}

function revisionPrompt(cfg, record, verdict) {
  const issues = (verdict.issues ?? []).map((issue, index) => {
    const severity = issue.severity ? `[${issue.severity}] ` : ''
    const where = issue.where ? `${issue.where} — ` : ''
    const direction = issue.direction ? `\n   → 修改方向: ${issue.direction}` : ''
    return `${index + 1}. ${severity}${where}${issue.problem}${direction}`
  })
  const checks = (record.checks ?? []).map((check) => `- ${describeCheck(check)}`)
  const blocks = [
    `# DSH 验收退回 · 第 ${(record.rounds ?? 0) + 1} 轮`,
    '上一轮产出没有通过 DSH 的验收。只做定向修复：不要重做已经通过的部分，也不要扩大改动范围。',
    `## 验收标准\n${record.acceptance || '（未单独声明，按原始任务判断）'}`,
    `## 未通过项\n${issues.length ? issues.join('\n') : '（见下方修改方向）'}`,
    `## 修改方向\n${verdict.directions || '按上面的未通过项逐条修复。'}`,
  ]
  if (checks.length > 0) blocks.push(`## 复检清单\n${checks.join('\n')}`)
  blocks.push(
    `## 收尾要求\n- 逐条说明每个未通过项是怎么闭环的：改了哪个文件、改成什么。\n- 仍然无法闭环的，明确写出原因和阻塞点，不要假称完成。\n- 模型固定为 ${record.model?.requested ?? cfg.fallbackModel}（${cfg.modelLabel}），不要切换。`,
  )
  return blocks.join('\n\n')
}

/* -------------------------------------------------------------- provisions */

const PLUGIN_MARKETPLACE_DEFAULT = 'codebuddy-plugins-official'

/** The worker's two config documents. */
function settingsFile(cfg) {
  return join(cfg.codebuddyHome, 'settings.json')
}

function mcpFile(cfg) {
  return join(cfg.codebuddyHome, 'mcp.json')
}

/** Key-order-independent JSON form, so "unchanged" really means unchanged. */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
}

/**
 * Merge one MCP server into the worker's own mcp.json.
 * @param config the already-staged document (so several stages chain)
 */
function establishMcpServer(cfg, config, spec) {
  const name = String(spec?.name ?? '').trim()
  if (!name) throw new Error('mcp needs `name`')
  const servers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}
  const transport = String(spec.type ?? (spec.url ? 'http' : 'stdio'))
  const entry = transport === 'stdio'
    ? { command: String(spec.command ?? ''), args: Array.isArray(spec.args) ? spec.args.map(String) : [], type: 'stdio' }
    : { url: String(spec.url ?? ''), type: transport, args: [], print: spec.print ?? true }
  if (transport === 'stdio' && !entry.command) throw new Error('mcp stdio needs `command`')
  if (transport !== 'stdio' && !entry.url) throw new Error('mcp http/sse needs `url`')
  const before = stable(servers[name] ?? null)
  servers[name] = entry
  config.mcpServers = servers
  config.disabledMcpServers = Array.isArray(config.disabledMcpServers)
    ? config.disabledMcpServers.filter((server) => server !== name)
    : []
  return { file: mcpFile(cfg), config, changed: stable(entry) !== before, detail: `${name} → ${transport}` }
}

/** Enable one CodeBuddy plugin in the worker's settings. */
function establishPlugin(cfg, config, spec) {
  const raw = String(spec ?? '').trim()
  if (!raw) throw new Error('plugin needs a name')
  const id = raw.includes('@') ? raw : `${raw}@${PLUGIN_MARKETPLACE_DEFAULT}`
  const enabled = config.enabledPlugins && typeof config.enabledPlugins === 'object' ? config.enabledPlugins : {}
  const changed = enabled[id] !== true
  enabled[id] = true
  config.enabledPlugins = enabled
  return { file: settingsFile(cfg), config, changed, detail: id }
}

/** Trust one directory so the worker stops asking for approval inside it. */
function establishTrustedDir(cfg, config, dir) {
  const path = String(dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!path) throw new Error('trustedDir needs a path')
  const list = Array.isArray(config.trustedDirectories) ? config.trustedDirectories : []
  const already = list.some((entry) => String(entry).replace(/\\/g, '/').replace(/\/\*+$/, '').replace(/\/+$/, '') === path)
  if (!already) list.push(`${path}/**`)
  config.trustedDirectories = list
  return { file: settingsFile(cfg), config, changed: !already, detail: path }
}

/** Pin the worker's own persisted model so a reset cannot silently drift. */
function establishModel(cfg, config, model) {
  const id = String(model ?? '').trim()
  if (!id) throw new Error('model needs an id')
  const changed = config.model !== id
  config.model = id
  return { file: settingsFile(cfg), config, changed, detail: id }
}

/* --------------------------------------------------------------------- tools */

const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, enum: CHECK_KINDS, description: 'Check to run.' },
    path: { type: 'string', description: 'File to inspect, relative to the run cwd.' },
    pattern: { type: 'string', description: 'Regex for file-contains / file-not-contains.' },
    line: { type: 'string', description: 'Shell line for kind=command (e.g. "npm test").' },
    argv: { type: 'array', items: { type: 'string' }, description: 'Exact argv for kind=command instead of line.' },
    cwd: { type: 'string', description: 'Working directory override for kind=command.' },
    expectContains: { type: 'string', description: 'Require this substring in command output.' },
    timeoutSec: { type: 'integer', description: 'Command timeout, default 120.' },
  },
}

const ISSUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    problem: { type: 'string', required: true, description: 'What is wrong, concretely.' },
    where: { type: 'string', description: 'file:line or area.' },
    severity: { type: 'string', enum: ['blocker', 'major', 'minor'], description: 'How bad it is.' },
    direction: { type: 'string', description: 'Concrete fix direction for this item.' },
  },
}

/** Compact projection of an attempt for a tool result. `model` and `ok` are
 * projected by the caller so a verified model block always wins. */
function attemptView(attempt) {
  return clean({
    sec: attempt.sec,
    stopReason: attempt.stopReason,
    turns: attempt.turns,
    usage: attempt.usage,
    result: attempt.text,
    truncated: attempt.truncated,
    sessionId: attempt.sessionId,
    denials: attempt.denials,
    gaps: attempt.gaps?.length ? attempt.gaps : undefined,
    checks: attempt.checks?.length ? attempt.checks : undefined,
    exitCode: attempt.exitCode,
    timedOut: attempt.timedOut,
    stderr: attempt.stderr,
    spawnError: attempt.spawnError,
  })
}

function modelBlock(cfg, resolved, attempt) {
  const pattern = new RegExp(cfg.requiredModelPattern, 'i')
  const observed = attempt?.model?.used
  return clean({
    requested: attempt?.model?.requested ?? resolved.id,
    policy: resolved.policy,
    label: cfg.modelLabel,
    observed,
    observedName: attempt?.model?.name,
    verified: attempt?.model?.verified,
    compliant: pattern.test(observed ?? resolved.id),
    drift: observed !== undefined && observed !== (attempt?.model?.requested ?? resolved.id)
      ? { used: observed, requested: attempt?.model?.requested }
      : undefined,
  })
}

const buddyRun = defineTool({
  name: 'buddy_run',
  description:
    'Dispatch ONE supervised attempt to a local agent (codebuddy/workbuddy), pinned to the newest DeepSeek model the CLI advertises, with the acceptance criteria wrapped into the prompt. Returns a compact envelope plus a runId for buddy_review; the worker spends its own quota. Pass `acceptance` and `checks` so the verdict in buddy_review has evidence.',
  parameters: {
    worker: { type: 'string', required: true, enum: ['codebuddy', 'workbuddy'], description: 'Agent to run.' },
    task: { type: 'string', required: true, description: 'Self-contained task; the worker has no conversation context.' },
    cwd: { type: 'string', description: 'Working directory; defaults to the session workspace.' },
    acceptance: { type: 'string', description: 'Acceptance criteria DSH will judge the output against.' },
    checks: { type: 'array', items: CHECK_SCHEMA, description: 'Deterministic checks re-run at every review.' },
    model: { type: 'string', description: 'Override the discovered newest DeepSeek id.' },
    permissionMode: { type: 'string', enum: PERMISSION_MODES, description: 'CLI permission mode; defaults to config.' },
    maxTurns: { type: 'integer', description: 'Cap agentic turns.' },
    effort: { type: 'string', enum: EFFORTS, description: 'Reasoning effort level.' },
    timeoutSec: { type: 'integer', description: 'Worker timeout, default 900.' },
  },
  timeoutMs: 1_800_000,
  output: {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args, exec) {
    const cfg = thisConfig
    const cwd = resolveCwd(args.cwd, sessionCwd(exec) ?? cfg.defaultCwd)
    const resolved = await resolveModel(cfg, args.model)
    const record = {
      version: 1,
      runId: newRunId(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      worker: args.worker,
      cwd,
      task: String(args.task),
      acceptance: args.acceptance ? String(args.acceptance) : undefined,
      checks: Array.isArray(args.checks) ? args.checks : [],
      model: { requested: resolved.id, policy: resolved.policy },
      permissionMode: args.permissionMode ?? cfg.permissionMode,
      maxTurns: args.maxTurns,
      effort: args.effort,
      timeoutSec: Math.min(3600, Math.max(10, args.timeoutSec ?? cfg.defaultTimeoutSec)),
      rounds: 0,
      status: 'open',
      sessionId: undefined,
      attempts: [],
      verdicts: [],
    }

    const attempt = await spawnAttempt(cfg, {
      worker: args.worker,
      model: resolved.id,
      prompt: initialPrompt(record.task, record.acceptance, cwd),
      cwd,
      permissionMode: record.permissionMode,
      maxTurns: record.maxTurns,
      effort: record.effort,
      timeoutSec: record.timeoutSec ?? Math.min(3600, Math.max(10, args.timeoutSec ?? cfg.defaultTimeoutSec)),
      round: 1,
    }, exec.signal)

    if (record.checks.length > 0) attempt.checks = await runChecks(cfg, record.checks, cwd, exec.signal)
    record.rounds = 1
    record.sessionId = attempt.sessionId
    record.attempts.push(attempt)
    saveRun(cfg, record)

    return clean({
      ok: attempt.ok,
      runId: record.runId,
      round: 1,
      worker: record.worker,
      cwd,
      model: modelBlock(cfg, resolved, attempt),
      ...attemptView(attempt),
      next: attempt.ok
        ? 'Inspect the output, then buddy_review({runId, verdict:"accept"|"reject", issues, directions}). A reject sends the directions back into this same session.'
        : 'buddy_gaps({runId}) lists the missing capabilities; buddy_provision repairs the safe ones.',
    })
  },
  presentCall: (args) => ({
    card: 'generic',
    title: `Buddy run → ${args.worker}`,
    kind: 'other',
    rawInput: { task: String(args.task ?? '').slice(0, 160), cwd: args.cwd },
  }),
})

const buddyReview = defineTool({
  name: 'buddy_review',
  description:
    'Record DSH\'s acceptance verdict for a run. accept → run closes. reject → the issues/directions are sent back into the SAME worker session (--resume), the checks are re-run, and the new attempt is returned; repeat until accepted or the round budget is spent. Reject needs at least one issue or `directions`.',
  parameters: {
    runId: { type: 'string', required: true, description: 'runId returned by buddy_run.' },
    verdict: { type: 'string', required: true, enum: ['accept', 'reject'], description: 'DSH acceptance result.' },
    criteria: { type: 'string', description: 'What you actually checked (one line per criterion).' },
    issues: { type: 'array', items: ISSUE_SCHEMA, description: 'Rejected items; each becomes a numbered requirement.' },
    directions: { type: 'string', description: 'Overall revision direction sent to the worker.' },
    checks: { type: 'array', items: CHECK_SCHEMA, description: 'Replace the run\'s checks for this and later rounds.' },
    fix: { type: 'boolean', description: 'Send the revision immediately on reject; default true.' },
    maxRounds: { type: 'integer', description: 'Revision budget, default 4.' },
    permissionMode: { type: 'string', enum: PERMISSION_MODES, description: 'Escalate the mode for the revision run.' },
    extraDirection: { type: 'string', description: 'Extra note appended to the revision prompt.' },
  },
  timeoutMs: 1_800_000,
  output: {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args, exec) {
    const cfg = thisConfig
    const record = loadRun(cfg, args.runId)
    const checks = Array.isArray(args.checks) && args.checks.length > 0 ? args.checks : record.checks ?? []
    if (Array.isArray(args.checks) && args.checks.length > 0) record.checks = checks

    const reviewed = checks.length > 0 ? await runChecks(cfg, checks, record.cwd, exec.signal) : []
    const current = record.attempts.at(-1)
    if (current) current.checks = reviewed

    const verdict = clean({
      round: record.rounds,
      verdict: args.verdict,
      criteria: args.criteria,
      issues: args.issues ?? [],
      directions: args.directions,
      checks: reviewed,
      at: nowIso(),
    })
    record.verdicts.push(verdict)

    if (args.verdict === 'accept') {
      record.status = 'accepted'
      saveRun(cfg, record)
      return clean({
        ok: true,
        runId: record.runId,
        status: 'accepted',
        rounds: record.rounds,
        worker: record.worker,
        model: record.attempts.at(-1)?.model,
        checks: reviewed.length ? reviewed : undefined,
      })
    }

    if ((verdict.issues.length === 0) && !verdict.directions) {
      throw new Error('buddy_review reject needs at least one issue (problem/where/direction) or `directions`; an empty rejection gives the worker nothing to repair.')
    }

    const maxRounds = Math.min(12, Math.max(1, args.maxRounds ?? cfg.defaultMaxRounds))
    if (record.rounds >= maxRounds) {
      record.status = 'exhausted'
      saveRun(cfg, record)
      return clean({
        ok: false,
        runId: record.runId,
        status: 'exhausted',
        rounds: record.rounds,
        maxRounds,
        hint: 'The revision budget is spent. Either accept what exists, raise maxRounds in a new buddy_review call, or buddy_run a fresh attempt with a narrower task.',
      })
    }

    if (args.fix === false) {
      record.status = 'rejected'
      saveRun(cfg, record)
      return clean({
        ok: false,
        runId: record.runId,
        status: 'rejected',
        rounds: record.rounds,
        hint: 'Verdict recorded without dispatching. Call buddy_review again with fix=true (or the same verdict) to send the revision.',
      })
    }

    const resolved = { id: record.model.requested, policy: record.model.policy ?? 'pinned' }
    const attempt = await spawnAttempt(cfg, {
      worker: record.worker,
      model: resolved.id,
      prompt: revisionPrompt(cfg, record, verdict),
      cwd: record.cwd,
      permissionMode: args.permissionMode ?? record.permissionMode ?? cfg.permissionMode,
      maxTurns: record.maxTurns,
      effort: record.effort,
      timeoutSec: record.timeoutSec ?? cfg.defaultTimeoutSec,
      resumeSessionId: record.sessionId,
      round: record.rounds + 1,
    }, exec.signal)

    const rechecked = record.checks?.length ? await runChecks(cfg, record.checks, record.cwd, exec.signal) : []
    attempt.checks = rechecked
    record.rounds += 1
    record.sessionId = attempt.sessionId ?? record.sessionId
    record.attempts.push(attempt)
    record.status = 'open'
    saveRun(cfg, record)

    const failing = rechecked.filter((check) => check.ok === false)
    return clean({
      ok: attempt.ok,
      runId: record.runId,
      status: 'open',
      round: record.rounds,
      worker: record.worker,
      model: modelBlock(cfg, resolved, attempt),
      checksFailing: failing.length ? failing : undefined,
      ...attemptView(attempt),
      next: failing.length === 0
        ? 'Every declared check now passes; buddy_review({verdict:"accept"}) to close the run.'
        : 'Judge the revision again with buddy_review; keep rejecting with concrete issues until the checks pass.',
    })
  },
  presentCall: (args) => ({
    card: 'generic',
    title: `Buddy review → ${args.verdict}`,
    kind: 'other',
    rawInput: { runId: args.runId, issues: (args.issues ?? []).length },
  }),
})

const buddyGaps = defineTool({
  name: 'buddy_gaps',
  description:
    'List the capabilities the last attempt was missing (auth, executable, node package, tool, MCP server, permission, model, context, timeout) with the evidence line and the remedy. Run it before blaming the worker for a bad result.',
  parameters: {
    runId: { type: 'string', description: 'Run to inspect; defaults to the newest run.' },
    round: { type: 'integer', description: 'Attempt number; defaults to the latest.' },
  },
  timeoutMs: 60_000,
  output: {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args) {
    const cfg = thisConfig
    const runId = args.runId ?? listRuns(cfg, 1)[0]?.runId
    if (!runId) throw new Error('no run recorded yet; call buddy_run first')
    const record = loadRun(cfg, runId)
    const attempt = args.round
      ? record.attempts.find((entry) => entry.round === args.round)
      : record.attempts.at(-1)
    if (!attempt) throw new Error(`run ${runId} has no attempt #${args.round ?? 'latest'}`)

    const remedies = (attempt.gaps ?? []).map((gap) => {
      switch (gap.kind) {
        case 'permission':
          return { for: gap.kind, tool: 'buddy_provision', args: { runId, trustedDir: record.cwd, apply: true } }
        case 'model':
          return { for: gap.kind, tool: 'buddy_provision', args: { runId, model: record.model.requested, apply: true } }
        case 'missing-mcp':
          return { for: gap.kind, tool: 'buddy_provision', args: { mcp: { name: '<server>', url: 'http://127.0.0.1:<port>/mcp' }, apply: true } }
        case 'missing-tool':
          return { for: gap.kind, tool: 'buddy_provision', args: { plugin: '<plugin-name>', apply: true } }
        case 'missing-node-package':
          return { for: gap.kind, tool: 'buddy_provision', args: { npmPackage: '<package>', confirmInstall: true, apply: true } }
        case 'auth':
          return { for: gap.kind, tool: 'manual', args: { how: record.worker === 'workbuddy' ? 'Open the WorkBuddy CLI interactively and run /login (headless mode cannot sign in).' : 'Run `codebuddy` once in a terminal and use /login.' } }
        default:
          return { for: gap.kind, tool: 'retry', args: { how: gap.hint } }
      }
    })

    return clean({
      runId,
      round: attempt.round,
      worker: record.worker,
      status: record.status,
      gaps: attempt.gaps ?? [],
      remedies,
      note: (attempt.gaps ?? []).length === 0
        ? 'No capability gap detected: the worker had what it needed, so a bad result is a solution problem, not a missing plugin.'
        : undefined,
    })
  },
})

const buddyProvision = defineTool({
  name: 'buddy_provision',
  description:
    'Give the worker the capability it lacked: register an MCP server, enable a Buddy plugin, trust the working directory, pin its persisted model, or install an npm CLI. Plans by default; `apply:true` writes. It edits the worker\'s own config (~/.codebuddy) with a timestamped backup, never DSH\'s.',
  parameters: {
    mcp: {
      type: 'object',
      additionalProperties: false,
      description: 'MCP server to register in the worker mcp.json.',
      properties: {
        name: { type: 'string', required: true, description: 'Server name the tools appear under.' },
        url: { type: 'string', description: 'Endpoint for http/sse transports.' },
        type: { type: 'string', enum: ['http', 'sse', 'stdio'], description: 'Transport; inferred from url when omitted.' },
        command: { type: 'string', description: 'Executable for stdio transport.' },
        args: { type: 'array', items: { type: 'string' }, description: 'stdio argv.' },
      },
    },
    plugin: { type: 'string', description: 'Buddy plugin to enable, e.g. "docx" or "docx@codebuddy-plugins-official".' },
    trustedDir: { type: 'string', description: 'Directory to trust so the worker stops asking for approval there.' },
    model: { type: 'string', description: 'Model id to pin in the worker settings.json.' },
    npmPackage: { type: 'string', description: 'Global npm package to install for the worker (needs confirmInstall).' },
    runId: { type: 'string', description: 'Plan the remedies detected for this run instead of passing them explicitly.' },
    apply: { type: 'boolean', description: 'Write the changes; default false = plan only.' },
    confirmInstall: { type: 'boolean', description: 'Approve the npm install; without it the install is planned only.' },
  },
  timeoutMs: 900_000,
  output: {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args, exec) {
    const cfg = thisConfig
    const apply = args.apply === true
    const stamp = nowIso().replace(/[:.]/g, '-')
    const plan = []
    const applied = []
    const failed = []
    const skipped = []
    const staged = []
    const backups = []

    /** Read a document from the pending writes first, so stages chain per file. */
    const currentDoc = (file, fallback) => writes.get(file) ?? readJson(file, fallback)
    const writes = new Map()

    const stage = (kind, target, builder) => {
      try {
        const change = builder()
        plan.push(clean({ kind, target: change.file, detail: change.detail ?? target, alreadyDone: !change.changed }))
        if (!apply) return
        if (!change.changed) {
          skipped.push(clean({ kind, detail: change.detail ?? target, reason: 'already configured' }))
          return
        }
        writes.set(change.file, change.config)
        staged.push(clean({ kind, target: change.file, detail: change.detail ?? target }))
      } catch (error) {
        failed.push(clean({ kind, detail: target, error: String(error?.message ?? error) }))
      }
    }

    const settings = () => currentDoc(settingsFile(cfg), {})
    const mcp = () => currentDoc(mcpFile(cfg), { mcpServers: {}, disabledMcpServers: [] })

    if (args.runId) {
      const record = loadRun(cfg, args.runId)
      const gaps = record.attempts.at(-1)?.gaps ?? []
      for (const gap of gaps) {
        if (gap.kind === 'permission') stage('trusted-dir', record.cwd, () => establishTrustedDir(cfg, settings(), record.cwd))
        if (gap.kind === 'model') stage('model-pin', record.model.requested, () => establishModel(cfg, settings(), record.model.requested))
      }
      plan.push(clean({
        kind: 'gap-plan',
        detail: `${gaps.length} gap(s) on ${record.runId}; mcp/plugin/npm need explicit values`,
      }))
    }

    if (args.mcp) stage('mcp-server', args.mcp.name, () => establishMcpServer(cfg, mcp(), args.mcp))
    if (args.plugin) stage('plugin-enable', args.plugin, () => establishPlugin(cfg, settings(), args.plugin))
    if (args.trustedDir) stage('trusted-dir', args.trustedDir, () => establishTrustedDir(cfg, settings(), args.trustedDir))
    if (args.model) stage('model-pin', args.model, () => establishModel(cfg, settings(), args.model))

    // One backup per touched file, then one atomic write per file.
    for (const [file, config] of writes) {
      try {
        const backup = backupFile(file, stamp)
        if (backup) backups.push(backup)
        writeJsonAtomic(file, config)
      } catch (error) {
        failed.push(clean({ kind: 'write', detail: file, error: String(error?.message ?? error) }))
        continue
      }
    }
    if (apply) {
      for (const entry of staged) {
        if (!failed.some((failure) => failure.kind === 'write' && failure.detail === entry.target)) applied.push(entry)
      }
    }

    if (args.npmPackage) {
      const pkg = String(args.npmPackage).trim()
      if (!/^(@[\w.-]+\/)?[\w.-]+(@[\w.^~<>=* -]+)?$/.test(pkg)) {
        failed.push(clean({ kind: 'npm-package', detail: pkg, error: 'package name failed the safety pattern' }))
      } else if (!apply || args.confirmInstall !== true) {
        plan.push(clean({ kind: 'npm-package', detail: `npm install -g ${pkg}`, needs: 'apply:true + confirmInstall:true' }))
      } else {
        const out = await run('npm', ['install', '-g', pkg], { timeoutMs: 600_000, shell: true, signal: exec.signal })
        const entry = clean({
          kind: 'npm-package',
          detail: `npm install -g ${pkg}`,
          ok: out.code === 0,
          exitCode: out.code,
          tail: clip(out.stdout || out.stderr, 600).text,
        })
        if (entry.ok) applied.push(entry)
        else failed.push(entry)
      }
    }

    if (plan.length === 0 && failed.length === 0) {
      return clean({
        ok: false,
        applied: [],
        hint: 'Nothing to do: pass mcp/plugin/trustedDir/model/npmPackage, or runId to plan the detected gaps.',
      })
    }

    return clean({
      ok: failed.length === 0,
      apply,
      applied: applied.length ? applied : undefined,
      planned: plan,
      skipped: skipped.length ? skipped : undefined,
      failed: failed.length ? failed : undefined,
      backups: backups.length ? backups : undefined,
      effects: apply
        ? ['The worker reads mcp.json/settings.json at process start: the next buddy_run picks the change up.']
        : ['Plan only. Re-call with apply:true to write; npm installs additionally need confirmInstall:true.'],
    })
  },
  presentCall: (args) => ({
    card: 'generic',
    title: `Buddy provision${args.apply ? '' : ' (plan)'}`,
    kind: 'other',
    rawInput: { mcp: args.mcp?.name, plugin: args.plugin, model: args.model, npmPackage: args.npmPackage },
  }),
})

const buddyDiscover = defineTool({
  name: 'buddy_discover',
  description:
    'Inventory this device: which of node / npm / winget / CodeBuddy CLI / WorkBuddy are installed, exactly where, at which version, and what a missing one would need. Paths come from the registry, PATH and per-user app roots, never from a hard-coded drive. Saves a per-host device profile so a second machine shows up as its own entry. Zero model cost.',
  parameters: {
    refresh: { type: 'boolean', description: 'Ignore the cached inventory and probe again.' },
    save: { type: 'boolean', description: 'Persist this device profile; default true.' },
  },
  timeoutMs: 180_000,
  output: {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args) {
    const cfg = thisConfig
    const snapshot = await discover(cfg, { refresh: args.refresh === true })
    const profile = args.save === false ? undefined : saveDevice(cfg, snapshot)
    return clean({
      device: snapshot.device,
      components: snapshot.components,
      missing: snapshot.missing,
      installPlan: snapshot.installPlan,
      registry: snapshot.registry,
      devices: listDevices(cfg),
      profile,
      next: snapshot.missing.length
        ? 'buddy_deploy({apply:true, acceptInstall:true}) installs the missing pieces and wires the rest up.'
        : 'Everything this plugin needs is present. buddy_deploy({apply:true}) converges config and verifies with a live call.',
    })
  },
})

const buddyDeploy = defineTool({
  name: 'buddy_deploy',
  description:
    'Converge this device to a working state: install missing node / CodeBuddy CLI / WorkBuddy, wire the worker config (MCP servers, plugins, trusted dirs, model pin), then verify with a live PONG call. Plans by default; apply:true writes and installs, acceptInstall:true authorises the installers. Idempotent — a device that is already complete reports every step as present.',
  parameters: {
    apply: { type: 'boolean', description: 'Write config and run installers; default false = plan only.' },
    acceptInstall: { type: 'boolean', description: 'Authorise winget/npm installs of missing software.' },
    verify: { type: 'boolean', description: 'End with a live worker call; default true when apply is true.' },
    install: {
      type: 'object',
      additionalProperties: false,
      description: 'Which missing components to install; omitted installs everything missing.',
      properties: {
        node: { type: 'boolean', description: 'Install node via winget when absent.' },
        codebuddyCli: { type: 'boolean', description: 'Install the CodeBuddy CLI via npm when absent.' },
        workbuddy: { type: 'boolean', description: 'Install WorkBuddy via winget when absent.' },
      },
    },
    profile: {
      type: 'object',
      additionalProperties: false,
      description: 'Desired worker config. Only keys you pass are touched.',
      properties: {
        model: { type: 'string', description: 'Model id to pin; "latest" resolves through the CLI.' },
        mcp: {
          type: 'array',
          description: 'MCP servers the worker must have.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              url: { type: 'string' },
              type: { type: 'string', enum: ['http', 'sse', 'stdio'] },
              command: { type: 'string' },
              args: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        plugins: { type: 'array', items: { type: 'string' }, description: 'Buddy plugins to enable.' },
        trustedDirs: { type: 'array', items: { type: 'string' }, description: 'Directories the worker may act in without asking.' },
      },
    },
    refresh: { type: 'boolean', description: 'Re-probe the device before planning.' },
    verifyTimeoutSec: { type: 'integer', description: 'Timeout for the verification call, default 180.' },
  },
  timeoutMs: 1_800_000,
  output: {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args, exec) {
    const cfg = thisConfig
    const apply = args.apply === true
    const accepted = args.acceptInstall === true
    const stamp = nowIso().replace(/[:.]/g, '-')
    const wanted = args.install ?? {}
    const steps = []
    const step = (id, status, detail, extra) => steps.push(clean({ id, status, detail, ...extra }))

    let snapshot = await discover(cfg, { refresh: args.refresh === true })
    if (apply) saveDevice(cfg, snapshot)

    // 1. Software: install only what is missing, and only with explicit consent.
    const installer = (component) => {
      if (wanted[component === 'codebuddy-cli' ? 'codebuddyCli' : component] === false) return false
      return true
    }
    for (const plan of snapshot.installPlan) {
      if (!installer(plan.component)) {
        step(plan.component, 'skipped', `${plan.command} (not requested)`)
        continue
      }
      if (!apply || !accepted) {
        step(plan.component, 'planned', plan.command, { needs: 'apply:true + acceptInstall:true' })
        continue
      }
      const out = await run(plan.command, [], { timeoutMs: 900_000, shell: true, signal: exec.signal })
      const ok = out.code === 0
      step(plan.component, ok ? 'installed' : 'failed', plan.command, {
        exitCode: out.code,
        tail: ok ? undefined : clip(out.stderr || out.stdout, 700).text,
      })
    }
    if (snapshot.installPlan.length === 0) {
      step('software', 'present', `node, ${cfg.codebuddyNpmPackage}, WorkBuddy all found`)
    }

    // 2. Interface wiring: converge the worker's own config documents.
    const desired = args.profile ?? {}
    const writes = new Map()
    const doc = (file, fallback) => writes.get(file) ?? readJson(file, fallback)
    const stage = (id, build) => {
      try {
        const change = build()
        if (!change.changed) {
          step(id, 'present', `${change.detail} already configured`)
          return
        }
        if (!apply) {
          step(id, 'planned', `${change.detail} → ${change.file}`)
          return
        }
        writes.set(change.file, change.config)
        step(id, 'applied', `${change.detail} → ${change.file}`)
      } catch (error) {
        step(id, 'failed', String(error?.message ?? error))
      }
    }

    const settings = () => doc(settingsFile(cfg), {})
    const mcp = () => doc(mcpFile(cfg), { mcpServers: {}, disabledMcpServers: [] })

    if (desired.model) {
      const resolved = await resolveModel(cfg, desired.model)
      stage('model-pin', () => establishModel(cfg, settings(), resolved.id))
    }
    for (const server of desired.mcp ?? []) {
      stage(`mcp:${server.name}`, () => establishMcpServer(cfg, mcp(), server))
    }
    for (const plugin of desired.plugins ?? []) {
      stage(`plugin:${plugin}`, () => establishPlugin(cfg, settings(), plugin))
    }
    for (const dir of desired.trustedDirs ?? []) {
      stage(`trust:${dir}`, () => establishTrustedDir(cfg, settings(), dir))
    }

    const backups = []
    for (const [file, config] of writes) {
      try {
        const backup = backupFile(file, stamp)
        if (backup) backups.push(backup)
        writeJsonAtomic(file, config)
      } catch (error) {
        step('write', 'failed', `${file}: ${String(error?.message ?? error)}`)
      }
    }
    if (!apply && writes.size === 0) step('config', 'present', 'worker config already converged')

    // 3. Re-probe after installs so the report describes the resulting device.
    if (apply && snapshot.installPlan.length > 0) {
      snapshot = await discover(cfg, { refresh: true })
      saveDevice(cfg, snapshot)
    }

    // 4. Acceptance gate: a deployment that cannot answer is not a deployment.
    let verified
    const shouldVerify = args.verify ?? apply
    if (shouldVerify) {
      if (snapshot.components?.['codebuddy-cli']?.present !== true) {
        step('verify', 'skipped', 'CodeBuddy CLI is not installed, nothing to call')
      } else {
        const resolved = await resolveModel(cfg, desired.model)
        const attempt = await spawnAttempt(cfg, {
          worker: 'codebuddy',
          model: resolved.id,
          prompt: 'Reply with exactly: PONG',
          cwd: resolveCwd(undefined, sessionCwd(exec) ?? cfg.defaultCwd),
          permissionMode: cfg.permissionMode,
          maxTurns: 3,
          timeoutSec: Math.min(600, Math.max(30, args.verifyTimeoutSec ?? 180)),
          round: 0,
        }, exec.signal)
        const answered = /PONG/i.test(String(attempt.text ?? ''))
        verified = clean({
          ok: attempt.ok && answered,
          answered,
          model: attempt.model,
          sec: attempt.sec,
          usage: attempt.usage,
        })
        step('verify', verified.ok ? 'verified' : 'failed', verified.ok
          ? `live call answered PONG on ${attempt.model?.used ?? resolved.id}`
          : clip(attempt.text ?? attempt.stderr ?? 'no answer', 300).text)
      }
    }

    const failed = steps.filter((entry) => entry.status === 'failed')
    const planned = steps.filter((entry) => entry.status === 'planned')
    return clean({
      ok: failed.length === 0,
      apply,
      device: snapshot.device,
      missing: snapshot.missing,
      steps,
      verified,
      backups: backups.length ? backups : undefined,
      failed: failed.length ? failed : undefined,
      planned: planned.length ? planned.length : undefined,
      next: failed.length
        ? 'Read `failed`, fix that one cause, and call buddy_deploy again; every step is idempotent.'
        : apply
          ? (verified?.ok
            ? 'Device is deployed and verified. buddy_run is ready.'
            : 'Config converged but the live call did not answer; run buddy_gaps to see what the worker is missing.')
          : 'Plan only. Re-call with apply:true (and acceptInstall:true for installs) to converge this device.',
    })
  },
  presentCall: (args) => ({
    card: 'generic',
    title: `Buddy deploy${args.apply ? '' : ' (plan)'}`,
    kind: 'other',
    rawInput: { install: args.install, profile: args.profile ? Object.keys(args.profile) : undefined },
  }),
})

/* --------------------------------------------------------------- diagnosis */

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

/** Redact machine- and person-specific strings so a report can be pasted elsewhere. */
function redact(text) {
  let out = String(text ?? '')
  out = out.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-***')
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer ***')
  if (HOME) out = out.split(HOME).join('~')
  const user = process.env.USERNAME ?? process.env.USER
  if (user && user.length >= 3) out = out.split(user).join('USER').split(user.toLowerCase()).join('USER')
  return out
}

/** Facts about this plugin installation itself, including how it is mounted. */
function pluginSelf() {
  const manifest = readJson(join(PLUGIN_DIR, 'package.json'), {})
  const dependencies = []
  try {
    createRequire(join(PLUGIN_DIR, 'index.js')).resolve('@deepseek-ai/dsh-tools')
    dependencies.push({ name: '@deepseek-ai/dsh-tools', ok: true })
  } catch (error) {
    dependencies.push({ name: '@deepseek-ai/dsh-tools', ok: false, error: String(error?.message ?? error) })
  }
  const profileDir = process.env.DSH_PROFILE_DIR
  let linkage
  if (profileDir) {
    const profile = readJson(join(profileDir, 'package.json'), {})
    const bundles = profile?.dsh?.profile?.bundles
    linkage = clean({
      profile: process.env.DSH_PROFILE ?? undefined,
      dir: profileDir,
      inBundles: Array.isArray(bundles) ? bundles.includes(manifest.name) : undefined,
      dependency: profile?.dependencies?.[manifest.name],
    })
  }
  return clean({
    name: manifest.name,
    version: manifest.version,
    dir: PLUGIN_DIR,
    /** A local checkout is linked; Node resolves the real path, so the dependency link matters. */
    linkedCheckout: !/[\\/]node_modules[\\/]dsh-buddy-control$/.test(PLUGIN_DIR),
    dependencies,
    linkage,
  })
}

const buddyDoctor = defineTool({
  name: 'buddy_doctor',
  description:
    'Diagnose a broken or surprising install: plugin dependency/profile linkage, ledger writability, skill presence, device discovery, model drift, and recent failing runs with their gaps. Returns a redacted `report` that can be pasted to someone else for help. Zero model cost — start here when a buddy_* tool misbehaves.',
  parameters: {
    report: { type: 'boolean', description: 'Include the redacted text report; default true.' },
  },
  timeoutMs: 180_000,
  output: {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args) {
    const cfg = thisConfig
    const problems = []
    const note = (id, severity, detail, fix) => problems.push(clean({ id, severity, detail: redact(detail), fix }))

    const self = pluginSelf()
    if (self.dependencies.some((dep) => !dep.ok)) {
      note(
        'dependency',
        'blocker',
        'A runtime dependency does not resolve from the plugin directory.',
        'Run the bundled install.ps1 (it recreates the dependency link), then reload the plugin.',
      )
    }
    if (self.linkage?.inBundles === false) {
      note(
        'bundle-registration',
        'warn',
        'The package is not in this profile\'s dsh.profile.bundles list, so it will disappear on restart.',
        'Re-run install_bundle for this package, or add it to the profile package.json.',
      )
    }

    let ledgerWritable = false
    try {
      mkdirSync(cfg.stateDir, { recursive: true })
      const probe = join(cfg.stateDir, `.doctor-${process.pid}`)
      writeFileSync(probe, 'ok')
      unlinkSync(probe)
      ledgerWritable = true
    } catch (error) {
      note(
        'state',
        'blocker',
        `The ledger directory is not writable: ${String(error?.message ?? error)}`,
        'Fix permissions on ~/.dsh/buddy-control; no run can be recorded without it.',
      )
    }

    const snapshot = await discover(cfg, { refresh: true })
    if (!snapshot.components?.['codebuddy-cli']?.present) {
      note('codebuddy', 'blocker', 'The CodeBuddy CLI is not installed on this device.', 'buddy_deploy({install:{codebuddyCli:true}, apply:true, acceptInstall:true})')
    }
    if (!snapshot.components?.workbuddy?.present) {
      note('workbuddy', 'warn', 'WorkBuddy is not installed on this device.', 'buddy_deploy({install:{workbuddy:true}, apply:true, acceptInstall:true}); CodeBuddy alone can carry the work meanwhile.')
    }
    if (self.linkedCheckout) {
      const own = join(PLUGIN_DIR, 'node_modules', '@deepseek-ai', 'dsh-tools')
      if (!existsSync(own)) {
        note(
          'dependency-link',
          'warn',
          'This plugin runs from a linked checkout without its own dependency link, so a reinstall or a moved checkout will fail to import.',
          'Run install.ps1 — it creates node_modules/@deepseek-ai/dsh-tools as a directory junction.',
        )
      }
    }

    const resolved = await resolveModel(cfg, undefined)
    let patternOk = true
    try {
      patternOk = new RegExp(cfg.requiredModelPattern, 'i').test(resolved.id)
    } catch {
      patternOk = false
    }
    if (!patternOk) {
      note(
        'model-pattern',
        'warn',
        `The resolved model ${resolved.id} does not match requiredModelPattern ${cfg.requiredModelPattern}.`,
        'Set requiredModelPattern to the current DeepSeek family, or pin `model` explicitly.',
      )
    }
    if (resolved.policy === 'fallback') {
      note(
        'model-discovery',
        'warn',
        'The CLI did not advertise its model list, so the fallback model is in use.',
        'Verify `node <codebuddy entry> --help` prints "Currently supported: (...)". A broken entry makes discovery fall back.',
      )
    }
    const settings = readJson(settingsFile(cfg), {})
    if (settings.model && settings.model !== resolved.id) {
      note('model-drift', 'warn', `Worker settings pin ${settings.model} but this plugin pins ${resolved.id}.`, `buddy_provision({model:"${resolved.id}", apply:true})`)
    }

    const skill = join(HOME, '.dsh', 'skills', 'buddy-control', 'SKILL.md')
    if (!existsSync(skill)) {
      note('skill', 'info', 'The buddy-control skill is not installed, so a fresh session will not know the loop.', 'Copy skills/buddy-control/SKILL.md to ~/.dsh/skills/buddy-control/SKILL.md (install.ps1 does it).')
    }

    const devices = listDevices(cfg)
    if (devices.length === 0) {
      note('device-profile', 'info', 'No device profile has been saved yet.', 'buddy_discover() records one per host.')
    }

    const runs = listRuns(cfg, 5)
    for (const run of runs) {
      if (['open', 'rejected', 'accepted'].includes(run.status)) continue
      note('run-history', 'info', `Run ${run.runId} ended as ${run.status}.`, `buddy_gaps({runId:"${run.runId}"}) lists what the worker was missing.`)
    }

    const report = args.report === false ? undefined : redact([
      `dsh-buddy-control ${self.version}${self.linkage?.profile ? ` · profile ${self.linkage.profile}` : ''}`,
      `plugin dir : ${self.dir}`,
      `dependencies: ${self.dependencies.map((dep) => `${dep.name}=${dep.ok ? 'ok' : 'MISSING'}`).join(', ')}`,
      `device     : ${snapshot.device.host} (${snapshot.device.platform}/${snapshot.device.arch}) user=${snapshot.device.user} node=${snapshot.device.node}`,
      `workers    : codebuddy=${snapshot.components?.['codebuddy-cli']?.path ?? 'MISSING'} workbuddy=${snapshot.components?.workbuddy?.path ?? 'MISSING'}`,
      `missing    : ${snapshot.missing.length ? snapshot.missing.join(', ') : 'none'}`,
      `model      : ${resolved.id} (${resolved.policy}) label=${cfg.modelLabel} workerSettings=${settings.model ?? 'unset'}`,
      `ledger     : ${cfg.stateDir} writable=${ledgerWritable} runs=${runs.length} devices=${devices.length}`,
      `last runs  : ${runs.map((run) => `${run.runId}:${run.status}/${run.rounds}r`).join(' ') || 'none'}`,
      `problems   : ${problems.length ? problems.map((entry) => `${entry.severity}:${entry.id}`).join(' ') : 'none'}`,
      '',
      'Load-time failures cannot be diagnosed here: if a buddy_* tool is missing entirely and the',
      'logs show ERR_MODULE_NOT_FOUND, run install.ps1 — that failure happens before any tool exists.',
    ].join('\n'))

    return clean({
      ok: problems.every((entry) => entry.severity !== 'blocker'),
      plugin: self,
      device: snapshot.device,
      workers: {
        codebuddy: snapshot.components?.['codebuddy-cli']?.path,
        workbuddy: snapshot.components?.workbuddy?.path,
      },
      missing: snapshot.missing,
      model: { pinned: resolved.id, policy: resolved.policy, workerSettings: settings.model },
      ledger: { dir: cfg.stateDir, writable: ledgerWritable, runs: runs.length, devices: devices.length },
      problems,
      report,
      hint: problems.some((entry) => entry.severity === 'blocker')
        ? 'Fix the blocker(s) first; every other finding can wait.'
        : problems.length
          ? 'No blocker. Each `fix` above is a single tool call or a one-line edit.'
          : 'Nothing to fix on this device.',
    })
  },
})

const buddyStatus = defineTool({
  name: 'buddy_status',
  description:
    'Report this device, the worker fleet (resolved paths, not configured guesses), the model this plugin pins, config drift, the worker MCP/plugin inventory, other device profiles, and the recent run ledger. Zero model cost — call it before delegating.',
  parameters: {
    runs: { type: 'integer', description: 'Ledger entries to list, default 5.' },
    refresh: { type: 'boolean', description: 'Re-probe the device instead of using the cached inventory.' },
  },
  timeoutMs: 180_000,
  output: {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args) {
    const cfg = thisConfig
    const snapshot = await discover(cfg, { refresh: args.refresh === true })
    const resolved = await resolveModel(cfg, undefined)
    const settings = readJson(settingsFile(cfg), {})
    const mcpConfig = readJson(mcpFile(cfg), { mcpServers: {} })
    const pattern = new RegExp(cfg.requiredModelPattern, 'i')
    const cli = snapshot.components?.['codebuddy-cli']
    const workbuddy = snapshot.components?.workbuddy

    return clean({
      device: snapshot.device,
      workers: {
        codebuddy: {
          installed: cli?.present === true,
          entry: cli?.path,
          onPath: cli?.onPath,
          version: cli?.path
            ? await run(snapshot.components?.node?.path ?? 'node', [cli.path, '--version'], { timeoutMs: 20_000, captureChars: 2000, env: { CODEBUDDY_SKIP_GIT_BASH_CHECK: '1' } })
              .then((out) => (out.code === 0 ? `${out.stdout}\n${out.stderr}`.match(/\d+\.\d+\.\d+/)?.[0] : undefined))
              .catch(() => undefined)
            : undefined,
        },
        workbuddy: {
          installed: workbuddy?.present === true,
          app: workbuddy?.path,
          cli: workbuddy?.cli,
          version: workbuddy?.version,
          note: workbuddy?.present ? 'headless CLI needs an interactive /login; a run reports needsLogin instead of guessing' : undefined,
        },
      },
      missing: snapshot.missing,
      model: {
        pinned: resolved.id,
        policy: resolved.policy,
        label: cfg.modelLabel,
        requiredPattern: cfg.requiredModelPattern,
        compliant: pattern.test(resolved.id),
        workerSettings: settings.model,
        drift: settings.model && settings.model !== resolved.id ? { settings: settings.model, pinned: resolved.id } : undefined,
      },
      workerCapabilities: {
        mcpServers: Object.keys(mcpConfig.mcpServers ?? {}),
        enabledPlugins: Object.keys(settings.enabledPlugins ?? {}),
        trustedDirectories: Array.isArray(settings.trustedDirectories) ? settings.trustedDirectories.length : 0,
      },
      devices: listDevices(cfg),
      runs: listRuns(cfg, Math.min(20, Math.max(1, args.runs ?? 5))),
      ledger: join(cfg.stateDir, 'runs'),
      note: 'Model evidence comes from each attempt\'s providerData.requestModelId, so a silent fallback is reported as model.drift.',
    })
  },
})

/** Filled by `apply`; the tool closures read the resolved config at call time. */
let thisConfig = { ...DEFAULTS }
/** The plugin's own Cordis context, for optional service lookups from tool bodies. */
let thisContext

/**
 * Register the buddy-control tools on `ctx.tools`.
 * @param ctx Cordis context carrying the tool registry
 * @param config profile-patch config merged over DEFAULTS
 */
export function apply(ctx, config = {}) {
  thisConfig = { ...DEFAULTS, ...(config ?? {}) }
  thisContext = ctx
  // Prefer the session's working directory over the Host process cwd, so a call
  // that omits `cwd` still lands where the user actually is.
  try {
    const workingDirectory = ctx.get?.('workingDirectory')
    const directory = workingDirectory?.defaultDirectory
    if (typeof directory === 'string' && existsSync(directory)) thisConfig.defaultCwd = directory
  } catch {
    /* optional: the service may not be mounted in a headless composition */
  }
  mkdirSync(runsDir(thisConfig), { recursive: true })
  for (const tool of [buddyRun, buddyReview, buddyGaps, buddyProvision, buddyDiscover, buddyDeploy, buddyDoctor, buddyStatus]) {
    // Re-bind per registration so a profile reload with new config takes effect.
    ctx.tools.register(tool)
  }
}
