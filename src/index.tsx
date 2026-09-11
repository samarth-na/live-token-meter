/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import { createTracker, type TpsStore } from "./tracker"
import { TpsFooter } from "./tps-panel"

export type TpsOptions = {
  /** Set to false to disable the plugin. Default: true. */
  enabled?: boolean
  /** Approximate chars per token used for the live estimate. Default: 4. */
  charsPerToken?: number
  /** Show the session-wide cumulative token total. Default: true. */
  showTotals?: boolean
}

type Context = Plugin.Context

/**
 * live-token-meter — live tokens-per-second in the OpenCode 2.0 TUI prompt
 * footer.
 *
 * Native opencode2 (merged PR #45265) already shows settled turn throughput
 * (`· X.X tok/s`) in the assistant footer from `time.streamed - time.created`
 * (output tokens only, tool time excluded) behind the `session.tps` setting.
 * This plugin complements it: live rolling tok/s while streaming (requested
 * in issue #47914, which native does not provide), plus the last-step rate
 * computed the same native way and the session total.
 *
 * Registers the `prompt.footer.status` slot so the status line in the prompt
 * footer shows a live TPS readout while the model streams, and the settled
 * step stats once the step finishes.
 */
export default Plugin.define({
  id: "live-token-meter",
  setup: (context: Context) => {
    const options: Required<TpsOptions> = {
      enabled: true,
      charsPerToken: 4,
      showTotals: true,
      ...context.options,
    }
    if (!options.enabled) return

    const [store, mutate] = context.storage.memory<TpsStore>("live-token-meter", {
      initial: { sessions: {} },
    })
    const tracker = createTracker(options.charsPerToken, mutate)

    const unsubs: Array<() => void> = [
      context.data.on("session.step.started", (event) =>
        tracker.stepStarted(
          event.data.sessionID,
          event.created,
          event.data.model.id,
          // PR #47125 adds request-start `started`; older servers omit it.
          (event.data as { started?: number }).started,
        ),
      ),
      context.data.on("session.text.started", (event) => tracker.textStarted(event.data.sessionID)),
      context.data.on("session.text.delta", (event) =>
        tracker.delta(event.data.sessionID, event.data.delta, event.created),
      ),
      // Reasoning excluded from TPS (native is visible-output-only).
      context.data.on("session.reasoning.delta", (event) =>
        tracker.reasoningDelta(event.data.sessionID),
      ),
      context.data.on("session.text.ended", (event) => tracker.textEnded(event.data.sessionID)),
      // Merged PR #45265: provider response-body boundary, before tool settlement.
      // Registered defensively: old servers never emit it and settlement falls
      // back to `step.ended`.
      ...((() => {
        try {
          return [
            (context.data.on as (...args: [string, (event: any) => void]) => () => void)(
              "session.step.streamed",
              (event) => tracker.streamed(event.data.sessionID, event.created),
            ),
          ]
        } catch {
          return []
        }
      })()),
      context.data.on("session.step.ended", (event) => {
        tracker.stepEnded(event.data.sessionID, event.created, event.data.tokens, event.data.finish)
        if (options.showTotals) {
          tracker.setTotalTokens(event.data.sessionID, sumSessionTokens(context, event.data.sessionID))
        }
      }),
      context.data.on("session.step.failed", (event) =>
        tracker.stepFailed(event.data.sessionID, event.data.error?.message ?? "step failed"),
      ),
      context.ui.slot({
        append: "prompt.footer.status",
        render: (props) => (
          <TpsFooter
            sessionID={props.sessionID}
            store={store}
            theme={context.theme}
            showTotals={options.showTotals}
          />
        ),
      }),
    ]

    return () => {
      for (const unsub of unsubs) unsub()
    }
  },
})

/** Sum assistant visible-output tokens across a session's messages.
 *  Matches native `turnTokensPerSecond` (output only, reasoning excluded). */
function sumSessionTokens(context: Context, sessionID: string): number {
  let total = 0
  for (const message of context.data.session.message.list(sessionID)) {
    if (message.type !== "assistant") continue
    total += message.tokens?.output ?? 0
  }
  return total
}
