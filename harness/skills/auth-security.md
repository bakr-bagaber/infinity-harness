---
name: auth-security
description: Authentication, authorization, secrets, and the injection/XSS/CSRF baseline
tags: [auth, authentication, authorization, security, login, password, token, jwt, session, oauth, secret, csrf, xss, injection, permission]
when: task touches login, sessions, tokens, permissions, user input, or secrets
phases: [plan, build, verify]
kind: domain
provenance: { origin: built-in }
---

# Auth & Security

## Rules

- **Never roll your own crypto or password hashing.** Passwords: argon2id
  or bcrypt via the platform's vetted library. Compare with constant-time
  functions. No MD5/SHA for passwords, ever.
- **AuthN ≠ AuthZ.** Authentication says who you are; EVERY endpoint still
  checks what you may do — on the server, against the resource ("is this
  order YOURS?"), not just the route. Client-side checks are UI hints only.
- **Sessions:** httpOnly + Secure + SameSite cookies; regenerate the ID on
  login; server-side revocation on logout/password change.
- **JWTs (if you must):** short-lived access (≤15 min) + rotating refresh;
  verify `alg` (reject `none`), `exp`, `aud`, `iss`; keys from env/KMS.
  If you need instant revocation, you wanted sessions.
- **Secrets live in the environment** (or a secrets manager) — never in
  code, configs, logs, error messages, or git history. `.env` is
  gitignored; ship `.env.example` with dummy values.
- **All user input is hostile:** parameterized SQL (see `databases.md`);
  context-aware output encoding (frameworks' default escaping — don't
  bypass with innerHTML/dangerouslySetInnerHTML); path traversal checks on
  any filename input; allowlists over blocklists.
- **CSRF:** any cookie-authenticated state change needs SameSite plus a
  CSRF token (or requires a custom header). Token-in-header APIs are
  exempt; cookie APIs are not.
- **Rate-limit auth endpoints** (login, reset, signup) and return uniform
  errors — "invalid credentials", never "no such user" (enumeration).
- **Fail closed.** Auth error / lookup failure / config missing → deny.

## Anti-patterns

- **Logging tokens/passwords** — scrub auth headers and bodies at the
  logger, once, centrally.
- **Role checks sprinkled inline** (`if user.role == "admin"`) → one
  authorization function/policy layer, called everywhere, testable alone.
- **Long-lived static API keys in client code** — anything shipped to a
  browser/app is public.
- **Home-grown password reset** — tokens must be single-use, expiring,
  hashed at rest, invalidated on use AND on password change.

## Checklist

- [ ] Every state-changing endpoint has an explicit server-side authZ check
- [ ] Secrets only via env; repo greps clean of keys (`git log -p` too)
- [ ] Auth failures uniform + rate-limited; nothing enumerable
- [ ] Tests include the NEGATIVE cases: wrong user, expired token, missing role
- [ ] Dependency audit run (npm audit / pip-audit) with highs resolved
