/**
 * Tree Visualization Engine (SVG + Pan/Zoom + Minimap)
 * Modes:
 *  - 'focus': MyHeritage-style Family & Pedigree view (coupled ancestors up, siblings + spouses & cousins across, descendants down)
 *  - 'fan': Interactive Ancestor Fan Chart (180°, 220°, 360°; 3-7 generations)
 *  - 'full': Full Genealogical Tree layout of all individuals & families
 */

window.TreeEngine = (function () {
  const CARD_W = 216;
  const CARD_H = 84;
  const COMPACT_W = 170;
  const COMPACT_H = 64;
  const LEVEL_GAP_Y = 156;
  const SIBLING_GAP_X = 34;
  const SPOUSE_GAP_X = 68;

  function escapeXml(unsafe) {
    if (!unsafe) return "";
    return String(unsafe)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function getLifeYears(p) {
    if (!p) return "";
    const b = p.birth?.dateDisplay || (p.birth?.year ? String(p.birth.year) : "");
    const d = p.death?.dateDisplay || (p.death?.year ? String(p.death.year) : "");
    if (p.birth?.year && p.death?.year) return `${p.birth.year} – ${p.death.year}`;
    if (b && !p.isDeceased) return `n. ${b.toLowerCase()}`;
    if (b && d) return `${b.toLowerCase()} – ${d.toLowerCase()}`;
    if (b && p.isDeceased) return `n. ${b.toLowerCase()} – †`;
    if (d) return `† ${d.toLowerCase()}`;
    if (p.isDeceased) return "Deceduto/a";
    return "Vivente";
  }

  function getInitials(p) {
    if (!p) return "?";
    const g = (p.givenName || "").trim();
    const s = (p.surname || "").trim();
    const i1 = g ? g[0].toUpperCase() : "";
    const i2 = s ? s[0].toUpperCase() : "";
    return i1 + i2 || "?";
  }

  /**
   * Builds an SVG path with smooth rounded corners from a parent union drop point
   * (midX, startY) via a horizontal bus at busY to a child target (childX, endY).
   */
  function buildRoundedDropPath(startX, startY, busY, endX, endY, radius = 12) {
    const dx = endX - startX;
    if (Math.abs(dx) < 2) {
      return `M ${startX} ${startY} L ${endX} ${endY}`;
    }
    const dir = dx > 0 ? 1 : -1;
    const r = Math.min(radius, Math.abs(dx) / 2, Math.abs(busY - startY) / 2, Math.abs(endY - busY) / 2);
    return [
      `M ${startX} ${startY}`,
      `L ${startX} ${busY - r}`,
      `Q ${startX} ${busY} ${startX + dir * r} ${busY}`,
      `L ${endX - dir * r} ${busY}`,
      `Q ${endX} ${busY} ${endX} ${busY + r}`,
      `L ${endX} ${endY}`,
    ].join(" ");
  }

  class Visualizer {
    constructor(containerEl, minimapEl, callbacks) {
      this.container = containerEl;
      this.minimap = minimapEl;
      this.callbacks = callbacks || {};

      this.tree = null;
      this.mode = "focus"; // 'focus' | 'fan' | 'full'
      this.focusPersonId = null;
      this.selectedPersonId = null;

      // Options
      this.ancestorGens = 4;
      this.descendantGens = 4;
      this.showSiblings = true;
      this.compactCards = false;
      this.fanAngle = 220; // 180, 220, 360
      this.fanGens = 5;
      this.surnameFilter = "";

      // Kinship path highlight state
      this.kinshipHighlight = null;

      // Viewport transform
      this.scale = 1;
      this.tx = 0;
      this.ty = 0;
      this.isPanning = false;
      this.panStartX = 0;
      this.panStartY = 0;

      // Computed layout bounds & node positions
      this.nodePositions = new Map(); // personId -> { x, y, w, h }
      this.bounds = { minX: -500, maxX: 500, minY: -400, maxY: 400 };

      this._initDOM();
      this._bindEvents();
    }

    _initDOM() {
      this.container.innerHTML = "";
      this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      this.svg.setAttribute("class", "tree-svg");
      this.svg.setAttribute("width", "100%");
      this.svg.setAttribute("height", "100%");

      const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      defs.innerHTML = `
        <filter id="card-shadow" x="-15%" y="-15%" width="130%" height="145%">
          <feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#000000" flood-opacity="0.18" />
        </filter>
        <filter id="glow-highlight" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="kinship-grad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#f59e0b" />
          <stop offset="50%" stop-color="#ec4899" />
          <stop offset="100%" stop-color="#8b5cf6" />
        </linearGradient>
      `;
      this.svg.appendChild(defs);

      this.viewport = document.createElementNS("http://www.w3.org/2000/svg", "g");
      this.viewport.setAttribute("class", "tree-viewport");
      this.svg.appendChild(this.viewport);

      this.linksLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
      this.linksLayer.setAttribute("class", "tree-links-layer");
      this.viewport.appendChild(this.linksLayer);

      this.kinshipLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
      this.kinshipLayer.setAttribute("class", "tree-kinship-layer");
      this.viewport.appendChild(this.kinshipLayer);

      this.nodesLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
      this.nodesLayer.setAttribute("class", "tree-nodes-layer");
      this.viewport.appendChild(this.nodesLayer);

      this.badgesLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
      this.badgesLayer.setAttribute("class", "tree-badges-layer");
      this.viewport.appendChild(this.badgesLayer);

      this.container.appendChild(this.svg);
    }

    _bindEvents() {
      this.svg.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        this.panMoved = false;
        if (e.target.closest(".node-action-btn")) return;
        this.isPanning = true;
        this.panStartX = e.clientX - this.tx;
        this.panStartY = e.clientY - this.ty;
        this.svg.classList.add("panning");
      });

      window.addEventListener("mousemove", (e) => {
        if (!this.isPanning) return;
        const dx = e.clientX - this.panStartX - this.tx;
        const dy = e.clientY - this.panStartY - this.ty;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          this.panMoved = true;
        }
        this.tx = e.clientX - this.panStartX;
        this.ty = e.clientY - this.panStartY;
        this._applyTransform();
      });

      window.addEventListener("mouseup", () => {
        if (this.isPanning) {
          this.isPanning = false;
          this.svg.classList.remove("panning");
        }
      });

      let lastTouchDist = null;
      this.svg.addEventListener(
        "touchstart",
        (e) => {
          if (e.touches.length === 1) {
            this.panMoved = false;
            if (e.target.closest(".node-action-btn")) return;
            this.isPanning = true;
            this.panStartX = e.touches[0].clientX - this.tx;
            this.panStartY = e.touches[0].clientY - this.ty;
          } else if (e.touches.length === 2) {
            this.isPanning = false;
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            lastTouchDist = Math.hypot(dx, dy);
          }
        },
        { passive: true }
      );

      this.svg.addEventListener(
        "touchmove",
        (e) => {
          if (e.touches.length === 1 && this.isPanning) {
            this.panMoved = true;
            this.tx = e.touches[0].clientX - this.panStartX;
            this.ty = e.touches[0].clientY - this.panStartY;
            this._applyTransform();
          } else if (e.touches.length === 2 && lastTouchDist) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.hypot(dx, dy);
            const factor = dist / lastTouchDist;
            lastTouchDist = dist;
            const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            this.zoomAtPoint(factor, cx, cy);
          }
        },
        { passive: true }
      );

      this.svg.addEventListener("touchend", () => {
        this.isPanning = false;
        lastTouchDist = null;
      });

      this.svg.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          const factor = e.deltaY < 0 ? 1.12 : 0.89;
          const rect = this.svg.getBoundingClientRect();
          const cx = e.clientX - rect.left;
          const cy = e.clientY - rect.top;
          this.zoomAtPoint(factor, cx, cy);
        },
        { passive: false }
      );
    }

    zoomAtPoint(factor, clientX, clientY) {
      const nextScale = Math.min(2.8, Math.max(0.08, this.scale * factor));
      const actualFactor = nextScale / this.scale;
      this.tx = clientX - (clientX - this.tx) * actualFactor;
      this.ty = clientY - (clientY - this.ty) * actualFactor;
      this.scale = nextScale;
      this._applyTransform();
    }

    zoomBy(factor) {
      const rect = this.container.getBoundingClientRect();
      this.zoomAtPoint(factor, rect.width / 2, rect.height / 2);
    }

    _applyTransform(animate = false) {
      if (animate) {
        this.viewport.style.transition = "transform 0.42s cubic-bezier(0.22, 1, 0.36, 1)";
        setTimeout(() => {
          if (this.viewport) this.viewport.style.transition = "";
        }, 450);
      } else {
        this.viewport.style.transition = "";
      }
      this.viewport.setAttribute(
        "transform",
        `translate(${this.tx.toFixed(1)}, ${this.ty.toFixed(1)}) scale(${this.scale.toFixed(4)})`
      );
      this._updateMinimap();
      if (this.callbacks.onZoomChange) {
        this.callbacks.onZoomChange(Math.round(this.scale * 100));
      }
    }

    centerOnCoords(x, y, targetScale = null, animate = true) {
      const rect = this.container.getBoundingClientRect();
      if (targetScale !== null) {
        this.scale = Math.min(2.5, Math.max(0.12, targetScale));
      }
      this.tx = rect.width / 2 - x * this.scale;
      this.ty = rect.height / 2 - y * this.scale;
      this._applyTransform(animate);
    }

    centerOnPerson(personId, targetScale = null, animate = true) {
      const pos = this.nodePositions.get(personId);
      if (pos) {
        this.centerOnCoords(pos.x, pos.y, targetScale, animate);
        return true;
      }
      return false;
    }

    fitToScreen(padding = 70, animate = true) {
      const rect = this.container.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const bw = Math.max(300, this.bounds.maxX - this.bounds.minX);
      const bh = Math.max(300, this.bounds.maxY - this.bounds.minY);
      const scaleX = (rect.width - padding * 2) / bw;
      const scaleY = (rect.height - padding * 2) / bh;
      this.scale = Math.min(1.25, Math.max(0.1, Math.min(scaleX, scaleY)));
      const cx = (this.bounds.minX + this.bounds.maxX) / 2;
      const cy = (this.bounds.minY + this.bounds.maxY) / 2;
      this.tx = rect.width / 2 - cx * this.scale;
      this.ty = rect.height / 2 - cy * this.scale;
      this._applyTransform(animate);
    }

    fitToPeople(personIds, animate = true) {
      const coords = personIds.map((id) => this.nodePositions.get(id)).filter(Boolean);
      if (coords.length === 0) return;
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
      for (const c of coords) {
        minX = Math.min(minX, c.x - CARD_W);
        maxX = Math.max(maxX, c.x + CARD_W);
        minY = Math.min(minY, c.y - CARD_H);
        maxY = Math.max(maxY, c.y + CARD_H);
      }
      const rect = this.container.getBoundingClientRect();
      const bw = Math.max(400, maxX - minX);
      const bh = Math.max(300, maxY - minY);
      const scaleX = (rect.width - 140) / bw;
      const scaleY = (rect.height - 140) / bh;
      this.scale = Math.min(1.15, Math.max(0.15, Math.min(scaleX, scaleY)));
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      this.tx = rect.width / 2 - cx * this.scale;
      this.ty = rect.height / 2 - cy * this.scale;
      this._applyTransform(animate);
    }

    setData(tree, focusPersonId = null) {
      this.tree = tree;
      if (focusPersonId && tree.individuals[focusPersonId]) {
        this.focusPersonId = focusPersonId;
      } else if (!this.focusPersonId || !tree.individuals[this.focusPersonId]) {
        this.focusPersonId = tree.meta?.defaultPersonId || Object.keys(tree.individuals)[0] || null;
      }
      this.render(true);
    }

    setKinshipHighlight(kinshipResult) {
      if (!kinshipResult || !kinshipResult.found) {
        this.kinshipHighlight = null;
      } else {
        this.kinshipHighlight = {
          personIds: new Set(kinshipResult.personIds || []),
          familyIds: new Set(kinshipResult.familyIds || []),
          orderedIds: (kinshipResult.steps || []).map((s) => s.personId),
          commonAncestorIds: new Set(kinshipResult.commonAncestorIds || []),
          rawSteps: kinshipResult.rawSteps || [],
        };

        if (this.mode === "focus" || this.mode === "fan") {
          const allVisible = (kinshipResult.personIds || []).every((id) => this.nodePositions.has(id));
          if (!allVisible) {
            this.mode = "full";
            if (this.callbacks.onModeAutoSwitch) {
              this.callbacks.onModeAutoSwitch("full");
            }
          }
        }
      }
      this.render(false);
      if (this.kinshipHighlight) {
        this.fitToPeople(Array.from(this.kinshipHighlight.personIds), true);
      }
    }

    render(autoCenter = false) {
      if (!this.tree || !this.tree.individuals) return;
      this.linksLayer.innerHTML = "";
      this.kinshipLayer.innerHTML = "";
      this.nodesLayer.innerHTML = "";
      if (this.badgesLayer) this.badgesLayer.innerHTML = "";
      this.nodePositions.clear();

      if (this.mode === "fan") {
        this._renderFanChart();
        if (autoCenter) {
          this.fitToScreen(50, false);
        } else {
          this._updateMinimap();
        }
        return;
      }

      if (this.mode === "focus") {
        this._renderFocusTree();
      } else {
        this._renderFullTree();
      }

      this._drawKinshipOverlay();

      if (autoCenter) {
        if (this.mode === "focus" && this.focusPersonId && this.nodePositions.has(this.focusPersonId)) {
          this.centerOnPerson(this.focusPersonId, 0.88, false);
        } else {
          this.fitToScreen(60, false);
        }
      } else {
        this._updateMinimap();
      }
    }

    // =========================================================================
    // 1. MYHERITAGE-STYLE FOCUS TREE
    //    - Parents stay side-by-side right above children at every generation!
    //    - Siblings of focus person show their spouses & children too!
    // =========================================================================
    _renderFocusTree() {
      const focusId = this.focusPersonId;
      if (!focusId || !this.tree.individuals[focusId]) return;

      const cardW = this.compactCards ? COMPACT_W : CARD_W;
      const cardH = this.compactCards ? COMPACT_H : CARD_H;
      const gapX = this.compactCards ? 24 : SIBLING_GAP_X;
      const gapY = this.compactCards ? 132 : LEVEL_GAP_Y;
      const spouseGap = this.compactCards ? 48 : SPOUSE_GAP_X;

      const placedNodes = new Map(); // id -> { id, x, y, w, h, role }
      const connectors = [];

      const placeNode = (id, x, y, role = "") => {
        if (!placedNodes.has(id)) {
          placedNodes.set(id, { id, x, y, w: cardW, h: cardH, role });
          this.nodePositions.set(id, { x, y, w: cardW, h: cardH });
        }
      };

      // Helper: recursively build a descendant subtree for any person (focus person, sibling, child, etc.)
      // Supports placing spouse on the left (if person is female and has 1 husband) or right (default)
      const visitedDesc = new Set();

      const buildDescendantSubtree = (pid, depth) => {
        visitedDesc.add(pid);
        const p = this.tree.individuals[pid];
        const famsList = (p?.fams || [])
          .map((fid) => this.tree.families[fid])
          .filter(Boolean);

        const spouses = [];
        const childSubtrees = [];

        for (const fam of famsList) {
          const spId = fam.husband === pid ? fam.wife : fam.husband;
          if (spId && this.tree.individuals[spId] && !visitedDesc.has(spId)) {
            visitedDesc.add(spId);
            spouses.push({
              id: spId,
              famId: fam.id,
              marriageYear: fam.marriage?.year || "",
              isHusband: fam.husband === spId,
            });
          }
          if (depth < this.descendantGens) {
            for (const cid of fam.children || []) {
              if (this.tree.individuals[cid] && !visitedDesc.has(cid)) {
                const chSub = buildDescendantSubtree(cid, depth + 1);
                chSub.parentFamId = fam.id;
                childSubtrees.push(chSub);
              }
            }
          }
        }

        // Follow MyHeritage convention: if person is Female and has 1 male spouse, place Husband on Left, Wife on Right
        const spouseOnLeft =
          spouses.length === 1 && p?.sex === "F" && spouses[0].isHusband && pid !== focusId;

        const coupleWidth = cardW + spouses.length * (cardW + spouseGap);
        let childrenTotalWidth = 0;
        if (childSubtrees.length > 0) {
          childrenTotalWidth =
            childSubtrees.reduce((acc, c) => acc + c.width, 0) +
            (childSubtrees.length - 1) * gapX * 1.3;
        }

        return {
          id: pid,
          depth,
          spouses,
          spouseOnLeft,
          children: childSubtrees,
          coupleWidth,
          width: Math.max(coupleWidth, childrenTotalWidth),
        };
      };

      const layoutDescendantSubtree = (node, centerX, y) => {
        let personX = centerX;
        const spousePositions = new Map();

        if (node.spouses.length === 1 && node.spouseOnLeft) {
          // Husband on Left, Blood person (Wife) on Right
          const sp = node.spouses[0];
          const spX = centerX - (cardW + spouseGap) / 2;
          personX = centerX + (cardW + spouseGap) / 2;
          placeNode(sp.id, spX, y, "spouse");
          placeNode(node.id, personX, y, node.id === focusId ? "focus" : "descendant");
          spousePositions.set(sp.famId, {
            p1X: spX,
            p2X: personX,
            midX: centerX,
            marriageYear: sp.marriageYear,
          });
        } else {
          // Blood person on Left, Spouse(s) on Right
          if (node.spouses.length > 0) {
            personX = centerX - (node.spouses.length * (cardW + spouseGap)) / 2;
          }
          placeNode(node.id, personX, y, node.id === focusId ? "focus" : "descendant");
          let curSpX = personX + cardW + spouseGap;
          for (const sp of node.spouses) {
            placeNode(sp.id, curSpX, y, "spouse");
            spousePositions.set(sp.famId, {
              p1X: personX,
              p2X: curSpX,
              midX: (personX + curSpX) / 2,
              marriageYear: sp.marriageYear,
            });
            curSpX += cardW + spouseGap;
          }
        }

        node.placedPersonX = personX;
        node.placedY = y;

        // Layout children below
        if (node.children.length > 0) {
          const nextY = y + gapY;
          const totalChildrenW =
            node.children.reduce((acc, c) => acc + c.width, 0) +
            (node.children.length - 1) * gapX * 1.3;

          const firstSpInfo = node.spouses.length > 0 ? spousePositions.get(node.spouses[0].famId) : null;
          const unionCenterX = firstSpInfo ? firstSpInfo.midX : personX;
          let curLeft = unionCenterX - totalChildrenW / 2;

          const childrenByFam = new Map();
          for (const ch of node.children) {
            const chCenter = curLeft + ch.width / 2;
            layoutDescendantSubtree(ch, chCenter, nextY);
            const famKey = ch.parentFamId || "default";
            if (!childrenByFam.has(famKey)) childrenByFam.set(famKey, []);
            // Connect parent line directly into the blood child's card (ch.placedPersonX)!
            childrenByFam.get(famKey).push({
              x: ch.placedPersonX,
              y: nextY,
              id: ch.id,
            });
            curLeft += ch.width + gapX * 1.3;
          }

          for (const [famKey, chCoords] of childrenByFam.entries()) {
            const spInfo = spousePositions.get(famKey);
            if (spInfo) {
              connectors.push({
                type: "couple-children",
                famId: famKey,
                p1: { x: spInfo.p1X, y },
                p2: { x: spInfo.p2X, y },
                mid: { x: spInfo.midX, y },
                marriageYear: spInfo.marriageYear,
                children: chCoords,
              });
            } else {
              connectors.push({
                type: "single-parent",
                famId: famKey,
                parent: { x: personX, y, id: node.id },
                children: chCoords,
              });
            }
          }
        }

        // Marriage connectors for couples with no children rendered
        for (const sp of node.spouses) {
          const hasChildrenConn = connectors.some((c) => c.famId === sp.famId);
          if (!hasChildrenConn) {
            const spInfo = spousePositions.get(sp.famId);
            if (spInfo) {
              connectors.push({
                type: "couple-only",
                famId: sp.famId,
                p1: { x: spInfo.p1X, y },
                p2: { x: spInfo.p2X, y },
                mid: { x: spInfo.midX, y },
                marriageYear: sp.marriageYear,
              });
            }
          }
        }
      };

      // Step A: Build Generation 0 (Focus Person + Siblings with their spouses & children!)
      const focusPerson = this.tree.individuals[focusId];
      const parentFamId = focusPerson.famc?.[0] || null;
      const parentFam = parentFamId ? this.tree.families[parentFamId] : null;

      const gen0Subtrees = [];
      if (this.showSiblings && parentFam && parentFam.children && parentFam.children.length > 1) {
        for (const cid of parentFam.children) {
          if (this.tree.individuals[cid] && !visitedDesc.has(cid)) {
            gen0Subtrees.push(buildDescendantSubtree(cid, 0));
          }
        }
      } else {
        gen0Subtrees.push(buildDescendantSubtree(focusId, 0));
      }

      // Layout Generation 0 subtrees side by side, then shift so focusPerson is near x = 0
      const totalGen0W =
        gen0Subtrees.reduce((acc, s) => acc + s.width, 0) + (gen0Subtrees.length - 1) * gapX * 1.6;
      let curGen0Left = -totalGen0W / 2;
      const gen0BloodChildrenCoords = [];

      for (const sub of gen0Subtrees) {
        const subCenter = curGen0Left + sub.width / 2;
        layoutDescendantSubtree(sub, subCenter, 0);
        gen0BloodChildrenCoords.push({
          x: sub.placedPersonX,
          y: 0,
          id: sub.id,
        });
        curGen0Left += sub.width + gapX * 1.6;
      }

      // Step B: Coupled Ancestors Upwards (Gen -1 .. -this.ancestorGens)
      // Each node in the ancestor tree is a COUPLE UNIT (Father + Mother side-by-side!),
      // so parents are ALWAYS right next to each other and directly above their children!
      const buildAncestorCoupleTree = (famId, depth) => {
        if (!famId || depth > this.ancestorGens) return null;
        const fam = this.tree.families[famId];
        if (!fam) return null;

        const fatherId = fam.husband && this.tree.individuals[fam.husband] ? fam.husband : null;
        const motherId = fam.wife && this.tree.individuals[fam.wife] ? fam.wife : null;
        if (!fatherId && !motherId) return null;

        const father = fatherId ? this.tree.individuals[fatherId] : null;
        const mother = motherId ? this.tree.individuals[motherId] : null;

        const leftParentsTree =
          father && father.famc?.[0] && depth < this.ancestorGens
            ? buildAncestorCoupleTree(father.famc[0], depth + 1)
            : null;
        const rightParentsTree =
          mother && mother.famc?.[0] && depth < this.ancestorGens
            ? buildAncestorCoupleTree(mother.famc[0], depth + 1)
            : null;

        const ownCoupleW = fatherId && motherId ? cardW * 2 + spouseGap : cardW;
        let upperW = 0;
        if (leftParentsTree && rightParentsTree) {
          upperW = leftParentsTree.width + rightParentsTree.width + gapX * 1.5;
        } else if (leftParentsTree) {
          upperW = leftParentsTree.width;
        } else if (rightParentsTree) {
          upperW = rightParentsTree.width;
        }

        return {
          famId,
          fatherId,
          motherId,
          marriageYear: fam.marriage?.year || "",
          depth,
          ownCoupleW,
          width: Math.max(ownCoupleW, upperW),
          leftParents: leftParentsTree,
          rightParents: rightParentsTree,
        };
      };

      const layoutAncestorCoupleTree = (coupleNode, centerX, y, childrenCoords) => {
        if (!coupleNode) return;

        let fatherX = centerX;
        let motherX = centerX;

        if (coupleNode.fatherId && coupleNode.motherId) {
          // Father and Mother stay side-by-side right around centerX!
          fatherX = centerX - (cardW + spouseGap) / 2;
          motherX = centerX + (cardW + spouseGap) / 2;
          placeNode(coupleNode.fatherId, fatherX, y, "ancestor");
          placeNode(coupleNode.motherId, motherX, y, "ancestor");

          connectors.push({
            type: "couple-children",
            famId: coupleNode.famId,
            p1: { x: fatherX, y },
            p2: { x: motherX, y },
            mid: { x: centerX, y },
            marriageYear: coupleNode.marriageYear,
            children: childrenCoords,
          });
        } else {
          const singleId = coupleNode.fatherId || coupleNode.motherId;
          placeNode(singleId, centerX, y, "ancestor");
          connectors.push({
            type: "single-parent",
            famId: coupleNode.famId,
            parent: { x: centerX, y, id: singleId },
            children: childrenCoords,
          });
        }

        // Now place Father's parents and Mother's parents one row above (y - gapY)
        const nextY = y - gapY;
        const leftT = coupleNode.leftParents;
        const rightT = coupleNode.rightParents;

        if (leftT && rightT) {
          // Ideal centers are above fatherX and motherX, pushed outward only enough so their subtrees don't overlap
          const minDistance = (leftT.width + rightT.width) / 2 + gapX * 1.5;
          const naturalMid = (fatherX + motherX) / 2;
          const leftCenter = Math.min(fatherX, naturalMid - minDistance / 2);
          const rightCenter = Math.max(motherX, naturalMid + minDistance / 2);

          layoutAncestorCoupleTree(leftT, leftCenter, nextY, [
            { x: fatherX, y, id: coupleNode.fatherId },
          ]);
          layoutAncestorCoupleTree(rightT, rightCenter, nextY, [
            { x: motherX, y, id: coupleNode.motherId },
          ]);
        } else if (leftT) {
          layoutAncestorCoupleTree(leftT, fatherX, nextY, [
            { x: fatherX, y, id: coupleNode.fatherId },
          ]);
        } else if (rightT) {
          layoutAncestorCoupleTree(rightT, motherX, nextY, [
            { x: motherX, y, id: coupleNode.motherId },
          ]);
        }
      };

      if (parentFamId && this.ancestorGens > 0) {
        const rootAncCouple = buildAncestorCoupleTree(parentFamId, 1);
        if (rootAncCouple) {
          // Center parents directly above the blood children of generation 0!
          const minChildX = Math.min(...gen0BloodChildrenCoords.map((c) => c.x));
          const maxChildX = Math.max(...gen0BloodChildrenCoords.map((c) => c.x));
          const parentsCenterX = (minChildX + maxChildX) / 2;
          layoutAncestorCoupleTree(rootAncCouple, parentsCenterX, -gapY, gen0BloodChildrenCoords);
        }
      }

      // Render connectors and nodes (passing placedNodes so we know who has hidden branches!)
      this._drawConnectors(connectors, cardW, cardH);
      this._drawNodes(Array.from(placedNodes.values()), placedNodes);
      this._computeBounds(cardW, cardH);
    }

    // =========================================================================
    // 2. ANCESTOR FAN CHART (VENTAGLIO DEGLI ANTENATI)
    // =========================================================================
    _renderFanChart() {
      const focusId = this.focusPersonId;
      if (!focusId || !this.tree.individuals[focusId]) return;

      const maxGen = this.fanGens || 5;
      const totalAngleDeg = this.fanAngle || 220;
      const startAngleDeg = -90 - totalAngleDeg / 2;
      const innerR = 78;
      const ringW = 68;

      const degToRad = (d) => (d * Math.PI) / 180;

      const polarToCartesian = (cx, cy, r, angleDeg) => {
        const rad = degToRad(angleDeg);
        return {
          x: cx + r * Math.cos(rad),
          y: cy + r * Math.sin(rad),
        };
      };

      const createWedgePath = (r1, r2, a1, a2) => {
        const span = Math.min(359.5, a2 - a1);
        const endA = a1 + span;
        const p1 = polarToCartesian(0, 0, r2, a1);
        const p2 = polarToCartesian(0, 0, r2, endA);
        const p3 = polarToCartesian(0, 0, r1, endA);
        const p4 = polarToCartesian(0, 0, r1, a1);
        const largeArc = span > 180 ? 1 : 0;
        return [
          `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
          `A ${r2} ${r2} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
          `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)}`,
          `A ${r1} ${r1} 0 ${largeArc} 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)}`,
          "Z",
        ].join(" ");
      };

      const getWedgeColor = (gen, index, isEmpty) => {
        if (isEmpty) return "rgba(148, 163, 184, 0.08)";
        const totalSlots = 1 << gen;
        const ratio = index / totalSlots;
        const lightness = Math.min(38, 22 + gen * 2.5);
        if (ratio < 0.25) return `hsl(217, 72%, ${lightness}%)`;
        if (ratio < 0.5) return `hsl(168, 65%, ${lightness}%)`;
        if (ratio < 0.75) return `hsl(32, 78%, ${lightness}%)`;
        return `hsl(342, 68%, ${lightness}%)`;
      };

      const slotMap = new Map();
      slotMap.set("0:0", focusId);

      for (let g = 0; g < maxGen; g++) {
        const count = 1 << g;
        for (let i = 0; i < count; i++) {
          const pid = slotMap.get(`${g}:${i}`);
          if (!pid || !this.tree.individuals[pid]) continue;
          const p = this.tree.individuals[pid];
          if (p.famc && p.famc.length > 0) {
            const fam = this.tree.families[p.famc[0]];
            if (fam) {
              if (fam.husband && this.tree.individuals[fam.husband]) {
                slotMap.set(`${g + 1}:${i * 2}`, fam.husband);
              }
              if (fam.wife && this.tree.individuals[fam.wife]) {
                slotMap.set(`${g + 1}:${i * 2 + 1}`, fam.wife);
              }
            }
          }
        }
      }

      for (let g = 1; g <= maxGen; g++) {
        const count = 1 << g;
        const r1 = innerR + (g - 1) * ringW;
        const r2 = innerR + g * ringW;
        const stepAngle = totalAngleDeg / count;

        for (let i = 0; i < count; i++) {
          const a1 = startAngleDeg + i * stepAngle;
          const a2 = a1 + stepAngle;
          const midA = (a1 + a2) / 2;
          const midR = (r1 + r2) / 2;
          const centerPt = polarToCartesian(0, 0, midR, midA);

          const pid = slotMap.get(`${g}:${i}`);
          const person = pid ? this.tree.individuals[pid] : null;
          const childPid = slotMap.get(`${g - 1}:${Math.floor(i / 2)}`);

          if (!person && !childPid) continue;

          const wedgeG = document.createElementNS("http://www.w3.org/2000/svg", "g");
          const isHighlighted =
            person && this.kinshipHighlight && this.kinshipHighlight.personIds.has(person.id);
          const isSelected = person && this.selectedPersonId === person.id;

          wedgeG.setAttribute(
            "class",
            `fan-wedge ${person ? "occupied" : "empty-slot"} ${isSelected ? "selected" : ""} ${
              isHighlighted ? "kinship-active" : ""
            }`
          );

          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", createWedgePath(r1, r2, a1 + 0.35, a2 - 0.35));
          path.setAttribute("fill", getWedgeColor(g, i, !person));
          path.setAttribute(
            "stroke",
            isHighlighted
              ? "#fbbf24"
              : isSelected
              ? "#60a5fa"
              : person
              ? "rgba(255,255,255,0.16)"
              : "rgba(148,163,184,0.12)"
          );
          path.setAttribute("stroke-width", isHighlighted || isSelected ? "2.5" : "1");
          wedgeG.appendChild(path);

          if (person) {
            this.nodePositions.set(person.id, { x: centerPt.x, y: centerPt.y, w: 60, h: 40 });

            const textG = document.createElementNS("http://www.w3.org/2000/svg", "g");
            let rot = midA;
            if (g <= 3 && stepAngle > 22) {
              rot = midA + 90;
              if (rot > 90 && rot < 270) rot += 180;
            } else {
              if (midA > 90 || midA < -90) rot = midA + 180;
            }
            textG.setAttribute(
              "transform",
              `translate(${centerPt.x.toFixed(1)}, ${centerPt.y.toFixed(1)}) rotate(${rot.toFixed(1)})`
            );

            const maxChars = g <= 2 ? 22 : g === 3 ? 18 : g === 4 ? 14 : 11;
            const dispName =
              person.fullName.length > maxChars
                ? person.fullName.slice(0, maxChars - 1) + "…"
                : person.fullName;

            const fontSize = g <= 2 ? 11.5 : g === 3 ? 10 : g === 4 ? 8.8 : 7.5;
            const years = getLifeYears(person);

            let innerSvg = `
              <text class="fan-text-name" y="${years && g <= 4 ? -4 : 3}" font-size="${fontSize}" text-anchor="middle">${escapeXml(
              dispName
            )}</text>
            `;
            if (years && g <= 4) {
              innerSvg += `<text class="fan-text-years" y="9" font-size="${
                fontSize - 1.5
              }" text-anchor="middle">${escapeXml(years)}</text>`;
            }
            textG.innerHTML = innerSvg;
            wedgeG.appendChild(textG);

            wedgeG.addEventListener("click", (e) => {
              if (this.panMoved) return;
              e.stopPropagation();
              if (this.callbacks.onSelectPerson) this.callbacks.onSelectPerson(person.id);
            });
            wedgeG.addEventListener("dblclick", (e) => {
              e.stopPropagation();
              if (this.callbacks.onFocusPerson) this.callbacks.onFocusPerson(person.id);
            });
          } else if (childPid && g <= 4) {
            const role = i % 2 === 0 ? "father" : "mother";
            const plusText = document.createElementNS("http://www.w3.org/2000/svg", "text");
            plusText.setAttribute("x", centerPt.x.toFixed(1));
            plusText.setAttribute("y", (centerPt.y + 4).toFixed(1));
            plusText.setAttribute("text-anchor", "middle");
            plusText.setAttribute("class", "fan-empty-plus");
            plusText.textContent = role === "father" ? "+ Padre" : "+ Madre";
            wedgeG.appendChild(plusText);

            wedgeG.addEventListener("click", (e) => {
              if (this.panMoved) return;
              e.stopPropagation();
              if (this.callbacks.onQuickAddRelative) {
                this.callbacks.onQuickAddRelative(childPid, role);
              }
            });
          }

          this.nodesLayer.appendChild(wedgeG);
        }
      }

      const fp = this.tree.individuals[focusId];
      this.nodePositions.set(focusId, { x: 0, y: 0, w: innerR * 2, h: innerR * 2 });
      const centerG = document.createElementNS("http://www.w3.org/2000/svg", "g");
      centerG.setAttribute("class", "fan-center-node");
      centerG.innerHTML = `
        <circle cx="0" cy="0" r="${innerR - 4}" class="fan-center-circle" filter="url(#card-shadow)" />
        <text y="-8" text-anchor="middle" class="fan-center-given">${escapeXml(
          fp.givenName || fp.fullName
        )}</text>
        <text y="10" text-anchor="middle" class="fan-center-surname">${escapeXml(
          fp.surname || ""
        )}</text>
        <text y="28" text-anchor="middle" class="fan-center-years">${escapeXml(
          getLifeYears(fp)
        )}</text>
      `;
      centerG.addEventListener("click", (e) => {
        if (this.panMoved) return;
        e.stopPropagation();
        if (this.callbacks.onSelectPerson) this.callbacks.onSelectPerson(focusId);
      });
      this.nodesLayer.appendChild(centerG);

      const outerR = innerR + maxGen * ringW + 40;
      this.bounds = { minX: -outerR, maxX: outerR, minY: -outerR, maxY: outerR };
    }

    // =========================================================================
    // 3. FULL TREE (COMPLETE GENEALOGICAL TREE OF ALL PEOPLE)
    // =========================================================================
    _renderFullTree() {
      const individuals = this.tree.individuals;
      const families = this.tree.families;
      const cardW = this.compactCards ? COMPACT_W : CARD_W;
      const cardH = this.compactCards ? COMPACT_H : CARD_H;
      const gapX = this.compactCards ? 22 : 30;
      const gapY = this.compactCards ? 132 : 156;
      const spouseGap = this.compactCards ? 48 : SPOUSE_GAP_X;

      let activeIds = new Set(Object.keys(individuals));
      if (this.surnameFilter) {
        const q = this.surnameFilter.toLowerCase();
        const matched = new Set();
        for (const [id, p] of Object.entries(individuals)) {
          if (
            (p.surname || "").toLowerCase().includes(q) ||
            (p.marriedSurname || "").toLowerCase().includes(q)
          ) {
            matched.add(id);
            for (const fid of p.fams || []) {
              const f = families[fid];
              if (f) {
                if (f.husband) matched.add(f.husband);
                if (f.wife) matched.add(f.wife);
                for (const cid of f.children || []) matched.add(cid);
              }
            }
            for (const fid of p.famc || []) {
              const f = families[fid];
              if (f) {
                if (f.husband) matched.add(f.husband);
                if (f.wife) matched.add(f.wife);
              }
            }
          }
        }
        if (matched.size > 0) activeIds = matched;
      }

      const genMap = new Map();
      const assignComponentGenerations = (seedId) => {
        const compIds = [];
        const queue = [{ id: seedId, gen: 0 }];
        genMap.set(seedId, 0);

        while (queue.length > 0) {
          const { id, gen } = queue.shift();
          compIds.push(id);
          const p = individuals[id];
          if (!p) continue;

          for (const fid of p.famc || []) {
            const fam = families[fid];
            if (!fam) continue;
            for (const parId of [fam.husband, fam.wife]) {
              if (parId && activeIds.has(parId) && !genMap.has(parId)) {
                genMap.set(parId, gen - 1);
                queue.push({ id: parId, gen: gen - 1 });
              }
            }
            for (const sibId of fam.children || []) {
              if (sibId && activeIds.has(sibId) && !genMap.has(sibId)) {
                genMap.set(sibId, gen);
                queue.push({ id: sibId, gen });
              }
            }
          }

          for (const fid of p.fams || []) {
            const fam = families[fid];
            if (!fam) continue;
            for (const spId of [fam.husband, fam.wife]) {
              if (spId && activeIds.has(spId) && !genMap.has(spId)) {
                genMap.set(spId, gen);
                queue.push({ id: spId, gen });
              }
            }
            for (const chId of fam.children || []) {
              if (chId && activeIds.has(chId) && !genMap.has(chId)) {
                genMap.set(chId, gen + 1);
                queue.push({ id: chId, gen: gen + 1 });
              }
            }
          }
        }
        return compIds;
      };

      const components = [];
      if (this.focusPersonId && activeIds.has(this.focusPersonId)) {
        components.push(assignComponentGenerations(this.focusPersonId));
      }
      for (const id of activeIds) {
        if (!genMap.has(id)) {
          components.push(assignComponentGenerations(id));
        }
      }

      components.sort((a, b) => b.length - a.length);

      const placedNodes = new Map();
      const connectors = [];
      let componentOffsetX = 0;

      for (const comp of components) {
        if (comp.length === 0) continue;

        const byGen = new Map();
        let minGen = Infinity,
          maxGen = -Infinity;
        for (const pid of comp) {
          const g = genMap.get(pid) || 0;
          minGen = Math.min(minGen, g);
          maxGen = Math.max(maxGen, g);
          if (!byGen.has(g)) byGen.set(g, []);
          byGen.get(g).push(pid);
        }

        const unitsByGen = new Map();
        const assignedToUnit = new Set();

        for (let g = minGen; g <= maxGen; g++) {
          const pids = byGen.get(g) || [];
          pids.sort((a, b) => {
            const pa = individuals[a];
            const pb = individuals[b];
            const fca = pa?.famc?.[0] || "";
            const fcb = pb?.famc?.[0] || "";
            if (fca !== fcb) return fca.localeCompare(fcb);
            return (pa?.birth?.year || 9999) - (pb?.birth?.year || 9999);
          });

          const units = [];
          for (const pid of pids) {
            if (assignedToUnit.has(pid)) continue;
            const unitMembers = [pid];
            assignedToUnit.add(pid);

            const p = individuals[pid];
            for (const fid of p?.fams || []) {
              const fam = families[fid];
              if (!fam) continue;
              const spId = fam.husband === pid ? fam.wife : fam.husband;
              if (
                spId &&
                activeIds.has(spId) &&
                !assignedToUnit.has(spId) &&
                genMap.get(spId) === g
              ) {
                unitMembers.push(spId);
                assignedToUnit.add(spId);
              }
            }
            units.push({
              members: unitMembers,
              gen: g,
              x: 0,
              width: unitMembers.length * cardW + (unitMembers.length - 1) * spouseGap,
            });
          }
          unitsByGen.set(g, units);
        }

        const memberX = new Map();
        const assignRowX = (g) => {
          const units = unitsByGen.get(g) || [];
          let curX = 0;
          for (const u of units) {
            u.x = curX + u.width / 2;
            let mx = curX;
            for (const m of u.members) {
              memberX.set(m, mx + cardW / 2);
              mx += cardW + spouseGap;
            }
            curX += u.width + gapX * 1.4;
          }
        };

        for (let g = minGen; g <= maxGen; g++) {
          assignRowX(g);
        }

        for (let iter = 0; iter < 4; iter++) {
          for (let g = minGen + 1; g <= maxGen; g++) {
            const units = unitsByGen.get(g) || [];
            for (const u of units) {
              const refXs = [];
              for (const m of u.members) {
                const p = individuals[m];
                for (const fid of p?.famc || []) {
                  const fam = families[fid];
                  if (fam?.husband && memberX.has(fam.husband)) refXs.push(memberX.get(fam.husband));
                  if (fam?.wife && memberX.has(fam.wife)) refXs.push(memberX.get(fam.wife));
                }
              }
              u.desiredX = refXs.length > 0 ? refXs.reduce((a, b) => a + b, 0) / refXs.length : u.x;
            }
            units.sort((a, b) => a.desiredX - b.desiredX);
            let nextMinLeft = -Infinity;
            for (const u of units) {
              const half = u.width / 2;
              const left = Math.max(nextMinLeft, u.desiredX - half);
              u.x = left + half;
              let mx = left;
              for (const m of u.members) {
                memberX.set(m, mx + cardW / 2);
                mx += cardW + spouseGap;
              }
              nextMinLeft = left + u.width + gapX * 1.3;
            }
          }

          for (let g = maxGen - 1; g >= minGen; g--) {
            const units = unitsByGen.get(g) || [];
            for (const u of units) {
              const refXs = [];
              for (const m of u.members) {
                const p = individuals[m];
                for (const fid of p?.fams || []) {
                  const fam = families[fid];
                  for (const cid of fam?.children || []) {
                    if (memberX.has(cid)) refXs.push(memberX.get(cid));
                  }
                }
              }
              u.desiredX = refXs.length > 0 ? refXs.reduce((a, b) => a + b, 0) / refXs.length : u.x;
            }
            units.sort((a, b) => a.desiredX - b.desiredX);
            let nextMinLeft = -Infinity;
            for (const u of units) {
              const half = u.width / 2;
              const left = Math.max(nextMinLeft, u.desiredX - half);
              u.x = left + half;
              let mx = left;
              for (const m of u.members) {
                memberX.set(m, mx + cardW / 2);
                mx += cardW + spouseGap;
              }
              nextMinLeft = left + u.width + gapX * 1.3;
            }
          }
        }

        let compMinX = Infinity,
          compMaxX = -Infinity;
        for (const pid of comp) {
          const x = memberX.get(pid) || 0;
          compMinX = Math.min(compMinX, x - cardW / 2);
          compMaxX = Math.max(compMaxX, x + cardW / 2);
        }

        const shiftX = componentOffsetX - compMinX;
        for (const pid of comp) {
          const finalX = (memberX.get(pid) || 0) + shiftX;
          const finalY = (genMap.get(pid) || 0) * gapY;
          const role = pid === this.focusPersonId ? "focus" : "member";
          placedNodes.set(pid, { id: pid, x: finalX, y: finalY, w: cardW, h: cardH, role });
          this.nodePositions.set(pid, { x: finalX, y: finalY, w: cardW, h: cardH });
        }

        componentOffsetX += compMaxX - compMinX + cardW * 1.8;
      }

      for (const [fid, fam] of Object.entries(families)) {
        const hPos = fam.husband ? placedNodes.get(fam.husband) : null;
        const wPos = fam.wife ? placedNodes.get(fam.wife) : null;
        const chCoords = (fam.children || [])
          .map((cid) => {
            const p = placedNodes.get(cid);
            return p ? { x: p.x, y: p.y, id: cid } : null;
          })
          .filter(Boolean);

        if (hPos && wPos) {
          const midX = (hPos.x + wPos.x) / 2;
          const midY = (hPos.y + wPos.y) / 2;
          if (chCoords.length > 0) {
            connectors.push({
              type: "couple-children",
              famId: fid,
              p1: { x: hPos.x, y: hPos.y },
              p2: { x: wPos.x, y: wPos.y },
              mid: { x: midX, y: midY },
              marriageYear: fam.marriage?.year || "",
              children: chCoords,
            });
          } else {
            connectors.push({
              type: "couple-only",
              famId: fid,
              p1: { x: hPos.x, y: hPos.y },
              p2: { x: wPos.x, y: wPos.y },
              mid: { x: midX, y: midY },
              marriageYear: fam.marriage?.year || "",
            });
          }
        } else if ((hPos || wPos) && chCoords.length > 0) {
          const par = hPos || wPos;
          connectors.push({
            type: "single-parent",
            famId: fid,
            parent: { x: par.x, y: par.y, id: par.id },
            children: chCoords,
          });
        }
      }

      this._drawConnectors(connectors, cardW, cardH);
      this._drawNodes(Array.from(placedNodes.values()), placedNodes);
      this._computeBounds(cardW, cardH);
    }

    // =========================================================================
    // DRAWING CONNECTORS (SMOOTH ROUNDED MYHERITAGE CORNERS), NODES & BADGES
    // =========================================================================
    _drawConnectors(connectors, cardW, cardH) {
      const halfH = cardH / 2;
      let html = "";
      let badgesHtml = "";

      for (const c of connectors) {
        const isHighlighted =
          this.kinshipHighlight && c.famId && this.kinshipHighlight.familyIds.has(c.famId);
        const strokeClass = `tree-link ${isHighlighted ? "kinship-link" : ""}`;

        if (c.type === "couple-only" || c.type === "couple-children") {
          // Horizontal line between spouses
          html += `<path class="${strokeClass} marriage-line" d="M ${c.p1.x} ${c.p1.y} L ${c.p2.x} ${c.p2.y}" />`;

          if (c.marriageYear) {
            const badgeW = 56;
            badgesHtml += `
              <g class="marriage-badge" transform="translate(${c.mid.x}, ${c.mid.y - 16})" filter="url(#card-shadow)">
                <rect x="${-badgeW / 2}" y="-10" width="${badgeW}" height="20" rx="10" class="marriage-pill" />
                <text y="3.5" text-anchor="middle" class="marriage-pill-text">💍 ${escapeXml(
                  c.marriageYear
                )}</text>
              </g>
            `;
          }

          if (c.type === "couple-children" && c.children.length > 0) {
            const busY = c.mid.y + halfH + 30;
            for (const ch of c.children) {
              const d = buildRoundedDropPath(c.mid.x, c.mid.y, busY, ch.x, ch.y - halfH, 13);
              html += `<path class="${strokeClass}" d="${d}" />`;
            }
          }
        } else if (c.type === "single-parent" && c.children.length > 0) {
          const busY = c.parent.y + halfH + 30;
          for (const ch of c.children) {
            const d = buildRoundedDropPath(
              c.parent.x,
              c.parent.y + halfH,
              busY,
              ch.x,
              ch.y - halfH,
              13
            );
            html += `<path class="${strokeClass}" d="${d}" />`;
          }
        }
      }

      this.linksLayer.innerHTML = html;
      if (this.badgesLayer) this.badgesLayer.innerHTML = badgesHtml;
    }

    _drawKinshipOverlay() {
      if (!this.kinshipHighlight || !this.kinshipHighlight.orderedIds) return;
      const ids = this.kinshipHighlight.orderedIds;
      const pts = ids.map((id) => this.nodePositions.get(id)).filter(Boolean);
      if (pts.length < 2) return;

      let d = `M ${pts[0].x} ${pts[0].y}`;
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const cur = pts[i];
        const midY = (prev.y + cur.y) / 2;
        d += ` C ${prev.x} ${midY}, ${cur.x} ${midY}, ${cur.x} ${cur.y}`;
      }

      this.kinshipLayer.innerHTML = `
        <path d="${d}" class="kinship-glow-bg" filter="url(#glow-highlight)" />
        <path d="${d}" class="kinship-glow-line" />
      `;
    }

    _hasHiddenBranch(personId, placedNodes) {
      if (!placedNodes) return { parents: false, family: false };
      const p = this.tree.individuals[personId];
      if (!p) return { parents: false, family: false };

      let hiddenParents = false;
      for (const fid of p.famc || []) {
        const fam = this.tree.families[fid];
        if (!fam) continue;
        if (
          (fam.husband && this.tree.individuals[fam.husband] && !placedNodes.has(fam.husband)) ||
          (fam.wife && this.tree.individuals[fam.wife] && !placedNodes.has(fam.wife))
        ) {
          hiddenParents = true;
          break;
        }
      }

      let hiddenFamily = false;
      for (const fid of p.fams || []) {
        const fam = this.tree.families[fid];
        if (!fam) continue;
        const spId = fam.husband === personId ? fam.wife : fam.husband;
        if (spId && this.tree.individuals[spId] && !placedNodes.has(spId)) {
          hiddenFamily = true;
          break;
        }
        for (const cid of fam.children || []) {
          if (this.tree.individuals[cid] && !placedNodes.has(cid)) {
            hiddenFamily = true;
            break;
          }
        }
      }

      return { parents: hiddenParents, family: hiddenFamily };
    }

    _drawNodes(nodes, placedNodes = null) {
      const hasKinship = Boolean(this.kinshipHighlight);

      for (const n of nodes) {
        const p = this.tree.individuals[n.id];
        if (!p) continue;

        const isSelected = this.selectedPersonId === n.id;
        const isFocus = this.focusPersonId === n.id;
        const isInKinship = hasKinship && this.kinshipHighlight.personIds.has(n.id);
        const isMrca = hasKinship && this.kinshipHighlight.commonAncestorIds.has(n.id);
        const isDimmed = hasKinship && !isInKinship;

        const hiddenInfo = this._hasHiddenBranch(n.id, placedNodes);

        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.setAttribute("transform", `translate(${n.x - n.w / 2}, ${n.y - n.h / 2})`);
        g.setAttribute(
          "class",
          [
            "person-node",
            `sex-${(p.sex || "U").toLowerCase()}`,
            isSelected ? "selected" : "",
            isFocus ? "is-focus" : "",
            isInKinship ? "kinship-node" : "",
            isMrca ? "mrca-node" : "",
            isDimmed ? "dimmed-node" : "",
          ]
            .filter(Boolean)
            .join(" ")
        );
        g.dataset.personId = n.id;

        const years = getLifeYears(p);
        const dispGiven =
          (p.givenName || p.fullName).length > 18
            ? (p.givenName || p.fullName).slice(0, 17) + "…"
            : p.givenName || p.fullName;
        const dispSurname =
          (p.surname || "").length > 18 ? (p.surname || "").slice(0, 17) + "…" : p.surname || "";

        const clipId = `avatar-clip-${n.id.replace(/[^a-zA-Z0-9]/g, "")}`;
        const avatarR = this.compactCards ? 20 : 26;
        const avatarCx = this.compactCards ? 28 : 36;
        const avatarCy = n.h / 2;
        const textX = this.compactCards ? 55 : 70;

        let avatarMarkup = "";
        if (p.primaryPhoto) {
          avatarMarkup = `
            <clipPath id="${clipId}">
              <circle cx="${avatarCx}" cy="${avatarCy}" r="${avatarR}" />
            </clipPath>
            <circle cx="${avatarCx}" cy="${avatarCy}" r="${avatarR + 1.5}" class="avatar-ring" />
            <image href="${escapeXml(p.primaryPhoto)}"
                   x="${avatarCx - avatarR}" y="${avatarCy - avatarR}"
                   width="${avatarR * 2}" height="${avatarR * 2}"
                   preserveAspectRatio="xMidYMid slice"
                   clip-path="url(#${clipId})" />
          `;
        } else {
          avatarMarkup = `
            <circle cx="${avatarCx}" cy="${avatarCy}" r="${avatarR}" class="avatar-fallback" />
            <text x="${avatarCx}" y="${avatarCy + 5}" text-anchor="middle" class="avatar-initials">${escapeXml(
            getInitials(p)
          )}</text>
          `;
        }

        // MyHeritage-style Hidden Branch Indicator above the card (`[▪-▪]`)
        // Shows whenever a person has parents/ancestors or additional family not currently visible
        let hiddenBranchMarkup = "";
        if (hiddenInfo.parents || hiddenInfo.family) {
          const bx = n.w - 38;
          hiddenBranchMarkup = `
            <g class="node-action-btn hidden-branch-indicator" transform="translate(${bx}, -22)" data-action="focus">
              <title>Questa persona ha un ramo familiare aggiuntivo non visibile — Clicca per espandere l'albero di ${escapeXml(
                p.fullName
              )}</title>
              <line x1="16" y1="12" x2="16" y2="22" class="branch-ind-line" />
              <line x1="6" y1="7" x2="26" y2="7" class="branch-ind-line" />
              <line x1="6" y1="7" x2="6" y2="12" class="branch-ind-line" />
              <line x1="26" y1="7" x2="26" y2="12" class="branch-ind-line" />
              <rect x="0" y="0" width="13" height="9" rx="3" class="branch-ind-box" />
              <rect x="19" y="0" width="13" height="9" rx="3" class="branch-ind-box" />
            </g>
          `;
        }

        // MyHeritage-style bottom '+' tab to quickly add a relative
        const bottomAddTabMarkup = `
          <g class="node-action-btn bottom-add-tab" transform="translate(${n.w / 2}, ${n.h})" data-action="add-rel">
            <title>Aggiungi familiare a ${escapeXml(p.fullName)}</title>
            <path d="M -22 0 Q -14 0 -10 11 Q -7 16 0 16 Q 7 16 10 11 Q 14 0 22 0 Z" class="add-tab-bg" />
            <text x="0" y="12" text-anchor="middle" class="add-tab-plus">+</text>
          </g>
        `;

        // Top-right green pivot button (like MyHeritage's green cycle icon) & bottom-right edit pencil
        const cornerIconsMarkup = `
          <g class="node-action-btn pivot-icon-btn" transform="translate(${n.w - 24}, 8)" data-action="focus">
            <title>Centra l'albero su ${escapeXml(p.fullName)}</title>
            <circle cx="8" cy="8" r="8.5" class="pivot-circle ${isFocus ? "active-focus" : ""}" />
            <text x="8" y="11.5" text-anchor="middle" class="pivot-symbol">↻</text>
          </g>
          <g class="node-action-btn edit-icon-btn" transform="translate(${n.w - 22}, ${n.h - 21})" data-action="edit">
            <title>Modifica scheda di ${escapeXml(p.fullName)}</title>
            <text x="7" y="12" text-anchor="middle" class="edit-pencil">✎</text>
          </g>
        `;

        let mrcaBadgeMarkup = "";
        if (isMrca) {
          mrcaBadgeMarkup = `
            <rect x="10" y="-11" width="104" height="19" rx="9.5" class="mrca-badge-rect" />
            <text x="62" y="2" text-anchor="middle" class="mrca-badge-text">★ Antenato Comune</text>
          `;
        }

        g.innerHTML = `
          ${hiddenBranchMarkup}
          ${bottomAddTabMarkup}
          <rect x="0" y="0" width="${n.w}" height="${n.h}" rx="10" class="card-bg" filter="url(#card-shadow)" />
          ${avatarMarkup}
          <text x="${textX}" y="${this.compactCards ? 23 : 29}" class="card-given-name">${escapeXml(
          dispGiven
        )}</text>
          <text x="${textX}" y="${this.compactCards ? 39 : 46}" class="card-surname">${escapeXml(
          dispSurname
        )}</text>
          <text x="${textX}" y="${this.compactCards ? 53 : 64}" class="card-years">${escapeXml(
          years
        )}</text>
          ${mrcaBadgeMarkup}
          ${cornerIconsMarkup}
        `;

        g.addEventListener("click", (e) => {
          const actionBtn = e.target.closest(".node-action-btn");
          if (actionBtn) {
            e.stopPropagation();
            const act = actionBtn.dataset.action;
            if (act === "focus" && this.callbacks.onFocusPerson) {
              this.callbacks.onFocusPerson(n.id);
              return;
            }
            if (act === "add-rel" && this.callbacks.onQuickAddRelative) {
              this.callbacks.onQuickAddRelative(n.id, "child");
              return;
            }
            if (act === "edit" && this.callbacks.onSelectPerson) {
              this.callbacks.onSelectPerson(n.id);
              return;
            }
          }
          if (this.panMoved) return;
          e.stopPropagation();
          if (this.callbacks.onSelectPerson) this.callbacks.onSelectPerson(n.id);
        });

        g.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          if (this.callbacks.onFocusPerson) this.callbacks.onFocusPerson(n.id);
        });

        this.nodesLayer.appendChild(g);
      }
    }

    _computeBounds(cardW, cardH) {
      if (this.nodePositions.size === 0) {
        this.bounds = { minX: -400, maxX: 400, minY: -300, maxY: 300 };
        return;
      }
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
      for (const pos of this.nodePositions.values()) {
        minX = Math.min(minX, pos.x - cardW / 2);
        maxX = Math.max(maxX, pos.x + cardW / 2);
        minY = Math.min(minY, pos.y - cardH / 2);
        maxY = Math.max(maxY, pos.y + cardH / 2);
      }
      this.bounds = { minX: minX - 80, maxX: maxX + 80, minY: minY - 80, maxY: maxY + 80 };
    }

    _updateMinimap() {
      if (!this.minimap) return;
      const canvas = this.minimap.querySelector("canvas");
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const cw = canvas.width;
      const ch = canvas.height;
      ctx.clearRect(0, 0, cw, ch);

      const bw = Math.max(200, this.bounds.maxX - this.bounds.minX);
      const bh = Math.max(200, this.bounds.maxY - this.bounds.minY);
      const scale = Math.min((cw - 16) / bw, (ch - 16) / bh);
      const ox = (cw - bw * scale) / 2 - this.bounds.minX * scale;
      const oy = (ch - bh * scale) / 2 - this.bounds.minY * scale;

      for (const [id, pos] of this.nodePositions.entries()) {
        const mx = ox + pos.x * scale;
        const my = oy + pos.y * scale;
        if (this.kinshipHighlight && this.kinshipHighlight.personIds.has(id)) {
          ctx.fillStyle = "#f59e0b";
          ctx.fillRect(mx - 2.5, my - 2.5, 5, 5);
        } else if (id === this.focusPersonId) {
          ctx.fillStyle = "#38bdf8";
          ctx.fillRect(mx - 2.5, my - 2.5, 5, 5);
        } else {
          ctx.fillStyle = "rgba(148, 163, 184, 0.55)";
          ctx.fillRect(mx - 1.5, my - 1, 3, 2);
        }
      }

      const rect = this.container.getBoundingClientRect();
      if (rect.width && rect.height) {
        const vx1 = (-this.tx / this.scale) * scale + ox;
        const vy1 = (-this.ty / this.scale) * scale + oy;
        const vw = (rect.width / this.scale) * scale;
        const vh = (rect.height / this.scale) * scale;

        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(vx1, vy1, vw, vh);
      }
    }
  }

  return {
    Visualizer,
    getLifeYears,
    getInitials,
    escapeXml,
  };
})();
