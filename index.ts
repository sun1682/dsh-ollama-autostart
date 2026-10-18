import { spawn, spawnSync } from 'node:child_process'
import { Socket } from 'node:net'
import { join } from 'node:path'

type PluginLogger = {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

type PluginContext = {
  on(event: 'ready', listener: () => void | Promise<void>): unknown
  on(event: 'dispose', listener: () => void | Promise<void>): unknown
  logger(name: string): PluginLogger
}

export const name = 'dsh-ollama-autostart'

// CUSTOMIZE BEFORE SHARING: keep this on loopback unless you intentionally want network access.
const HOST = '127.0.0.1'
// CUSTOMIZE BEFORE SHARING: choose the port for this machine and use the same port in DSH's API URL.
const PORT = 11434
const POLL_INTERVAL_MS = 1_000
const STARTUP_TIMEOUT_MS = 60_000
const CONNECT_TIMEOUT_MS = 1_000

/** Returns true when something accepts TCP connections on the Ollama port. */
function isOllamaPortOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket()
    let settled = false

    const finish = (isOpen: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(isOpen)
    }

    socket.setTimeout(CONNECT_TIMEOUT_MS)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(PORT, HOST)
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveOllamaCommand(): string {
  const localAppData = process.env.LOCALAPPDATA
  // Do not probe with existsSync here. DSH's plugin runtime may restrict file
  // metadata access outside the workspace even when Windows can launch the exe.
  // The probe then falsely falls back to `ollama`, which is often not on PATH.
  if (localAppData) return join(localAppData, 'Programs', 'Ollama', 'ollama.exe')
  return 'ollama'
}

async function startOllama(
  ctx: PluginContext,
  onStarted: (child: ReturnType<typeof spawn>) => void,
  onAlreadyRunning: (pid: number | undefined) => void,
): Promise<void> {
  const logger = ctx.logger('dsh-ollama-autostart')

  if (await isOllamaPortOpen()) {
    logger.info('Ollama is already listening on %s:%d; skipping startup.', HOST, PORT)
    const pid = findOllamaListenerPid()
    if (pid) {
      logger.info('Recorded the existing Ollama listener process with PID %d for shutdown.', pid)
    } else {
      logger.warn('Ollama is listening, but its process could not be identified; it cannot be stopped automatically.')
    }
    onAlreadyRunning(pid)
    return
  }

  if (process.platform !== 'win32') {
    logger.warn('Ollama is not listening on %s:%d. Automatic startup is configured for Windows only.', HOST, PORT)
    return
  }

  let child: ReturnType<typeof spawn>
  try {
    const command = resolveOllamaCommand()
    logger.info('Starting Ollama with "%s" serve.', command)
    child = spawn(command, ['serve'], {
      detached: true,
      env: {
        ...process.env,
        OLLAMA_HOST: `${HOST}:${PORT}`,
      },
      stdio: 'ignore',
      windowsHide: true,
    })
    onStarted(child)
    child.once('spawn', () => logger.info('Ollama process started with PID %d.', child.pid))
    child.once('error', (error) => {
      logger.error(
        'Failed to start Ollama with "%s": %s (%s). Set LOCALAPPDATA to the Ollama install root or add Ollama to PATH.',
        command,
        error.message,
        error.code ?? 'unknown error',
      )
    })
    child.unref()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('Failed to start Ollama: %s', message)
    return
  }

  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isOllamaPortOpen()) {
      logger.info('Ollama is ready on %s:%d.', HOST, PORT)
      return
    }
    await delay(POLL_INTERVAL_MS)
  }

  logger.error(
    'Timed out after %d ms waiting for Ollama at %s:%d. Check the Ollama executable and startup logs.',
    STARTUP_TIMEOUT_MS,
    HOST,
    PORT,
  )
}

function findOllamaListenerPid(): number | undefined {
  if (process.platform !== 'win32') return undefined

  const netstat = spawnSync('netstat', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
  })
  if (netstat.status !== 0 || !netstat.stdout) return undefined

  for (const line of netstat.stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    if (
      columns[0]?.toUpperCase() !== 'TCP' ||
      !columns[1]?.endsWith(`:${PORT}`) ||
      columns[3]?.toUpperCase() !== 'LISTENING'
    ) continue

    const pid = Number(columns[columns.length - 1])
    if (!Number.isInteger(pid) || pid <= 0) continue

    const tasklist = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    })
    if (tasklist.status === 0 && /^"ollama\.exe","\d+"/i.test(tasklist.stdout.trim())) return pid
  }

  return undefined
}

function stopOllama(pid: number, ctx: PluginContext): void {
  const logger = ctx.logger('dsh-ollama-autostart')
  if (process.platform !== 'win32' || !pid) return

  try {
    // Run synchronously during dispose so DSH cannot exit before taskkill starts.
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: 'ignore',
      windowsHide: true,
    })
    if (result.status === 0) logger.info('Stopped the Ollama listener process tree.')
    else if (result.error) logger.warn('Failed to stop Ollama: %s', result.error.message)
    else logger.warn('Could not stop the Ollama process tree (taskkill exit code %s).', result.status)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn('Failed to stop Ollama during DSH shutdown: %s', message)
  }
}

export function apply(ctx: PluginContext) {
  const logger = ctx.logger('dsh-ollama-autostart')
  let startup: Promise<void> | undefined
  let readySeen = false
  let managedPid: number | undefined
  let disposed = false
  let stopped = false

  const stopStartedOllama = () => {
    if (!managedPid || stopped) return
    stopped = true
    stopOllama(managedPid, ctx)
  }

  const startOnce = () => {
    startup ??= startOllama(ctx, (child) => {
      if (child.pid) managedPid = child.pid
      if (disposed) stopStartedOllama()
    }, (pid) => {
      managedPid = pid
      if (disposed) stopStartedOllama()
    })
    return startup
  }

  logger.info('Plugin loaded; waiting for the Cordis ready event.')
  ctx.on('ready', () => {
    readySeen = true
    return startOnce()
  })

  // Record either the listener already present at startup or the process this
  // plugin launches, then stop that Ollama process when DSH exits.
  ctx.on('dispose', () => {
    disposed = true
    stopStartedOllama()
  })

  // Cordis dispose is the normal path; process exit is an additional fallback.
  process.once('exit', () => {
    if (managedPid) stopOllama(managedPid, ctx)
  })

  // Some hosts finish emitting `ready` before dynamically loaded bundles
  // register their listeners. Preserve the normal lifecycle path, but recover
  // if DSH loaded this plugin after that event had already passed.
  setTimeout(() => {
    if (!readySeen) {
      logger.warn('Cordis ready event was not observed; starting Ollama after plugin load as a fallback.')
      void startOnce()
    }
  }, 1_500)
}
