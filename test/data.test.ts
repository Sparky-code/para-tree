import { test } from "node:test";
import assert from "node:assert/strict";
import { collectNodes } from "../src/data.ts";

/** Minimal fake of the bits of `App` that `collectNodes` touches. */
type FileSpec = { path: string; basename?: string; mtime?: number; fm?: Record<string, unknown> | null };

function makeApp(specs: FileSpec[]) {
  const files = specs.map((s) => ({
    path: s.path,
    basename: s.basename ?? s.path.split("/").pop()!.replace(/\.md$/, ""),
    stat: { mtime: s.mtime ?? 0 },
    _fm: s.fm,
  }));
  return {
    vault: { getMarkdownFiles: () => files },
    metadataCache: {
      getFileCache: (file: { _fm?: Record<string, unknown> | null }) =>
        file._fm === undefined ? null : { frontmatter: file._fm },
    },
  } as any; // duck-typed App for the test
}

test("buckets notes by kind and strips wikilinks", () => {
  const { projects, resources, areas } = collectNodes(makeApp([
    { path: "01 Projects/Job Exit.md", fm: { type: "project", area: "[[Career]]", status: "active", created: "2026-01-01" } },
    { path: "01 Projects/Czech.md", fm: { type: "project", area: "[[Language]]", "branched-from": "[[Job Exit]]", created: "2026-02-01" } },
    { path: "02 Areas/Career.md", fm: { type: "area" } },
    { path: "03 Resources/RFC.md", fm: { type: "resource", project: "[[Job Exit]]" } },
    { path: "00 Inbox/loose note.md", fm: { project: "[[Czech]]" } }, // untyped + project link -> resource
    { path: "00 Inbox/plain.md", fm: { type: "note" } },             // no type/project -> excluded
    { path: "00 Inbox/empty.md", fm: undefined },                     // no frontmatter -> excluded
  ]));

  assert.equal(projects.length, 2);
  assert.equal(areas.length, 1);
  assert.equal(resources.length, 2); // RFC + the untyped-with-link note

  const job = projects.find((p) => p.title === "Job Exit")!;
  assert.equal(job.area, "Career");            // [[Career]] -> Career
  assert.equal(job.kind, "project");

  const czech = projects.find((p) => p.title === "Czech")!;
  assert.equal(czech.branchedFrom, "Job Exit"); // [[Job Exit]] -> Job Exit

  const rfc = resources.find((r) => r.title === "RFC")!;
  assert.equal(rfc.kind, "resource");
  assert.equal(rfc.parentProject, "Job Exit");
});

test("projects are sorted by created date ascending", () => {
  const { projects } = collectNodes(makeApp([
    { path: "a.md", fm: { type: "project", created: "2026-03-01" } },
    { path: "b.md", fm: { type: "project", created: "2026-01-15" } },
    { path: "c.md", fm: { type: "project", created: "2026-02-10" } },
  ]));
  assert.deepEqual(projects.map((p) => p.title), ["b", "c", "a"]);
});

test("skip-folder notes are excluded from every bucket", () => {
  const { projects, resources, areas } = collectNodes(makeApp([
    { path: "_templates/Project.md", fm: { type: "project" } },
    { path: "04 Archive/Old.md", fm: { type: "project" } },
    { path: "06 Reviews/Weekly.md", fm: { type: "resource", project: "[[X]]" } },
    { path: "02 Areas/_templates-lookalike Career.md", fm: { type: "area" } }, // NOT skipped (prefix differs)
  ]));
  assert.equal(projects.length, 0);
  assert.equal(resources.length, 0);
  assert.equal(areas.length, 1); // only the non-skipped area
});

test("an `area` note carrying a `project:` link lands in BOTH areas and resources", () => {
  // Preserves the pre-refactor overlap (collectAreas + collectResources both matched it).
  const { areas, resources } = collectNodes(makeApp([
    { path: "02 Areas/Health.md", fm: { type: "area", project: "[[Health Lab]]" } },
  ]));
  assert.equal(areas.length, 1);
  assert.equal(resources.length, 1);
  assert.equal(resources[0].parentProject, "Health Lab");
});

test("status defaults to 'active' for projects, 'area' for areas", () => {
  const { projects, areas } = collectNodes(makeApp([
    { path: "p.md", fm: { type: "project" } },
    { path: "a.md", fm: { type: "area" } },
  ]));
  assert.equal(projects[0].status, "active");
  assert.equal(areas[0].status, "area");
});
