---
name: config-and-secrets
description: Configuration discipline — env-driven config, validation at boot, secret hygiene, environments
tags: [config, configuration, environment, env, secret, settings, deploy, dotenv, variable]
when: task adds configuration, environment handling, or deployment settings
phases: [build, ship]
kind: domain
provenance: { origin: built-in }
---

# Configuration & Secrets

## Rules

- **Config comes from the environment; code ships identical everywhere.**
  Anything that differs between dev/staging/prod (URLs, credentials,
  flags, limits) is env config — never an `if (env === "prod")` branch
  buried in logic.
- **One config module, validated at boot.** Read `process.env`/equivalent
  in exactly one place; parse, type-check, and apply defaults there; crash
  at startup with a message naming every missing/invalid variable. A
  missing variable discovered at 3am mid-request is a design failure.
- **Everything has a sane dev default EXCEPT secrets.** A fresh clone runs
  with `.env.example` copied to `.env`. Secrets have NO defaults —
  absence must fail loudly, never fall back to a shared "dev secret".
- **Secrets:** environment or secrets manager only. `.env` gitignored;
  `.env.example` committed with dummy values documenting every variable.
  Rotate on any suspicion of exposure; a secret that hit git history IS
  exposed (rewriting history doesn't un-leak it — rotate).
- **Name for grep:** consistent prefix (`APP_DB_URL`, `APP_REDIS_URL`).
  Booleans parse explicitly ("true"/"1"); everything else arrives as a
  string — convert deliberately.
- **Feature flags are config too:** defined in the config module, defaulted
  off, deleted after full rollout — a flag older than a quarter is debt.

## Anti-patterns

- **`process.env.X` scattered through the codebase** → impossible to know
  what the app needs; centralize.
- **Config objects passed 8 layers deep** → modules accept the 2 values
  they need (see `codebase-design.md`), not the world.
- **"Just for testing" hardcoded credentials** → tests read the same
  config module, pointed at test resources.
- **Committing the real .env "temporarily"** → it's in history forever;
  rotate everything it contained.

## Checklist

- [ ] Fresh clone + `.env.example` → app boots (or fails naming exactly what's missing)
- [ ] Single config module; grep finds no stray env reads
- [ ] No secret has a default; all documented in .env.example
- [ ] git history greps clean of credentials
- [ ] Env-specific behavior expressed as config values, not env-name branches
