import { spawn, type ChildProcess } from "node:child_process"
import pc from "picocolors"
import { ui } from "../format.js"

type DevOptions = {
  orchestrator?: boolean
  editor?: boolean
  site?: boolean
  only?: string
}

type Service = {
  name: string
  color: (s: string) => string
  command: string
  args: string[]
}

const SERVICES: Record<string, Service> = {
  orchestrator: {
    name: "orchestrator",
    color: pc.magenta,
    command: "pnpm",
    args: ["--filter", "@ai-site-editor/orchestrator", "dev"],
  },
  editor: {
    name: "editor",
    color: pc.cyan,
    command: "pnpm",
    args: ["--filter", "@ai-site-editor/editor", "dev"],
  },
  site: {
    name: "site",
    color: pc.green,
    command: "pnpm",
    args: ["--filter", "@ai-site-editor/site", "dev"],
  },
}

const PREFIX_WIDTH = 14

function prefixStream(service: Service) {
  return (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
    for (const rawLine of text.split("\n")) {
      const line = rawLine.replace(/\r$/, "")
      if (!line) continue
      const tag = service.color(`[${service.name}]`.padEnd(PREFIX_WIDTH))
      process.stdout.write(`${tag} ${line}\n`)
    }
  }
}

function selectServices(opts: DevOptions): Service[] {
  if (opts.only) {
    const names = opts.only.split(",").map((s) => s.trim()).filter(Boolean)
    const bad = names.filter((n) => !SERVICES[n])
    if (bad.length) {
      ui.error(`Unknown service(s): ${bad.join(", ")}`)
      ui.dim(`  Known: ${Object.keys(SERVICES).join(", ")}`)
      process.exit(1)
    }
    return names.map((n) => SERVICES[n])
  }
  const out: Service[] = []
  if (opts.orchestrator !== false) out.push(SERVICES.orchestrator)
  if (opts.editor !== false) out.push(SERVICES.editor)
  if (opts.site) out.push(SERVICES.site)
  return out
}

export async function devCommand(opts: DevOptions): Promise<void> {
  const selected = selectServices(opts)

  ui.section("Avocado Studio — local dev")
  for (const s of selected) {
    const tag = s.color(`[${s.name}]`.padEnd(PREFIX_WIDTH))
    console.log(`${tag} ${pc.dim(`${s.command} ${s.args.join(" ")}`)}`)
  }
  console.log(pc.dim("\n  Press Ctrl-C once to stop gracefully, twice to force-kill.\n"))

  const children: ChildProcess[] = []
  for (const service of selected) {
    const proc = spawn(service.command, service.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    proc.stdout?.on("data", prefixStream(service))
    proc.stderr?.on("data", prefixStream(service))
    proc.on("error", (err) => {
      const tag = service.color(`[${service.name}]`.padEnd(PREFIX_WIDTH))
      process.stderr.write(`${tag} ${pc.red(`failed to spawn: ${err.message}`)}\n`)
    })
    children.push(proc)
  }

  // Ctrl-C UX: first press = SIGTERM + 5s grace; second press = SIGKILL now.
  let shutdownPhase: "running" | "graceful" | "forced" = "running"
  const shutdown = (signal: NodeJS.Signals) => {
    if (shutdownPhase === "running") {
      shutdownPhase = "graceful"
      console.log(pc.dim(`\n  Received ${signal}, stopping ${children.length} service${children.length === 1 ? "" : "s"}... (press again to force-kill)\n`))
      for (const proc of children) {
        if (!proc.killed) proc.kill("SIGTERM")
      }
      return
    }
    if (shutdownPhase === "graceful") {
      shutdownPhase = "forced"
      console.log(pc.yellow("\n  Force-killing services.\n"))
      for (const proc of children) {
        if (!proc.killed) proc.kill("SIGKILL")
      }
    }
  }

  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))

  const exitCodes = await Promise.all(
    children.map(
      (proc) =>
        new Promise<number>((resolve) => {
          proc.on("exit", (code) => resolve(code ?? 0))
        }),
    ),
  )

  const worst = exitCodes.reduce((acc, c) => (c !== 0 ? c : acc), 0)
  process.exit(worst)
}
