import { describe, expect, test } from "bun:test"
import { createTracker, type TpsStore } from "../src/tracker"

function makeHarness(charsPerToken = 4) {
  const state: TpsStore = { sessions: {} }
  const mutate = (fn: (draft: TpsStore) => void) => fn(state)
  const tracker = createTracker(charsPerToken, mutate)
  return { state, tracker }
}

describe("live TPS estimate", () => {
  test("estimates tps from text deltas", () => {
    const { state, tracker } = makeHarness()
    tracker.stepStarted("s1", 0, "some-model")
    tracker.delta("s1", "x".repeat(40), 1000)

    const snap = state.sessions["s1"]!
    expect(snap.status).toBe("streaming")
    expect(snap.liveTokens).toBeCloseTo(10, 5) // 40 chars / 4
    expect(snap.liveTps).toBeCloseTo(10, 5) // 10 tokens over 1s
    expect(snap.elapsedMs).toBe(1000)
    expect(snap.model).toBe("some-model")
  })

  test("accumulates across deltas", () => {
    const { state, tracker } = makeHarness()
    tracker.stepStarted("s1", 0)
    tracker.delta("s1", "x".repeat(20), 500)
    tracker.delta("s1", "y".repeat(20), 1000)

    const snap = state.sessions["s1"]!
    expect(snap.liveTokens).toBeCloseTo(10, 5) // 40 chars / 4
    expect(snap.liveTps).toBeCloseTo(10, 5) // 10 tokens over 1s
  })

  test("counts reasoning deltas too", () => {
    const { state, tracker } = makeHarness()
    tracker.stepStarted("s1", 0)
    tracker.delta("s1", "x".repeat(20), 500) // text
    tracker.delta("s1", "r".repeat(20), 1000) // reasoning

    const snap = state.sessions["s1"]!
    expect(snap.liveTokens).toBeCloseTo(10, 5)
    expect(snap.liveTps).toBeCloseTo(10, 5)
  })

  test("limits early burst estimates", () => {
    const { state, tracker } = makeHarness()
    tracker.stepStarted("s1", 0)
    tracker.delta("s1", "x".repeat(400), 50)

    const snap = state.sessions["s1"]!
    expect(snap.liveTokens).toBeCloseTo(100, 5) // 400 chars / 4
    expect(snap.liveTps).toBeCloseTo(100, 5) // minimum 1s denominator
  })

  test("guards against division by zero", () => {
    const { state, tracker } = makeHarness()
    tracker.stepStarted("s1", 1000)
    tracker.delta("s1", "abc", 1000) // same timestamp
    expect(Number.isFinite(state.sessions["s1"]!.liveTps)).toBe(true)
  })

  test("uses configured chars per token", () => {
    const { state, tracker } = makeHarness(3)
    tracker.stepStarted("s1", 0)
    tracker.delta("s1", "x".repeat(30), 1000)
    expect(state.sessions["s1"]!.liveTokens).toBeCloseTo(10, 5)
  })
})

describe("step settlement", () => {
  test("uses exact tokens and full duration for final tps", () => {
    const { state, tracker } = makeHarness()
    tracker.stepStarted("s1", 0)
    tracker.delta("s1", "abc", 1500)
    tracker.stepEnded("s1", 2000, { output: 200, reasoning: 50 }, "end_turn")

    const snap = state.sessions["s1"]!
    expect(snap.status).toBe("done")
    expect(snap.lastTokens).toBe(250)
    expect(snap.lastTps).toBeCloseTo(125, 5) // 250 tokens / 2s
    expect(snap.lastDurationMs).toBe(2000)
    expect(snap.lastFinish).toBe("end_turn")
  })

  test("pauses to working between text streams and on text end", () => {
    const { state, tracker } = makeHarness()
    tracker.stepStarted("s1", 0)
    tracker.textStarted("s1")
    expect(state.sessions["s1"]!.status).toBe("working")
    tracker.delta("s1", "hello", 1000)
    expect(state.sessions["s1"]!.status).toBe("streaming")
    tracker.textEnded("s1")
    expect(state.sessions["s1"]!.status).toBe("working")
  })

  test("marks failed steps", () => {
    const { state, tracker } = makeHarness()
    tracker.stepStarted("s1", 0)
    tracker.stepFailed("s1", "boom")
    const snap = state.sessions["s1"]!
    expect(snap.status).toBe("failed")
    expect(snap.error).toBe("boom")
    expect(snap.liveTps).toBe(0)
  })
})

describe("sessions", () => {
  test("keeps sessions isolated", () => {
    const { state, tracker } = makeHarness()
    tracker.stepStarted("a", 0)
    tracker.stepStarted("b", 0)
    tracker.delta("a", "x".repeat(40), 1000)

    expect(state.sessions["a"]!.status).toBe("streaming")
    expect(state.sessions["b"]!.status).toBe("working")
    expect(state.sessions["b"]!.liveTokens).toBe(0)
  })

  test("tracks totals per session", () => {
    const { state, tracker } = makeHarness()
    tracker.setTotalTokens("s1", 1234)
    tracker.setTotalTokens("s2", 56)
    expect(state.sessions["s1"]!.totalTokens).toBe(1234)
    expect(state.sessions["s2"]!.totalTokens).toBe(56)
    expect(state.sessions["s3"]).toBeUndefined()
  })
})
