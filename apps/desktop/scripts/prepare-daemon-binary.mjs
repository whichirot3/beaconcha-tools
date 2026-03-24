#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, '..');
const workspaceRoot = resolve(desktopRoot, '..', '..');
const targetDir = resolve(workspaceRoot, 'target', 'release');
const binaryName = process.platform === 'win32' ? 'beaconops-daemon.exe' : 'beaconops-daemon';
const source = resolve(targetDir, binaryName);
const outputDir = resolve(desktopRoot, 'src-tauri', 'bin');
const output = resolve(outputDir, binaryName);

console.log('[prepare-daemon] building beaconops-daemon (release)');
const build = spawnSync('cargo', ['build', '-p', 'beaconops-daemon', '--release'], {
  cwd: workspaceRoot,
  stdio: 'inherit',
  env: process.env,
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

if (!existsSync(source)) {
  console.error(`[prepare-daemon] built binary not found: ${source}`);
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });
copyFileSync(source, output);
if (process.platform !== 'win32') {
  chmodSync(output, 0o755);
}

console.log(`[prepare-daemon] copied ${source} -> ${output}`);
