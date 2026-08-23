/**
 * infinity-harness — shared domain types.
 *
 * Single source of truth for every shape that crosses a module boundary.
 * Nothing here does I/O; it is safe to import from anywhere.
 */

// ── Phases ──────────────────────────────────────────────────────────────────

export const PHASE_ORDER = [
  "init",
  "define",
  "plan",
  "build",
  "verify",
  "simplify",
  "review",
  "ship",
] as const;

export type Phase = (typeof PHASE_ORDER)[number];

/** Phases enabled by default — SIMPLIFY is opt-in. */
export const DEFAULT_ENABLED_PHASES: Phase[] = [
  "define",
  "plan",
  "build",
  "verify",
  "review",
  "ship",
];

export type Role = "planner" | "generator" | "evaluator" | "simplifier";

/** Which role owns each phase. Drives the "put on this hat" brief line. */
export const PHASE_ROLE: Record<Phase, Role> = {
  init: "planner",
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
