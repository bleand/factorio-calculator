// Icons and display names are not part of the public factorio-data repository,
// so they are imported from a local Factorio installation when one is available
// and committed to this repository (site/icons, tools/extract/names.json).
// Without an installation (e.g. in CI) the committed copies are reused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME_SECTIONS = ['item-name', 'fluid-name', 'entity-name', 'recipe-name', 'equipment-name'];

/** Returns the `data` directory of a Factorio installation, or null. */
export function findInstall(explicit) {
  const home = os.homedir();
  const candidates = [
    explicit,
    process.env.FACTORIO_PATH,
    'C:/Program Files (x86)/Steam/steamapps/common/Factorio',
    'C:/Program Files/Factorio',
    path.join(home, '.steam/steam/steamapps/common/Factorio'),
    path.join(home, '.local/share/Steam/steamapps/common/Factorio'),
    path.join(home, 'Library/Application Support/Steam/steamapps/common/Factorio/factorio.app/Contents'),
    '/Applications/factorio.app/Contents',
  ].filter(Boolean);
  for (const candidate of candidates) {
    for (const dir of [candidate, path.join(candidate, 'data')]) {
      if (fs.existsSync(path.join(dir, 'base', 'info.json'))) return dir;
    }
  }
  return null;
}

export function installVersion(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'base', 'info.json'), 'utf8')).version;
}

/** Reads the English name sections of the given mods: { section: { id: name } }. */
export function readNames(dataDir, mods) {
  const names = Object.fromEntries(NAME_SECTIONS.map((section) => [section, {}]));
  for (const mod of mods) {
    const dir = path.join(dataDir, mod, 'locale', 'en');
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.cfg')).sort()) {
      let section = null;
      for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/)) {
        const header = /^\[(.+)\]\s*$/.exec(line);
        if (header) {
          section = names[header[1]] ?? null;
          continue;
        }
        const entry = /^([^=;#][^=]*)=(.*)$/.exec(line);
        // skip names that are templates referring to other strings
        if (section && entry && !entry[2].includes('__')) section[entry[1].trim()] = entry[2].trim();
      }
    }
  }
  return names;
}

/**
 * Returns a function mapping a prototype icon reference such as
 * "__base__/graphics/icons/fluid/water.png" to a site-relative path
 * ("base/fluid/water.png"), copying the file from the installation if possible.
 * Yields undefined when the icon is not available.
 */
export function iconResolver(iconsDir, dataDir) {
  const cache = new Map();
  return (ref) => {
    if (typeof ref !== 'string') return undefined;
    if (cache.has(ref)) return cache.get(ref);
    const match = /^__([^/]+)__\/graphics\/icons\/(.+\.png)$/.exec(ref);
    let result;
    if (match && !match[2].includes('..')) {
      const relative = `${match[1]}/${match[2]}`;
      const target = path.join(iconsDir, relative);
      const source = dataDir && path.join(dataDir, match[1], 'graphics', 'icons', match[2]);
      if (source && fs.existsSync(source)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
      }
      if (fs.existsSync(target)) result = relative;
    }
    cache.set(ref, result);
    return result;
  };
}
