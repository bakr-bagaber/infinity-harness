#!/usr/bin/env node
/**
 * infinity-harness — a scripted model server for driving *real* pi in tests.
 *
 * Every bug the user has hit in production so far — a BOM in a config file, a
 * loop that dies on the first handoff, a harness that forgets itself after
 * compaction — shares one property: no unit test could see it, because the
 * thing that broke was pi's runtime, not ours. The module tests mock the pi
 * API, so they prove our adapter calls the right methods; they cannot prove pi
 * does what we think when it calls back.
 *
 * This server closes that hole. It speaks OpenAI chat-completions, which pi
 * talks natively, so `scripts/live-e2e.mjs` can start a real `pi` process
 * against a real project with the real extension loaded, and drive it through
 * a scripted conversation — including turns whose reported token usage is
 * large enough to force pi's own auto-compaction.
 *
 * The script file is re-read on every request, so a test can change what the
 * model will say next while pi is still running.
 *
 * Script format (JSON):
 *   {
 *     "replies": [ Step, ... ],   // consumed in order
 *     "default": Step             // repeated once `replies` runs out
 *   }
 *
 *   Step = {
 *     "content":        string | null,
 *     "tool_calls":     OpenAI tool_calls array,
 *     "prompt_tokens":  number,   // what pi is told the context cost
 *     "finish_reason":  string,
 *     "match":          string    // only use this step if the request body matches
 *   }
 *
 * Usage: node scripts/rig/mock-model.mjs <script.json> <request-log.jsonl> [port]
 * Prints `PORT=<n>` on stdout once listening.
 */

import { createServer } from "node:http";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const [scriptPath, logPath, portArg] = process.argv.slice(2);

if (!scriptPath || !logPath) {
  console.error("usage: mock-model.mjs <script.json> <request-log.jsonl> [port]");
  process.exit(2);
}

let served = 0;
writeFileSync(logPath, "");

/** Pick the step for this request: first unconsumed step whose `match` fits. */
function pickStep(script, body) {
  const replies = Array.isArray(script.replies) ? script.replies : [];
  const text = JSON.stringify(body ?? {});
  for (let i = served; i < replies.length; i += 1) {
    const step = replies[i];
    if (!step.match || text.includes(step.match)) return { step, index: i };
  }
  return { step: script.default ?? { content: "ok" }, index: -1 };
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", () => {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* pi always sends JSON; a malformed body is a test bug, not a server one */
    }

    if (String(req.url).includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-1" }] }));
      return;
    }

    let script;
    try {
      script = JSON.parse(readFileSync(scriptPath, "utf8"));
    } catch {
      script = { default: { content: "ok" } };
    }

    const { step } = pickStep(script, parsed);
    appendFileSync(
      logPath,
      JSON.stringify({ n: served, url: req.url, body: parsed, replied: step }) + "\n",
    );
    served += 1;

    const message = { role: "assistant", content: step.content ?? null };
    if (step.tool_calls) message.tool_calls = step.tool_calls;

    const usage = {
      prompt_tokens: step.prompt_tokens ?? 200,
      completion_tokens: step.completion_tokens ?? 10,
      total_tokens: (step.prompt_tokens ?? 200) + (step.completion_tokens ?? 10),
    };
    const finish = step.tool_calls ? "tool_calls" : (step.finish_reason ?? "stop");
    const created = Math.floor(Date.now() / 1000);
    const id = "chatcmpl-" + served;
    const model = parsed?.model ?? "mock-1";

    if (parsed?.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = { id, object: "chat.completion.chunk", created, model };
      res.write(
        "data: " +
          JSON.stringify({ ...base, choices: [{ index: 0, delta: message, finish_reason: null }] }) +
          "\n\n",
      );
      res.write(
        "data: " +
          JSON.stringify({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: finish }],
            usage,
          }) +
          "\n\n",
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message, finish_reason: finish }],
        usage,
      }),
    );
  });
});

server.listen(Number(portArg) || 0, "127.0.0.1", () => {
  console.log("PORT=" + server.address().port);
});
