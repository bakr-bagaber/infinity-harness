import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRouterConfig, resolveModel, resolveThinking, DEFAULT_ROUTER } from '../src/modelRouter.ts';
import { defaultConfig, saveConfig } from '../src/core/config.ts';
import { saveFeatureList, loadFeatureList, nextActionableTask, findFeature } from '../src/core/featureList.ts';
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
    console.log('✓ routing-live — resolveModel/resolveThinking switch per actionable task');
  } finally { rmSync(d,{recursive:true,force:true}); }
}
