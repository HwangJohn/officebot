import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audit } from '../tools/privacy-audit.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'officebot-audit-'));
  const paths = [];
  return {
    root,
    dir(name) { const path = join(root, name); mkdirSync(path); paths.push([path, true]); },
    file(name, contents) { const path = join(root, name); writeFileSync(path, contents); paths.push([path, false]); },
    clean() { for (const [path, directory] of paths.reverse()) directory ? rmdirSync(path) : unlinkSync(path); rmdirSync(root); }
  };
}
const fakeSecret = () => 'sk-' + 'x'.repeat(24);

test('uninitialized export ignores nested local data and scans tests', () => {
  const f = fixture();
  try {
    f.file('.gitignore', 'data/\n'); f.dir('client'); f.dir('client/data');
    f.file('client/data/local.txt', fakeSecret()); f.dir('test'); f.file('test/sample.ts', 'safe');
    assert.deepEqual(audit(f.root), []);
    writeFileSync(join(f.root, 'test/sample.ts'), fakeSecret());
    assert.ok(audit(f.root).some(item => item.startsWith('API credential: test/sample.ts:')));
  } finally { f.clean(); }
});

test('tracked prohibited paths fail before staged or working contents are read', () => {
  const f = fixture();
  try {
    f.file('.gitignore', 'data/\n'); f.dir('.git'); f.dir('client'); f.dir('client/data');
    f.file('client/data/private.db', 'not inspected');
    const calls = [];
    const git = (_root, args) => {
      calls.push(args[0]);
      if (args[0] === 'rev-parse') return Buffer.from(f.root);
      if (args[0] === 'ls-files') return Buffer.from('100644 ' + 'a'.repeat(40) + ' 0\tclient/data/private.db\0');
      throw new Error('prohibited content must not be read');
    };
    assert.ok(audit(f.root, git).includes('prohibited tracked path: client/data/private.db'));
    assert.deepEqual(calls, ['rev-parse', 'ls-files']);
  } finally { f.clean(); }
});

test('staged test credentials are scanned even if the working file is clean', () => {
  const f = fixture();
  try {
    f.dir('.git'); f.dir('test'); f.file('test/sample.ts', 'safe');
    const git = (_root, args) => args[0] === 'rev-parse' ? Buffer.from(f.root) : args[0] === 'ls-files' ? Buffer.from('100644 ' + 'a'.repeat(40) + ' 0\ttest/sample.ts\0') : Buffer.from(fakeSecret());
    assert.ok(audit(f.root, git).some(item => item.startsWith('API credential: test/sample.ts:')));
  } finally { f.clean(); }
});

test('a parent repository does not become the export repository', () => {
  const f = fixture();
  try {
    f.dir('.git'); f.dir('export'); f.file('export/README.md', 'safe');
    assert.deepEqual(audit(join(f.root, 'export'), () => { throw new Error('parent git must not be called'); }), []);
  } finally { f.clean(); }
});

test('reserved emails and only the defined synthetic snowflake range are allowed', () => {
  const f = fixture();
  try {
    f.file('README.md', ['demo@sample.test', 'person@example.com', '100000000000000999'].join('\n'));
    assert.deepEqual(audit(f.root), []);
    writeFileSync(join(f.root, 'README.md'), [['person', 'company.com'].join('@'), '100000000000001' + '000'].join('\n'));
    const issues = audit(f.root);
    assert.ok(issues.some(item => item.startsWith('email address:')));
    assert.ok(issues.some(item => item.startsWith('snowflake:')));
  } finally { f.clean(); }
});

test('upstream lockfile deprecation contact has a narrow exception', () => {
  const f = fixture();
  try {
    const contact = ['i', 'izs.me'].join('@');
    f.file('package-lock.json', `"deprecated": "Contact ${contact}"`);
    assert.deepEqual(audit(f.root), []);
    writeFileSync(join(f.root, 'package-lock.json'), `"other": "${contact}"`);
    assert.ok(audit(f.root).some(item => item.startsWith('email address:')));
    writeFileSync(join(f.root, 'package-lock.json'), 'safe');
    f.file('README.md', `"deprecated": "${contact}"`);
    assert.ok(audit(f.root).some(item => item.startsWith('email address:')));
  } finally { f.clean(); }
});
