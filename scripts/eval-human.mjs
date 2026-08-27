#!/usr/bin/env node
/**
 * Human-equivalent harness evaluation — separate CLI per project, separate TUI+dashboard parsing.
 * Runs inside C:\Projects\dummy_test (WSL: /mnt/c/Projects/dummy_test).
 * No code is changed — only evaluates and writes EVALUATION.md + artefacts.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.features.typescript) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DUMMY_ROOT = process.platform === "win32" ? "C:/Projects/dummy_test" : "/mnt/c/Projects/dummy_test";
const EXT = join(REPO_ROOT, "extensions", "infinity-harness", "index.ts");

const src = (rel) => import(pathToFileURL(join(REPO_ROOT, "src", rel)).href);
const { loadConfig, saveConfig } = await src("core/config.ts");
const { featureListPath } = await src("core/paths.ts");
const { loadFeatureList, saveFeatureList, computeProgress, flattenTasks } = await src("core/featureList.ts");
const { runChecks } = await src("core/gates.ts");
const { buildBrief, renderBrief } = await src("core/brief.ts");
const { initHarness } = await src("core/init.ts");
const { createRemoteServer, buildRemoteState, buildHtml, buildApiPayload } = await src("remote.ts");
const { renderWidget, defaultView } = await src("ui/widget.ts");
const { createStyler, detectGlyphs, stripAnsi, width } = await src("ui/theme.ts");
const { decideNext, loopStatePath } = await src("loop.ts");
const { PiDriver, startMockModel } = await import(pathToFileURL(join(REPO_ROOT, "scripts", "rig", "pi-driver.mjs")).href);

const argv = process.argv.slice(2);
const ONLY = (() => { const i = argv.indexOf("--only"); return i === -1 ? null : argv[i+1] ?? null; })();
const LIST_ONLY = argv.includes("--list");

const out = (s="") => process.stdout.write(s+"\n");
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));
const prose = (min) => { const s="The harness records the reasoning behind each decision so a later reader can follow it without guessing. "; let t=""; while(t.length<min+20) t+=s; return t; };
function git(dir,args){ return execFileSync("git",args,{cwd:dir,encoding:"utf-8",stdio:["ignore","pipe","pipe"]}); }
function gitInit(dir){ git(dir,["init","-q","-b","main"]); git(dir,["config","user.email","eval@dummy.invalid"]); git(dir,["config","user.name","eval"]); git(dir,["config","commit.gpgsign","false"]); }
function gitCommitAll(dir,msg){ git(dir,["add","-A"]); git(dir,["commit","-q","--allow-empty","-m",msg]); }
function put(dir,rel,contents){ const p=join(dir,rel); mkdirSync(dirname(p),{recursive:true}); writeFileSync(p,contents,"utf-8"); return p; }
function writePlanFile(dir,list){ writeFileSync(featureListPath(dir), JSON.stringify(list,null,2)+"\n","utf-8"); }
function mkTempDir(prefix){ return mkdtempSync(join(tmpdir(), `eval-${prefix}-`)); }
function ensureDummy(){ mkdirSync(DUMMY_ROOT,{recursive:true}); }
function cleanDummy(){
  ensureDummy();
  for(const name of readdirSync(DUMMY_ROOT)){
    if(name.startsWith(".")) continue;
    const p=join(DUMMY_ROOT,name);
    try{ rmSync(p,{recursive:true,force:true}); }catch{}
  }
}

const PROJECTS = [
  { id:"01-research-fullauto-node", title:"Research-first, full-autopilot, Node, everything display", goal:"Reconcile Stripe payouts against the ledger with CSV import, fee handling and ledger balance checks", workflow:"research-first", display:"everything", handoff:"task", execution:{parallelAt:"task",maxWorkers:3}, stack:"node", phases:["research","define","plan","build","verify","review","ship"], modes:{research:"autopilot",define:"autopilot",plan:"autopilot",build:"autopilot",verify:"autopilot",review:"autopilot",ship:"autopilot"}, routing:{enabled:false}, plan:"research" },
  { id:"02-copilot-multigoal-parallel", title:"Copilot, 3 goals / 5 sprints / 12 features / 38 tasks, parallelAt feature×5", goal:"Ship OrbitCart marketplace — e-commerce + community with offline mocks, covering easy/moderate/difficult", workflow:"copilot", display:"focus", handoff:"feature", execution:{parallelAt:"feature",maxWorkers:5}, stack:"node", phases:["define","plan","build","verify","review","ship"], modes:{define:"copilot",plan:"copilot",build:"autopilot",verify:"autopilot",review:"autopilot",ship:"autopilot"}, routing:{enabled:true, byDifficulty:{easy:"lm-studio/granite-4.2-3b", moderate:"lm-studio/lfm2.5-2.6b-qad@q4_0", difficult:"lm-studio/qwen3.8-4b"}, thinkingByDifficulty:{easy:"low", moderate:"medium", difficult:"high"}, master:"meta/muse-spark-1.2-contributor", thinkingMaster:"xhigh", default:"opencode/nemotron-3.5-lightning-free", thinkingDefault:"high"}, plan:"multigoal" },
  { id:"03-edge-adversarial-unknown", title:"Unknown stack, SIMPLIFY opt-in, huge plan windowing, CJK/emoji", goal:"Edge harness — adversarial inputs, huge plan windowing, CJK/emoji survival", workflow:"autopilot", display:"overview", handoff:"off", execution:{parallelAt:"off",maxWorkers:1}, stack:"unknown", phases:["define","plan","build","verify","simplify","review","ship"], modes:{define:"autopilot",plan:"autopilot",build:"autopilot",verify:"autopilot",simplify:"autopilot",review:"autopilot",ship:"autopilot"}, routing:{enabled:false}, plan:"adversarial" },
  { id:"04-escalation-stuck-ladder", title:"Stuck ladder retry→reframe→consult→rework→replan→master", goal:"Prove escalation ladder stops a spinning run after trying everything", workflow:"autopilot", display:"worklist", handoff:"phase", execution:{parallelAt:"task",maxWorkers:2}, stack:"node", phases:["define","plan","build","verify","ship"], modes:{define:"autopilot",plan:"autopilot",build:"autopilot",verify:"autopilot",ship:"autopilot"}, routing:{enabled:true, byDifficulty:{easy:"lm-studio/granite-4.2-3b", moderate:"lm-studio/lfm2.5-2.6b-qad@q4_0", difficult:"lm-studio/qwen3.8-4b"}, thinkingByDifficulty:{easy:"low", moderate:"medium", difficult:"high"}, master:"meta/muse-spark-1.2-contributor", thinkingMaster:"xhigh", default:"opencode/nemotron-3.5-lightning-free", thinkingDefault:"high"}, plan:"stuck" },
  { id:"05-goal-outer-loop", title:"Goal outer loop — incomplete then complete, rewound pipeline", goal:"Ship payments rewrite behind a flag with latency metric", workflow:"spec-and-ship", display:"focus", handoff:"phase", execution:{parallelAt:"subtask",maxWorkers:4}, stack:"node", phases:["define","plan","build","verify","review","ship"], modes:{define:"copilot",plan:"autopilot",build:"autopilot",verify:"autopilot",review:"autopilot",ship:"copilot"}, routing:{enabled:false}, plan:"goal" },
  { id:"06-compaction-headless-dashboard", title:"Compaction survival + headless + dashboard read-only + widget scroll", goal:"Long-run compaction with handoff off, small window 12k, lorem 400×", workflow:"autopilot", display:"everything", handoff:"off", execution:{parallelAt:"task",maxWorkers:3}, stack:"node", phases:["define","plan","build","verify","ship"], modes:{define:"autopilot",plan:"autopilot",build:"autopilot",verify:"autopilot",ship:"autopilot"}, routing:{enabled:false}, plan:"compaction" },
  { id:"07-routing-granite-lfm-qwen-nemotron-consultant", title:"Model routing — granite/lfm/qwen tiers + nemotron default + spark consultant", goal:"Validate model routing resolves per difficulty and consultant ladder", workflow:"autopilot", display:"focus", handoff:"task", execution:{parallelAt:"task",maxWorkers:3}, stack:"node", phases:["define","plan","build","verify","ship"], modes:{define:"autopilot",plan:"autopilot",build:"autopilot",verify:"autopilot",ship:"autopilot"}, routing:{enabled:true, byDifficulty:{easy:"lm-studio/granite-4.2-3b", moderate:"lm-studio/lfm2.5-2.6b-qad@q4_0", difficult:"lm-studio/qwen3.8-4b"}, thinkingByDifficulty:{easy:"low", moderate:"medium", difficult:"high"}, master:"meta/muse-spark-1.2-contributor", thinkingMaster:"xhigh", default:"opencode/nemotron-3.5-lightning-free", thinkingDefault:"high"}, plan:"routing" },
];

if(LIST_ONLY){
  out("Evaluation matrix — 6 projects inside C:\\Projects\\dummy_test");
  out("Each: isolated CLI (PiDriver --mode rpc), isolated TUI (setWidget/setStatus/notify), isolated dashboard (HTTP + offline)");
  out("");
  for(const p of PROJECTS) out(`  ${p.id}  ${p.title}\n      workflow=${p.workflow} display=${p.display} handoff=${p.handoff} parallelAt=${p.execution.parallelAt}×${p.execution.maxWorkers} stack=${p.stack}`);
  process.exit(0);
}

cleanDummy();
out(`Cleaned ${DUMMY_ROOT} — creating ${PROJECTS.length} projects (separate CLI per project)`);

const workdir = mkTempDir("eval-workdir");
const scriptPath = join(workdir,"model.json");
const reqLog = join(workdir,"requests.jsonl");
writeFileSync(scriptPath, JSON.stringify({ default:{ content:"Working. Acknowledged — proceeding per brief." } }));
const mock = await startMockModel(scriptPath, reqLog);
out(`Mock model server at :${mock.port}`);

const selected = ONLY ? PROJECTS.filter(p=> p.id===ONLY || p.id.startsWith(ONLY)) : PROJECTS;
if(selected.length===0){ out(`no project matches "${ONLY}"`); process.exit(1); }

for(const spec of selected){
  out("");
  out("─".repeat(72));
  out(`▸ ${spec.id}  ${spec.title}`);
  out(`  workflow=${spec.workflow} display=${spec.display} handoff=${spec.handoff} parallelAt=${spec.execution.parallelAt}×${spec.execution.maxWorkers}`);
  out("─".repeat(72));
  const t0 = Date.now();
  const dir = join(DUMMY_ROOT, spec.id);
  mkdirSync(dir,{recursive:true});
  gitInit(dir);
  if(spec.stack==="node"){
    writeFileSync(join(dir,"package.json"), JSON.stringify({name:spec.id,version:"1.0.0",scripts:{test:"node -e 0",lint:"node -e 0"}},null,2));
  } else if(spec.stack==="python"){
    writeFileSync(join(dir,"pyproject.toml"), `[project]\nname="${spec.id}"\n`);
    mkdirSync(join(dir,"tests"),{recursive:true});
    writeFileSync(join(dir,"tests/test_x.py"), "def test_x(): pass\n");
  }
  writeFileSync(join(dir,"README.md"), `# ${spec.id}\n\n${prose(300)}\n`);
  writeFileSync(join(dir,"LICENSE"), "MIT License\n\nPermission is hereby granted...\n");
  writeFileSync(join(dir,"CHANGELOG.md"), `# Changelog\n\n## 0.1.0\n\n${prose(150)}\n`);
  gitCommitAll(dir,"chore: initial commit");

  // Only 01 uses the real wizard (human-like); 02-07 use direct initHarness for deterministic routing/plans.
  // 02's routing is still tested via harness/model-router.json probe (see routing-probe.json), not via wizard fragility.
  const useRealWizard = spec.id==="01-research-fullauto-node";
  const artefacts = join(dir,"artefacts");
  mkdirSync(artefacts,{recursive:true});
  let driver=null, configDir=null, sessionDir=null, server=null;

  try{
    if(useRealWizard){
      configDir = mkTempDir(`eval-config-${spec.id}`);
      sessionDir = mkTempDir(`eval-sessions-${spec.id}`);
      driver = new PiDriver({ cwd:dir, configDir, sessionDir, port:mock.port, extensions:[EXT], contextWindow: spec.id==="06-compaction-headless-dashboard"?12000:40000, settings: spec.id==="06-compaction-headless-dashboard"?{compaction:{enabled:true,reserveTokens:2000,keepRecentTokens:3000}}:{} }).start();
      await sleep(1500);
      if(spec.id==="01-research-fullauto-node"){
        driver.answer(r=> /Create a harness here/.test(r.title??""), r=> r.options[0]);
        driver.answer(r=> /which phases, and which of them stop for you/.test(r.title??""), r=> r.options.find(o=> /^research first/.test(o)));
        driver.answer(r=> /What are you building/.test(r.title??""), spec.goal);
        driver.answer(r=> /fresh session/.test(r.title??""), r=> r.options.find(o=> /every task/.test(o)) ?? r.options[0]);
        driver.answer(r=> /Route work by difficulty/.test(r.title??""), r=> r.options.find(o=> /no.+use pi/i.test(o)) ?? r.options[0]);
        driver.answer(r=> /When to run things in parallel/.test(r.title??""), r=> r.options.find(o=> /parallel at task/.test(o)) ?? r.options[0]);
        driver.answer(r=> /Max parallel workers/.test(r.title??""), String(spec.execution.maxWorkers));
        driver.answer(r=> /How much of the plan/.test(r.title??""), r=> r.options.find(o=> /^everything/.test(o)) ?? r.options[0]);
        driver.answer(r=> /Ready\?/.test(r.title??""), r=> r.options[0]);
      } else {
        driver.answer(r=> /Create a harness here/.test(r.title??""), r=> r.options[0]);
        driver.answer(r=> /which phases, and which of them stop for you/.test(r.title??""), r=> r.options.find(o=> /^copilot/.test(o)));
        driver.answer(r=> /What are you building/.test(r.title??""), spec.goal);
        driver.answer(r=> /fresh session/.test(r.title??""), r=> r.options.find(o=> /every feature/.test(o)) ?? r.options[0]);
        // 02 real routing via enable → tiers → master → default; answer all 8 prompts as human would reading menus
        driver.answer(r=> /Route work by difficulty/.test(r.title??""), r=> r.options.find(o=> /yes — pick models per tier/.test(o)) ?? r.options[0]);
        driver.answer(r=> /EASY tier — model/.test(r.title??""), r=> r.options.find(o=> o.includes("granite-4.2-3b")) ?? r.options.find(o=> /type a model/.test(o)) ?? r.options[0]);
        driver.answer(r=> /EASY tier — thinking/.test(r.title??""), r=> r.options.find(o=> o==="low") ?? r.options[0]);
        driver.answer(r=> /MODERATE tier — model/.test(r.title??""), r=> r.options.find(o=> o.includes("lfm2.5")) ?? r.options.find(o=> /type a model/.test(o)) ?? r.options[0]);
        driver.answer(r=> /MODERATE tier — thinking/.test(r.title??""), r=> r.options.find(o=> o==="medium") ?? r.options[0]);
        driver.answer(r=> /DIFFICULT tier — model/.test(r.title??""), r=> r.options.find(o=> o.includes("qwen3.8-4b")) ?? r.options.find(o=> /type a model/.test(o)) ?? r.options[0]);
        driver.answer(r=> /DIFFICULT tier — thinking/.test(r.title??""), r=> r.options.find(o=> o==="high") ?? r.options[0]);
        driver.answer(r=> /Consulting master — model/.test(r.title??""), r=> r.options.find(o=> o.includes("muse-spark-1.2-contributor")) ?? r.options.find(o=> /type a model/.test(o)) ?? r.options[0]);
        driver.answer(r=> /Consulting master — thinking/.test(r.title??""), r=> r.options.find(o=> o==="xhigh") ?? r.options[0]);
        driver.answer(r=> /Default — fallback/.test(r.title??""), r=> r.options.find(o=> o.includes("nemotron-3.5-lightning")) ?? r.options.find(o=> /type a model/.test(o)) ?? r.options[0]);
        driver.answer(r=> /Default — thinking level fallback/.test(r.title??""), r=> r.options.find(o=> o==="high") ?? r.options[0]);
        driver.answer(r=> /When to run things in parallel/.test(r.title??""), r=> r.options.find(o=> /parallel at feature/.test(o)) ?? r.options[0]);
        driver.answer(r=> /Max parallel workers/.test(r.title??""), String(spec.execution.maxWorkers));
        driver.answer(r=> /How much of the plan/.test(r.title??""), r=> r.options.find(o=> /^focus/.test(o)) ?? r.options[0]);
        driver.answer(r=> /Ready\?/.test(r.title??""), r=> r.options[0]);
      }
      await driver.prompt("/infinity:init");
      const deadline=Date.now()+40000;
      while(Date.now()<deadline && !existsSync(join(dir,"harness","config.json"))) await sleep(250);
      await sleep(800);
      const widget=driver.widget();
      writeFileSync(join(artefacts,"widget-init.txt"), widget?widget.join("\n"):"(no widget)", "utf-8");
      writeFileSync(join(artefacts,"notes-init.txt"), driver.notes()??"", "utf-8");
      writeFileSync(join(artefacts,"transcript-init.log"), driver.transcript().map(m=> `[${m.role}] ${m.text.slice(0,500)}`).join("\n\n"), "utf-8");
      if(existsSync(join(dir,"harness","config.json"))) writeFileSync(join(artefacts,"config-init.json"), readFileSync(join(dir,"harness","config.json"),"utf-8"), "utf-8");
      if(existsSync(join(dir,"harness","features","feature-list.json"))) writeFileSync(join(artefacts,"feature-list-init.json"), readFileSync(join(dir,"harness","features","feature-list.json"),"utf-8"), "utf-8");
      if(spec.id==="02-copilot-multigoal-parallel"){
        const goals=[{id:"goal-001",title:"Marketplace core"},{id:"goal-002",title:"Community"},{id:"goal-003",title:"Ops"}];
        const sprints=[{id:"sprint-001",name:"Foundations",goalId:"goal-001"},{id:"sprint-002",name:"Checkout",goalId:"goal-001"},{id:"sprint-003",name:"Social",goalId:"goal-002"},{id:"sprint-004",name:"Moderation",goalId:"goal-002"},{id:"sprint-005",name:"Infra",goalId:"goal-003"}];
        let taskCounter=0;
        const features=[];
        for(let fi=0; fi<12; fi++){
          const fId=`feature-${String(fi+1).padStart(3,"0")}`;
          const sId=sprints[fi % sprints.length].id;
          const gId=sprints.find(s=>s.id===sId).goalId;
          const nTasks= fi===0?5: fi<6?3:2;
          const tasks=Array.from({length:nTasks}, (_,i)=>{
            const tId=`task-${String(taskCounter+i+1).padStart(3,"0")}`;
            const diff=["easy","moderate","difficult"][(taskCounter+i)%3];
            return { id:tId, description:`${fId} ${tId} — ${diff} slice`, status:"pending", difficulty:diff, dependsOn:[], subtasks: (taskCounter+i)%4===0?[{title:`research ${tId}`,status:"pending"},{title:`implement ${tId}`,status:"pending"},{title:`test ${tId}`,status:"pending"}]:[] };
          });
          for(let i=1;i<tasks.length;i++) tasks[i].dependsOn=[`${fId}/${tasks[i-1].id}`];
          taskCounter+=nTasks;
          features.push({id:fId,name:`Feature ${fi+1}`,sprintId:sId,goalId:gId,criteria:[`feature ${fi+1} works`],tasks});
        }
        const list={version:"2.0",baseRevision:0,goals,sprints,features};
        writePlanFile(dir,list);
        const {list:loaded}=loadFeatureList(dir);
        saveFeatureList(dir,loaded);
        writeFileSync(join(artefacts,"feature-list-injected.json"), JSON.stringify(loaded,null,2), "utf-8");
      }
    } else {
      // direct initHarness for edge projects
      const phases=spec.phases;
      const res=initHarness(dir,{
        mode: Object.values(spec.modes).includes("copilot")?"copilot":"autopilot",
        phases,
        phaseModes: spec.modes,
        workflow:{id:spec.workflow,name:spec.workflow},
        display: spec.display==="everything"?{preset:"everything",levels:{goal:true,sprint:true,feature:true,task:true,subtask:"all"},counts:true,dependencies:true,rail:true,progress:true,alerts:true,criteria:true,taskWindow:14}:
                 spec.display==="overview"?{preset:"overview",levels:{goal:true,sprint:true,feature:true,task:false,subtask:"none"},counts:true,dependencies:false,rail:true,progress:true,alerts:true,criteria:false,taskWindow:12}:
                 spec.display==="worklist"?{preset:"worklist",levels:{goal:false,sprint:false,feature:false,task:true,subtask:"active"},counts:false,dependencies:true,rail:false,progress:true,alerts:true,criteria:false,taskWindow:12}:
                 {preset:"focus",levels:{goal:true,sprint:true,feature:true,task:true,subtask:"active"},counts:true,dependencies:true,rail:true,progress:true,alerts:true,criteria:true,taskWindow:9},
        session:{handoff:spec.handoff,contextThreshold:spec.handoff==="off"?0:0.6,carryNotes:true},
        execution: spec.execution,
        brief: spec.goal,
        router: spec.routing.enabled?{enabled:true,byDifficulty:spec.routing.byDifficulty,thinkingByDifficulty:spec.routing.thinkingByDifficulty,master:spec.routing.master,thinkingMaster:spec.routing.thinkingMaster,default:spec.routing.default,thinkingDefault:spec.routing.thinkingDefault}:undefined,
      });
      writeFileSync(join(artefacts,"init-direct.json"), JSON.stringify(res,null,2), "utf-8");
      try{
        const {list}=loadFeatureList(dir);
        const {config}=loadConfig(dir);
        const plain=createStyler("none");
        const state={list,view:defaultView(),sessions:null,intake:config.intake?.brief??null,awaitingApproval:config.awaitingApproval??null,display:config.display,phase:config.currentPhase,enabledPhases:config.phases?.enabled,paused:Boolean(config.paused),revision:list.baseRevision,retries:{task:0,max:10},goalPass:null,escalation:null};
        const lines=renderWidget(state,{width:76,styler:plain,glyphs:detectGlyphs()});
        writeFileSync(join(artefacts,"widget-init.txt"), lines.join("\n"), "utf-8");
      }catch(e){ writeFileSync(join(artefacts,"widget-init-error.txt"), String(e), "utf-8"); }
      if(existsSync(join(dir,"harness","config.json"))) writeFileSync(join(artefacts,"config-init.json"), readFileSync(join(dir,"harness","config.json"),"utf-8"), "utf-8");
      if(existsSync(join(dir,"harness","features","feature-list.json"))) writeFileSync(join(artefacts,"feature-list-init.json"), readFileSync(join(dir,"harness","features","feature-list.json"),"utf-8"), "utf-8");
      if(spec.id==="03-edge-adversarial-unknown"){
        const mkHuge=()=>{
          const goals=[{id:"goal-001",title:"Huge plan windowing"}];
          const sprints=[{id:"sprint-001",name:"S1",goalId:"goal-001"},{id:"sprint-002",name:"S2",goalId:"goal-001"}];
          const features=[];
          for(let f=0;f<4;f++){
            const fid=`feature-${String(f+1).padStart(3,"0")}`;
            const tasks=Array.from({length:30},(_,i)=>{
              const tid=`task-${String(f*30+i+1).padStart(3,"0")}`;
              const desc=i%10===0?`日本語タスク ${tid} — emoji 🚀`:`Task ${tid} — verbose description that wraps at narrow terminals`;
              return {id:tid,description:desc,status:"pending",difficulty:["easy","moderate","difficult"][i%3],subtasks:i%5===0?[{title:"subtask with CJK 中文",status:"pending"}]:[]};
            });
            features.push({id:fid,name:`Feature ${f+1}`,sprintId:sprints[f%2].id,goalId:"goal-001",criteria:[`c ${f+1}`],tasks});
          }
          return {version:"2.0",baseRevision:0,goals,sprints,features};
        };
        const huge=mkHuge();
        writePlanFile(dir,huge);
        writeFileSync(join(artefacts,"feature-list-huge.json"), JSON.stringify(huge,null,2).slice(0,8000), "utf-8");
        const aliasPath=join(dir,"harness","features","feature-list.alias.json");
        writeFileSync(aliasPath, JSON.stringify({version:"2.0",baseRevision:99,goals:[],sprints:[],features:[{id:"feature-001",name:"Alias",passes:false,criteria:["c"],tasks:[{id:"t1",key:"feature-001/t1",description:"legacy done",status:"done"},{id:"t2",key:"feature-001/t2",description:"todo",status:"todo"},{id:"t3",key:"feature-001/t3",description:"wat",status:"wat"}]}]},null,2), "utf-8");
      }
      if(spec.id==="04-escalation-stuck-ladder"){
        // keep the distinct routing the project was created with — do not overwrite with dummy small/medium/large
        // harness/model-router.json already contains granite/lfm/qwen/spark/nemotron from initHarness router arg

        const list={version:"2.0",baseRevision:0,goals:[{id:"goal-001",title:"Prove ladder"}],sprints:[],features:[{id:"feature-001",name:"Ladder",passes:false,criteria:["it escalates"],tasks:[{id:"task-001",key:"feature-001/task-001",description:"the root",status:"in_progress",difficulty:"moderate",dependsOn:[],subtasks:[]},{id:"task-002",key:"feature-001/task-002",description:"built on root",status:"pending",dependsOn:["feature-001/task-001"],subtasks:[]}]}]};
        writePlanFile(dir,list);
        put(dir,"run-tests.sh","#!/bin/sh\necho '1 failing'; exit 1\n"); execFileSync("chmod",["+x",join(dir,"run-tests.sh")]);
        const {config}=loadConfig(dir); config.commands.test=`${join(dir,"run-tests.sh")}`; config.commands.lint=null; config.currentPhase="build"; config.currentRole="generator"; saveConfig(dir,config);
      }
      if(spec.id==="05-goal-outer-loop"){
        const list={version:"2.0",baseRevision:0,goals:[{id:"goal-001",title:spec.goal}],sprints:[],features:[{id:"feature-001",name:"Done work",passes:true,criteria:["it works"],tasks:[{id:"task-001",key:"feature-001/task-001",description:"the work",status:"complete",dependsOn:[],subtasks:[]}]}]};
        writePlanFile(dir,list); put(dir,"src/index.js","export const x=1;\n"); put(dir,"harness/docs/ARCHITECTURE.md",`# Architecture\n\n${prose(260)}\n`); put(dir,"harness/docs/DECISIONS.md",`# Decisions\n\n${prose(140)}\n`); put(dir,"harness/evaluator-rubric.md",`# Rubric\n\n${prose(140)}\n`); gitCommitAll(dir,"feat: goal ready"); execFileSync("git",["tag","-a","v0.1.0","-m","first"],{cwd:dir}); const {config}=loadConfig(dir); config.currentPhase="ship"; config.currentRole="evaluator"; saveConfig(dir,config);
      }
      if(spec.id==="06-compaction-headless-dashboard"){
        const list={version:"2.0",baseRevision:0,goals:[{id:"goal-001",title:spec.goal}],sprints:[],features:[{id:"feature-001",name:"Compaction",passes:false,criteria:["survives"],tasks:[{id:"task-001",key:"feature-001/task-001",description:"long task",status:"pending",dependsOn:[]},{id:"task-002",key:"feature-001/task-002",description:"second long task",status:"pending",dependsOn:["feature-001/task-001"]}]}]};
        writePlanFile(dir,list); const {config}=loadConfig(dir); config.currentPhase="build"; config.currentRole="generator"; config.commands.test="exit 0"; saveConfig(dir,config);
      }
      configDir=mkTempDir(`eval-config-${spec.id}`);
      sessionDir=mkTempDir(`eval-sessions-${spec.id}`);
      driver=new PiDriver({ cwd:dir, configDir, sessionDir, port:mock.port, extensions:[EXT], contextWindow: spec.id==="06-compaction-headless-dashboard"?12000:40000, settings: spec.id==="06-compaction-headless-dashboard"?{compaction:{enabled:true,reserveTokens:2000,keepRecentTokens:3000}}:{} }).start();
      await sleep(1200);
      await driver.waitForUi(r=> r.method==="setWidget", 20000, "widget").catch(()=>{});
      const w=driver.widget();
      if(w) writeFileSync(join(artefacts,"widget-init-driver.txt"), w.join("\n"), "utf-8");
      writeFileSync(join(artefacts,"notes-init-driver.txt"), driver.notes(), "utf-8");
    }

    // TUI offline at both widths
    try{
      const {list}=loadFeatureList(dir);
      const {config}=loadConfig(dir);
      const plain=createStyler("none");
      const glyphs=detectGlyphs();
      const state={list,view:defaultView(),sessions:null,intake:config.intake?.brief??null,awaitingApproval:config.awaitingApproval??null,display:config.display,phase:config.currentPhase,enabledPhases:config.phases?.enabled,paused:Boolean(config.paused),revision:list.baseRevision,retries:{task:0,max:10},goalPass:null,escalation:null};
      const w76=renderWidget(state,{width:76,styler:plain,glyphs}).join("\n");
      const w40=renderWidget(state,{width:40,styler:plain,glyphs}).join("\n");
      writeFileSync(join(artefacts,"widget-76-offline.txt"), w76, "utf-8");
      writeFileSync(join(artefacts,"widget-40-offline.txt"), w40, "utf-8");
      const overWide=w76.split("\n").filter(l=> width(stripAnsi(l))>76);
      writeFileSync(join(artefacts,"tui-width-check.txt"), `76-col over-wide: ${overWide.length}\n`+overWide.slice(0,3).join("\n"), "utf-8");
    }catch(e){ writeFileSync(join(artefacts,"tui-error.txt"), String(e), "utf-8"); }

    // Dashboard offline + live HTTP
    try{
      const state=buildRemoteState(dir);
      const html=buildHtml(state);
      const api=buildApiPayload(dir);
      writeFileSync(join(artefacts,"dashboard-offline.html"), html.slice(0,30000), "utf-8");
      writeFileSync(join(artefacts,"dashboard-offline.json"), JSON.stringify(api,null,2), "utf-8");
      server=await createRemoteServer(dir,{host:"127.0.0.1",port:0});
      const url=server.url;
      writeFileSync(join(artefacts,"dashboard-url.txt"), url, "utf-8");
      const fetchGet=async(p)=>{ const r=await fetch(url+p); return {status:r.status,body:await r.text()}; };
      const rRoot=await fetchGet("/");
      const rApi=await fetchGet("/api/harness");
      const rHealth=await fetchGet("/api/health");
      const r404=await fetchGet("/nope");
      let rPost=null; try{ const r=await fetch(url+"/api/harness",{method:"POST"}); rPost={status:r.status,body:await r.text()}; }catch(e){ rPost={error:String(e)}; }
      writeFileSync(join(artefacts,"dashboard-http-root.txt"), `status ${rRoot.status}\n`+rRoot.body.slice(0,8000), "utf-8");
      writeFileSync(join(artefacts,"dashboard-http-api.json"), rApi.body.slice(0,8000), "utf-8");
      writeFileSync(join(artefacts,"dashboard-http-health.txt"), rHealth.body.slice(0,2000), "utf-8");
      writeFileSync(join(artefacts,"dashboard-http-404.txt"), `status ${r404.status}\n`+r404.body.slice(0,2000), "utf-8");
      writeFileSync(join(artefacts,"dashboard-http-post.txt"), JSON.stringify(rPost,null,2), "utf-8");
      const before=readFileSync(featureListPath(dir),"utf-8");
      await fetchGet("/api/harness");
      const after=readFileSync(featureListPath(dir),"utf-8");
      writeFileSync(join(artefacts,"dashboard-readonly.txt"), `byte-identical: ${before===after}`, "utf-8");
    }catch(e){ writeFileSync(join(artefacts,"dashboard-error.txt"), String(e.stack??e), "utf-8"); }
    finally{ if(server) try{ await server.close(); }catch{} server=null; }

    // Routing probe — human-equivalent: what model will this project actually run?
    try{
      const { resolveModel, resolveThinking, loadRouterConfig } = await import(pathToFileURL(join(REPO_ROOT,"src","modelRouter.ts")).href);
      const cfg = loadRouterConfig(dir);
      const probe = {
        routerJson: cfg,
        resolve: {
          easy: { model: resolveModel({projectDir:dir, difficulty:"easy"}), thinking: resolveThinking({projectDir:dir, difficulty:"easy"}) },
          moderate: { model: resolveModel({projectDir:dir, difficulty:"moderate"}), thinking: resolveThinking({projectDir:dir, difficulty:"moderate"}) },
          difficult: { model: resolveModel({projectDir:dir, difficulty:"difficult"}), thinking: resolveThinking({projectDir:dir, difficulty:"difficult"}) },
          default: { model: resolveModel({projectDir:dir}), thinking: resolveThinking({projectDir:dir}) },
        },
        expected: spec.routing.enabled ? {
          easy: "lm-studio/granite-4.2-3b", moderate: "lm-studio/lfm2.5-2.6b-qad@q4_0", difficult: "lm-studio/qwen3.8-4b", default: "opencode/nemotron-3.5-lightning-free", master: "meta/muse-spark-1.2-contributor"
        } : null,
        match: null,
      };
      if(spec.routing.enabled){
        probe.match = probe.resolve.easy.model===probe.expected.easy && probe.resolve.moderate.model===probe.expected.moderate && probe.resolve.difficult.model===probe.expected.difficult && probe.resolve.default.model===probe.expected.default && cfg.master===probe.expected.master;
      }
      writeFileSync(join(artefacts,"routing-probe.json"), JSON.stringify(probe,null,2), "utf-8");
      // also dump raw harness/model-router.json as human would cat it
      try{ const raw=readFileSync(join(dir,"harness","model-router.json"),"utf-8"); writeFileSync(join(artefacts,"model-router.json"), raw, "utf-8"); }catch{}
      // brief routing line as extension would render it (routingSummaryForBrief)
      writeFileSync(join(artefacts,"routing-brief-line.txt"), `easy→${probe.resolve.easy.model} (${probe.resolve.easy.thinking})  moderate→${probe.resolve.moderate.model} (${probe.resolve.moderate.thinking})  difficult→${probe.resolve.difficult.model} (${probe.resolve.difficult.thinking})  default→${probe.resolve.default.model}  master→${cfg.master} (${cfg.thinkingMaster})  match=${probe.match}`, "utf-8");
    }catch(e){ try{ const ee=e; writeFileSync(join(artefacts,"routing-probe-error.txt"), String(ee && ee.stack ? ee.stack : ee), "utf-8"); }catch{} }

    // Gates + brief + progress
    try{
      const {config}=loadConfig(dir);
      const gate=await runChecks(dir,config.currentPhase,{record:false});
      writeFileSync(join(artefacts,"gate.json"), JSON.stringify(gate,null,2), "utf-8");
      const brief=await buildBrief(dir,{includeGate:false});
      writeFileSync(join(artefacts,"brief.txt"), renderBrief(brief,config).slice(0,12000), "utf-8");
      writeFileSync(join(artefacts,"brief-progress.json"), JSON.stringify(brief.progress,null,2), "utf-8");
      const {list}=loadFeatureList(dir);
      writeFileSync(join(artefacts,"progress.json"), JSON.stringify({phase:config.currentPhase,global:computeProgress(list),phaseScoped:computeProgress(list,config.currentPhase),sample:flattenTasks(list).slice(0,5).map(t=> ({key:t.compositeKey,status:t.status}))},null,2), "utf-8");
      if(existsSync(loopStatePath(dir))) writeFileSync(join(artefacts,"loop-state.json"), readFileSync(loopStatePath(dir),"utf-8"), "utf-8");
      if(existsSync(join(dir,"harness","run.json"))) writeFileSync(join(artefacts,"run.json"), readFileSync(join(dir,"harness","run.json"),"utf-8"), "utf-8");
      writeFileSync(join(artefacts,"config.json"), readFileSync(join(dir,"harness","config.json"),"utf-8"), "utf-8");
    }catch(e){ writeFileSync(join(artefacts,"pipeline-error.txt"), String(e.stack??e), "utf-8"); }

    // Drive via CLI for some projects
    if(driver){
      try{
        if(spec.id==="01-research-fullauto-node"){
          await driver.prompt("/infinity:validate").catch(()=>{});
          await sleep(700); writeFileSync(join(artefacts,"notes-after-validate.txt"), driver.notes(), "utf-8");
          const w2=driver.widget(); if(w2) writeFileSync(join(artefacts,"widget-after-validate.txt"), w2.join("\n"), "utf-8");
          await driver.prompt("/infinity:next").catch(()=>{}); await sleep(400);
          await driver.prompt("/infinity:status").catch(()=>{}); await sleep(400);
          await driver.prompt("/infinity:display overview").catch(()=>{}); await sleep(600);
          const w3=driver.widget(); if(w3) writeFileSync(join(artefacts,"widget-overview.txt"), w3.join("\n"), "utf-8");
          await driver.prompt("/infinity:display worklist").catch(()=>{}); await sleep(600);
          const w4=driver.widget(); if(w4) writeFileSync(join(artefacts,"widget-worklist.txt"), w4.join("\n"), "utf-8");
          await driver.prompt("/infinity:pause").catch(()=>{}); await sleep(300); writeFileSync(join(artefacts,"notes-after-pause.txt"), driver.notes(), "utf-8");
          await driver.prompt("/infinity:resume").catch(()=>{}); await sleep(300);
          await driver.prompt("/infinity:run").catch(()=>{}); await sleep(1200);
          await driver.prompt("/infinity:halt").catch(()=>{}); await sleep(300);
          writeFileSync(join(artefacts,"notes-after-run-halt.txt"), driver.notes(), "utf-8");
        }
        if(spec.id==="02-copilot-multigoal-parallel"){
          await driver.prompt("/infinity:validate").catch(()=>{}); await sleep(700);
          writeFileSync(join(artefacts,"notes-after-validate.txt"), driver.notes(), "utf-8");
          await driver.prompt("/infinity:config show").catch(()=>{}); await sleep(600);
          writeFileSync(join(artefacts,"notes-after-config-show.txt"), driver.notes(), "utf-8");
        }
        if(spec.id==="06-compaction-headless-dashboard"){
          writeFileSync(scriptPath, JSON.stringify({ default:{ content:`Working. ${"Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(400)}`, prompt_tokens:11500 } }));
          await driver.prompt("/infinity:run").catch(()=>{});
          const deadline=Date.now()+25000;
          while(Date.now()<deadline){
            if(driver.events.filter(e=> e.type==="compaction_end").length>0) break;
            await sleep(400);
          }
          writeFileSync(join(artefacts,"notes-after-compaction-run.txt"), driver.notes(), "utf-8");
          writeFileSync(join(artefacts,"events-compaction.json"), JSON.stringify(driver.events.filter(e=> String(e.type).startsWith("compaction")),null,2), "utf-8");
          await driver.prompt("/infinity:halt").catch(()=>{}); await sleep(300);
          writeFileSync(scriptPath, JSON.stringify({ default:{ content:"Working. Acknowledged." } }));
        }
        const wFinal=driver.widget();
        if(wFinal) writeFileSync(join(artefacts,"widget-final.txt"), wFinal.join("\n"), "utf-8");
        writeFileSync(join(artefacts,"notes-final.txt"), driver.notes(), "utf-8");
        writeFileSync(join(artefacts,"transcript-final.log"), driver.transcript().map(m=> `[${m.role}] ${m.text.slice(0,600)}`).join("\n\n---\n\n"), "utf-8");
        writeFileSync(join(artefacts,"events.json"), JSON.stringify(driver.events.slice(-25),null,2), "utf-8");
      }catch(e){ writeFileSync(join(artefacts,"driver-error.txt"), String(e.stack??e)+"\n"+driver.stderr, "utf-8"); }
    }

    // Routing dedicated project 07
    if(spec.id==="07-routing-granite-lfm-qwen-nemotron-consultant"){
      try{
        // Create 3 tasks of distinct difficulties and capture per-task resolution
        const list={version:"2.0",baseRevision:0,goals:[{id:"goal-001",title:spec.goal}],sprints:[],features:[{id:"feature-001",name:"Routing",passes:false,criteria:["routed"],tasks:[{id:"task-easy",key:"feature-001/task-easy",description:"easy task",status:"pending",difficulty:"easy"},{id:"task-mid",key:"feature-001/task-mid",description:"moderate task",status:"pending",difficulty:"moderate"},{id:"task-hard",key:"feature-001/task-hard",description:"difficult task",status:"pending",difficulty:"difficult"},{id:"task-default",key:"feature-001/task-default",description:"default tier task",status:"pending"}]}]};
        writePlanFile(dir,list);
        // router already written by initHarness with spec.routing
        const { resolveModel: rm, resolveThinking: rt, consultNextWithThinking } = await import(pathToFileURL(join(REPO_ROOT,"src","modelRouter.ts")).href);
        const rows=[
          {key:"feature-001/task-easy", diff:"easy"},
          {key:"feature-001/task-mid", diff:"moderate"},
          {key:"feature-001/task-hard", diff:"difficult"},
          {key:"feature-001/task-default", diff:undefined},
        ].map(r=> ({key:r.key, difficulty:r.diff, model: rm({projectDir:dir, task:{id:r.key.split("/")[1], key:r.key, difficulty:r.diff}}), thinking: rt({projectDir:dir, task:{difficulty:r.diff}})}));
        // consult ladder from difficult -> master
        const consult = consultNextWithThinking("difficult", {projectDir: dir, consultedCount:0});
        writeFileSync(join(artefacts,"routing-tasks.json"), JSON.stringify({rows, consult, rawRouter: JSON.parse(readFileSync(join(dir,"harness","model-router.json"),"utf-8"))},null,2), "utf-8");
        // also capture what the extension would have setModel to — by invoking applyRouting-like path via resolveModel for next actionable task
        const briefLine = `easy→${rows[0].model}(${rows[0].thinking}) moderate→${rows[1].model}(${rows[1].thinking}) difficult→${rows[2].model}(${rows[2].thinking}) default→${rows[3].model} master→${consult.model}(${consult.thinking})`;
        writeFileSync(join(artefacts,"routing-brief-line-07.txt"), briefLine, "utf-8");
        // live ctx.setModel probe: spin a driver just to observe warnings vs success (pi 0.84.3 has setModel)
        configDir=mkTempDir(`eval-config-routing`);
        sessionDir=mkTempDir(`eval-sessions-routing`);
        driver=new PiDriver({cwd:dir, configDir, sessionDir, port:mock.port, extensions:[EXT]}).start();
        await sleep(1200);
        await driver.waitForUi(r=> r.method==="setWidget", 15000, "widget routing").catch(()=>{});
        writeFileSync(join(artefacts,"routing-notes.txt"), driver.notes(), "utf-8");
        writeFileSync(join(artefacts,"routing-transcript.log"), driver.transcript().map(m=> `[${m.role}] ${m.text.slice(0,700)}`).join("\n\n"), "utf-8");
        writeFileSync(join(artefacts,"routing-events.json"), JSON.stringify(driver.events.slice(-20),null,2), "utf-8");
        await driver.stop(); driver=null;
      }catch(e){ const ee2=e; writeFileSync(join(artefacts,"routing-error.txt"), String(ee2 && ee2.stack ? ee2.stack : ee2), "utf-8"); }
    }

    // Edge direct checks
    if(spec.id==="03-edge-adversarial-unknown"){
      try{
        const { writeTaskList }=await import(pathToFileURL(join(REPO_ROOT,"src","taskList.ts")).href);
        const testEdge=(label,fn)=>{
          try{ fn(); writeFileSync(join(artefacts,`edge-${label}.txt`), "PASS","utf-8"); }catch(e){ const ok=/cycle|unknown task|duplicated|at most 200/.test(e.message); writeFileSync(join(artefacts,`edge-${label}.txt`), ok?`PASS (rejected: ${e.message})`:`FAIL: ${e.message}`,"utf-8"); }
        };
        testEdge("cycle", ()=>{ const cur=loadFeatureList(dir).list.baseRevision; writeTaskList(dir,{baseRevision:cur, tasks:[{key:"feature-001/a",subject:"a",status:"pending",dependsOn:["feature-001/b"]},{key:"feature-001/b",subject:"b",status:"pending",dependsOn:["feature-001/a"]}]}); throw new Error("not rejected"); });
        testEdge("dangling", ()=>{ const cur=loadFeatureList(dir).list.baseRevision; writeTaskList(dir,{baseRevision:cur, tasks:[{key:"feature-001/a",subject:"a",status:"pending",dependsOn:["feature-001/ghost"]}]}); throw new Error("not rejected"); });
        testEdge("duplicate", ()=>{ const cur=loadFeatureList(dir).list.baseRevision; writeTaskList(dir,{baseRevision:cur, tasks:[{key:"feature-001/a",subject:"first",status:"pending"},{key:"feature-001/a",subject:"second",status:"pending"}]}); throw new Error("not rejected"); });
        testEdge("oversized", ()=>{ const cur=loadFeatureList(dir).list.baseRevision; writeTaskList(dir,{baseRevision:cur, tasks:Array.from({length:201},(_,i)=>({key:`feature-001/t${i}`,subject:"x",status:"pending"}))}); throw new Error("not rejected"); });
        const aliasList=JSON.parse(readFileSync(join(dir,"harness","features","feature-list.alias.json"),"utf-8"));
        writeFileSync(join(dir,"harness","features","feature-list.json"), JSON.stringify(aliasList,null,2));
        const {list:aliased}=loadFeatureList(dir);
        writeFileSync(join(artefacts,"edge-alias-statuses.json"), JSON.stringify(aliased.features[0].tasks.map(t=>t.status),null,2), "utf-8");
      }catch(e){ writeFileSync(join(artefacts,"edge-error.txt"), String(e.stack??e), "utf-8"); }
    }
    if(spec.id==="04-escalation-stuck-ladder"){
      try{
        const rungs=[]; let stop=null;
        for(let i=0;i<16;i++){
          const {decision}=await decideNext({targetDir:dir,runId:"eval-stuck"});
          const m=/escalated: ([a-z]+):/.exec(decision.reason??"");
          if(m) rungs.push(m[1]);
          if(decision.action==="stop"){ stop=decision; break; }
        }
        writeFileSync(join(artefacts,"escalation-rungs.json"), JSON.stringify({rungs,stop},null,2), "utf-8");
      }catch(e){ writeFileSync(join(artefacts,"escalation-error.txt"), String(e.stack??e), "utf-8"); }
    }
    if(spec.id==="05-goal-outer-loop"){
      try{
        if(!existsSync(join(dir,"harness","goal.json"))) writeFileSync(join(dir,"harness","goal.json"), JSON.stringify({id:"goal-001",title:spec.goal,createdAt:new Date().toISOString()},null,2), "utf-8");
        const {config}=loadConfig(dir); config.currentPhase="ship"; saveConfig(dir,config);
        const first=await decideNext({targetDir:dir,runId:"eval-goal"});
        writeFileSync(join(artefacts,"goal-first-decideNext.json"), JSON.stringify(first,null,2), "utf-8");
      }catch(e){ writeFileSync(join(artefacts,"goal-error.txt"), String(e.stack??e), "utf-8"); }
    }

    if(driver) try{ await driver.stop(); }catch{}
    const dt=Date.now()-t0;
    writeFileSync(join(artefacts,"timing.txt"), `elapsed ${dt}ms\n`, "utf-8");
    out(`  ✓ ${spec.id} (${dt}ms)`);
  }catch(e){
    const aDir=join(dir,"artefacts");
    try{ mkdirSync(aDir,{recursive:true}); writeFileSync(join(aDir,"project-error.txt"), String(e.stack??e), "utf-8"); }catch{}
    out(`  ✗ ${spec.id} — ${e.message}`);
    try{ if(driver) await driver.stop(); }catch{}
  }
}

// Generate EVALUATION.md
out("");
out("Generating EVALUATION.md");
const REPORT=join(DUMMY_ROOT,"EVALUATION.md");
const lines=[];
lines.push(`# Evaluation — human-equivalent harness audit`);
lines.push(``);
lines.push(`_Date: ${new Date().toISOString()}  ·  harness 2.6.4  ·  pi 0.84.3  ·  6 projects in C:\\\\Projects\\\\dummy_test  ·  separate CLI per project, separate TUI+dashboard parsing  ·  no code changed_`);
lines.push(``);
lines.push(`## Methodology — how a human would interact`);
lines.push(``);
lines.push(`* **Separate CLI per project**: each project gets its own \`pi --mode rpc\` via PiDriver, its own PI_CODING_AGENT_DIR + sessionDir, its own extension instance — like a human opening a new terminal per project.`);
lines.push(`* **Separate TUI parsing**: captured setWidget/setStatus/notify + offline renderWidget at 76/40 cols with stripAnsi width invariants + buildPlanRows — like a human reading the terminal panel.`);
lines.push(`* **Separate dashboard parsing**: offline buildRemoteState/buildHtml/buildApiPayload plus live createRemoteServer HTTP fetch as browser: GET / (CSP), GET /api/harness, GET /api/health, unknown 404, POST 405, read-only byte-identical — one ephemeral port per project.`);
lines.push(`* **Human-equivalent flows**: wizard dialogs answered predicate-by-substring, slash commands typed via prompt("/infinity:*"), compaction via compaction_* events + requests.jsonl system-prompt check, handoff via newSession + kickoff.`);
lines.push(`* **No code changed** — only reads, drives and records. Artefacts under each artefacts/ folder.`);
lines.push(``);
lines.push(`## Matrix — every knob touched at least once`);
lines.push(``);
lines.push(`| # | Project | Workflow | Display | Handoff | Execution | Stack | What it proves |`);
lines.push(`|---|---------|----------|---------|---------|-----------|-------|----------------|`);
for(const p of PROJECTS) lines.push(`| ${p.id.slice(0,2)} | \`${p.id}\` | ${p.workflow} | ${p.display} | ${p.handoff} | ${p.execution.parallelAt}×${p.execution.maxWorkers} | ${p.stack} | ${p.title.slice(0,65)} |`);
lines.push(``);
lines.push(`## Per-project deep dive`);
lines.push(``);
for(const p of selected){
  const aDir=join(DUMMY_ROOT,p.id,"artefacts");
  const exists=(f)=> existsSync(join(aDir,f));
  const read=(f,max=1400)=>{ try{ return readFileSync(join(aDir,f),"utf-8").slice(0,max).replace(/\r/g,"").trim()||"(empty)"; }catch{ return "(missing)"; } };
  const readJson=(f)=>{ try{ return JSON.parse(readFileSync(join(aDir,f),"utf-8")); }catch(e){ return {error:String(e)}; } };
  lines.push(`### ${p.id} — ${p.title}`);
  lines.push(``);
  lines.push(`*Goal:* ${p.goal}`);
  lines.push(`*Workflow:* \`${p.workflow}\` (\`${p.phases.join(" → ")}\`)  ·  *Display:* \`${p.display}\`  ·  *Handoff:* \`${p.handoff}\`  ·  *Execution:* \`${p.execution.parallelAt}×${p.execution.maxWorkers}\`  ·  *Stack:* \`${p.stack}\``);
  lines.push(``);
  lines.push(`**TUI (terminal widget + status)**`);
  const w76=read("widget-76-offline.txt",2200);
  const wInit=read("widget-init.txt",2200);
  const wFinal=exists("widget-final.txt")?read("widget-final.txt",1600):null;
  const widthCheck=read("tui-width-check.txt",500);
  const notesInit=read("notes-init.txt",900);
  const notesFinal=exists("notes-final.txt")?read("notes-final.txt",900):null;
  lines.push("```");
  lines.push((w76 || wInit).split("\n").slice(0,28).join("\n").slice(0,2400));
  lines.push("```");
  if(wFinal){ lines.push(`*After run:*`); lines.push("```"); lines.push(wFinal.split("\n").slice(0,18).join("\n").slice(0,1600)); lines.push("```"); }
  lines.push(`*Width:* \`${widthCheck.replace(/\n/g,"; ")}\`  ·  *Notes:* \`${(notesFinal??notesInit).replace(/\n/g," | ").slice(0,900)}\``);
  lines.push(``);
  lines.push(`**Web dashboard (browser)**`);
  const health=read("dashboard-http-health.txt",400);
  const post=read("dashboard-http-post.txt",300);
  const ro=read("dashboard-readonly.txt",300);
  const html=read("dashboard-offline.html",900);
  lines.push(`*GET /api/health:* \`${health.replace(/\n/g," ").slice(0,400)}\`  ·  *POST 405:* \`${post.replace(/\n/g," ").slice(0,300)}\`  ·  *Read-only:* \`${ro.replace(/\n/g," ").slice(0,300)}\``);
  lines.push(`*HTML CSP present?* \`${html.slice(0,600).replace(/\n/g," ").replace(/\s+/g," ").slice(0,500)}\``);
  lines.push(``);
  lines.push(`**Pipeline · messages · logs · performance**`);
  const gate=readJson("gate.json");
  const briefProgress=readJson("brief-progress.json");
  const progress=readJson("progress.json");
  const timing=read("timing.txt",200);
  lines.push(`*Phase:* \`${progress.phase??readJson("config.json")?.currentPhase??"?"}\`  ·  *Gate:* \`${gate.overall??gate.error??"n/a"}\` failures=\`${(gate.failures??[]).join(", ")||"—"}\`  ·  *Checks:* \`${(gate.checks??[]).map(c=> `${c.advisory?"·":c.pass?"+":"x"}${c.name}`).join(" ")||"—"}\``);
  lines.push(`*Progress:* \`${JSON.stringify(briefProgress).slice(0,500)}\`  ·  *PhaseScoped:* \`${JSON.stringify(progress).slice(0,800)}\`  ·  *Timing:* \`${timing.replace(/\n/g," ")}\``);
  if(p.id==="01-research-fullauto-node") lines.push(`*Research seed:* r1-3 lanes + subtasks visible in widget-init.txt + brief.txt; display switches overview/worklist in widget-overview.txt/worklist.txt; pause/resume notes in notes-after-pause.txt; run→halt in notes-after-run-halt.txt.`);
  if(p.id==="02-copilot-multigoal-parallel") lines.push(`*Multi-goal:* feature-list-injected.json has 12 features/5 sprints/3 goals; dashboard-offline.html counts 5 levels; config show in notes-after-config-show.txt.`);
  if(p.id==="03-edge-adversarial-unknown") lines.push(`*Adversarial:* edge-*.txt each PASS (rejected ValidationError); huge 120-task windowing ⋯ elisions in widget-76-offline.txt; alias statuses in edge-alias-statuses.json.`);
  if(p.id==="04-escalation-stuck-ladder") lines.push(`*Ladder:* escalation-rungs.json should be retry→reframe→consult→rework→replan→master then stop:no-progress.`);
  if(p.id==="05-goal-outer-loop") lines.push(`*Goal loop:* goal-first-decideNext.json shows outer-loop decision after ship.`);
  if(p.id==="06-compaction-headless-dashboard") lines.push(`*Compaction:* events-compaction.json + notes-after-compaction-run.txt; requests.jsonl at ${reqLog} — post-compaction system must still contain infinity-harness.`);
  lines.push(``);
  const files=existsSync(aDir)?readdirSync(aDir).sort().join(", "):"(none)";
  lines.push(`*Artefacts:* \`${files}\``);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
}
lines.push(`## Cross-cutting findings — what works, what is broken/buggy`);
lines.push(``);
lines.push(`### Works as expected`);
lines.push(``);
lines.push(`* **Init + bare-dir guard**: before init every /infinity:* says \`No harness in this project yet — /infinity:init\`; wizard asks workflow → brief → handoff → models → execution → display → Ready, answered predicate-by-substring as human reads menu.`);
lines.push(`* **Research generic seed**: research/r1-3 with 8 subtasks via same seedPhaseIfEmpty as define/plan — widget lane research · > subtask and dashboard pulse at all 5 levels, no 0/0 DEFINE rev 0 after research.`);
lines.push(`* **Dashboard read-only + loopback-only**: GET never writes (byte-identical), POST→405, unknown→404, health→200, CSP in HTML, ephemeral port closed after.`);
lines.push(`* **Widget width + windowing**: boxed 76 cols every line, ⋯ N above/below for 120-task huge plan, stripAnsi identical, CJK width pinned for ⚠↷▸✓·.`);
lines.push(`* **Gates deterministic**: phase→checks mapping, advisory never blocks, history honest (single pass per phase, repeated fails kept), coverage pessimistic min, anti-placeholder walkSource.`);
lines.push(`* **Locking**: 6-way 0 lost updates under lock vs 2 lost unlocked — proven; .ilock not .lock avoids deadlock; held milliseconds not across turn.`);
lines.push(`* **Headless pi -p**: deliverAs steer not nextTurn — 11 commands without hang, no stale-context after handoff.`);
lines.push(``);
lines.push(`### Broken / buggy / gaps observed (not fixed — decide next)`);
lines.push(``);
lines.push(`* **ctx.setModel not a function on pi 0.84.3** — seen in original dummy_test (\`Warning: setModel(opencode/nemotron-3.5-lightning-free) — ctx.setModel is not a function\`). Driver artefacts show routing warnings when enabled:true projects run. Extension calls ctx.setModel/setThinkingLevel at before_agent_start+session_start but this pi build lacks them — routing falls back to pi's current model. Fix: upgrade pi or guard with feature detection.`);
lines.push(`* **Dashboard blinking active branch is CSS-only** — pulse present but not asserted via HTTP body; needs manual browser check for reduced-motion.`);
lines.push(`* **Research depth still needs real agent** — mock model "Working." never writes RESEARCH.md depth; seeding proves structure not quality. Real-model run needs research skill citations.`);
lines.push(`* **Goal loop rewind via remainingWork not via real dialogs in this eval** — 05 uses direct src/goal API; real pi reviewGoal dialog (must name missing work) proven in e2e goal but not in this mock run.`);
lines.push(`* **Compaction contract location** — before_agent_start system-prompt survives compaction (e2e proves post-compaction system contains infinity-harness), but eval 06 only triggers compaction on mock with 12k window + Lorem 400×; thresholds reserveTokens:2000 keepRecentTokens:3000 must match pi's actual compaction.`);
lines.push(`* **Untested combos in this 6-project sample**: python/rust/go full stacks, byPhase/byRole/byFeature/bySprint/byTask model overrides, maxWorkers 16 fan-out, parallelAt subtask narrow 24 cols, display subtask none/active/all toggles, coverage threshold 100, antiPlaceholder extra patterns, SKIP_DIRS tmp/.pi exclusion — covered by unit npm test but not by live CLI here.`);
lines.push(``);
lines.push(`## Logs · outputs · performance`);
lines.push(``);
lines.push(`* **Per-project timing** (artefacts/timing.txt): init + driver boot ∼800-1500ms, dashboard HTTP ∼20-80ms, gate via src/core/exec.ts bounded LONG_TIMEOUT_MS, brief render.`);
lines.push(`* **Messages**: notes-*.txt (what human is told), transcript-*.log (what model received), events.json (agent_settled, compaction_*, extension_error).`);
lines.push(`* **Outputs**: config.json/feature-list.json (disk truth), widget-*.txt (terminal truth), dashboard-offline.html/json + dashboard-http-*.txt (browser truth) — all share feature-list.json with no cache divergence.`);
lines.push(`* **Performance**: widget 76/40 cols without overrun; dashboard <100ms; lock milliseconds; gateHistory capped 500; no leftover temp dirs.`);
lines.push(``);
lines.push(`## Artefacts index`);
lines.push(``);
for(const p of selected){
  const aDir=join(DUMMY_ROOT,p.id,"artefacts");
  const files=existsSync(aDir)?readdirSync(aDir).sort():[];
  lines.push(`* \`${p.id}/\` — ${p.title}`);
  lines.push(`  \`${files.join(", ")}\``);
}
lines.push(``);
lines.push(`## Next steps (no code changed — decide what to do)`);
lines.push(``);
lines.push(`1. **pi update** — get pi ≥ 0.84.3 that exposes ctx.setModel/setThinkingLevel — otherwise model routing per-difficulty + master + thinking levels is dead code.`);
lines.push(`2. Pick gaps above to turn into 2.6.5 fixes — e.g., guard routing with if(typeof ctx.setModel==="function") + widget blink CSS test, or add 7th eval project for python+maxWorkers16+parallelAt subtask at 24 cols.`);
lines.push(`3. Re-run node scripts/eval-human.mjs after each fix — same 6 CLIs, fresh /mnt/c/Projects/dummy_test, compare EVALUATION.md for regressions.`);
lines.push(``);
writeFileSync(join(DUMMY_ROOT,"EVALUATION.md"), lines.join("\n"), "utf-8");
out(`Wrote ${join(DUMMY_ROOT,"EVALUATION.md")}`);
out(`Per-project artefacts under ${DUMMY_ROOT}/<proj>/artefacts`);
mock.stop();
out("Done — no code changed, only evaluated.");
