import { h, icon } from './dom.js';
import { renderFlow } from './flow.js';
import { RAW, defaultMachine, defaultPrefs, defaultRecipe, machineFamilies, machinesFor, recipesFor, solve } from './solver.js';

const STORAGE_KEY = 'factorio-calculator:v1';
const DEFAULT_TARGET = 'automation-science-pack';
const EXTRACTION = new Set(['mine', 'pump', 'gather']);

const $ = (id) => document.getElementById(id);
const datasets = new Map();

const state = {
  mode: 'vanilla',
  rate: 1,
  unit: 's',
  view: 'flow', // 'flow' | 'table'
  // per game mode: { target, recipes: {item: recipe|RAW}, machines: {recipe: machine}, prefs: {assembler, furnace, drill} }
  perMode: {},
  ...loadState(),
};
let data = null;

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}

function modeState() {
  const current = (state.perMode[state.mode] ??= {});
  current.recipes ??= {};
  current.machines ??= {};
  current.prefs = { ...defaultPrefs(data), ...current.prefs };
  if (!data.items[current.target] || recipesFor(data, current.target).length === 0) current.target = DEFAULT_TARGET;
  return current;
}

// ------------------------------------------------------------------ helpers
function formatNumber(value) {
  if (!Number.isFinite(value)) return '–';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs < 0.001) return value.toPrecision(2);
  const digits = abs >= 100 ? 1 : abs >= 1 ? 2 : 3;
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

const unitFactor = () => (state.unit === 'min' ? 60 : 1);
const unitLabel = () => (state.unit === 'min' ? '/min' : '/s');
const formatRate = (perSecond) => `${formatNumber(perSecond * unitFactor())}${unitLabel()}`;
const formatPower = (kw) => (kw >= 1000 ? `${formatNumber(kw / 1000)} MW` : `${formatNumber(kw)} kW`);
const itemName = (id) => data.items[id]?.name ?? id;

function setSegmented(container, value, onChange) {
  for (const button of container.querySelectorAll('button')) {
    button.setAttribute('aria-checked', String(button.dataset.value === value));
    button.onclick = () => onChange(button.dataset.value);
  }
}

// ----------------------------------------------------------------- sidebar
function renderSidebar() {
  const current = modeState();

  setSegmented($('mode'), state.mode, (mode) => switchMode(mode));
  setSegmented($('unit'), state.unit, (unit) => {
    // keep the same real production rate when switching units
    state.unit = unit;
    update();
  });

  if (document.activeElement !== $('rate')) $('rate').value = Number((state.rate * unitFactor()).toPrecision(10));
  if (document.activeElement !== $('item-search')) $('item-search').value = itemName(current.target);

  const families = machineFamilies(data);
  for (const key of ['assembler', 'furnace', 'drill']) {
    const select = $(`pref-${key}`);
    select.replaceChildren(
      ...families[key].map((id) => h('option', { value: id, selected: id === current.prefs[key] }, data.machines[id].name)),
    );
    select.onchange = () => {
      current.prefs[key] = select.value;
      update();
    };
  }

  const hasOverrides = Object.keys(current.recipes).length + Object.keys(current.machines).length > 0;
  $('reset').hidden = !hasOverrides;
  $('reset').onclick = () => {
    current.recipes = {};
    current.machines = {};
    update();
  };
}

// Item picker ---------------------------------------------------------------
let pickerItems = [];
let pickerMatches = [];
let pickerIndex = 0;

function setupPicker() {
  const input = $('item-search');
  const listbox = $('item-list');

  const close = () => {
    listbox.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  };
  const choose = (id) => {
    modeState().target = id;
    close();
    input.blur();
    update();
  };
  const render = () => {
    const query = input.value.trim().toLowerCase();
    const selectedName = itemName(modeState().target).toLowerCase();
    const filtering = query && query !== selectedName;
    pickerMatches = filtering
      ? pickerItems.filter((id) => itemName(id).toLowerCase().includes(query) || id.includes(query))
      : pickerItems;
    pickerIndex = Math.min(pickerIndex, Math.max(0, pickerMatches.length - 1));
    listbox.replaceChildren(
      ...(pickerMatches.length === 0
        ? [h('li', { class: 'empty' }, 'No matching items')]
        : pickerMatches.map((id, i) =>
            h(
              'li',
              {
                role: 'option',
                'aria-selected': String(i === pickerIndex),
                onmousedown: (event) => {
                  event.preventDefault();
                  choose(id);
                },
              },
              icon(data.items[id], 24),
              h('span', {}, itemName(id)),
            ),
          )),
    );
    listbox.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    listbox.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('focus', () => {
    input.select();
    pickerIndex = Math.max(0, pickerItems.indexOf(modeState().target));
    render();
  });
  input.addEventListener('input', () => {
    pickerIndex = 0;
    render();
  });
  input.addEventListener('blur', () => {
    close();
    input.value = itemName(modeState().target);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      pickerIndex = Math.max(0, Math.min(pickerMatches.length - 1, pickerIndex + step));
      render();
    } else if (event.key === 'Enter' && pickerMatches[pickerIndex]) {
      choose(pickerMatches[pickerIndex]);
    } else if (event.key === 'Escape') {
      input.blur();
    }
  });

  $('rate').addEventListener('input', () => {
    const value = Number($('rate').value);
    if (!Number.isFinite(value) || value < 0) return;
    state.rate = value / unitFactor();
    update();
  });
}

// ----------------------------------------------------------------- results
const flowHost = h('div', { class: 'flow-host' });

function flow(entry, minor, tag) {
  return h(
    'div',
    { class: `flow${minor ? ' minor' : ''}` },
    icon(data.items[entry.item], 24),
    h('span', { class: 'name' }, itemName(entry.item), tag && h('span', { class: 'tag' }, tag)),
    h('span', { class: 'amount' }, formatRate(entry.rate)),
  );
}

// "How is this item obtained" selector: every recipe that makes it, or external input.
function recipeSelect(item, activeRecipe) {
  const current = modeState();
  const options = recipesFor(data, item);
  const fallback = defaultRecipe(data, item);
  const value = activeRecipe ?? RAW;
  const select = h(
    'select',
    {
      class: (activeRecipe ?? null) !== fallback ? 'changed' : '',
      'aria-label': `Recipe for ${itemName(item)}`,
      onchange: () => {
        const chosen = select.value === RAW ? RAW : select.value;
        if ((chosen === RAW ? null : chosen) === fallback) delete current.recipes[item];
        else current.recipes[item] = chosen;
        update();
      },
    },
    options.map((id) => h('option', { value: id, selected: id === value }, data.recipes[id].name)),
    h('option', { value: RAW, selected: value === RAW }, 'Supply as input'),
  );
  return select;
}

function machineCell(step) {
  if (!step?.machine) return h('span', { class: 'dash' }, '–');
  const current = modeState();
  const candidates = machinesFor(data, step.recipe);
  const machineIcon = icon(data.machines[step.machine], 24);
  if (candidates.length === 1) return h('div', { class: 'with-icon' }, machineIcon, h('span', { class: 'static' }, data.machines[step.machine].name));
  const fallback = defaultMachine(data, step.recipe, current.prefs);
  const select = h(
    'select',
    {
      class: step.machine !== fallback ? 'changed' : '',
      'aria-label': `Machine for ${data.recipes[step.recipe].name}`,
      onchange: () => {
        if (select.value === fallback) delete current.machines[step.recipe];
        else current.machines[step.recipe] = select.value;
        update();
      },
    },
    candidates.map((id) => h('option', { value: id, selected: id === step.machine }, data.machines[id].name)),
  );
  return h('div', { class: 'with-icon' }, machineIcon, select);
}

function countCell(step) {
  if (!step || step.machineCount === null) return h('span', { class: 'dash' }, '–');
  const whole = Math.ceil(step.machineCount - 1e-9);
  return [
    h('span', { class: 'count' }, formatNumber(whole)),
    h('span', { class: 'exact' }, `${formatNumber(step.machineCount)} exact`),
  ];
}

function stepRow(step) {
  const primary = new Set(step.items);
  const outputs = [...step.outputs].sort((a, b) => Number(primary.has(b.item)) - Number(primary.has(a.item)));
  return h(
    'tr',
    {},
    h('td', {}, outputs.map((entry) => flow(entry, !primary.has(entry.item), !primary.has(entry.item) && 'byproduct'))),
    h(
      'td',
      {},
      step.items.map((item) =>
        h(
          'div',
          { class: 'choice' },
          step.items.length > 1 && h('span', { class: 'choice-label' }, itemName(item)),
          recipeSelect(item, step.recipe),
        ),
      ),
    ),
    h(
      'td',
      {},
      step.inputs.length > 0 ? step.inputs.map((entry) => flow(entry, true)) : h('span', { class: 'dash' }, '–'),
    ),
    h('td', {}, machineCell(step), step.productivity > 0 && h('span', { class: 'tag' }, `+${Math.round(step.productivity * 100)}% prod`)),
    h('td', { class: 'num' }, countCell(step)),
  );
}

function inputRow(entry) {
  const hasRecipes = recipesFor(data, entry.item).length > 0;
  return h(
    'tr',
    {},
    h('td', {}, flow(entry, false)),
    h('td', {}, hasRecipes ? recipeSelect(entry.item, null) : h('span', { class: 'static' }, 'External input')),
    h('td', {}, h('span', { class: 'dash' }, '–')),
    h('td', {}, h('span', { class: 'dash' }, '–')),
    h('td', { class: 'num' }, h('span', { class: 'dash' }, '–')),
  );
}

function table(headers, rows) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, headers.map((label, i) => h('th', { class: i === headers.length - 1 ? 'num' : '' }, label)))),
      h('tbody', {}, rows),
    ),
  );
}

function renderResults() {
  const current = modeState();
  const root = $('results');

  if (!(state.rate > 0)) {
    root.replaceChildren(h('p', { class: 'empty-state' }, 'Enter an amount greater than zero.'));
    return;
  }

  const result = solve(data, {
    targets: { [current.target]: state.rate },
    recipes: current.recipes,
    machines: current.machines,
    prefs: current.prefs,
  });

  const production = result.steps.filter((step) => !EXTRACTION.has(step.kind));
  const extraction = result.steps.filter((step) => EXTRACTION.has(step.kind));
  const machineTotal = result.steps.reduce(
    (sum, step) => sum + (step.machineCount === null ? 0 : Math.ceil(step.machineCount - 1e-9)),
    0,
  );
  const stat = (value, label) => h('div', { class: 'stat' }, h('span', { class: 'value' }, value), h('span', { class: 'label' }, label));

  const viewButton = (value, label) =>
    h(
      'button',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': String(state.view === value),
        onclick: () => {
          state.view = value;
          update();
        },
      },
      label,
    );
  const viewToggle = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'View' }, viewButton('flow', 'Flow'), viewButton('table', 'Table'));

  const content = [
    h(
      'div',
      { class: 'summary' },
      h('h2', {}, icon(data.items[current.target], 36), `${formatRate(state.rate)} ${itemName(current.target)}`),
      h(
        'div',
        { class: 'stats' },
        stat(formatNumber(machineTotal), 'machines'),
        stat(formatPower(result.power), 'electric power'),
        stat(String(result.steps.length), 'steps'),
        viewToggle,
      ),
    ),
    result.warnings.map((message) => h('p', { class: 'notice', role: 'alert' }, message)),
  ];
  if (state.view === 'flow') {
    root.replaceChildren(...content.flat().filter(Boolean), flowHost);
    renderFlow(flowHost, {
      data,
      result,
      targets: { [current.target]: state.rate },
      formatRate,
      formatNumber,
    });
    return;
  }
  content.push(
    h(
      'section',
      { class: 'block' },
      h('h3', {}, 'Raw materials', h('small', {}, 'what the factory takes in')),
      extraction.length + result.inputs.length === 0
        ? h('p', { class: 'meta' }, 'Nothing: every input is produced by a step below.')
        : table(['Resource', 'Source', 'Consumes', 'Machine', 'Count'], [
            ...extraction.map(stepRow),
            ...result.inputs.map(inputRow),
          ]),
    ),
    production.length > 0 &&
      h(
        'section',
        { class: 'block' },
        h('h3', {}, 'Production steps', h('small', {}, 'from the target down to raw materials')),
        table(['Produces', 'Recipe', 'Consumes', 'Machine', 'Count'], production.map(stepRow)),
      ),
    result.surplus.length > 0 &&
      h(
        'section',
        { class: 'block' },
        h('h3', {}, 'Surplus byproducts', h('small', {}, 'made but not used: needs storage or another consumer')),
        h(
          'div',
          { class: 'table-wrap' },
          h('table', { class: 'compact' }, h('tbody', {}, result.surplus.map((entry) => h('tr', {}, h('td', {}, flow(entry, false)))))),
        ),
      ),
  );
  root.replaceChildren(...content.flat().filter(Boolean));
}

// --------------------------------------------------------------------- app
function update() {
  saveState();
  renderSidebar();
  renderResults();
}

async function loadDataset(mode) {
  if (!datasets.has(mode)) {
    const response = await fetch(`data/${mode}.json`);
    if (!response.ok) throw new Error(`Could not load data/${mode}.json (${response.status})`);
    datasets.set(mode, await response.json());
  }
  return datasets.get(mode);
}

async function switchMode(mode) {
  try {
    data = await loadDataset(mode);
  } catch (error) {
    $('results').replaceChildren(h('p', { class: 'notice', role: 'alert' }, error.message));
    return;
  }
  state.mode = mode;
  pickerItems = Object.keys(data.items)
    .filter((id) => !data.items[id].hidden && recipesFor(data, id).length > 0)
    .sort((a, b) => data.items[a].sort.localeCompare(data.items[b].sort));
  $('data-version').textContent = `Recipes from Factorio ${data.version}`;
  update();
}

setupPicker();
switchMode(state.mode === 'space-age' ? 'space-age' : 'vanilla');
