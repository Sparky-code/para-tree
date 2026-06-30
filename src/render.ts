import { ProjectNode, neighborhood } from "./data";
import { layout, LayoutResult, DOT_R, FOCUS_DOT_R, ROW_H, relTime, isOverdue } from "./layout";

const NS = "http://www.w3.org/2000/svg";
const DIM = 0.13; // opacity for elements outside the focused neighborhood

export interface RenderHandlers {
  onOpen: (path: string) => void;        // open the note
  onFocus: (title: string) => void;      // zoom into a node's neighborhood
  onFocusArea: (area: string) => void;   // select a whole area (trunk)
  onToggle: (title: string) => void;     // expand/collapse a primary's sub-projects
}

export interface RenderOptions {
  focus?: string | null;
  focusArea?: string | null;
  expanded?: Set<string>;
  laneMode?: "packed" | "spread";
  hiddenKinds?: Set<string>;            // node kinds to hide (type filter)
  areaColors?: Map<string, string>;     // canonical area→color (keeps colors stable)
  activeArea?: string | null;           // RFC B: popped-out area
}

function svg(tag: string, attrs: Record<string, string | number> = {}, parent?: Element): any {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}

/** Right-angle elbow with a filleted corner: down the parent lane, round the
 *  corner, across to the child (fork/merge). */
function elbowVH(x1: number, y1: number, x2: number, y2: number, r = 7): string {
  if (x1 === x2) return `M${x1},${y1} L${x2},${y2}`;
  const dir = x2 > x1 ? 1 : -1;
  const cr = Math.min(r, Math.abs(y2 - y1), Math.abs(x2 - x1));
  return `M${x1},${y1} L${x1},${y2 - cr} Q${x1},${y2} ${x1 + dir * cr},${y2} L${x2},${y2}`;
}

/** Right-angle detour out to a right gutter `bx` with filleted corners, for
 *  cross-links (contributes-to): across → down/up the gutter → back to target. */
function elbowHVH(x1: number, y1: number, x2: number, y2: number, bx: number, r = 7): string {
  const vy = y2 >= y1 ? 1 : -1;
  const cr = Math.min(r, Math.abs(y2 - y1) / 2 || r);
  return `M${x1},${y1} H${bx - cr} Q${bx},${y1} ${bx},${y1 + vy * cr}`
    + ` V${y2 - vy * cr} Q${bx},${y2} ${bx - cr},${y2} H${x2}`;
}

function truncate(s: string, n = 46): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function tooltip(p: ProjectNode): string {
  return [
    p.title,
    `Area: ${p.area ?? "—"}`,
    `Status: ${p.status}`,
    p.created ? `Started: ${p.created}` : null,
    p.branchedFrom ? `Branched from: ${p.branchedFrom}` : null,
    p.contributesTo.length ? `Contributes to: ${p.contributesTo.join(", ")}` : null,
    p.path,
  ].filter(Boolean).join("\n");
}

/**
 * Custom SVG renderer.
 * - Focus mode (M2): render the full graph and DIM everything outside the
 *   focused node's neighborhood (layout stays put), rather than re-filtering.
 * - contributes-to edges are dashed + directional (arrowhead).
 */
export function renderLineage(
  container: HTMLElement,
  projects: ProjectNode[],
  resources: ProjectNode[],
  areaNodes: ProjectNode[],
  handlers: RenderHandlers,
  opts: RenderOptions = {},
): void {
  container.empty();
  const focus = opts.focus ?? null;
  const focusArea = opts.focusArea ?? null;

  // The whole graph always renders; a focus/area selection DIMS around the
  // selection (layout stays put) rather than filtering rows out.
  const visible = projects;

  if (visible.length === 0) {
    container.createDiv({ cls: "plm-empty", text: "Nothing to show for this selection." });
    return;
  }

  let keepP: Set<string> | null = null;
  let keepA: Set<string> | null = null;
  if (focus) {
    const nb = neighborhood(projects.concat(resources), focus);
    keepP = nb.keepProjects;
    keepA = nb.keepAreas;
  } else if (focusArea) {
    keepP = new Set(projects.concat(resources).filter((p) => (p.area ?? "Unfiled") === focusArea).map((p) => p.title));
    keepA = new Set([focusArea]);
  }
  const nodeDim = (key: string) => (keepP ? !keepP.has(key) : false);
  const areaDim = (area: string) => (keepA ? !keepA.has(area) : false);
  const edgeDim = (ownerKey: string, otherKey?: string) =>
    keepP ? !(keepP.has(ownerKey) || (otherKey != null && keepP.has(otherKey))) : false;

  const L: LayoutResult = layout(visible, resources, areaNodes, {
    expanded: opts.expanded, laneMode: opts.laneMode,
    hiddenKinds: opts.hiddenKinds, areaColors: opts.areaColors,
    activeArea: opts.activeArea,
  });
  // Fit the graph to the pane (no horizontal scroll) so the timestamp stays pinned to
  // the visible right edge; titles budget/ellipsize into the space that's left. (RFC A S5)
  const fillW = (container.clientWidth || 720) - 2;
  const AGE_W = 64; // reserved right gutter for the relative-time stamp (RFC A text fix)
  const root = svg("svg", { class: "plm-svg", width: fillW, height: L.height }, container);

  // Arrowhead marker for contributes-to edges.
  const defs = svg("defs", {}, root);
  const marker = svg("marker", {
    id: "plm-arrow", viewBox: "0 0 8 8", refX: 7, refY: 4,
    markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse",
  }, defs);
  svg("path", { d: "M0,0 L8,4 L0,8 z", fill: "#c678dd" }, marker);

  // Row layers: highlight bands sit BEHIND the spines; transparent hit rects
  // (above edges, below the spines/nodes) capture full-row hover + click-to-focus.
  const bandsG = svg("g", {}, root);
  const hitG = svg("g", {}, root);

  // Column rule.
  svg("line", { class: "plm-col-rule", x1: L.columnX - 10, y1: 8, x2: L.columnX - 10, y2: L.height - 8 }, root);

  // 1) Area spines + labels.
  for (const s of L.spines) {
    const dim = areaDim(s.area);
    const line = svg("line", {
      x1: s.x, y1: s.yTop, x2: s.x, y2: s.yBottom,
      stroke: s.color, "stroke-width": 4, "stroke-linecap": "round",
      opacity: dim ? DIM : 0.85, cursor: "pointer",
    }, root);
    line.addEventListener("click", () => handlers.onFocusArea(s.area));
    // Packed mode hides top labels — the area rows in the column already name them.
    if (opts.laneMode !== "packed") {
      const t = svg("text", {
        class: "plm-spine-label", x: s.x, y: s.labelY,
        fill: s.color, "text-anchor": "middle", opacity: dim ? DIM : 1, cursor: "pointer",
      }, root);
      t.textContent = s.area;
      t.addEventListener("click", () => handlers.onFocusArea(s.area));
    }
  }

  // 2) Edges.
  for (const e of L.edges) {
    const dim = edgeDim(e.ownerKey, e.otherKey);
    const attrs: Record<string, string | number> = {
      d: e.kind === "contributes"
        ? elbowHVH(e.x1, e.y1, e.x2, e.y2, L.columnX - 24) // right-angle detour to the gutter
        : elbowVH(e.x1, e.y1, e.x2, e.y2),                 // right-angle fork/merge
      fill: "none",
      stroke: e.color,
      "stroke-width": e.kind === "contributes" ? 1.5 : 3,
      "stroke-dasharray": e.dashed ? "4 3" : "0",
      opacity: dim ? DIM : e.dashed ? 0.7 : 0.9,
    };
    if (e.kind === "contributes") attrs["marker-end"] = "url(#plm-arrow)";
    svg("path", attrs, root);
  }

  // 3) Nodes + leader lines + right-hand column.
  for (const n of L.nodes) {
    const isFocus = focus === n.key;
    const isArea = n.kind === "area";
    const isRes = n.kind === "resource";
    // Area rows follow their trunk's state, so a selected area never dims itself.
    const dim = isArea ? areaDim(n.area) : nodeDim(n.key);
    const op = dim ? DIM : 1;

    // Full-row highlight band (drawn behind the spines) + hit target. Toggle the
    // fill via inline style — a CSS `fill` rule would override setAttribute.
    const band = svg("rect", { class: "plm-row-hl", x: 0, y: n.y - ROW_H / 2, width: fillW, height: ROW_H }, bandsG);
    const enter = () => { band.style.fill = "var(--background-modifier-hover)"; };
    const leave = () => { band.style.fill = ""; };
    const hit = svg("rect", { class: "plm-row-hit", x: 0, y: n.y - ROW_H / 2, width: fillW, height: ROW_H }, hitG);
    hit.addEventListener("mouseenter", enter);
    hit.addEventListener("mouseleave", leave);
    hit.addEventListener("click", () => isArea ? handlers.onFocusArea(n.area) : handlers.onFocus(n.key));

    svg("line", {
      class: "plm-leader", x1: n.x + DOT_R, y1: n.y, x2: L.columnX - 12, y2: n.y,
      opacity: dim ? DIM : 0.5,
    }, root);

    const g = svg("g", { class: "plm-node", opacity: op }, root);
    g.addEventListener("mouseenter", enter);
    g.addEventListener("mouseleave", leave);
    const title = svg("title", {}, g);
    title.textContent = tooltip(n.project);

    const dot = svg("circle", {
      cx: n.x, cy: n.y, r: isFocus ? FOCUS_DOT_R : isArea ? 7 : isRes ? 4 : DOT_R,
      fill: isRes ? "var(--background-primary)" : n.color,
      stroke: n.color, "stroke-width": isFocus ? 3 : isArea ? 3 : 2,
      cursor: "pointer",
    }, g);
    dot.addEventListener("click", () => isArea ? handlers.onFocusArea(n.area) : handlers.onFocus(n.key));

    // Right-hand column: indent by depth; a chevron+count button for parents.
    const indent = Math.max(0, n.depth - 1) * 14;
    const toggleX = L.columnX + indent;
    if (n.hasChildren) {
      const txt = n.expanded ? "▾" : `▸ ${n.childCount}`;
      const tw = txt.length * 6.2 + 9;
      const bg = svg("rect", { class: "plm-toggle-bg", x: toggleX, y: n.y - 9, width: tw, height: 18, rx: 5 }, g);
      const tg = svg("text", { class: "plm-toggle", x: toggleX + 5, y: n.y + 4 }, g);
      tg.textContent = txt;
      // Expanding also selects the node (so it never stays dimmed) — but only if it
      // isn't already selected, so the chevron doesn't toggle a selected node off.
      const toggle = (ev: Event) => {
        ev.stopPropagation();
        handlers.onToggle(n.key);
        if (isArea) { if (focusArea !== n.area) handlers.onFocusArea(n.area); }
        else if (focus !== n.key) handlers.onFocus(n.key);
      };
      bg.addEventListener("click", toggle);
      tg.addEventListener("click", toggle);
    }

    const labelX = L.columnX + indent + 32; // fixed toggle slot keeps titles aligned
    // Budget the title so title + pills never reach the reserved timestamp gutter.
    const typeText = isArea ? "area" : isRes ? "resource" : "project";
    const pillsW = (typeText.length * 6 + 18) + (isArea ? 0 : n.project.status.length * 6 + 18) + 10;
    // Keep a fixed margin for the timestamp; if the row is too tight to honor it, drop
    // the timestamp (the created date is in the inspector) and give the title that space.
    const showAge = fillW - AGE_W - labelX - pillsW >= 40;
    const maxChars = Math.max(4, Math.floor(((showAge ? fillW - AGE_W : fillW - 8) - labelX - pillsW) / 6.6));
    const label = svg("text", { class: "plm-row-label", x: labelX, y: n.y + 4 }, g);
    label.textContent = `${isFocus ? "▶ " : ""}${truncate(n.project.title, maxChars)}`;
    if (isArea) label.style.fontWeight = "700";
    if (n.project.path) label.addEventListener("click", () => handlers.onOpen(n.project.path));

    // Pills after the title: type (resources only) + status. Measure each to size it.
    const measured = label.getComputedTextLength();
    let cursor = labelX + (measured > 0 ? measured : (label.textContent?.length ?? 0) * 7) + 10;
    const addPill = (text: string, fill: string) => {
      const bg = svg("rect", { class: "plm-pill-bg", x: cursor, y: n.y - 7, height: 14, rx: 4 }, g);
      const t = svg("text", { class: "plm-pill-text", x: cursor + 6, y: n.y + 3 }, g);
      t.style.fill = fill; // inline beats the `.plm-graph svg text` rule
      t.textContent = text;
      const w = t.getComputedTextLength();
      const pw = (w > 0 ? w : text.length * 5.5) + 12;
      bg.setAttribute("width", String(pw));
      cursor += pw + 6;
    };
    if (isArea) {
      addPill("area", n.color);
    } else {
      addPill(isRes ? "resource" : "project", "var(--text-muted)");
      addPill(n.project.status, n.color);
    }

    // Right-aligned last-edited time — only when its margin can be honored (else dropped).
    const rel = showAge ? relTime(n.project.lastEdited) : "";
    if (rel) {
      const ageT = svg("text", { class: "plm-ago", x: fillW - 12, y: n.y + 4, "text-anchor": "end", opacity: dim ? DIM : 1 }, g);
      ageT.textContent = rel;
      // Attention indicator: a small amber dot just left of the timestamp when past cadence.
      if (!isArea && isOverdue(n.project.lastEdited, n.project.cadence)) {
        const tw = ageT.getComputedTextLength() || rel.length * 6;
        const cd = svg("circle", {
          cx: fillW - 12 - tw - 7, cy: n.y, r: 3, fill: "#e8853b", opacity: dim ? DIM : 1,
        }, g);
        const tt = svg("title", {}, cd);
        tt.textContent = `Needs attention — past ${n.project.cadence} cadence`;
      }
    }
  }

  // Jump-to-node: scroll the focused node into view if it's off-screen.
  if (focus) {
    const fn = L.nodes.find((n) => n.key === focus);
    const h = container.clientHeight;
    if (fn && h && (fn.y < container.scrollTop + 24 || fn.y > container.scrollTop + h - 24)) {
      container.scrollTop = Math.max(0, fn.y - h / 2);
    }
  }
}
