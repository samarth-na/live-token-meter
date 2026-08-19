// @bun
// src/index.tsx
import { createComponent as _$createComponent2 } from "@opentui/solid";
import { Plugin } from "@opencode-ai/plugin/tui";

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
function createTracker(charsPerToken, mutate) {
  const counters = new Map;
  function counter(sessionID) {
    let entry = counters.get(sessionID);
    if (!entry) {
      entry = { chars: 0, stepStart: null };
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
  return {
    stepStarted(sessionID, createdMs, model) {
      const entry = counter(sessionID);
      entry.chars = 0;
      entry.stepStart = createdMs;
      patch(sessionID, { status: "working", model, liveTps: 0, liveTokens: 0, elapsedMs: 0 });
    },
    textStarted(sessionID) {
      patch(sessionID, { status: "working" });
    },
    delta(sessionID, text, createdMs) {
      const entry = counter(sessionID);
      if (entry.stepStart === null)
        entry.stepStart = createdMs;
      entry.chars += text.length;
      const elapsedMs = Math.max(1, createdMs - entry.stepStart);
      const liveTokens = entry.chars / charsPerToken;
      const liveTps = liveTokens / (Math.max(MIN_LIVE_ELAPSED_MS, elapsedMs) / 1000);
      patch(sessionID, {
        status: "streaming",
        liveTokens,
        liveTps,
        elapsedMs
      });
    },
    textEnded(sessionID) {
      patch(sessionID, { status: "working" });
    },
    stepEnded(sessionID, createdMs, tokens, finish) {
      const entry = counter(sessionID);
      const elapsedMs = Math.max(1, createdMs - (entry.stepStart ?? createdMs));
      const output = tokens.output + (tokens.reasoning ?? 0);
      patch(sessionID, {
        status: "done",
        lastTps: output / (elapsedMs / 1000),
        lastTokens: output,
        lastDurationMs: elapsedMs,
        lastFinish: finish,
        liveTps: 0,
        liveTokens: 0,
        elapsedMs: 0
      });
    },
    stepFailed(sessionID, message) {
      patch(sessionID, {
        status: "failed",
        error: message,
        liveTps: 0,
        liveTokens: 0,
        elapsedMs: 0
      });
    },
    setTotalTokens(sessionID, tokens) {
      patch(sessionID, { totalTokens: tokens });
    }
  };
}

// src/tps-panel.tsx
import { effect as _$effect } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
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
function TpsFooter(props) {
  const session = () => props.sessionID ? props.store.sessions[props.sessionID] : undefined;
  const text = props.theme.text;
  const feedback = text.feedback;
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
          var _el$2 = _$createElement("span"), _el$3 = _$createTextNode(` tok/s`);
          _$insertNode(_el$2, _el$3);
          _$insert(_el$2, (() => {
            var _c$ = _$memo(() => item().status === "streaming");
            return () => _c$() ? formatTps(item().liveTps) : "\u2014";
          })(), _el$3);
          _$effect((_$p) => _$setProp(_el$2, "style", {
            fg: text.action.primary.default
          }, _$p));
          return _el$2;
        }
      }), _$createComponent(Show, {
        get when() {
          return item().status === "done";
        },
        get children() {
          return [(() => {
            var _el$4 = _$createElement("span");
            _$insertNode(_el$4, _$createTextNode(`\u2713`));
            _$effect((_$p) => _$setProp(_el$4, "style", {
              fg: feedback.success.default
            }, _$p));
            return _el$4;
          })(), (() => {
            var _el$6 = _$createElement("span"), _el$7 = _$createTextNode(` `), _el$8 = _$createTextNode(` tok/s \xB7 `), _el$9 = _$createTextNode(` tok`);
            _$insertNode(_el$6, _el$7);
            _$insertNode(_el$6, _el$8);
            _$insertNode(_el$6, _el$9);
            _$insert(_el$6, () => formatTps(item().lastTps), _el$8);
            _$insert(_el$6, () => formatTokens(item().lastTokens), _el$9);
            _$effect((_$p) => _$setProp(_el$6, "style", {
              fg: text.default
            }, _$p));
            return _el$6;
          })()];
        }
      }), _$createComponent(Show, {
        get when() {
          return item().status === "failed";
        },
        get children() {
          var _el$0 = _$createElement("span");
          _$insertNode(_el$0, _$createTextNode(`\u2717 step failed`));
          _$effect((_$p) => _$setProp(_el$0, "style", {
            fg: feedback.error.default
          }, _$p));
          return _el$0;
        }
      }), _$createComponent(Show, {
        get when() {
          return _$memo(() => !!props.showTotals)() && item().totalTokens > 0;
        },
        get children() {
          var _el$10 = _$createElement("span"), _el$11 = _$createTextNode(` \xB7 total `), _el$12 = _$createTextNode(` tok`);
          _$insertNode(_el$10, _el$11);
          _$insertNode(_el$10, _el$12);
          _$insert(_el$10, () => formatTokens(item().totalTokens), _el$12);
          _$effect((_$p) => _$setProp(_el$10, "style", {
            fg: text.subdued
          }, _$p));
          return _el$10;
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
    const unsubs = [context.data.on("session.step.started", (event) => tracker.stepStarted(event.data.sessionID, event.created, event.data.model.id)), context.data.on("session.text.started", (event) => tracker.textStarted(event.data.sessionID)), context.data.on("session.text.delta", (event) => tracker.delta(event.data.sessionID, event.data.delta, event.created)), context.data.on("session.reasoning.delta", (event) => tracker.delta(event.data.sessionID, event.data.delta, event.created)), context.data.on("session.text.ended", (event) => tracker.textEnded(event.data.sessionID)), context.data.on("session.step.ended", (event) => {
      tracker.stepEnded(event.data.sessionID, event.created, event.data.tokens, event.data.finish);
      if (options.showTotals) {
        tracker.setTotalTokens(event.data.sessionID, sumSessionTokens(context, event.data.sessionID));
      }
    }), context.data.on("session.step.failed", (event) => tracker.stepFailed(event.data.sessionID, event.data.error?.message ?? "step failed")), context.ui.slot({
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
    total += message.tokens?.reasoning ?? 0;
  }
  return total;
}
export {
  src_default as default
};
