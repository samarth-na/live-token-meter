import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import plugin from "../src/index"
import type { TpsStore } from "../src/tracker"

type Handler = (event: any) => void

function mockContext() {
  const handlers = new Map<string, Handler[]>()
  const [store, mutate] = createStore<TpsStore>({ sessions: {} })
  const messages: Record<string, any[]> = {}
  const captured: {
    slots: Array<{ name: string; render: (props: any) => unknown }>
    disposers: Array<() => void>
  } = { slots: [], disposers: [] }

  const context: any = {
    options: {},
    theme: {},
    data: {
      on: (type: string, handler: Handler) => {
        const list = handlers.get(type) ?? []
        list.push(handler)
        handlers.set(type, list)
        return () => {
          const next = (handlers.get(type) ?? []).filter((h) => h !== handler)
          if (next.length) handlers.set(type, next)
          else handlers.delete(type)
        }
      },
      session: {
        message: {
          list: (sessionID: string) => messages[sessionID] ?? [],
        },
      },
    },
    ui: {
      slot: (claim: unknown) => {
        captured.slots.push(claim as { name: string; render: (props: any) => unknown })
        const disposer = () => {
          captured.slots = []
        }
        captured.disposers.push(disposer)
        return disposer
      },
    },
    storage: {
      memory: () => [store, mutate],
    },
  }

  return {
    context,
    handlers,
    store,
    messages,
    captured,
    emit: (type: string, event: Record<string, unknown>) => {
      for (const handler of handlers.get(type) ?? []) handler(event)
    },
  }
}

describe("live-token-meter plugin", () => {
  test("registers the prompt.footer.status slot and returns cleanup", async () => {
    const { context, captured } = mockContext()
    const cleanup = plugin.setup(context) as () => void

    expect(plugin.id).toBe("live-token-meter")
    expect(captured.slots).toHaveLength(1)
    const claim = captured.slots[0] as any
    expect(claim.append).toBe("prompt.footer.status")
    expect(typeof claim.render).toBe("function")
    expect(typeof cleanup).toBe("function")
  })

  test("does nothing when disabled", () => {
    const { context, captured, handlers } = mockContext()
    context.options = { enabled: false }
    const cleanup = plugin.setup(context) as () => void

    expect(cleanup).toBeUndefined()
    expect(captured.slots.length).toBe(0)
    expect(handlers.size).toBe(0)
  })

  test("computes live tps from streamed events", () => {
    const { context, emit, store } = mockContext()
    plugin.setup(context)

    emit("session.step.started", {
      created: 0,
      data: { sessionID: "s1", model: { id: "m" } },
    })
    emit("session.text.started", { created: 10, data: { sessionID: "s1" } })
    emit("session.text.delta", { created: 1000, data: { sessionID: "s1", delta: "x".repeat(40) } })
    // reasoning excluded from live TPS (native parity)
    emit("session.reasoning.delta", { created: 2000, data: { sessionID: "s1", delta: "y".repeat(40) } })

    const live = store.sessions["s1"]!
    expect(live.status).toBe("streaming")
    expect(live.liveTokens).toBeCloseTo(10, 5) // 40 chars / 4
    expect(live.liveTps).toBeCloseTo(10, 5) // 10 tokens over max(1s, 1s visible)
    expect(live.model).toBe("m")
  })

  test("settles with output-only tokens and updates totals from state", () => {
    const { context, emit, store, messages } = mockContext()
    plugin.setup(context)

    messages["s1"] = [
      { type: "assistant", tokens: { output: 1000, reasoning: 200 } },
      { type: "user" },
      { type: "assistant", tokens: { output: 500 } },
    ]

    emit("session.step.started", { created: 0, data: { sessionID: "s1", model: { id: "m" } } })
    emit("session.text.delta", { created: 1000, data: { sessionID: "s1", delta: "abc" } })
    emit("session.step.ended", {
      created: 2000,
      data: {
        sessionID: "s1",
        finish: "stop",
        tokens: { output: 300, reasoning: 100, input: 0, cache: { read: 0, write: 0 } },
      },
    })

    const settled = store.sessions["s1"]!
    expect(settled.status).toBe("done")
    // reasoning excluded to match native turnTokensPerSecond
    expect(settled.lastTokens).toBe(300)
    expect(settled.lastTps).toBeCloseTo(150, 5) // 300 tokens / 2s
    expect(settled.lastFinish).toBe("stop")
    expect(settled.lastSuppressed).toBe(false)
    expect(settled.totalTokens).toBe(1500) // 1000 + 500 output from state
  })

  test("marks failed steps and unsubscribes on cleanup", () => {
    const { context, emit, store, captured } = mockContext()
    const cleanup = plugin.setup(context) as () => void

    emit("session.step.started", {
      created: 0,
      data: { sessionID: "s1", model: { id: "m" } },
    })
    emit("session.step.failed", {
      created: 100,
      data: { sessionID: "s1", error: { type: "unknown", message: "provider exploded" } },
    })
    expect(store.sessions["s1"]!.status).toBe("failed")
    expect(store.sessions["s1"]!.error).toBe("provider exploded")

    cleanup!()
    emit("session.text.delta", { created: 200, data: { sessionID: "s1", delta: "zzz" } })
    expect(store.sessions["s1"]!.status).toBe("failed") // unchanged, handler removed
    expect(captured.slots.length).toBe(0) // slot unregistered
  })
})
