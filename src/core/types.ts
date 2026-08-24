/**
 * infinity-harness — shared domain types.
 *
 * Single source of truth for every shape that crosses a module boundary.
 * Nothing here does I/O; it is safe to import from anywhere.
 */

// ── Phases ──────────────────────────────────────────────────────────────────

export const PHASE_ORDER = [
  "init",
  "research",
  "define",
  "plan",
  "build",
  "verify",
  "simplify",
  "review",
  "ship",
] as const;

export type Phase = (typeof PHASE_ORDER)[number];

/** Phases enabled by default — RESEARCH and SIMPLIFY are opt-in. */
export const DEFAULT_ENABLED_PHASES: Phase[] = [
  "define",
  "plan",
  "build",
  "verify",
  "review",
  "ship",
];

/**
 * Phases whose output a human may want to sign off before the run continues.
 *
 * These are the three that decide *what gets built*. Everything after them is
 * execution: if the definition and the plan are right, an autonomous run that
 * gets BUILD wrong fails a gate and retries, but an autonomous run that got
 * DEFINE wrong spends a weekend building the wrong product perfectly.
 */
export const APPROVABLE_PHASES = ["research", "define", "plan"] as const;
export type ApprovablePhase = (typeof APPROVABLE_PHASES)[number];

export type Role = "researcher" | "planner" | "generator" | "evaluator" | "simplifier";

/** Which role owns each phase. Drives the "put on this hat" brief line. */
export const PHASE_ROLE: Record<Phase, Role> = {
  init: "planner",
  research: "researcher",
  define: "planner",
  plan: "planner",
  build: "generator",
  verify: "evaluator",
  simplify: "simplifier",
  review: "evaluator",
  ship: "evaluator",
};

// ── Task / feature status ───────────────────────────────────────────────────

export const TASK_STATUSES = [
  "pending",
  "in_progress",
  "complete",
  "blocked",
  "rework",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const SUBTASK_STATUSES = ["pending", "in_progress", "complete"] as const;
export type SubtaskStatus = (typeof SUBTASK_STATUSES)[number];

export type Difficulty = "easy" | "moderate" | "difficult";

// ── Feature list (the SSOT on disk) ─────────────────────────────────────────

export type Subtask = {
  id: string;
  title: string;
  status: SubtaskStatus;
};

export type Task = {
  id: string;
  /** Stable key; defaults to `id`, may be `featureId/taskId`. */
  key?: string;
  description: string;
  status: TaskStatus;
  dependsOn?: string[];
  subtasks?: Subtask[];
  difficulty?: Difficulty;
  modelHint?: string;
  criteria?: string[];
  /** Free-form extras are preserved verbatim on round-trip. */
  [k: string]: unknown;
};

export type Feature = {
  id: string;
  name: string;
  description?: string;
  passes?: boolean;
  sprintId?: string;
  goalId?: string;
  criteria?: string[];
  tasks: Task[];
  [k: string]: unknown;
};

export type Sprint = {
  id: string;
  name: string;
  goalId?: string;
  [k: string]: unknown;
};

export type Goal = {
  id: string;
  title: string;
  description?: string;
  [k: string]: unknown;
};

export type FeatureList = {
  version: string;
  /** Optimistic-concurrency counter. Bumped on every mutating write. */
  baseRevision: number;
  goals?: Goal[];
  sprints?: Sprint[];
  features: Feature[];
  [k: string]: unknown;
};

// ── Config (harness/config.json) ────────────────────────────────────────────

export type GateHistoryEntry = {
  phase: string;
  result: "pass" | "fail";
  timestamp: string;
  feature?: string;
  task?: string;
};

export type RetryBucket = {
  enabled: boolean;
  maxRetries: number | null;
};

/**
 * How the run divides itself into pi sessions.
 *
 * A harness that never starts a new session is a harness whose context window
 * only ever grows: by the tenth task the model is reading the whole history of
 * the first nine to do the tenth, paying for it, and — on a small model —
 * drowning in it. The plan, the phase and the gate all live on disk, so a
 * session boundary costs nothing but the brief, and the brief is what the
 * agent should be working from anyway.
 */
export type SessionPolicy = {
  /**
   * When to hand off to a fresh session.
   *   off    never — one session for the whole run (the old behaviour)
   *   phase  when the pipeline advances a phase
   *   task   when the pipeline advances a phase or moves to a different task
   */
  handoff: "off" | "phase" | "task";
  /**
   * Hand off early once the context is this full, as a fraction of the
   * window. 0 disables it. This is what keeps a long BUILD phase — which may
   * never advance for hours — from riding a single session into compaction.
   */
  contextThreshold: number;
  /** Carry a short "what the last session did" note into the new session. */
  carryNotes: boolean;
};

/** Which phases stop and wait for a human signature before the run continues. */
export type ApprovalPolicy = {
  research: boolean;
  define: boolean;
  plan: boolean;
};

/** What the start-up wizard settled, so it is never asked twice. */
export type IntakeState = {
  /** True once the wizard has run to completion for this project. */
  completed: boolean;
  /** What the human said they want built, in their words. */
  brief: string | null;
  /** ISO timestamp of the wizard run. */
  at: string | null;
};

export type HarnessConfig = {
  version: string;
  stack: string | null;
  mode: "copilot" | "autopilot";
  currentPhase: Phase | null;
  currentRole: Role | null;
  currentFeature: string | null;
  currentTask: string | null;
  paused: boolean;
  features: { remaining: number; passing: number; total: number };
  gates: {
    enabled: boolean;
    checks: string[];
    coverage: { enabled: boolean; threshold: number };
    cleanState: { enabled: boolean; stalePatterns: string[]; startupCmd: string | null };
    antiPlaceholder: { enabled: boolean; patterns: string[] };
  };
  commands: {
    lint: string | null;
    test: string | null;
    coverage: string | null;
    build: string | null;
  };
  git: {
    autoCommit: boolean;
    autoTag: boolean;
    branch: string | null;
    clean: boolean;
    hasUpstream: boolean;
    lastCommitMessage: string | null;
  };
  phases: { enabled: Phase[] };
  roles: { strict: boolean };
  session: SessionPolicy;
  approvals: ApprovalPolicy;
  intake: IntakeState;
  /** Set when a gate passed but the phase needs a human signature first. */
  awaitingApproval: Phase | null;
  /** Budgets that bound an unattended continuous run. See src/loop.ts. */
  loop: {
    maxIterations: number;
    maxWallClockMs: number;
    noProgressLimit: number;
  };
  retry: {
    tasks: RetryBucket;
    features: RetryBucket;
    phases: RetryBucket;
  };
  maxRetries: number;
  retryCount: number;
  taskRetryCount: number;
  featureRetryCount: number;
  phaseRetryCount: number;
  pipelineIteration: number;
  gateHistory: GateHistoryEntry[];
  [k: string]: unknown;
};

// ── Gates ───────────────────────────────────────────────────────────────────

export type CheckResult = {
  name: string;
  pass: boolean;
  detail: string;
  /** Advisory checks never fail the gate; they are reported for context. */
  advisory?: boolean;
};

export type GateResult = {
  phase: string;
  checks: CheckResult[];
  overall: boolean;
  failures: string[];
  feature?: string;
  task?: string;
};

// ── Brief ───────────────────────────────────────────────────────────────────

export type Brief = {
  phase: Phase | null;
  role: Role | null;
  paused: boolean;
  complete: boolean;
  goal: string | null;
  feature: { id: string; name: string } | null;
  task: { id: string; key: string; description: string; status: TaskStatus } | null;
  criteria: string[];
  validateCommand: string;
  gate: GateResult | null;
  progress: { tasksDone: number; tasksTotal: number; featuresDone: number; featuresTotal: number };
  retries: { task: number; feature: number; phase: number; max: number };
  /** Craft skills worth reading before starting this task, best match first. */
  skills: { name: string; description: string; why: string }[];
  notes: string[];
};

// ── Errors ──────────────────────────────────────────────────────────────────

export class ValidationError extends Error {
  override readonly name = "ValidationError";
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class HarnessError extends Error {
  override readonly name = "HarnessError";
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, HarnessError.prototype);
  }
}
