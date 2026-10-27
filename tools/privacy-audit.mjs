import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import ignore from 'ignore';

// This heuristic supplements, but cannot replace, a review of the release and history.
const allowedRoots = new Set(['.github', '.env.example', '.gitignore', 'client', 'docs', 'public', 'scripts', 'src', 'test', 'tools', 'CONTRIBUTING.md', 'LICENSE', 'README.md', 'README.ko.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts']);
const prohibited = /(?:^|\/)(?:data|logs?|backups?|artifacts|screenshots|\.env(?:\..*)?|(?:credentials?|secrets?)(?:\.[^/]*)?)(?:\/|$)|\.(?:sqlite(?:-\w+)?|db(?:-\w+)?|log|pem|key|p12|pfx|dump|bak)$/i;
const checks = [
  ['API credential', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ['cloud credential', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['Discord credential', /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,}\b/g],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['local author path', /(?:\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"'<>]+[\\/]|\/(?:Users|home)\/[A-Za-z0-9._-]+\/)[^\s"'<>]+/gi],
  ['email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
  ['snowflake', /\b\d{17,22}\b/g]
];
const forbidden = file => (file !== '.env.example' && prohibited.test(file)) || file.split('/').some(part => ['node_modules', 'dist', '.git', 'coverage', 'test-results', '.playwright'].includes(part));
function safeEmail(value, file, line) {
  const domain = value.slice(value.lastIndexOf('@') + 1).toLowerCase();
  if (/(?:^|\.)(?:test|invalid)$/.test(domain) || /^(?:[^.]+\.)*example\.(?:com|org|net)$/.test(domain) || /^(?:users\.)?noreply\.github\.com$/.test(domain)) return true;
  return file === 'package-lock.json' && value.toLowerCase() === ['i', 'izs.me'].join('@') && /^\s*"deprecated"\s*:/.test(line);
}
function gitCommand(root, args) {
  const result = spawnSync('git', args, { cwd: root, windowsHide: true, maxBuffer: 50 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('git inspection failed');
  return result.stdout;
}
export function audit(root, git = gitCommand) {
  root = resolve(root);
  const findings = [];
  const report = (category, file, line) => findings.push(`${category}: ${file}${line ? `:${line}` : ''}`);
  const ignorePath = join(root, '.gitignore');
  if (existsSync(ignorePath) && lstatSync(ignorePath).isSymbolicLink()) return ['symbolic link: .gitignore'];
  const rules = ignore().add(existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '');
  function scan(file, bytes) {
    if (bytes.includes(0)) { report('binary file', file); return; }
    const lines = bytes.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) for (const [category, pattern] of checks) {
      pattern.lastIndex = 0;
      for (const match of lines[i].matchAll(pattern)) {
        if (category === 'snowflake' && /^100000000000000\d{3}$/.test(match[0])) continue;
        if (category === 'email address' && safeEmail(match[0], file, lines[i])) continue;
        report(category, file, i + 1);
      }
    }
  }
  // Refuse links in any component before opening a working-tree file.
  function readWorking(file) {
    let path = root;
    for (const part of file.split('/')) {
      path = join(path, part);
      if (!existsSync(path)) return;
      if (lstatSync(path).isSymbolicLink()) { report('symbolic link', file); return; }
    }
    if (!lstatSync(path).isFile()) { report('unsupported file', file); return; }
    scan(file, readFileSync(path));
  }
  if (existsSync(join(root, '.git'))) {
    try {
      const top = git(root, ['rev-parse', '--show-toplevel']).toString().trim();
      const canonical = path => process.platform === 'win32' ? realpathSync(path).toLowerCase() : realpathSync(path);
      if (canonical(top) !== canonical(root)) throw new Error('wrong root');
      const entries = git(root, ['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean);
      for (const entry of entries) {
        const match = /^(\d+) [0-9a-f]+ (\d)\t([\s\S]+)$/.exec(entry);
        if (!match) { report('tracked-file inspection unavailable', '.'); continue; }
        const [, mode, stage, file] = match;
        if (forbidden(file) || rules.ignores(file)) { report('prohibited tracked path', file); continue; }
        if (mode !== '100644' && mode !== '100755') { report('unsupported tracked file', file); continue; }
        if (stage !== '0') { report('unmerged tracked file', file); continue; }
        scan(file, git(root, ['show', `:${file}`]));
        readWorking(file);
      }
    } catch { report('tracked-file inspection unavailable', '.'); }
  } else {
    function visit(dir, prefix = '') {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!prefix && !allowedRoots.has(file)) continue;
        if (rules.ignores(entry.isDirectory() ? `${file}/` : file)) continue;
        if (forbidden(file)) { report('prohibited path', file); continue; }
        if (entry.isSymbolicLink()) { report('symbolic link', file); continue; }
        if (entry.isDirectory()) visit(join(dir, entry.name), file);
        else if (entry.isFile()) readWorking(file);
        else report('unsupported file', file);
      }
    }
    visit(root);
  }
  return findings;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const findings = audit(process.cwd());
  if (findings.length) { console.error(findings.join('\n')); console.error(`Privacy audit found ${findings.length} issue(s).`); process.exitCode = 1; }
  else console.log('Privacy audit passed its local heuristic checks.');
  console.log('Review the exact release files and history independently; this audit cannot prove absence of secrets.');
}
