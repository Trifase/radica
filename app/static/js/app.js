/**
 * Main Application Controller for Albero Genealogico Web
 */

(function () {
  let treeData = null;
  let visualizer = null;
  let currentMode = "focus"; // 'focus' | 'fan' | 'full' | 'table'
  let selectedPersonId = null;

  // Kinship state
  let kinshipPersonA = null;
  let kinshipPersonB = null;

  // Relationship modal state
  let relModalMode = "create"; // 'create' | 'existing'

  // DOM Elements
  const treeTitleEl = document.getElementById("tree-title");
  const treeStatsEl = document.getElementById("tree-stats");
  const canvasContainer = document.getElementById("tree-canvas-container");
  const tableContainer = document.getElementById("table-view-container");
  const minimapContainer = document.getElementById("minimap-container");
  const viewOptionsBar = document.getElementById("view-options-bar");
  const canvasControls = document.getElementById("canvas-controls");

  // Search
  const globalSearchInput = document.getElementById("global-search");
  const clearSearchBtn = document.getElementById("clear-search-btn");
  const searchDropdown = document.getElementById("search-results-dropdown");

  // Drawer
  const personDrawer = document.getElementById("person-drawer");
  const drawerAvatar = document.getElementById("drawer-avatar");
  const drawerFullName = document.getElementById("drawer-full-name");
  const drawerLifeSummary = document.getElementById("drawer-life-summary");
  const drawerMediaCount = document.getElementById("drawer-media-count");

  function showToast(message, isError = false) {
    const container = document.getElementById("toast-container");
    const el = document.createElement("div");
    el.className = "toast";
    if (isError) el.style.borderLeftColor = "#ef4444";
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3500);
  }

  function escapeHtml(s) {
    return window.TreeEngine.escapeXml(s);
  }

  async function apiCall(url, options = {}) {
    const resp = await fetch(url, options);
    if (!resp.ok) {
      let msg = `Errore HTTP ${resp.status}`;
      try {
        const err = await resp.json();
        if (err.detail) msg = err.detail;
      } catch (_) {}
      throw new Error(msg);
    }
    return resp.json();
  }

  // =========================================================================
  // INITIALIZATION
  // =========================================================================
  async function initApp() {
    visualizer = new window.TreeEngine.Visualizer(canvasContainer, minimapContainer, {
      onSelectPerson: (pid) => selectPerson(pid),
      onFocusPerson: (pid) => focusOnPerson(pid),
      onQuickAddRelative: (targetPid, relType) => openRelationshipModal(targetPid, relType),
      onZoomChange: (pct) => {
        document.getElementById("zoom-level-indicator").textContent = `${pct}%`;
      },
      onModeAutoSwitch: (newMode) => {
        setViewMode(newMode, false);
      },
    });

    bindTopbarEvents();
    bindToolbarEvents();
    bindKinshipEvents();
    bindDrawerEvents();
    bindModalEvents();
    bindTableEvents();

    await loadTreeData(true);
  }

  async function loadTreeData(initial = false) {
    try {
      const data = await apiCall("/api/tree");
      treeData = data;
      updateHeaderStats();
      populateSurnameFilter();

      const focusId =
        visualizer.focusPersonId && treeData.individuals[visualizer.focusPersonId]
          ? visualizer.focusPersonId
          : treeData.meta?.defaultPersonId;

      visualizer.setData(treeData, focusId);
      if (initial && focusId) {
        selectPerson(focusId, false);
        kinshipPersonA = focusId;
        updateKinshipInputsUI();
      } else if (selectedPersonId && treeData.individuals[selectedPersonId]) {
        populateDrawer(selectedPersonId);
      }
      if (currentMode === "table") {
        renderPeopleTable();
      }
    } catch (err) {
      showToast("Errore nel caricamento dell'albero: " + err.message, true);
    }
  }

  function updateHeaderStats() {
    if (!treeData) return;
    const subTitle = treeData.meta?.title || "Albero Genealogico";
    treeTitleEl.textContent = "Ràdica";
    document.title = `Ràdica — ${subTitle}`;
    const indCount = Object.keys(treeData.individuals || {}).length;
    const famCount = Object.keys(treeData.families || {}).length;
    treeStatsEl.textContent = `${subTitle} • ${indCount} Persone • ${famCount} Famiglie`;
  }

  function populateSurnameFilter() {
    const select = document.getElementById("opt-surname-filter");
    const currentVal = select.value;
    const counts = new Map();
    for (const p of Object.values(treeData.individuals || {})) {
      const s = (p.surname || "").trim();
      if (s) counts.set(s, (counts.get(s) || 0) + 1);
    }
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    select.innerHTML = `<option value="">Tutti i cognomi (${Object.keys(treeData.individuals).length} persone)</option>`;
    for (const [surn, cnt] of sorted) {
      const opt = document.createElement("option");
      opt.value = surn;
      opt.textContent = `${surn} (${cnt})`;
      select.appendChild(opt);
    }
    select.value = currentVal;
  }

  // =========================================================================
  // VIEW MODES & NAVIGATION
  // =========================================================================
  function setViewMode(mode, reRender = true) {
    currentMode = mode;
    document.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });

    document.getElementById("controls-focus").classList.toggle("hidden", mode !== "focus");
    document.getElementById("controls-fan").classList.toggle("hidden", mode !== "fan");
    document
      .getElementById("controls-full")
      .classList.toggle("hidden", mode !== "full" && mode !== "branches");
    document.getElementById("compact-toggle-wrap").classList.toggle("hidden", mode === "fan");

    if (mode === "table") {
      canvasContainer.classList.add("hidden");
      viewOptionsBar.classList.add("hidden");
      canvasControls.classList.add("hidden");
      tableContainer.classList.remove("hidden");
      renderPeopleTable();
    } else {
      tableContainer.classList.add("hidden");
      canvasContainer.classList.remove("hidden");
      viewOptionsBar.classList.remove("hidden");
      canvasControls.classList.remove("hidden");
      visualizer.mode = mode;
      if (reRender) {
        visualizer.render(true);
      }
    }
  }

  function selectPerson(personId, centerIfOffscreen = false) {
    if (!personId || !treeData?.individuals[personId]) return;
    selectedPersonId = personId;
    visualizer.selectedPersonId = personId;
    visualizer.render(false);
    populateDrawer(personId);
    personDrawer.classList.remove("hidden");

    if (centerIfOffscreen && currentMode !== "table") {
      const ok = visualizer.centerOnPerson(personId, null, true);
      if (!ok) {
        // Person wasn't in the current subset (e.g. beyond focus generations), focus on them!
        focusOnPerson(personId);
      }
    }
  }

  function focusOnPerson(personId) {
    if (!personId || !treeData?.individuals[personId]) return;
    selectedPersonId = personId;
    visualizer.selectedPersonId = personId;
    visualizer.focusPersonId = personId;
    if (currentMode === "table") {
      setViewMode("focus", false);
    }
    visualizer.render(true);
    populateDrawer(personId);
    personDrawer.classList.remove("hidden");
    showToast(`Albero centrato su ${treeData.individuals[personId].fullName}`);
  }

  // =========================================================================
  // SEARCH & KEYBOARD SHORTCUTS
  // =========================================================================
  function searchPeople(query, limit = 25) {
    if (!treeData || !query.trim()) return [];
    const tokens = query
      .toLowerCase()
      .trim()
      .split(/\s+/);

    const results = [];
    for (const p of Object.values(treeData.individuals)) {
      const hay = [
        p.fullName,
        p.givenName,
        p.surname,
        p.marriedSurname,
        p.birth?.place,
        p.birth?.year ? String(p.birth.year) : "",
        p.death?.place,
        p.death?.year ? String(p.death.year) : "",
        p.occupation,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      if (tokens.every((t) => hay.includes(t))) {
        results.push(p);
      }
    }

    results.sort((a, b) => a.fullName.localeCompare(b.fullName));
    return results.slice(0, limit);
  }

  function bindTopbarEvents() {
    // Mode switcher
    document.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => setViewMode(btn.dataset.mode, true));
    });

    // Global search
    globalSearchInput.addEventListener("input", () => {
      const q = globalSearchInput.value;
      clearSearchBtn.classList.toggle("hidden", !q);
      if (!q.trim()) {
        searchDropdown.classList.add("hidden");
        return;
      }
      const matches = searchPeople(q, 20);
      if (matches.length === 0) {
        searchDropdown.innerHTML = `<div class="search-result-item"><div class="res-info"><div class="res-meta">Nessuna persona trovata</div></div></div>`;
      } else {
        searchDropdown.innerHTML = matches
          .map((p) => {
            const years = window.TreeEngine.getLifeYears(p);
            const place = p.birth?.place || p.death?.place || "";
            const avatar = p.primaryPhoto
              ? `<img src="${escapeHtml(p.primaryPhoto)}" class="res-avatar" />`
              : `<div class="res-avatar">${escapeHtml(window.TreeEngine.getInitials(p))}</div>`;
            return `
              <div class="search-result-item" data-pid="${p.id}">
                ${avatar}
                <div class="res-info">
                  <div class="res-name">${escapeHtml(p.fullName)} ${
              p.marriedSurname ? `<small>(${escapeHtml(p.marriedSurname)})</small>` : ""
            }</div>
                  <div class="res-meta">${escapeHtml(years)}${place ? " • 📍 " + escapeHtml(place) : ""}</div>
                </div>
              </div>
            `;
          })
          .join("");
      }
      searchDropdown.classList.remove("hidden");
    });

    searchDropdown.addEventListener("click", (e) => {
      const item = e.target.closest(".search-result-item");
      if (item && item.dataset.pid) {
        const pid = item.dataset.pid;
        searchDropdown.classList.add("hidden");
        selectPerson(pid, true);
      }
    });

    clearSearchBtn.addEventListener("click", () => {
      globalSearchInput.value = "";
      clearSearchBtn.classList.add("hidden");
      searchDropdown.classList.add("hidden");
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-wrapper")) {
        searchDropdown.classList.add("hidden");
      }
    });

    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        globalSearchInput.focus();
      } else if (e.key === "Escape") {
        searchDropdown.classList.add("hidden");
        document.getElementById("media-lightbox").classList.add("hidden");
        document.getElementById("relationship-modal").classList.add("hidden");
        document.getElementById("import-modal").classList.add("hidden");
      }
    });

    // Theme toggle
    document.getElementById("theme-toggle-btn").addEventListener("click", () => {
      const html = document.documentElement;
      const next = html.getAttribute("data-theme") === "dark" ? "light" : "dark";
      html.setAttribute("data-theme", next);
      document.getElementById("theme-toggle-btn").textContent = next === "dark" ? "🌙" : "☀️";
      visualizer.render(false);
    });

    // Topbar buttons
    document.getElementById("new-person-top-btn").addEventListener("click", () => {
      openRelationshipModal(null, null);
    });

    document.getElementById("import-gedcom-btn").addEventListener("click", () => {
      document.getElementById("import-modal").classList.remove("hidden");
    });
  }

  function bindToolbarEvents() {
    document.getElementById("opt-ancestor-gens").addEventListener("change", (e) => {
      visualizer.ancestorGens = parseInt(e.target.value, 10);
      visualizer.render(false);
    });

    document.getElementById("opt-descendant-gens").addEventListener("change", (e) => {
      visualizer.descendantGens = parseInt(e.target.value, 10);
      visualizer.render(false);
    });

    document.getElementById("opt-show-siblings").addEventListener("change", (e) => {
      visualizer.showSiblings = e.target.checked;
      visualizer.render(false);
    });

    document.getElementById("opt-fan-gens").addEventListener("change", (e) => {
      visualizer.fanGens = parseInt(e.target.value, 10);
      visualizer.render(true);
    });

    document.getElementById("opt-fan-angle").addEventListener("change", (e) => {
      visualizer.fanAngle = parseInt(e.target.value, 10);
      visualizer.render(false);
    });

    document.getElementById("opt-surname-filter").addEventListener("change", (e) => {
      visualizer.surnameFilter = e.target.value;
      visualizer.render(true);
    });

    const crossLinksCheckbox = document.getElementById("opt-cross-links");
    if (crossLinksCheckbox) {
      crossLinksCheckbox.addEventListener("change", (e) => {
        visualizer.showCrossLinks = e.target.checked;
        visualizer.render(false);
      });
    }

    document.getElementById("opt-compact-cards").addEventListener("change", (e) => {
      visualizer.compactCards = e.target.checked;
      visualizer.render(false);
    });

    document.getElementById("go-home-person-btn").addEventListener("click", () => {
      const rootId = treeData?.meta?.defaultPersonId;
      if (rootId) focusOnPerson(rootId);
    });

    // Zoom buttons
    document.getElementById("zoom-in-btn").addEventListener("click", () => visualizer.zoomBy(1.2));
    document.getElementById("zoom-out-btn").addEventListener("click", () => visualizer.zoomBy(0.82));
    document.getElementById("zoom-fit-btn").addEventListener("click", () => visualizer.fitToScreen(60, true));
    document.getElementById("zoom-center-btn").addEventListener("click", () => {
      const target = selectedPersonId || visualizer.focusPersonId;
      if (target) visualizer.centerOnPerson(target, 0.95, true);
    });
  }

  // =========================================================================
  // KINSHIP / RELATIONSHIP LINE CALCULATOR
  // =========================================================================
  function bindKinshipEvents() {
    const panel = document.getElementById("kinship-panel");
    const triggerBtn = document.getElementById("toggle-kinship-btn");
    const inputA = document.getElementById("kinship-input-a");
    const inputB = document.getElementById("kinship-input-b");
    const dropA = document.getElementById("kinship-dropdown-a");
    const dropB = document.getElementById("kinship-dropdown-b");

    triggerBtn.addEventListener("click", () => {
      const isHidden = panel.classList.contains("hidden");
      panel.classList.toggle("hidden", !isHidden);
      triggerBtn.classList.toggle("active", isHidden);
      if (isHidden && selectedPersonId && !kinshipPersonA) {
        kinshipPersonA = selectedPersonId;
        updateKinshipInputsUI();
      }
    });

    document.getElementById("close-kinship-btn").addEventListener("click", () => {
      panel.classList.add("hidden");
      triggerBtn.classList.remove("active");
      visualizer.setKinshipHighlight(null);
    });

    document.getElementById("kinship-clear-btn").addEventListener("click", () => {
      kinshipPersonB = null;
      updateKinshipInputsUI();
      document.getElementById("kinship-result-box").classList.add("hidden");
      visualizer.setKinshipHighlight(null);
    });

    document.getElementById("kinship-swap-btn").addEventListener("click", () => {
      const tmp = kinshipPersonA;
      kinshipPersonA = kinshipPersonB;
      kinshipPersonB = tmp;
      updateKinshipInputsUI();
      computeAndHighlightKinship();
    });

    function setupAutocomplete(inputEl, dropEl, onPick) {
      inputEl.addEventListener("input", () => {
        const q = inputEl.value;
        if (!q.trim()) {
          dropEl.classList.add("hidden");
          return;
        }
        const matches = searchPeople(q, 15);
        dropEl.innerHTML = matches
          .map(
            (p) => `
          <div class="search-result-item" data-pid="${p.id}">
            <div class="res-info">
              <div class="res-name">${escapeHtml(p.fullName)}</div>
              <div class="res-meta">${escapeHtml(window.TreeEngine.getLifeYears(p))}</div>
            </div>
          </div>
        `
          )
          .join("");
        dropEl.classList.remove("hidden");
      });

      dropEl.addEventListener("click", (e) => {
        const item = e.target.closest(".search-result-item");
        if (item && item.dataset.pid) {
          dropEl.classList.add("hidden");
          onPick(item.dataset.pid);
        }
      });
    }

    setupAutocomplete(inputA, dropA, (pid) => {
      kinshipPersonA = pid;
      updateKinshipInputsUI();
      computeAndHighlightKinship();
    });

    setupAutocomplete(inputB, dropB, (pid) => {
      kinshipPersonB = pid;
      updateKinshipInputsUI();
      computeAndHighlightKinship();
    });
  }

  function updateKinshipInputsUI() {
    const inputA = document.getElementById("kinship-input-a");
    const inputB = document.getElementById("kinship-input-b");
    inputA.value = kinshipPersonA && treeData?.individuals[kinshipPersonA] ? treeData.individuals[kinshipPersonA].fullName : "";
    inputB.value = kinshipPersonB && treeData?.individuals[kinshipPersonB] ? treeData.individuals[kinshipPersonB].fullName : "";
  }

  function computeAndHighlightKinship() {
    const resBox = document.getElementById("kinship-result-box");
    if (!kinshipPersonA || !kinshipPersonB) {
      resBox.classList.add("hidden");
      visualizer.setKinshipHighlight(null);
      return;
    }

    const rel = window.KinshipEngine.findRelationship(treeData, kinshipPersonA, kinshipPersonB);
    if (!rel) return;

    resBox.classList.remove("hidden");
    const pA = treeData.individuals[kinshipPersonA];
    const pB = treeData.individuals[kinshipPersonB];
    document.getElementById("kinship-relation-title").textContent = `${pB.fullName} è ${rel.title} di ${pA.fullName}`;
    document.getElementById("kinship-relation-subtitle").textContent = rel.subtitle;

    const chainEl = document.getElementById("kinship-steps-chain");
    if (rel.steps && rel.steps.length > 0) {
      chainEl.innerHTML = rel.steps
        .map((st, idx) => {
          const p = treeData.individuals[st.personId];
          if (!p) return "";
          const pill = `
            <div class="kinship-step-pill ${st.isCommonAncestor ? "mrca" : ""}" data-pid="${p.id}">
              <span class="kinship-step-role">${escapeHtml(st.role)}${st.isCommonAncestor ? " ★" : ""}</span>
              <span class="kinship-step-name">${escapeHtml(p.fullName)}</span>
            </div>
          `;
          return idx === 0 ? pill : `<span class="kinship-arrow">→</span>` + pill;
        })
        .join("");

      chainEl.querySelectorAll(".kinship-step-pill").forEach((pill) => {
        pill.addEventListener("click", () => {
          selectPerson(pill.dataset.pid, true);
        });
      });
    } else {
      chainEl.innerHTML = "";
    }

    if (currentMode === "table") {
      setViewMode("full", false);
    }
    visualizer.setKinshipHighlight(rel);
  }

  // =========================================================================
  // PERSON DRAWER (PROFILE, FAMILY, EVENTS, MEDIA)
  // =========================================================================
  function bindDrawerEvents() {
    document.getElementById("close-drawer-btn").addEventListener("click", () => {
      personDrawer.classList.add("hidden");
    });

    // Tabs switching
    document.querySelectorAll(".drawer-tab").forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => {
        const target = tabBtn.dataset.tab;
        document.querySelectorAll(".drawer-tab").forEach((b) => b.classList.toggle("active", b === tabBtn));
        ["profile", "family", "events", "media"].forEach((t) => {
          document.getElementById(`tab-content-${t}`).classList.toggle("hidden", t !== target);
        });
      });
    });

    // Header quick actions
    document.getElementById("drawer-focus-btn").addEventListener("click", () => {
      if (selectedPersonId) focusOnPerson(selectedPersonId);
    });

    document.getElementById("drawer-kinship-btn").addEventListener("click", () => {
      if (!selectedPersonId) return;
      const panel = document.getElementById("kinship-panel");
      panel.classList.remove("hidden");
      document.getElementById("toggle-kinship-btn").classList.add("active");
      if (!kinshipPersonA || kinshipPersonA === selectedPersonId) {
        kinshipPersonA = selectedPersonId;
        document.getElementById("kinship-input-b").focus();
      } else {
        kinshipPersonB = selectedPersonId;
      }
      updateKinshipInputsUI();
      computeAndHighlightKinship();
    });

    document.getElementById("drawer-set-root-btn").addEventListener("click", async () => {
      if (!selectedPersonId) return;
      try {
        await apiCall("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ defaultPersonId: selectedPersonId }),
        });
        treeData.meta.defaultPersonId = selectedPersonId;
        showToast(`${treeData.individuals[selectedPersonId].fullName} impostato come persona principale!`);
      } catch (err) {
        showToast(err.message, true);
      }
    });

    // Save person form
    document.getElementById("person-edit-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!selectedPersonId) return;

      const payload = {
        givenName: document.getElementById("edit-givenName").value,
        surname: document.getElementById("edit-surname").value,
        marriedSurname: document.getElementById("edit-marriedSurname").value,
        sex: document.getElementById("edit-sex").value,
        prefix: document.getElementById("edit-prefix").value,
        suffix: document.getElementById("edit-suffix").value,
        isDeceased: document.getElementById("edit-isDeceased").checked,
        birth: {
          date: document.getElementById("edit-birthDate").value,
          place: document.getElementById("edit-birthPlace").value,
        },
        christening: {
          date: document.getElementById("edit-chrDate").value,
          place: document.getElementById("edit-chrPlace").value,
        },
        death: {
          date: document.getElementById("edit-deathDate").value,
          place: document.getElementById("edit-deathPlace").value,
          cause: document.getElementById("edit-deathCause").value,
          age: document.getElementById("edit-deathAge").value,
        },
        burial: {
          date: document.getElementById("edit-burialDate").value,
          place: document.getElementById("edit-burialPlace").value,
        },
        occupation: document.getElementById("edit-occupation").value,
        address: document.getElementById("edit-address").value,
        email: document.getElementById("edit-email").value,
        notes: document.getElementById("edit-notes").value,
      };

      try {
        const res = await apiCall(`/api/person/${encodeURIComponent(selectedPersonId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        treeData.individuals[selectedPersonId] = res.person;
        populateSurnameFilter();
        visualizer.render(false);
        populateDrawer(selectedPersonId);
        if (currentMode === "table") renderPeopleTable();
        showToast("Modifiche salvate con successo!");
      } catch (err) {
        showToast("Errore nel salvataggio: " + err.message, true);
      }
    });

    // Delete person
    document.getElementById("delete-person-btn").addEventListener("click", async () => {
      if (!selectedPersonId) return;
      const p = treeData.individuals[selectedPersonId];
      if (!confirm(`Sei sicuro di voler eliminare definitivamente ${p.fullName} dall'albero?`)) {
        return;
      }
      try {
        const res = await apiCall(`/api/person/${encodeURIComponent(selectedPersonId)}`, {
          method: "DELETE",
        });
        treeData = res.tree;
        selectedPersonId = treeData.meta?.defaultPersonId;
        personDrawer.classList.add("hidden");
        updateHeaderStats();
        visualizer.setData(treeData, selectedPersonId);
        if (currentMode === "table") renderPeopleTable();
        showToast("Persona eliminata dall'albero.");
      } catch (err) {
        showToast("Errore durante l'eliminazione: " + err.message, true);
      }
    });

    // Quick add relationship buttons inside Family Tab
    document.querySelectorAll(".quick-rel-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!selectedPersonId) return;
        openRelationshipModal(selectedPersonId, btn.dataset.rel);
      });
    });

    // Add custom event button
    document.getElementById("add-custom-event-btn").addEventListener("click", async () => {
      if (!selectedPersonId) return;
      const p = treeData.individuals[selectedPersonId];
      const label = prompt("Tipo di evento (es. Laurea, Servizio Militare, Trasferimento, Matrimonio Religioso):");
      if (!label) return;
      const date = prompt("Data dell'evento (es. 15 MAG 2010 o 2010):", "") || "";
      const place = prompt("Luogo dell'evento:", "") || "";
      const notes = prompt("Note aggiuntive (opzionale):", "") || "";

      const updatedEvents = [
        ...(p.events || []),
        {
          tag: "EVEN",
          type: label,
          label: label,
          date,
          place,
          notes,
        },
      ];

      try {
        const res = await apiCall(`/api/person/${encodeURIComponent(selectedPersonId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events: updatedEvents }),
        });
        treeData.individuals[selectedPersonId] = res.person;
        populateDrawer(selectedPersonId);
        showToast("Evento aggiunto!");
      } catch (err) {
        showToast(err.message, true);
      }
    });

    // Upload media
    document.getElementById("media-file-input").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file || !selectedPersonId) return;
      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", file.name);
      formData.append("set_primary", "true");

      try {
        showToast("Caricamento file in corso...");
        const res = await apiCall(`/api/person/${encodeURIComponent(selectedPersonId)}/media`, {
          method: "POST",
          body: formData,
        });
        treeData.individuals[selectedPersonId] = res.person;
        visualizer.render(false);
        populateDrawer(selectedPersonId);
        showToast("File multimediale caricato!");
      } catch (err) {
        showToast("Errore upload: " + err.message, true);
      } finally {
        e.target.value = "";
      }
    });

    // Lightbox close
    document.getElementById("close-lightbox-btn").addEventListener("click", () => {
      document.getElementById("media-lightbox").classList.add("hidden");
    });
  }

  function populateDrawer(personId) {
    const p = treeData.individuals[personId];
    if (!p) return;

    drawerFullName.textContent = p.fullName;
    const years = window.TreeEngine.getLifeYears(p);
    drawerLifeSummary.textContent = `${years}${p.occupation ? " • " + p.occupation : ""}`;

    if (p.primaryPhoto) {
      drawerAvatar.innerHTML = `<img src="${escapeHtml(p.primaryPhoto)}" alt="${escapeHtml(p.fullName)}" />`;
      drawerAvatar.onclick = () => openLightbox(p.primaryPhoto, p.fullName);
    } else {
      drawerAvatar.innerHTML = `<span>${escapeHtml(window.TreeEngine.getInitials(p))}</span>`;
      drawerAvatar.onclick = null;
    }

    // 1. Profile Form
    document.getElementById("edit-givenName").value = p.givenName || "";
    document.getElementById("edit-surname").value = p.surname || "";
    document.getElementById("edit-marriedSurname").value = p.marriedSurname || "";
    document.getElementById("edit-sex").value = p.sex || "U";
    document.getElementById("edit-prefix").value = p.prefix || "";
    document.getElementById("edit-suffix").value = p.suffix || "";
    document.getElementById("edit-isDeceased").checked = Boolean(p.isDeceased);

    document.getElementById("edit-birthDate").value = p.birth?.date || "";
    document.getElementById("edit-birthPlace").value = p.birth?.place || "";
    document.getElementById("edit-chrDate").value = p.christening?.date || "";
    document.getElementById("edit-chrPlace").value = p.christening?.place || "";

    document.getElementById("edit-deathDate").value = p.death?.date || "";
    document.getElementById("edit-deathPlace").value = p.death?.place || "";
    document.getElementById("edit-deathCause").value = p.death?.cause || "";
    document.getElementById("edit-deathAge").value = p.death?.age || "";
    document.getElementById("edit-burialDate").value = p.burial?.date || "";
    document.getElementById("edit-burialPlace").value = p.burial?.place || "";

    document.getElementById("edit-occupation").value = p.occupation || "";
    document.getElementById("edit-address").value = p.address || "";
    document.getElementById("edit-email").value = p.email || "";
    document.getElementById("edit-notes").value = p.notes || "";

    // 2. Family & Relationships Tab
    renderDrawerFamilyTab(p);

    // 3. Events Tab
    renderDrawerEventsTab(p);

    // 4. Media Tab
    renderDrawerMediaTab(p);
  }

  function renderPersonMiniCard(person, roleSub, unlinkPayload = null) {
    const avatar = person.primaryPhoto
      ? `<img src="${escapeHtml(person.primaryPhoto)}" class="res-avatar" />`
      : `<div class="res-avatar">${escapeHtml(window.TreeEngine.getInitials(person))}</div>`;
    const years = window.TreeEngine.getLifeYears(person);
    const unlinkBtn = unlinkPayload
      ? `<button class="icon-btn sm unlink-rel-btn" data-unlink='${JSON.stringify(
          unlinkPayload
        )}' title="Scollega questa relazione">✕</button>`
      : "";

    return `
      <div class="rel-card">
        <div class="rel-card-main" data-goto="${person.id}">
          ${avatar}
          <div class="rel-card-info">
            <div class="rel-card-name">${escapeHtml(person.fullName)}</div>
            <div class="rel-card-sub">${escapeHtml(roleSub)} • ${escapeHtml(years)}</div>
          </div>
        </div>
        ${unlinkBtn}
      </div>
    `;
  }

  function renderDrawerFamilyTab(p) {
    const container = document.getElementById("drawer-family-lists");
    let html = "";

    // Parents & Siblings
    const parentsHtml = [];
    const siblingsHtml = [];
    for (const famcId of p.famc || []) {
      const fam = treeData.families[famcId];
      if (!fam) continue;
      if (fam.husband && treeData.individuals[fam.husband]) {
        parentsHtml.push(
          renderPersonMiniCard(treeData.individuals[fam.husband], "Padre", {
            familyId: famcId,
            personId: p.id,
            role: "child",
          })
        );
      }
      if (fam.wife && treeData.individuals[fam.wife]) {
        parentsHtml.push(
          renderPersonMiniCard(treeData.individuals[fam.wife], "Madre", {
            familyId: famcId,
            personId: p.id,
            role: "child",
          })
        );
      }
      for (const cid of fam.children || []) {
        if (cid !== p.id && treeData.individuals[cid]) {
          const sib = treeData.individuals[cid];
          siblingsHtml.push(renderPersonMiniCard(sib, sib.sex === "F" ? "Sorella" : "Fratello"));
        }
      }
    }

    html += `
      <div class="fam-group-block">
        <div class="fam-group-header">Genitori (${parentsHtml.length})</div>
        ${parentsHtml.join("") || `<p class="modal-help-text">Nessun genitore registrato.</p>`}
      </div>
    `;

    // Marriages / Spouses & Children
    const famsList = (p.fams || []).map((fid) => treeData.families[fid]).filter(Boolean);
    html += `<div class="fam-group-block"><div class="fam-group-header">Coniugi &amp; Figli (${famsList.length} unioni)</div>`;

    if (famsList.length === 0) {
      html += `<p class="modal-help-text">Nessun coniuge o figlio registrato.</p>`;
    } else {
      for (const fam of famsList) {
        const isHusband = fam.husband === p.id;
        const spouseId = isHusband ? fam.wife : fam.husband;
        const spouseRole = isHusband ? "wife" : "husband";
        const spouse = spouseId ? treeData.individuals[spouseId] : null;

        if (spouse) {
          html += renderPersonMiniCard(spouse, "Coniuge / Partner", {
            familyId: fam.id,
            personId: spouse.id,
            role: spouseRole,
          });
        }

        // Editable marriage date & place
        html += `
          <div class="marriage-edit-inline">
            <div>💍 <strong>Matrimonio (${fam.id})</strong> ${
          fam.marriage?.dateDisplay ? "• " + escapeHtml(fam.marriage.dateDisplay) : ""
        }</div>
            <div class="marriage-edit-row">
              <input type="text" placeholder="Data matrimonio (es. 18 APR 2018)" value="${escapeHtml(
                fam.marriage?.date || ""
              )}" data-fam-date="${fam.id}" />
              <input type="text" placeholder="Luogo matrimonio" value="${escapeHtml(
                fam.marriage?.place || ""
              )}" data-fam-place="${fam.id}" />
              <button class="mini-pill-btn primary save-fam-btn" data-famid="${fam.id}">Salva</button>
            </div>
          </div>
        `;

        // Children of this family
        for (const cid of fam.children || []) {
          const ch = treeData.individuals[cid];
          if (ch) {
            html += renderPersonMiniCard(ch, ch.sex === "F" ? "Figlia" : "Figlio", {
              familyId: fam.id,
              personId: ch.id,
              role: "child",
            });
          }
        }
      }
    }
    html += `</div>`;

    // Siblings
    html += `
      <div class="fam-group-block">
        <div class="fam-group-header">Fratelli e Sorelle (${siblingsHtml.length})</div>
        ${siblingsHtml.join("") || `<p class="modal-help-text">Nessun fratello/sorella registrato.</p>`}
      </div>
    `;

    container.innerHTML = html;

    // Bind click to navigate to relative
    container.querySelectorAll("[data-goto]").forEach((el) => {
      el.addEventListener("click", () => {
        selectPerson(el.dataset.goto, true);
      });
    });

    // Bind save marriage info
    container.querySelectorAll(".save-fam-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const fid = btn.dataset.famid;
        const dateIn = container.querySelector(`[data-fam-date="${fid}"]`).value;
        const placeIn = container.querySelector(`[data-fam-place="${fid}"]`).value;
        try {
          const res = await apiCall(`/api/family/${encodeURIComponent(fid)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ marriage: { date: dateIn, place: placeIn } }),
          });
          treeData = res.tree;
          visualizer.setData(treeData, visualizer.focusPersonId);
          populateDrawer(selectedPersonId);
          showToast("Dati matrimonio aggiornati!");
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });

    // Bind unlink buttons
    container.querySelectorAll(".unlink-rel-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const payload = JSON.parse(btn.dataset.unlink);
        if (!confirm("Vuoi scollegare questo legame familiare?")) return;
        try {
          const res = await apiCall("/api/relationship/unlink", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          treeData = res.tree;
          visualizer.setData(treeData, visualizer.focusPersonId);
          populateDrawer(selectedPersonId);
          showToast("Legame rimosso.");
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });
  }

  function renderDrawerEventsTab(p) {
    const listEl = document.getElementById("drawer-events-list");
    const allEvents = [];

    if (p.birth?.date || p.birth?.place) {
      allEvents.push({
        label: "Nascita",
        dateDisplay: p.birth.dateDisplay || p.birth.date,
        place: p.birth.place,
        year: p.birth.year || 0,
        fixed: true,
      });
    }
    if (p.christening?.date || p.christening?.place) {
      allEvents.push({
        label: "Battesimo",
        dateDisplay: p.christening.dateDisplay || p.christening.date,
        place: p.christening.place,
        year: p.christening.year || 0,
        fixed: true,
      });
    }

    // Marriages from families
    for (const fid of p.fams || []) {
      const fam = treeData.families[fid];
      if (!fam) continue;
      const spId = fam.husband === p.id ? fam.wife : fam.husband;
      const sp = spId ? treeData.individuals[spId] : null;
      if (fam.marriage?.date || fam.marriage?.place || sp) {
        allEvents.push({
          label: `Matrimonio${sp ? " con " + sp.fullName : ""}`,
          dateDisplay: fam.marriage?.dateDisplay || fam.marriage?.date || "",
          place: fam.marriage?.place || "",
          year: fam.marriage?.year || 9998,
          fixed: true,
        });
      }
    }

    // Other events
    (p.events || []).forEach((ev, idx) => {
      if (["BIRT", "CHR", "BAPM", "DEAT", "BURI"].includes(ev.tag)) return;
      allEvents.push({
        idx,
        id: ev.id,
        label: ev.label || ev.type || ev.tag,
        value: ev.value,
        dateDisplay: ev.dateDisplay || ev.date,
        place: ev.place,
        notes: ev.notes,
        year: ev.year || 5000,
        fixed: false,
      });
    });

    if (p.isDeceased || p.death?.date || p.death?.place) {
      allEvents.push({
        label: "Decesso",
        dateDisplay: p.death?.dateDisplay || p.death?.date || "",
        place: p.death?.place || "",
        notes: p.death?.cause ? `Causa: ${p.death.cause}` : "",
        year: p.death?.year || 9999,
        fixed: true,
      });
    }

    if (p.burial?.date || p.burial?.place) {
      allEvents.push({
        label: "Sepoltura",
        dateDisplay: p.burial.dateDisplay || p.burial.date,
        place: p.burial.place,
        year: p.burial.year || 10000,
        fixed: true,
      });
    }

    if (allEvents.length === 0) {
      listEl.innerHTML = `<p class="modal-help-text">Nessun evento registrato per questa persona.</p>`;
      return;
    }

    listEl.innerHTML = allEvents
      .map(
        (ev) => `
      <div class="event-card">
        <div class="event-card-top">
          <span class="event-tag-badge">${escapeHtml(ev.label)}${
          ev.value ? ": " + escapeHtml(ev.value) : ""
        }</span>
          <span class="event-date-str">${escapeHtml(ev.dateDisplay || "")}</span>
        </div>
        ${ev.place ? `<div class="event-place-str">📍 ${escapeHtml(ev.place)}</div>` : ""}
        ${ev.notes ? `<div class="event-place-str">${escapeHtml(ev.notes)}</div>` : ""}
      </div>
    `
      )
      .join("");
  }

  function renderDrawerMediaTab(p) {
    const mediaList = p.media || [];
    drawerMediaCount.textContent = String(mediaList.length);
    const grid = document.getElementById("drawer-media-gallery");

    if (mediaList.length === 0) {
      grid.innerHTML = `<p class="modal-help-text" style="grid-column: 1 / -1;">Nessuna foto o documento associato.</p>`;
      return;
    }

    grid.innerHTML = mediaList
      .map((m) => {
        const isPdf = m.form === "pdf";
        const thumb = isPdf
          ? `<div class="pdf-thumb"><span>📄</span><span>Documento PDF</span></div>`
          : `<img src="${escapeHtml(m.url)}" alt="${escapeHtml(m.title)}" loading="lazy" />`;

        return `
        <div class="media-item-card">
          <div class="media-thumb-wrap" data-url="${escapeHtml(m.url)}" data-title="${escapeHtml(
          m.title
        )}" data-pdf="${isPdf}">
            ${thumb}
          </div>
          <div class="media-item-footer">
            <div class="media-item-title" title="${escapeHtml(m.title)}">${escapeHtml(m.title)}</div>
            <div class="media-item-actions">
              ${
                !isPdf
                  ? `<button class="mini-pill-btn ${
                      p.primaryPhoto === m.url ? "primary" : ""
                    }" data-setprim="${escapeHtml(m.id)}">${
                      p.primaryPhoto === m.url ? "★ Principale" : "Usa come profilo"
                    }</button>`
                  : `<a href="${escapeHtml(m.url)}" target="_blank" class="mini-pill-btn primary">Apri PDF ↗</a>`
              }
              <button class="mini-pill-btn" data-delmedia="${escapeHtml(m.id)}" title="Elimina">🗑️</button>
            </div>
          </div>
        </div>
      `;
      })
      .join("");

    grid.querySelectorAll(".media-thumb-wrap").forEach((wrap) => {
      wrap.addEventListener("click", () => {
        if (wrap.dataset.pdf === "true") {
          window.open(wrap.dataset.url, "_blank");
        } else {
          openLightbox(wrap.dataset.url, wrap.dataset.title);
        }
      });
    });

    grid.querySelectorAll("[data-setprim]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const res = await apiCall(`/api/person/${encodeURIComponent(selectedPersonId)}/primary-media`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mediaId: btn.dataset.setprim }),
          });
          treeData.individuals[selectedPersonId] = res.person;
          visualizer.render(false);
          populateDrawer(selectedPersonId);
          showToast("Foto profilo aggiornata!");
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });

    grid.querySelectorAll("[data-delmedia]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Rimuovere questo file multimediale?")) return;
        try {
          const res = await apiCall(
            `/api/person/${encodeURIComponent(selectedPersonId)}/media/${encodeURIComponent(btn.dataset.delmedia)}`,
            { method: "DELETE" }
          );
          treeData.individuals[selectedPersonId] = res.person;
          visualizer.render(false);
          populateDrawer(selectedPersonId);
          showToast("Media rimosso.");
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });
  }

  function openLightbox(url, caption) {
    document.getElementById("lightbox-img").src = url;
    document.getElementById("lightbox-caption").textContent = caption || "";
    document.getElementById("media-lightbox").classList.remove("hidden");
  }

  // =========================================================================
  // MODAL: CREATE PERSON / LINK RELATIONSHIP & IMPORT GEDCOM
  // =========================================================================
  function openRelationshipModal(targetId, linkType) {
    const modal = document.getElementById("relationship-modal");
    document.getElementById("rel-target-id").value = targetId || "";
    document.getElementById("rel-link-type").value = linkType || "";

    // Reset fields
    document.getElementById("new-givenName").value = "";
    document.getElementById("new-surname").value = "";
    document.getElementById("new-occupation").value = "";
    document.getElementById("new-birthDate").value = "";
    document.getElementById("new-birthPlace").value = "";
    document.getElementById("new-deathDate").value = "";
    document.getElementById("new-deathPlace").value = "";
    document.getElementById("rel-marriageDate").value = "";
    document.getElementById("rel-marriagePlace").value = "";
    document.getElementById("existing-person-search").value = "";
    document.getElementById("existing-person-selected-id").value = "";
    document.getElementById("existing-person-list").innerHTML = "";

    const targetPerson = targetId ? treeData.individuals[targetId] : null;
    const banner = document.getElementById("rel-target-banner");
    const modeSwitch = document.getElementById("rel-modal-mode-switch");
    const marriageFields = document.getElementById("rel-marriage-fields");
    const famSelectGroup = document.getElementById("rel-family-select-group");
    const famSelect = document.getElementById("rel-family-select");

    setRelModalTab("create");

    if (!targetPerson || !linkType) {
      document.getElementById("rel-modal-title").textContent = "➕ Crea Nuova Persona";
      banner.classList.add("hidden");
      modeSwitch.classList.add("hidden");
      marriageFields.classList.add("hidden");
      famSelectGroup.classList.add("hidden");
    } else {
      modeSwitch.classList.remove("hidden");
      banner.classList.remove("hidden");

      const labels = {
        father: "Padre",
        mother: "Madre",
        spouse: "Coniuge / Partner",
        child: "Figlio / Figlia",
        sibling: "Fratello / Sorella",
      };
      document.getElementById("rel-modal-title").textContent = `Aggiungi ${labels[linkType]} a ${targetPerson.fullName}`;
      banner.innerHTML = `Stai aggiungendo un <strong>${labels[linkType]}</strong> per <strong>${escapeHtml(
        targetPerson.fullName
      )}</strong>`;

      // Pre-fill sex & surname intelligently
      if (linkType === "father") {
        document.getElementById("new-sex").value = "M";
        document.getElementById("new-surname").value = targetPerson.surname || "";
      } else if (linkType === "mother") {
        document.getElementById("new-sex").value = "F";
      } else if (linkType === "spouse") {
        document.getElementById("new-sex").value = targetPerson.sex === "M" ? "F" : "M";
      } else if (linkType === "child" || linkType === "sibling") {
        if (targetPerson.sex === "M" || linkType === "sibling") {
          document.getElementById("new-surname").value = targetPerson.surname || "";
        }
      }

      marriageFields.classList.toggle("hidden", linkType !== "spouse");

      // If adding a child and target has multiple marriages, let user pick which marriage
      if (linkType === "child" && targetPerson.fams && targetPerson.fams.length > 1) {
        famSelectGroup.classList.remove("hidden");
        famSelect.innerHTML = targetPerson.fams
          .map((fid) => {
            const f = treeData.families[fid];
            const spId = f?.husband === targetPerson.id ? f?.wife : f?.husband;
            const sp = spId ? treeData.individuals[spId] : null;
            return `<option value="${fid}">Unione con ${sp ? escapeHtml(sp.fullName) : "Sconosciuto"} (${fid})</option>`;
          })
          .join("");
      } else {
        famSelectGroup.classList.add("hidden");
        famSelect.innerHTML = "";
      }
    }

    modal.classList.remove("hidden");
  }

  function setRelModalTab(mode) {
    relModalMode = mode;
    document.querySelectorAll("#rel-modal-mode-switch .modal-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.relmode === mode);
    });
    document.getElementById("rel-create-fields").classList.toggle("hidden", mode !== "create");
    document.getElementById("rel-existing-fields").classList.toggle("hidden", mode !== "existing");
  }

  function bindModalEvents() {
    document.querySelectorAll("#rel-modal-mode-switch .modal-tab").forEach((tab) => {
      tab.addEventListener("click", () => setRelModalTab(tab.dataset.relmode));
    });

    const closeRelModal = () => document.getElementById("relationship-modal").classList.add("hidden");
    document.getElementById("close-rel-modal-btn").addEventListener("click", closeRelModal);
    document.getElementById("cancel-rel-modal-btn").addEventListener("click", closeRelModal);

    // Search existing candidates inside modal
    const existSearch = document.getElementById("existing-person-search");
    const existList = document.getElementById("existing-person-list");
    const existSelected = document.getElementById("existing-person-selected-id");

    existSearch.addEventListener("input", () => {
      const matches = searchPeople(existSearch.value, 20);
      existList.innerHTML = matches
        .map(
          (p) => `
        <div class="candidate-row ${existSelected.value === p.id ? "selected" : ""}" data-cid="${p.id}">
          <span>${escapeHtml(p.fullName)}</span>
          <span>${escapeHtml(window.TreeEngine.getLifeYears(p))}</span>
        </div>
      `
        )
        .join("");
    });

    existList.addEventListener("click", (e) => {
      const row = e.target.closest(".candidate-row");
      if (!row) return;
      existSelected.value = row.dataset.cid;
      existList.querySelectorAll(".candidate-row").forEach((r) => r.classList.toggle("selected", r === row));
    });

    // Submit Relationship / Create Person Modal
    document.getElementById("rel-modal-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const targetId = document.getElementById("rel-target-id").value || null;
      const linkType = document.getElementById("rel-link-type").value || null;
      const familyId = document.getElementById("rel-family-select").value || null;
      const marriageDate = document.getElementById("rel-marriageDate").value;
      const marriagePlace = document.getElementById("rel-marriagePlace").value;

      try {
        if (relModalMode === "create" || !targetId) {
          const givn = document.getElementById("new-givenName").value.trim();
          const surn = document.getElementById("new-surname").value.trim();
          if (!givn && !surn) {
            showToast("Inserisci almeno il nome o il cognome.", true);
            return;
          }

          const res = await apiCall("/api/person", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              givenName: givn,
              surname: surn,
              sex: document.getElementById("new-sex").value,
              occupation: document.getElementById("new-occupation").value,
              birthDate: document.getElementById("new-birthDate").value,
              birthPlace: document.getElementById("new-birthPlace").value,
              deathDate: document.getElementById("new-deathDate").value,
              deathPlace: document.getElementById("new-deathPlace").value,
              targetPersonId: targetId,
              linkType: linkType,
              familyId: familyId,
              marriageDate,
              marriagePlace,
            }),
          });
          treeData = res.tree;
          updateHeaderStats();
          populateSurnameFilter();
          closeRelModal();
          visualizer.setData(treeData, visualizer.focusPersonId);
          selectPerson(targetId || res.person.id, false);
          showToast(`Aggiunto ${res.person.fullName}!`);
        } else {
          const relatedId = existSelected.value;
          if (!relatedId) {
            showToast("Seleziona una persona dall'elenco.", true);
            return;
          }
          const res = await apiCall("/api/relationship", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              targetPersonId: targetId,
              relatedPersonId: relatedId,
              linkType,
              familyId,
              marriageDate,
              marriagePlace,
            }),
          });
          treeData = res.tree;
          closeRelModal();
          visualizer.setData(treeData, visualizer.focusPersonId);
          selectPerson(targetId, false);
          showToast("Legame familiare creato!");
        }
      } catch (err) {
        showToast(err.message, true);
      }
    });

    // Import GEDCOM Modal
    const closeImport = () => document.getElementById("import-modal").classList.add("hidden");
    document.getElementById("close-import-modal-btn").addEventListener("click", closeImport);
    document.getElementById("cancel-import-modal-btn").addEventListener("click", closeImport);

    document.getElementById("import-gedcom-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById("gedcom-file-input");
      if (!fileInput.files[0]) return;
      const formData = new FormData();
      formData.append("file", fileInput.files[0]);
      try {
        showToast("Importazione GEDCOM in corso...");
        const res = await apiCall("/api/gedcom/import", {
          method: "POST",
          body: formData,
        });
        treeData = res.tree;
        closeImport();
        updateHeaderStats();
        populateSurnameFilter();
        visualizer.setData(treeData, treeData.meta?.defaultPersonId);
        if (treeData.meta?.defaultPersonId) {
          selectPerson(treeData.meta.defaultPersonId, false);
        }
        showToast("File GEDCOM importato con successo! Download foto avviato in background.");
      } catch (err) {
        showToast("Errore importazione: " + err.message, true);
      }
    });
  }

  // =========================================================================
  // TABLE / DIRECTORY VIEW
  // =========================================================================
  function bindTableEvents() {
    ["table-search-input", "table-sex-filter", "table-photo-filter", "table-sort-by"].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener("input", renderPeopleTable);
      el.addEventListener("change", renderPeopleTable);
    });
  }

  function renderPeopleTable() {
    if (!treeData) return;
    const q = document.getElementById("table-search-input").value.toLowerCase().trim();
    const sexFilter = document.getElementById("table-sex-filter").value;
    const photoFilter = document.getElementById("table-photo-filter").value;
    const sortBy = document.getElementById("table-sort-by").value;

    let list = Object.values(treeData.individuals || {});

    if (q) {
      const tokens = q.split(/\s+/);
      list = list.filter((p) => {
        const hay = [
          p.fullName,
          p.marriedSurname,
          p.birth?.place,
          p.death?.place,
          p.occupation,
          p.notes,
          p.birth?.year ? String(p.birth.year) : "",
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return tokens.every((t) => hay.includes(t));
      });
    }

    if (sexFilter) {
      list = list.filter((p) => p.sex === sexFilter);
    }

    if (photoFilter === "with_photo") {
      list = list.filter((p) => Boolean(p.primaryPhoto));
    } else if (photoFilter === "living") {
      list = list.filter((p) => !p.isDeceased);
    } else if (photoFilter === "deceased") {
      list = list.filter((p) => p.isDeceased);
    }

    list.sort((a, b) => {
      if (sortBy === "surname") {
        const cmp = (a.surname || "ZZZ").localeCompare(b.surname || "ZZZ");
        return cmp !== 0 ? cmp : (a.givenName || "").localeCompare(b.givenName || "");
      }
      if (sortBy === "givenName") {
        return (a.givenName || "").localeCompare(b.givenName || "");
      }
      if (sortBy === "birthYearAsc") {
        return (a.birth?.year || 9999) - (b.birth?.year || 9999);
      }
      if (sortBy === "birthYearDesc") {
        return (b.birth?.year || -9999) - (a.birth?.year || -9999);
      }
      return 0;
    });

    document.getElementById("table-count-label").textContent = `${list.length} persone trovate`;

    const tbody = document.getElementById("people-table-body");
    tbody.innerHTML = list
      .map((p) => {
        const avatar = p.primaryPhoto
          ? `<img src="${escapeHtml(p.primaryPhoto)}" class="res-avatar" loading="lazy" />`
          : `<div class="res-avatar">${escapeHtml(window.TreeEngine.getInitials(p))}</div>`;

        const parents = window.KinshipEngine.getParents(treeData, p.id)
          .map((par) => treeData.individuals[par.id]?.fullName)
          .filter(Boolean)
          .join(", ");

        const spouses = window.KinshipEngine.getSpouses(treeData, p.id)
          .map((sp) => treeData.individuals[sp.id]?.fullName)
          .filter(Boolean)
          .join(", ");

        return `
        <tr>
          <td>
            <div class="table-person-cell" data-select="${p.id}">
              ${avatar}
              <div>
                <div class="res-name">${escapeHtml(p.fullName)}</div>
                ${p.occupation ? `<div class="res-meta">${escapeHtml(p.occupation)}</div>` : ""}
              </div>
            </div>
          </td>
          <td>${p.sex === "M" ? "♂ M" : p.sex === "F" ? "♀ F" : "—"}</td>
          <td>
            <div>${escapeHtml(p.birth?.dateDisplay || p.birth?.date || "—")}</div>
            <div class="res-meta">${escapeHtml(p.birth?.place || "")}</div>
          </td>
          <td>
            <div>${
              p.isDeceased ? escapeHtml(p.death?.dateDisplay || p.death?.date || "Deceduto/a") : "Vivente"
            }</div>
            <div class="res-meta">${escapeHtml(p.death?.place || "")}</div>
          </td>
          <td><div class="res-meta">${escapeHtml(parents || "—")}</div></td>
          <td><div class="res-meta">${escapeHtml(spouses || "—")}</div></td>
          <td>
            <button class="mini-pill-btn primary" data-focus-tree="${p.id}">🎯 Vedi nell'albero</button>
          </td>
        </tr>
      `;
      })
      .join("");

    tbody.querySelectorAll("[data-select]").forEach((el) => {
      el.addEventListener("click", () => selectPerson(el.dataset.select, false));
    });

    tbody.querySelectorAll("[data-focus-tree]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setViewMode("focus", false);
        focusOnPerson(btn.dataset.focusTree);
      });
    });
  }

  document.addEventListener("DOMContentLoaded", initApp);
})();
