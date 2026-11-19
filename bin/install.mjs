#!/usr/bin/env node
/** Install the complete Claude Quota OpenCode plugin. */
import { copyFile, mkdir, access } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

const files = ["server.ts", "tui.tsx", "rpc.ts"]
const args = process.argv.slice(2)

function usage() {
  console.log(`Usage: claude-quota-install [--dest <plugin-directory>]

Copies ${files.join(", ")} into the OpenCode Claude Quota plugin directory.

Options:
  --dest <directory>  Install into this plugin directory
  -h, --help          Show this help`)
}

function optionValue(name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`)
  return value
}

async function main() {
  if (args.includes("--help") || args.includes("-h")) {
    usage()
    return
  }
  for (const arg of args) {
    if (arg !== "--dest" && arg !== optionValue("--dest")) {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  const configDir = process.env.OPENCODE_CONFIG_DIR
    ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode")
  const destination = path.resolve(optionValue("--dest") || path.join(configDir, "plugins", "claude-quota"))
  const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src")

  for (const file of files) await access(path.join(sourceDir, file))
  await mkdir(destination, { recursive: true })
  for (const file of files) await copyFile(path.join(sourceDir, file), path.join(destination, file))

  console.log(`Installed Claude Quota plugin (${files.join(", ")}) to ${destination}`)
  console.log("Restart OpenCode to load the plugin.")
}

main().catch((error) => {
  console.error(`claude-quota-install: ${error.message}`)
  process.exitCode = 1
})
