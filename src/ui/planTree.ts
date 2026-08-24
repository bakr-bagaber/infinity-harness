/**
 * infinity-harness — the plan, flattened into displayable rows.
 *
 * The plan on disk has five levels: goal → sprint → feature → task → subtask.
 * Only two of them used to reach the human. The widget drew features and
 * tasks; goals appeared as a single title line; sprints appeared nowhere at
 * all, so a plan organised into sprints looked, on screen, exactly like a plan
 * that was not. Subtasks showed up only under the one task being worked.
 *
 * The fix is one shared model of what the plan looks like, consumed by every
 * surface that draws it. The TUI windows these rows; the dashboard renders all
 * of them. Neither one walks the plan itself, so the two cannot drift — which
 * is the same rule the rest of this package follows for the same reason.
 *
 * Rows are pure data: no colour, no glyphs, no width. Presentation belongs to
 * the surface doing the drawing.
 */

import type { Feature, FeatureList, Goal, Sprint, Subtask, Task } from "../core/types.ts";
import { isDone } from "../core/featureList.ts";

export type PlanLevel = "goal" | "sprint" | "feature" | "task" | "subtask";

export type PlanRow = {
  level: PlanLevel;
  /** 0 for the outermost level actually present, so a plan with no goals is not indented. */
  depth: number;
  /** Stable identifier within the plan — `goal-001`, `feature-001/task-004`, … */
  id: string;
  /** Short label shown before the title: an id, or a task's plan number. */
  label: string;
  title: string;
  /** Task and subtask statuses; null for the grouping levels. */
  status: string | null;
  /** `3/7` for grouping levels — how much of this branch is finished. */
  done: number;
  total: number;
  /** Task-level extras. */
  dependsOn?: string[];
  criteria?: string[];
  difficulty?: string | null;
  /** 1-based position of a task in the flattened plan, for `← #3` labels. */
  index?: number;
  /** True when this row is the task the pipeline is working on right now. */
  active?: boolean;
  /** Which task row a subtask belongs to. */
  parentId?: string;
};

export type PlanTreeOptions = {
  /** Show subtasks for every task, not only the active one. */
  expandSubtasks?: boolean;
  /**
   * Skip grouping levels that carry no information. A plan with one unnamed
   * goal and no sprints should not spend two rows saying so.
   */
  collapseTrivial?: boolean;
  /**
   * Which levels the reader has asked to see.
   *
   * A hidden level does not hide what is under it: turning off sprints on a
   * plan organised into sprints must still show the features, one indent
   * shallower, or the setting silently deletes half the plan from view.
   */
  levels?: Partial<Record<PlanLevel, boolean>>;
};

function taskCounts(tasks: Task[] | undefined): { done: number; total: number } {
  const list = tasks ?? [];
  return { done: list.filter((t) => isDone(t.status as never)).length, total: list.length };
}

function subtaskRows(
  task: Task,
  taskId: string,
  depth: number,
  subtasks: Subtask[],
): PlanRow[] {
  return subtasks.map((s, i) => ({
    level: "subtask" as const,
    depth,
    id: `${taskId}#${s.id ?? i + 1}`,
    label: "",
    title: s.title ?? "",
    status: s.status ?? "pending",
    done: s.status === "complete" ? 1 : 0,
    total: 1,
    parentId: taskId,
  }));
}

export type PlanSprintGroup = {
  sprint: Sprint | null;
  features: Feature[];
  done: number;
  total: number;
};

export type PlanGoalGroup = {
  goal: Goal | null;
  sprints: PlanSprintGroup[];
  done: number;
  total: number;
};

function sumTasks(features: Feature[]): { done: number; total: number } {
  return features.reduce(
    (acc, f) => {
      const c = taskCounts(f.tasks);
      return { done: acc.done + c.done, total: acc.total + c.total };
    },
    { done: 0, total: 0 },
  );
}

/**
 * The plan's real shape: goals holding sprints holding features.
 *
 * Both the widget and the dashboard group by this, so the tree in the terminal
 * and the tree in the browser cannot disagree about where a feature belongs.
 * A feature with no sprint sits in a nameless sprint group; a feature with no
 * goal sits in a nameless goal group. Nothing is dropped for lacking a parent,
 * including a feature pointing at a goal or sprint that has been deleted —
 * silently hiding it is how a task nobody can see gets stuck forever.
 */
export function groupPlan(list: FeatureList): PlanGoalGroup[] {
  const goals = list.goals ?? [];
  const sprints = list.sprints ?? [];
  const features = list.features ?? [];

  const goalIds = new Set(goals.map((g) => g.id));
  const sprintIds = new Set(sprints.map((s) => s.id));
  const claimed = new Set<string>();

  const groupFor = (goal: Goal | null, ownSprints: Sprint[], direct: Feature[]): PlanGoalGroup => {
    const sprintGroups: PlanSprintGroup[] = ownSprints.map((sprint) => {
      const owned = features.filter((f) => f.sprintId === sprint.id);
      for (const f of owned) claimed.add(f.id);
      const c = sumTasks(owned);
      return { sprint, features: owned, done: c.done, total: c.total };
    });
    if (direct.length) {
      for (const f of direct) claimed.add(f.id);
      const c = sumTasks(direct);
      sprintGroups.push({ sprint: null, features: direct, done: c.done, total: c.total });
    }
    const c = sumTasks(sprintGroups.flatMap((sg) => sg.features));
    return { goal, sprints: sprintGroups, done: c.done, total: c.total };
  };

  const out: PlanGoalGroup[] = goals.map((goal) =>
    groupFor(
      goal,
      sprints.filter((s) => s.goalId === goal.id),
      features.filter((f) => f.goalId === goal.id && (!f.sprintId || !sprintIds.has(f.sprintId))),
    ),
  );

  // Sprints with no goal, and features with neither.
  const orphanSprints = sprints.filter((s) => !s.goalId || !goalIds.has(s.goalId));
  const orphanFeatures = features.filter((f) => !claimed.has(f.id) && !orphanSprints.some((s) => s.id === f.sprintId));
  if (orphanSprints.length || orphanFeatures.length) {
    out.push(groupFor(null, orphanSprints, orphanFeatures));
  }

  // A last sweep for anything the passes above still missed.
  const missed = features.filter((f) => !claimed.has(f.id));
  if (missed.length) {
    const c = sumTasks(missed);
    out.push({
      goal: null,
      sprints: [{ sprint: null, features: missed, done: c.done, total: c.total }],
      done: c.done,
      total: c.total,
    });
    for (const f of missed) claimed.add(f.id);
  }

  return out.filter((g) => g.goal !== null || g.sprints.some((sg) => sg.features.length > 0 || sg.sprint !== null));
}

/**
 * Flatten a plan into rows, in reading order.
 *
 * A grouping level with nothing to say is skipped: one unnamed goal and no
 * sprints should not cost two rows to communicate nothing. Everything else is
 * drawn, at the depth it belongs to.
 */
export function buildPlanRows(
  list: FeatureList,
  activeTaskId: string | null = null,
  options: PlanTreeOptions = {},
): PlanRow[] {
  const collapse = options.collapseTrivial !== false;
  const groups = groupPlan(list);
  const wants = (level: PlanLevel): boolean => options.levels?.[level] !== false;

  // A single goal is the run's headline and the surface draws it separately.
  const showGoals =
    wants("goal") &&
    (collapse ? groups.filter((g) => g.goal !== null).length > 1 : groups.some((g) => g.goal));
  const showSprints = wants("sprint") && groups.some((g) => g.sprints.some((sg) => sg.sprint !== null));

  const rows: PlanRow[] = [];
  let taskIndex = 0;

  const emitFeature = (feature: Feature, depth: number): void => {
    const counts = taskCounts(feature.tasks);
    let taskDepth = depth;
    if (wants("feature")) {
      rows.push({
        level: "feature",
        depth,
        id: feature.id,
        label: feature.id,
        title: feature.name ?? feature.id,
        status: null,
        done: counts.done,
        total: counts.total,
        criteria: Array.isArray(feature.criteria) ? feature.criteria : undefined,
      });
    } else {
      // Hiding the feature row must not hide its tasks — nor indent them as
      // though the row were still there.
      taskDepth = Math.max(0, depth - 1);
    }

    for (const task of feature.tasks ?? []) {
      // Numbered even when hidden: `← #3` has to keep meaning the same task
      // whatever the reader has chosen to look at.
      taskIndex += 1;
      if (!wants("task")) continue;
      const id = task.key ?? `${feature.id}/${task.id}`;
      const active = activeTaskId !== null && (id === activeTaskId || task.id === activeTaskId);
      rows.push({
        level: "task",
        depth: taskDepth + 1,
        id,
        label: String(taskIndex),
        title: task.description ?? id,
        status: task.status,
        done: isDone(task.status) ? 1 : 0,
        total: 1,
        dependsOn: Array.isArray(task.dependsOn) && task.dependsOn.length ? task.dependsOn : undefined,
        criteria: Array.isArray(task.criteria) && task.criteria.length ? task.criteria : undefined,
        difficulty: typeof task.difficulty === "string" ? task.difficulty : null,
        index: taskIndex,
        active,
      });

      // Subtasks follow the work. Showing them for every task fills the
      // window with detail nobody is acting on; showing them only for the
      // caller's "active" key hides them from any surface that does not track
      // one, so a task that is plainly in progress counts too.
      const subs = Array.isArray(task.subtasks) ? task.subtasks : [];
      const working = task.status === "in_progress" || task.status === "rework";
      const show = wants("subtask") && (options.expandSubtasks || active || working);
      if (show && subs.length) rows.push(...subtaskRows(task, id, taskDepth + 2, subs));
    }
  };

  for (const group of groups) {
    let depth = 0;
    if (showGoals && group.goal) {
      rows.push({
        level: "goal",
        depth: 0,
        id: group.goal.id,
        label: group.goal.id,
        title: group.goal.title ?? group.goal.id,
        status: null,
        done: group.done,
        total: group.total,
      });
      depth = 1;
    }
    for (const sg of group.sprints) {
      let featureDepth = depth;
      // Every feature row hidden means the tasks sit where the features were.
      if (showSprints && sg.sprint) {
        rows.push({
          level: "sprint",
          depth,
          id: sg.sprint.id,
          label: sg.sprint.id,
          title: sg.sprint.name ?? sg.sprint.id,
          status: null,
          done: sg.done,
          total: sg.total,
        });
        featureDepth = depth + 1;
      }
      for (const f of sg.features) emitFeature(f, featureDepth);
    }
  }

  return rows;
}

/** Rows the human is most likely to want in view: the active task, or the first open one. */
export function focusRowIndex(rows: PlanRow[]): number {
  const active = rows.findIndex((r) => r.level === "task" && r.active);
  if (active !== -1) return active;
  for (const status of ["in_progress", "rework", "blocked", "pending"]) {
    const i = rows.findIndex((r) => r.level === "task" && r.status === status);
    if (i !== -1) return i;
  }
  return Math.max(0, rows.length - 1);
}
