import type { App, TFile, FrontMatterCache } from "obsidian";

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

/** Folders that may contain typed notes that aren't real PARA nodes. */
const SKIP_PREFIXES = ["_templates", "04 Archive", "06 Reviews"];

/** The plugin-relevant nodes, bucketed by kind from a single vault pass. */
export interface VaultNodes {
  projects: ProjectNode[];
  resources: ProjectNode[];
  areas: ProjectNode[];
}

/** Order by created-date ascending, then title — stable so parents precede children. */
export const byCreated = (a: ProjectNode, b: ProjectNode) =>
  (a.created ?? "").localeCompare(b.created ?? "") || a.title.localeCompare(b.title);

/** Build a ProjectNode from one file's frontmatter; `kind` selects which fields apply. */
function baseNode(file: TFile, fm: FrontMatterCache, kind: ProjectNode["kind"]): ProjectNode {
  const isArea = kind === "area";
  return {
    title: file.basename,
    path: file.path,
    area: isArea ? file.basename : unlink(fm.area),
    status: isArea ? "area" : String(fm.status ?? "active"),
    // Areas use only `created`; projects/resources fall back to `started`.
    created: isArea
      ? (fm.created != null ? String(fm.created) : null)
      : fm.created != null ? String(fm.created)
      : fm.started != null ? String(fm.started)
      : null,
    branchedFrom: kind === "project" ? unlink(fm["branched-from"]) : null,
    contributesTo: isArea ? [] : unlinkList(fm["contributes-to"]),
    promotedTo: kind === "project" ? unlink(fm["promoted-to"]) : null,
    goal: fm.goal != null ? String(fm.goal) : null,
    nextAction: fm["next-action"] != null ? String(fm["next-action"]) : null,
    lastEdited: new Date(file.stat.mtime).toISOString(),
    cadence: fm.cadence != null ? String(fm.cadence) : null,
    kind,
    parentProject: kind === "resource" ? unlink(fm.project) : null,
  };
}

/**
 * Single vault pass that buckets every relevant note by kind. Replaces the three
 * former full-scan collectors (collectProjects/Resources/Areas) so one `draw()`
 * reads the vault once instead of three times.
 *  - project:  `type: project`
 *  - area:     `type: area` (incl. empty areas, so dead trunks still show)
 *  - resource: any non-project note that is `type: resource` OR carries a
 *              `project:` link (an `type: area` note with a `project:` link is,
 *              as before, collected as both an area and a resource).
 * Projects/resources are sorted by created-date ascending (parents before children).
 */
export function collectNodes(app: App): VaultNodes {
  const projects: ProjectNode[] = [];
  const resources: ProjectNode[] = [];
  const areas: ProjectNode[] = [];

  for (const file of app.vault.getMarkdownFiles()) {
    if (SKIP_PREFIXES.some((p) => file.path.startsWith(p))) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;

    if (fm.type === "project") { projects.push(baseNode(file, fm, "project")); continue; }
    if (fm.type === "area") areas.push(baseNode(file, fm, "area"));
    if (fm.type === "resource" || unlink(fm.project) != null) {
      resources.push(baseNode(file, fm, "resource"));
    }
  }

  projects.sort(byCreated);
  resources.sort(byCreated);
  return { projects, resources, areas };
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
