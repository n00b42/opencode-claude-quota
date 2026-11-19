/**
 * Claude Quota sidebar (TUI part).
 *
 * Shows the Claude subscription quota (5-hour and weekly windows) as a section
 * in the session sidebar. Data comes from the server part over the
 * `claude-quota` RPC; the server caches it, so polling here is cheap.
 *
 * Refreshes: every POLL_MS, after each finished turn, and immediately whenever
 * the server fetches (e.g. the `quota` tool or `/quota` ran).
 */

import { createEffect, createSignal, For, on, Show } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { ClaudeQuota, type QuotaStatus, type QuotaWindow } from "./rpc.ts"

const POLL_MS = 60_000
const BAR_WIDTH = 10

/**
 * Providers billed against the Claude subscription. The section is shown, and
 * polled, only while the prompt's selected model belongs to one of them.
 */
const CLAUDE_PROVIDERS = new Set(["claude-agent", "anthropic"])

function bar(used: number): string {
  const clamped = Math.min(100, Math.max(0, used))
  const filled = Math.round((clamped / 100) * BAR_WIDTH)
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled)
}

function resetsIn(resetsAt: string | null | undefined, now: number): string {
  if (!resetsAt) return "?"
  const diff = new Date(resetsAt).getTime() - now
  if (Number.isNaN(diff)) return "?"
  if (diff <= 0) return "now"
  const hours = Math.floor(diff / 3_600_000)
  const minutes = Math.floor((diff % 3_600_000) / 60_000)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** Short sidebar labels for the server's window titles. */
function label(title: string): string {
  switch (title) {
    case "Session (5h)":
      return "5h"
    case "Weekly":
      return "Week"
    case "Weekly Opus":
      return "Opus"
    case "Weekly Sonnet":
      return "Sonnet"
    default:
      return title
  }
}

export default Plugin.define({
  id: "claude-quota.sidebar",
  setup(context) {
    const [status, setStatus] = createSignal<QuotaStatus | undefined>()
    const [rpcError, setRpcError] = createSignal<string | undefined>()
    const [now, setNow] = createSignal(Date.now())
    let disposed = false

    // Read context.client on every call: it changes after a server restart.
    const api = () => context.client.rpc(ClaudeQuota)

    // Reactive: follows model switches in the prompt.
    const isClaude = () => CLAUDE_PROVIDERS.has(context.ui.model.current()?.providerID ?? "")

    const refresh = async (force = false) => {
      if (!isClaude()) return
      try {
        const next = (await api().status({ force })) as QuotaStatus
        if (disposed) return
        setStatus(next)
        setRpcError(undefined)
      } catch (err) {
        if (disposed) return
        setRpcError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!disposed) setNow(Date.now())
      }
    }

    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    const stopTurn = context.data.on("session.execution.succeeded", () => void refresh())
    const stopUpdated = api().events.on("updated", (event: { data: unknown }) => {
      if (disposed) return
      setStatus(event.data as QuotaStatus)
      setRpcError(undefined)
      setNow(Date.now())
    })

    const theme = context.theme
    const levelColor = (used: number) =>
      used >= 90 ? theme.text.feedback.error.base : used >= 70 ? theme.text.feedback.warning.base : theme.text.muted

    const windows = () => status()?.windows ?? []
    const labelWidth = () => Math.max(4, ...windows().map((w) => label(w.title).length))
    const error = () => rpcError() ?? status()?.error

    const Row = (props: { window: QuotaWindow }) => (
      <box flexDirection="row" gap={1}>
        <text fg={theme.text.muted} flexShrink={0}>
          {label(props.window.title).padEnd(labelWidth())}
        </text>
        <text fg={levelColor(props.window.used)} flexShrink={0}>
          {`${bar(props.window.used)} ${String(props.window.used).padStart(3)}%`}
        </text>
        <text fg={theme.text.muted} flexShrink={0}>
          {`· ${resetsIn(props.window.resetsAt, now())}`}
        </text>
      </box>
    )

    context.ui.slot({
      append: "sidebar.content",
      render: () => {
        // Switching to a Claude model: refresh right away instead of waiting
        // for the next poll (the server cache still limits real fetches).
        createEffect(on(isClaude, (claude) => claude && void refresh(), { defer: true }))
        return (
        <Show when={isClaude() && (status() || rpcError())}>
          <box>
            <text fg={theme.text.base}>
              <b>Claude quota</b>
            </text>
            <For each={windows()}>{(window) => <Row window={window} />}</For>
            <Show when={windows().length === 0}>
              <text fg={theme.text.muted}>unavailable</text>
            </Show>
            <Show when={error()}>
              <text fg={windows().length > 0 ? theme.text.muted : theme.text.feedback.error.base}>
                {windows().length > 0 ? "stale: last refresh failed" : error()}
              </text>
            </Show>
          </box>
        </Show>
        )
      },
    })

    return () => {
      disposed = true
      clearInterval(timer)
      stopTurn?.()
      stopUpdated?.()
    }
  },
})
