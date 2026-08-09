/** @jsxImportSource @opentui/solid */
import type { ResolvedTheme } from "@opencode-ai/theme/tui"
import { Show } from "solid-js"
import type { Store } from "solid-js/store"
import type { TpsSession, TpsStore } from "./tracker"

/**
 * Formatting helpers.
 */

export function formatTps(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1)
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value < 1000) return String(Math.round(value))
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`
  return `${Math.round(value / 1000)}k`
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/**
 * Prompt-footer readout. Renders inside the `prompt.footer.end` slot, on the
 * same line as the context indicator: a live TPS value while a step streams,
 * the settled step stats when it finishes, and the session-wide token total.
 */
export function TpsFooter(props: {
  sessionID?: string
  store: Store<TpsStore>
  theme: ResolvedTheme
  showTotals: boolean
}) {
  const session = (): TpsSession | undefined =>
    props.sessionID ? props.store.sessions[props.sessionID] : undefined
  const text = props.theme.text
  const feedback = text.feedback

  return (
    <text wrapMode="none">
      <Show when={session()}>
        {(item) => (
          <>
            <Show when={item().status === "streaming" || item().status === "working"}>
              <span style={{ fg: text.action.primary.default }}>
                {item().status === "streaming" ? formatTps(item().liveTps) : "—"} tok/s
              </span>
            </Show>
            <Show when={item().status === "done"}>
              <span style={{ fg: feedback.success.default }}>✓</span>
              <span style={{ fg: text.default }}>
                {" "}
                {formatTps(item().lastTps)} tok/s · {formatTokens(item().lastTokens)} tok
              </span>
            </Show>
            <Show when={item().status === "failed"}>
              <span style={{ fg: feedback.error.default }}>✗ step failed</span>
            </Show>
            <Show when={props.showTotals && item().totalTokens > 0}>
              <span style={{ fg: text.subdued }}> · total {formatTokens(item().totalTokens)} tok</span>
            </Show>
          </>
        )}
      </Show>
    </text>
  )
}
