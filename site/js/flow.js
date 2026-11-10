// Flow view: the production plan drawn as a graph. Nodes are steps, lines are
// items moving between them. Drag to pan, scroll to zoom, hover to trace a step.
import { h, icon, svg } from './dom.js';
import { buildGraph, layoutGraph } from './graph.js';

const PADDING = 48;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2;
const controllers = new WeakMap();

function pathData(edge) {
  const points = edge.points;
  const first = points[0];
  const last = points[points.length - 1];
  if (edge.back) {
    // a loop going back to an earlier column arcs over the top
    const top = Math.min(first.y, last.y) - 120;
    return `M${first.x},${first.y} C${first.x + 110},${top} ${last.x - 110},${top} ${last.x},${last.y}`;
  }
  let d = `M${first.x},${first.y}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a.y === b.y) d += ` L${b.x},${b.y}`;
    else d += ` C${(a.x + b.x) / 2},${a.y} ${(a.x + b.x) / 2},${b.y} ${b.x},${b.y}`;
  }
  return d;
}

function labelPosition(edge) {
  if (!edge.back) return edge.label;
  const first = edge.points[0];
  const last = edge.points[edge.points.length - 1];
  const top = Math.min(first.y, last.y) - 120;
  return { x: (first.x + last.x) / 2, y: (first.y + last.y + 6 * top) / 8 };
}

function controllerFor(container) {
  let controller = controllers.get(container);
  if (controller) return controller;

  const canvas = h('div', { class: 'flow-canvas' });
  const viewport = h('div', { class: 'flow-viewport' }, canvas);
  const view = { x: 0, y: 0, k: 1 };
  const apply = () => {
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  };
  const zoomAt = (factor, cx, cy) => {
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor));
    view.x = cx - ((cx - view.x) * k) / view.k;
    view.y = cy - ((cy - view.y) * k) / view.k;
    view.k = k;
    apply();
  };
  const fit = () => {
    const { clientWidth: vw, clientHeight: vh } = viewport;
    const { width, height } = controller.size;
    view.k = Math.max(MIN_ZOOM, Math.min(1.3, (vw - PADDING * 2) / width, (vh - PADDING * 2) / height));
    view.x = (vw - width * view.k) / 2;
    view.y = (vh - height * view.k) / 2;
    apply();
  };
  const zoomButton = (factor) => () => zoomAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);

  let drag = null;
  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    drag = { x: event.clientX - view.x, y: event.clientY - view.y };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('dragging');
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!drag) return;
    view.x = event.clientX - drag.x;
    view.y = event.clientY - drag.y;
    apply();
  });
  const endDrag = () => {
    drag = null;
    viewport.classList.remove('dragging');
  };
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);
  viewport.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - bounds.left, event.clientY - bounds.top);
    },
    { passive: false },
  );

  const toolbar = h(
    'div',
    { class: 'flow-toolbar' },
    h('button', { type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: zoomButton(1 / 1.25) }, '−'),
    h('button', { type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: zoomButton(1.25) }, '+'),
    h('button', { type: 'button', class: 'wide', title: 'Fit the whole graph', onclick: fit }, 'Fit'),
  );
  const root = h('div', { class: 'flow-view' }, viewport, toolbar, h('p', { class: 'flow-hint' }, 'Drag to pan · scroll to zoom · hover a step to trace it'));

  controller = { root, canvas, viewport, fit, size: { width: 1, height: 1 }, signature: null };
  // refit when the pane itself changes size (window resize, sidebar wrapping on small screens)
  let lastSize = '';
  new ResizeObserver(() => {
    const size = `${viewport.clientWidth}x${viewport.clientHeight}`;
    if (size !== lastSize && viewport.clientWidth > 0) {
      lastSize = size;
      if (controller.signature !== null) fit();
    }
  }).observe(viewport);
  controllers.set(container, controller);
  return controller;
}

/**
 * @param container  element that hosts the view (reused between renders so pan/zoom survive)
 * @param context    { data, result, targets, formatRate, formatNumber }
 */
export function renderFlow(container, { data, result, targets, formatRate, formatNumber }) {
  const controller = controllerFor(container);
  const layout = layoutGraph(buildGraph(result, targets));
  const itemOf = (id) => data.items[id] ?? { name: id };

  const related = new Map(layout.nodes.map((node) => [node.id, new Set([node.id])]));
  const elements = new Map(); // id -> [elements]
  const register = (id, element) => {
    if (!elements.has(id)) elements.set(id, []);
    elements.get(id).push(element);
    return element;
  };

  // ------------------------------------------------------------------ edges
  const rates = layout.edges.map((edge) => edge.rate);
  const minRate = Math.min(...rates);
  const maxRate = Math.max(...rates);
  const strokeWidth = (rate) =>
    maxRate > minRate ? 2 + 5 * (Math.log(rate / minRate) / Math.log(maxRate / minRate)) : 3;

  const drawing = svg('svg', { class: 'flow-edges', width: layout.width, height: layout.height });
  const labels = [];
  for (const edge of layout.edges) {
    const d = pathData(edge);
    const width = strokeWidth(edge.rate);
    register(edge.id, drawing.appendChild(svg('path', { class: 'edge', d, 'stroke-width': width })));
    register(edge.id, drawing.appendChild(svg('path', { class: 'edge-dots', d, 'stroke-width': Math.max(2, width * 0.55) })));
    const position = labelPosition(edge);
    labels.push(
      register(
        edge.id,
        h(
          'div',
          { class: 'flow-label', style: `left:${position.x}px;top:${position.y}px`, title: itemOf(edge.item).name },
          icon(itemOf(edge.item), 18),
          formatRate(edge.rate),
        ),
      ),
    );
    related.get(edge.from).add(edge.id).add(edge.to);
    related.get(edge.to).add(edge.id).add(edge.from);
  }

  // ------------------------------------------------------------------ nodes
  const stepNode = (node) => {
    const { step } = node;
    const recipe = data.recipes[step.recipe];
    const single = step.items.length === 1;
    const main = single ? itemOf(step.items[0]) : { name: recipe.name, icon: recipe.icon ?? itemOf(step.items[0]).icon };
    const primary = step.outputs.filter((out) => step.items.includes(out.item));
    const machine = step.machine ? data.machines[step.machine] : null;
    const kindLabel = { launch: 'Rocket launch', gather: 'Gathered' }[step.kind] ?? '';
    return h(
      'div',
      {
        class: `flow-node${node.target ? ' target' : ''}${step.kind === 'craft' || step.kind === 'launch' ? '' : ' source'}`,
        title: `${recipe.name}${machine && step.machineCount !== null ? `\n${formatNumber(step.machineCount)} × ${machine.name}` : ''}`,
      },
      icon(main, 40),
      h(
        'div',
        { class: 'body' },
        h('div', { class: 'title' }, main.name),
        h(
          'div',
          { class: 'rates' },
          primary.map((out) => h('span', {}, !single && icon(itemOf(out.item), 16), formatRate(out.rate))),
        ),
        h(
          'div',
          { class: 'machine' },
          machine && step.machineCount !== null
            ? [
                icon(machine, 20),
                h('strong', {}, `× ${formatNumber(Math.ceil(step.machineCount - 1e-9))}`),
                h('span', {}, machine.name),
                step.productivity > 0 && h('span', { class: 'tag' }, `+${Math.round(step.productivity * 100)}%`),
              ]
            : h('span', {}, kindLabel),
        ),
      ),
    );
  };
  const edgeNode = (node) =>
    h(
      'div',
      { class: `flow-node small ${node.type}`, title: itemOf(node.item).name },
      icon(itemOf(node.item), 32),
      h(
        'div',
        { class: 'body' },
        h('div', { class: 'title' }, itemOf(node.item).name),
        h('div', { class: 'rates' }, h('span', {}, formatRate(node.rate)), h('span', { class: 'kind' }, node.type === 'input' ? 'External input' : 'Surplus')),
      ),
    );

  const nodeElements = layout.nodes.map((node) => {
    const element = register(node.id, node.type === 'step' ? stepNode(node) : edgeNode(node));
    element.style.cssText = `left:${node.x}px;top:${node.y}px;width:${node.w}px;height:${node.h}px`;
    element.addEventListener('mouseenter', () => {
      controller.canvas.classList.add('tracing');
      for (const id of related.get(node.id)) for (const el of elements.get(id) ?? []) el.classList.add('on');
    });
    element.addEventListener('mouseleave', () => {
      controller.canvas.classList.remove('tracing');
      for (const id of related.get(node.id)) for (const el of elements.get(id) ?? []) el.classList.remove('on');
    });
    return element;
  });

  controller.canvas.style.width = `${layout.width}px`;
  controller.canvas.style.height = `${layout.height}px`;
  controller.canvas.classList.remove('tracing');
  controller.canvas.replaceChildren(drawing, ...labels, ...nodeElements);
  controller.size = { width: layout.width, height: layout.height };

  if (controller.root.parentNode !== container) container.replaceChildren(controller.root);
  // keep the user's pan/zoom while only the numbers change; refit when the graph changes shape
  const signature = layout.nodes.map((node) => node.id).sort().join('|');
  if (signature !== controller.signature) {
    controller.signature = signature;
    controller.fit();
  }
}
