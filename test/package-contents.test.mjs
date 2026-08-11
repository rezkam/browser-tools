import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

const EXPECTED_DOCS = ['README.md', 'CHANGELOG.md', 'LICENSE', 'package.json'];
// The skill is installed from this repository (`npx skills add rezkam/browser-tools`), not from
// the tarball, so its docs, evals, and config example stay out of the published package.
const EXCLUDED_PREFIXES = ['SKILL.md', 'CONTEXT.md', 'references/', 'evals/', 'config/', 'test/', '.changeset/', '.github/'];

function packedPaths() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf-8' });
  assert.equal(result.status, 0, `npm pack --dry-run failed: ${result.stderr}`);
  const [tarball] = JSON.parse(result.stdout);
  return tarball.files.map((file) => file.path);
}

test('published package contains the runtime CLI, every runtime module, and npm-facing docs', () => {
  const paths = packedPaths();

  assert.deepEqual(paths.filter((path) => path.startsWith('bin/')).sort(), ['bin/browser-tools.mjs']);

  const runtimeSources = readdirSync(new URL('../scripts', import.meta.url))
    .map((name) => `scripts/${name}`)
    .sort();
  assert.deepEqual(paths.filter((path) => path.startsWith('scripts/')).sort(), runtimeSources);

  for (const doc of EXPECTED_DOCS) assert.ok(paths.includes(doc), `${doc} should be published`);
});

test('published package excludes skill, test, and repository automation files', () => {
  const unexpected = packedPaths().filter((path) => EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)));

  assert.deepEqual(unexpected, []);
});

test('package metadata points at this standalone repository', () => {
  assert.equal(packageJson.repository.url, 'git+https://github.com/rezkam/browser-tools.git');
  assert.equal(packageJson.repository.directory, undefined);
  assert.match(packageJson.homepage, /^https:\/\/github\.com\/rezkam\/browser-tools/);
  assert.match(packageJson.bugs.url, /^https:\/\/github\.com\/rezkam\/browser-tools/);
});
