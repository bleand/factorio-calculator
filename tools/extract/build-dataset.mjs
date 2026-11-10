// Turns the raw prototype dump into the compact dataset the web app loads.
//
// Dataset shape (all rates are per craft, the app turns them into per second):
//   items    { id: { name, icon?, fluid?, hidden?, sort } }     icon is relative to site/icons
//   recipes  { id: { name, kind, cats, time, in: {item: amount}, out: {item: [amount, productiveAmount]}, prod, maxProd } }
//            kind is "craft" | "mine" | "pump" | "gather" | "launch"
//   machines { id: { name, kind, speed, cats, slots, baseProd, power, burner, effects } }
//   modules  { id: { name, category, tier, effect } }
//   beacons  { id: { name, slots, effectivity, effects, power } }

const ITEM_TYPES = [
  'item', 'ammo', 'capsule', 'gun', 'item-with-entity-data', 'item-with-label', 'item-with-inventory',
  'item-with-tags', 'module', 'rail-planner', 'spidertron-remote', 'tool', 'armor', 'repair-tool',
  'space-platform-starter-pack', 'selection-tool', 'blueprint', 'blueprint-book', 'copy-paste-tool',
  'deconstruction-item', 'upgrade-item',
];

// The data stage encodes empty Lua tables as {} - normalise anything list-like.
const list = (v) => (Array.isArray(v) ? v : []);

// The public data repository ships no locale files, so display names are
// derived from the internal ids ("iron-gear-wheel" -> "Iron gear wheel").
export function humanize(id) {
  const text = id.replace(/-/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function parsePowerKw(value) {
  const match = /^([\d.]+)\s*([kMGT]?)W$/.exec(value ?? '');
  if (!match) return 0;
  return Number(match[1]) * { '': 0.001, k: 1, M: 1e3, G: 1e6, T: 1e9 }[match[2]];
}

// Expected amount of a recipe product, and the part of it that productivity multiplies.
function productAmounts(product) {
  let probability = product.probability ?? 1;
  if (product.shared_probability) probability = product.shared_probability.max - product.shared_probability.min;
  const base = product.amount ?? ((product.amount_min ?? 0) + (product.amount_max ?? 0)) / 2;
  const amount = probability * base + (product.extra_count_fraction ?? 0);
  const productive = probability * Math.max(0, base - (product.ignored_by_productivity ?? 0));
  return [amount, productive];
}

const round = (n) => Number(n.toPrecision(12));

function addTo(map, key, amount) {
  map[key] = round((map[key] ?? 0) + amount);
}

function addProduct(out, product) {
  const [amount, productive] = productAmounts(product);
  const current = out[product.name] ?? [0, 0];
  out[product.name] = [round(current[0] + amount), round(current[1] + productive)];
}

export function buildDataset(raw, { mode, version, names = {}, resolveIcon = () => undefined }) {
  // Real in-game names when a locale import is available, derived names otherwise.
  const localised = (section, id) => (id ? names[section]?.[id] : undefined);
  const itemName = (proto) =>
    localised('item-name', proto.name) ??
    localised('entity-name', proto.place_result) ??
    localised('entity-name', proto.name) ??
    localised('equipment-name', proto.place_as_equipment_result) ??
    localised('equipment-name', proto.name) ??
    humanize(proto.name);
  const entityName = (id) => localised('entity-name', id) ?? localised('item-name', id) ?? humanize(id);
  const iconOf = (proto) => resolveIcon(proto.icon ?? list(proto.icons)[0]?.icon);
  const withIcon = (object, proto) => {
    const icon = iconOf(proto);
    if (icon) object.icon = icon;
    return object;
  };
  const nameOf = (id) => items[id]?.name ?? humanize(id);

  const items = {};
  const recipes = {};
  const machines = {};
  const modules = {};
  const beacons = {};

  // ------------------------------------------------------------------ items
  const groups = raw['item-group'] ?? {};
  const subgroups = raw['item-subgroup'] ?? {};
  const sortKey = (proto, fallbackSubgroup) => {
    const subgroup = subgroups[proto.subgroup ?? fallbackSubgroup] ?? {};
    const group = groups[subgroup.group] ?? {};
    return [group.order ?? 'zz', subgroup.order ?? 'zz', proto.order ?? proto.name].join('|');
  };
  for (const type of ITEM_TYPES) {
    for (const proto of Object.values(raw[type] ?? {})) {
      if (proto.parameter) continue;
      items[proto.name] = withIcon({ name: itemName(proto), sort: sortKey(proto, 'other') }, proto);
      if (proto.hidden) items[proto.name].hidden = true;
    }
  }
  for (const proto of Object.values(raw.fluid ?? {})) {
    if (proto.parameter) continue;
    items[proto.name] = withIcon(
      { name: localised('fluid-name', proto.name) ?? humanize(proto.name), fluid: true, sort: sortKey(proto, 'fluid') },
      proto,
    );
    if (proto.hidden) items[proto.name].hidden = true;
  }

  // ---------------------------------------------------------------- recipes
  for (const proto of Object.values(raw.recipe ?? {})) {
    const cats = list(proto.categories ?? (proto.category ? [proto.category] : ['crafting'])).filter(
      (c) => c !== 'hand-crafting',
    );
    if (proto.hidden || proto.parameter || cats.includes('parameters') || cats.length === 0) continue;
    const results = list(proto.results);
    const mainProduct = proto.main_product || (results.length === 1 ? results[0].name : undefined);
    const recipe = {
      name: localised('recipe-name', proto.name) ?? (mainProduct && items[mainProduct]?.name) ?? humanize(proto.name),
      kind: 'craft',
      cats,
      time: proto.energy_required ?? 0.5,
      in: {},
      out: {},
      prod: Boolean(proto.allow_productivity),
      maxProd: proto.maximum_productivity ?? 3,
    };
    for (const ingredient of list(proto.ingredients)) addTo(recipe.in, ingredient.name, ingredient.amount);
    for (const product of results) addProduct(recipe.out, product);
    if (Object.keys(recipe.out).length === 0) continue;
    recipes[proto.name] = withIcon(recipe, proto);
  }

  // Mining: one pseudo recipe per resource entity.
  for (const proto of Object.values(raw.resource ?? {})) {
    const minable = proto.minable;
    if (!minable) continue;
    const recipe = {
      name: `${entityName(proto.name)} (mining)`,
      kind: 'mine',
      cats: [`mining:${proto.category ?? 'basic-solid'}`],
      time: minable.mining_time ?? 1,
      in: {},
      out: {},
      prod: true,
      maxProd: 1e9,
    };
    // required fluid is specified per 10 mining operations
    if (minable.required_fluid) addTo(recipe.in, minable.required_fluid, (minable.fluid_amount ?? 0) / 10);
    if (minable.result) addProduct(recipe.out, { name: minable.result, amount: minable.count ?? 1 });
    for (const product of list(minable.results)) addProduct(recipe.out, product);
    if (Object.keys(recipe.out).length === 0) continue;
    recipes[`mine:${proto.name}`] = recipe;
  }

  // Offshore pumping: one pseudo recipe per fluid that exists as a tile.
  const pumps = Object.values(raw['offshore-pump'] ?? {});
  if (pumps.length > 0) {
    const fluids = new Set(Object.values(raw.tile ?? {}).map((t) => t.fluid).filter(Boolean));
    for (const fluid of [...fluids].sort()) {
      recipes[`pump:${fluid}`] = {
        name: `${nameOf(fluid)} (offshore pump)`,
        kind: 'pump',
        cats: ['pumping'],
        time: 1,
        in: {},
        out: { [fluid]: [1, 0] },
        prod: false,
        maxProd: 0,
      };
    }
  }

  // Things gathered rather than crafted: asteroid chunks and harvested plants.
  // They have no meaningful per-machine rate, so they are plain sources.
  const gather = (id, name, out) => {
    recipes[id] = { name, kind: 'gather', cats: ['gathering'], time: 0, in: {}, out, prod: false, maxProd: 0 };
  };
  for (const proto of Object.values(raw['asteroid-chunk'] ?? {})) {
    if (proto.parameter || proto.hidden || !items[proto.name]) continue;
    gather(`collect:${proto.name}`, `${nameOf(proto.name)} (asteroid collector)`, { [proto.name]: [1, 0] });
  }
  for (const proto of Object.values(raw.plant ?? {})) {
    const out = {};
    for (const product of list(proto.minable?.results)) if (items[product.name]) addProduct(out, { ...product, ignored_by_productivity: 1e9 });
    if (proto.minable?.result && items[proto.minable.result]) out[proto.minable.result] = [proto.minable.count ?? 1, 0];
    if (Object.keys(out).length > 0) gather(`harvest:${proto.name}`, `${entityName(proto.name)} (harvest)`, out);
  }

  // Rocket launches that turn cargo into products (space science in the base game).
  const silo = Object.values(raw['rocket-silo'] ?? {})[0];
  for (const type of ITEM_TYPES) {
    for (const proto of Object.values(raw[type] ?? {})) {
      const products = list(proto.rocket_launch_products);
      if (products.length === 0 || !silo) continue;
      const recipe = {
        name: `${nameOf(proto.name)} (rocket launch)`,
        kind: 'launch',
        cats: ['rocket-launch'],
        time: 0,
        in: { [proto.name]: 1, 'rocket-part': silo.rocket_parts_required ?? 100 },
        out: {},
        prod: false,
        maxProd: 0,
      };
      for (const product of products) addProduct(recipe.out, product);
      recipes[`launch:${proto.name}`] = recipe;
    }
  }

  // --------------------------------------------------------------- machines
  const effectsOf = (proto) => {
    if (proto.effect_receiver?.uses_module_effects === false) return [];
    return list(proto.allowed_effects ?? ['consumption', 'speed', 'productivity', 'pollution', 'quality']);
  };
  const common = (proto) => withIcon({
    name: entityName(proto.name),
    slots: proto.module_slots ?? 0,
    baseProd: proto.effect_receiver?.base_effect?.productivity ?? 0,
    power: parsePowerKw(proto.energy_usage),
    burner: proto.energy_source?.type === 'burner',
    effects: effectsOf(proto),
  }, proto);
  for (const type of ['assembling-machine', 'furnace', 'rocket-silo']) {
    for (const proto of Object.values(raw[type] ?? {})) {
      if (proto.hidden) continue;
      machines[proto.name] = {
        ...common(proto),
        kind: 'crafter',
        speed: proto.crafting_speed,
        cats: list(proto.crafting_categories),
      };
    }
  }
  for (const proto of Object.values(raw['mining-drill'] ?? {})) {
    if (proto.hidden) continue;
    machines[proto.name] = {
      ...common(proto),
      kind: 'drill',
      speed: proto.mining_speed,
      cats: list(proto.resource_categories).map((c) => `mining:${c}`),
    };
  }
  for (const proto of pumps) {
    machines[proto.name] = {
      ...common(proto),
      kind: 'pump',
      speed: (proto.pumping_speed ?? 20) * 60, // per tick -> per second
      cats: ['pumping'],
      power: 0,
      effects: [],
    };
  }

  // ------------------------------------------------------- modules, beacons
  for (const proto of Object.values(raw.module ?? {})) {
    if (proto.hidden) continue;
    modules[proto.name] = {
      name: itemName(proto),
      icon: iconOf(proto),
      category: proto.category,
      tier: proto.tier ?? 1,
      effect: proto.effect ?? {},
    };
  }
  for (const proto of Object.values(raw.beacon ?? {})) {
    if (proto.hidden) continue;
    beacons[proto.name] = {
      name: entityName(proto.name),
      icon: iconOf(proto),
      slots: proto.module_slots ?? 0,
      effectivity: proto.distribution_effectivity ?? 1,
      profile: list(proto.profile).slice(0, 16),
      effects: list(proto.allowed_effects),
      power: parsePowerKw(proto.energy_usage),
    };
  }

  // Every item a recipe mentions must exist, and unused prototypes are dropped.
  const used = new Set();
  for (const recipe of Object.values(recipes)) {
    for (const id of [...Object.keys(recipe.in), ...Object.keys(recipe.out)]) {
      used.add(id);
      items[id] ??= { name: humanize(id), sort: `zz|zz|${id}`, hidden: true };
    }
  }
  for (const id of Object.keys(items)) if (!used.has(id)) delete items[id];

  return { version, mode, items, recipes, machines, modules, beacons };
}
