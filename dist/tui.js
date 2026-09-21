// @bun
// src/index.tsx
import { createComponent as _$createComponent2 } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";

// src/tracker.ts
function emptySession() {
  return {
    status: "idle",
    liveTps: 0,
    liveTokens: 0,
    elapsedMs: 0,
    lastTps: 0,
    lastTokens: 0,
    lastDurationMs: 0,
    totalTokens: 0
  };
}
var MIN_LIVE_ELAPSED_MS = 1000;
var MIN_SETTLED_ELAPSED_MS = 250;
function isReportableFinish(finish) {
  return finish === "stop" || finish === "length";
}
function createTracker(charsPerToken, mutate) {
  const counters = new Map;
  function counter(sessionID) {
    let entry = counters.get(sessionID);
    if (!entry) {
      entry = {
        samples: {},
        stepStart: null,
        streamed: null,
        text: false,
        reasoning: false,
        responded: false,
        toolInputs: new Set,
        tools: new Set
      };
      counters.set(sessionID, entry);
    }
    return entry;
  }
  function patch(sessionID, patch2) {
    mutate((draft) => {
      draft.sessions[sessionID] = {
        ...draft.sessions[sessionID] ?? emptySession(),
        ...patch2
      };
    });
  }
  function progress(sessionID) {
    const entry = counter(sessionID);
    if (entry.active === "text" && !entry.text || entry.active === "reasoning" && !entry.reasoning || entry.active === "tool-input" && !entry.toolInputs.size)
      entry.active = undefined;
    if (entry.text || entry.reasoning || entry.toolInputs.size || entry.tools.size)
      entry.responded = true;
    const phase = entry.active ?? (entry.reasoning ? "reasoning" : entry.toolInputs.size ? "tool-input" : entry.tools.size ? "tools" : entry.text ? "text" : entry.responded || entry.streamed !== null ? "settling" : "waiting");
    patch(sessionID, {
      phase,
      status: entry.active ? "streaming" : "working",
      ...!entry.active ? { liveTps: 0, liveTokens: 0, elapsedMs: 0 } : {}
    });
  }
  function delta(sessionID, kind, text, createdMs) {
    if (!text.length)
      return;
    const entry = counter(sessionID);
    if (entry.stepStart === null)
      entry.stepStart = createdMs;
    const sample = entry.samples[kind] ??= { chars: 0, firstDelta: createdMs };
    sample.chars += text.length;
    entry.active = kind;
    entry.responded = true;
    const elapsedMs = Math.max(1, createdMs - sample.firstDelta);
    const liveTokens = sample.chars / charsPerToken;
    patch(sessionID, {
      status: "streaming",
      phase: kind,
      liveTokens,
      liveTps: liveTokens / (Math.max(MIN_LIVE_ELAPSED_MS, elapsedMs) / 1000),
      elapsedMs
    });
  }
  return {
    waiting(sessionID) {
      counters.delete(sessionID);
      patch(sessionID, { status: "working", phase: "waiting", error: undefined, liveTps: 0, liveTokens: 0, elapsedMs: 0 });
    },
    stepStarted(sessionID, createdMs, model, requestStartedMs) {
      const entry = counter(sessionID);
      entry.samples = {};
      entry.active = undefined;
      entry.stepStart = requestStartedMs ?? createdMs;
      entry.streamed = null;
      entry.text = false;
      entry.reasoning = false;
      entry.responded = false;
      entry.toolInputs.clear();
      entry.tools.clear();
      patch(sessionID, {
        status: "working",
        phase: "waiting",
        error: undefined,
        model,
        liveTps: 0,
        liveTokens: 0,
        elapsedMs: 0
      });
    },
    textStarted(sessionID) {
      const entry = counter(sessionID);
      entry.text = true;
      if (entry.active === "text")
        entry.active = undefined;
      progress(sessionID);
    },
    delta(sessionID, text, createdMs) {
      if (!text.length)
        return;
      counter(sessionID).text = true;
      delta(sessionID, "text", text, createdMs);
    },
    reasoningStarted(sessionID) {
      counter(sessionID).reasoning = true;
      progress(sessionID);
    },
    reasoningDelta(sessionID, text, createdMs) {
      if (!text.length)
        return;
      counter(sessionID).reasoning = true;
      delta(sessionID, "reasoning", text, createdMs);
    },
    reasoningEnded(sessionID) {
      counter(sessionID).reasoning = false;
      progress(sessionID);
    },
    textEnded(sessionID) {
      const entry = counter(sessionID);
      entry.text = false;
      progress(sessionID);
    },
    toolInputStarted(sessionID, id) {
      counter(sessionID).toolInputs.add(id);
      progress(sessionID);
    },
    toolInputDelta(sessionID, id, text, createdMs) {
      if (!text.length)
        return;
      counter(sessionID).toolInputs.add(id);
      delta(sessionID, "tool-input", text, createdMs);
    },
    toolInputEnded(sessionID, id) {
      counter(sessionID).toolInputs.delete(id);
      progress(sessionID);
    },
    toolCalled(sessionID, id) {
      const entry = counter(sessionID);
      entry.toolInputs.delete(id);
      entry.tools.add(id);
      progress(sessionID);
    },
    toolEnded(sessionID, id) {
      const entry = counters.get(sessionID);
      if (!entry)
        return;
      const input = entry.toolInputs.delete(id);
      const running = entry.tools.delete(id);
      if (!input && !running)
        return;
      progress(sessionID);
    },
    streamed(sessionID, createdMs) {
      const entry = counter(sessionID);
      entry.streamed = createdMs;
      entry.text = false;
      entry.reasoning = false;
      entry.toolInputs.clear();
      progress(sessionID);
    },
    stepEnded(sessionID, createdMs, tokens, finish) {
      const entry = counter(sessionID);
      const output = tokens.output;
      const endMs = entry.streamed ?? createdMs;
      const elapsedMs = Math.max(1, endMs - (entry.stepStart ?? endMs));
      counters.delete(sessionID);
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
          elapsedMs: 0
        });
        return;
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
        elapsedMs: 0
      });
    },
    stepFailed(sessionID, message) {
      counters.delete(sessionID);
      patch(sessionID, {
        status: "failed",
        error: message,
        liveTps: 0,
        liveTokens: 0,
        elapsedMs: 0
      });
    },
    interrupted(sessionID) {
      counters.delete(sessionID);
      patch(sessionID, { status: "interrupted", liveTps: 0, liveTokens: 0, elapsedMs: 0 });
    },
    setTotalTokens(sessionID, tokens) {
      patch(sessionID, { totalTokens: tokens });
    }
  };
}

// src/tps-panel.tsx
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Show } from "solid-js";
function formatTps(value) {
  if (!Number.isFinite(value) || value <= 0)
    return "0";
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}
function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0)
    return "0";
  if (value < 1000)
    return String(Math.round(value));
  if (value < 1e4)
    return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}
function formatActivity(item) {
  if (item.status === "streaming") {
    const label = item.phase === "reasoning" ? " \xB7 thinking" : item.phase === "tool-input" ? " \xB7 tool call" : "";
    return `~${formatTps(item.liveTps)} tok/s${label}`;
  }
  switch (item.phase) {
    case "reasoning":
      return "Thinking\u2026";
    case "text":
      return "Receiving text\u2026";
    case "tool-input":
      return "Generating tool call\u2026";
    case "tools":
      return "Running tools\u2026";
    case "settling":
      return "Finishing step\u2026";
    default:
      return "Waiting for response\u2026";
  }
}
function TpsFooter(props) {
  const session = () => props.sessionID ? props.store.sessions[props.sessionID] : undefined;
  const text = () => props.theme.text;
  return (() => {
    var _el$ = _$createElement("text");
    _$setProp(_el$, "wrapMode", "none");
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return session();
      },
      children: (item) => [_$createComponent(Show, {
        get when() {
          return item().status === "streaming" || item().status === "working";
        },
        get children() {
          var _el$2 = _$createElement("span");
          _$insert(_el$2, () => formatActivity(item()));
          _$effect((_$p) => _$setProp(_el$2, "style", {
            fg: text().action.primary.base
          }, _$p));
          return _el$2;
        }
      }), _$createComponent(Show, {
        get when() {
          return item().status === "done";
        },
        get children() {
          return [(() => {
            var _el$3 = _$createElement("span");
            _$insertNode(_el$3, _$createTextNode(`\u2713`));
            _$effect((_$p) => _$setProp(_el$3, "style", {
              fg: text().feedback.success.base
            }, _$p));
            return _el$3;
          })(), (() => {
            var _el$5 = _$createElement("span"), _el$6 = _$createTextNode(` `);
            _$insertNode(_el$5, _el$6);
            _$insert(_el$5, _$createComponent(Show, {
              get when() {
                return _$memo(() => !!!item().lastSuppressed)() && item().lastTps > 0;
              },
              get fallback() {
                return `${formatTokens(item().lastTokens)} tok`;
              },
              get children() {
                return [_$memo(() => formatTps(item().lastTps)), " tok/s \xB7 ", _$memo(() => formatTokens(item().lastTokens)), " tok"];
              }
            }), null);
            _$effect((_$p) => _$setProp(_el$5, "style", {
              fg: text().base
            }, _$p));
            return _el$5;
          })()];
        }
      }), _$createComponent(Show, {
        get when() {
          return item().status === "failed";
        },
        get children() {
          var _el$7 = _$createElement("span");
          _$insertNode(_el$7, _$createTextNode(`\u2717 step failed`));
          _$effect((_$p) => _$setProp(_el$7, "style", {
            fg: text().feedback.error.base
          }, _$p));
          return _el$7;
        }
      }), _$createComponent(Show, {
        get when() {
          return item().status === "interrupted";
        },
        get children() {
          var _el$9 = _$createElement("span");
          _$insertNode(_el$9, _$createTextNode(`Interrupted`));
          _$effect((_$p) => _$setProp(_el$9, "style", {
            fg: text().muted
          }, _$p));
          return _el$9;
        }
      }), _$createComponent(Show, {
        get when() {
          return _$memo(() => !!props.showTotals)() && item().totalTokens > 0;
        },
        get children() {
          var _el$1 = _$createElement("span"), _el$10 = _$createTextNode(` \xB7 total `), _el$11 = _$createTextNode(` tok`);
          _$insertNode(_el$1, _el$10);
          _$insertNode(_el$1, _el$11);
          _$insert(_el$1, () => formatTokens(item().totalTokens), _el$11);
          _$effect((_$p) => _$setProp(_el$1, "style", {
            fg: text().muted
          }, _$p));
          return _el$1;
        }
      })]
    }));
    return _el$;
  })();
}

// src/index.tsx
var src_default = Plugin.define({
  id: "live-token-meter",
  setup: (context) => {
    const options = {
      enabled: true,
      charsPerToken: 4,
      showTotals: true,
      ...context.options
    };
    if (!options.enabled)
      return;
    const [store, mutate] = context.storage.memory("live-token-meter", {
      initial: {
        sessions: {}
      }
    });
    const tracker = createTracker(options.charsPerToken, mutate);
    const unsubs = [context.data.on("session.execution.started", (event) => tracker.waiting(event.data.sessionID)), context.data.on("session.retry.scheduled", (event) => tracker.waiting(event.data.sessionID)), context.data.on("session.step.started", (event) => tracker.stepStarted(event.data.sessionID, event.created, event.data.model.id, event.data.started)), context.data.on("session.text.started", (event) => tracker.textStarted(event.data.sessionID)), context.data.on("session.text.delta", (event) => tracker.delta(event.data.sessionID, event.data.delta, event.created)), context.data.on("session.reasoning.started", (event) => tracker.reasoningStarted(event.data.sessionID)), context.data.on("session.reasoning.delta", (event) => tracker.reasoningDelta(event.data.sessionID, event.data.delta, event.created)), context.data.on("session.reasoning.ended", (event) => tracker.reasoningEnded(event.data.sessionID)), context.data.on("session.text.ended", (event) => tracker.textEnded(event.data.sessionID)), context.data.on("session.tool.input.started", (event) => tracker.toolInputStarted(event.data.sessionID, event.data.id)), context.data.on("session.tool.input.delta", (event) => tracker.toolInputDelta(event.data.sessionID, event.data.id, event.data.delta, event.created)), context.data.on("session.tool.input.ended", (event) => tracker.toolInputEnded(event.data.sessionID, event.data.id)), context.data.on("session.tool.called", (event) => tracker.toolCalled(event.data.sessionID, event.data.id)), context.data.on("session.tool.success", (event) => tracker.toolEnded(event.data.sessionID, event.data.id)), context.data.on("session.tool.failed", (event) => tracker.toolEnded(event.data.sessionID, event.data.id)), context.data.on("session.step.streamed", (event) => tracker.streamed(event.data.sessionID, event.created)), context.data.on("session.step.ended", (event) => {
      tracker.stepEnded(event.data.sessionID, event.created, event.data.tokens, event.data.finish);
      if (options.showTotals) {
        tracker.setTotalTokens(event.data.sessionID, sumSessionTokens(context, event.data.sessionID));
      }
    }), context.data.on("session.step.failed", (event) => tracker.stepFailed(event.data.sessionID, event.data.error?.message ?? "step failed")), context.data.on("session.execution.interrupted", (event) => tracker.interrupted(event.data.sessionID)), context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => _$createComponent2(TpsFooter, {
        get sessionID() {
          return props.sessionID;
        },
        store,
        get theme() {
          return context.theme;
        },
        get showTotals() {
          return options.showTotals;
        }
      })
    })];
    return () => {
      for (const unsub of unsubs)
        unsub();
    };
  }
});
function sumSessionTokens(context, sessionID) {
  let total = 0;
  for (const message of context.data.session.message.list(sessionID)) {
    if (message.type !== "assistant")
      continue;
    total += message.tokens?.output ?? 0;
  }
  return total;
}
export {
  src_default as default
};
