import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import ts from 'typescript';
import { branchingFamilyTree, familyTreeWithCousins, collateralAncestorFamilyTree } from './family-tree-fixtures.mjs';

// The layout is pure TypeScript, so exercise it without creating browser state.
const source = ts.transpileModule(fs.readFileSync(new URL('../utils/familyTreeLayout.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { layoutFamilyTree, routeFamilyConnections, TREE_NODE_WIDTH, TREE_NODE_HEIGHT } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const makeTree = (ids, families) => ({ rootId: ids[0] || null, people: ids.map(id => ({ id, name: id })), families });

function assertNoOverlaps(layout) {
  const overlaps = [];
  for (const [index, first] of layout.nodes.entries()) for (const second of layout.nodes.slice(index + 1)) {
    if (first.x < second.x + TREE_NODE_WIDTH && first.x + TREE_NODE_WIDTH > second.x + 0.00001
      && first.y < second.y + TREE_NODE_HEIGHT && first.y + TREE_NODE_HEIGHT > second.y) overlaps.push(`${first.id}/${second.id}`);
  }
  expect(overlaps, 'overlapping person cards').toEqual([]);
}

test('family layout centres on me and keeps both partners’ parents in the same generation', () => {
  const tree = makeTree(['me', 'spouse', 'dad', 'mom', 'spouse-dad', 'spouse-mom', 'granddad', 'grandmom', 'child', 'child-spouse', 'sibling', 'grandchild'], [
    { id: 'us', parentIds: ['me', 'spouse'], childIds: ['child', 'sibling'] },
    { id: 'my-parents', parentIds: ['dad', 'mom'], childIds: ['me'] },
    { id: 'their-parents', parentIds: ['spouse-dad', 'spouse-mom'], childIds: ['spouse'] },
    { id: 'my-grandparents', parentIds: ['granddad', 'grandmom'], childIds: ['dad'] },
    { id: 'next-generation', parentIds: ['child', 'child-spouse'], childIds: ['grandchild'] },
  ]);
  const layout = layoutFamilyTree(tree);
  const positions = new Map(layout.nodes.map(node => [node.id, node]));
  expect(positions.get('me')).toEqual({ id: 'me', x: 0, y: 0 });
  expect(positions.get('spouse')).toEqual({ id: 'spouse', x: 232, y: 0 });
  for (const id of ['dad', 'mom', 'spouse-dad', 'spouse-mom']) expect(positions.get(id).y).toBe(-240);
  expect(positions.get('granddad').y).toBe(-480);
  expect(positions.get('grandchild').y).toBe(480);
  expect(positions.get('dad').x).toBeLessThan(positions.get('spouse-dad').x);
  assertNoOverlaps(layout);
  expect(layoutFamilyTree(tree)).toEqual(layout);
  expect(tree.people[0]).toEqual({ id: 'me', name: 'me' });
});

test('expanded ancestor branches and child couples never overlap and all connectors stay below parents', () => {
  const ids = ['me', 'spouse'];
  const families = [{ id: 'us', parentIds: ['me', 'spouse'], childIds: [] }];
  let generation = ['me', 'spouse'];
  for (let depth = 0; depth < 4; depth++) {
    const next = [];
    for (const id of generation) {
      const parents = [`${id}-p1`, `${id}-p2`];
      ids.push(...parents); next.push(...parents);
      families.push({ id: `parents-${id}`, parentIds: parents, childIds: [id] });
    }
    generation = next;
  }
  for (let index = 0; index < 8; index++) {
    const child = `child-${index}`;
    const spouse = `child-spouse-${index}`;
    const grandchild = `grandchild-${index}`;
    ids.push(child, spouse, grandchild);
    families[0].childIds.push(child);
    families.push({ id: `family-${index}`, parentIds: [child, spouse], childIds: [grandchild] });
  }
  const layout = layoutFamilyTree(makeTree(ids, families));
  expect(layout.nodes).toHaveLength(ids.length);
  assertNoOverlaps(layout);
  const positions = new Map(layout.nodes.map(node => [node.id, node]));
  for (const family of layout.families) {
    for (const id of family.parentIds) expect(family.y).toBeGreaterThan(positions.get(id).y + TREE_NODE_HEIGHT);
    for (const id of family.childIds) expect(family.y).toBeLessThan(positions.get(id).y);
  }
});

test('a full pedigree uses uninterrupted family connectors', () => {
  const tree = branchingFamilyTree({ depth: 3, children: 0 });
  // A pedigree without collateral families has no cross-branch relationships.
  const collateral = new Set(tree.people.filter(person => /sibling|inlaw|cousin/.test(person.id)).map(person => person.id));
  tree.people = tree.people.filter(person => !collateral.has(person.id));
  tree.families = tree.families.filter(family => !family.parentIds.some(id => collateral.has(id)))
    .map(family => ({ ...family, childIds: family.childIds.filter(id => !collateral.has(id)) }));
  const layout = layoutFamilyTree(tree);
  for (const family of layout.families) if (family.bus && family.bus.x2 - family.bus.x1 > epsilon) {
    expect(family.busSegments).toEqual([family.bus]);
    expect(family.lane).toBe(0);
  }
  assertNoOverlaps(layout); assertSeparateConnections(layout.families);
});

function assertRecursiveAncestryParts(tree, layout) {
  const positions = new Map(layout.nodes.map(node => [node.id, node]));
  const parentFamilies = new Map(tree.families.flatMap(family => family.childIds.map(id => [id, family])));
  const ancestors = id => {
    const result = new Set();
    const pending = [...(parentFamilies.get(id)?.parentIds || [])];
    for (const parent of pending) if (!result.has(parent)) {
      result.add(parent);
      pending.push(...(parentFamilies.get(parent)?.parentIds || []));
    }
    return result;
  };
  const conflicts = [];
  for (const family of tree.families.filter(family => family.parentIds.length === 2)) {
    const [left, right] = [...family.parentIds].sort((a, b) => positions.get(a).x - positions.get(b).x);
    const leftAncestors = ancestors(left), rightAncestors = ancestors(right);
    const shared = new Set([...leftAncestors].filter(id => rightAncestors.has(id)));
    const a = [...leftAncestors].filter(id => !shared.has(id)).map(id => positions.get(id));
    const b = [...rightAncestors].filter(id => !shared.has(id)).map(id => positions.get(id));
    for (const y of new Set(a.map(node => node.y))) {
      const aRow = a.filter(node => node.y === y), bRow = b.filter(node => node.y === y);
      if (bRow.length && Math.max(...aRow.map(node => node.x + TREE_NODE_WIDTH)) > Math.min(...bRow.map(node => node.x)) + epsilon) {
        conflicts.push(family.id + ' interleaves ancestors at ' + y);
      }
    }
  }
  expect(conflicts, 'each couple recursively separates both ancestral branches').toEqual([]);
}

for (const extendedInlaws of [false, true]) test('recursive family parts stay separate with cousins and in-laws (extended: ' + extendedInlaws + ')', () => {
  const tree = branchingFamilyTree({ extendedInlaws });
  const before = JSON.stringify(tree);
  const layout = layoutFamilyTree(tree);
  assertRecursiveAncestryParts(tree, layout);
  const parts = [layout.nodes.filter(node => node.id === 'me' || node.id.startsWith('me-')), layout.nodes.filter(node => node.id === 'wife' || node.id.startsWith('wife-'))];
  for (const y of new Set(layout.nodes.map(node => node.y))) {
    const left = parts[0].filter(node => node.y === y), right = parts[1].filter(node => node.y === y);
    if (left.length && right.length) expect(Math.max(...left.map(node => node.x + TREE_NODE_WIDTH))).toBeLessThan(Math.min(...right.map(node => node.x)));
  }
  assertNoOverlaps(layout);
  assertSeparateConnections(layout.families);
  assertConnectionsAvoidCards(layout.nodes, layout.families);
  expect(JSON.stringify(tree)).toBe(before);
  expect(layoutFamilyTree(tree)).toEqual(layout);
});

test('empty and single-parent trees have finite bounds and valid positions', () => {
  expect(layoutFamilyTree(makeTree([], [])).nodes).toEqual([]);
  const layout = layoutFamilyTree(makeTree(['me', 'parent', 'child'], [
    { id: 'above', parentIds: ['parent'], childIds: ['me'] },
    { id: 'below', parentIds: ['me'], childIds: ['child'] },
  ]));
  expect(layout.nodes).toEqual([
    { id: 'me', x: 0, y: 0 }, { id: 'parent', x: 0, y: -240 }, { id: 'child', x: 0, y: 240 },
  ]);
  expect(Object.values(layout.bounds).every(Number.isFinite)).toBe(true);
  assertNoOverlaps(layout);
});


const screenshotTree = () => makeTree(['me', 'dad', 'mom', 'mg1', 'mg2', 'pg1', 'pg2', 'aunt', 'aunt-spouse'], [
  { id: 'parents', parentIds: ['dad', 'mom'], childIds: ['me'] },
  { id: 'maternal', parentIds: ['mg1', 'mg2'], childIds: ['mom'] },
  { id: 'paternal', parentIds: ['pg1', 'pg2'], childIds: ['dad', 'aunt'] },
  { id: 'aunt-family', parentIds: ['aunt', 'aunt-spouse'], childIds: [] },
]);
const verticals = family => [...(family.stem ? [family.stem] : []), ...family.branches];
const horizontals = family => [...(family.partnerLine ? [family.partnerLine] : []), ...family.busSegments];
const epsilon = 0.001;
function assertSeparateConnections(families) {
  const conflicts = [];
  for (let index = 0; index < families.length; index++) for (let next = index + 1; next < families.length; next++) {
    const first = families[index], second = families[next];
    for (const a of horizontals(first)) for (const b of horizontals(second)) {
      if (Math.abs(a.y - b.y) < epsilon && Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > epsilon) conflicts.push(`${first.id}/${second.id} share a horizontal wire`);
    }
    for (const a of verticals(first)) for (const b of verticals(second)) {
      if (Math.abs(a.x - b.x) < epsilon && Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > epsilon) conflicts.push(`${first.id}/${second.id} share a vertical wire`);
    }
    for (const [a, b] of [[first, second], [second, first]]) for (const horizontal of horizontals(a)) for (const vertical of verticals(b)) {
      const crosses = vertical.x > horizontal.x1 + epsilon && vertical.x < horizontal.x2 - epsilon && horizontal.y > vertical.y1 + epsilon && horizontal.y < vertical.y2 - epsilon;
      if (crosses) conflicts.push(`${a.id}/${b.id} have an unmarked crossing`);
    }
  }
  expect(conflicts).toEqual([]);
}
function assertConnectionsAvoidCards(nodes, families) {
  const conflicts = [];
  for (const family of families) for (const card of nodes) {
    for (const line of verticals(family)) {
      const inside = line.x > card.x + epsilon && line.x < card.x + TREE_NODE_WIDTH - epsilon && Math.min(line.y2, card.y + TREE_NODE_HEIGHT) - Math.max(line.y1, card.y) > epsilon;
      if (inside) conflicts.push(`${family.id} vertical wire enters ${card.id}`);
    }
    for (const line of horizontals(family)) {
      const inside = line.y > card.y + epsilon && line.y < card.y + TREE_NODE_HEIGHT - epsilon && Math.min(line.x2, card.x + TREE_NODE_WIDTH) - Math.max(line.x1, card.x) > epsilon;
      if (inside) conflicts.push(`${family.id} horizontal wire enters ${card.id}`);
    }
  }
  expect(conflicts).toEqual([]);
}

test('the screenshot family has distinct parent buses and a gap where unrelated lines cross', () => {
  const tree = screenshotTree();
  const nodes = [
    { id: 'mg1', x: 0, y: 0 }, { id: 'mg2', x: 232, y: 0 },
    { id: 'pg1', x: 512, y: 0 }, { id: 'pg2', x: 744, y: 0 },
    { id: 'dad', x: 166, y: 240 }, { id: 'mom', x: 398, y: 240 },
    { id: 'aunt', x: 678, y: 240 }, { id: 'aunt-spouse', x: 910, y: 240 },
    { id: 'me', x: 282, y: 480 },
  ];
  const before = JSON.stringify({ tree, nodes });
  const { families } = routeFamilyConnections(tree, nodes);
  const maternal = families.find(family => family.id === 'maternal');
  const paternal = families.find(family => family.id === 'paternal');
  expect(paternal.y - maternal.y).toBeGreaterThanOrEqual(22);
  expect(maternal.childIds).toEqual(['mom']); expect(paternal.childIds).toEqual(['dad', 'aunt']);
  expect(maternal.branches).toEqual([{ personId: 'mom', x: 498, y1: maternal.y, y2: 240 }]);
  expect(paternal.busSegments).toHaveLength(2);
  expect(paternal.busSegments[0].x2).toBeLessThan(498);
  expect(paternal.busSegments[1].x1).toBeGreaterThan(498);
  expect(paternal.junctions).toContainEqual({ x: paternal.x, y: paternal.y });
  assertSeparateConnections(families); assertConnectionsAvoidCards(nodes, families);
  expect(JSON.stringify({ tree, nodes })).toBe(before);
  expect(routeFamilyConnections({ ...tree, families: [...tree.families].reverse() }, nodes).families.sort((a, b) => a.id.localeCompare(b.id))).toEqual([...families].sort((a, b) => a.id.localeCompare(b.id)));
});

test('recursive family order removes the screenshot ancestry crossing without changing relationships', () => {
  const tree = screenshotTree();
  const before = JSON.stringify(tree);
  const layout = layoutFamilyTree(tree);
  const positions = new Map(layout.nodes.map(node => [node.id, node]));
  expect(positions.get('dad').x).toBeLessThan(positions.get('mom').x);
  const maternal = layout.families.find(family => family.id === 'maternal');
  const paternal = layout.families.find(family => family.id === 'paternal');
  expect(maternal.childIds).toEqual(['mom']);
  expect(paternal.childIds).toEqual(['dad', 'aunt']);
  expect(paternal.bus.x2).toBeLessThan(maternal.bus.x1);
  expect(maternal.lane).toBe(paternal.lane);
  expect(maternal.busSegments).toEqual([maternal.bus]);
  expect(paternal.busSegments).toEqual([paternal.bus]);
  assertNoOverlaps(layout);
  assertSeparateConnections(layout.families); assertConnectionsAvoidCards(layout.nodes, layout.families);
  expect(JSON.stringify(tree)).toBe(before);
  expect(layoutFamilyTree(tree)).toEqual(layout);
});

test('the root couple keeps its family branches separate while keeping me at the origin', () => {
  const tree = { ...screenshotTree(), rootId: 'dad' };
  const layout = layoutFamilyTree(tree);
  expect(layout.nodes.find(node => node.id === 'dad')).toEqual({ id: 'dad', x: 0, y: 0 });
  expect(layout.nodes.find(node => node.id === 'mom')).toEqual({ id: 'mom', x: 232, y: 0 });
  const maternal = layout.families.find(family => family.id === 'maternal');
  const paternal = layout.families.find(family => family.id === 'paternal');
  expect(paternal.bus.x2).toBeLessThan(maternal.bus.x1);
  assertNoOverlaps(layout);
  assertSeparateConnections(layout.families); assertConnectionsAvoidCards(layout.nodes, layout.families);
});

test('disjoint families reuse a lane and aligned unrelated stems do not share a column', () => {
  const tree = makeTree(['a1', 'a2', 'b1', 'b2', 'ac', 'bc'], [
    { id: 'a', parentIds: ['a1', 'a2'], childIds: ['ac'] },
    { id: 'b', parentIds: ['b1', 'b2'], childIds: ['bc'] },
  ]);
  const base = [{ id: 'a1', x: 0, y: 0 }, { id: 'a2', x: 232, y: 0 }, { id: 'b1', x: 512, y: 0 }, { id: 'b2', x: 744, y: 0 }];
  const disjoint = routeFamilyConnections(tree, [...base, { id: 'ac', x: 116, y: 240 }, { id: 'bc', x: 628, y: 240 }]);
  expect(disjoint.bands[0].lanes).toBe(1);
  const crossedNodes = [...base, { id: 'ac', x: 628, y: 240 }, { id: 'bc', x: 116, y: 240 }];
  const crossed = routeFamilyConnections(tree, crossedNodes);
  for (const family of crossed.families) for (const other of crossed.families.filter(item => item !== family)) for (const branch of other.branches) expect(Math.abs(family.stem.x - branch.x)).toBeGreaterThanOrEqual(8);
  assertSeparateConnections(crossed.families); assertConnectionsAvoidCards(crossedNodes, crossed.families);
});

test('crowded generations expand to keep their connector lanes legible', () => {
  const count = 8, ids = [], families = [];
  for (let index = 0; index < count; index++) {
    ids.push(`p${index}a`, `p${index}b`);
    families.push({ id: `origin-${index}`, parentIds: [`p${index}a`, `p${index}b`], childIds: [] });
  }
  let rootId;
  for (let first = 0; first < count; first++) for (let second = first + 1; second < count; second++) {
    const a = `child-${first}-${second}`, b = `child-${second}-${first}`;
    ids.push(a, b); rootId ||= a;
    families[first].childIds.push(a); families[second].childIds.push(b);
    families.push({ id: `couple-${first}-${second}`, parentIds: [a, b], childIds: [] });
  }
  const layout = layoutFamilyTree({ ...makeTree(ids, families), rootId });
  const origins = layout.families.filter(family => family.id.startsWith('origin-'));
  const laneCount = Math.max(...origins.map(family => family.lane)) + 1;
  expect(laneCount).toBeGreaterThan(4);
  const positions = new Map(layout.nodes.map(node => [node.id, node]));
  for (const family of origins) {
    const bottom = positions.get(family.parentIds[0]).y + TREE_NODE_HEIGHT;
    const top = positions.get(family.childIds[0]).y;
    expect(top - bottom).toBeGreaterThan(120);
    expect(family.y - bottom).toBeGreaterThanOrEqual(24 - epsilon);
    expect(top - family.y).toBeGreaterThanOrEqual(24 - epsilon);
  }
  expect(positions.get(rootId).y).toBe(0);
  assertNoOverlaps(layout); assertSeparateConnections(layout.families); assertConnectionsAvoidCards(layout.nodes, layout.families);
});

for (const rootId of ['me', 'dad']) test(`the browser preserves untangled partner order through zoom and reload (root: ${rootId})`, async ({ page }) => {
  const tree = { ...screenshotTree(), rootId };
  await page.goto('/');
  await page.evaluate(async tree => {
    const { storageService } = await import('/services/storageService.ts');
    await storageService.saveFamilyTree(tree);
  }, tree);
  await page.reload(); await page.getByRole('button', { name: 'Family tree', exact: true }).click();
  const maternal = page.locator('[data-family-id="maternal"]');
  const paternal = page.locator('[data-family-id="paternal"]');
  const assertRoutes = async () => {
    const mother = await page.locator('[data-person-id="mom"]').boundingBox();
    const father = await page.locator('[data-person-id="dad"]').boundingBox();
    expect(father.x + father.width).toBeLessThan(mother.x);
    expect(await maternal.getAttribute('data-route-y')).toBe(await paternal.getAttribute('data-route-y'));
    await expect(maternal.locator('[data-child-id]')).toHaveCount(1);
    await expect(maternal.locator('[data-child-id="mom"]')).toHaveCount(1);
    await expect(paternal.locator('[data-child-id="dad"]')).toHaveCount(1);
    await expect(paternal.locator('[data-child-id="aunt"]')).toHaveCount(1);
    await expect(maternal.locator('[data-connector="bus"]')).toHaveCount(1);
    await expect(paternal.locator('[data-connector="bus"]')).toHaveCount(1);
  };
  const assertRootCentered = async () => {
    const root = await page.locator(`[data-person-id="${rootId}"]`).boundingBox();
    const canvas = await page.getByTestId('family-tree-canvas').boundingBox();
    expect(root.x + root.width / 2).toBeCloseTo(canvas.x + canvas.width / 2, 0);
    expect(root.y + root.height / 2).toBeCloseTo(canvas.y + canvas.height / 2, 0);
  };
  await assertRoutes(); await assertRootCentered();
  await page.getByRole('button', { name: 'Fit tree', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await assertRoutes();
  await page.reload(); await page.getByRole('button', { name: 'Family tree', exact: true }).click();
  await assertRoutes(); await assertRootCentered();
  const saved = await page.evaluate(async () => (await import('/services/storageService.ts')).storageService.loadFamilyTree());
  expect(saved).toEqual(tree);
});

test('shared ancestors keep one identity and clear routes rather than recursing indefinitely', () => {
  const tree = makeTree(['me', 'wife', 'dad', 'mom', 'wife-dad', 'wife-mom', 'granddad', 'grandmom'], [
    { id: 'us', parentIds: ['me', 'wife'], childIds: [] },
    { id: 'my-parents', parentIds: ['dad', 'mom'], childIds: ['me'] },
    { id: 'their-parents', parentIds: ['wife-dad', 'wife-mom'], childIds: ['wife'] },
    { id: 'shared-grandparents', parentIds: ['granddad', 'grandmom'], childIds: ['dad', 'wife-mom'] },
  ]);
  const before = JSON.stringify(tree);
  const layout = layoutFamilyTree(tree);
  expect(new Set(layout.nodes.map(node => node.id)).size).toBe(tree.people.length);
  expect(layout.nodes.find(node => node.id === 'me')).toEqual({ id: 'me', x: 0, y: 0 });
  expect(layout.families.find(family => family.id === 'shared-grandparents').childIds).toEqual(['dad', 'wife-mom']);
  assertNoOverlaps(layout); assertSeparateConnections(layout.families); assertConnectionsAvoidCards(layout.nodes, layout.families);
  expect(JSON.stringify(tree)).toBe(before);
});

test('siblings stay together while cousins and nieces stay outside their family connectors', () => {
  const tree = familyTreeWithCousins();
  const layout = layoutFamilyTree(tree);
  const positions = new Map(layout.nodes.map(node => [node.id, node]));
  expect(positions.get('nephew').x + TREE_NODE_WIDTH).toBeLessThan(positions.get('kid').x);
  expect(positions.get('kid2').x + TREE_NODE_WIDTH).toBeLessThan(positions.get('niece').x);
  for (const family of layout.families) if (family.bus && family.bus.x2 - family.bus.x1 > epsilon) {
    expect(family.busSegments, family.id + ' should have an uninterrupted connector').toEqual([family.bus]);
    expect(family.lane).toBe(0);
  }
  assertRecursiveAncestryParts(tree, layout);
  assertNoOverlaps(layout); assertSeparateConnections(layout.families); assertConnectionsAvoidCards(layout.nodes, layout.families);
});

for (const extraGenerations of [0, 2]) test('a great-aunt’s child stays with their branch above me (extra generations: ' + extraGenerations + ')', () => {
  const tree = collateralAncestorFamilyTree();
  for (let index = 0; index < extraGenerations; index++) {
    const id = 'descendant-' + index;
    tree.people.push({ id, name: id });
    tree.families.push({ id: 'descendants-' + index, parentIds: [tree.rootId], childIds: [id] });
    tree.rootId = id;
  }
  const before = JSON.stringify(tree);
  const layout = layoutFamilyTree(tree);
  const positions = new Map(layout.nodes.map(node => [node.id, node]));
  const cousin = positions.get('removed-cousin');
  expect(cousin.y).toBe(positions.get('aunt').y);
  expect(cousin.y).toBeLessThan(0);
  expect(cousin.x + TREE_NODE_WIDTH).toBeLessThan(Math.min(positions.get('aunt').x, positions.get('aunt-spouse').x));
  const branch = layout.families.find(family => family.id === 'great-aunt-family');
  const grandparents = layout.families.find(family => family.id === 'grandparents');
  expect(branch.bus.x2).toBeLessThan(grandparents.bus.x1);
  for (const family of [branch, grandparents]) {
    expect(family.busSegments).toEqual(family.bus.x2 - family.bus.x1 > epsilon ? [family.bus] : []);
    expect(family.lane).toBe(0);
  }
  assertRecursiveAncestryParts(tree, layout);
  assertNoOverlaps(layout); assertSeparateConnections(layout.families); assertConnectionsAvoidCards(layout.nodes, layout.families);
  expect(JSON.stringify(tree)).toBe(before);
});

test('the older cousin stays with their parents in the browser through zoom and reload', async ({ page }) => {
  const tree = collateralAncestorFamilyTree();
  await page.goto('/');
  await page.evaluate(async tree => {
    const { storageService } = await import('/services/storageService.ts');
    await storageService.saveFamilyTree(tree);
  }, tree);
  await page.reload();
  await page.getByRole('button', { name: 'Family tree', exact: true }).click();
  const assertBranch = async () => {
    const cousin = await page.locator('[data-person-id="removed-cousin"]').boundingBox();
    const aunt = await page.locator('[data-person-id="aunt-spouse"]').boundingBox();
    expect(cousin.x + cousin.width).toBeLessThan(aunt.x);
    await expect(page.locator('[data-family-id="great-aunt-family"] [data-child-id="removed-cousin"]')).toHaveCount(1);
  };
  await assertBranch();
  await page.getByRole('button', { name: 'Fit tree', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await assertBranch();
  await page.reload();
  await page.getByRole('button', { name: 'Family tree', exact: true }).click();
  await assertBranch();
  expect(await page.evaluate(async () => (await import('/services/storageService.ts')).storageService.loadFamilyTree())).toEqual(tree);
});
