/**
 * Claude Quota Plugin (OpenCode V2)
 *
 * Provides a `quota` tool that shows the Claude subscription quota
 * (5-hour session window and weekly window) from the Claude.ai usage API,
 * plus local per-session token/cost tracking. `quotaReset` clears the
 * local counters of the current session.
 *
 * Credentials are taken from, in order:
 *   1. OpenCode's active `anthropic` OAuth connection (if logged in via OpenCode)
 *   2. Claude Code's ~/.claude/.credentials.json
 *   3. Legacy OpenCode V1 auth.json (`anthropic` oauth entry)
 *
 * Tokens are never refreshed here: OAuth refresh tokens rotate, so refreshing
 * from this plugin without writing back would log the owning client out.
 *
 * The quota is also exposed through the `claude-quota` RPC (see rpc.ts) so the
 * TUI part (tui.tsx) can show it in the session sidebar. Results are cached
 * here, shared by every connected TUI, so the usage API is not polled more
 * than once per CACHE_TTL_MS no matter how many windows are open.
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { ClaudeQuota, type QuotaStatus } from "./rpc.ts"

// ============================================================================
// Types
// ============================================================================

interface AccessToken {
  access: string
  expires?: number // epoch ms
  source: string
}

interface QuotaUsage {
  utilization?: number | null // Percentage (0-100)
  resets_at?: string | null // ISO 8601 timestamp
}

interface ClaudeUsageResponse {
  five_hour?: QuotaUsage | null
  seven_day?: QuotaUsage | null
  seven_day_sonnet?: QuotaUsage | null
  seven_day_opus?: QuotaUsage | null
}

interface LocalState {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheTokens: number
  cost: number
  requests: number
  sessionStart: number
}

// ============================================================================
// Local per-session tracking
// ============================================================================

const MAX_SESSIONS = 256
const sessions = new Map<string, LocalState>()

function freshState(): LocalState {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    cost: 0,
    requests: 0,
    sessionStart: Date.now(),
  }
}

function stateFor(sessionID: string): LocalState {
  let state = sessions.get(sessionID)
  if (!state) {
    state = freshState()
    sessions.set(sessionID, state)
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value
      if (oldest !== undefined) sessions.delete(oldest)
    }
  }
  return state
}

// ============================================================================
// Credentials
// ============================================================================

async function fromIntegration(ctx: any): Promise<AccessToken | null> {
  try {
    const connection = await ctx.integration?.connection?.active?.("anthropic")
    if (!connection) return null
    const value = await ctx.integration.connection.resolve(connection)
    if (value?.type === "oauth" && value.access) {
      return { access: value.access, expires: value.expires, source: "OpenCode anthropic login" }
    }
  } catch {}
  return null
}

function fromClaudeCode(): AccessToken | null {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
    const file = path.join(dir, ".credentials.json")
    const oauth = JSON.parse(fs.readFileSync(file, "utf-8"))?.claudeAiOauth
    if (oauth?.accessToken) {
      return { access: oauth.accessToken, expires: oauth.expiresAt, source: "Claude Code credentials" }
    }
  } catch {}
  return null
}

function fromLegacyAuthFile(): AccessToken | null {
  const candidates = [
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "opencode", "auth.json") : null,
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "opencode", "auth.json") : null,
  ].filter(Boolean) as string[]

  for (const file of candidates) {
    try {
      const auth = JSON.parse(fs.readFileSync(file, "utf-8"))?.anthropic
      if (auth?.type === "oauth" && auth.access) {
        return { access: auth.access, expires: auth.expires, source: "OpenCode auth.json" }
      }
    } catch {}
  }
  return null
}

async function getAccessTokens(ctx: any): Promise<AccessToken[]> {
  const tokens = [await fromIntegration(ctx), fromClaudeCode(), fromLegacyAuthFile()].filter(
    Boolean,
  ) as AccessToken[]
  // Prefer non-expired tokens, keep order otherwise.
  const now = Date.now()
  return [...tokens.filter((t) => !t.expires || t.expires > now), ...tokens.filter((t) => t.expires && t.expires <= now)]
}

// ============================================================================
// Claude.ai API
// ============================================================================

async function fetchClaudeUsage(
  token: string,
  signal?: AbortSignal,
): Promise<{ ok: true; data: ClaudeUsageResponse } | { ok: false; error: string }> {
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal,
    })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status} ${response.statusText}` }
    return { ok: true, data: (await response.json()) as ClaudeUsageResponse }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ============================================================================
// Formatting
// ============================================================================

function formatProgressBar(percentage: number, width: number = 20): string {
  const clamped = Math.min(100, Math.max(0, percentage))
  const filled = Math.round((clamped / 100) * width)
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`
}

function formatTimeRemaining(resetTime: string | null | undefined): string {
  if (!resetTime) return "unknown"
  const diffMs = new Date(resetTime).getTime() - Date.now()
  if (Number.isNaN(diffMs)) return "unknown"
  if (diffMs <= 0) return "resetting..."

  const hours = Math.floor(diffMs / 3_600_000)
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function formatWindow(title: string, usage: QuotaUsage | null | undefined): string {
  const used = Math.round(usage?.utilization ?? 0)
  return `### ${title}
${formatProgressBar(used)} **${used}%** used | **${100 - used}%** remaining
Resets in: ${formatTimeRemaining(usage?.resets_at)}`
}

function formatLocal(state: LocalState | undefined): string {
  const s = state ?? freshState()
  const total = s.inputTokens + s.outputTokens + s.reasoningTokens + s.cacheTokens
  const minutes = Math.floor((Date.now() - s.sessionStart) / 60_000)
  return `## Local Session Tracking

| Metric | Value |
|--------|-------|
| Tokens Used | ${total.toLocaleString()} |
| Input | ${s.inputTokens.toLocaleString()} |
| Output | ${s.outputTokens.toLocaleString()} |
| Reasoning | ${s.reasoningTokens.toLocaleString()} |
| Cache | ${s.cacheTokens.toLocaleString()} |
| Requests | ${s.requests} |
| Session Time | ${minutes} min |
| Est. Cost | $${s.cost.toFixed(4)} |`
}

// ============================================================================
// Plugin
// ============================================================================

const emptyInput = { type: "object", properties: {}, additionalProperties: false }

type QuotaResult =
  | { ok: true; source: string; quota: ClaudeUsageResponse }
  | { ok: false; reason: string }

async function fetchQuota(ctx: any, signal?: AbortSignal): Promise<QuotaResult> {
  const tokens = await getAccessTokens(ctx)
  if (tokens.length === 0) {
    return {
      ok: false,
      reason:
        "No Claude OAuth credentials found (checked OpenCode's anthropic login, ~/.claude/.credentials.json and auth.json).",
    }
  }

  const errors: string[] = []
  for (const token of tokens) {
    const result = await fetchClaudeUsage(token.access, signal)
    if (result.ok) return { ok: true, source: token.source, quota: result.data }
    const expired = token.expires && token.expires <= Date.now() ? " (token expired)" : ""
    errors.push(`${token.source}: ${result.error}${expired}`)
  }
  return {
    ok: false,
    reason: `Could not fetch quota from Claude.ai (${errors.join("; ")}). If the token expired, start Claude Code (or re-login in OpenCode) to refresh it.`,
  }
}

function quotaWindows(quota: ClaudeUsageResponse): [string, QuotaUsage | null | undefined][] {
  const windows: [string, QuotaUsage | null | undefined][] = [
    ["Session (5h)", quota.five_hour],
    ["Weekly", quota.seven_day],
  ]
  if (quota.seven_day_opus?.utilization != null) windows.push(["Weekly Opus", quota.seven_day_opus])
  if (quota.seven_day_sonnet?.utilization != null) windows.push(["Weekly Sonnet", quota.seven_day_sonnet])
  return windows
}

// ============================================================================
// Shared cache (used by the sidebar RPC, refreshed by every fetch)
// ============================================================================

const CACHE_TTL_MS = 60_000 // regular refresh interval
const FORCE_MIN_MS = 15_000 // minimum age before a forced refresh refetches
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000 // after HTTP 429

let cached: QuotaStatus = { ok: false, windows: [] }
let lastAttempt = 0
let notBefore = 0
let inFlight: Promise<QuotaStatus> | null = null
let publish: (status: QuotaStatus) => void = () => {}

/** Fold a fetch result into the cache; keeps the last good windows on failure. */
function record(result: QuotaResult): QuotaStatus {
  if (result.ok) {
    cached = {
      ok: true,
      source: result.source,
      fetchedAt: Date.now(),
      windows: quotaWindows(result.quota).map(([title, usage]) => ({
        title,
        used: Math.round(usage?.utilization ?? 0),
        resetsAt: usage?.resets_at ?? null,
      })),
    }
  } else {
    if (/HTTP 429/.test(result.reason)) notBefore = Date.now() + RATE_LIMIT_BACKOFF_MS
    cached = { ...cached, error: result.reason }
  }
  publish(cached)
  return cached
}

async function fetchAndRecord(ctx: any, signal?: AbortSignal): Promise<QuotaResult> {
  lastAttempt = Date.now()
  const result = await fetchQuota(ctx, signal)
  record(result)
  return result
}

async function cachedStatus(ctx: any, force: boolean): Promise<QuotaStatus> {
  const now = Date.now()
  const age = now - lastAttempt
  if (now < notBefore || age < (force ? FORCE_MIN_MS : CACHE_TTL_MS)) return cached
  if (!inFlight) {
    inFlight = fetchAndRecord(ctx)
      .then(() => cached)
      .finally(() => {
        inFlight = null
      })
  }
  return inFlight
}

/** Markdown report for the model-facing `quota` tool. */
async function buildReport(ctx: any, sessionID: string | undefined, signal?: AbortSignal): Promise<string> {
  const local = formatLocal(sessionID ? sessions.get(sessionID) : undefined)
  const result = await fetchAndRecord(ctx, signal)
  if (!result.ok) {
    return `## Claude Quota

${result.reason}
You can also check https://claude.ai/settings/usage.

---

${local}`
  }

  const sections = quotaWindows(result.quota).map(([title, usage]) => formatWindow(title, usage))
  return `## Claude Quota (from Claude.ai, via ${result.source})

${sections.join("\n\n")}

---

${local}`
}

/** Compact plain-text report for the `/quota` command (the TUI shows it as-is, no Markdown). */
async function buildPlainReport(ctx: any, sessionID: string | undefined): Promise<string> {
  const s = (sessionID && sessions.get(sessionID)) || freshState()
  const total = s.inputTokens + s.outputTokens + s.reasoningTokens + s.cacheTokens
  const localLine =
    `This session: ${total.toLocaleString()} tokens ` +
    `(in ${s.inputTokens.toLocaleString()} · out ${s.outputTokens.toLocaleString()} · ` +
    `cache ${s.cacheTokens.toLocaleString()}) · ${s.requests} requests · $${s.cost.toFixed(4)}`

  const result = await fetchAndRecord(ctx)
  if (!result.ok) return `Claude quota: ${result.reason}\n${localLine}`

  const windows = quotaWindows(result.quota)
  const width = Math.max(...windows.map(([title]) => title.length))
  const lines = windows.map(([title, usage]) => {
    const used = Math.round(usage?.utilization ?? 0)
    return `${title.padEnd(width)}  ${formatProgressBar(used)} ${String(used).padStart(3)}% used · resets in ${formatTimeRemaining(usage?.resets_at)}`
  })
  return [`Claude quota (${result.source})`, ...lines, localLine].join("\n")
}

function resetSession(sessionID: string | undefined): string {
  const old = (sessionID && sessions.get(sessionID)) || freshState()
  const oldTotal = old.inputTokens + old.outputTokens + old.reasoningTokens + old.cacheTokens
  if (sessionID) sessions.set(sessionID, freshState())
  return `Local counters reset. Previous: ${oldTotal.toLocaleString()} tokens, $${old.cost.toFixed(4)}`
}

export default {
  id: "claude-quota",
  async setup(ctx: any) {
    const controller = new AbortController()

    // Track tokens per session from completed model steps.
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.step.ended", "session.created"],
          signal: controller.signal,
        })) {
          if (event.type === "session.created") {
            stateFor(event.data.sessionID)
            continue
          }
          const { sessionID, tokens, cost } = event.data ?? {}
          if (!sessionID) continue
          const state = stateFor(sessionID)
          state.inputTokens += tokens?.input || 0
          state.outputTokens += tokens?.output || 0
          state.reasoningTokens += tokens?.reasoning || 0
          state.cacheTokens += (tokens?.cache?.read || 0) + (tokens?.cache?.write || 0)
          state.cost += cost || 0
          state.requests += 1
        }
      } catch (err) {
        if (!controller.signal.aborted) console.error("[claude-quota] event subscription failed:", err)
      }
    })()

    // Tools the model can call.
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "quota",
        description:
          "Check your Claude subscription quota. Shows session (5-hour) and weekly usage with progress bars from the Claude.ai API, plus local token usage of this session.",
        input: emptyInput,
        execute: async (_input: unknown, context: any) => ({
          content: await buildReport(ctx, context?.sessionID, context?.signal),
        }),
      })

      editor.add({
        name: "quotaReset",
        description: "Reset the local quota tracking counters of the current session",
        input: emptyInput,
        execute: async (_input: unknown, context: any) => ({ content: resetSession(context?.sessionID) }),
      })
    })

    // Slash commands (/quota, /quota-reset): post the report into the session
    // without starting a model turn. The TUI renders a synthetic message as a
    // notice showing only its `description`, so the report goes there too.
    const post = (sessionID: string, text: string, description: string) =>
      ctx.session.synthetic({ sessionID, text, description, resume: false })

    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "quota",
        description: "Show Claude subscription quota (5-hour and weekly usage)",
        execute: async ({ sessionID }: { sessionID: string }) => {
          const report = await buildPlainReport(ctx, sessionID)
          await post(sessionID, report, report)
        },
      })

      editor.add({
        name: "quota-reset",
        description: "Reset local Claude quota token counters for this session",
        execute: async ({ sessionID }: { sessionID: string }) => {
          const message = resetSession(sessionID)
          await post(sessionID, message, message)
        },
      })
    })

    // Sidebar RPC: cached status plus an `updated` broadcast after each fetch.
    let registration: any
    try {
      registration = await ctx.rpc.register(ClaudeQuota, {
        status: async (input: unknown) => cachedStatus(ctx, (input as { force?: boolean } | undefined)?.force === true),
      })
      publish = (status) => {
        try {
          Promise.resolve(registration.events.emit("updated", status)).catch(() => {})
        } catch {}
      }
    } catch (err) {
      console.error("[claude-quota] RPC registration failed:", err)
    }

    return () => {
      controller.abort()
      publish = () => {}
      registration?.dispose?.()
    }
  },
}
