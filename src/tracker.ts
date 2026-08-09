/**
 * Live TPS tracker for the OpenCode 2.0 TUI plugin API (next).
 *
 * Reactive snapshots live in a solid-js store provided by the host
 * (`context.storage.memory`); only the non-reactive streaming counters
 * (chars accumulated, step start) live here.
 */

export type TpsStatus = "idle" | "working" | "streaming" | "done" | "failed"

export type TpsSession = {
  /** Current phase of the most recent step. */
  status: TpsStatus
  /** Estimated tokens/sec while streaming (0 otherwise). */
  liveTps: number
  /** Estimated tokens produced this step so far. */
  liveTokens: number
  /** Milliseconds since the step started streaming. */
  elapsedMs: number
  /** Exact avg tokens/sec of the last completed step. */
  lastTps: number
  /** Exact output (+reasoning) tokens of the last completed step. */
  lastTokens: number
  /** Duration of the last completed step in ms. */
  lastDurationMs: number
  /** Provider finish reason of the last completed step. */
  lastFinish?: string
  /** Error message of a failed step. */
  error?: string
  /** Model id of the in-flight / last step. */
  model?: string
  /** Cumulative assistant tokens across the whole session. */
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

type Counters = {
  /** Accumulated chars from text + reasoning deltas of the in-flight step. */
  chars: number
  /** Timestamp (ms) of the current step start; null before any step. */
  stepStart: number | null
}

export type TpsTracker = {
  stepStarted: (sessionID: string, createdMs: number, model?: string) => void
  textStarted: (sessionID: string) => void
  delta: (sessionID: string, text: string, createdMs: number) => void
  textEnded: (sessionID: string) => void
  stepEnded: (
    sessionID: string,
    createdMs: number,
    tokens: { output: number; reasoning?: number },
    finish: string,
  ) => void
  stepFailed: (sessionID: string, message: string) => void
  setTotalTokens: (sessionID: string, tokens: number) => void
}

export function createTracker(charsPerToken: number, mutate: Mutate): TpsTracker {
  const counters = new Map<string, Counters>()

  function counter(sessionID: string): Counters {
    let entry = counters.get(sessionID)
    if (!entry) {
      entry = { chars: 0, stepStart: null }
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

  return {
    stepStarted(sessionID, createdMs, model) {
      const entry = counter(sessionID)
      entry.chars = 0
      entry.stepStart = createdMs
      patch(sessionID, { status: "working", model, liveTps: 0, liveTokens: 0, elapsedMs: 0 })
    },

    textStarted(sessionID) {
      patch(sessionID, { status: "working" })
    },

    delta(sessionID, text, createdMs) {
      const entry = counter(sessionID)
      if (entry.stepStart === null) entry.stepStart = createdMs
      entry.chars += text.length
      const elapsedMs = Math.max(1, createdMs - entry.stepStart)
      const liveTokens = entry.chars / charsPerToken
      patch(sessionID, {
        status: "streaming",
        liveTokens,
        liveTps: liveTokens / (elapsedMs / 1000),
        elapsedMs,
      })
    },

    textEnded(sessionID) {
      patch(sessionID, { status: "working" })
    },

    stepEnded(sessionID, createdMs, tokens, finish) {
      const entry = counter(sessionID)
      const elapsedMs = Math.max(1, createdMs - (entry.stepStart ?? createdMs))
      const output = tokens.output + (tokens.reasoning ?? 0)
      patch(sessionID, {
        status: "done",
        lastTps: output / (elapsedMs / 1000),
        lastTokens: output,
        lastDurationMs: elapsedMs,
        lastFinish: finish,
        liveTps: 0,
        liveTokens: 0,
        elapsedMs: 0,
      })
    },

    stepFailed(sessionID, message) {
      patch(sessionID, {
        status: "failed",
        error: message,
        liveTps: 0,
        liveTokens: 0,
        elapsedMs: 0,
      })
    },

    setTotalTokens(sessionID, tokens) {
      patch(sessionID, { totalTokens: tokens })
    },
  }
}
