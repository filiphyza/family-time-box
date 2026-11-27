export function branchingFamilyTree({ depth = 3, extendedInlaws = false, children = 2 } = {}) {
  const tree = { rootId: 'me', people: [], families: [] };
  const person = id => { tree.people.push({ id, name: id }); return id; };
  const family = (id, parentIds, childIds) => tree.families.push({ id, parentIds, childIds });
  person('me'); person('wife'); family('us', ['me', 'wife'], []);
  function ancestry(id, remaining, siblings = true) {
    if (!remaining) return;
    const parents = [person(`${id}-p0`), person(`${id}-p1`)];
    const relatives = [id];
    if (siblings) {
      const sibling = person(`${id}-sibling`), spouse = person(`${id}-inlaw`), child = person(`${id}-cousin`);
      relatives.push(sibling);
      family(`sibling-${id}`, [sibling, spouse], [child]);
      if (extendedInlaws && remaining > 1) ancestry(spouse, 1);
    }
    family(`parents-${id}`, parents, relatives);
    for (const parent of parents) ancestry(parent, remaining - 1, siblings);
  }
  ancestry('me', depth); ancestry('wife', depth);
  for (let index = 0; index < children; index++) {
    const child = person(`child-${index}`), spouse = person(`child-spouse-${index}`), grandchild = person(`grandchild-${index}`);
    tree.families[0].childIds.push(child);
    family(`child-family-${index}`, [child, spouse], [grandchild]);
    ancestry(spouse, 2, extendedInlaws);
  }
  return tree;
}

export function familyTreeWithCousins() {
  const names = { me: 'Alex Taylor', spouse: 'Jamie Morgan', dad: 'Daniel Taylor', mom: 'Sarah Taylor', fil: 'David Morgan', mil: 'Anna Morgan', pgf: 'George Taylor', pgm: 'Alice Taylor', mgf: 'James Reed', mgm: 'Margaret Reed', wpgf: 'John Morgan', wpgm: 'Mary Morgan', wmgf: 'Robert Smith', wmgm: 'Jane Smith', uncle: 'Sam Taylor', aunt: 'Emma Taylor', cousin: 'Oliver Taylor', sibling: 'Henry Taylor', sil: 'Grace Taylor', nephew: 'Noah Taylor', wifesibling: 'Mia Morgan', bil: 'Liam Hill', niece: 'Amelia Hill', kid: 'Leo Taylor', kid2: 'Isla Taylor', kidspouse: 'Chloe Brown', grandchild: 'Ava Taylor' };
  const families = [
    ['us', ['me', 'spouse'], ['kid', 'kid2']], ['mine', ['dad', 'mom'], ['me', 'sibling']],
    ['theirs', ['fil', 'mil'], ['spouse', 'wifesibling']], ['paternal', ['pgf', 'pgm'], ['dad', 'uncle']],
    ['maternal', ['mgf', 'mgm'], ['mom']], ['her-paternal', ['wpgf', 'wpgm'], ['fil']],
    ['her-maternal', ['wmgf', 'wmgm'], ['mil']], ['uncle-family', ['uncle', 'aunt'], ['cousin']],
    ['sibling-family', ['sibling', 'sil'], ['nephew']], ['her-sibling-family', ['wifesibling', 'bil'], ['niece']],
    ['child-family', ['kid', 'kidspouse'], ['grandchild']],
  ].map(([id, parentIds, childIds]) => ({ id, parentIds, childIds }));
  return { rootId: 'me', people: Object.entries(names).map(([id, name]) => ({ id, name })), families };
}

export function collateralAncestorFamilyTree() {
  const ids = ['me', 'dad', 'mom', 'grandmother', 'grandfather', 'aunt-spouse', 'aunt', 'great-uncle', 'great-aunt', 'removed-cousin', 'great-grandfather', 'great-grandmother', 'cousin'];
  const families = [
    ['parents', ['dad', 'mom'], ['me']],
    ['grandparents', ['grandmother', 'grandfather'], ['dad', 'aunt']],
    ['great-grandparents', ['great-grandfather', 'great-grandmother'], ['grandmother', 'great-aunt']],
    ['great-aunt-family', ['great-uncle', 'great-aunt'], ['removed-cousin']],
    ['aunt-family', ['aunt-spouse', 'aunt'], ['cousin']],
  ].map(([id, parentIds, childIds]) => ({ id, parentIds, childIds }));
  return { rootId: 'me', people: ids.map(id => ({ id, name: id })), families };
}
