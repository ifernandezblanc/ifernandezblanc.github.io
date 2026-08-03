/* The knowledge graph in three dimensions, anchored to the marker printed in the CV.
 *
 * Nothing is loaded from a file: the scene is generated at runtime from graph.json, the
 * same data the reading and 2D graph views use. The previous AR CV was a hand-built
 * Vectary export where every letter was its own mesh, which is precisely why it sat
 * four years out of date.
 */
AFRAME.registerComponent("cvgraph", {
  schema: { src: { default: "graph.json" }, layout: { default: "force" } },

  init() {
    this.nodes = [];
    this.links = [];
    this.labels = new Map();
    this.focus = null;
    this.root = new THREE.Group();
    this.el.setObject3D("graph", this.root);
    this.palette = {};
    fetch(this.data.src).then((r) => r.json()).then((data) => this.assemble(data));
    this.el.sceneEl.addEventListener("click", (event) => this.pick(event));
  },

  /* --- construction ----------------------------------------------------- */

  assemble(data) {
    const styles = getComputedStyle(document.documentElement);
    Object.entries(data.kinds).forEach(([kind, slot]) => {
      this.palette[kind] = new THREE.Color(styles.getPropertyValue(`--${slot}`).trim() || "#888");
    });

    const byId = new Map();
    this.nodes = data.nodes.map((node) => {
      const item = {
        ...node,
        position: new THREE.Vector3().randomDirection().multiplyScalar(0.6),
        velocity: new THREE.Vector3(),
        degree: 0,
      };
      byId.set(node.id, item);
      return item;
    });
    this.links = data.links
      .map((link) => ({ source: byId.get(link.source), target: byId.get(link.target) }))
      .filter((link) => link.source && link.target);
    this.links.forEach((link) => { link.source.degree++; link.target.degree++; });

    this.relax(320);
    this.buildNodes();
    this.buildEdges();
    this.buildLabels();
    document.getElementById("loading")?.setAttribute("hidden", "");
  },

  /* Settle the layout once on load rather than every frame: phones do not have the
     budget for a live simulation on top of camera tracking. */
  relax(iterations) {
    const centre = new THREE.Vector3();
    const delta = new THREE.Vector3();
    for (let step = 0; step < iterations; step++) {
      const cooling = 1 - step / iterations;
      for (let i = 0; i < this.nodes.length; i++) {
        const a = this.nodes[i];
        for (let j = i + 1; j < this.nodes.length; j++) {
          const b = this.nodes[j];
          delta.subVectors(b.position, a.position);
          const distance = Math.max(delta.length(), 0.02);
          const push = (0.0016 / (distance * distance)) * cooling;
          delta.normalize().multiplyScalar(push);
          a.velocity.sub(delta);
          b.velocity.add(delta);
        }
      }
      this.links.forEach((link) => {
        delta.subVectors(link.target.position, link.source.position);
        const distance = Math.max(delta.length(), 0.02);
        delta.multiplyScalar(((distance - 0.22) / distance) * 0.06 * cooling);
        link.source.velocity.add(delta);
        link.target.velocity.sub(delta);
      });
      this.nodes.forEach((node) => {
        node.velocity.addScaledVector(node.position, -0.02 * cooling);
        node.position.add(node.velocity.multiplyScalar(0.72));
        centre.add(node.position);
      });
      centre.divideScalar(this.nodes.length);
      this.nodes.forEach((node) => node.position.sub(centre));
      centre.set(0, 0, 0);
    }
    if (this.data.layout === "timeline") this.applyTimeline();
  },

  /* The timeline is the same graph on a time axis, not a different dataset. */
  applyTimeline() {
    const years = this.nodes.map((n) => n.year).filter(Boolean);
    const earliest = Math.min(...years);
    const latest = Math.max(...years);
    const span = Math.max(1, latest - earliest);
    this.nodes.forEach((node) => {
      if (node.year) node.position.x = ((node.year - earliest) / span - 0.5) * 1.6;
    });
  },

  radius(node) {
    return 0.012 + Math.sqrt(node.weight) * 0.009;
  },

  buildNodes() {
    const geometry = new THREE.SphereGeometry(1, 12, 10);
    const byKind = {};
    this.nodes.forEach((node) => { (byKind[node.kind] ||= []).push(node); });

    Object.entries(byKind).forEach(([kind, members]) => {
      const material = new THREE.MeshStandardMaterial({
        color: this.palette[kind] || 0x888888, roughness: 0.55, metalness: 0.05,
      });
      const mesh = new THREE.InstancedMesh(geometry, material, members.length);
      const matrix = new THREE.Matrix4();
      members.forEach((node, index) => {
        const scale = this.radius(node);
        matrix.compose(node.position, new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale));
        mesh.setMatrixAt(index, matrix);
        node.instance = { mesh, index };
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.root.add(mesh);
    });
  },

  buildEdges() {
    const points = [];
    this.links.forEach((link) => {
      points.push(link.source.position.clone(), link.target.position.clone());
    });
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ color: 0x5a6478, transparent: true, opacity: 0.34 });
    this.edges = new THREE.LineSegments(geometry, material);
    this.root.add(this.edges);
  },

  /* Labels are canvas sprites so no font has to load, and only the readable ones are
     created: at marker scale, ninety labels is noise. */
  label(node) {
    if (this.labels.has(node.id)) return this.labels.get(node.id);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    const text = node.label.length > 28 ? `${node.label.slice(0, 27)}…` : node.label;
    context.font = "600 40px system-ui, sans-serif";
    canvas.width = Math.ceil(context.measureText(text).width) + 24;
    canvas.height = 56;
    context.font = "600 40px system-ui, sans-serif";
    context.fillStyle = "rgba(255,255,255,.9)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#16181d";
    context.textBaseline = "middle";
    context.fillText(text, 12, canvas.height / 2);

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false })
    );
    sprite.scale.set((canvas.width / canvas.height) * 0.055, 0.055, 1);
    sprite.position.copy(node.position).add(new THREE.Vector3(0, this.radius(node) + 0.035, 0));
    this.root.add(sprite);
    this.labels.set(node.id, sprite);
    return sprite;
  },

  buildLabels() {
    this.nodes
      .filter((node) => node.kind === "person" || node.degree >= 6)
      .forEach((node) => this.label(node));
  },

  /* --- interaction ------------------------------------------------------ */

  neighbours(node) {
    const set = new Set([node.id]);
    this.links.forEach((link) => {
      if (link.source === node) set.add(link.target.id);
      if (link.target === node) set.add(link.source.id);
    });
    return set;
  },

  pick(event) {
    const camera = this.el.sceneEl.camera;
    if (!camera) return;
    const pointer = new THREE.Vector2(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1
    );
    const caster = new THREE.Raycaster();
    caster.setFromCamera(pointer, camera);
    const hits = caster.intersectObjects(this.root.children, false);
    const hit = hits.find((entry) => entry.object.isInstancedMesh);
    if (!hit) return this.show(null);
    const node = this.nodes.find(
      (candidate) => candidate.instance
        && candidate.instance.mesh === hit.object
        && candidate.instance.index === hit.instanceId
    );
    this.show(node === this.focus ? null : node);
  },

  show(node) {
    this.focus = node;
    const panel = document.getElementById("detail");
    if (!node) {
      panel.hidden = true;
      this.labels.forEach((sprite) => { sprite.visible = true; });
      this.edges.material.opacity = 0.34;
      return;
    }
    const lit = this.neighbours(node);
    this.nodes.filter((candidate) => lit.has(candidate.id)).forEach((candidate) => this.label(candidate));
    this.labels.forEach((sprite, id) => { sprite.visible = lit.has(id); });
    this.edges.material.opacity = 0.12;

    panel.hidden = false;
    panel.innerHTML =
      `<button type="button" class="close" aria-label="Close">×</button>` +
      `<span class="kind">${node.kind}</span><h2>${node.label}</h2>` +
      (node.detail ? `<p>${node.detail}</p>` : "");
    panel.querySelector(".close").addEventListener("click", () => this.show(null));
  },
});

document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("layout");
  toggle?.addEventListener("click", () => {
    const target = document.getElementById("cvgraph");
    const current = target.getAttribute("cvgraph").layout;
    const next = current === "force" ? "timeline" : "force";
    toggle.textContent = next === "force" ? "Timeline layout" : "Force layout";
    target.setAttribute("cvgraph", "layout", next);
    target.components.cvgraph.el.removeAttribute("cvgraph");
    target.setAttribute("cvgraph", { src: "graph.json", layout: next });
  });
});
