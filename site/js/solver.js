// Production solver. Pure functions over a dataset (see tools/extract/build-dataset.mjs),
// shared by the browser UI and the Node tests.
//
// Model: every item is made by exactly one "primary" recipe (a default, or the
// user's choice) or is treated as an external input. Recipe rates are then
// solved so that each produced item covers its demand, crediting byproducts of
// other recipes in the plan and handling loops (e.g. Kovarex enrichment).

export const RAW = 'raw';

// Defaults where the generic heuristic would pick a poor recipe.
const PREFERRED_RECIPE = {
  'petroleum-gas': 'basic-oil-processing',
  'heavy-oil': 'advanced-oil-processing',
  'light-oil': 'advanced-oil-processing',
  'solid-fuel': 'solid-fuel-from-light-oil',
  'uranium-235': 'uranium-processing',
  'uranium-238': 'uranium-processing',
  // only ever a side effect of other recipes: supplied from outside by default
  spoilage: RAW,
  steam: RAW,
};

const EPS = 1e-9;
const indexCache = new WeakMap();

function indexOf(data) {
  let index = indexCache.get(data);
  if (index) return index;

  const producers = new Map();
  for (const [id, recipe] of Object.entries(data.recipes)) {
    for (const item of Object.keys(recipe.out)) {
      // a recipe that only passes an item through (catalyst) does not produce it
      if (recipe.out[item][0] - (recipe.in[item] ?? 0) <= EPS) continue;
      if (!producers.has(item)) producers.set(item, []);
      producers.get(item).push(id);
    }
  }

  const byCategory = new Map();
  for (const [id, machine] of Object.entries(data.machines)) {
    for (const cat of machine.cats) {
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(id);
    }
  }

  const bySpeed = (a, b) =>
    data.machines[a].speed - data.machines[b].speed ||
    Number(data.machines[b].burner) - Number(data.machines[a].burner) ||
    data.machines[a].power - data.machines[b].power;
  const family = (cat) => [...(byCategory.get(cat) ?? [])].sort(bySpeed);
  const families = {
    assembler: family('crafting'),
    furnace: family('smelting').filter((id) => !data.machines[id].cats.includes('crafting')),
    drill: family('mining:basic-solid'),
  };

  index = { producers, byCategory, families };
  indexCache.set(data, index);
  return index;
}

/** Recipes that can make `item`, best default first. */
export function recipesFor(data, item) {
  const { producers } = indexOf(data);
  const candidates = producers.get(item) ?? [];
  const score = (id) => {
    const recipe = data.recipes[id];
    const outputs = Object.keys(recipe.out);
    let s = 0;
    if (PREFERRED_RECIPE[item] === id) s += 1000;
    if (id === item) s += 500; // the item's own recipe
    if (recipe.kind === 'mine' || recipe.kind === 'gather') s += 300; // ores are mined unless they have their own recipe
    if (recipe.kind === 'pump') s += item === 'water' || candidates.length === 1 ? 400 : -100;
    if (recipe.kind === 'launch') s += 50;
    if (outputs[0] === item) s += 40;
    s -= 10 * (outputs.length - 1); // prefer dedicated recipes over byproduct ones
    if (recipe.in[item]) s -= 60; // self-consuming loops are opt-in
    if (id.startsWith(item)) s += 5;
    return s;
  };
  return [...candidates].sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}

export function defaultRecipe(data, item) {
  if (PREFERRED_RECIPE[item] === RAW) return null;
  return recipesFor(data, item)[0] ?? null;
}

/** Machines able to run `recipe`, in the order of the recipe's categories. */
export function machinesFor(data, recipeId) {
  const { byCategory } = indexOf(data);
  const seen = new Set();
  for (const cat of data.recipes[recipeId].cats) for (const id of byCategory.get(cat) ?? []) seen.add(id);
  return [...seen];
}

export function machineFamilies(data) {
  return indexOf(data).families;
}

export function defaultPrefs(data) {
  const { families } = indexOf(data);
  const pick = (list, wanted) => (list.includes(wanted) ? wanted : list[0] ?? null);
  return {
    assembler: pick(families.assembler, 'assembling-machine-2'),
    furnace: pick(families.furnace, 'electric-furnace'),
    drill: pick(families.drill, 'electric-mining-drill'),
  };
}

export function defaultMachine(data, recipeId, prefs = defaultPrefs(data)) {
  const candidates = machinesFor(data, recipeId);
  if (candidates.length === 0) return null;
  const { families } = indexOf(data);
  for (const key of ['assembler', 'furnace', 'drill']) {
    const family = families[key];
    const start = family.indexOf(prefs[key]);
    if (start < 0) continue;
    // the preferred tier, or the next tier up that can run this recipe
    for (let i = start; i < family.length; i++) if (candidates.includes(family[i])) return family[i];
  }
  return candidates[0];
}

/**
 * @param data     dataset
 * @param options  {
 *   targets:  { itemId: itemsPerSecond },
 *   recipes:  { itemId: recipeId | RAW }   per-item recipe overrides
 *   machines: { recipeId: machineId }      per-recipe machine overrides
 *   prefs:    { assembler, furnace, drill } default machine tiers
 * }
 */
export function solve(data, { targets, recipes: recipeChoice = {}, machines: machineChoice = {}, prefs } = {}) {
  prefs = { ...defaultPrefs(data), ...prefs };
  const warnings = [];

  // 1. Walk down from the targets, assigning each item its primary recipe.
  const primary = new Map(); // item -> recipeId | null (external input)
  const plan = []; // recipe ids in discovery (breadth-first) order
  const depth = new Map();
  const queue = Object.keys(targets).map((item) => [item, 0]);
  while (queue.length > 0) {
    const [item, level] = queue.shift();
    if (primary.has(item)) continue;
    const choice = recipeChoice[item];
    let recipeId = choice === RAW ? null : choice;
    if (recipeId === undefined || (recipeId !== null && !data.recipes[recipeId]?.out[item])) {
      recipeId = defaultRecipe(data, item);
    }
    primary.set(item, recipeId);
    if (!recipeId) continue;
    if (!plan.includes(recipeId)) {
      plan.push(recipeId);
      depth.set(recipeId, level);
    }
    for (const ingredient of Object.keys(data.recipes[recipeId].in)) queue.push([ingredient, level + 1]);
  }

  // 2. Per-recipe machine and effective yields.
  const setup = new Map();
  for (const recipeId of plan) {
    const recipe = data.recipes[recipeId];
    const candidates = machinesFor(data, recipeId);
    let machineId = machineChoice[recipeId];
    if (!candidates.includes(machineId)) machineId = defaultMachine(data, recipeId, prefs);
    const machine = machineId ? data.machines[machineId] : null;
    const productivity = Math.min(machine?.baseProd ?? 0, recipe.maxProd);
    const out = {};
    for (const [item, [amount, productive]] of Object.entries(recipe.out)) out[item] = amount + productive * productivity;
    setup.set(recipeId, { recipe, machineId, machine, productivity, out, in: recipe.in });
  }

  // 3. Solve the rates (crafts per second) by Gauss-Seidel iteration.
  const rate = new Map(plan.map((id) => [id, 0]));
  const primaryItems = new Map(plan.map((id) => [id, []]));
  for (const [item, recipeId] of primary) if (recipeId) primaryItems.get(recipeId).push(item);

  const stuck = new Set();
  let converged = false;
  for (let iteration = 0; iteration < 5000 && !converged; iteration++) {
    let change = 0;
    for (const recipeId of plan) {
      const own = setup.get(recipeId);
      let needed = 0;
      for (const item of primaryItems.get(recipeId)) {
        const net = own.out[item] - (own.in[item] ?? 0);
        if (net <= EPS) {
          stuck.add(item);
          continue;
        }
        let required = targets[item] ?? 0;
        for (const otherId of plan) {
          if (otherId === recipeId) continue;
          const other = setup.get(otherId);
          required += rate.get(otherId) * ((other.in[item] ?? 0) - (other.out[item] ?? 0));
        }
        needed = Math.max(needed, required / net);
      }
      const previous = rate.get(recipeId);
      change = Math.max(change, Math.abs(needed - previous) / Math.max(1, needed, previous));
      rate.set(recipeId, needed);
      if (needed > 1e15) iteration = Infinity;
    }
    converged = change < 1e-12;
  }
  if (!converged) {
    warnings.push('The selected recipes form a loop that consumes more than it produces. Change a recipe to break it.');
    for (const id of plan) rate.set(id, 0);
  }
  for (const item of stuck) {
    warnings.push(`${data.items[item]?.name ?? item}: the selected recipe does not produce a net surplus of it.`);
  }

  // 4. Totals.
  const produced = {};
  const consumed = {};
  for (const recipeId of plan) {
    const s = setup.get(recipeId);
    const r = rate.get(recipeId);
    if (r <= EPS) continue;
    for (const [item, amount] of Object.entries(s.out)) produced[item] = (produced[item] ?? 0) + r * amount;
    for (const [item, amount] of Object.entries(s.in)) consumed[item] = (consumed[item] ?? 0) + r * amount;
  }

  const steps = [];
  for (const recipeId of plan) {
    const s = setup.get(recipeId);
    const r = rate.get(recipeId);
    if (r <= EPS) continue;
    const scale = (amounts) =>
      Object.entries(amounts)
        .map(([item, amount]) => ({ item, rate: r * amount }))
        .filter((entry) => entry.rate > EPS);
    const count = s.machine && s.recipe.time > 0 ? (r * s.recipe.time) / s.machine.speed : null;
    steps.push({
      recipe: recipeId,
      kind: s.recipe.kind,
      items: primaryItems.get(recipeId), // what this step is in the plan for
      crafts: r,
      machine: s.machineId,
      machineCount: count,
      power: count !== null && !s.machine.burner ? count * s.machine.power : 0, // kW, electric only
      productivity: s.productivity,
      inputs: scale(s.in),
      outputs: scale(s.out),
      depth: depth.get(recipeId),
    });
  }

  const inputs = []; // items brought in from outside the plan
  const surplus = []; // byproducts nobody consumes
  const allItems = new Set([...Object.keys(produced), ...Object.keys(consumed), ...Object.keys(targets)]);
  for (const item of allItems) {
    const balance = (produced[item] ?? 0) - (consumed[item] ?? 0) - (targets[item] ?? 0);
    const scaleRef = Math.max(produced[item] ?? 0, consumed[item] ?? 0, targets[item] ?? 0, 1);
    if (balance < -1e-7 * scaleRef) inputs.push({ item, rate: -balance });
    else if (balance > 1e-7 * scaleRef) surplus.push({ item, rate: balance });
  }
  const byName = (a, b) => (data.items[a.item]?.sort ?? a.item).localeCompare(data.items[b.item]?.sort ?? b.item);
  inputs.sort(byName);
  surplus.sort(byName);

  return {
    steps,
    inputs,
    surplus,
    warnings,
    produced,
    consumed,
    power: steps.reduce((sum, step) => sum + step.power, 0),
  };
}
