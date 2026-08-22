import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldBounceToRework } from "../src/review.ts";

function tmpProject(cfg: any): string {
  const d = mkdtempSync(join(tmpdir(), "pi-review-"));
  mkdirSync(join(d,"harness"),{recursive:true});
  writeFileSync(join(d,"harness/config.json"), JSON.stringify(cfg,null,2));
  return d;
}

{
  const proj = tmpProject({ review: { allowBackward: true, maxBounces: 2, bounceRequiresDelta: true } });
  try {
    let r = shouldBounceToRework({ projectDir: proj, fileDelta: true, bounceCount: 0 });
    assert.equal(r.shouldBounce, true, "fileDelta true -> bounce");
    r = shouldBounceToRework({ projectDir: proj, fileDelta: false, bounceCount: 0 });
    assert.equal(r.shouldBounce, false, "fileDelta false ignored when bounceRequiresDelta");
    assert.match(r.reason, /bounceRequiresDelta/);
    console.log("✓ bounceRequiresDelta fileDelta");
  } finally { rmSync(proj,{recursive:true,force:true}); }
}
{
  const proj = tmpProject({ review: { allowBackward: true, maxBounces: 2, bounceRequiresDelta: false } });
  try {
    const r = shouldBounceToRework({ projectDir: proj, fileDelta: false, bounceCount: 0 });
    assert.equal(r.shouldBounce, true, "bounceRequiresDelta false -> fileDelta false still bounces");
    console.log("✓ bounceRequiresDelta false ignores fileDelta");
  } finally { rmSync(proj,{recursive:true,force:true}); }
}
{
  const proj = tmpProject({ review: { allowBackward: true, maxBounces: 2, bounceRequiresDelta: true } });
  try {
    const r = shouldBounceToRework({ projectDir: proj, fileDelta: true, bounceCount: 2 });
    assert.equal(r.shouldBounce, false, "maxBounces guard");
    assert.match(r.reason, /maxBounces/);
    console.log("✓ maxBounces guard");
  } finally { rmSync(proj,{recursive:true,force:true}); }
}
{
  const proj = tmpProject({ review: { allowBackward: false, maxBounces: 2, bounceRequiresDelta: true } });
  try {
    const r = shouldBounceToRework({ projectDir: proj, fileDelta: true, bounceCount: 0 });
    assert.equal(r.shouldBounce, false);
    assert.match(r.reason, /allowBackward/);
    console.log("✓ allowBackward false");
  } finally { rmSync(proj,{recursive:true,force:true}); }
}
{
  // fresh-read: toggle config between calls
  const proj = tmpProject({ review: { allowBackward: true, maxBounces: 2, bounceRequiresDelta: true } });
  try {
    let r = shouldBounceToRework({ projectDir: proj, fileDelta: false, bounceCount: 0 });
    assert.equal(r.shouldBounce, false);
    writeFileSync(join(proj,"harness/config.json"), JSON.stringify({ review: { allowBackward: true, maxBounces: 2, bounceRequiresDelta: false } },null,2));
    r = shouldBounceToRework({ projectDir: proj, fileDelta: false, bounceCount: 0 });
    assert.equal(r.shouldBounce, true, "fresh-read toggle");
    console.log("✓ fresh-read toggle");
  } finally { rmSync(proj,{recursive:true,force:true}); }
}
console.log("All review tests PASS");
