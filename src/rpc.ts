/**
 * RPC contract shared by the server part (which fetches the quota and owns the
 * cache) and the TUI part (which renders it in the session sidebar).
 */

import { Rpc } from "@opencode/plugin/rpc"

/** One quota window as shown in the sidebar. */
export interface QuotaWindow {
  title: string
  used: number // percentage 0-100
  resetsAt?: string | null // ISO 8601
}

/** Snapshot returned by `status` and broadcast with `updated`. */
export interface QuotaStatus {
  /** True when `windows` comes from a successful fetch (possibly an older one). */
  ok: boolean
  windows: QuotaWindow[]
  source?: string
  /** Epoch ms of the last successful fetch. */
  fetchedAt?: number
  /** Error of the most recent fetch attempt, if it failed. */
  error?: string
}

const statusSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    windows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          used: { type: "number" },
          resetsAt: { type: ["string", "null"] },
        },
        required: ["title", "used"],
      },
    },
    source: { type: "string" },
    fetchedAt: { type: "number" },
    error: { type: "string" },
  },
  required: ["ok", "windows"],
}

export const ClaudeQuota = Rpc.define({
  id: "claude-quota",
  methods: {
    status: {
      input: {
        type: "object",
        properties: {
          /** Bypass the regular cache interval (still rate-limited to a shorter minimum). */
          force: { type: "boolean" },
        },
        additionalProperties: false,
      },
      output: statusSchema,
    },
  },
  events: {
    updated: { schema: statusSchema },
  },
})
