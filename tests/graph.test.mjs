import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { buildGraph, layoutGraph } from '../site/js/graph.js';
import { defaultRecipe, solve } from '../site/js/solver.js';

const load = (mode) => JSON.parse(fs.readFileSync(new URL(`../site/data/${mode}.json`, import.meta.url), 'utf8'));
const vanilla = load('vanilla');
const spaceAge = load('space-age');

function graphFor(data, item, recipes = {}) {
  const targets = { [item]: 1 };
  const result = solve(data, { targets, recipes });
  const graph = buildGraph(result, targets);
  return { result, graph, layout: layoutGraph(graph) };
}

test('edges deliver exactly what each step consumes', () => {
  const { result, graph } = graphFor(vanilla, 'rocket-silo');
  for (const step of result.steps) {
    for (const input of step.inputs) {
      const delivered = graph.edges
        .filter((edge) => edge.to === step.recipe && edge.item === input.item)
        .reduce((sum, edge) => sum + edge.rate, 0);
      assert.ok(Math.abs(delivered - input.rate) <= 1e-6 * input.rate, `${step.recipe} ${input.item}`);
    }
  }
});

test('target is marked and surplus/input nodes exist', () => {
  const { graph } = graphFor(vanilla, 'lubricant');
  assert.deepEqual(graph.nodes.filter((n) => n.target).map((n) => n.id), ['lubricant']);
  assert.ok(graph.nodes.some((n) => n.id === 'out:light-oil'));
  const raw = graphFor(vanilla, 'iron-gear-wheel', { 'iron-plate': 'raw' }).graph;
  assert.ok(raw.nodes.some((n) => n.id === 'in:iron-plate'));
});

function assertValidLayout(layout, label) {
  for (const node of layout.nodes) {
    assert.ok([node.x, node.y, node.w, node.h].every(Number.isFinite), `${label} ${node.id} position`);
    assert.ok(node.x >= 0 && node.y >= -1e-6, `${label} ${node.id} inside canvas`);
  }
  // no two nodes of a column overlap
  const columns = Map.groupBy(layout.nodes, (node) => node.col);
  for (const column of columns.values()) {
    const sorted = [...column].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i].y >= sorted[i - 1].y + sorted[i - 1].h - 1e-6, `${label} overlap ${sorted[i - 1].id} / ${sorted[i].id}`);
    }
  }
  for (const edge of layout.edges) {
    assert.ok(edge.points.length >= 2, `${label} ${edge.id} has a route`);
    assert.ok(edge.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), `${label} ${edge.id} route`);
    if (!edge.back) assert.ok(edge.points[0].x < edge.points.at(-1).x, `${label} ${edge.id} flows left to right`);
  }
}

test('layout flows left to right with the target in the last column', () => {
  const { layout } = graphFor(vanilla, 'rocket-silo');
  assertValidLayout(layout, 'rocket-silo');
  const target = layout.nodes.find((node) => node.target);
  assert.equal(target.col, Math.max(...layout.nodes.map((node) => node.col)));
});

test('loops are laid out (Kovarex)', () => {
  const { layout } = graphFor(vanilla, 'uranium-235', { 'uranium-235': 'kovarex-enrichment-process' });
  assertValidLayout(layout, 'kovarex');
});

test('every craftable item produces a valid layout in both modes', () => {
  for (const data of [vanilla, spaceAge]) {
    for (const item of Object.keys(data.items)) {
      if (!defaultRecipe(data, item)) continue;
      assertValidLayout(graphFor(data, item).layout, `${data.mode} ${item}`);
    }
  }
});
