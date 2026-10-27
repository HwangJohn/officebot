import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** All policy, evidence snapshots and checks are supplied by the host, never by a proposal. */
export type ImprovementEvidence = { id: string; sha256: string };
export type ImprovementProposal = {
  title: string; rationale: string; evidence: ImprovementEvidence[];
  baseRevision: string; baseFiles: Record<string, string>; sourceScope: string[]; patch: string;
};
export type TrustedImprovementCheck = { id: string; run: (files: Readonly<Record<string, string>>) => { passed: boolean; detail: string } };
export type ImprovementHostPolicy = {
  workspaceRoot: string; sourceRoot: string; artifactRoot: string; revision: string;
  allowedFiles: string[]; evidence: ImprovementEvidence[]; checks: TrustedImprovementCheck[];
};
export type ImprovementReview = {
  status: 'rejected' | 'checks_failed' | 'review_required'; reason?: string;
  artifactDir: string; patchSha256: string; checks: { id: string; passed: boolean; detail: string }[];
  finalApplication: 'requires_explicit_review';
};

export function improvementSha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
const digest = /^[a-f0-9]{64}$/;
const forbiddenPath = /(^|\/)(?:\.git|\.github|\.env[^/]*|node_modules|package(?:-lock)?\.json|[^/]*(?:auth|permission|policy|deploy|config|secret|credential|workflow|server|core|db)[^/]*)(?:\/|$)/i;
const forbiddenChange = /\b(?:auth(?:entication|orization)?|authori[sz]ation|authority|permissions?|policy|policies|access|roles?|allowlist|allowedSources|scopes?|deploy(?:ment)?|config(?:uration)?|credentials?|secrets?|reviewer|api[_-]?key|process\.env|host|port|endpoint)\b/i;
function safePath(path: string) {
  return typeof path === 'string' && path.length < 240 && /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.ts$/.test(path) &&
    !path.split('/').some(part => part === '.' || part === '..') && !forbiddenPath.test(path);
}
function readSource(root: string, path: string): Buffer {
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('symlink_in_scope');
  }
  if (!lstatSync(current).isFile()) throw new Error('not_regular_file');
  const bytes = readFileSync(current);
  if (bytes.length > 1024 * 1024 || bytes.includes(0) || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) throw new Error('non_text_source');
  return bytes;
}

/** Parse the constrained unified diff grammar before passing it to git apply. */
function patchPaths(patch: string): string[] {
  if (typeof patch !== 'string' || patch.length > 256_000 || patch.includes('\0') || patch.includes('\r')) throw new Error('invalid_patch');
  const lines = patch.split('\n'); let i = 0; const paths: string[] = [];
  while (i < lines.length && lines[i] !== '') {
    const head = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(lines[i++] ?? '');
    if (!head || head[1] !== head[2] || !safePath(head[1]) || paths.includes(head[1])) throw new Error('invalid_diff_header');
    const path = head[1]; paths.push(path);
    if (/^index [a-f0-9]+\.\.[a-f0-9]+(?: 100644)?$/.test(lines[i] ?? '')) i++;
    if (lines[i++] !== `--- a/${path}` || lines[i++] !== `+++ b/${path}`) throw new Error('invalid_file_headers');
    let hunks = 0;
    while ((lines[i] ?? '').startsWith('@@ ')) {
      const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[i++] ?? '');
      if (!h) throw new Error('invalid_hunk');
      let old = Number(h[2] ?? 1), next = Number(h[4] ?? 1); hunks++;
      while (old > 0 || next > 0) {
        const line = lines[i++]; if (line === undefined) throw new Error('truncated_hunk');
        if (line.startsWith(' ')) { old--; next--; }
        else if (line.startsWith('-')) { old--; if (forbiddenChange.test(line.slice(1))) throw new Error('authority_change'); }
        else if (line.startsWith('+')) { next--; if (forbiddenChange.test(line.slice(1))) throw new Error('authority_change'); }
        else throw new Error('invalid_hunk_line');
        if (old < 0 || next < 0) throw new Error('invalid_hunk_length');
        if (lines[i] === '\\ No newline at end of file') i++;
      }
    }
    if (!hunks) throw new Error('missing_hunk');
  }
  if (!paths.length || lines.slice(i).some(line => line !== '')) throw new Error('unexpected_patch_metadata');
  return paths;
}

/** Returns a preserved bundle. No application, package install, or proposed command is performed. */
export function evaluateImprovement(proposal: ImprovementProposal, policy: ImprovementHostPolicy): ImprovementReview {
  const workspace = realpathSync(policy.workspaceRoot), source = realpathSync(policy.sourceRoot), artifacts = realpathSync(policy.artifactRoot);
  const isWithin = (parent: string, child: string) => { const rel = relative(parent, child); return !rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };
  if (!isWithin(workspace, source)) throw new Error('source_outside_workspace');
  if (isWithin(workspace, artifacts)) throw new Error('artifact_root_inside_workspace');
  const artifactDir = mkdtempSync(join(artifacts, 'improvement-'));
  const result: ImprovementReview = { status: 'rejected', artifactDir, patchSha256: improvementSha256(typeof proposal?.patch === 'string' ? proposal.patch : ''), checks: [], finalApplication: 'requires_explicit_review' };
  try {
    if (!proposal || typeof proposal.title !== 'string' || !proposal.title.trim() || proposal.title.length > 300 || typeof proposal.rationale !== 'string' || !proposal.rationale.trim() || proposal.rationale.length > 4000) throw new Error('invalid_proposal');
    if (!Array.isArray(proposal.evidence) || !proposal.evidence.length || proposal.evidence.length > 20 || proposal.evidence.some(e => !e || typeof e.id !== 'string' || !digest.test(e.sha256) || !policy.evidence.some(known => known.id === e.id && known.sha256 === e.sha256))) throw new Error('untrusted_evidence');
    if (!policy.revision || proposal.baseRevision !== policy.revision) throw new Error('stale_revision');
    if (!Array.isArray(proposal.sourceScope) || !proposal.sourceScope.length || proposal.sourceScope.length > 30 || new Set(proposal.sourceScope).size !== proposal.sourceScope.length || proposal.sourceScope.some(p => !safePath(p) || !policy.allowedFiles.includes(p))) throw new Error('invalid_scope');
    if (!proposal.baseFiles || Object.keys(proposal.baseFiles).length !== proposal.sourceScope.length || proposal.sourceScope.some(p => !digest.test(proposal.baseFiles[p] ?? ''))) throw new Error('invalid_base_hashes');
    if (!Array.isArray(policy.checks) || !policy.checks.length || new Set(policy.checks.map(c => c.id)).size !== policy.checks.length || policy.checks.some(c => !c.id || typeof c.run !== 'function')) throw new Error('invalid_host_checks');
    const paths = patchPaths(proposal.patch);
    if (paths.some(p => !proposal.sourceScope.includes(p))) throw new Error('path_outside_scope');
    const copy = join(artifactDir, 'evaluation'); mkdirSync(copy);
    for (const p of proposal.sourceScope) {
      const contents = readSource(source, p);
      if (improvementSha256(contents) !== proposal.baseFiles[p]) throw new Error('stale_source');
      const destination = resolve(copy, ...p.split('/')); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, contents, { flag: 'wx' });
    }
    writeFileSync(join(artifactDir, 'proposal.patch'), proposal.patch, 'utf8');
    const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CEILING_DIRECTORIES: artifactDir, GIT_TERMINAL_PROMPT: '0' };
    for (const args of [['apply', '--check', '--whitespace=nowarn', '-'], ['apply', '--whitespace=nowarn', '-']]) {
      const run = spawnSync('git', args, { cwd: copy, input: proposal.patch, encoding: 'utf8', env, timeout: 10_000, maxBuffer: 128_000, windowsHide: true });
      if (run.error || run.status !== 0) throw new Error('git_apply_failed');
    }
    const files: Record<string, string> = Object.create(null);
    for (const p of proposal.sourceScope) files[p] = readSource(copy, p).toString('utf8');
    Object.freeze(files);
    for (const check of policy.checks) {
      try { const outcome = check.run(files); result.checks.push({ id: check.id, passed: outcome?.passed === true, detail: String(outcome?.detail ?? '').slice(0, 2000) }); }
      catch { result.checks.push({ id: check.id, passed: false, detail: 'trusted_check_threw' }); }
    }
    result.status = result.checks.every(c => c.passed) ? 'review_required' : 'checks_failed';
  } catch (error) { result.reason = error instanceof Error ? error.message : 'evaluation_error'; }
  writeFileSync(join(artifactDir, 'review.json'), JSON.stringify({ proposal, result }, null, 2), 'utf8');
  return result;
}
