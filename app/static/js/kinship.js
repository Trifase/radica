/**
 * Kinship & Relationship Path Finder (in Italian)
 * Finds both blood relationships (via MRCA) and affinity/marriage paths (via BFS).
 */

window.KinshipEngine = (function () {
  function getParents(tree, personId) {
    const p = tree.individuals[personId];
    if (!p || !p.famc) return [];
    const parents = [];
    for (const fid of p.famc) {
      const fam = tree.families[fid];
      if (!fam) continue;
      if (fam.husband && tree.individuals[fam.husband]) {
        parents.push({ id: fam.husband, role: "father", familyId: fid });
      }
      if (fam.wife && tree.individuals[fam.wife]) {
        parents.push({ id: fam.wife, role: "mother", familyId: fid });
      }
    }
    return parents;
  }

  function getChildren(tree, personId) {
    const p = tree.individuals[personId];
    if (!p || !p.fams) return [];
    const children = [];
    for (const fid of p.fams) {
      const fam = tree.families[fid];
      if (!fam || !fam.children) continue;
      for (const cid of fam.children) {
        if (tree.individuals[cid]) {
          children.push({ id: cid, familyId: fid });
        }
      }
    }
    return children;
  }

  function getSpouses(tree, personId) {
    const p = tree.individuals[personId];
    if (!p || !p.fams) return [];
    const spouses = [];
    for (const fid of p.fams) {
      const fam = tree.families[fid];
      if (!fam) continue;
      const otherId = fam.husband === personId ? fam.wife : (fam.wife === personId ? fam.husband : null);
      if (otherId && tree.individuals[otherId]) {
        spouses.push({ id: otherId, familyId: fid });
      }
    }
    return spouses;
  }

  function buildAncestorMap(tree, startId) {
    // Returns Map<personId, { dist, path: Array<{from, to, familyId, dir}> }>
    const map = new Map();
    const queue = [{ id: startId, dist: 0, path: [] }];
    map.set(startId, { dist: 0, path: [] });

    while (queue.length > 0) {
      const cur = queue.shift();
      const parents = getParents(tree, cur.id);
      for (const par of parents) {
        if (!map.has(par.id)) {
          const nextPath = [
            ...cur.path,
            { from: cur.id, to: par.id, familyId: par.familyId, stepType: "up" },
          ];
          map.set(par.id, { dist: cur.dist + 1, path: nextPath });
          queue.push({ id: par.id, dist: cur.dist + 1, path: nextPath });
        }
      }
    }
    return map;
  }

  function describeBloodRelation(dA, dB, sexB, sharedParentCount) {
    const isF = sexB === "F";
    if (dA === 0 && dB === 0) return "Stessa persona";

    // Direct ancestors of A (dB === 0)
    if (dB === 0) {
      if (dA === 1) return isF ? "Madre" : "Padre";
      if (dA === 2) return isF ? "Nonna" : "Nonno";
      if (dA === 3) return isF ? "Bisnonna" : "Bisnonno";
      if (dA === 4) return isF ? "Trisavola (Trisnonna)" : "Trisavolo (Trisnonno)";
      if (dA === 5) return isF ? "Quadrisavola" : "Quadrisavolo";
      if (dA === 6) return isF ? "Quintavola" : "Quintavolo";
      return `${isF ? "Antenata diretta" : "Antenato diretto"} (${dA} generazioni fa)`;
    }

    // Direct descendants of A (dA === 0)
    if (dA === 0) {
      if (dB === 1) return isF ? "Figlia" : "Figlio";
      if (dB === 2) return isF ? "Nipote (figlia di figlio/a)" : "Nipote (figlio di figlio/a)";
      if (dB === 3) return isF ? "Pronipote (in linea retta)" : "Pronipote (in linea retta)";
      if (dB === 4) return isF ? "Trisnipote" : "Trisnipote";
      return `${isF ? "Discendente diretta" : "Discendente diretto"} (${dB} generazioni dopo)`;
    }

    // Siblings
    if (dA === 1 && dB === 1) {
      if (sharedParentCount === 1) {
        return isF ? "Sorellastra (un genitore in comune)" : "Fratellastro (un genitore in comune)";
      }
      return isF ? "Sorella" : "Fratello";
    }

    // Uncles/Aunts & Nephews/Nieces
    if (dA === 1 && dB === 2) return isF ? "Nipote (figlia di fratello/sorella)" : "Nipote (figlio di fratello/sorella)";
    if (dA === 2 && dB === 1) return isF ? "Zia" : "Zio";
    if (dA === 1 && dB === 3) return isF ? "Pronipote (nipote di fratello/sorella)" : "Pronipote (nipote di fratello/sorella)";
    if (dA === 3 && dB === 1) return isF ? "Prozia" : "Prozio";
    if (dA === 1 && dB >= 4) return `${isF ? "Discendente" : "Discendente"} di fratello/sorella (${dB} gen.)`;
    if (dA >= 4 && dB === 1) return `${isF ? "Prozia" : "Prozio"} (${dA - 1}° grado ancestrale)`;

    // Cousins
    if (dA === dB) {
      const degree = dA - 1;
      return `${isF ? "Cugina" : "Cugino"} di ${degree}° grado`;
    }

    const minD = Math.min(dA, dB) - 1;
    const diff = Math.abs(dA - dB);
    if (dA > dB) {
      if (minD === 1 && diff === 1) return isF ? "Zia di 2° grado (cugina del genitore)" : "Zio di 2° grado (cugino del genitore)";
      return `${isF ? "Cugina" : "Cugino"} di ${minD}° grado (${diff} gen. sopra)`;
    } else {
      if (minD === 1 && diff === 1) return isF ? "Nipote di 2° grado (figlia di cugino/a)" : "Nipote di 2° grado (figlio di cugino/a)";
      return `${isF ? "Cugina" : "Cugino"} di ${minD}° grado (${diff} gen. sotto)`;
    }
  }

  function stepRoleLabel(tree, fromId, toId, stepType) {
    const toP = tree.individuals[toId];
    const isF = toP && toP.sex === "F";
    if (stepType === "up") return isF ? "madre" : "padre";
    if (stepType === "down") return isF ? "figlia" : "figlio";
    if (stepType === "spouse") return isF ? "moglie / partner" : "marito / partner";
    return "parente";
  }

  function findRelationship(tree, personAId, personBId) {
    if (!personAId || !personBId || !tree.individuals[personAId] || !tree.individuals[personBId]) {
      return null;
    }

    const personA = tree.individuals[personAId];
    const personB = tree.individuals[personBId];

    if (personAId === personBId) {
      return {
        found: true,
        isBlood: true,
        title: "Stessa persona",
        subtitle: personA.fullName,
        commonAncestor: personA,
        personIds: [personAId],
        familyIds: [],
        steps: [{ personId: personAId, label: "Punto di partenza" }],
      };
    }

    // 1. Check blood relationship via MRCA
    const ancA = buildAncestorMap(tree, personAId);
    const ancB = buildAncestorMap(tree, personBId);

    let bestDist = Infinity;
    let bestAncestors = [];

    for (const [ancId, infoA] of ancA.entries()) {
      if (ancB.has(ancId)) {
        const infoB = ancB.get(ancId);
        const total = infoA.dist + infoB.dist;
        if (total < bestDist) {
          bestDist = total;
          bestAncestors = [ancId];
        } else if (total === bestDist) {
          bestAncestors.push(ancId);
        }
      }
    }

    // 2. Also run BFS over all links (parents, children, spouses) for shortest overall path
    const bfsQueue = [{ id: personAId, path: [] }];
    const visited = new Set([personAId]);
    let bfsSteps = null;

    while (bfsQueue.length > 0) {
      const cur = bfsQueue.shift();
      if (cur.id === personBId) {
        bfsSteps = cur.path;
        break;
      }

      const neighbors = [];
      for (const p of getParents(tree, cur.id)) {
        neighbors.push({ id: p.id, familyId: p.familyId, stepType: "up" });
      }
      for (const c of getChildren(tree, cur.id)) {
        neighbors.push({ id: c.id, familyId: c.familyId, stepType: "down" });
      }
      for (const s of getSpouses(tree, cur.id)) {
        neighbors.push({ id: s.id, familyId: s.familyId, stepType: "spouse" });
      }

      for (const nb of neighbors) {
        if (!visited.has(nb.id)) {
          visited.add(nb.id);
          bfsQueue.push({
            id: nb.id,
            path: [
              ...cur.path,
              { from: cur.id, to: nb.id, familyId: nb.familyId, stepType: nb.stepType },
            ],
          });
        }
      }
    }

    // If blood relationship exists, build the blood path through MRCA
    if (bestAncestors.length > 0) {
      const mrcaId = bestAncestors[0];
      const infoA = ancA.get(mrcaId);
      const infoB = ancB.get(mrcaId);
      const dA = infoA.dist;
      const dB = infoB.dist;

      // Reverse path from MRCA down to B
      const downSteps = [...infoB.path].reverse().map((st) => ({
        from: st.to,
        to: st.from,
        familyId: st.familyId,
        stepType: "down",
      }));

      // Note: if dA === 1 && dB === 1 (siblings), they already share the same familyId in infoA.path[0] and infoB.path[0]
      const fullSteps = [...infoA.path, ...downSteps];
      const personIds = [personAId];
      const familyIds = new Set();
      const uiSteps = [{ personId: personAId, role: "Partenza" }];

      for (const st of fullSteps) {
        personIds.push(st.to);
        if (st.familyId) familyIds.add(st.familyId);
        uiSteps.push({
          personId: st.to,
          familyId: st.familyId,
          stepType: st.stepType,
          role: stepRoleLabel(tree, st.from, st.to, st.stepType),
          isCommonAncestor: st.to === mrcaId && dA > 0 && dB > 0,
        });
      }

      const title = describeBloodRelation(dA, dB, personB.sex, bestAncestors.length);
      const civilDegree = dA + dB;
      const mrcaNames = bestAncestors
        .slice(0, 2)
        .map((id) => tree.individuals[id]?.fullName)
        .filter(Boolean)
        .join(" & ");

      const subtitle =
        dA > 0 && dB > 0
          ? `Antenato comune: ${mrcaNames} (${civilDegree}° grado civile)`
          : `Linea diretta (${civilDegree} ${civilDegree === 1 ? "passaggio" : "passaggi"})`;

      return {
        found: true,
        isBlood: true,
        title,
        subtitle,
        dA,
        dB,
        commonAncestorIds: bestAncestors,
        personIds: Array.from(new Set(personIds)),
        familyIds: Array.from(familyIds),
        rawSteps: fullSteps,
        steps: uiSteps,
      };
    }

    // If no blood relationship, check if BFS found an affinity/marriage path
    if (bfsSteps && bfsSteps.length > 0) {
      const personIds = [personAId];
      const familyIds = new Set();
      const uiSteps = [{ personId: personAId, role: "Partenza" }];

      for (const st of bfsSteps) {
        personIds.push(st.to);
        if (st.familyId) familyIds.add(st.familyId);
        uiSteps.push({
          personId: st.to,
          familyId: st.familyId,
          stepType: st.stepType,
          role: stepRoleLabel(tree, st.from, st.to, st.stepType),
        });
      }

      // Recognize common affinity titles
      const types = bfsSteps.map((s) => s.stepType).join("-");
      const isF = personB.sex === "F";
      let title = "Parente acquisito (affinità)";
      if (types === "spouse") title = isF ? "Moglie / Partner" : "Marito / Partner";
      else if (types === "spouse-up") title = isF ? "Suocera" : "Suocero";
      else if (types === "down-spouse") title = isF ? "Nuora" : "Genero";
      else if (types === "spouse-up-down" || types === "up-down-spouse") title = isF ? "Cognata" : "Cognato";
      else if (types === "up-up-down-spouse") title = isF ? "Zia acquisita" : "Zio acquisito";
      else if (types === "up-spouse") title = isF ? "Matrigna / Coniuge del genitore" : "Patrigno / Coniuge del genitore";
      else if (types === "spouse-down") title = isF ? "Figliastra" : "Figliastro";

      return {
        found: true,
        isBlood: false,
        title,
        subtitle: `Legame tramite matrimonio (${bfsSteps.length} ${bfsSteps.length === 1 ? "passaggio" : "passaggi"})`,
        commonAncestorIds: [],
        personIds: Array.from(new Set(personIds)),
        familyIds: Array.from(familyIds),
        rawSteps: bfsSteps,
        steps: uiSteps,
      };
    }

    return {
      found: false,
      isBlood: false,
      title: "Nessun legame trovato",
      subtitle: "Le due persone appartengono a rami non collegati",
      commonAncestorIds: [],
      personIds: [personAId, personBId],
      familyIds: [],
      rawSteps: [],
      steps: [],
    };
  }

  return {
    findRelationship,
    getParents,
    getChildren,
    getSpouses,
  };
})();
