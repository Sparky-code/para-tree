import { ProjectNode } from "./data";

// ---- Tunables ----
export const ROW_H = 42;
const HEADER_TOP = 14;    // top padding before the wrapped labels
const LABEL_LH = 14;      // line height for wrapped area labels
const LABEL_CHAR_W = 6.6; // approx width per char of the 12px bold label
const LEFT_PAD = 84;      // room for the leftmost spine's centered label
const PROJ_LANE_W = 24;   // horizontal step per lineage-depth level
const AREA_PAD = 34;      // gap between area blocks
const LEADER_GAP = 48;    // gap between the graph and the right-hand column
const COL_W = 360;        // right-hand message column width
const FORK_DY = ROW_H * 0.6;
const LABEL_GAP = 8;          // min horizontal gap between adjacent spine header labels
export const DOT_R = 6;
export const FOCUS_DOT_R = 9;

const AREA_COLORS = [
  "#4f9cff", "#e5c07b", "#c678dd", "#98c379",
  "#e06c75", "#56b6c2", "#d19a66", "#61afef",
];

export const DONE = new Set([
  "done", "complete", "completed", "archived", "shipped", "ready-to-publish",
]);

export function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (DONE.has(s)) return "#98c379";
  if (s === "idea") return "#8a8f98";
  if (s === "in-progress") return "#e5c07b";
  return "#4f9cff";
}

/** Canonical area order: projects first-seen, then any empty area notes appended. */
export function orderedAreas(projects: ProjectNode[], areaNodes: ProjectNode[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (a: string) => { if (!seen.has(a)) { seen.add(a); out.push(a); } };
  for (const p of projects) push(p.area ?? "Unfiled");
  for (const a of areaNodes) push(a.title);
  return out;
}

/** Stable area→color map keyed on the ordered area-name list. */
export function buildAreaColors(areaNames: string[]): Map<string, string> {
  const map = new Map<string, string>();
  areaNames.forEach((a, i) => { if (!map.has(a)) map.set(a, AREA_COLORS[i % AREA_COLORS.length]); });
  return map;
}

/**
 * Parse a cadence string to days. Lenient — accepts:
 *   named:  daily, weekly, biweekly/fortnightly, monthly, quarterly, yearly/annually
 *   "<n><unit>" with optional space: 3d, 3 days, 2w, 2 weeks, 1mo, 1 month, 72h, 1y, 90 (bare = days)
 *   unit by first letter: d=day, w=week, m/mo=month(30d), y=year(365d), h=hour. null if unparseable.
 */
export function cadenceDays(c: string | null): number | null {
  if (!c) return null;
  const s = c.trim().toLowerCase();
  const named: Record<string, number> = {
    daily: 1, weekly: 7, biweekly: 14, fortnightly: 14, monthly: 30, quarterly: 90, yearly: 365, annually: 365,
  };
  if (s in named) return named[s];
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2];
  const per =
    u === "" || u[0] === "d" ? 1 :          // d / day / days / bare number
    u[0] === "w" ? 7 :                       // w / wk / week / weeks
    u === "m" || u.startsWith("mo") ? 30 :   // m / mo / month / months
    u[0] === "y" ? 365 :                     // y / yr / year / years
    u[0] === "h" ? 1 / 24 :                  // h / hr / hrs / hour / hours
    null;
  return per == null ? null : n * per;
}

/** True when a node declares a cadence and hasn't been edited within it. */
export function isOverdue(lastEdited: string | null, cadence: string | null): boolean {
  const days = cadenceDays(cadence);
  if (days == null || !lastEdited) return false;
  const t = Date.parse(lastEdited);
  return !Number.isNaN(t) && Date.now() - t > days * 86400000;
}

/** Short relative time like "3d ago" / "2w ago" / "5mo ago"; "" if undated. */
export function relTime(d?: string | null): string {
  if (!d) return "";
  const t = Date.parse(d);
  if (Number.isNaN(t)) return "";
  const days = Math.round((Date.now() - t) / 86400000);
  if (days <= 0) return "today";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

export type TimeMode = "ordinal" | "month" | "year";

export interface LayoutNode {
  key: string;
  project: ProjectNode;
  area: string;
  x: number;
  y: number;
  color: string;
  depth: number;        // 0 = area trunk, 1 = primary, 2+ = sub-branch / resource
  kind: "project" | "resource" | "area";
  hasChildren: boolean; // has sub-projects or resources
  childCount: number;   // direct children hidden when collapsed
  expanded: boolean;
}

export interface LayoutSpine {
  area: string;
  x: number;
  yTop: number;
  yBottom: number;
  labelY: number;        // baseline of the first label line
  labelLines: string[];  // word-wrapped area label (currently single-element; multi-line reserved for long names)
  color: string;
}

export interface LayoutEdge {
  kind: "fork" | "merge" | "contributes";
  x1: number; y1: number; x2: number; y2: number;
  color: string;
  dashed: boolean;
  ownerKey: string;
  otherKey?: string;
}

export interface LayoutResult {
  nodes: LayoutNode[];
  spines: LayoutSpine[];
  edges: LayoutEdge[];
  width: number;
  height: number;
  columnX: number;
}

/**
 * Pure layout.
 * - x (lane) = lineage DEPTH within an area (spine = 0, primary = 1, sub = 2…).
 * - y = a single GLOBAL row sequence (unique per visible node, so the right-hand
 *   column never overlaps), grouped by area, DFS within each area so subtopics
 *   sit under their parent.
 * - Collapse: sub-projects (depth ≥ 2) are hidden unless their parent is in
 *   `expanded`; primaries always show. Spines are drawn full-height (parallel).
 */
export function layout(
  visible: ProjectNode[],
  resources: ProjectNode[],
  areaNodes: ProjectNode[],
  opts: {
    expanded?: Set<string>; mode?: TimeMode; laneMode?: "packed" | "spread";
    hiddenKinds?: Set<string>; areaColors?: Map<string, string>;
    activeArea?: string | null;
  } = {},
): LayoutResult {
  const expanded = opts.expanded ?? new Set<string>();
  const hidden = opts.hiddenKinds ?? new Set<string>();
  const packed = (opts.laneMode ?? "packed") !== "spread"; // packed = tight gutter
  const LANE_W = packed ? 8 : PROJ_LANE_W;   // column step within an area
  const LEFT = packed ? 30 : LEFT_PAD;
  const activeArea = opts.activeArea ?? null; // the active / "breathing" area (or null)

  // Resources hung under their parent project; area-level ones under the area.
  const resByProject = new Map<string, ProjectNode[]>();
  const resByArea = new Map<string, ProjectNode[]>();
  for (const r of resources) {
    const map = r.parentProject ? resByProject : resByArea;
    const key = r.parentProject ?? r.area ?? "Unfiled";
    let list = map.get(key);
    if (!list) { list = []; map.set(key, list); }
    list.push(r);
  }
  const sortCreated = (arr: ProjectNode[]) => arr.sort(
    (a, b) => (a.created ?? "").localeCompare(b.created ?? "") || a.title.localeCompare(b.title),
  );
  resByProject.forEach(sortCreated);
  resByArea.forEach(sortCreated);
  const areaNodeByName = new Map(areaNodes.map((a) => [a.title, a]));
  const synthArea = (name: string): ProjectNode => ({
    title: name, path: "", area: name, status: "area", created: null,
    branchedFrom: null, contributesTo: [], promotedTo: null, goal: null, nextAction: null,
    kind: "area", parentProject: null, lastEdited: null, cadence: null,
  });

  const byCreated = (a: ProjectNode, b: ProjectNode) =>
    (a.created ?? "").localeCompare(b.created ?? "") || a.title.localeCompare(b.title);

  // Group by area; include empty areas (from area notes) so dead trunks show.
  const areas = orderedAreas(visible, areaNodes);
  const byArea = new Map<string, ProjectNode[]>(areas.map((a): [string, ProjectNode[]] => [a, []]));
  for (const p of visible) byArea.get(p.area ?? "Unfiled")!.push(p);

  const projByTitle = new Map(visible.map((p) => [p.title, p]));
  const areaOf = (p: ProjectNode) => p.area ?? "Unfiled";

  const depthCache = new Map<string, number>();
  const depthOf = (p: ProjectNode): number => {
    const cached = depthCache.get(p.title);
    if (cached != null) return cached;
    let d = 1;
    if (p.branchedFrom) {
      const par = projByTitle.get(p.branchedFrom);
      if (par && areaOf(par) === areaOf(p)) d = depthOf(par) + 1;
    }
    depthCache.set(p.title, d);
    return d;
  };

  // Per-area child map + roots (primaries).
  const childrenOf = (area: string) => {
    const kids = new Map<string, ProjectNode[]>();
    const roots: ProjectNode[] = [];
    for (const p of byArea.get(area)!) {
      const par = p.branchedFrom ? projByTitle.get(p.branchedFrom) : undefined;
      if (par && areaOf(par) === area) {
        let list = kids.get(par.title);
        if (!list) { list = []; kids.set(par.title, list); }
        list.push(p);
      } else {
        roots.push(p);
      }
    }
    roots.sort(byCreated);
    kids.forEach((arr) => arr.sort(byCreated));
    return { kids, roots };
  };

  // Walk areas → DFS (respecting collapse) → global row order.
  // `lane` = graph column. compact: lane = lineage depth (primaries share a lane).
  // stacked: each primary subtree fans into its own column block.
  interface Pending { node: ProjectNode; area: string; kind: "project" | "resource" | "area"; depth: number; lane: number; hasChildren: boolean; childCount: number; }
  const ordered: Pending[] = [];
  const areaColor = opts.areaColors ?? buildAreaColors(areas);
  const spineX = new Map<string, number>();

  let x = LEFT;
  areas.forEach((area) => {
    spineX.set(area, x);
    const isActive = area === activeArea;
    const { kids, roots } = childrenOf(area);
    const areaRes = resByArea.get(area) ?? [];

    // Area header row on its trunk; area-level resources collapse under it.
    if (!hidden.has("area")) {
      ordered.push({
        node: areaNodeByName.get(area) ?? synthArea(area),
        area, kind: "area", depth: 0, lane: 0,
        hasChildren: areaRes.length > 0, childCount: areaRes.length,
      });
    }

    let maxD = 1;
    {
      const visit = (p: ProjectNode) => {
        const subs = kids.get(p.title) ?? [];
        const res = resByProject.get(p.title) ?? [];
        const d = depthOf(p);
        if (!hidden.has("project")) {
          ordered.push({ node: p, area, kind: "project", depth: d, lane: d, hasChildren: subs.length + res.length > 0, childCount: subs.length + res.length });
        }
        maxD = Math.max(maxD, d);
        if (expanded.has(p.title)) {
          subs.forEach(visit);
          if (!hidden.has("resource")) {
            for (const r of res) {
              ordered.push({ node: r, area, kind: "resource", depth: d + 1, lane: d + 1, hasChildren: false, childCount: 0 });
              maxD = Math.max(maxD, d + 1);
            }
          }
        }
      };
      roots.forEach(visit);
      if (expanded.has(area) && !hidden.has("resource")) {
        for (const r of areaRes) {
          ordered.push({ node: r, area, kind: "resource", depth: 1, lane: 1, hasChildren: false, childCount: 0 });
          maxD = Math.max(maxD, 1);
        }
      }
    }

    // Spacing per area:
    // -- RFC B (pop-out) PRESERVED for re-enable: inactive areas hide projects + go thin.
    //      const popout = activeArea != null;
    //      const showProjects = !popout || isActive;  // gate the visit block above
    //      if (popout && !isActive) x += 16; else if (isActive) x += spread; else x += dynamic;
    // -- COMBINATION (current): every area keeps its projects (A's overview); the ACTIVE
    //    area "breathes" to a full spread (wide lanes), the rest stay A's dynamic-tight.
    if (isActive) {
      x += (maxD + 1) * PROJ_LANE_W + AREA_PAD;
    } else {
      x += packed ? Math.max(26, (maxD + 1) * LANE_W + 8) : (maxD + 1) * PROJ_LANE_W + AREA_PAD;
    }
  });

  const total = Math.max(1, ordered.length);
  const graphRight = x;
  const columnX = graphRight + LEADER_GAP;
  const width = columnX + COL_W;

  // Assign each area label a tier so adjacent labels don't overlap; the header
  // grows downward as needed and the graph starts below it.
  const labelTier = new Map<string, number>();
  const tierRight: number[] = [];
  for (const area of areas) {
    const cx = spineX.get(area)!;
    const half = (area.length * LABEL_CHAR_W + 10) / 2;
    let t = 0;
    while (t < tierRight.length && cx - half < tierRight[t] + LABEL_GAP) t++;
    labelTier.set(area, t);
    tierRight[t] = cx + half;
  }
  const headerH = packed ? 0 : Math.max(1, tierRight.length) * LABEL_LH;
  const topY = HEADER_TOP + headerH + 12;
  const height = topY + total * ROW_H;

  const yTop = topY - ROW_H * 0.45;
  const yBottom = topY + (total - 1) * ROW_H + ROW_H * 0.45;

  // Spines span full height (parallel trunks); labels sit on their tier.
  const spines: LayoutSpine[] = areas.map((area) => ({
    area,
    x: spineX.get(area)!,
    yTop,
    yBottom,
    labelY: HEADER_TOP + labelTier.get(area)! * LABEL_LH + 11,
    labelLines: [area],
    color: areaColor.get(area)!,
  }));

  const nodes: LayoutNode[] = ordered.map((it, idx) => ({
    key: it.node.title,
    project: it.node,
    area: it.area,
    x: spineX.get(it.area)! + it.lane * (it.area === activeArea ? PROJ_LANE_W : LANE_W),
    y: topY + idx * ROW_H,
    color: it.kind === "area" ? (areaColor.get(it.area) ?? "#888") : statusColor(it.node.status),
    depth: it.depth,
    kind: it.kind,
    hasChildren: it.hasChildren,
    childCount: it.childCount,
    expanded: expanded.has(it.node.title),
  }));
  const nodeByTitle = new Map(nodes.map((n) => [n.key, n]));

  const edges: LayoutEdge[] = [];
  for (const n of nodes) {
    const p = n.project;
    const areaCol = areaColor.get(n.area)!;
    if (p.kind !== "area") {
      const parentTitle = p.kind === "resource" ? p.parentProject : p.branchedFrom;
      const candidate = parentTitle ? nodeByTitle.get(parentTitle) : undefined;
      const parent = candidate && candidate.area === n.area ? candidate : null;
      const fromX = parent ? parent.x : spineX.get(n.area)!;
      const fromY = parent ? parent.y : n.y - FORK_DY;
      edges.push({ kind: "fork", x1: fromX, y1: fromY, x2: n.x, y2: n.y, color: areaCol, dashed: false, ownerKey: n.key });
    }

    if (p.kind === "project" && DONE.has(p.status.toLowerCase())) {
      edges.push({ kind: "merge", x1: n.x, y1: n.y, x2: spineX.get(n.area)!, y2: n.y + FORK_DY, color: "#98c379", dashed: false, ownerKey: n.key });
    }
  }

  for (const n of nodes) {
    for (const target of n.project.contributesTo) {
      if (target === n.project.area) continue;
      const tn = nodeByTitle.get(target);
      if (tn) {
        edges.push({ kind: "contributes", x1: n.x, y1: n.y, x2: tn.x, y2: tn.y, color: "#c678dd", dashed: true, ownerKey: n.key, otherKey: target });
      } else if (spineX.has(target)) {
        edges.push({ kind: "contributes", x1: n.x, y1: n.y, x2: spineX.get(target)!, y2: n.y, color: "#c678dd", dashed: true, ownerKey: n.key, otherKey: target });
      }
    }
  }

  return { nodes, spines, edges, width, height, columnX };
}
