import { ensureCdpDomains } from './cdp.js';

const INTERESTING_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'tab',
  'menuitem',
  'switch',
  'heading',
  'spinbutton',
  'slider'
]);

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(value, maxChars) {
  const text = cleanText(value);
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return text.slice(0, maxChars - 3) + '...';
}

function getAxValue(axValue) {
  if (!axValue || typeof axValue !== 'object') return '';
  if ('value' in axValue) return String(axValue.value ?? '');
  return '';
}

function getProperty(node, name) {
  const props = Array.isArray(node?.properties) ? node.properties : [];
  for (const prop of props) {
    if (!prop || prop.name !== name) continue;
    return prop.value;
  }
  return null;
}

function getBoolProperty(node, name) {
  const v = getProperty(node, name);
  if (!v || typeof v !== 'object') return null;
  if (v.type === 'boolean') return Boolean(v.value);
  if (typeof v.value === 'boolean') return Boolean(v.value);
  return null;
}

function isInteresting(node) {
  const role = cleanText(getAxValue(node?.role)).toLowerCase();
  if (!role) return false;
  if (INTERESTING_ROLES.has(role)) return true;

  // Some sites use generic roles but still expose a useful name.
  const name = cleanText(getAxValue(node?.name));
  if (name && role !== 'generic' && role !== 'group') return true;
  return false;
}

export async function takeA11ySnapshot(page, opts = {}) {
  const {
    interestingOnly = true,
    maxNodes = 400,
    maxNameChars = 120,
    query = null,
    maxDepth = 24
  } = opts;

  const session = await ensureCdpDomains(page, ['Accessibility']);
  const response = await session.send('Accessibility.getFullAXTree');
  const nodes = Array.isArray(response?.nodes) ? response.nodes : [];

  const q = query ? cleanText(query).toLowerCase() : null;
  const depthLimit = typeof maxDepth === 'number' && maxDepth > 0 ? maxDepth : 24;

  const childIds = new Set();
  for (const node of nodes) {
    const children = Array.isArray(node?.childIds) ? node.childIds : [];
    for (const childId of children) childIds.add(childId);
  }

  const roots = nodes
    .filter((node) => node && !childIds.has(node.nodeId))
    .map((node) => node.nodeId);

  const nodeById = new Map();
  for (const node of nodes) {
    if (!node || typeof node.nodeId === 'undefined') continue;
    nodeById.set(node.nodeId, node);
  }

  const depthByNodeId = new Map();
  const queue = [];
  for (const rootId of roots) queue.push({ id: rootId, depth: 0 });
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const { id, depth } = current;
    if (depthByNodeId.has(id)) continue;
    depthByNodeId.set(id, depth);
    const node = nodeById.get(id);
    const children = Array.isArray(node?.childIds) ? node.childIds : [];
    for (const childId of children) {
      queue.push({ id: childId, depth: depth + 1 });
    }
  }

  const out = [];
  const uidToBackend = new Map();
  let truncated = false;

  for (const node of nodes) {
    if (!node || node.ignored) continue;
    const depth = depthByNodeId.get(node.nodeId) ?? 0;
    if (depth > depthLimit) continue;
    if (interestingOnly && !isInteresting(node)) continue;

    const role = cleanText(getAxValue(node.role)).toLowerCase();
    const name = truncateText(getAxValue(node.name), maxNameChars);
    if (q && !name.toLowerCase().includes(q)) continue;

    const uid = `ax-${String(node.nodeId)}`;
    const backendDOMNodeId = typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : null;
    if (backendDOMNodeId) uidToBackend.set(uid, backendDOMNodeId);

    const checked = getBoolProperty(node, 'checked');
    const disabled = getBoolProperty(node, 'disabled');
    const expanded = getBoolProperty(node, 'expanded');
    const pressed = getBoolProperty(node, 'pressed');
    const hidden = getBoolProperty(node, 'hidden');
    const value = truncateText(getAxValue(node.value), maxNameChars);

    out.push({
      uid,
      role,
      name,
      depth,
      checked,
      disabled,
      expanded,
      pressed,
      hidden,
      value
    });

    if (out.length >= maxNodes) {
      truncated = true;
      break;
    }
  }

  return { nodes: out, uidToBackend, truncated };
}
