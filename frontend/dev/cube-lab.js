// DEVELOPMENT ONLY: drive the cube loader by hand to inspect every motion mode and the settle.
import { cubeLoader } from "../js/components/cube.js";
import { brandMark, h } from "../js/dom.js";

const stage = document.getElementById("stage");
const ref = document.getElementById("ref");
ref.append(brandMark({ className: "lab__mark" }));

let cube = null;
function fresh() {
  cube?.destroy();
  cube = cubeLoader({ label: "lab" });
  stage.replaceChildren(cube.el);
}
fresh();
const modes = ["open", "prepare", "generate", "execute", "verify", "repair", "analyze"];
const controls = document.getElementById("controls");
for (const m of modes) controls.append(h("button", { class: "btn btn--secondary btn--sm", type: "button", text: m, onClick: () => cube.setMode(m) }));
controls.append(h("button", { class: "btn btn--primary btn--sm", type: "button", text: "settle (done)", onClick: () => cube.settle() }));
controls.append(h("button", { class: "btn btn--secondary btn--sm", type: "button", text: "settle (failed)", onClick: () => cube.settle({ failed: true }) }));
controls.append(h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "restart", onClick: fresh }));
const p = new URLSearchParams(location.search).get("mode");
if (p) cube.setMode(p);
