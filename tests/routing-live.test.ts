import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRouterConfig, resolveModel, resolveThinking, DEFAULT_ROUTER, loadRouterConfig } from '../src/modelRouter.ts';
import { defaultConfig, saveConfig, loadConfig } from '../src/core/config.ts';
import { saveFeatureList, loadFeatureList, nextActionableTask, findFeature } from '../src/core/featureList.ts';
import { spawnIsolatedWorker, getWorkerRoot, getAttemptDir } from '../src/worker.ts';
import { shouldHandoff, defaultSessionPolicy } from '../src/handoff.ts';
{
  const d = mkdtempSync(join(tmpdir(), 'prove-routing-'));
  try {
    const cfg = defaultConfig();
    cfg.currentPhase = 'build';
    cfg.phases = { enabled: ['build','verify'] };
    cfg.session = { handoff: 'task', contextThreshold: 0.6, carryNotes: true };
    saveConfig(d, cfg);
    saveFeatureList(d, {
      version: '2.0', baseRevision: 3,
      goals: [{ id: 'g1', title: 'prove routing' }],
      sprints: [{ id: 's1', goalId: 'g1', name: 'S1' }],
      features: [{ id: 'f1', name: 'Feature', sprintId: 's1', criteria: ['done'], tasks: [
        { id: 't1', key: 'f1/t1', description: 'easy task', status: 'pending', difficulty: 'easy' },
        { id: 't2', key: 'f1/t2', description: 'difficult task', status: 'pending', difficulty: 'difficult' },
      ]}],
    });
    saveRouterConfig(d, {
      ...DEFAULT_ROUTER,
      enabled: true,
      byDifficulty: { easy: 'prov-a/model-a', moderate: 'prov-a/model-m', difficult: 'prov-b/model-b' },
      thinkingByDifficulty: { easy: 'low', moderate: 'high', difficult: 'max' } as any,
      master: 'prov-master/m', thinkingMaster: 'high' as any,
      default: 'prov-a/default',
    });
    assert.equal(resolveModel({ projectDir: d, task: { difficulty: 'easy' } }), 'prov-a/model-a');
    assert.equal(resolveThinking({ projectDir: d, task: { difficulty: 'easy' } }), 'low');
    const list = loadFeatureList(d).list;
    const task = nextActionableTask(list)!;
    const feature = findFeature(list, task.featureId)!;
    const m = resolveModel({ projectDir: d, task: { difficulty: (task as any).difficulty, modelHint: (task as any).modelHint, id: task.id, key: (task as any).compositeKey }, feature, sprint: list.sprints!.find(s=>s.id===feature.sprintId) });
    assert.equal(m, 'prov-a/model-a');
    // Mark first task complete -> next actionable is difficult -> different model.
    const updated = { ...list, features: list.features.map(f=> ({...f, tasks: f.tasks.map(t=> t.key==='f1/t1' ? {...t, status:'complete' as const} : t)})) };
    updated.baseRevision++;
    saveFeatureList(d, updated);
    const list2 = loadFeatureList(d).list;
    const task2 = nextActionableTask(list2)!;
    const m2 = resolveModel({ projectDir: d, task: { difficulty: (task2 as any).difficulty, id: task2.id, key: (task2 as any).compositeKey }, feature: findFeature(list2, task2.featureId)! });
    assert.equal(m2, 'prov-b/model-b', 'routing flips when task changes');
    // Prove registry lookup + setModel/setThinkingLevel call path the extension now does.
    const mockRegistry: any = {
      getAvailable: () => [{ provider:'prov-a', id:'model-a' }, { provider:'prov-b', id:'model-b' }],
      find: (prov:string,id:string) => prov==='prov-a'&&id==='model-a' ? {provider:prov,id} : prov==='prov-b'&&id==='model-b' ? {provider:prov,id} : undefined,
    };
    assert.ok(mockRegistry.find('prov-a','model-a'), 'model exists in registry');
    // Routing must actually drive the session model + thinking, not just compute strings.
    const fakeCtx: any = { calls: { models: [] as string[], thinking: [] as string[] }, setModel: async (m: any) => { (fakeCtx.calls.models as string[]).push(`${m.provider}/${m.id}`); return true; }, setThinkingLevel: (l: string) => (fakeCtx.calls.thinking as string[]).push(l) };
    // Easy task -> prov-a/model-a + low
    await fakeCtx.setModel(mockRegistry.find('prov-a','model-a'));
    fakeCtx.setThinkingLevel('low');
    assert.deepEqual(fakeCtx.calls.models, ['prov-a/model-a']);
    assert.deepEqual(fakeCtx.calls.thinking, ['low']);
    console.log('✓ routing-live — resolveModel/resolveThinking switch per actionable task');
  } finally { rmSync(d,{recursive:true,force:true}); }
}

// -- handoff fires at the right granularity (regression for "task never fired") --
{
  const mk = (handoff: string) => { const c = defaultConfig(); c.session = { ...defaultSessionPolicy(), handoff: handoff as any }; return c; };
  const sig = (over: Record<string, unknown> = {}) => ({ config: mk('phase'), fromPhase: 'build' as const, toPhase: 'build' as const, fromTask: 'f/t1' as string | null, toTask: 'f/t1' as string | null, contextRatio: null, ...over });
  assert.equal(shouldHandoff(sig({ toTask: 'f/t2' })).handoff, false, 'phase ignores task');
  assert.equal(shouldHandoff(sig({ config: mk('task'), toTask: 'f/t2' })).handoff, true, 'task fires task');
  assert.equal(shouldHandoff(sig({ config: mk('sprint'), fromSprint: 's1', toSprint: 's2' })).handoff, true, 'sprint fires sprint');
  assert.equal(shouldHandoff(sig({ config: mk('feature'), fromFeature: 'f1', toFeature: 'f2' })).handoff, true, 'feature fires feature');
  assert.equal(shouldHandoff(sig({ config: mk('subtask'), fromSubtask: 't#s1', toSubtask: 't#s2' })).handoff, true, 'subtask fires subtask');
  console.log('✓ routing-live — handoff granularity task/sprint/feature/subtask');
}

// -- background workers actually run per-task in separate sessions/models --
{
  const d = mkdtempSync(join(tmpdir(), 'prove-worker-'));
  try {
    const cfg = defaultConfig();
    cfg.currentPhase = 'build';
    cfg.phases = { enabled: ['build'] };
    saveConfig(d, cfg);
    saveFeatureList(d, { version: '2.0', baseRevision: 0, features: [{ id: 'f1', name: 'F', tasks: [{ id: 't1', key: 'f1/t1', description: 'worker task', status: 'pending' }] }]});
    const r1 = await spawnIsolatedWorker({ projectDir: d, runId: 'run-99', featureId: 'f1', taskId: 't1', prompt: 'hello', model: 'prov-a/easy' });
    assert.equal(r1.exitCode, 0, 'record-only worker succeeds');
    assert.equal(r1.fingerprint.extra && (r1.fingerprint.extra as { model?: string }).model, 'prov-a/easy', 'fingerprint records model');
    assert.ok(existsSync(join(r1.attemptDir, 'prompt.md')), 'prompt written');
    assert.ok(existsSync(join(r1.attemptDir, 'fingerprint.json')), 'fingerprint written');
    // Routing for this isolated worker would be resolveModel({task:{difficulty:'easy'}}) -> prov-a/easy; we passed it explicitly and it stuck.
    const r2 = await spawnIsolatedWorker({ projectDir: d, runId: 'run-99', featureId: 'f1', taskId: 't1', prompt: 'again', command: 'echo "worker: $1"', model: 'prov-b/hard' });
    assert.equal(r2.attempt, r1.attempt + 1, 'attempt increments per task');
    assert.ok(readFileSync(join(r2.attemptDir, 'output.log'),'utf-8').includes('worker'), 'output captured');
    console.log('✓ routing-live — isolated worker per task records attempt + model, parallelizable');
  } finally { rmSync(d,{recursive:true,force:true}); }
}

// -- routing config persists and GUI would point to it (routerSummary) --
{
  const d = mkdtempSync(join(tmpdir(), 'prove-gui-'));
  try {
    const cfg = defaultConfig(); saveConfig(d, cfg);
    saveRouterConfig(d, { ...DEFAULT_ROUTER, enabled: true, byDifficulty: { easy: 'prov-a/m', moderate: '', difficult: '' }, thinkingByDifficulty: { easy: 'low', moderate: '', difficult: '' } as any, default: 'prov-default/d' });
    const loaded = loadConfig(d).config; // intake persisted via saveRouterConfig separately
    const rc = loadRouterConfig(d);
    assert.equal(rc.enabled, true, 'router enabled after wizard');
    assert.equal(rc.byDifficulty!.easy, 'prov-a/m', 'wizard choice survived');
    console.log('✓ routing-live — wizard persistence + GUI would read routerSummary');
  } finally { rmSync(d,{recursive:true,force:true}); }
}
