// Turns a solver result into a flow graph and lays it out left to right
// by complexity level (raw materials in the first column). Pure functions, no DOM.

/**
 * Nodes are production steps, external inputs and surplus outputs.
 * Edges carry one item from the node that makes it to a node that uses it.
 */
export function buildGraph(result, targets) {
  const nodes = [];
  const edges = [];

  for (const step of result.steps) {
    nodes.push({ id: step.recipe, type: 'step', step, target: step.items.some((item) => item in targets) });
  }
  for (const entry of result.inputs) nodes.push({ id: `in:${entry.item}`, type: 'input', item: entry.item, rate: entry.rate });
  for (const entry of result.surplus) nodes.push({ id: `out:${entry.item}`, type: 'surplus', item: entry.item, rate: entry.rate });

  // item -> who supplies it and how much
  const sources = new Map();
  const addSource = (item, id, rate) => {
    if (!sources.has(item)) sources.set(item, []);
    sources.get(item).push({ id, rate });
  };
  for (const step of result.steps) for (const out of step.outputs) addSource(out.item, step.recipe, out.rate);
  for (const entry of result.inputs) addSource(entry.item, `in:${entry.item}`, entry.rate);

  const connect = (item, to, rate) => {
    const suppliers = (sources.get(item) ?? []).filter((source) => source.id !== to);
    const total = suppliers.reduce((sum, source) => sum + source.rate, 0);
    if (total <= 0) return;
    for (const source of suppliers) {
      const share = (rate * source.rate) / total;
      if (share > 1e-9) edges.push({ id: `${source.id}>${to}>${item}`, from: source.id, to, item, rate: share });
    }
  };
  for (const step of result.steps) for (const input of step.inputs) connect(input.item, step.recipe, input.rate);
  for (const entry of result.surplus) connect(entry.item, `out:${entry.item}`, entry.rate);

  return { nodes, edges };
}

const DEFAULTS = {
  nodeWidth: 244,
  stepHeight: 76,
  smallHeight: 52,
  dummyHeight: 12,
  gapX: 130,
  gapY: 22,
  dummyGap: 10,
};

/**
 * Layered (Sugiyama-style) layout.
 * Returns { width, height, nodes: [{..., x, y, w, h, col}], edges: [{..., points, label, back}] }
 * where x/y are top-left corners and points run from the source's right side to the target's left side.
 */
export function layoutGraph(graph, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const succ = new Map(graph.nodes.map((node) => [node.id, new Set()]));
  const pred = new Map(graph.nodes.map((node) => [node.id, new Set()]));
  for (const edge of graph.edges) {
    succ.get(edge.from).add(edge.to);
    pred.get(edge.to).add(edge.from);
  }

  // 1. Find back edges (loops such as Kovarex) so the rest is acyclic.
  const backPairs = new Set();
  const visitState = new Map();
  const findBackEdges = (id) => {
    visitState.set(id, 1);
    for (const next of succ.get(id)) {
      if (visitState.get(next) === 1) backPairs.add(`${id}>${next}`);
      else if (!visitState.has(next)) findBackEdges(next);
    }
    visitState.set(id, 2);
  };
  for (const node of graph.nodes) if (!visitState.has(node.id)) findBackEdges(node.id);
  const isBack = (from, to) => backPairs.has(`${from}>${to}`);

  // 2. Column = complexity level: raw materials (nothing feeding them) are in
  //    column 0, and every other node sits one column right of its deepest input.
  const layer = new Map();
  const layerOf = (id) => {
    if (layer.has(id)) return layer.get(id);
    let value = 0;
    for (const previous of pred.get(id)) if (!isBack(previous, id)) value = Math.max(value, layerOf(previous) + 1);
    layer.set(id, value);
    return value;
  };
  graph.nodes.forEach((node) => layerOf(node.id));
  const maxLayer = Math.max(0, ...layer.values());
  const colOf = (id) => layer.get(id);

  // 3. Columns, with dummy nodes where an edge skips columns.
  const columns = Array.from({ length: maxLayer + 1 }, () => []);
  const placed = new Map(); // id -> layout node
  const place = (node) => {
    placed.set(node.id, node);
    columns[node.col].push(node);
    return node;
  };
  // seed the order with a depth-first walk from the sinks so related nodes start close together
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = byId.get(id);
    place({
      ...node,
      col: colOf(id),
      w: o.nodeWidth,
      h: node.type === 'step' ? o.stepHeight : o.smallHeight,
      left: [],
      right: [],
    });
    for (const previous of pred.get(id)) walk(previous);
  };
  graph.nodes.filter((node) => succ.get(node.id).size === 0).forEach((node) => walk(node.id));
  graph.nodes.forEach((node) => walk(node.id));

  const link = (a, b) => {
    a.right.push(b);
    b.left.push(a);
  };
  const laidOutEdges = graph.edges.map((edge) => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    const back = isBack(edge.from, edge.to) || to.col <= from.col;
    const chain = [from];
    if (!back) {
      for (let col = from.col + 1; col < to.col; col++) {
        chain.push(place({ id: `${edge.id}#${col}`, type: 'dummy', col, w: o.nodeWidth, h: o.dummyHeight, left: [], right: [] }));
      }
      chain.push(to);
      for (let i = 0; i + 1 < chain.length; i++) link(chain[i], chain[i + 1]);
    } else {
      chain.push(to);
    }
    return { ...edge, back, chain };
  });

  // 4. Reduce crossings: order each column by the average position of its neighbours.
  const reindex = () => columns.forEach((column) => column.forEach((node, i) => (node.order = i)));
  reindex();
  const sweep = (column, side) => {
    for (const node of column) {
      const neighbours = node[side];
      node.weight = neighbours.length > 0 ? neighbours.reduce((sum, n) => sum + n.order, 0) / neighbours.length : node.order;
    }
    column.sort((a, b) => a.weight - b.weight || a.order - b.order);
    column.forEach((node, i) => (node.order = i));
  };
  for (let pass = 0; pass < 12; pass++) {
    for (let c = 1; c < columns.length; c++) sweep(columns[c], 'left');
    for (let c = columns.length - 2; c >= 0; c--) sweep(columns[c], 'right');
  }

  // 5. Vertical positions: start stacked, then pull nodes towards their neighbours
  //    while keeping the order and the minimum spacing.
  const spacing = (a, b) => (a.h + b.h) / 2 + (a.type === 'dummy' && b.type === 'dummy' ? o.dummyGap : o.gapY);
  for (const column of columns) {
    let y = 0;
    column.forEach((node, i) => {
      if (i > 0) y += spacing(column[i - 1], node);
      node.cy = y;
    });
    const offset = y / 2;
    column.forEach((node) => (node.cy -= offset));
  }
  const relax = (column, sides) => {
    const desired = column.map((node) => {
      const neighbours = sides.flatMap((side) => node[side]);
      return neighbours.length > 0 ? neighbours.reduce((sum, n) => sum + n.cy, 0) / neighbours.length : node.cy;
    });
    const down = [...desired];
    for (let i = 1; i < column.length; i++) down[i] = Math.max(down[i], down[i - 1] + spacing(column[i - 1], column[i]));
    const up = [...desired];
    for (let i = column.length - 2; i >= 0; i--) up[i] = Math.min(up[i], up[i + 1] - spacing(column[i], column[i + 1]));
    column.forEach((node, i) => (node.cy = (down[i] + up[i]) / 2));
  };
  for (let pass = 0; pass < 30; pass++) {
    for (let c = 1; c < columns.length; c++) relax(columns[c], ['left']);
    for (let c = columns.length - 2; c >= 0; c--) relax(columns[c], ['right']);
    for (const column of columns) relax(column, ['left', 'right']);
  }

  const top = Math.min(...[...placed.values()].map((node) => node.cy - node.h / 2));
  for (const node of placed.values()) {
    node.x = node.col * (o.nodeWidth + o.gapX);
    node.y = node.cy - node.h / 2 - top;
    node.cy -= top;
  }

  // 6. Edge routes. Edges leaving/entering a node are fanned out along its side.
  const ports = new Map(); // node id -> { out: Map(edgeId -> dy), in: Map(edgeId -> dy) }
  const fan = (node, list, side) => {
    const sorted = [...list].sort((a, b) => a.otherY - b.otherY);
    const span = Math.min(node.h * 0.55, 13 * (sorted.length - 1));
    const map = new Map();
    sorted.forEach((entry, i) => map.set(entry.edge.id, sorted.length === 1 ? 0 : -span / 2 + (i * span) / (sorted.length - 1)));
    if (!ports.has(node.id)) ports.set(node.id, {});
    ports.get(node.id)[side] = map;
  };
  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of laidOutEdges) {
    const from = edge.chain[0];
    const to = edge.chain[edge.chain.length - 1];
    if (!outgoing.has(from.id)) outgoing.set(from.id, []);
    if (!incoming.has(to.id)) incoming.set(to.id, []);
    outgoing.get(from.id).push({ edge, otherY: edge.chain[1].cy });
    incoming.get(to.id).push({ edge, otherY: edge.chain[edge.chain.length - 2].cy });
  }
  for (const [id, list] of outgoing) fan(placed.get(id), list, 'out');
  for (const [id, list] of incoming) fan(placed.get(id), list, 'in');

  const edges = laidOutEdges.map(({ chain, ...edge }) => {
    const from = chain[0];
    const to = chain[chain.length - 1];
    const points = [{ x: from.x + from.w, y: from.cy + ports.get(from.id).out.get(edge.id) }];
    for (const dummy of chain.slice(1, -1)) {
      points.push({ x: dummy.x, y: dummy.cy }, { x: dummy.x + dummy.w, y: dummy.cy });
    }
    points.push({ x: to.x, y: to.cy + ports.get(to.id).in.get(edge.id) });
    // label sits in the first gap, where the item leaves its producer
    const label = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    return { ...edge, points, label };
  });

  const nodes = [...placed.values()]
    .filter((node) => node.type !== 'dummy')
    .map(({ left, right, order, weight, cy, ...node }) => node);
  const width = Math.max(...nodes.map((node) => node.x + node.w));
  const height = Math.max(...[...placed.values()].map((node) => node.y + node.h));
  return { width, height, nodes, edges };
}
