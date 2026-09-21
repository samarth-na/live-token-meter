/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
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
 * Shows estimated throughput for text, reasoning, and tool-call arguments.
 * Completed-step rates and session totals use provider output tokens.
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
      context.data.on("session.execution.started", (event) => tracker.waiting(event.data.sessionID)),
      context.data.on("session.retry.scheduled", (event) => tracker.waiting(event.data.sessionID)),
      context.data.on("session.step.started", (event) =>
        tracker.stepStarted(
          event.data.sessionID,
          event.created,
          event.data.model.id,
          event.data.started,
        ),
      ),
      context.data.on("session.text.started", (event) => tracker.textStarted(event.data.sessionID)),
      context.data.on("session.text.delta", (event) =>
        tracker.delta(event.data.sessionID, event.data.delta, event.created),
      ),
      context.data.on("session.reasoning.started", (event) => tracker.reasoningStarted(event.data.sessionID)),
      context.data.on("session.reasoning.delta", (event) =>
        tracker.reasoningDelta(event.data.sessionID, event.data.delta, event.created),
      ),
      context.data.on("session.reasoning.ended", (event) => tracker.reasoningEnded(event.data.sessionID)),
      context.data.on("session.text.ended", (event) => tracker.textEnded(event.data.sessionID)),
      context.data.on("session.tool.input.started", (event) =>
        tracker.toolInputStarted(event.data.sessionID, event.data.id),
      ),
      context.data.on("session.tool.input.delta", (event) =>
        tracker.toolInputDelta(event.data.sessionID, event.data.id, event.data.delta, event.created),
      ),
      context.data.on("session.tool.input.ended", (event) =>
        tracker.toolInputEnded(event.data.sessionID, event.data.id),
      ),
      context.data.on("session.tool.called", (event) => tracker.toolCalled(event.data.sessionID, event.data.id)),
      context.data.on("session.tool.success", (event) => tracker.toolEnded(event.data.sessionID, event.data.id)),
      context.data.on("session.tool.failed", (event) => tracker.toolEnded(event.data.sessionID, event.data.id)),
      context.data.on("session.step.streamed", (event) =>
        tracker.streamed(event.data.sessionID, event.created),
      ),
      context.data.on("session.step.ended", (event) => {
        tracker.stepEnded(event.data.sessionID, event.created, event.data.tokens, event.data.finish)
        if (options.showTotals) {
          tracker.setTotalTokens(event.data.sessionID, sumSessionTokens(context, event.data.sessionID))
        }
      }),
      context.data.on("session.step.failed", (event) =>
        tracker.stepFailed(event.data.sessionID, event.data.error?.message ?? "step failed"),
      ),
      context.data.on("session.execution.interrupted", (event) => tracker.interrupted(event.data.sessionID)),
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

/** Sum provider output tokens from cached assistant messages, excluding reasoning. */
function sumSessionTokens(context: Context, sessionID: string): number {
  let total = 0
  for (const message of context.data.session.message.list(sessionID)) {
    if (message.type !== "assistant") continue
    total += message.tokens?.output ?? 0
  }
  return total
}
