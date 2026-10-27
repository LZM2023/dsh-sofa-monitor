#!/usr/bin/env node
/**
 * 语法自检：对仓库内所有 .mjs / .cjs / .js 逐个跑 `node --check`。
 * 只做语法解析，不执行任何模块，因此不会触发插件副作用（不连平台、不写数据目录）。
 *
 * 用法：node scripts/check-syntax.mjs
 */
import { readdir } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const EXTENSIONS = new Set(['.mjs', '.cjs', '.js']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'outputs', '.sofa-monitor']);

async function collect(dir) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await collect(full)));
    else if (EXTENSIONS.has(extname(entry.name))) found.push(full);
  }
  return found;
}

const files = (await collect(root)).sort();
const failures = [];

for (const file of files) {
  try {
    await run(process.execPath, ['--check', file], { windowsHide: true });
  } catch (error) {
    failures.push({ file: relative(root, file), stderr: String(error.stderr || error.message).trim() });
  }
}

if (failures.length === 0) {
  console.log(`语法自检通过：${files.length} 个文件`);
  process.exit(0);
}

console.error(`语法自检失败：${failures.length} / ${files.length} 个文件`);
for (const failure of failures) console.error(`\n${failure.file}\n${failure.stderr}`);
process.exit(1);
