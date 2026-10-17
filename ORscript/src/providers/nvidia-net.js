// SPDX-License-Identifier: GPL-3.0-or-later
// src/providers/nvidia-net.js — NVIDIA NIM playground response tap (MAIN world).
// Preserve Kimi K3's raw OpenAI-compatible stream before React transforms or
// virtualizes the rendered response. The isolated provider reads this state from
// #rs-nvidia-net and still falls back to the visible DOM when a payload changes.
(() => {
  "use strict";
  if (window.__rsNvidiaNet) return;
  window.__rsNvidiaNet = true;

  const NODE_ID = "rs-nvidia-net";
  let seq = 0;
  const node = () => {
    let el = document.getElementById(NODE_ID);
    if (!el) {
      el = document.createElement("script");
      el.id = NODE_ID;
      el.type = "application/json";
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  };
  const publish = (state) => {
    try {
      const page = window.location && window.location.pathname || "";
      node().textContent = JSON.stringify({ ...state, page, t: Date.now() });
    } catch {}
  };
  const textPart = (value) => {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    return value.map((part) => typeof part === "string"
      ? part
      : String((part && (part.text || part.content || part.value)) || "")).join("");
  };
  const appendFragment = (old, value, cumulative = false) => {
    value = textPart(value);
    old = old || "";
    if (!value) return old;
    if ((cumulative || value.length >= old.length) && value.startsWith(old)) return value;
    if (old === value || old.endsWith(value)) return old;
    return old + value;
  };
  const isChatUrl = (value) => /(?:\/v1)?\/(?:chat\/completions|responses)(?:[/?#]|$)/i.test(String(value || ""));

  function foldNativeCalls(calls, state) {
    if (!calls) return;
    if (!Array.isArray(calls)) calls = [calls];
    for (let index = 0; index < calls.length; index++) {
      const raw = calls[index] || {};
      const fn = raw.function && typeof raw.function === "object" ? raw.function : raw;
      const slotIndex = Number.isFinite(Number(raw.index)) ? Number(raw.index) : index;
      let slot = state.nativeCalls.find((call) => call.index === slotIndex);
      if (!slot) {
        slot = { index: slotIndex, name: "", arguments: "" };
        state.nativeCalls.push(slot);
      }
      slot.name = appendFragment(slot.name, fn.name || raw.name || raw.tool_name || raw.toolName);
      let args = fn.arguments != null ? fn.arguments
        : raw.arguments != null ? raw.arguments
        : raw.parameters != null ? raw.parameters
        : raw.input;
      if (args && typeof args === "object") args = JSON.stringify(args);
      slot.arguments = appendFragment(slot.arguments, args);
    }
  }

  function foldPayload(payload, state) {
    if (!payload || typeof payload !== "object") return;
    const type = String(payload.type || payload.event || "").toLowerCase();
    if (/error|failed/.test(type) || payload.error) {
      const error = payload.error || payload;
      state.error = String((error && (error.message || error.detail || error.error)) || error || "NVIDIA NIM request failed").slice(0, 500);
      state.done = true;
    }

    const choice = payload.choices && payload.choices[0];
    if (choice) {
      const cumulative = !choice.delta && !!choice.message;
      const part = choice.delta || choice.message || {};
      state.text = appendFragment(state.text, part.content, cumulative);
      state.thinking = appendFragment(state.thinking,
        part.reasoning_content || part.reasoning || part.thinking, cumulative);
      foldNativeCalls(part.tool_calls || part.toolCalls || part.function_call, state);
      if (choice.finish_reason != null) state.done = true;
    }

    // OpenAI Responses API compatibility.
    if (/response\.output_text\.delta|output_text\.delta|text_delta/.test(type)) {
      state.text = appendFragment(state.text, payload.delta || payload.text || payload.content);
    } else if (/reasoning/.test(type)) {
      state.thinking = appendFragment(state.thinking, payload.delta || payload.text || payload.content);
    }
    if (/function_call|tool_call/.test(type)) {
      foldNativeCalls(payload.tool_calls || payload.toolCalls || payload.item || payload.call || payload, state);
    }
    if (/response\.(?:completed|done)|^(?:done|finished)$/.test(type)
        || payload.done === true || payload.finished === true) state.done = true;

    for (const key of ["data", "result", "response"]) {
      const child = payload[key];
      if (child && typeof child === "object" && child !== payload) foldPayload(child, state);
    }
  }

  function foldLine(raw, state, eventState) {
    let line = String(raw == null ? "" : raw).trim();
    if (!line) { eventState.name = ""; return; }
    if (line.startsWith(":")) return;
    if (/^event\s*:/i.test(line)) {
      eventState.name = line.slice(line.indexOf(":") + 1).trim();
      return;
    }
    if (/^(?:id|retry)\s*:/i.test(line)) return;
    if (line.startsWith("data:")) line = line.slice(5).trim();
    if (!line) return;
    if (line === "[DONE]") { state.done = true; return; }
    try {
      const payload = JSON.parse(line);
      if (eventState.name && payload && typeof payload === "object" && payload.type == null) {
        foldPayload({ ...payload, type: eventState.name }, state);
      } else {
        foldPayload(payload, state);
      }
    } catch {}
  }

  async function consume(response, state) {
    try {
      if (!response) return;
      if (response.ok === false) {
        let detail = "";
        try { detail = String(await response.text()).replace(/\s+/g, " ").trim().slice(0, 360); } catch {}
        state.error = `NVIDIA NIM HTTP ${response.status || "error"}${detail ? `: ${detail}` : ""}`;
        state.done = true;
        publish(state);
        return;
      }
      const contentType = response.headers && response.headers.get && response.headers.get("content-type") || "";
      if (/application\/json/i.test(contentType)) {
        try { foldPayload(await response.json(), state); } catch {}
        state.done = true;
        publish(state);
        return;
      }
      if (!response.body) { state.done = true; publish(state); return; }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const eventState = { name: "" };
      let buffer = "";
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          foldLine(buffer.slice(0, newline), state, eventState);
          buffer = buffer.slice(newline + 1);
        }
        publish(state);
      }
      if (buffer) foldLine(buffer, state, eventState);
    } catch (error) {
      state.error = String(error && error.message || error).slice(0, 500);
    }
    state.done = true;
    publish(state);
  }

  const freshState = () => ({
    rid: `nim-${Date.now()}-${++seq}`,
    text: "",
    thinking: "",
    nativeCalls: [],
    done: false,
    error: "",
  });

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (...args) {
      const url = (args[0] && args[0].url) || args[0];
      const promise = originalFetch.apply(this, args);
      if (isChatUrl(url)) {
        const state = freshState();
        publish(state);
        promise.then((response) => {
          try { consume(response.clone(), state); }
          catch (error) { state.error = String(error && error.message || error).slice(0, 500); state.done = true; publish(state); }
        }, (error) => {
          state.error = String(error && error.message || error).slice(0, 500);
          state.done = true;
          publish(state);
        });
      }
      return promise;
    };
  }

  // Kaizen deployments have alternated between fetch and XMLHttpRequest.
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url, ...rest) {
      this.__rsNim = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
      return open.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (body) {
      const info = this.__rsNim || {};
      if (info.method === "POST" && isChatUrl(info.url)) {
        const state = freshState();
        const eventState = { name: "" };
        let offset = 0, buffer = "";
        publish(state);
        const drain = () => {
          let text = "";
          try { text = typeof this.responseText === "string" ? this.responseText : ""; } catch {}
          if (text.length <= offset) return;
          buffer += text.slice(offset);
          offset = text.length;
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            foldLine(buffer.slice(0, newline), state, eventState);
            buffer = buffer.slice(newline + 1);
          }
          publish(state);
        };
        this.addEventListener("progress", drain);
        this.addEventListener("load", () => {
          drain();
          if (buffer) foldLine(buffer, state, eventState);
          try {
            if (!state.text && !state.nativeCalls.length && typeof this.response === "object") foldPayload(this.response, state);
          } catch {}
          if (this.status >= 400) state.error = `NVIDIA NIM HTTP ${this.status}`;
          state.done = true;
          publish(state);
        });
        const fail = () => { state.error = "NVIDIA NIM request failed"; state.done = true; publish(state); };
        this.addEventListener("error", fail);
        this.addEventListener("abort", fail);
      }
      return send.call(this, body);
    };
  }
})();
