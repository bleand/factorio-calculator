// Small DOM helpers shared by the views.

export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    if (key === 'class') element.className = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    element.append(child.nodeType ? child : document.createTextNode(child));
  }
  return element;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg(tag, props = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(props)) if (value != null) element.setAttribute(key, value);
  return element;
}

/**
 * A Factorio icon. Icon files are 64px sprites followed by their mipmaps, so
 * the image is cropped to its leftmost square. Falls back to a letter tile.
 */
export function icon(entry, size = 32) {
  const style = `width:${size}px;height:${size}px`;
  if (!entry?.icon) {
    return h('span', { class: 'icon icon-missing', style: `${style};font-size:${Math.round(size * 0.5)}px` }, (entry?.name ?? '?').charAt(0));
  }
  return h(
    'span',
    { class: 'icon', style },
    h('img', { src: `icons/${entry.icon}`, alt: '', loading: 'lazy', draggable: 'false' }),
  );
}
