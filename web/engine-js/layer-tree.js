// LayerIntf.cpp Exchange/Swap: move layer identities, preserving their images
// and script state. Swap keeps the children at their original tree positions.
export function setAbsoluteOrderMode(node, enabled) {
  if (node.absoluteOrderMode === enabled) return;
  node.absoluteOrderMode = enabled;
  if (enabled) node.children.forEach((child, index) => { child.absoluteOrderIndex = index; });
}

export function joinLayer(node, parent) {
  node.parent = parent;
  if (!parent) return;
  const last = parent.children.at(-1);
  parent.children.push(node);
  if (parent.absoluteOrderMode && last) node.absoluteOrderIndex = last.absoluteOrderIndex + 1;
}

export function setLayerOrder(node, index, absolute = false) {
  const parent = node.parent;
  if (!parent) throw new Error('TJS cannot move primary or siblingless layer');
  setAbsoluteOrderMode(parent, absolute);
  const siblings = parent.children;
  const from = siblings.indexOf(node);
  let to;
  if (absolute) {
    to = siblings.findIndex(child => child.absoluteOrderIndex >= index);
    if (to < 0) to = siblings.length;
    if (from < to) to--;
    node.absoluteOrderIndex = index;
  } else to = Math.max(0, Math.min(siblings.length - 1, index));
  siblings.splice(from, 1);
  siblings.splice(to, 0, node);
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
  const detach = current => {
    if (current.parent) current.parent.children.splice(current.parent.children.indexOf(current), 1);
    current.parent = null;
  };
  const join = joinLayer;
  detach(node); detach(target);
  if (nodeBranch && nodeBranch !== node) detach(nodeBranch);
  if (targetBranch && targetBranch !== target) detach(targetBranch);
  const nodeChildren = keepChildren ? node.children.splice(0) : null;
  const targetChildren = keepChildren ? target.children.splice(0) : null;
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
