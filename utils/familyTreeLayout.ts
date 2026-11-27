import type { FamilyTreeData } from '../types';

export const TREE_NODE_WIDTH = 200;
export const TREE_NODE_HEIGHT = 120;
const SPOUSE_GAP = 32;
const BRANCH_GAP = 80;
const GENERATION_HEIGHT = 240;

export interface FamilyTreeNode { id: string; x: number; y: number }
export interface FamilyTreeVertical { x: number; y1: number; y2: number }
export interface FamilyTreeHorizontal { x1: number; x2: number; y: number }
export interface FamilyTreeRoute {
  id: string;
  parentIds: string[];
  childIds: string[];
  x: number;
  y: number;
  lane: number;
  partnerLine?: FamilyTreeHorizontal;
  union?: { x: number; y: number };
  stem?: FamilyTreeVertical;
  bus?: FamilyTreeHorizontal;
  busSegments: FamilyTreeHorizontal[];
  branches: (FamilyTreeVertical & { personId: string })[];
  junctions: { x: number; y: number }[];
}
export interface FamilyTreeLayout {
  nodes: FamilyTreeNode[];
  families: FamilyTreeRoute[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

interface Group {
  id: string;
  members: string[];
  width: number;
  rank: number;
  x: number; // Horizontal centre, before translating the root card to (0, 0).
  order: number;
}
interface Link {
  parent: Group;
  child: Group;
  parentIds: string[];
  childId: string;
  parentOffset: number;
  childOffset: number;
}

/**
 * Recursively order each partner's family as one branch, including collateral
 * relatives. Fixed-order barycentre sweeps and family corridors preserve those
 * branches across generations while keeping couples adjacent.
 */
export function layoutFamilyTree(tree: FamilyTreeData): FamilyTreeLayout {
  if (!tree.people.length) return {
    nodes: [], families: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  };

  const ids = new Set(tree.people.map(person => person.id));
  const leader = new Map(tree.people.map(person => [person.id, person.id]));
  const find = (id: string): string => {
    const parent = leader.get(id)!;
    if (parent === id) return id;
    const result = find(parent);
    leader.set(id, result);
    return result;
  };
  for (const family of tree.families) {
    const parents = family.parentIds.filter(id => ids.has(id));
    if (parents.length > 1) leader.set(find(parents[1]), find(parents[0]));
  }

  const byLeader = new Map<string, Group>();
  tree.people.forEach((person, order) => {
    const key = find(person.id);
    if (!byLeader.has(key)) byLeader.set(key, { id: key, members: [], width: 0, rank: 0, x: 0, order });
    byLeader.get(key)!.members.push(person.id);
  });
  const groups = [...byLeader.values()];
  const personGroup = new Map<string, Group>();
  for (const group of groups) {
    // Start with me on the left; descendant branches orient couples outward below.
    if (group.members.includes(tree.rootId!)) {
      group.members = [tree.rootId!, ...group.members.filter(id => id !== tree.rootId)];
    }
    group.width = group.members.length * TREE_NODE_WIDTH + (group.members.length - 1) * SPOUSE_GAP;
    for (const id of group.members) personGroup.set(id, group);
  }
  const offset = (group: Group, id: string) =>
    -group.width / 2 + TREE_NODE_WIDTH / 2 + group.members.indexOf(id) * (TREE_NODE_WIDTH + SPOUSE_GAP);

  const links: Link[] = [];
  for (const family of tree.families) {
    const parents = family.parentIds.filter(id => personGroup.has(id));
    if (!parents.length) continue;
    const parent = personGroup.get(parents[0])!;
    const parentOffset = parents.reduce((sum, id) => sum + offset(parent, id), 0) / parents.length;
    for (const id of family.childIds) {
      const child = personGroup.get(id);
      if (child && child !== parent) links.push({ parent, child, parentIds: parents, childId: id, parentOffset, childOffset: offset(child, id) });
    }
  }

  const incomingLinks = new Map(groups.map(group => [group.id, [] as Link[]]));
  const outgoingLinks = new Map(groups.map(group => [group.id, [] as Link[]]));
  for (const link of links) {
    incomingLinks.get(link.child.id)!.push(link);
    outgoingLinks.get(link.parent.id)!.push(link);
  }
  const rootGroup = personGroup.get(tree.rootId || '') || groups[0];
  const ordered: Group[] = [];
  const visited = new Set<string>();
  const visitBranch = (group: Group, via?: Link, side: 'left' | 'right' = 'right') => {
    if (visited.has(group.id)) return;
    visited.add(group.id);
    const entry = via ? via.parent === group ? via.child : via.parent : undefined;
    if (via?.child === group && group.members.length === 2) {
      // Keep the blood relative toward their parents and their partner's ancestry
      // on the outside of this branch, including for siblings and cousins.
      const partner = group.members.find(id => id !== via.childId)!;
      group.members = side === 'left' ? [partner, via.childId] : [via.childId, partner];
    }
    const children = [...outgoingLinks.get(group.id)!].filter(link => link.child !== entry).sort((a, b) => a.child.order - b.child.order);
    // Collateral families grow outward. Shared descendants fan out on both
    // sides, keeping their partners' families outside the sibling connections.
    const split = via?.parent === group ? side === 'left' ? children.length : 0 : Math.floor(children.length / 2);
    for (const link of children.slice(0, split)) visitBranch(link.child, link, 'left');
    const visitParents = (id: string | undefined, parentSide: 'left' | 'right') => {
      const link = incomingLinks.get(group.id)!.find(item => item.childId === id);
      if (link && link.parent !== entry) visitBranch(link.parent, link, parentSide);
    };
    visitParents(group.members[0], 'left');
    ordered.push(group);
    visitParents(group.members[1], 'right');
    for (const link of children.slice(split)) visitBranch(link.child, link, 'right');
  };
  for (const group of [rootGroup, ...groups]) visitBranch(group);
  const branchOrder = new Map(ordered.map((group, index) => [group.id, index]));
  for (const link of links) {
    link.parentOffset = link.parentIds.reduce((sum, id) => sum + offset(link.parent, id), 0) / link.parentIds.length;
    link.childOffset = offset(link.child, link.childId);
  }

  // Assign generations outward from the root first. A branch with fewer known
  // ancestors must not pull its direct parents up into the grandparents' row.
  const ranked = new Set<string>();
  const rootDistance = new Map<string, number>();
  for (const start of [rootGroup, ...groups]) {
    if (ranked.has(start.id)) continue;
    const visit = [start];
    ranked.add(start.id);
    rootDistance.set(start.id, 0);
    for (let index = 0; index < visit.length; index++) {
      const group = visit[index];
      for (const link of links) {
        const neighbour = link.parent === group ? link.child : link.child === group ? link.parent : undefined;
        if (!neighbour || ranked.has(neighbour.id)) continue;
        neighbour.rank = group.rank + (link.parent === group ? 1 : -1);
        ranked.add(neighbour.id);
        rootDistance.set(neighbour.id, rootDistance.get(group.id)! + 1);
        visit.push(neighbour);
      }
    }
  }

  // Longest-path constraints also support a known ancestor shared by two branches.
  const outgoing = new Map(groups.map(group => [group.id, new Set<Group>()]));
  const indegree = new Map(groups.map(group => [group.id, 0]));
  for (const { parent, child } of links) {
    if (outgoing.get(parent.id)!.has(child)) continue;
    outgoing.get(parent.id)!.add(child);
    indegree.set(child.id, indegree.get(child.id)! + 1);
  }
  const queue = groups.filter(group => indegree.get(group.id) === 0);
  for (let index = 0; index < queue.length; index++) {
    const parent = queue[index];
    for (const child of outgoing.get(parent.id)!) {
      child.rank = Math.max(child.rank, parent.rank + 1);
      indegree.set(child.id, indegree.get(child.id)! - 1);
      if (!indegree.get(child.id)) queue.push(child);
    }
  }

  const rows = new Map<number, Group[]>();
  for (const group of groups) {
    if (!rows.has(group.rank)) rows.set(group.rank, []);
    rows.get(group.rank)!.push(group);
  }
  const ranks = [...rows.keys()].sort((a, b) => a - b);
  for (const row of rows.values()) row.sort((a, b) => branchOrder.get(a.id)! - branchOrder.get(b.id)!);

  // Project desired centres onto the minimum-spacing constraints. Pool adjacent
  // violators keeps whole sibling/ancestor blocks centred instead of shoving
  // every collision to the right and making the layout drift on each sweep.
  const placeRow = (row: Group[], desired: Map<string, number>) => {
    const prefix: number[] = [];
    let distance = 0;
    const blocks: { start: number; end: number; sum: number; count: number }[] = [];
    row.forEach((group, index) => {
      if (index) distance += row[index - 1].width / 2 + group.width / 2 + BRANCH_GAP;
      prefix.push(distance);
      blocks.push({ start: index, end: index, sum: desired.get(group.id)! - distance, count: 1 });
      while (blocks.length > 1) {
        const right = blocks[blocks.length - 1];
        const left = blocks[blocks.length - 2];
        if (left.sum / left.count <= right.sum / right.count) break;
        blocks.splice(blocks.length - 2, 2, {
          start: left.start, end: right.end, sum: left.sum + right.sum, count: left.count + right.count,
        });
      }
    });
    for (const block of blocks) for (let index = block.start; index <= block.end; index++) {
      row[index].x = block.sum / block.count + prefix[index];
    }
  };
  for (const row of rows.values()) placeRow(row, new Map(row.map(group => [group.id, 0])));

  // Preserve each couple's left/right ancestral parts when ordering descendants.
  // These constraints also apply to the ancestors of children's partners.
  const parentFamily = new Map(tree.families.flatMap(family => family.childIds.map(id => [id, family] as const)));
  const ancestorCache = new Map<string, Set<Group>>();
  const ancestorGroups = (id: string): Set<Group> => {
    const cached = ancestorCache.get(id);
    if (cached) return cached;
    const result = new Set<Group>();
    ancestorCache.set(id, result);
    for (const parent of parentFamily.get(id)?.parentIds || []) {
      const group = personGroup.get(parent);
      if (group) result.add(group);
      for (const ancestor of ancestorGroups(parent)) result.add(ancestor);
    }
    return result;
  };
  const ancestryOrder = new Map(groups.map(group => [group.id, new Set<Group>()]));
  for (const group of groups) if (group.members.length === 2) {
    const left = ancestorGroups(group.members[0]), right = ancestorGroups(group.members[1]);
    for (const a of left) if (!right.has(a)) for (const b of right) if (!left.has(b)) {
      if (a.rank === b.rank && branchOrder.get(a.id)! < branchOrder.get(b.id)!) ancestryOrder.get(a.id)!.add(b);
    }
  }
  const orderFamilyRow = (row: Group[], desired: Map<string, number>) => {
    const indegree = new Map(row.map(group => [group.id, 0]));
    for (const group of row) for (const next of ancestryOrder.get(group.id)!) indegree.set(next.id, indegree.get(next.id)! + 1);
    const pending = row.filter(group => !indegree.get(group.id));
    const result: Group[] = [];
    while (pending.length) {
      pending.sort((a, b) => desired.get(a.id)! - desired.get(b.id)! || branchOrder.get(a.id)! - branchOrder.get(b.id)!);
      const group = pending.shift()!;
      result.push(group);
      for (const next of ancestryOrder.get(group.id)!) {
        indegree.set(next.id, indegree.get(next.id)! - 1);
        if (!indegree.get(next.id)) pending.push(next);
      }
    }
    row.splice(0, row.length, ...result);
  };

  const sweep = (direction: 'parents' | 'children') => {
    const visitRanks = direction === 'parents' ? ranks : [...ranks].reverse();
    for (const rank of visitRanks) {
      const row = rows.get(rank)!;
      const desired = new Map<string, number>();
      for (const group of row) {
        let neighbours = links.filter(link => direction === 'parents' ? link.child === group : link.parent === group);
        if (direction === 'parents' && neighbours.length) {
          // Apply this in every generation: collateral relatives above me
          // belong to their own parent branch just like my descendants do.
          const closest = Math.min(...neighbours.map(link => rootDistance.get(link.parent.id)!));
          neighbours = neighbours.filter(link => rootDistance.get(link.parent.id) === closest);
        }
        const centres = neighbours.map(link => direction === 'parents'
          ? link.parent.x + link.parentOffset - link.childOffset
          : link.child.x + link.childOffset - link.parentOffset);
        desired.set(group.id, centres.length ? centres.reduce((sum, value) => sum + value, 0) / centres.length : group.x);
      }
      if (direction === 'parents') {
        orderFamilyRow(row, desired);
      }
      placeRow(row, desired);
    }
  };
  // Align generations while preserving the recursive branch order.
  for (let iteration = 0; iteration < 8; iteration++) {
    sweep('children');
    sweep('parents');
  }

  // Reserve a separate horizontal corridor for each family in a generation.
  // Keep both source stems and child ports in that order, so the branches remain
  // separate between rows as well as on the rows themselves.
  type Constraint = { from: Group; to: Group; gap: number };
  const constraints: Constraint[] = [];
  for (const row of rows.values()) for (let index = 1; index < row.length; index++) {
    const from = row[index - 1], to = row[index];
    constraints.push({ from, to, gap: from.width / 2 + to.width / 2 + BRANCH_GAP });
  }
  const rowOrder = new Map<string, number>();
  for (const row of rows.values()) row.forEach((group, index) => rowOrder.set(group.id, index));
  const portOrder = (link: Link) => rowOrder.get(link.child.id)! * 3 + link.child.members.indexOf(link.childId);
  const corridors: Constraint[][] = [];
  for (const row of rows.values()) {
    const families = row.map(group => [...outgoingLinks.get(group.id)!].sort((a, b) => portOrder(a) - portOrder(b))).filter(children => children.length);
    for (let index = 1; index < families.length; index++) {
      const left = families[index - 1], right = families[index];
      const last = left[left.length - 1], first = right[0];
      // Shared ancestry and marriages between branches can form a non-planar
      // graph. Keep the explicit crossing router for those extra connections.
      if (last.child.rank !== first.child.rank || portOrder(last) >= portOrder(first)) continue;
      corridors.push([
        { from: left[0].parent, to: first.child, gap: left[0].parentOffset - first.childOffset + 24 },
        { from: last.child, to: right[0].parent, gap: last.childOffset - right[0].parentOffset + 24 },
      ]);
    }
  }
  const solveSpacing = (edges: Constraint[]) => {
    const positions = new Map(groups.map(group => [group.id, group.x]));
    for (let pass = 0; pass < groups.length; pass++) {
      let changed = false;
      for (const { from, to, gap } of edges) {
        const minimum = positions.get(from.id)! + gap;
        if (positions.get(to.id)! < minimum - 0.001) {
          positions.set(to.id, minimum);
          changed = true;
        }
      }
      if (!changed) return positions;
    }
    return null;
  };
  let spaced = solveSpacing([...constraints, ...corridors.flat()]);
  if (!spaced) {
    spaced = solveSpacing(constraints);
    // Retain every feasible branch corridor if additional shared links conflict.
    for (const corridor of corridors) {
      const candidate = solveSpacing([...constraints, ...corridor]);
      if (candidate) { constraints.push(...corridor); spaced = candidate; }
    }
  }
  if (spaced) for (const group of groups) group.x = spaced.get(group.id)!;

  const rootId = tree.rootId && personGroup.has(tree.rootId) ? tree.rootId : rootGroup.members[0];
  const rootX = rootGroup.x + offset(rootGroup, rootId) - TREE_NODE_WIDTH / 2;
  let nodes = groups.flatMap(group => group.members.map(id => ({
    id,
    x: group.x + offset(group, id) - TREE_NODE_WIDTH / 2 - rootX,
    y: (group.rank - rootGroup.rank) * GENERATION_HEIGHT,
  })));
  let routed = routeFamilyConnections(tree, nodes);
  const extraAfterRow = new Map<number, number>();
  for (const band of routed.bands) {
    const extra = Math.max(0, band.requiredGap - (band.childY - band.parentY - TREE_NODE_HEIGHT));
    extraAfterRow.set(band.parentY, Math.max(extraAfterRow.get(band.parentY) || 0, extra));
  }
  if ([...extraAfterRow.values()].some(extra => extra > 0)) {
    // Keep legible lane spacing in crowded generations instead of stacking wires.
    const rowYs = [...new Set(nodes.map(node => node.y))].sort((a, b) => a - b);
    const shifted = new Map<number, number>();
    let extra = 0;
    rowYs.forEach((y, index) => {
      if (index) extra += extraAfterRow.get(rowYs[index - 1]) || 0;
      shifted.set(y, y + extra);
    });
    const rootY = shifted.get(0) || 0;
    nodes = nodes.map(node => ({ ...node, y: shifted.get(node.y)! - rootY }));
    routed = routeFamilyConnections(tree, nodes);
  }
  const families = routed.families;
  return {
    nodes, families,
    bounds: {
      minX: Math.min(...nodes.map(node => node.x)),
      minY: Math.min(...nodes.map(node => node.y)),
      maxX: Math.max(...nodes.map(node => node.x + TREE_NODE_WIDTH)),
      maxY: Math.max(...nodes.map(node => node.y + TREE_NODE_HEIGHT), ...families.map(family => family.y)),
    },
  };
}


const ROUTE_MARGIN = 24;
const ROUTE_LANE_SPACING = 22;
const CROSSING_GAP = 5;
const EPSILON = 0.001;
interface RoutePlan {
  id: string;
  parentIds: string[];
  childIds: string[];
  parents: FamilyTreeNode[];
  children: FamilyTreeNode[];
  parentY: number;
  childY: number;
  x: number;
  minX: number;
  maxX: number;
  lane: number;
}

/** Route each family's bus separately; unrelated crossings are gaps, never junctions. */
export function routeFamilyConnections(tree: FamilyTreeData, nodes: FamilyTreeNode[]): {
  families: FamilyTreeRoute[];
  bands: { parentY: number; childY: number; lanes: number; requiredGap: number }[];
} {
  const positions = new Map(nodes.map(node => [node.id, node]));
  const plans: RoutePlan[] = tree.families.flatMap(family => {
    const parentIds = family.parentIds.filter(id => positions.has(id));
    const childIds = family.childIds.filter(id => positions.has(id));
    if (!parentIds.length) return [];
    const parents = parentIds.map(id => positions.get(id)!);
    const children = childIds.map(id => positions.get(id)!);
    const parentY = Math.max(...parents.map(node => node.y));
    const x = parents.reduce((sum, node) => sum + node.x + TREE_NODE_WIDTH / 2, 0) / parents.length;
    const childXs = children.map(node => node.x + TREE_NODE_WIDTH / 2);
    return [{ id: family.id, parentIds, childIds, parents, children, parentY,
      childY: children.length ? Math.min(...children.map(node => node.y)) : parentY + GENERATION_HEIGHT,
      x, minX: Math.min(x, ...childXs), maxX: Math.max(x, ...childXs), lane: 0 }];
  });
  const byRow = new Map<number, RoutePlan[]>();
  for (const plan of plans) if (plan.children.length) {
    if (!byRow.has(plan.parentY)) byRow.set(plan.parentY, []);
    byRow.get(plan.parentY)!.push(plan);
  }
  const bands: { parentY: number; childY: number; lanes: number; requiredGap: number }[] = [];
  const laneCounts = new Map<number, number>();
  for (const [parentY, row] of byRow) {
    for (const plan of row) {
      // An outgoing couple stem must not share a column with another family's incoming child.
      const foreignChildren = row.filter(other => other !== plan).flatMap(other => other.children.map(child => child.x + TREE_NODE_WIDTH / 2));
      const preferred = plan.x;
      const left = Math.min(...plan.parents.map(node => node.x)) + TREE_NODE_WIDTH;
      const right = Math.max(...plan.parents.map(node => node.x));
      const offsets = [0, 8, -8].filter(offset => plan.parents.length === 1 || preferred + offset >= left + 5 && preferred + offset <= right - 5);
      const offset = offsets.find(offset => foreignChildren.every(x => Math.abs(x - preferred - offset) >= 8 - EPSILON));
      plan.x = preferred + (offset || 0);
      const childXs = plan.children.map(child => child.x + TREE_NODE_WIDTH / 2);
      plan.minX = Math.min(plan.x, ...childXs); plan.maxX = Math.max(plan.x, ...childXs);
    }
    // Interval coloring reuses lanes for disjoint families and separates overlapping spans.
    const laneEnds: number[] = [];
    for (const plan of [...row].sort((a, b) => a.minX - b.minX || a.maxX - b.maxX || a.id.localeCompare(b.id))) {
      let lane = laneEnds.findIndex(end => end + 12 < plan.minX);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = plan.maxX; plan.lane = lane;
    }
    laneCounts.set(parentY, laneEnds.length);
    bands.push({ parentY, childY: Math.min(...row.map(plan => plan.childY)), lanes: laneEnds.length,
      requiredGap: ROUTE_MARGIN * 2 + (laneEnds.length - 1) * ROUTE_LANE_SPACING });
  }
  const families: FamilyTreeRoute[] = plans.map(plan => {
    const parentBottom = plan.parentY + TREE_NODE_HEIGHT;
    const parentMiddle = plan.parentY + TREE_NODE_HEIGHT / 2;
    const laneCount = laneCounts.get(plan.parentY) || 1;
    const span = (laneCount - 1) * ROUTE_LANE_SPACING;
    const y = plan.children.length ? parentBottom + (plan.childY - parentBottom - span) / 2 + plan.lane * ROUTE_LANE_SPACING : parentBottom + 36;
    const partnerLine = plan.parents.length === 2 ? {
      x1: Math.min(...plan.parents.map(node => node.x)) + TREE_NODE_WIDTH,
      x2: Math.max(...plan.parents.map(node => node.x)), y: parentMiddle,
    } : undefined;
    const bus = plan.children.length ? { x1: plan.minX, x2: plan.maxX, y } : undefined;
    const childXs = plan.children.map(node => node.x + TREE_NODE_WIDTH / 2);
    const junctions = [...new Set([plan.x, ...childXs])].filter(x =>
      Number(x > plan.minX + EPSILON) + Number(x < plan.maxX - EPSILON) + Number(x === plan.x) + Number(childXs.includes(x)) >= 3
    ).map(x => ({ x, y }));
    return { id: plan.id, parentIds: plan.parentIds, childIds: plan.childIds, x: plan.x, y, lane: plan.lane,
      ...(partnerLine ? { partnerLine, union: { x: plan.x, y: parentMiddle } } : {}),
      ...(bus ? { stem: { x: plan.x, y1: partnerLine ? parentMiddle : parentBottom, y2: y }, bus } : {}),
      busSegments: bus && bus.x2 - bus.x1 > EPSILON ? [{ ...bus }] : [],
      branches: plan.children.map(node => ({ personId: node.id, x: node.x + TREE_NODE_WIDTH / 2, y1: y, y2: node.y })),
      junctions: plan.children.length ? junctions : [],
    };
  });
  const routeRows = new Map<string, number>(plans.map(plan => [plan.id, plan.parentY]));
  for (const family of families) {
    if (!family.bus || family.bus.x2 - family.bus.x1 <= EPSILON) continue;
    const { x1, x2, y } = family.bus;
    const crossings: number[] = [];
    for (const other of families) {
      if (other.id === family.id || routeRows.get(other.id) !== routeRows.get(family.id)) continue;
      for (const vertical of [...(other.stem ? [other.stem] : []), ...other.branches]) {
        if (vertical.x > x1 + EPSILON && vertical.x < x2 - EPSILON && y > Math.min(vertical.y1, vertical.y2) + EPSILON && y < Math.max(vertical.y1, vertical.y2) - EPSILON) crossings.push(vertical.x);
      }
    }
    const segments: FamilyTreeHorizontal[] = [];
    let cursor = x1;
    for (const crossing of [...new Set(crossings)].sort((a, b) => a - b)) {
      if (crossing - CROSSING_GAP > cursor + EPSILON) segments.push({ x1: cursor, x2: crossing - CROSSING_GAP, y });
      cursor = Math.max(cursor, crossing + CROSSING_GAP);
    }
    if (cursor < x2 - EPSILON) segments.push({ x1: cursor, x2, y });
    family.busSegments = segments;
  }
  return { families, bands };
}
