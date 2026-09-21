import { describe, expect, test } from "bun:test"

// bunfig.toml loads the OpenTUI Solid transform used for local TSX plugins.
const mod = await import("../src/index.tsx")
const plugin = mod.default as { id: string; setup: (ctx: any) => unknown }

const { formatTps, formatTokens, formatDuration } = await import("../src/tps-panel")

describe("loader contract", () => {
  test("default export has id and setup", () => {
    expect(plugin.id).toBe("live-token-meter")
    expect(typeof plugin.setup).toBe("function")
  })
})

describe("formatting helpers", () => {
  test("formatTps", () => {
    expect(formatTps(41.8)).toBe("41.8")
    expect(formatTps(112.4)).toBe("112")
    expect(formatTps(0)).toBe("0")
    expect(formatTps(-5)).toBe("0")
    expect(formatTps(Number.NaN)).toBe("0")
  })

  test("formatTokens", () => {
    expect(formatTokens(842)).toBe("842")
    expect(formatTokens(1200)).toBe("1.2k")
    expect(formatTokens(12400)).toBe("12k")
    expect(formatTokens(0)).toBe("0")
  })

  test("formatDuration", () => {
    expect(formatDuration(23000)).toBe("23s")
    expect(formatDuration(31000)).toBe("31s")
    expect(formatDuration(95000)).toBe("1m 35s")
    expect(formatDuration(0)).toBe("0s")
  })
})
