import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateImprovement, improvementSha256, type ImprovementHostPolicy, type ImprovementProposal } from '../src/improvementReview.js';

const original = 'export function limit(value: number) {\n  return Math.min(value, 10);\n}\n';
function diff(replacement: string, path = 'src/limit.ts') {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n export function limit(value: number) {\n-  return Math.min(value, 10);\n+  ${replacement}\n }\n`;
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'improvement-test-')); const source = join(root, 'source'), artifacts = join(root, 'artifacts');
  mkdirSync(join(source, 'src'), { recursive: true }); mkdirSync(artifacts); writeFileSync(join(source, 'src', 'limit.ts'), original);
  const evidence = [{ id: 'evidence:7', sha256: improvementSha256('trusted snapshot') }];
  const policy: ImprovementHostPolicy = { workspaceRoot: source, sourceRoot: source, artifactRoot: artifacts, revision: 'revision-1', allowedFiles: ['src/limit.ts'], evidence,
    checks: [{ id: 'limit-regression', run(files) {
      // Trusted fixture accepts only a small, inert expression grammar; it never evaluates proposed code.
      const match = /^export function limit\(value: number\) \{\n  return Math\.min\((?:value, (\d+)|(\d+), value)\);\n\}\n$/.exec(files['src/limit.ts']);
      const bound = match ? Number(match[1] ?? match[2]) : NaN;
      return { passed: Number.isFinite(bound) && Math.min(20, bound) === 10 && Math.min(3, bound) === 3, detail: 'limit stays at 10 and preserves smaller inputs' };
    } }] };
  const proposal: ImprovementProposal = { title: 'Clarify limit', rationale: 'Maintain bounded output', evidence, baseRevision: 'revision-1', baseFiles: { 'src/limit.ts': improvementSha256(original) }, sourceScope: ['src/limit.ts'], patch: diff('return Math.min(10, value);') };
  return { root, source, artifacts, policy, proposal };
}
test('isolated review runs host regression and preserves source and review artifacts', () => {
  const t = setup(); try {
    const valid = evaluateImprovement(t.proposal, t.policy);
    assert.equal(valid.status, 'review_required'); assert.equal(valid.checks[0].passed, true);
    assert.equal(readFileSync(join(t.source, 'src', 'limit.ts'), 'utf8'), original);
    assert.equal(JSON.parse(readFileSync(join(valid.artifactDir, 'review.json'), 'utf8')).result.finalApplication, 'requires_explicit_review');
    const broken = evaluateImprovement({ ...t.proposal, patch: diff('return Math.min(value, 100);') }, t.policy);
    assert.equal(broken.status, 'checks_failed'); assert.equal(broken.checks[0].passed, false);
    assert.match(readFileSync(join(broken.artifactDir, 'evaluation', 'src', 'limit.ts'), 'utf8'), /100/);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});
test('rejects stale, untrusted, out-of-scope, destructive and metadata patches', () => {
  const t = setup(); try {
    const variants: Partial<ImprovementProposal>[] = [
      { baseRevision: 'old' }, { baseFiles: { 'src/limit.ts': '0'.repeat(64) } },
      { evidence: [{ id: 'invented', sha256: '0'.repeat(64) }] },
      { patch: diff('return Math.min(value, 10);', '../escape.ts') },
      { patch: diff('return Math.min(value, 10);', '/absolute.ts') },
      { patch: diff('return Math.min(value, 10);', 'src/unknown.ts') },
      { patch: diff('return Math.min(value, 10);', 'src/policy.ts') },
      { patch: t.proposal.patch.replace('--- a/src/limit.ts', 'old mode 100644\nnew mode 100755\n--- a/src/limit.ts') },
      { patch: t.proposal.patch.replace('+++ b/src/limit.ts', '+++ /dev/null') },
      { patch: t.proposal.patch.replace('--- a/src/limit.ts', 'GIT binary patch\n--- a/src/limit.ts') },
      { patch: diff('return authority;') },
      { patch: t.proposal.patch + 'unexpected metadata\n' }
    ];
    for (const variant of variants) assert.equal(evaluateImprovement({ ...t.proposal, ...variant }, t.policy).status, 'rejected', JSON.stringify(variant));
    assert.throws(() => evaluateImprovement(t.proposal, { ...t.policy, artifactRoot: t.source }), /artifact_root_inside_workspace/);
    assert.equal(evaluateImprovement(t.proposal, { ...t.policy, checks: [] }).reason, 'invalid_host_checks');
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});
test('rejects symlinked source paths and failing trusted checks', (context) => {
  const t = setup(); try {
    const failed = evaluateImprovement(t.proposal, { ...t.policy, checks: [{ id: 'failure', run() { throw new Error('fail'); } }] });
    assert.equal(failed.status, 'checks_failed'); assert.equal(failed.checks[0].detail, 'trusted_check_threw');
    rmSync(join(t.source, 'src'), { recursive: true });
    const elsewhere = join(t.root, 'elsewhere'); mkdirSync(elsewhere); writeFileSync(join(elsewhere, 'limit.ts'), original);
    try { symlinkSync(elsewhere, join(t.source, 'src'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { context.diagnostic(`symlink/junction creation unavailable: ${String(error)}`); return; }
    assert.equal(evaluateImprovement(t.proposal, t.policy).reason, 'symlink_in_scope');
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});
