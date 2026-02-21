import fs from 'node:fs/promises';
import path from 'node:path';

function defaultWorkspaceDir() {
  const cwd = process.cwd();
  const base = path.basename(cwd).toLowerCase();
  // Gemini MCP config runs this server with cwd=.../Auto, so workspace is parent.
  if (base === 'auto') return path.resolve(cwd, '..');
  return cwd;
}

export const WORKSPACE_DIR = path.resolve(
  process.env['MCP_WORKSPACE_DIR'] ||
    process.env['JOB_AUTOMATION_BASE_DIR'] ||
    defaultWorkspaceDir()
);

export const ALLOWED_READ_DIRS = [
  path.resolve(path.join(WORKSPACE_DIR, 'Applied Jobs')),
  path.resolve(path.join(WORKSPACE_DIR, 'Auto', 'output')),
  path.resolve(path.join(WORKSPACE_DIR, 'Auto', 'logs'))
];

export const ALLOWED_WRITE_DIRS = [
  path.resolve(path.join(WORKSPACE_DIR, 'Auto', 'output')),
  path.resolve(path.join(WORKSPACE_DIR, 'Auto', 'logs'))
];

function isPathWithin(parentDir, targetPath) {
  const rel = path.relative(parentDir, targetPath);
  if (!rel) return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function resolveRealPath(targetPath) {
  const abs = path.resolve(targetPath);
  try {
    return await fs.realpath(abs);
  } catch {
    return abs;
  }
}

export async function assertAllowedReadPath(targetPath) {
  const abs = await resolveRealPath(targetPath);
  for (const baseDir of ALLOWED_READ_DIRS) {
    if (isPathWithin(baseDir, abs)) return abs;
  }
  throw new Error(`Reading this path is not allowed: ${abs}`);
}

export async function assertAllowedWritePath(targetPath) {
  const abs = path.resolve(targetPath);
  for (const baseDir of ALLOWED_WRITE_DIRS) {
    if (isPathWithin(baseDir, abs)) return abs;
  }
  throw new Error(`Writing this path is not allowed: ${abs}`);
}

