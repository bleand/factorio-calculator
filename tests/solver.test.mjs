import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { RAW, defaultRecipe, solve } from '../site/js/solver.js';

const load = (mode) => JSON.parse(fs.readFileSync(new URL(`../site/data/${mode}.json`, import.meta.url), 'utf8'));
const vanilla = load('vanilla');
const spaceAge = load('space-age');

const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)), `${message}: ${actual} != ${expected}`);
const step = (result, recipe) => result.steps.find((s) => s.recipe === recipe);
const rateOf = (list, item) => list.find((e) => e.item === item)?.rate ?? 0;

test('iron gear wheels: assemblers, furnaces and drills', () => {
  const result = solve(vanilla, { targets: { 'iron-gear-wheel': 1 } });
  // 1 gear/s = 1 craft/s x 0.5 s in an assembler 2 (speed 0.75)
  near(step(result, 'iron-gear-wheel').machineCount, 0.5 / 0.75, 'assemblers');
  assert.equal(step(result, 'iron-gear-wheel').machine, 'assembling-machine-2');
  // 2 plates/s x 3.2 s in electric furnaces (speed 2)
  near(step(result, 'iron-plate').machineCount, (2 * 3.2) / 2, 'furnaces');
  // 2 ore/s, mining time 1, electric mining drill speed 0.5
  near(step(result, 'mine:iron-ore').machineCount, 4, 'drills');
  assert.deepEqual(result.inputs, []);
  assert.deepEqual(result.surplus, []);
});

test('machine tier preference changes machine counts', () => {
  const result = solve(vanilla, {
    targets: { 'iron-gear-wheel': 1 },
    prefs: { assembler: 'assembling-machine-3', furnace: 'stone-furnace' },
  });
  near(step(result, 'iron-gear-wheel').machineCount, 0.5 / 1.25, 'assembler 3');
  near(step(result, 'iron-plate').machineCount, 2 * 3.2, 'stone furnace');
});

test('electronic circuit raw totals', () => {
  const result = solve(vanilla, { targets: { 'electronic-circuit': 1 } });
  near(result.produced['iron-ore'], 1, 'iron ore');
  near(result.produced['copper-ore'], 1.5, 'copper ore');
});

test('assembler 1 cannot handle fluids, so the next tier is used', () => {
  const result = solve(vanilla, { targets: { 'engine-unit': 1 }, prefs: { assembler: 'assembling-machine-1' } });
  const fluidStep = result.steps.find((s) => vanilla.recipes[s.recipe].cats.includes('crafting-with-fluid'));
  if (fluidStep) assert.equal(fluidStep.machine, 'assembling-machine-2');
  assert.equal(step(result, 'iron-gear-wheel').machine, 'assembling-machine-1');
});

test('plastic uses basic oil processing without leftover byproducts', () => {
  const result = solve(vanilla, { targets: { 'plastic-bar': 2 } });
  assert.ok(step(result, 'basic-oil-processing'));
  assert.deepEqual(result.surplus, []);
});

test('multi-output recipe: byproducts are credited and the rest is surplus', () => {
  // lubricant needs heavy oil (advanced oil processing), which also yields light oil and gas
  const result = solve(vanilla, { targets: { lubricant: 1 } });
  const refinery = step(result, 'advanced-oil-processing');
  near(refinery.crafts * 25, 1, 'heavy oil for 1 lubricant/s'); // 10 heavy oil -> 10 lubricant
  near(rateOf(result.surplus, 'light-oil'), refinery.crafts * 45, 'light oil surplus');
  near(rateOf(result.surplus, 'petroleum-gas'), refinery.crafts * 55, 'petroleum gas surplus');
});

test('uranium processing is shared between U-235 and U-238', () => {
  const result = solve(vanilla, { targets: { 'uranium-fuel-cell': 1 } });
  assert.equal(result.steps.filter((s) => s.recipe === 'uranium-processing').length, 1);
  // each fuel cell craft (10 cells) needs 1 U-235 and 19 U-238; U-235 (0.7%) is the bottleneck
  near(step(result, 'uranium-processing').crafts, 0.1 / 0.007, 'centrifuge crafts');
  assert.ok(rateOf(result.surplus, 'uranium-238') > 0);
});

test('Kovarex loop converges when chosen', () => {
  const result = solve(vanilla, {
    targets: { 'uranium-235': 1 },
    recipes: { 'uranium-235': 'kovarex-enrichment-process' },
  });
  assert.deepEqual(result.warnings, []);
  // net +1 U-235 and -3 U-238 per craft; uranium processing covers the U-238 and adds some U-235
  const kovarex = step(result, 'kovarex-enrichment-process').crafts;
  const processing = step(result, 'uranium-processing').crafts;
  near(kovarex + processing * 0.007, 1, 'U-235 balance');
  near(processing * 0.993, kovarex * 3, 'U-238 balance');
});

test('marking an item as raw stops the chain there', () => {
  const result = solve(vanilla, { targets: { 'iron-gear-wheel': 1 }, recipes: { 'iron-plate': RAW } });
  assert.equal(result.steps.length, 1);
  near(rateOf(result.inputs, 'iron-plate'), 2, 'iron plate input');
});

test('space science in the base game comes from rocket launches', () => {
  const result = solve(vanilla, { targets: { 'space-science-pack': 1 } });
  near(step(result, 'launch:satellite').crafts, 1 / 1000, 'launches per second');
  near(step(result, 'rocket-part').crafts, 0.1, 'rocket parts per second');
  assert.equal(step(result, 'rocket-part').machine, 'rocket-silo');
});

test('Space Age: foundry base productivity is applied', () => {
  const result = solve(spaceAge, { targets: { 'iron-plate': 3 }, recipes: { 'iron-plate': 'casting-iron' } });
  const casting = step(result, 'casting-iron');
  assert.equal(casting.machine, 'foundry');
  near(casting.productivity, 0.5, 'base productivity');
  near(casting.crafts, 1, 'casts per second'); // 2 plates x 1.5
  near(casting.machineCount, 3.2 / 4, 'foundries');
});

test('Space Age defaults keep Nauvis basics simple', () => {
  assert.equal(defaultRecipe(spaceAge, 'iron-plate'), 'iron-plate');
  assert.equal(defaultRecipe(spaceAge, 'iron-ore'), 'mine:iron-ore');
  assert.equal(defaultRecipe(spaceAge, 'water'), 'pump:water');
  assert.equal(defaultRecipe(spaceAge, 'sulfuric-acid'), 'sulfuric-acid');
  assert.equal(defaultRecipe(spaceAge, 'heavy-oil'), 'advanced-oil-processing');
  assert.equal(defaultRecipe(spaceAge, 'petroleum-gas'), 'basic-oil-processing');
});

test('every craftable item solves without warnings in both modes', () => {
  for (const data of [vanilla, spaceAge]) {
    for (const item of Object.keys(data.items)) {
      if (!defaultRecipe(data, item)) continue;
      const result = solve(data, { targets: { [item]: 1 } });
      assert.deepEqual(result.warnings, [], `${data.mode} ${item}`);
      assert.ok(result.steps.length > 0, `${data.mode} ${item} has steps`);
      for (const s of result.steps) assert.ok(Number.isFinite(s.crafts) && s.crafts > 0, `${data.mode} ${item} ${s.recipe}`);
    }
  }
});
