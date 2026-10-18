# dsh-ollama-autostart

A Cordis plugin bundle for DSH that checks whether the local Ollama service is available when the plugin becomes ready. On Windows, it starts the installed `ollama serve` command in the background when needed, waits for Ollama's native API port, and stops the identified Ollama process tree when DSH exits.

## Features

- Hooks into Cordis `ready` lifecycle.
- If DSH has already emitted `ready` before the plugin registers, starts once after a short fallback delay.
- Checks the configured loopback address and port before taking action. If Ollama is already listening, it identifies that listener so it can stop the service when DSH exits.
- On Windows, starts `ollama serve` with `windowsHide: true` and detached, ignored standard streams.
- Passes the configured address and port to Ollama through `OLLAMA_HOST`.
- When DSH disposes this plugin, stops the Ollama process tree whether the listener was already running or this plugin started it. For an existing listener, it uses Windows `netstat` and confirms the process name with `tasklist` before recording its PID.
- Polls the same port for up to 60 seconds and logs a timeout or startup error.
- Does not create an HTTP server, open an extra port, proxy traffic, or handle model inference. Ollama continues to provide its API on the configured port (including the OpenAI-compatible `/v1` endpoint where supported by the installed Ollama version).

## Requirements

- DSH with the Cordis plugin runtime.
- Windows for automatic process startup.
- Ollama installed. The plugin uses `%LOCALAPPDATA%\Programs\Ollama\ollama.exe` when `LOCALAPPDATA` is set; otherwise it falls back to `ollama` on `PATH`.
- Node.js 18 or later.

On non-Windows platforms, the plugin still checks the port. If Ollama is not already listening, it logs a warning and does not try to start a process.

## Install

The package declares `dsh.bundle.patch` in `package.json` and includes `cordis.patch.yml`, which inserts the plugin into the Cordis configuration layer. Install the package directory using your DSH plugin management workflow. The entry point uses a small structural type for the Cordis context and has no runtime import or package dependency on `cordis`.

## Configure your own port

Before sharing or installing the plugin, choose an unused local port and edit the clearly marked settings near the top of `index.ts`:

```ts
const HOST = '127.0.0.1' // keep local unless you intentionally want network access
const PORT = 11434      // CUSTOMIZE: change this to your own unused port
```

The plugin passes the same `HOST:PORT` to `ollama serve` with the `OLLAMA_HOST` environment variable. Ollama's default is `127.0.0.1:11434`; the configured value must match the port used in DSH's model provider API URL, for example `http://127.0.0.1:11435/v1` if `PORT` is changed to `11435`. See Ollama's [official FAQ for `OLLAMA_HOST`](https://github.com/ollama/ollama/blob/main/docs/faq.mdx).

Keep `HOST` set to `127.0.0.1` for this-machine-only access. Setting it to `0.0.0.0` exposes the service on network interfaces and should only be done intentionally.

## Behavior

1. When Cordis emits `ready`, the plugin attempts a TCP connection to the configured host and port. If that event has already passed, a 1.5-second fallback starts the same one-time check.
2. If a connection succeeds, startup is skipped.
3. If the port is closed on Windows, the plugin launches `ollama serve` without a visible console window.
4. The plugin checks once per second for up to 60 seconds and logs an error if the port does not become available.
5. The PID is recorded immediately after spawning. If Ollama was already listening, the plugin finds the process that owns the configured port and confirms that it is `ollama.exe`. When the Cordis context is disposed as DSH exits, it synchronously runs Windows `taskkill /T /F` for the recorded PID so DSH cannot exit before the stop request is issued. A process-exit hook repeats cleanup as a fallback.

The plugin only verifies that the TCP port accepts connections; it does not make HTTP requests or verify model availability.

## GitHub visibility

Anyone can clone or pull a public GitHub repository. If you do not want others to download this source, keep the repository private. If you publish it publicly, include your customized-port instructions and do not assume users can run it unchanged on a port that may conflict with their local setup.

## License

MIT
