import { ItemView, Platform, WorkspaceLeaf } from "obsidian";
import type ParaTreePlugin from "./main";
import { collectProjects, collectResources, collectAreas, ProjectNode } from "./data";
import { renderLineage } from "./render";
import { buildAreaColors, orderedAreas, statusColor, relTime, isOverdue } from "./layout";

export const VIEW_TYPE_LINEAGE = "para-tree";

/** A small defined glyph: three vertical bars, tight (packed) or spaced (spread). */
function laneGlyph(parent: HTMLElement, spread: boolean): void {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  for (const x of spread ? [2.5, 7, 11.5] : [4.5, 7, 9.5]) {
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", String(x));
    line.setAttribute("y1", "2.5");
    line.setAttribute("x2", String(x));
    line.setAttribute("y2", "11.5");
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "1.7");
    line.setAttribute("stroke-linecap", "round");
    svg.appendChild(line);
  }
  parent.appendChild(svg);
}

export class LineageView extends ItemView {
  plugin: ParaTreePlugin;
  focus: string | null = null;      // a project title, or null
  focusArea: string | null = null;  // a selected area (trunk), or null
  expanded: Set<string> = new Set(); // primaries whose sub-projects are shown
  sidebarW = 210;   // desktop pane widths, draggable; persist across redraws
  inspectorW = 320;
  laneMode: "packed" | "spread" = "packed"; // graph lane spacing
  hiddenKinds: Set<"area" | "project" | "resource"> = new Set(); // type filter
  search = ""; // jump-to-node query (filters the sidebar into a matches list)

  constructor(leaf: WorkspaceLeaf, plugin: ParaTreePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_LINEAGE; }
  getDisplayText(): string { return "PARA-Tree"; }
  getIcon(): string { return "workflow"; }

  async onOpen() { this.draw(); }
  async onClose() { this.contentEl.empty(); }

  draw() {
    const root = this.contentEl;
    root.empty();
    root.addClass("plm-container");
    root.toggleClass("plm-mobile", Platform.isMobile);

    const projects = collectProjects(this.app);
    const resources = collectResources(this.app);
    const areaNodes = collectAreas(this.app);
    const areas = orderedAreas(projects, areaNodes);
    const areaColors = buildAreaColors(areas);

    // ---- Toolbar ----
    const bar = root.createDiv({ cls: "plm-toolbar" });

    // Title — fully left, above the sidebar. The left segment is sized to the sidebar
    // so the main segment begins exactly at the graph column's left edge.
    const tbLeft = bar.createDiv({ cls: "plm-tb-left" });
    if (!Platform.isMobile) tbLeft.style.width = `${this.sidebarW + 11}px`; // sidebar + resizer
    const titleEl = tbLeft.createSpan({ cls: "plm-title", text: this.app.vault.getName().slice(0, 20) });
    titleEl.setAttr("title", "Pick an area to highlight · click a node to focus · click a label to open");

    // Main segment: selection tag (left, at the graph column) + lane toggle (far right).
    // Type-filter chips removed for now — collapse + sidebar + search cover navigation;
    // the `hiddenKinds` plumbing in layout/render is retained for easy reintroduction.
    const tbMain = bar.createDiv({ cls: "plm-tb-main" });

    // Selection tag. The area dropdown is deprecated — see renderAreaDropdown().
    if (this.focus || this.focusArea) {
      const tag = tbMain.createDiv({ cls: "plm-focus" });
      tag.appendText(this.focus ? "Focus: " : "Area: ");
      tag.createEl("b", { text: this.focus ?? this.focusArea! });
      const x = tag.createSpan({ cls: "plm-focus-x", text: "✕" });
      x.setAttr("aria-label", "Clear selection");
      x.onclick = () => { this.focus = null; this.focusArea = null; this.draw(); };
    }

    this.renderLaneToggle(tbMain); // pushed fully right via CSS margin-left:auto

    if (projects.length === 0) {
      root.createDiv({
        cls: "plm-empty",
        text: "No project notes found. Add `type: project` to a note's frontmatter (and an `area:` link to place it on a trunk).",
      });
      return;
    }

    // Create all three panes first so the graph measures its final width.
    const main = root.createDiv({ cls: "plm-main" });
    const sideEl = main.createDiv({ cls: "plm-sidebar" });
    const resizeL = Platform.isMobile ? null : main.createDiv({ cls: "plm-resizer" });
    const graphEl = main.createDiv({ cls: "plm-graph" });
    const resizeR = Platform.isMobile ? null : main.createDiv({ cls: "plm-resizer" });
    const inspEl = main.createDiv({ cls: "plm-inspector" });
    if (!Platform.isMobile) {
      sideEl.style.width = `${this.sidebarW}px`;
      inspEl.style.width = `${this.inspectorW}px`;
      this.attachResize(resizeL!, "sidebar");
      this.attachResize(resizeR!, "inspector");
    }

    this.renderSidebar(sideEl, projects, resources, areas, areaColors);

    // RFC B: active (popped-out) area = the selected area, or the focused node's area.
    const activeArea = this.focusArea
      ?? (this.focus ? (projects.concat(resources).find((n) => n.title === this.focus)?.area ?? null) : null);

    renderLineage(
      graphEl,
      projects,
      resources,
      areaNodes,
      {
        onOpen: (path) => this.app.workspace.openLinkText(path, "", false),
        onFocus: (title) => this.selectNode(title),
        onFocusArea: (area) => this.selectArea(area),
        onToggle: (title) => {
          if (this.expanded.has(title)) this.expanded.delete(title);
          else this.expanded.add(title);
          this.draw();
        },
      },
      {
        focus: this.focus, focusArea: this.focusArea,
        expanded: this.expanded, laneMode: this.laneMode,
        hiddenKinds: this.hiddenKinds, areaColors, activeArea,
      },
    );
    this.renderInspector(inspEl, projects, resources, areaColors);
  }

  // Toggling selection: clicking the already-selected node/area clears it.
  private selectNode(title: string) {
    this.focus = this.focus === title ? null : title;
    this.focusArea = null;
    this.draw();
  }
  private selectArea(area: string) {
    this.focusArea = this.focusArea === area ? null : area;
    this.focus = null;
    this.draw();
  }

  /** Drag a divider to resize the sidebar or inspector pane (desktop). */
  private attachResize(handle: HTMLElement, which: "sidebar" | "inspector") {
    handle.addEventListener("mousedown", (e: MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = which === "sidebar" ? this.sidebarW : this.inspectorW;
      const min = which === "sidebar" ? 140 : 220;
      const max = which === "sidebar" ? 420 : 520;
      document.body.style.cursor = "col-resize";
      let raf = 0;
      const onMove = (ev: MouseEvent) => {
        const delta = which === "sidebar" ? ev.clientX - startX : startX - ev.clientX;
        const w = Math.max(min, Math.min(max, startW + delta));
        if (which === "sidebar") this.sidebarW = w; else this.inspectorW = w;
        // Live, rAF-throttled redraw so the toolbar + timestamps track the moving edge.
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.draw(); });
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        if (raf) cancelAnimationFrame(raf);
        this.draw();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  /** Left navigator: a sticky search box at the top + the list (sections or matches) below. */
  private renderSidebar(host: HTMLElement, projects: ProjectNode[], resources: ProjectNode[], areas: string[], colors: Map<string, string>) {
    const searchInput = host.createEl("input", { cls: "plm-side-search" });
    searchInput.type = "text";
    searchInput.placeholder = "Search nodes…";
    searchInput.value = this.search;
    searchInput.oninput = () => { this.search = searchInput.value; this.refreshSidebarList(); };
    this.renderLegend(host);
    this.renderSidebarList(host.createDiv({ cls: "plm-side-list" }), projects, resources, areas, colors);
  }

  /** Packed ↔ Spread slider with a defined glyph (tight / spaced bars) on each side. */
  private renderLaneToggle(parent: HTMLElement) {
    const laneWrap = parent.createDiv({ cls: "plm-lane-toggle" });
    const iconL = laneWrap.createSpan({ cls: this.laneMode === "packed" ? "plm-lane-ic on" : "plm-lane-ic" });
    laneGlyph(iconL, false);
    iconL.setAttr("aria-label", "Packed lanes — tight");
    iconL.onclick = () => { this.laneMode = "packed"; this.draw(); };
    const sw = laneWrap.createDiv({ cls: this.laneMode === "spread" ? "plm-switch on" : "plm-switch" });
    sw.setAttr("role", "switch");
    sw.setAttr("aria-label", "Toggle packed / spread lanes");
    sw.createDiv({ cls: "plm-switch-knob" });
    sw.onclick = () => { this.laneMode = this.laneMode === "packed" ? "spread" : "packed"; this.draw(); };
    const iconR = laneWrap.createSpan({ cls: this.laneMode === "spread" ? "plm-lane-ic on" : "plm-lane-ic" });
    laneGlyph(iconR, true);
    iconR.setAttr("aria-label", "Spread lanes — roomy");
    iconR.onclick = () => { this.laneMode = "spread"; this.draw(); };
  }

  /**
   * @deprecated Area selection now lives in the sidebar. Kept (unrendered) for a
   * possible mobile layout where the sidebar collapses into a dropdown.
   */
  private renderAreaDropdown(bar: HTMLElement, projects: ProjectNode[], areas: string[]) {
    const select = bar.createEl("select", { cls: "plm-filter dropdown" });
    select.createEl("option", { text: `All areas (${projects.length})`, value: "" });
    for (const area of areas) {
      const count = projects.filter((p) => p.area === area).length;
      const opt = select.createEl("option", { text: `${area} (${count})`, value: area });
      if (area === this.focusArea) opt.selected = true;
    }
    select.onchange = () => { this.focusArea = select.value || null; this.focus = null; this.draw(); };
  }

  /** Collapsible legend, under the search box. */
  private renderLegend(host: HTMLElement) {
    const d = host.createEl("details", { cls: "plm-legend-drop" });
    d.createEl("summary", { text: "Legend" });
    const b = d.createDiv({ cls: "plm-legend-body" });
    ([["#4f9cff", "active"], ["#e5c07b", "in-progress"], ["#98c379", "done"], ["#8a8f98", "idea"]] as const)
      .forEach(([c, l]) => {
        const r = b.createDiv({ cls: "plm-legend-row" });
        r.createSpan({ cls: "plm-legend-dot" }).style.background = c;
        r.createSpan({ text: l });
      });
    ([["branch", "#4f9cff", false], ["merge", "#98c379", false], ["contributes →", "#c678dd", true]] as const)
      .forEach(([l, c, dash]) => {
        const r = b.createDiv({ cls: "plm-legend-row" });
        r.createSpan({ cls: dash ? "plm-legend-line dash" : "plm-legend-line" }).style.borderTopColor = c;
        r.createSpan({ text: l });
      });
  }

  /** Re-render only the list under the search box (keeps the input focused while typing). */
  private refreshSidebarList() {
    const list = this.contentEl.querySelector(".plm-side-list") as HTMLElement | null;
    if (!list) return;
    const projects = collectProjects(this.app);
    const resources = collectResources(this.app);
    const areas = orderedAreas(projects, collectAreas(this.app));
    list.empty();
    this.renderSidebarList(list, projects, resources, areas, buildAreaColors(areas));
  }

  /** The list body: Areas / Projects / Reviews — or a flat matches list when searching. */
  private renderSidebarList(host: HTMLElement, projects: ProjectNode[], resources: ProjectNode[], areas: string[], colors: Map<string, string>) {
    const section = (label: string, count: number) => {
      const s = host.createDiv({ cls: "plm-side-sec" });
      s.createSpan({ text: label });
      s.createSpan({ cls: "plm-side-count", text: String(count) });
    };
    const item = (on: boolean, color: string, name: string, meta: string, onClick: () => void) => {
      const row = host.createDiv({ cls: on ? "plm-side-item on" : "plm-side-item" });
      row.createSpan({ cls: "plm-side-dot" }).style.background = color;
      row.createSpan({ cls: "plm-side-name", text: name });
      row.createSpan({ cls: "plm-side-meta", text: meta });
      row.onclick = onClick;
    };

    // Search mode: one flat, clickable matches list across all node kinds.
    const q = this.search.trim().toLowerCase();
    if (q) {
      const matches: { kind: "area" | "project" | "resource"; title: string; color: string }[] = [];
      for (const a of areas) if (a.toLowerCase().includes(q)) matches.push({ kind: "area", title: a, color: colors.get(a) || "var(--text-muted)" });
      for (const p of projects) if (p.title.toLowerCase().includes(q)) matches.push({ kind: "project", title: p.title, color: statusColor(p.status) });
      for (const r of resources) if (r.title.toLowerCase().includes(q)) matches.push({ kind: "resource", title: r.title, color: statusColor(r.status) });
      section(`Matches "${this.search}"`, matches.length);
      if (!matches.length) host.createDiv({ cls: "plm-side-empty", text: "no matches" });
      for (const m of matches) {
        const on = m.kind === "area" ? this.focusArea === m.title && !this.focus : this.focus === m.title;
        item(on, m.color, m.title, m.kind, () => (m.kind === "area" ? this.selectArea(m.title) : this.selectNode(m.title)));
      }
      return;
    }

    section("Areas · trunks", areas.length);
    for (const area of areas) {
      const count = projects.filter((p) => p.area === area).length;
      item(
        this.focusArea === area && !this.focus,
        colors.get(area) || "var(--text-muted)",
        area, count ? `${count} br` : "0 br", () => this.selectArea(area),
      );
    }

    section("Projects · branches", projects.length);
    for (const p of projects) {
      item(this.focus === p.title, statusColor(p.status), p.title, relTime(p.created), () => this.selectNode(p.title));
    }

    section("Reviews · tags", 0);
    host.createDiv({ cls: "plm-side-empty", text: "none yet" });
  }

  /** Right-hand (or, on mobile, stacked) detail pane for the focused node. */
  private renderInspector(host: HTMLElement, projects: ProjectNode[], resources: ProjectNode[], colors: Map<string, string>) {
    if (!this.focus) {
      host.createDiv({
        cls: "plm-insp-empty",
        text: this.focusArea
          ? `Area selected: ${this.focusArea}. Click a node to inspect it.`
          : "Click a node to inspect its lineage, goal, and links.",
      });
      return;
    }
    const all = projects.concat(resources);
    const p = all.find((x) => x.title === this.focus);
    if (!p) { host.createDiv({ cls: "plm-insp-empty", text: "Note not found." }); return; }

    const ac = (p.area && colors.get(p.area)) || "var(--text-muted)";
    const areaSet = new Set(projects.map((x) => x.area).filter((a): a is string => !!a));

    host.createDiv({ cls: "plm-insp-band" }).style.background = `linear-gradient(90deg, ${ac}, transparent)`;
    host.createEl("h3", { cls: "plm-insp-title", text: p.title });

    const pills = host.createDiv({ cls: "plm-insp-pills" });
    pills.createSpan({ cls: "plm-insp-pill", text: p.status }).style.color = statusColor(p.status);

    const meta = host.createDiv({ cls: "plm-insp-meta" });
    if (isOverdue(p.lastEdited, p.cadence)) {
      meta.createDiv({ cls: "plm-insp-warn", text: `⚠ Needs attention — past ${p.cadence} cadence` });
    }
    if (p.lastEdited) meta.createDiv({ text: `last edited ${relTime(p.lastEdited)}` });
    if (p.created) meta.createDiv({ text: `created ${p.created}` });
    if (p.cadence) meta.createDiv({ text: `cadence ${p.cadence}` });
    const trunk = meta.createDiv();
    trunk.appendText("trunk: ");
    trunk.createEl("b", { text: p.area ?? "—" }).style.color = ac;
    if (p.area) { trunk.classList.add("plm-clickable"); trunk.onclick = () => this.selectArea(p.area!); }
    meta.createDiv({ cls: "plm-insp-path", text: p.path });

    if (p.goal) {
      const gs = host.createDiv({ cls: "plm-insp-sec" });
      gs.createEl("h4", { text: "Goal" });
      gs.createDiv({ cls: "plm-insp-goal", text: p.goal });
    }
    if (p.nextAction) {
      const ns = host.createDiv({ cls: "plm-insp-sec" });
      ns.createEl("h4", { text: "Next action" });
      ns.createDiv({ cls: "plm-insp-goal", text: p.nextAction });
    }

    // Linked notes — the "diff": lineage in and out.
    type Link = { kind: string; label: string; area: boolean };
    const links: Link[] = [];
    const seen = new Set<string>();
    const add = (kind: string, label: string, area: boolean) => {
      const id = `${kind}|${label}`;
      if (seen.has(id)) return;
      seen.add(id);
      links.push({ kind, label, area });
    };
    if (p.kind === "resource" && p.parentProject) add("project", p.parentProject, false);
    if (p.branchedFrom) add("branched-from", p.branchedFrom, false);
    if (p.area) add("area", p.area, true);
    for (const t of p.contributesTo) {
      if (t === p.area) continue;
      add("contributes-to", t, areaSet.has(t) && !projects.some((x) => x.title === t));
    }
    for (const x of all) if (x.contributesTo.includes(p.title)) add("fed-by", x.title, false);
    for (const x of all) if (x.branchedFrom === p.title) add("branch", x.title, false);
    for (const x of all) if (x.parentProject === p.title) add("resource", x.title, false);

    const ls = host.createDiv({ cls: "plm-insp-sec" });
    ls.createEl("h4", { text: `Linked notes · ${links.length}` });
    if (!links.length) ls.createDiv({ cls: "plm-insp-empty", text: "— connects only by area —" });
    for (const lk of links) {
      const row = ls.createDiv({ cls: "plm-insp-link" });
      row.createSpan({ cls: "plm-insp-kind", text: lk.kind });
      row.createSpan({ text: lk.label });
      row.onclick = () => (lk.area ? this.selectArea(lk.label) : this.selectNode(lk.label));
    }

    const open = host.createEl("button", { cls: "plm-insp-open mod-cta", text: "Open note →" });
    open.onclick = () => this.app.workspace.openLinkText(p.path, "", false);
  }
}
