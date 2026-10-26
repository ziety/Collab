import { showCountry, hideCountry } from "./panel.js";

// Data is loaded with fetch() (not JSON module imports) so it works in every
// browser and with any static server: Live Server, start.bat, etc.
const [d110, d50] = await Promise.all(
  ["data/d110.json", "data/d50.json"].map((u) =>
    fetch(u).then((r) => r.json()),
  ),
);

const root = document.documentElement;
const canvas = document.getElementById("globe");
const ctx = canvas.getContext("2d");

/* ---------- data (Natural Earth via world-atlas) ---------- */
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const HUES = [88, 104, 72, 60, 118, 46];

// A ring that has collapsed to fewer than 3 distinct points (a tiny island
// after simplification) has zero area, and d3 can't tell its inside from its
// outside: it floods the whole visible hemisphere with that country's colour.
function ringOk(r) {
  const a = r[0];
  let b = null;
  for (let i = 1; i < r.length; i++) {
    const p = r[i];
    if (p[0] === a[0] && p[1] === a[1]) continue;
    if (!b) b = p;
    else if (!(p[0] === b[0] && p[1] === b[1])) return true;
  }
  return false;
}
function dropDegenerate(g) {
  const polys =
    g.type === "Polygon"
      ? [g.coordinates]
      : g.type === "MultiPolygon"
        ? g.coordinates
        : null;
  if (!polys) return g;
  const out = [];
  for (const rings of polys)
    if (ringOk(rings[0]))
      out.push(rings.filter((r, i) => i === 0 || ringOk(r)));
  return { type: "MultiPolygon", coordinates: out };
}

function prep(t, capsFrom) {
  const feats = topojson.feature(t, t.objects.countries).features;
  feats.forEach((f) => (f.geometry = dropDegenerate(f.geometry)));
  feats.forEach((f) => {
    const h = hash(f.properties.name || "x");
    const hue = HUES[h % HUES.length],
      j = (h >> 3) % 9;
    f.fills = {
      light: "hsl(" + hue + "," + (30 + j) + "%," + (60 + j) + "%)",
      dark: "hsl(" + hue + "," + (20 + j) + "%," + (21 + j) + "%)",
    };
  });
  // (a simplified copy stays within a hair of the original shape, so it can
  // reuse the original's bounds; the culling margin in draw() covers the rest)
  feats.forEach((f, i) => {
    f.cap = capsFrom
      ? capsFrom[i].cap
      : capOf(d3.geoCentroid(f), geomPoints(f.geometry));
  });
  return {
    features: feats,
    borders: chunkLines(topojson.mesh(t, t.objects.countries, (a, b) => a !== b)),
    coast: chunkLines(topojson.mesh(t, t.objects.countries, (a, b) => a === b)),
  };
}

// Bounding caps (centre + angular radius, radians) let draw() skip anything
// that is off-screen, which is what keeps zoomed-in rotation smooth.
function geomPoints(g) {
  const out = [];
  const walk = (a) => {
    if (typeof a[0] === "number") out.push(a);
    else a.forEach(walk);
  };
  walk(g.coordinates);
  return out;
}
function capOf(c, pts) {
  if (!c || !isFinite(c[0]) || !isFinite(c[1])) return { c: [0, 0], r: Math.PI };
  const rad = Math.PI / 180,
    cl = c[1] * rad,
    cx = Math.cos(cl) * Math.cos(c[0] * rad),
    cy = Math.cos(cl) * Math.sin(c[0] * rad),
    cz = Math.sin(cl);
  let minDot = 1;
  for (const p of pts) {
    const l = p[1] * rad,
      cp = Math.cos(l);
    const dot =
      cx * cp * Math.cos(p[0] * rad) + cy * cp * Math.sin(p[0] * rad) + cz * Math.sin(l);
    if (dot < minDot) minDot = dot;
  }
  return { c, r: Math.acos(Math.max(-1, minDot)) };
}
// split a mesh's long lines into short pieces (sharing end points) with caps
function chunkLines(mesh, n = 40) {
  const out = [];
  for (const line of mesh.coordinates) {
    for (let i = 0; i < line.length - 1; i += n) {
      const pts = line.slice(i, i + n + 1);
      out.push({ pts, cap: capOf(pts[pts.length >> 1], pts) });
    }
  }
  return out;
}

const LOD = [prep(d110), prep(d50)];

/* ---------- zoom-adaptive detail ----------
   Drawing the full detailed map is expensive at mid zoom (most of the globe
   is still on screen) even though most of its points are far smaller than a
   pixel. So each point of the detailed map gets an importance (Douglas-Peucker
   distance, computed once) and, per zoom, we draw a copy that only keeps
   points bigger than a pixel or so: same picture, far fewer points. While the
   globe is moving, fine detail is invisible, so it drops more of it. */
const PX_MOVING = 1.5, // tolerance in screen pixels while spinning/zooming
  PX_STILL = 0.6; // ...and when paused and still
const DETAIL_TOLS = [0.2, 0.1, 0.05, 0.025, 0.0125, 0.007]; // degrees, coarse -> fine

function arcImportance(xs, ys, sx, sy) {
  const n = xs.length,
    w = new Float64Array(n);
  w[0] = w[n - 1] = Infinity;
  const stack = [[0, n - 1, Infinity]];
  while (stack.length) {
    const [a, b, cap] = stack.pop();
    if (b - a < 2) continue;
    const ax = xs[a] * sx,
      ay = ys[a] * sy,
      dx = xs[b] * sx - ax,
      dy = ys[b] * sy - ay,
      len = Math.hypot(dx, dy);
    let md = -1,
      mi = a + 1;
    for (let i = a + 1; i < b; i++) {
      const px = xs[i] * sx - ax,
        py = ys[i] * sy - ay;
      const d = len ? Math.abs(px * dy - py * dx) / len : Math.hypot(px, py);
      if (d > md) {
        md = d;
        mi = i;
      }
    }
    w[mi] = Math.min(md, cap); // never more important than the point that split it
    stack.push([a, mi, w[mi]], [mi, b, w[mi]]);
  }
  return w;
}
const detailSrc = (() => {
  const [sx, sy] = d50.transform.scale;
  return d50.arcs.map((arc) => {
    const xs = new Int32Array(arc.length),
      ys = new Int32Array(arc.length);
    let x = 0,
      y = 0;
    arc.forEach((p, i) => {
      xs[i] = x += p[0];
      ys[i] = y += p[1];
    });
    return { xs, ys, w: arcImportance(xs, ys, sx, sy) };
  });
})();
function simplified(tol) {
  const arcs = detailSrc.map(({ xs, ys, w }) => {
    const out = [];
    let px = 0,
      py = 0;
    for (let i = 0; i < xs.length; i++) {
      if (w[i] < tol) continue;
      out.push([xs[i] - px, ys[i] - py]);
      px = xs[i];
      py = ys[i];
    }
    return out;
  });
  return prep({ ...d50, arcs }, LOD[1].features);
}
const detailLevels = [];
const detailLevel = (i) => (detailLevels[i] ||= simplified(DETAIL_TOLS[i]));
// build the levels in the background so the first zoom doesn't hitch
(function warm(i = 0) {
  if (i >= DETAIL_TOLS.length) return;
  setTimeout(() => {
    detailLevel(i);
    warm(i + 1);
  }, i ? 150 : 1500);
})();
// the coarsest level that is still within `px` pixels of the full detail at this scale
function detailFor(scale, px) {
  const need = ((px * 180) / Math.PI) / scale;
  const i = DETAIL_TOLS.findIndex((tol) => tol <= need);
  return i < 0 ? LOD[1] : detailLevel(i);
}
// label anchors: centroid of each country's largest piece

const labels = LOD[1].features
  .map((f) => {
    const polys =
      f.geometry.type === "MultiPolygon"
        ? f.geometry.coordinates.map((c) => ({
            type: "Polygon",
            coordinates: c,
          }))
        : [f.geometry];
    let best = polys[0],
      ba = -1;
    for (const p of polys) {
      const a = d3.geoArea(p);
      if (a > ba) {
        ba = a;
        best = p;
      }
    }
    return {
      name: f.properties.name,
      c: d3.geoCentroid(best),
      area: d3.geoArea(f),
      parea: ba,
      id: f.id,
      feat: f,
    };
  })
  .filter((l) => l.name)
  .sort((a, b) => b.area - a.area);
const grat = d3.geoGraticule10();
const SPHERE = { type: "Sphere" };

/* ---------- theme ---------- */
const THEMES = {
  light: {
    oceanIn: "#8cc3ee",
    oceanOut: "#3f83c4",
    border: "rgba(255,255,255,.75)",
    coast: "rgba(35,70,60,.55)",
    grat: "rgba(255,255,255,.18)",
    text: "#16261d",
    halo: "rgba(255,255,255,.85)",
    shadeHi: "rgba(255,255,255,.28)",
    shadeLo: "rgba(10,30,70,.38)",
    glow: "rgba(120,180,255,.45)",
    select: "#FDE047",
    selectText: "#EA835E",
  },
  dark: {
    oceanIn: "#10264a",
    oceanOut: "#060f22",
    border: "rgba(170,195,230,.32)",
    coast: "rgba(150,185,235,.55)",
    grat: "rgba(130,170,230,.09)",
    text: "#e9f1ff",
    halo: "rgba(0,4,14,.85)",
    shadeHi: "rgba(255,255,255,.10)",
    shadeLo: "rgba(0,0,10,.6)",
    glow: "rgba(80,140,255,.35)",
    select: "#FDE047",
    selectText: "#EA835E",
  },
};

function theme() {
  return (
    root.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  );
}

root.dataset.theme = "dark";
try {
  const t = localStorage.getItem("globe-theme");
  if (t) root.dataset.theme = t;
} catch (e) {}
document.getElementById("theme").addEventListener("click", () => {
  const n = theme() === "dark" ? "light" : "dark";
  root.dataset.theme = n;
  try {
    localStorage.setItem("globe-theme", n);
  } catch (e) {}
});

/* ---------- view state ---------- */
let W = 0,
  H = 0,
  dpr = 1,
  R = 0;
let lon = 20,
  lat = 18,
  zoom = 1,
  zoomT = 1,
  dragging = false,
  scrolling = false,
  spinning = true, // auto-rotation; toggled by the play/pause button, stopped by fly-to
  flight = null, // active fly-to animation
  wheelTimer;

const playEl = document.getElementById("play");
function setSpinning(on) {
  spinning = on;
  playEl.classList.toggle("on", on); // "on" = rotating -> shows the pause icon
  const label = on ? "Pause rotation" : "Play rotation";
  playEl.setAttribute("aria-label", label);
  playEl.title = label;
}
setSpinning(true);
playEl.addEventListener("click", () => setSpinning(!spinning));

// user input cancels any fly-to in progress, but never the auto-rotation:
// only the pause button (or choosing a country) stops that
function stopAuto() {
  flight = null;
}

const MINZ = 0.7,
  MAXZ = 16;
function resize() {
  dpr = window.devicePixelRatio || 1;
  W = innerWidth;
  H = innerHeight;
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  R = Math.min(W, H) * 0.36;
}
addEventListener("resize", resize);
resize();

const proj = d3.geoOrthographic().clipAngle(90).precision(0.4);
const path = d3.geoPath(proj, ctx);

/* ---------- input ---------- */
const ptrs = new Map();
let pinchD = 0;
const dist2 = () => {
  const a = [...ptrs.values()];
  return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
};
canvas.addEventListener("pointerdown", (e) => {
  stopAuto();
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  dragging = true;
  document.activeElement && document.activeElement.blur();
  closeResults();
  canvas.classList.add("drag");
  if (ptrs.size === 2) pinchD = dist2();
});
canvas.addEventListener("pointermove", (e) => {
  const p = ptrs.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x,
    dy = e.clientY - p.y;
  p.x = e.clientX;
  p.y = e.clientY;
  if (ptrs.size === 1) {
    const k = 180 / Math.PI / (R * zoom);
    lon -= dx * k;
    lat += dy * k;
    lat = Math.max(-85, Math.min(85, lat));
  } else if (ptrs.size === 2) {
    const d = dist2();
    if (pinchD > 0) {
      zoomT = Math.max(MINZ, Math.min(MAXZ, (zoomT * d) / pinchD));
      zoom = zoomT;
    }
    pinchD = d;
  }
});
function up(e) {
  ptrs.delete(e.pointerId);
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch (_) {}
  if (ptrs.size < 2) pinchD = 0;
  if (ptrs.size === 0) {
    dragging = false;
    canvas.classList.remove("drag");
  }
}
canvas.addEventListener("pointerup", up);
canvas.addEventListener("pointercancel", up);
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    stopAuto();

    scrolling = true;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      scrolling = false;
    }, 200);

    zoomT = Math.max(
      MINZ,
      Math.min(MAXZ, zoomT * Math.exp(-e.deltaY * 0.0016)),
    );
  },
  { passive: false },
);

/* ---------- fly-to ---------- */
function flyTo(l) {
  setSpinning(false);
  const lat1 = Math.max(-85, Math.min(85, l.c[1]));
  const dlon = ((((l.c[0] - lon) % 360) + 540) % 360) - 180; // shortest way round
  // pick a zoom so the country fills a comfortable part of the view
  const r = Math.sqrt(l.parea / Math.PI); // angular radius (rad)
  // lower FLY_FILL = more zoomed out when a country is selected (was 0.61 / max 10)
  const FLY_FILL = 0.45,
    FLY_MAXZ = 7.5;
  const z1 = Math.max(
    1,
    Math.min(FLY_MAXZ, FLY_FILL / Math.sin(Math.max(r, 0.002))),
  );
  const dist = d3.geoDistance([lon, lat], l.c);
  flight = {
    t0: performance.now(),
    dur: 800 + 900 * (dist / Math.PI),
    lon0: lon,
    dlon,
    lat0: lat,
    lat1,
    lz0: Math.log(zoom),
    lz1: Math.log(z1),
  };
}
function stepFlight(now) {
  const f = flight,
    t = Math.min(1, (now - f.t0) / f.dur),
    e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  lon = f.lon0 + f.dlon * e;
  lat = f.lat0 + (f.lat1 - f.lat0) * e;
  zoom = zoomT = Math.exp(f.lz0 + (f.lz1 - f.lz0) * e);
  if (t >= 1) flight = null;
}

/* ---------- country search ---------- */
const qEl = document.getElementById("q"),
  listEl = document.getElementById("results");
const norm = (s) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
const countries = labels
  .map((l) => ({ l, key: norm(l.name) }))
  .sort((a, b) => a.l.name.localeCompare(b.l.name));

let shown = [],
  active = -1,
  select = null;

function closeResults() {
  listEl.hidden = true;
  qEl.setAttribute("aria-expanded", "false");
  active = -1;
}
function setActive(i) {
  active = i;
  [...listEl.children].forEach((li, n) => {
    li.classList.toggle("active", n === i);
    if (n === i) li.scrollIntoView({ block: "nearest" });
  });
}
function choose(l) {
  select = l.name;
  qEl.value = l.name;
  closeResults();
  qEl.blur();
  flyTo(l);
  showCountry(l);
}
function renderResults() {
  const q = norm(qEl.value.trim());
  listEl.textContent = "";
  if (!q) {
    select = null;
    return closeResults();
  }
  const starts = [],
    contains = [];
  for (const c of countries) {
    const i = c.key.indexOf(q);
    if (i === 0) starts.push(c);
    else if (i > 0) contains.push(c);
  }
  shown = [...starts, ...contains].map((c) => c.l);
  if (!shown.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No countries found";
    listEl.appendChild(li);
  }
  for (const l of shown) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    // highlight the typed text (norm() keeps string length for these names)
    const i = norm(l.name).indexOf(q);
    if (i >= 0 && norm(l.name).length === l.name.length) {
      li.append(l.name.slice(0, i));
      const m = document.createElement("mark");
      m.textContent = l.name.slice(i, i + q.length);
      li.append(m, l.name.slice(i + q.length));
    } else li.textContent = l.name;
    li.addEventListener("click", () => choose(l));
    listEl.appendChild(li);
  }
  listEl.hidden = false;
  qEl.setAttribute("aria-expanded", "true");
  setActive(shown.length ? 0 : -1);
}
qEl.addEventListener("input", () => {
  // any edit that no longer matches the chosen country (e.g. backspace) hides the card
  if (norm(qEl.value.trim()) !== norm(select || "")) hideCountry();
  renderResults();
});
qEl.addEventListener("focus", () => {
  qEl.select();
  renderResults();
});
qEl.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!shown.length) return;
    e.preventDefault();
    const n = shown.length;
    setActive((active + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (shown[active]) choose(shown[active]);
  } else if (e.key === "Escape") {
    closeResults();
    qEl.blur();
  }
});
// keep input focused while clicking a result
listEl.addEventListener("mousedown", (e) => e.preventDefault());
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest("#search")) closeResults();
});

// shuffle: pick a random country (never the one already selected) and run it
// through the same path as choosing it from the search results
document.getElementById("shuffle").addEventListener("click", () => {
  const pool = countries.filter((c) => c.l.name !== select);
  choose(pool[Math.floor(Math.random() * pool.length)].l);
});

/* ---------- render ---------- */
function draw() {
  const T = THEMES[theme()],
    cx = W / 2,
    cy = H / 2,
    scale = R * zoom;
  proj.translate([cx, cy]).scale(scale).rotate([-lon, -lat]);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // atmosphere glow
  if (scale * 1.15 < Math.hypot(W, H) / 2) {
    const g = ctx.createRadialGradient(
      cx,
      cy,
      scale * 0.97,
      cx,
      cy,
      scale * 1.14,
    );
    g.addColorStop(0, T.glow);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, scale * 1.14, 0, Math.PI * 2);
    ctx.fill();
  }
  // ocean
  const og = ctx.createRadialGradient(
    cx - scale * 0.2,
    cy - scale * 0.25,
    scale * 0.05,
    cx,
    cy,
    scale,
  );
  og.addColorStop(0, T.oceanIn);
  og.addColorStop(1, T.oceanOut);
  ctx.beginPath();
  path(SPHERE);
  ctx.fillStyle = og;
  ctx.fill();
  // graticule
  ctx.beginPath();
  path(grat);
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = T.grat;
  ctx.stroke();

  // countries
  const lod =
      scrolling || dragging || flight
        ? LOD[0]
        : zoom >= 1.7
          ? detailFor(
              scale,
              spinning || Math.abs(zoomT - zoom) > 0.01 ? PX_MOVING : PX_STILL,
            )
          : LOD[0],
    tn = theme();
  // only draw what can be on screen: angular radius of the visible area
  const half = Math.hypot(W, H) / 2,
    lim = (half < scale ? Math.asin(half / scale) : Math.PI / 2) + 0.03,
    view = [lon, lat],
    seen = (k) => d3.geoDistance(k.c, view) - k.r <= lim;
  for (const f of lod.features) {
    if (!seen(f.cap)) continue;
    ctx.beginPath();
    path(f);
    ctx.fillStyle = f.properties.name === select ? T.select : f.fills[tn];
    ctx.fill();
  }
  const lines = (chunks) => ({
    type: "MultiLineString",
    coordinates: chunks.filter((k) => seen(k.cap)).map((k) => k.pts),
  });
  ctx.lineJoin = "round";
  ctx.beginPath();
  path(lines(lod.borders));
  ctx.lineWidth = Math.min(1.6, 0.5 + zoom * 0.12);
  ctx.strokeStyle = T.border;
  ctx.stroke();
  ctx.beginPath();
  path(lines(lod.coast));
  ctx.lineWidth = Math.min(1.8, 0.7 + zoom * 0.12);
  ctx.strokeStyle = T.coast;
  ctx.stroke();

  // sphere shading
  const sg = ctx.createRadialGradient(
    cx - scale * 0.38,
    cy - scale * 0.42,
    scale * 0.05,
    cx,
    cy,
    scale * 1.02,
  );
  sg.addColorStop(0, T.shadeHi);
  sg.addColorStop(0.45, "rgba(0,0,0,0)");
  sg.addColorStop(1, T.shadeLo);
  ctx.beginPath();
  path(SPHERE);
  ctx.fillStyle = sg;
  ctx.fill();

  // country names
  if (zoom >= 1.7) {
    const fs = Math.min(15, 9 + (zoom - 1.7) * 1.5);
    ctx.font = "600 " + fs + "px system-ui,-apple-system,Segoe UI,sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    const center = [lon, lat],
      placed = [];
    for (const l of labels) {
      const d = d3.geoDistance(l.c, center);
      if (d > 1.38) continue;
      const p = proj(l.c);
      if (!p) continue;
      if (p[0] < -60 || p[0] > W + 60 || p[1] < -20 || p[1] > H + 20) continue;
      const tw = ctx.measureText(l.name).width;
      const x0 = p[0] - tw / 2 - 3,
        x1 = p[0] + tw / 2 + 3,
        y0 = p[1] - fs / 2 - 2,
        y1 = p[1] + fs / 2 + 2;
      let hit = false;
      for (const r of placed) {
        if (x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]) {
          hit = true;
          break;
        }
      }
      if (hit) continue;
      placed.push([x0, y0, x1, y1]);
      ctx.globalAlpha = Math.max(
        0,
        Math.min(1, (1.42 - d) / 0.3, (zoom - 1.7) / 0.4),
      );
      ctx.strokeStyle = T.halo;
      ctx.strokeText(l.name, p[0], p[1]);
      ctx.fillStyle = l.name === select ? T.selectText : T.text;
      ctx.fillText(l.name, p[0], p[1]);
    }
    ctx.globalAlpha = 1;
  }
}

let prev = performance.now();
function frame(now) {
  const dt = Math.min((now - prev) / 1000, 0.05);
  prev = now;
  if (flight) stepFlight(now);
  else zoom += (zoomT - zoom) * Math.min(1, dt * 10);
  if (!dragging && spinning && !flight)
    lon += (9 / Math.pow(Math.max(1, zoom), 1.3)) * dt;
  if (lon > 180) lon -= 360;
  else if (lon < -180) lon += 360;
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
