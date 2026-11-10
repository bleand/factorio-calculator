// Runs Factorio's data stage (the Lua prototype definitions) inside a Lua VM
// and returns the resulting `data.raw` subset as a plain JS object.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fengari from 'fengari';

const { lua, lauxlib, lualib, to_luastring } = fengari;
const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'harness.lua');

export const MOD_SETS = {
  vanilla: ['core', 'base'],
  'space-age': ['core', 'base', 'elevated-rails', 'recycler', 'quality', 'space-age'],
};

export function dumpRaw(root, mode) {
  root = path.resolve(root).replace(/\\/g, '/');
  const modList = MOD_SETS[mode].filter((m) => fs.existsSync(`${root}/${m}/info.json`));
  const versions = modList.map((m) => JSON.parse(fs.readFileSync(`${root}/${m}/info.json`, 'utf8')).version);

  // Sandbox: the prototype files are third-party code, so the VM only gets the
  // pure libraries (no io, os or package) and no way to load files on its own.
  const L = lauxlib.luaL_newstate();
  const libs = {
    _G: lualib.luaopen_base,
    table: lualib.luaopen_table,
    string: lualib.luaopen_string,
    math: lualib.luaopen_math,
    coroutine: lualib.luaopen_coroutine,
    utf8: lualib.luaopen_utf8,
    debug: lualib.luaopen_debug, // the harness keeps only debug.traceback
  };
  for (const [name, open] of Object.entries(libs)) {
    lauxlib.luaL_requiref(L, to_luastring(name), open, 1);
    lua.lua_pop(L, 1);
  }
  for (const name of ['dofile', 'loadfile']) {
    lua.lua_pushnil(L);
    lua.lua_setglobal(L, to_luastring(name));
  }

  // The only file access: read-only, .lua files inside the data checkout.
  lua.lua_pushjsfunction(L, (L) => {
    const file = path.resolve(Buffer.from(lua.lua_tostring(L, 1)).toString('utf8')).replace(/\\/g, '/');
    let content;
    try {
      if (!file.startsWith(root + '/') || !file.endsWith('.lua')) throw new Error('outside sandbox');
      content = fs.readFileSync(file);
    } catch {
      lua.lua_pushnil(L);
      return 1;
    }
    // Strip a UTF-8 byte order mark if present.
    if (content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) content = content.subarray(3);
    lua.lua_pushstring(L, new Uint8Array(content));
    return 1;
  });
  lua.lua_setglobal(L, to_luastring('__readfile'));

  const setString = (name, value) => {
    lua.lua_pushstring(L, to_luastring(value));
    lua.lua_setglobal(L, to_luastring(name));
  };
  setString('__root', root);
  setString('__mods', modList.join(','));
  setString('__versions', versions.join(','));
  lua.lua_pushboolean(L, mode === 'space-age');
  lua.lua_setglobal(L, to_luastring('__space_age'));

  const source = new Uint8Array(fs.readFileSync(HARNESS));
  const status =
    lauxlib.luaL_loadbuffer(L, source, source.length, to_luastring('@harness.lua')) || lua.lua_pcall(L, 0, 1, 0);
  const result = Buffer.from(lua.lua_tostring(L, -1) ?? []).toString('utf8');
  if (status !== lua.LUA_OK) throw new Error(`Factorio data stage failed (${mode}):\n${result}`);
  return { raw: JSON.parse(result), version: versions[modList.indexOf('base')] };
}

// Debug helper: node tools/extract/dump-raw.mjs <factorio-data dir> <mode> <out.json>
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, mode, outFile] = process.argv.slice(2);
  const started = Date.now();
  const { raw, version } = dumpRaw(root, mode);
  fs.writeFileSync(outFile, JSON.stringify(raw));
  console.log(`${mode} ${version}: ${Object.keys(raw.recipe).length} recipes in ${Date.now() - started} ms`);
}
