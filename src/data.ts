import { App } from "obsidian";

export interface ProjectNode {
  title: string;
  path: string;
  area: string | null;
  status: string;
  created: string | null;
  branchedFrom: string | null;
  contributesTo: string[];
  promotedTo: string | null;
  goal: string | null;
  nextAction: string | null;
  kind: "project" | "resource" | "area";
  parentProject: string | null; // resources: the `project:` link they hang off
  lastEdited: string | null;    // file mtime (ISO) — the dynamic "last edited" stamp
  cadence: string | null;       // review rhythm (e.g. "14d", "weekly") → attention indicator
}

/** Strip an Obsidian wikilink `[[Name|alias]]` down to `Name`; pass plain strings through. */
function unlink(value: unknown): string | null {
  if (value == null) return null;
  const raw: unknown = Array.isArray(value) ? (value[0] as unknown) : value;
  if (typeof raw !== "string") return null;
  const m = raw.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
  return (m ? m[1] : raw).trim() || null;
}

function unlinkList(value: unknown): string[] {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map(unlink).filter((x): x is string => !!x);
}

/**
 * Collect every note with `type: project` in its frontmatter, sorted by
 * created date ascending so parent branches are emitted before their children.
 */
/** Folders that may contain `type: project` notes that aren't real projects. */
const SKIP_PREFIXES = ["_templates", "04 Archive", "06 Reviews"];

export function collectProjects(app: App): ProjectNode[] {
  const out: ProjectNode[] = [];

  for (const file of app.vault.getMarkdownFiles()) {
    if (SKIP_PREFIXES.some((p) => file.path.startsWith(p))) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || fm.type !== "project") continue;

    out.push({
      title: file.basename,
      path: file.path,
      area: unlink(fm.area),
      status: String(fm.status ?? "active"),
      created: fm.created != null ? String(fm.created)
             : fm.started != null ? String(fm.started)
             : null,
      branchedFrom: unlink(fm["branched-from"]),
      contributesTo: unlinkList(fm["contributes-to"]),
      promotedTo: unlink(fm["promoted-to"]),
      goal: fm.goal != null ? String(fm.goal) : null,
      nextAction: fm["next-action"] != null ? String(fm["next-action"]) : null,
      lastEdited: new Date(file.stat.mtime).toISOString(),
      cadence: fm.cadence != null ? String(fm.cadence) : null,
      kind: "project",
      parentProject: null,
    });
  }

  out.sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));
  return out;
}

/**
 * Collect "resource" nodes: any note that is `type: resource` OR carries a
 * `project:` link (so RFCs/spikes/notes filed under a project come along too).
 * Excludes `type: project` notes (collected separately) and the skip folders.
 */
export function collectResources(app: App): ProjectNode[] {
  const out: ProjectNode[] = [];

  for (const file of app.vault.getMarkdownFiles()) {
    if (SKIP_PREFIXES.some((p) => file.path.startsWith(p))) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || fm.type === "project") continue;

    const parent = unlink(fm.project);
    if (fm.type !== "resource" && parent == null) continue; // not a resource node

    out.push({
      title: file.basename,
      path: file.path,
      area: unlink(fm.area),
      status: String(fm.status ?? "active"),
      created: fm.created != null ? String(fm.created)
             : fm.started != null ? String(fm.started)
             : null,
      branchedFrom: null,
      contributesTo: unlinkList(fm["contributes-to"]),
      promotedTo: null,
      goal: fm.goal != null ? String(fm.goal) : null,
      nextAction: fm["next-action"] != null ? String(fm["next-action"]) : null,
      lastEdited: new Date(file.stat.mtime).toISOString(),
      cadence: fm.cadence != null ? String(fm.cadence) : null,
      kind: "resource",
      parentProject: parent,
    });
  }

  out.sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));
  return out;
}

/** Collect `type: area` notes — the trunk header nodes (incl. empty areas). */
export function collectAreas(app: App): ProjectNode[] {
  const out: ProjectNode[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (SKIP_PREFIXES.some((p) => file.path.startsWith(p))) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || fm.type !== "area") continue;
    out.push({
      title: file.basename,
      path: file.path,
      area: file.basename,
      status: "area",
      created: fm.created != null ? String(fm.created) : null,
      branchedFrom: null,
      contributesTo: [],
      promotedTo: null,
      goal: fm.goal != null ? String(fm.goal) : null,
      nextAction: fm["next-action"] != null ? String(fm["next-action"]) : null,
      lastEdited: new Date(file.stat.mtime).toISOString(),
      cadence: fm.cadence != null ? String(fm.cadence) : null,
      kind: "area",
      parentProject: null,
    });
  }
  return out;
}

/**
 * The connected neighborhood of one project, for focus mode: the project itself,
 * its ancestry (branched-from chain) and each ancestor's area, its descendants
 * (projects branched from it), what it contributes to, and what contributes to
 * it. This is the "context both in and out" of the selected node.
 */
export function neighborhood(
  projects: ProjectNode[],
  focus: string,
): { keepProjects: Set<string>; keepAreas: Set<string> } {
  const keepProjects = new Set<string>();
  const keepAreas = new Set<string>();
  const byTitle = new Map(projects.map((p) => [p.title, p]));

  const f = byTitle.get(focus);
  if (!f) return { keepProjects, keepAreas };

  const add = (p: ProjectNode) => {
    keepProjects.add(p.title);
    if (p.area) keepAreas.add(p.area);
  };
  add(f);

  // Resource focus: keep its parent project, and a project keeps its resources.
  if (f.parentProject) {
    const par = byTitle.get(f.parentProject);
    if (par) add(par);
  }
  for (const p of projects) {
    if (p.parentProject === focus) add(p);
  }

  // Ancestry (in): walk branched-from up to the root.
  let cur: ProjectNode | undefined = f;
  const seen = new Set<string>();
  while (cur?.branchedFrom && byTitle.has(cur.branchedFrom) && !seen.has(cur.branchedFrom)) {
    seen.add(cur.branchedFrom);
    cur = byTitle.get(cur.branchedFrom);
    if (cur) add(cur);
  }

  // Descendants (out): everything that branched from a kept node.
  const queue = [focus];
  while (queue.length) {
    const t = queue.shift()!;
    for (const p of projects) {
      if (p.branchedFrom === t && !keepProjects.has(p.title)) {
        add(p);
        queue.push(p.title);
      }
    }
  }

  // Contributions out: what the focus feeds.
  for (const target of f.contributesTo) {
    const tp = byTitle.get(target);
    if (tp) add(tp);
    else keepAreas.add(target); // area-level target
  }

  // Contributions in: who feeds the focus.
  for (const p of projects) {
    if (p.contributesTo.includes(focus)) add(p);
  }

  return { keepProjects, keepAreas };
}
