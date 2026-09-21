/**
 * Live TPS tracker for the OpenCode 2.0.12 CLI plugin API.
 *
 * Settled TPS uses provider output tokens over the request-to-stream-end
 * window. This includes provider wait and excludes tool settlement. Without
 * a stream-end event, the window ends at step completion. Rates are hidden
 * for non-stop/length finishes, zero output, and windows shorter than 250ms.
 *
 * Live estimates use separate character counts for text, reasoning, and
 * tool arguments. Each clock starts at that kind's first delta, with a 1s
 * minimum denominator. Settled usage remains output-only.
 *
 * Reactive snapshots live in a solid-js store provided by the host
 * (`context.storage.memory`); only the non-reactive streaming counters
 * live here.
 */

export type TpsStatus = "idle" | "working" | "streaming" | "done" | "failed" | "interrupted"
export type TpsPhase = "waiting" | "text" | "reasoning" | "tool-input" | "tools" | "settling"

export type TpsSession = {
  /** Current phase of the most recent step. */
  status: TpsStatus
  /** Activity observed from stream and tool events. */
  phase?: TpsPhase
  /** Estimated tokens/sec while streaming (0 otherwise). */
  liveTps: number
  /** Estimated tokens for the current stream kind in this step. */
  liveTokens: number
  /** Milliseconds since the current stream kind's first delta. */
  elapsedMs: number
  /** Exact avg tokens/sec of the last completed step. 0 when suppressed. */
  lastTps: number
  /** Exact output tokens of the last completed step (reasoning excluded). */
  lastTokens: number
  /** Request-to-stream-end duration of the last completed step in ms. */
  lastDurationMs: number
  /** True when the last step produced no trustworthy rate (tool-call,
   *  error, buffered <250ms, or zero tokens). Panel hides the rate. */
  lastSuppressed?: boolean
  /** Provider finish reason of the last completed step. */
  lastFinish?: string
  /** Error message of a failed step. */
  error?: string
  /** Model id of the in-flight / last step. */
  model?: string
  /** Cumulative assistant output tokens across the whole session. */
  totalTokens: number
}

export type TpsStore = {
  sessions: Record<string, TpsSession>
}

export function emptySession(): TpsSession {
  return {
    status: "idle",
    liveTps: 0,
    liveTokens: 0,
    elapsedMs: 0,
    lastTps: 0,
    lastTokens: 0,
    lastDurationMs: 0,
    totalTokens: 0,
  }
}

export type Mutate = (mutation: (draft: TpsStore) => void) => void

/** Minimum live elapsed time (ms) used as the TPS denominator. */
const MIN_LIVE_ELAPSED_MS = 1000

/** Minimum settled window (ms). Below this a rate is a buffered-burst
 *  artifact (e.g. 4096 tokens in 29ms reading as 141k tok/s, issue #46883).
 *  Matches the 250ms floor proposed in upstream PR #42112. */
export const MIN_SETTLED_ELAPSED_MS = 250

type StreamKind = "text" | "reasoning" | "tool-input"

type Counters = {
  samples: Partial<Record<StreamKind, { chars: number; firstDelta: number }>>
  active?: StreamKind
  /** Timestamp (ms) of the current step start (request start when known). */
  stepStart: number | null
  /** Provider response-body end (`session.step.streamed`); null until seen. */
  streamed: number | null
  text: boolean
  reasoning: boolean
  responded: boolean
  toolInputs: Set<string>
  tools: Set<string>
}

export type TpsTracker = {
  waiting: (sessionID: string) => void
  stepStarted: (sessionID: string, createdMs: number, model?: string, requestStartedMs?: number) => void
  textStarted: (sessionID: string) => void
  delta: (sessionID: string, text: string, createdMs: number) => void
  reasoningDelta: (sessionID: string, text: string, createdMs: number) => void
  reasoningStarted: (sessionID: string) => void
  reasoningEnded: (sessionID: string) => void
  textEnded: (sessionID: string) => void
  toolInputStarted: (sessionID: string, id: string) => void
  toolInputDelta: (sessionID: string, id: string, text: string, createdMs: number) => void
  toolInputEnded: (sessionID: string, id: string) => void
  toolCalled: (sessionID: string, id: string) => void
  toolEnded: (sessionID: string, id: string) => void
  streamed: (sessionID: string, createdMs: number) => void
  stepEnded: (
    sessionID: string,
    createdMs: number,
    tokens: { output: number; reasoning?: number },
    finish: string,
  ) => void
  stepFailed: (sessionID: string, message: string) => void
  interrupted: (sessionID: string) => void
  setTotalTokens: (sessionID: string, tokens: number) => void
}

/** Completed text responses eligible for the settled output-token rate. */
export function isReportableFinish(finish: string): boolean {
  return finish === "stop" || finish === "length"
}

export function createTracker(charsPerToken: number, mutate: Mutate): TpsTracker {
  const counters = new Map<string, Counters>()

  function counter(sessionID: string): Counters {
    let entry = counters.get(sessionID)
    if (!entry) {
      entry = {
        samples: {},
        stepStart: null,
        streamed: null,
        text: false,
        reasoning: false,
        responded: false,
        toolInputs: new Set(),
        tools: new Set(),
      }
      counters.set(sessionID, entry)
    }
    return entry
  }

  function patch(sessionID: string, patch: Partial<TpsSession>) {
    mutate((draft) => {
      draft.sessions[sessionID] = {
        ...(draft.sessions[sessionID] ?? emptySession()),
        ...patch,
      }
    })
  }

  function progress(sessionID: string) {
    const entry = counter(sessionID)
    if (
      (entry.active === "text" && !entry.text) ||
      (entry.active === "reasoning" && !entry.reasoning) ||
      (entry.active === "tool-input" && !entry.toolInputs.size)
    ) entry.active = undefined
    if (entry.text || entry.reasoning || entry.toolInputs.size || entry.tools.size) entry.responded = true
    const phase: TpsPhase = entry.active ?? (
      entry.reasoning ? "reasoning" :
      entry.toolInputs.size ? "tool-input" :
      entry.tools.size ? "tools" :
      entry.text ? "text" :
      entry.responded || entry.streamed !== null ? "settling" : "waiting"
    )
    patch(sessionID, {
      phase,
      status: entry.active ? "streaming" : "working",
      ...(!entry.active ? { liveTps: 0, liveTokens: 0, elapsedMs: 0 } : {}),
    })
  }

  function delta(sessionID: string, kind: StreamKind, text: string, createdMs: number) {
    if (!text.length) return
    const entry = counter(sessionID)
    if (entry.stepStart === null) entry.stepStart = createdMs
    const sample = (entry.samples[kind] ??= { chars: 0, firstDelta: createdMs })
    sample.chars += text.length
    entry.active = kind
    entry.responded = true
    const elapsedMs = Math.max(1, createdMs - sample.firstDelta)
    const liveTokens = sample.chars / charsPerToken
    patch(sessionID, {
      status: "streaming",
      phase: kind,
      liveTokens,
      liveTps: liveTokens / (Math.max(MIN_LIVE_ELAPSED_MS, elapsedMs) / 1000),
      elapsedMs,
    })
  }

  return {
    waiting(sessionID) {
      counters.delete(sessionID)
      patch(sessionID, { status: "working", phase: "waiting", error: undefined, liveTps: 0, liveTokens: 0, elapsedMs: 0 })
    },

    stepStarted(sessionID, createdMs, model, requestStartedMs) {
      const entry = counter(sessionID)
      entry.samples = {}
      entry.active = undefined
      entry.stepStart = requestStartedMs ?? createdMs
      entry.streamed = null
      entry.text = false
      entry.reasoning = false
      entry.responded = false
      entry.toolInputs.clear()
      entry.tools.clear()
      patch(sessionID, {
        status: "working", phase: "waiting", error: undefined, model,
        liveTps: 0, liveTokens: 0, elapsedMs: 0,
      })
    },

    textStarted(sessionID) {
      const entry = counter(sessionID)
      entry.text = true
      if (entry.active === "text") entry.active = undefined
      progress(sessionID)
    },

    delta(sessionID, text, createdMs) {
      if (!text.length) return
      counter(sessionID).text = true
      delta(sessionID, "text", text, createdMs)
    },

    reasoningStarted(sessionID) {
      counter(sessionID).reasoning = true
      progress(sessionID)
    },

    reasoningDelta(sessionID, text, createdMs) {
      if (!text.length) return
      counter(sessionID).reasoning = true
      delta(sessionID, "reasoning", text, createdMs)
    },

    reasoningEnded(sessionID) {
      counter(sessionID).reasoning = false
      progress(sessionID)
    },

    textEnded(sessionID) {
      const entry = counter(sessionID)
      entry.text = false
      progress(sessionID)
    },

    toolInputStarted(sessionID, id) {
      counter(sessionID).toolInputs.add(id)
      progress(sessionID)
    },

    toolInputDelta(sessionID, id, text, createdMs) {
      if (!text.length) return
      counter(sessionID).toolInputs.add(id)
      delta(sessionID, "tool-input", text, createdMs)
    },

    toolInputEnded(sessionID, id) {
      counter(sessionID).toolInputs.delete(id)
      progress(sessionID)
    },

    toolCalled(sessionID, id) {
      const entry = counter(sessionID)
      entry.toolInputs.delete(id)
      entry.tools.add(id)
      progress(sessionID)
    },

    toolEnded(sessionID, id) {
      // Ignore late completions from a previous step or background tool.
      const entry = counters.get(sessionID)
      if (!entry) return
      const input = entry.toolInputs.delete(id)
      const running = entry.tools.delete(id)
      if (!input && !running) return
      progress(sessionID)
    },

    streamed(sessionID, createdMs) {
      const entry = counter(sessionID)
      entry.streamed = createdMs
      entry.text = false
      entry.reasoning = false
      entry.toolInputs.clear()
      progress(sessionID)
    },

    stepEnded(sessionID, createdMs, tokens, finish) {
      const entry = counter(sessionID)
      const output = tokens.output
      const endMs = entry.streamed ?? createdMs
      const elapsedMs = Math.max(1, endMs - (entry.stepStart ?? endMs))
      counters.delete(sessionID)
      if (!isReportableFinish(finish) || output <= 0 || elapsedMs < MIN_SETTLED_ELAPSED_MS) {
        patch(sessionID, {
          status: "done",
          lastTps: 0,
          lastTokens: output,
          lastDurationMs: elapsedMs,
          lastFinish: finish,
          lastSuppressed: true,
          liveTps: 0,
          liveTokens: 0,
          elapsedMs: 0,
        })
        return
      }
      patch(sessionID, {
        status: "done",
        lastTps: output / (elapsedMs / 1000),
        lastTokens: output,
        lastDurationMs: elapsedMs,
        lastFinish: finish,
        lastSuppressed: false,
        liveTps: 0,
        liveTokens: 0,
        elapsedMs: 0,
      })
    },

    stepFailed(sessionID, message) {
      counters.delete(sessionID)
      patch(sessionID, {
        status: "failed",
        error: message,
        liveTps: 0,
        liveTokens: 0,
        elapsedMs: 0,
      })
    },

    interrupted(sessionID) {
      counters.delete(sessionID)
      patch(sessionID, { status: "interrupted", liveTps: 0, liveTokens: 0, elapsedMs: 0 })
    },

    setTotalTokens(sessionID, tokens) {
      patch(sessionID, { totalTokens: tokens })
    },
  }
}
