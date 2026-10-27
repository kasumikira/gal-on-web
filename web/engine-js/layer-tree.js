// LayerIntf.cpp Exchange/Swap: move layer identities, preserving their images
// and script state. Swap keeps the children at their original tree positions.
export function setAbsoluteOrderMode(node, enabled) {
  if (node.absoluteOrderMode === enabled) return;
  node.absoluteOrderMode = enabled;
  if (enabled) node.children.forEach((child, index) => { child.absoluteOrderIndex = index; });
}

function reindex(parent) {
  parent.children.forEach((child, index) => { child.orderIndex = index; });
}
function detach(node) {
  if (node.parent) {
    const parent = node.parent;
    parent.children.splice(node.orderIndex, 1);
    reindex(parent);
  }
  node.parent = null;
  node.orderIndex = 0;
}
export function joinLayer(node, parent) {
  if (parent && isAncestorOrSelf(node, parent)) throw new Error('TJS cannot set layer parent to self or descendant');
  if (parent && node.manager && parent.manager && node.manager !== parent.manager)
    throw new Error('TJS cannot move layer under another primary layer manager');
  if (parent) node.manager ??= parent.manager;
  detach(node);
  if (!parent) return;
  node.parent = parent;
  const last = parent.children.at(-1);
  node.orderIndex = parent.children.length;
  parent.children.push(node);
  if (parent.absoluteOrderMode && last) node.absoluteOrderIndex = last.absoluteOrderIndex + 1;
}
export function detachLayerTree(node) {
  detach(node);
  for (const child of node.children) { child.parent = null; child.orderIndex = 0; }
  node.children.length = 0;
}
export function layerRoot(node) {
  while (node.parent) node = node.parent;
  return node;
}
export function layerOffset(node) {
  let x = 0, y = 0;
  for (; node.parent; node = node.parent) { x += node.left; y += node.top; }
  return { x: Math.trunc(x), y: Math.trunc(y) };
}

export function setLayerOrder(node, index, absolute = false) {
  const parent = node.parent;
  if (!parent) throw new Error('TJS cannot move primary or siblingless layer');
  setAbsoluteOrderMode(parent, absolute);
  const siblings = parent.children;
  const from = node.orderIndex;
  let to;
  if (absolute) {
    to = siblings.findIndex(child => child.absoluteOrderIndex >= index);
    if (to < 0) to = siblings.length;
    if (from < to) to--;
    node.absoluteOrderIndex = index;
  } else to = Math.max(0, Math.min(siblings.length - 1, index));
  siblings.splice(from, 1);
  siblings.splice(to, 0, node);
  reindex(parent);
}

export function isAncestorOrSelf(ancestor, node) {
  for (let walk = node; walk; walk = walk.parent) if (walk === ancestor) return true;
  return false;
}

export function isNodeEnabled(node) {
  for (let walk = node; walk; walk = walk.parent) if (!walk.enabled) return false;
  const modal = node.window?.modalLayers?.at(-1);
  return !modal || isAncestorOrSelf(modal, node);
}

export function exchangeLayers(node, target, keepChildren) {
  if (node === target) return;
  const ancestorChild = (child, ancestor) => {
    for (let walk = child; walk.parent; walk = walk.parent) if (walk.parent === ancestor) return walk;
    return null;
  };
  const nodeBranch = ancestorChild(node, target), targetBranch = ancestorChild(target, node);
  const nodeParent = node.parent, targetParent = target.parent;
  const nodeAbsolute = nodeParent?.absoluteOrderMode ?? true, targetAbsolute = targetParent?.absoluteOrderMode ?? true;
  const nodeIndex = nodeAbsolute ? node.absoluteOrderIndex : nodeParent.children.indexOf(node);
  const targetIndex = targetAbsolute ? target.absoluteOrderIndex : targetParent.children.indexOf(target);
  const nodePrimary = node.isPrimary, targetPrimary = target.isPrimary;
  const join = joinLayer;
  detach(node); detach(target);
  if (nodeBranch && nodeBranch !== node) detach(nodeBranch);
  if (targetBranch && targetBranch !== target) detach(targetBranch);
  const nodeChildren = keepChildren ? [...node.children] : null;
  const targetChildren = keepChildren ? [...target.children] : null;
  if (keepChildren) {
    for (const child of nodeChildren) detach(child);
    for (const child of targetChildren) detach(child);
  }
  const nodeOrders = nodeChildren?.map(child => child.absoluteOrderIndex);
  const targetOrders = targetChildren?.map(child => child.absoluteOrderIndex);
  join(node, targetParent === node ? target : targetParent);
  join(target, nodeParent === target ? node : nodeParent);
  if (keepChildren) {
    for (const child of nodeChildren) join(child, target);
    for (const child of targetChildren) join(child, node);
    if (node.absoluteOrderMode && target.absoluteOrderMode) {
      nodeChildren.forEach((child, index) => setLayerOrder(child, nodeOrders[index], true));
      targetChildren.forEach((child, index) => setLayerOrder(child, targetOrders[index], true));
    }
  }
  if (nodeBranch && nodeBranch !== node) join(nodeBranch, node);
  if (targetBranch && targetBranch !== target) join(targetBranch, target);
  if (node.parent && node.parent === target.parent && !nodeAbsolute && !targetAbsolute && !node.parent.absoluteOrderMode) {
    if (nodeIndex < targetIndex) {
      setLayerOrder(target, nodeIndex); setLayerOrder(node, targetIndex);
    } else {
      setLayerOrder(node, targetIndex); setLayerOrder(target, nodeIndex);
    }
  } else {
    if (target.parent && target.parent.absoluteOrderMode === targetAbsolute) setLayerOrder(target, targetIndex, targetAbsolute);
    if (node.parent && node.parent.absoluteOrderMode === nodeAbsolute) setLayerOrder(node, nodeIndex, nodeAbsolute);
  }
  node.isPrimary = targetPrimary; target.isPrimary = nodePrimary;
  if (nodePrimary) node.window.primaryLayer = target;
  if (targetPrimary) target.window.primaryLayer = node;
  [node.left, target.left] = [target.left, node.left];
  [node.top, target.top] = [target.top, node.top];
  [node.visible, target.visible] = [target.visible, node.visible];
}

// Pre-order neighbour traversal, without allocating a flattened tree.
export function focusNeighbor(node, direction) {
  const root = layerRoot(node);
  const last = current => {
    while (current.children.length) current = current.children.at(-1);
    return current;
  };
  const advance = current => {
    if (direction < 0) {
      if (!current.parent) return last(root);
      return current.orderIndex ? last(current.parent.children[current.orderIndex - 1]) : current.parent;
    }
    if (current.children.length) return current.children[0];
    while (current.parent) {
      if (current.orderIndex + 1 < current.parent.children.length)
        return current.parent.children[current.orderIndex + 1];
      current = current.parent;
    }
    return root;
  };
  const first = advance(node);
  if (first === node) return null;
  let candidate = first;
  do {
    let visible = true;
    for (let walk = candidate; walk; walk = walk.parent) if (!walk.visible) { visible = false; break; }
    if (candidate.focusable && candidate.joinFocusChain && visible && isNodeEnabled(candidate)) return candidate;
    candidate = advance(candidate);
  } while (candidate !== first);
  return null;
}
