/**
 * Live TPS tracker for the OpenCode 2.0 TUI plugin API (next).
 *
 * Aligns with upstream native throughput (sst/opencode PR #45265, merged):
 * - settled TPS uses visible **output tokens only** (reasoning excluded) over
 *   the provider response-body window (`time.streamed - time.created`),
 *   which excludes local tool-settlement time.
 * - `session.step.streamed` marks the response-body boundary; when the host
 *   does not emit it (older server), settlement falls back to `step.ended`.
 * - misleading samples are suppressed: non-`stop`/`length` finishes
 *   (tool-calls, errors), missing stream boundary on new servers is handled
 *   by fallback, and sub-250ms windows (buffered bursts, see issue #46883)
 *   report no rate instead of a 5-6 digit artifact.
 *
 * Open refinements tracked upstream (PR #42112 TPOT `output-1` + 250ms floor,
 * PR #47125 provider-wait `started` timestamp) use the same suppression
 * shape, so adopting them later only changes the duration source.
 *
 * Live estimate (our value-add over native, see issue #47914) is also
 * output-only: reasoning deltas do not advance it, and the clock starts at
 * the first visible delta (TTFT excluded) with a 1s minimum denominator.
 *
 * Reactive snapshots live in a solid-js store provided by the host
 * (`context.storage.memory`); only the non-reactive streaming counters
 * live here.
 */

export type TpsStatus = "idle" | "working" | "streaming" | "done" | "failed"

export type TpsSession = {
  /** Current phase of the most recent step. */
  status: TpsStatus
  /** Estimated tokens/sec while streaming (0 otherwise). */
  liveTps: number
  /** Estimated tokens produced this step so far. */
  liveTokens: number
  /** Milliseconds of active streaming time in this step. */
  elapsedMs: number
  /** Exact avg tokens/sec of the last completed step. 0 when suppressed. */
  lastTps: number
  /** Exact output tokens of the last completed step (reasoning excluded). */
  lastTokens: number
  /** Active streaming duration of the last completed step in ms. */
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

type Counters = {
  /** Accumulated visible-text chars of the in-flight step (reasoning excluded). */
  chars: number
  /** Timestamp (ms) of the current step start (request start when known). */
  stepStart: number | null
  /** Timestamp (ms) of the first visible delta; null until streaming. */
  firstDelta: number | null
  /** Provider response-body end (`session.step.streamed`); null until seen. */
  streamed: number | null
}

export type TpsTracker = {
  stepStarted: (sessionID: string, createdMs: number, model?: string, requestStartedMs?: number) => void
  textStarted: (sessionID: string) => void
  delta: (sessionID: string, text: string, createdMs: number) => void
  /** Reasoning deltas do not advance the live estimate (native is output-only).
   *  Kept as a no-op status signal so callers can forward the event safely. */
  reasoningDelta: (sessionID: string) => void
  textEnded: (sessionID: string) => void
  streamed: (sessionID: string, createdMs: number) => void
  stepEnded: (
    sessionID: string,
    createdMs: number,
    tokens: { output: number; reasoning?: number },
    finish: string,
  ) => void
  stepFailed: (sessionID: string, message: string) => void
  setTotalTokens: (sessionID: string, tokens: number) => void
}

/** Returns true for finishes with a trustworthy generation window.
 *  Mirrors native `tokenThroughput` (merged PR #45265) plus the open-PR
 *  refinement (PR #42112) that also suppresses tool-call turns. */
export function isReportableFinish(finish: string): boolean {
  return finish === "stop" || finish === "length"
}

export function createTracker(charsPerToken: number, mutate: Mutate): TpsTracker {
  const counters = new Map<string, Counters>()

  function counter(sessionID: string): Counters {
    let entry = counters.get(sessionID)
    if (!entry) {
      entry = { chars: 0, stepStart: null, firstDelta: null, streamed: null }
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
    stepStarted(sessionID, createdMs, model, requestStartedMs) {
      const entry = counter(sessionID)
      entry.chars = 0
      entry.stepStart = requestStartedMs ?? createdMs
      entry.firstDelta = null
      entry.streamed = null
      patch(sessionID, { status: "working", model, liveTps: 0, liveTokens: 0, elapsedMs: 0 })
    },

    textStarted(sessionID) {
      patch(sessionID, { status: "working" })
    },

    delta(sessionID, text, createdMs) {
      const entry = counter(sessionID)
      if (entry.stepStart === null) entry.stepStart = createdMs
      if (entry.firstDelta === null) entry.firstDelta = createdMs
      entry.chars += text.length
      const elapsedMs = Math.max(1, createdMs - entry.firstDelta)
      const liveTokens = entry.chars / charsPerToken
      const liveTps = liveTokens / (Math.max(MIN_LIVE_ELAPSED_MS, elapsedMs) / 1000)
      patch(sessionID, {
        status: "streaming",
        liveTokens,
        liveTps,
        elapsedMs,
      })
    },

    reasoningDelta() {
      // Intentionally ignored: native throughput is visible-output-only.
    },

    textEnded(sessionID) {
      patch(sessionID, { status: "working" })
    },

    streamed(sessionID, createdMs) {
      counter(sessionID).streamed = createdMs
    },

    stepEnded(sessionID, createdMs, tokens, finish) {
      const entry = counter(sessionID)
      const output = tokens.output
      const endMs = entry.streamed ?? createdMs
      const elapsedMs = Math.max(1, endMs - (entry.stepStart ?? endMs))
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
