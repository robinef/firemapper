/** Entry point for /sources.html. */
import { loadManifest } from "./data";
import { renderSources } from "./sources_render";

const root = document.getElementById("sources");
if (root) {
  void loadManifest()
    .then((manifest) => renderSources(root, manifest))
    .catch(() => renderSources(root, null));
}
