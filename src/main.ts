import { Plugin } from "obsidian";
import { LineageView, VIEW_TYPE_LINEAGE } from "./view";

export default class ParaTreePlugin extends Plugin {
  async onload() {
    this.registerView(
      VIEW_TYPE_LINEAGE,
      (leaf) => new LineageView(leaf, this),
    );

    this.addRibbonIcon("workflow", "Para-tree", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open",
      name: "Open",
      callback: () => void this.activateView(),
    });

    // Re-draw the open view when project metadata changes.
    this.registerEvent(
      this.app.metadataCache.on("changed", () => this.refreshOpenViews()),
    );
  }

  // No onunload leaf-detaching: Obsidian guidelines advise against it (it discards
  // the user's open tab on every reload/update); Obsidian cleans up the view itself.

  refreshOpenViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_LINEAGE)) {
      const view = leaf.view;
      if (view instanceof LineageView) view.draw();
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_LINEAGE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_LINEAGE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }
}
