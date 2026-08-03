/* Force-directed knowledge graph.
 *
 * Written rather than vendored: the dataset is ~100 nodes, so a naive O(n^2) repulsion
 * is comfortably fast, and it keeps the site free of third-party code — the previous
 * version of this site broke because a CDN shut down.
 */
(() => {
  "use strict";

  const canvas = document.getElementById("graph");
  const panel = document.getElementById("detail");
  const legend = document.getElementById("legend");
  const context = canvas.getContext("2d");
  const styles = getComputedStyle(document.documentElement);

  const state = {
    nodes: [], links: [], kinds: {},
    hidden: new Set(), focus: null, hover: null,
    scale: 1, offset: { x: 0, y: 0 },
    drag: null, panning: null, alpha: 1,
  };

  const colourOf = (kind) => styles.getPropertyValue(`--${state.kinds[kind]}`).trim() || "#888";
  const radiusOf = (node) => 4 + Math.sqrt(node.weight) * 3.2;

  /* --- data ------------------------------------------------------------- */

  async function load() {
    const data = await (await fetch("graph.json")).json();
    state.kinds = data.kinds;
    const byId = new Map();
    state.nodes = data.nodes.map((node, index) => {
      const angle = (index / data.nodes.length) * Math.PI * 2;
      const item = { ...node, x: Math.cos(angle) * 260, y: Math.sin(angle) * 260, vx: 0, vy: 0, degree: 0 };
      byId.set(node.id, item);
      return item;
    });
    state.links = data.links
      .map((link) => ({ ...link, source: byId.get(link.source), target: byId.get(link.target) }))
      .filter((link) => link.source && link.target);
    state.links.forEach((link) => { link.source.degree++; link.target.degree++; });
    buildLegend();
    resize();
    settle();
    frame();
    requestAnimationFrame(tick);
  }

  function buildLegend() {
    const counts = {};
    state.nodes.forEach((node) => { counts[node.kind] = (counts[node.kind] || 0) + 1; });
    legend.innerHTML = "";
    Object.keys(state.kinds).forEach((kind) => {
      if (!counts[kind]) return;
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.kind = kind;
      button.innerHTML =
        `<i style="background:${colourOf(kind)}"></i>${kind} <b>${counts[kind]}</b>`;
      button.addEventListener("click", () => {
        state.hidden.has(kind) ? state.hidden.delete(kind) : state.hidden.add(kind);
        button.classList.toggle("off", state.hidden.has(kind));
        state.alpha = Math.max(state.alpha, 0.5);
      });
      legend.appendChild(button);
    });
  }

  /* --- layout ----------------------------------------------------------- */

  /* Run the simulation to rest before the first frame. Watching a hundred nodes
     drift into place for several seconds is not an animation anyone asked for; the
     graph should be readable the moment it appears. */
  function settle() {
    const alpha = state.alpha;
    for (let i = 0; i < 260; i++) {
      state.alpha = 1 - i / 320;
      simulate();
    }
    state.alpha = alpha * 0.12;
  }

  /* Fit the settled layout to the canvas, so the graph arrives whole rather than
     cropped at whatever zoom happened to be the default. */
  function frame() {
    const live = state.nodes.filter(visible);
    if (!live.length) return;
    const xs = live.map((n) => n.x), ys = live.map((n) => n.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    const box = canvas.getBoundingClientRect();
    const margin = 90;
    state.scale = Math.min(
      1.4,
      Math.max(0.25, Math.min((box.width - margin) / width, (box.height - margin) / height))
    );
    state.offset = {
      x: -((Math.max(...xs) + Math.min(...xs)) / 2) * state.scale,
      y: -((Math.max(...ys) + Math.min(...ys)) / 2) * state.scale,
    };
  }

  const visible = (node) => !state.hidden.has(node.kind);

  function simulate() {
    const live = state.nodes.filter(visible);
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      for (let j = i + 1; j < live.length; j++) {
        const b = live[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let distance = Math.hypot(dx, dy) || 0.01;
        if (distance > 620) continue;
        const push = (5600 / (distance * distance)) * state.alpha;
        dx /= distance; dy /= distance;
        a.vx -= dx * push; a.vy -= dy * push;
        b.vx += dx * push; b.vy += dy * push;
      }
      // gentle pull to centre keeps disconnected clusters on screen
      a.vx -= a.x * 0.0016 * state.alpha;
      a.vy -= a.y * 0.0016 * state.alpha;
    }

    state.links.forEach((link) => {
      if (!visible(link.source) || !visible(link.target)) return;
      const dx = link.target.x - link.source.x;
      const dy = link.target.y - link.source.y;
      const distance = Math.hypot(dx, dy) || 0.01;
      const rest = link.kind === "uses" ? 130 : 190;
      const force = ((distance - rest) / distance) * 0.045 * state.alpha;
      link.source.vx += dx * force; link.source.vy += dy * force;
      link.target.vx -= dx * force; link.target.vy -= dy * force;
    });

    live.forEach((node) => {
      if (node === state.drag) return;
      node.x += (node.vx *= 0.82);
      node.y += (node.vy *= 0.82);
    });
    state.alpha = Math.max(0, state.alpha * 0.94);
  }

  /* --- rendering -------------------------------------------------------- */

  function neighbours(node) {
    const set = new Set([node.id]);
    state.links.forEach((link) => {
      if (link.source === node) set.add(link.target.id);
      if (link.target === node) set.add(link.source.id);
    });
    return set;
  }

  function draw() {
    const { width, height } = canvas;
    const dpr = window.devicePixelRatio || 1;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width / dpr, height / dpr);
    context.translate(width / (2 * dpr) + state.offset.x, height / (2 * dpr) + state.offset.y);
    context.scale(state.scale, state.scale);

    const active = state.focus || state.hover;
    const lit = active ? neighbours(active) : null;

    state.links.forEach((link) => {
      if (!visible(link.source) || !visible(link.target)) return;
      const on = !lit || (lit.has(link.source.id) && lit.has(link.target.id));
      context.strokeStyle = on ? "rgba(90,100,120,.42)" : "rgba(90,100,120,.07)";
      context.lineWidth = on ? 1.1 : 0.7;
      context.beginPath();
      context.moveTo(link.source.x, link.source.y);
      context.lineTo(link.target.x, link.target.y);
      context.stroke();
    });

    state.nodes.filter(visible).forEach((node) => {
      const on = !lit || lit.has(node.id);
      const radius = radiusOf(node);
      context.globalAlpha = on ? 1 : 0.16;
      context.fillStyle = colourOf(node.kind);
      context.beginPath();
      context.arc(node.x, node.y, radius, 0, Math.PI * 2);
      context.fill();
      if (node === active) {
        context.strokeStyle = "#111"; context.lineWidth = 2; context.stroke();
      }
      // labels only where they can be read: focused neighbourhood, or well-connected nodes
      const label = on && (lit || node.kind === "person" || node.degree >= 7 || state.scale > 1.1);
      if (label) {
        context.globalAlpha = on ? 1 : 0.2;
        context.fillStyle = "#20242c";
        context.font = `${node.kind === "person" ? 600 : 400} ${11 / state.scale + 5}px system-ui, sans-serif`;
        context.textAlign = "center";
        context.fillText(trim(node.label), node.x, node.y - radius - 5);
      }
      context.globalAlpha = 1;
    });
  }

  const trim = (text) => (text.length > 34 ? `${text.slice(0, 33)}…` : text);

  function tick() {
    if (state.alpha > 0.002 || state.drag) simulate();
    draw();
    requestAnimationFrame(tick);
  }

  /* --- interaction ------------------------------------------------------ */

  function toWorld(event) {
    const box = canvas.getBoundingClientRect();
    const point = event.touches ? event.touches[0] : event;
    return {
      x: (point.clientX - box.left - box.width / 2 - state.offset.x) / state.scale,
      y: (point.clientY - box.top - box.height / 2 - state.offset.y) / state.scale,
    };
  }

  function nodeAt(position) {
    let found = null;
    state.nodes.filter(visible).forEach((node) => {
      if (Math.hypot(node.x - position.x, node.y - position.y) <= radiusOf(node) + 6) found = node;
    });
    return found;
  }

  function show(node) {
    state.focus = node;
    if (!node) { panel.hidden = true; return; }
    panel.hidden = false;
    panel.innerHTML =
      `<button type="button" class="close" aria-label="Close">×</button>` +
      `<span class="kind" style="color:${colourOf(node.kind)}">${node.kind}</span>` +
      `<h2>${escapeHtml(node.label)}</h2>` +
      (node.detail ? `<p>${escapeHtml(node.detail)}</p>` : "") +
      (node.tags && node.tags.length
        ? `<div class="tags">${node.tags.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</div>`
        : "");
    panel.querySelector(".close").addEventListener("click", () => show(null));
  }

  const escapeHtml = (text) =>
    text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  canvas.addEventListener("mousemove", (event) => {
    if (state.panning) {
      state.offset.x += event.clientX - state.panning.x;
      state.offset.y += event.clientY - state.panning.y;
      state.panning = { x: event.clientX, y: event.clientY };
      return;
    }
    const position = toWorld(event);
    if (state.drag) { state.drag.x = position.x; state.drag.y = position.y; state.alpha = 0.5; return; }
    state.hover = nodeAt(position);
    canvas.style.cursor = state.hover ? "pointer" : "grab";
  });

  canvas.addEventListener("mousedown", (event) => {
    const node = nodeAt(toWorld(event));
    if (node) { state.drag = node; state.alpha = 0.6; }
    else state.panning = { x: event.clientX, y: event.clientY };
  });

  window.addEventListener("mouseup", (event) => {
    if (state.drag) {
      const node = nodeAt(toWorld(event));
      if (node === state.drag) show(node === state.focus ? null : node);
    } else if (!state.panning) {
      show(null);
    }
    state.drag = null; state.panning = null;
  });

  canvas.addEventListener("click", (event) => {
    if (state.drag || state.panning) return;
    const node = nodeAt(toWorld(event));
    if (!node) show(null);
  });

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 0.89;
    state.scale = Math.min(4, Math.max(0.3, state.scale * factor));
  }, { passive: false });

  // touch: one finger drags a node or pans, two fingers pinch to zoom
  let pinch = null;
  canvas.addEventListener("touchstart", (event) => {
    if (event.touches.length === 2) {
      pinch = Math.hypot(
        event.touches[0].clientX - event.touches[1].clientX,
        event.touches[0].clientY - event.touches[1].clientY);
      return;
    }
    const node = nodeAt(toWorld(event));
    if (node) { state.drag = node; state.alpha = 0.6; show(node); }
    else state.panning = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }, { passive: true });

  canvas.addEventListener("touchmove", (event) => {
    if (pinch && event.touches.length === 2) {
      const distance = Math.hypot(
        event.touches[0].clientX - event.touches[1].clientX,
        event.touches[0].clientY - event.touches[1].clientY);
      state.scale = Math.min(4, Math.max(0.3, state.scale * (distance / pinch)));
      pinch = distance;
      event.preventDefault();
      return;
    }
    if (state.drag) {
      const position = toWorld(event);
      state.drag.x = position.x; state.drag.y = position.y; state.alpha = 0.5;
      event.preventDefault();
    } else if (state.panning) {
      state.offset.x += event.touches[0].clientX - state.panning.x;
      state.offset.y += event.touches[0].clientY - state.panning.y;
      state.panning = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      event.preventDefault();
    }
  }, { passive: false });

  canvas.addEventListener("touchend", () => { state.drag = null; state.panning = null; pinch = null; });

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const box = canvas.parentElement.getBoundingClientRect();
    canvas.width = box.width * dpr;
    canvas.height = box.height * dpr;
    canvas.style.width = `${box.width}px`;
    canvas.style.height = `${box.height}px`;
  }

  window.addEventListener("resize", () => { resize(); state.alpha = 0.5; });
  document.getElementById("recentre").addEventListener("click", () => {
    show(null);
    frame();
  });

  load();
})();
