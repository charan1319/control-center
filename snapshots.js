import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

const SNAPSHOTS_DIR = join(process.cwd(), 'data', 'snapshots');

function repoDir(cwd) {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  return join(SNAPSHOTS_DIR, hash);
}

function gitEnv(cwd) {
  return { GIT_DIR: join(repoDir(cwd), 'repo.git'), GIT_WORK_TREE: cwd };
}

export function initRepo(cwd) {
  const dir = join(repoDir(cwd), 'repo.git');
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--bare'], { cwd: dir, stdio: 'ignore' });
  const excludeDir = join(dir, 'info');
  mkdirSync(excludeDir, { recursive: true });
  writeFileSync(join(excludeDir, 'exclude'), [
    'node_modules/', '.env', '.env.*', 'dist/', 'build/', '.next/',
    '*.log', '.DS_Store', '__pycache__/', '*.pyc', '.git/',
    '.control-center/'
  ].join('\n'));
}

export function capture(cwd) {
  const env = gitEnv(cwd);
  execFileSync('git', ['add', '-A'], { env: { ...process.env, ...env }, stdio: 'ignore', timeout: 30000 });
  const hash = execFileSync('git', ['write-tree'], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000 }).trim();
  return hash || null;
}

export function diff(cwd, treeHash) {
  const env = gitEnv(cwd);
  const currentHash = capture(cwd);
  if (!currentHash) return { added: [], modified: [], deleted: [] };
  const output = execFileSync('git', ['diff-tree', '-r', '--name-status', treeHash, currentHash],
    { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000 });
  const result = { added: [], modified: [], deleted: [] };
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const [status, filePath] = line.split('\t');
    if (status === 'A') result.added.push(filePath);
    else if (status === 'M') result.modified.push(filePath);
    else if (status === 'D') result.deleted.push(filePath);
  }
  return result;
}

export function restore(cwd, treeHash) {
  const changes = diff(cwd, treeHash);
  const env = gitEnv(cwd);
  execFileSync('git', ['read-tree', treeHash], { env: { ...process.env, ...env }, stdio: 'ignore', timeout: 10000 });
  execFileSync('git', ['checkout-index', '-a', '-f'], { env: { ...process.env, ...env }, stdio: 'ignore', timeout: 30000 });
  for (const f of changes.added) {
    const fullPath = join(cwd, f);
    try { unlinkSync(fullPath); } catch {}
    const parentDir = dirname(fullPath);
    if (parentDir !== cwd) {
      try { rmdirSync(parentDir); } catch {}
    }
  }
  return [...changes.added, ...changes.modified, ...changes.deleted];
}
