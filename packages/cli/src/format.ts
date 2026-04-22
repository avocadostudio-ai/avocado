import pc from "picocolors"

export const ui = {
  success: (msg: string) => console.log(pc.green("✓") + " " + msg),
  error: (msg: string) => console.error(pc.red("✗") + " " + msg),
  warn: (msg: string) => console.warn(pc.yellow("!") + " " + msg),
  info: (msg: string) => console.log(pc.cyan("i") + " " + msg),
  dim: (msg: string) => console.log(pc.dim(msg)),
  section: (title: string) => console.log("\n" + pc.bold(title)),
  kv: (key: string, value: string | number | undefined | null) => {
    const v = value === undefined || value === null || value === "" ? pc.dim("—") : String(value)
    console.log("  " + pc.dim(key.padEnd(14)) + " " + v)
  },
}

export function fail(message: string, detail?: string): never {
  ui.error(message)
  if (detail) console.error(pc.dim("  " + detail))
  process.exit(1)
}

export function requireSiteId(siteId: string | undefined): string {
  if (!siteId) {
    fail(
      "No site ID resolved.",
      "Pass --site <id>, or set NEXT_PUBLIC_DEFAULT_SITE_ID / AVC_SITE_ID in .env.local.",
    )
  }
  return siteId
}
