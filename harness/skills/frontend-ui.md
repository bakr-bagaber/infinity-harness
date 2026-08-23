---
name: frontend-ui
description: Frontend craft — state discipline, componentization, accessibility, loading/error states
tags: [frontend, ui, component, react, vue, svelte, state, form, accessibility, a11y, css, browser, render]
when: task builds or changes user interface
phases: [plan, build]
kind: domain
provenance: { origin: built-in }
---

# Frontend / UI

## Rules

- **State has one owner.** Every piece of state lives in exactly one place;
  everything else derives from it. Duplicated state = guaranteed
  desync bug. Derive, don't copy.
- **Server state ≠ UI state.** Data fetched from an API (cacheable,
  refetchable, shared) is a different animal from local UI state (open
  modal, input draft). Use the ecosystem's query layer for server state;
  keep UI state local to the component that owns it.
- **Every async view renders three states:** loading, error (with a retry
  affordance), and empty ("no results" is not a blank screen). Design them
  first — they're most of what users see on bad networks.
- **Forms:** controlled state or a form library — not DOM scraping.
  Validate on submit + inline after first blur; disable the submit button
  while in flight (double-submit is a data bug, not a UX nit).
- **Accessibility is baseline, not polish:** semantic elements first
  (`button`, `label`+input, `nav`); every interactive element keyboard
  reachable with visible focus; images get alt; color is never the only
  signal. If a div has onClick, it's a button — make it one.
- **Componentize by responsibility, not by size.** A component that takes
  12 props wants to be two. Container (data) vs presentational (markup)
  split keeps both testable.
- **Test behavior through the user's eyes:** render, interact (click/type),
  assert visible outcome. Don't assert internal state or mock child
  components — that's the implementation-coupled trap (`tdd.md`).

## Anti-patterns

- **useEffect as event handler** — effects synchronize with external
  systems; user actions belong in handlers. Effect-chains that set state
  which triggers effects = rewrite the data flow.
- **Prop drilling 4+ levels** → lift to context/store — but only genuinely
  shared state; context is not a junk drawer.
- **Pixel-perfect absolute positioning** → flexbox/grid; the content WILL
  change length and language.
- **Swallowed promise rejections in handlers** → every await in a handler
  has a catch that surfaces to the user.

## Checklist

- [ ] Loading / error / empty rendered for every async view
- [ ] Keyboard-only walkthrough works; focus visible
- [ ] No state duplicated across components (grep for copied fetch results)
- [ ] Forms: double-submit blocked, validation inline, errors named
- [ ] Interaction tests assert what the USER sees
