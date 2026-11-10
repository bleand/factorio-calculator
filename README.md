# Factorio Calculator

A production calculator for [Factorio](https://www.factorio.com). Pick an item and how many you want per second
(or minute) and it lists every step down to the raw materials: how much of each resource you need, which recipe and
machine each step uses, and how many machines to build.

- **Flow view**: the whole production chain drawn as a graph with the game's icons. Raw materials on the left, your
  target on the right, animated lines showing which item moves where and at what rate. Drag to pan, scroll to zoom,
  hover a step to trace what feeds it and what it feeds.
- **Table view**: the same plan as a list, where you can change the recipe or machine of any step.
- **Base game or Space Age**: toggle between the two recipe sets.
- **Always current recipes**: the data is generated from Wube's official prototype definitions and refreshed
  automatically when a new stable Factorio version is released.
- **Your choices**: default machine tiers (assembler, furnace, mining drill), plus per-step recipe and machine
  overrides (e.g. foundry casting instead of smelting, or "supply as input" to stop the chain at an item).
- Static site, no backend. Hosted on GitHub Pages.

Not included yet: modules, beacons, quality and research bonuses (mining/recipe productivity). Machine built-in
productivity (foundry, electromagnetic plant, biochamber) is applied.

## Tech stack

| Part | Tech |
|---|---|
| Web app | Plain HTML, CSS and JavaScript ES modules. No framework, no build step. |
| Data extraction | Node.js script running Factorio's Lua prototype files in [fengari](https://fengari.io) (a Lua VM in JavaScript) |
| Tests | Node's built-in test runner (`node --test`) |
| Hosting / automation | GitHub Pages + GitHub Actions |

## Project structure

```
site/                    The deployed static site (this folder is what GitHub Pages serves)
  index.html
  styles.css
  js/app.js              UI: state, item picker, table view
  js/solver.js           Calculation engine (pure functions, also used by the tests)
  js/graph.js            Builds the flow graph from a result and lays it out (pure functions)
  js/flow.js             Flow view: renders the graph, pan/zoom, hover tracing
  js/dom.js              DOM and icon helpers
  icons/                 Item, fluid, recipe and machine icons imported from a Factorio installation
  data/vanilla.json      Generated dataset: base game
  data/space-age.json    Generated dataset: Space Age
  data/meta.json         Factorio version the data was generated from
tools/
  update-data.mjs        Fetches a Factorio release and regenerates site/data
  extract/harness.lua    Emulates Factorio's data stage inside the Lua VM
  extract/dump-raw.mjs   Runs the harness in a sandboxed VM, returns data.raw
  extract/build-dataset.mjs  Converts data.raw into the compact dataset the app loads
  extract/assets.mjs     Imports icons and English names from a local Factorio installation
  extract/names.json     Imported display names (committed, reused when no installation is available)
  serve.mjs              Zero-dependency static server for local development
tests/solver.test.mjs    Solver tests against the real datasets
tests/graph.test.mjs     Flow graph and layout tests
.github/workflows/deploy.yml   Deploys to Pages and checks daily for new Factorio releases
run.ps1 / Makefile       Operation scripts (Windows / macOS+Linux)
```

## Prerequisites

- [Node.js](https://nodejs.org) 20 or newer
- Git (only for `update-data`, which clones the Factorio data repository)
- Optional: a Factorio installation, so `update-data` can refresh icons and names (see below)

## Setup

```bash
git clone https://github.com/bleand/factorio-calculator.git
cd factorio-calculator
```

Run it (Windows):

```powershell
.\run.ps1 run
```

Run it (macOS / Linux):

```bash
make run
```

Then open http://localhost:5173. The datasets are committed, so nothing needs to be installed just to run the site.
`npm install` is only required for regenerating the data.

## Available commands

| Windows | macOS / Linux | What it does |
|---|---|---|
| `.\run.ps1 run` | `make run` | Serve the site locally (aliases: `run-local`, `run-frontend`) |
| `.\run.ps1 run-frontend-debug` | `make run-frontend-debug` | Serve with the Node inspector enabled |
| `.\run.ps1 update-data` | `make update-data` | Regenerate `site/data` from the latest stable Factorio release |
| `.\run.ps1 update-data -Force` | `make update-data ARGS=--force` | Rebuild even if the version is unchanged |
| `.\run.ps1 update-data -Version 2.1.24` | `make update-data ARGS="--version 2.1.24"` | Use a specific release |
| `.\run.ps1 test` | `make test` | Run the solver tests |
| `.\run.ps1 install` | `make install` | Install dev dependencies |

`-Port <n>` / `PORT=<n>` changes the local port. There is no backend and no Docker setup, so `run-backend` and
`run-docker` do not apply.

## Environment variables

None are required.

| Variable | Purpose |
|---|---|
| `PORT` | Port of the local server (default 5173) |
| `FACTORIO_PATH` | Factorio installation folder used by `update-data` for icons and names, if it is not in a standard Steam location |

## Deployment (GitHub Pages)

One-time setup in the GitHub repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

After that, `.github/workflows/deploy.yml` handles everything:

- **Push to `main`**: runs the tests and deploys `site/`.
- **Daily (05:17 UTC)**: asks `factorio.com/api/latest-releases` for the latest stable version. If it differs from
  `site/data/meta.json`, the data is regenerated, tested, committed and deployed.
- **Manually**: *Actions → Update data and deploy → Run workflow* (optionally with *force*).

GitHub pauses scheduled workflows in repositories with no activity for 60 days; re-enable it from the Actions tab if
that happens.

## Architecture notes

### Where the recipes come from

Wube publishes the game's prototype definitions (the Lua "data stage" files) at
[wube/factorio-data](https://github.com/wube/factorio-data), tagged for every release. Rather than depending on a
third-party recipe dump, `tools/update-data.mjs`:

1. Checks out the tag for the requested version.
2. Runs the real `data.lua` / `data-updates.lua` files of `core` + `base` (and `elevated-rails`, `recycler`,
   `quality`, `space-age` for Space Age) inside a Lua VM. `harness.lua` provides the few engine globals those files
   expect (`data:extend`, `require`, `defines`, `mods`, `feature_flags`...).
3. Converts the resulting `data.raw` into a small JSON dataset: items, recipes, machines, modules and beacons.

The Lua VM is sandboxed: no `io`, `os` or `package` libraries, and file access is limited to reading `.lua` files
inside the checked-out data directory.

Things the public data repository does not contain, and how they are handled:

- **Sprite layouts and sounds**: stubbed while running the data stage, since they are irrelevant to the calculator.
- **Icons and locale files**: imported from a local Factorio installation (see below).
- **Engine-generated recipes** (barrelling, recycling): not present, which is fine for a production calculator.

### Icons and names

`update-data` looks for a Factorio installation (standard Steam folders, `--factorio <path>` or `FACTORIO_PATH`).
When it finds one it copies the icons referenced by the prototypes into `site/icons/` and writes the English names
to `tools/extract/names.json`. Both are committed.

The daily GitHub Actions run has no installation, so it reuses the committed copies. Recipes and numbers are always
current, but an item added by a new Factorio version shows a letter tile and a name derived from its id (for example
"Iron gear wheel" from `iron-gear-wheel`) until someone runs `update-data` locally and commits the result.

Icon files contain the 64px sprite followed by its mipmaps (120×64), so the app crops each one to its left square.

### Flow view (`site/js/graph.js`, `site/js/flow.js`)

The graph has one node per production step, plus nodes for external inputs and surplus byproducts. An edge carries
one item from the step that makes it to a step that uses it; when several steps make the same item, each consumer's
demand is split between them in proportion to their output.

Layout is a small layered (Sugiyama-style) algorithm written for this project, with no dependencies:

1. Loops (Kovarex and similar) are detected and their back edges set aside.
2. Each node's column is its longest distance to the target, so everything flows left to right.
3. Edges that skip columns get invisible waypoints so they route around nodes instead of through them.
4. Columns are reordered by neighbour position to reduce crossings, then nodes are pulled vertically towards their
   neighbours while keeping a minimum spacing.

Line thickness is on a log scale of the rate. Nodes are HTML and lines are SVG inside one container that is moved
and scaled with a CSS transform for pan and zoom.

Besides the crafting recipes, the dataset contains pseudo recipes so that everything is uniform for the solver:
`mine:*` (resources, with mining time and drill speed), `pump:*` (offshore pumps), `collect:*` / `harvest:*`
(asteroid chunks, plants) and `launch:*` (rocket launch products such as base-game space science).

### How the calculation works (`site/js/solver.js`)

1. **Plan**: starting from the target, each item gets one *primary* recipe: your override, or a default chosen by a
   heuristic (the item's own recipe, then mining/pumping, then the most direct alternative; oil products have
   explicit defaults). Its ingredients are followed recursively. Items with no recipe, or marked "supply as input",
   end the chain.
2. **Yields**: each recipe gets a machine (default tier or override); outputs include the machine's built-in
   productivity.
3. **Solve**: recipe rates are found by Gauss-Seidel iteration so that every produced item covers its demand.
   Byproducts of other recipes in the plan are credited (advanced oil processing, uranium processing), and loops
   such as Kovarex enrichment converge naturally. A loop that consumes more than it produces is reported.
4. **Report**: machines = crafts/s × recipe time ÷ machine speed. Unused byproducts are listed as surplus.

The solver does not optimise across alternative recipes (no linear programming): the result follows the selected
recipes exactly, which keeps it predictable. Balancing oil products through cracking is therefore a manual choice.

### State

Selections are stored in the browser's `localStorage`, separately for the base game and Space Age.

## Disclaimer

Not affiliated with Wube Software. Factorio, its data, names and icons are © Wube Software; the icons in
`site/icons/` are game assets included for identification only.
