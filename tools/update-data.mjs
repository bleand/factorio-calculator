#!/usr/bin/env node
// Regenerates site/data/*.json from the official Factorio prototype data.
//
//   node tools/update-data.mjs              update to the latest stable release (no-op if current)
//   node tools/update-data.mjs --force      rebuild even if the version is unchanged
//   node tools/update-data.mjs --version 2.1.24
//   node tools/update-data.mjs --channel experimental
//
// Source of truth: https://github.com/wube/factorio-data (tagged per release).
// Exit code 0 on success; prints "updated=true|false" for CI.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpRaw, MOD_SETS } from './extract/dump-raw.mjs';
import { buildDataset } from './extract/build-dataset.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'site', 'data');
const CACHE_DIR = path.join(ROOT, '.cache', 'factorio-data');
const REPO = 'https://github.com/wube/factorio-data.git';
const RELEASES = 'https://factorio.com/api/latest-releases';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);

async function latestVersion(channel) {
  const response = await fetch(RELEASES);
  if (!response.ok) throw new Error(`${RELEASES} responded ${response.status}`);
  const releases = await response.json();
  const version = releases[channel]?.headless ?? releases[channel]?.alpha;
  if (!version) throw new Error(`No "${channel}" release in ${JSON.stringify(releases)}`);
  return version;
}

function checkout(version) {
  const git = (cwd, ...gitArgs) => execFileSync('git', gitArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!fs.existsSync(path.join(CACHE_DIR, '.git'))) {
    fs.mkdirSync(path.dirname(CACHE_DIR), { recursive: true });
    git(ROOT, 'clone', '--quiet', '--depth', '1', '--branch', version, REPO, CACHE_DIR);
  } else {
    git(CACHE_DIR, 'fetch', '--quiet', '--depth', '1', 'origin', `refs/tags/${version}:refs/tags/${version}`);
    git(CACHE_DIR, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', `tags/${version}`);
  }
}

async function main() {
  const version = option('version') ?? (await latestVersion(option('channel') ?? 'stable'));
  const metaFile = path.join(DATA_DIR, 'meta.json');
  const current = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};

  if (current.version === version && !flag('force')) {
    console.log(`Data already at Factorio ${version}.`);
    console.log('updated=false');
    return;
  }

  console.log(`Fetching Factorio ${version} prototype data...`);
  checkout(version);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const summary = {};
  for (const mode of Object.keys(MOD_SETS)) {
    const { raw, version: dataVersion } = dumpRaw(CACHE_DIR, mode);
    const dataset = buildDataset(raw, { mode, version: dataVersion });
    fs.writeFileSync(path.join(DATA_DIR, `${mode}.json`), JSON.stringify(dataset));
    summary[mode] = {
      items: Object.keys(dataset.items).length,
      recipes: Object.keys(dataset.recipes).length,
      machines: Object.keys(dataset.machines).length,
    };
    console.log(`  ${mode}: ${JSON.stringify(summary[mode])}`);
  }

  const changed = current.version !== version;
  const meta = {
    version,
    source: 'https://github.com/wube/factorio-data',
    // keep the date stable on forced rebuilds so identical data produces no diff
    updated: changed || !current.updated ? new Date().toISOString().slice(0, 10) : current.updated,
    datasets: summary,
  };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
  console.log(`Wrote ${path.relative(ROOT, DATA_DIR)} for Factorio ${version}.`);
  console.log('updated=true');
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
