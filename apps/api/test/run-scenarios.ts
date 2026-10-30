// pnpm test:scenarios [--provider <id>] — recorded replay by default; with a provider, live accuracy.
import { spawnSync } from "node:child_process"
import { join } from "node:path"

const args = process.argv.slice(2)
const i = args.indexOf("--provider")
const env = { ...process.env }
if (i >= 0) {
  const id = args[i + 1]
  if (!["ollama", "anthropic", "openai"].includes(id ?? "")) {
    console.error("--provider must be ollama, anthropic or openai")
    process.exit(2)
  }
  env.SCENARIO_PROVIDER = id
}
const r = spawnSync(process.execPath, ["--import", "tsx", "--test", join(__dirname, "scenarios.test.ts")], { stdio: "inherit", env })
process.exit(r.status ?? 1)
