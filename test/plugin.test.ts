import { describe, expect, test } from "bun:test"
import { createStore, produce } from "solid-js/store"
import { RGBA } from "@opentui/core"
import { testRender, type JSX } from "@opentui/solid"
import plugin from "../src/index"
import type { TpsStore } from "../src/tracker"

const bundled = (await import(new URL("../dist/tui.js", import.meta.url).href)).default as typeof plugin

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
      memory: () => [store, (fn: (draft: TpsStore) => void) => mutate(produce(fn))],
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
    // Reasoning has its own character count and clock.
    emit("session.reasoning.delta", { created: 2000, data: { sessionID: "s1", delta: "y".repeat(40) } })

    const live = store.sessions["s1"]!
    expect(live.status).toBe("streaming")
    expect(live.phase).toBe("reasoning")
    expect(live.liveTokens).toBeCloseTo(10, 5) // 40 reasoning chars / 4
    expect(live.liveTps).toBeCloseTo(10, 5) // first reasoning sample, 1s floor
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

  const implementations = [["source", plugin], ["bundle", bundled]] as const
  test.each(implementations)("%s renders live generation rates", async (_name, implementation) => {
    const { context, emit, captured, messages } = mockContext()
    const color = RGBA.fromHex("#ffffff")
    context.theme = {
      text: {
        base: color, muted: color,
        action: { primary: { base: color } },
        feedback: { success: { base: color }, error: { base: color } },
      },
    }
    const cleanup = implementation.setup(context) as () => void
    const view = await testRender(() => captured.slots[0]!.render({ sessionID: "s1" }) as JSX.Element, {
      width: 100, height: 2,
    })
    const frame = async () => {
      await view.renderOnce()
      return view.captureCharFrame().trim()
    }
    const event = (type: string, created: number, data: Record<string, unknown> = {}) =>
      emit(type, { created, data: { sessionID: "s1", ...data } })

    try {
      expect(await frame()).toBe("")
      event("session.execution.started", 0)
      expect(await frame()).toBe("Waiting for response…")
      event("session.step.started", 100, { model: { id: "m" }, started: 0 })
      // Some providers open a text part before reasoning produces any output.
      event("session.text.started", 110)
      event("session.reasoning.started", 120)
      expect(await frame()).toBe("Thinking…")
      event("session.reasoning.delta", 150, { delta: "x".repeat(80) })
      expect(await frame()).toBe("~20.0 tok/s · thinking")
      event("session.reasoning.delta", 1150, { delta: "x".repeat(40) })
      expect(await frame()).toBe("~30.0 tok/s · thinking")
      event("session.reasoning.ended", 1200)
      expect(await frame()).toBe("Receiving text…")
      event("session.text.delta", 5000, { delta: "x".repeat(40) })
      expect(await frame()).toBe("~10.0 tok/s")
      event("session.text.delta", 6000, { delta: "x".repeat(80) })
      expect(await frame()).toBe("~30.0 tok/s")
      event("session.tool.input.started", 6100, { id: "t1" })
      event("session.text.ended", 6200)
      expect(await frame()).toBe("Generating tool call…")
      event("session.tool.input.delta", 6250, { id: "t1", delta: "x".repeat(40) })
      expect(await frame()).toBe("~10.0 tok/s · tool call")
      event("session.tool.input.delta", 6270, { id: "t1", delta: "x".repeat(80) })
      expect(await frame()).toBe("~30.0 tok/s · tool call")
      event("session.tool.input.ended", 6300, { id: "t1" })
      event("session.tool.called", 6300, { id: "t1" })
      event("session.step.streamed", 7000)
      expect(await frame()).toBe("Running tools…")
      event("session.tool.success", 10000, { id: "t1" })
      expect(await frame()).toBe("Finishing step…")
      event("session.step.ended", 10000, { finish: "tool-calls", tokens: { output: 50 } })
      expect(await frame()).toBe("✓ 50 tok")

      event("session.step.started", 11000, { model: { id: "m" }, started: 10000 })
      expect(await frame()).toBe("Waiting for response…")
      event("session.text.delta", 12000, { delta: "x".repeat(40) })
      event("session.step.streamed", 20000)
      messages.s1 = [{ type: "assistant", tokens: { output: 6700 } }]
      event("session.step.ended", 20000, { finish: "stop", tokens: { output: 560, reasoning: 100 } })
      expect(await frame()).toBe("✓ 56.0 tok/s · 560 tok · total 6.7k tok")

      event("session.execution.started", 21000)
      event("session.execution.interrupted", 22000)
      expect(await frame()).toBe("Interrupted · total 6.7k tok")

      event("session.step.started", 23000, { model: { id: "m" }, started: 23000 })
      event("session.tool.input.started", 23100, { id: "t2" })
      event("session.tool.input.delta", 23200, { id: "t2", delta: "x".repeat(80) })
      expect(await frame()).toBe("~20.0 tok/s · tool call · total 6.7k tok")
      event("session.tool.failed", 23300, { id: "t2" })
      expect(await frame()).toBe("Finishing step… · total 6.7k tok")
      event("session.step.failed", 23400, { error: { message: "provider failed" } })
      expect(await frame()).toBe("✗ step failed · total 6.7k tok")
    } finally {
      view.renderer.destroy()
      cleanup()
    }
  })
})
