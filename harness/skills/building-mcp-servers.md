---
name: building-mcp-servers
description: When and how to build a project MCP server — scaffold, handlers, self-test, register
tags: [meta, mcp, server, protocol, stdio, integration, build]
when: a needed external-system integration has no existing MCP server
phases: []
provenance: { origin: built-in }
---

# Building MCP Servers

## Build vs. script — decide first

- Capability is **reused across sessions/tasks** and benefits from being a
  native agent tool → build an MCP server.
- **One-off or shell-shaped** action → a tool script is cheaper
  (`building-tools.md`). Don't build a server to wrap one command.

## Process

1. **Scaffold** (a WORKING server — protocol plumbing done):

   ```
   infinity-harness capability create mcp <name>
   → harness/mcp/<name>/server.mjs + self-test.mjs
   ```

2. **Define tools.** Edit the `TOOLS` object in `server.mjs`. Per tool:
   - `description` written FOR the consuming model — say when to call it
     and what comes back
   - `inputSchema` — JSON Schema; mark required params
   - `handler(args)` — async, returns a string
   Keep it zero-dep if possible; if you need a client library, add it to
   the project and pin the version.

3. **Self-test until green:**

   ```
   node harness/mcp/<name>/self-test.mjs
   ```

   It runs initialize → tools/list → tools/call. Extend it with one call
   per real tool you added.

4. **Register** (adds it to the index AND every MCP client config):

   ```
   infinity-harness capability add mcp <name> --command node \
     --args harness/mcp/<name>/server.mjs \
     --tags db,postgres --description "Query the dev database" --trust curated
   ```

## Rules

- **stdout is the protocol.** Never `console.log` in a handler — one stray
  line corrupts the JSON-RPC stream. Log to stderr if you must.
- **Secrets via environment** (`process.env.X`), never hardcoded, never in
  client configs.
- **Handlers fail soft:** return an error message string, don't throw the
  server down.
- **Errors are content.** A tool that errors should return actionable text
  ("connection refused on :5432 — is the dev DB running?").

## Checklist

- [ ] Self-test green, one case per tool
- [ ] No stdout pollution (run self-test — parse errors reveal it)
- [ ] Secrets via env; version pins for any deps
- [ ] Registered with tags + description (matcher-visible)
- [ ] `infinity-harness capability doctor --type mcp` passes
