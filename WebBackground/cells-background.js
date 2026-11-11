// cells-background.js
// A lightweight, full-screen animated background for the Spleen Attack website: the game's playing
// plane, with its cells laid out exactly as in the game (from the same CSV, see
// tools/export_cells.py), drifting gently under a slowly orbiting camera in the game's dark red fog.
// The camera follows the pointer a little (parallax), and scrolling down the page plays the
// transition from stage 1 to stage 2, as in the game: each stage-1 cell shrinks away at its own
// moment and its stage-2 replacement grows in, while the cells scatter (the game's chaos phase).
// Scrolling back up plays it in reverse.
//
// Every cell is one point sprite, shaded in the fragment shader as a lit sphere with the game's
// inner/outer cell colours, and the transition runs in the vertex shader — so the whole plane is a
// single draw call, cheap enough for a page background, including on phones (which draw fewer cells).
//
// Usage — needs three.js (r150+) importable as "three" (an import map or a bundler):
//
//   <script type="importmap">
//     { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js" } }
//   </script>
//   <script type="module">
//     import { initCellsBackground } from "./cells-background.js";
//     initCellsBackground();                       // fixed, full-screen, behind the page
//   </script>
//
// initCellsBackground(container?, options?) — or initCellsBackground(options) — returns
// { settings, progress, setProgress(p), setPaused(bool), dispose() }.
// With no container it adds a fixed canvas behind everything on <body>. Options: see DEFAULTS.
// `settings` is the live options object: the orbit, parallax and transition values in it are read
// every frame, so they can be tuned from the browser console, e.g.  bg.settings.parallaxOrbit = 0.2

import * as THREE from "three";
import { CELL_COUNT, QUANT, DELTA_QUANT, PLANE_RADIUS, NONE, STAGE_CENTERS, DATA } from "./cells-data.js";

const DEFAULTS = {
  // Fraction of the cells to draw (0–1). "auto": all on large screens, 70% on phones.
  density: "auto",
  // Camera orbit speed around the plane (radians / second). 0 = still.
  orbitSpeed: 0.025,
  // Cells drift and wobble (as their random walk does in the game).
  cellMotion: true,

  // ── Parallax: the camera follows the pointer a little ──
  parallax: true,
  // How far the camera swings around the plane with the pointer at the left/right edge (radians).
  parallaxOrbit: 0.1,
  // How far the camera rises/drops with the pointer at the top/bottom edge (world units; the
  // camera is 30 up, the plane ~65 across).
  parallaxHeight: 10,
  // Seconds the camera takes to catch up with the pointer (higher = lazier, 0 = instant).
  parallaxSmoothing: 0.4,
  // Move the opposite way to the pointer.
  parallaxInvert: false,
  // Drift back to the centre view when the pointer leaves the window.
  parallaxReturnOnLeave: true,

  // ── Stage 1 → stage 2 transition, played by scrolling ──
  // Drive the transition from the page's scroll position. Off: it stays at stage 1 unless set with
  // setProgress(0–1) (e.g. from your own scroll library).
  scrollTransition: true,
  // Where in the page's scroll the transition starts and finishes, as fractions of the scrollable
  // height (0 = top of the page, 1 = bottom).
  transitionStart: 0.1,
  transitionEnd: 0.8,
  // How staggered the cells are: the fraction of the transition over which they start changing.
  // 0 = all at once; near 1 = one after another, each changing quickly.
  transitionSpread: 0.75,
  // How much the cells scatter mid-transition (the game's chaos phase). 0 = none.
  transitionChaos: 1,
  // Seconds the transition takes to catch up with the scroll position (smooths out mouse-wheel steps).
  transitionSmoothing: 0.35,
  // Centre each stage's circle of cells on the same point. In the game's data stage 2's circle sits
  // ~2.3 units off stage 1's, so without this the whole plane shifts sideways during the transition.
  centerStages: true,
  // Extra nudge for each stage's circle, [x, z] in world units (the plane is ~65 across), on top of
  // Center Stages: +x moves it right and +z towards the camera, as seen from the starting view. The
  // plane glides from one to the other during the transition.
  stage1Offset: [0, 0],
  stage2Offset: [0, 0],

  // Darkened edges, so text over the page stays readable.
  vignette: true,
  // Background colour, and the colour / thickness of the haze over the cells (the game's red fog).
  background: "#1a0608",
  fogColor: "#3a0b0d",
  fogDensity: 0.0125,
  // Overall cell brightness (the game is dark — lower this further if text over it needs contrast).
  brightness: 0.9,
  // Device-pixel-ratio cap (lower = lighter on high-DPI screens).
  maxPixelRatio: 1.75,
  // Honour the "reduce motion" accessibility setting: no animation — the view only changes when
  // the page is scrolled, without the scatter.
  respectReducedMotion: true,
};

// Cell types, in the order of the type indices in cells-data.js — colours and sizes from the game
// (prefab materials' Inner/Outer base colours; diameter = prefab scale × mesh size).
const TYPES = [
  { name: "B cells",       inner: "#334aef", outer: "#5963ab", size: 0.31 },
  // Myeloid cells are brightened and enlarged a little from the game's values so the red mass of
  // them in stage 2 reads at a distance, as it does in the game (which renders them with more detail).
  { name: "MYELOID CELLS", inner: "#c0381c", outer: "#8a1c0c", size: 0.27 },
  { name: "cDC2",          inner: "#b53b77", outer: "#952f62", size: 0.43 },
  { name: "Erythrocyte",   inner: "#910900", outer: "#910900", size: 0.19, flat: 0.55 },
  { name: "CD4+ T cells",  inner: "#b8be59", outer: "#8e8c4e", size: 0.31 },
  { name: "CD8+ T cells",  inner: "#ec9f2b", outer: "#ec9f2b", size: 0.31 },
  { name: "STROMAL CELLS", inner: "#4a1810", outer: "#2e0c08", size: 0.30 },
  { name: "cDC1",          inner: "#ef2388", outer: "#ef2388", size: 0.34 },
  { name: "ASC",           inner: "#2aa6e4", outer: "#4ec3ff", size: 0.41 },
];

// Camera framing, after the game's start view (from y 30, 50 back, looking down ~29°, 50° FOV).
const CAMERA = { fov: 50, height: 30, distance: 50, lookAtY: -5 };

// ── Shaders ──────────────────────────────────────────────────────────────────

const CELL_VERTEX = /* glsl */ `
  #define TYPE_COUNT ${TYPES.length}

  attribute vec2 aDelta;    // stage-2 position minus stage-1 position (xz)
  attribute vec2 aTypes;    // stage-1 / stage-2 type index (255 = no cell in that stage)
  attribute vec2 aRand;     // x: motion phase, y: when the cell changes (0–1)

  uniform vec3  uInner[TYPE_COUNT];
  uniform vec3  uOuter[TYPE_COUNT];
  uniform float uSize[TYPE_COUNT];
  uniform float uFlat[TYPE_COUNT];

  uniform float uTime;
  uniform float uMotion;
  uniform float uProgress;     // 0 = stage 1, 1 = stage 2
  uniform float uSpread;
  uniform float uChaos;
  uniform vec2  uOffset0;      // where stage 1's circle is moved to (see centerStages / stage1Offset)
  uniform vec2  uOffset1;      // ...and stage 2's
  uniform float uPointScale;   // viewport height / (2 tan(fov / 2)) in device pixels
  uniform float uFogDensity;

  varying vec3  vInner;
  varying vec3  vOuter;
  varying float vFlat;
  varying float vPhase;
  varying float vFog;

  void main() {
    // This cell's own progress through the transition: it starts at a random point (spread over
    // uSpread of the whole) and takes the rest of it.
    float spread = clamp(uSpread, 0.0, 0.98);
    float q = clamp((uProgress - aRand.y * spread) / (1.0 - spread), 0.0, 1.0);

    // As in the game: the stage-1 cell scales out over the first half, the stage-2 cell scales in
    // over the second (moving to its stage-2 spot while it's tiny).
    bool has0 = aTypes.x < 254.5;
    bool has1 = aTypes.y < 254.5;
    int  t0 = int(has0 ? aTypes.x : aTypes.y);
    int  t1 = int(has1 ? aTypes.y : aTypes.x);
    float out0 = has0 ? 1.0 - smoothstep(0.0, 0.5, q) : 0.0;
    float in1  = has1 ? smoothstep(0.5, 1.0, q) : 0.0;
    bool  second = q >= 0.5;
    int   t = second ? t1 : t0;
    float jitter = 0.9 + 0.2 * fract(aRand.x * 7.31);
    float size = (second ? uSize[t1] * in1 : uSize[t0] * out0) * jitter;

    // Stage-1 spot → stage-2 spot, each with its stage's offset (cells only in one stage glide with
    // the plane too). position is the stage-1 spot, or the stage-2 spot for cells only in stage 2.
    vec3 o0 = vec3(uOffset0.x, 0.0, uOffset0.y);
    vec3 o1 = vec3(uOffset1.x, 0.0, uOffset1.y);
    vec3 p = has0
      ? mix(position + o0, position + vec3(aDelta.x, 0.0, aDelta.y) + o1, smoothstep(0.3, 0.7, q))
      : position + o1;

    // Gentle drift and bob, each cell on its own phase (a stand-in for the game's random walk)...
    float time = uTime * uMotion;
    float a = aRand.x * 6.2831853;
    p.x += 0.07 * sin(time * 0.55 + a) + 0.03 * sin(time * 1.30 + a * 3.0);
    p.z += 0.07 * cos(time * 0.47 + a * 2.0) + 0.03 * cos(time * 1.10 + a * 5.0);
    p.y += 0.05 * sin(time * 0.80 + a * 7.0);
    // ...and the scatter mid-transition (the game's chaos phase: faster, looser).
    float chaos = uChaos * sin(3.14159265 * clamp(uProgress, 0.0, 1.0));
    p.x += chaos * 0.45 * sin(time * 2.1 + a * 11.0);
    p.z += chaos * 0.45 * cos(time * 1.7 + a * 13.0);
    p.y += chaos * (0.6 + 0.4 * sin(time * 1.3 + a * 5.0)) * fract(aRand.x * 3.7);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    if (size < 0.003) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // gone (between its two stages, or not in this one)
      gl_PointSize = 0.0;
      return;
    }
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(size * uPointScale / -mv.z, 1.5);

    float d = -mv.z;
    vFog = 1.0 - exp(-uFogDensity * uFogDensity * d * d);   // like Unity's exponential-squared fog
    vInner = uInner[t];
    vOuter = uOuter[t];
    vFlat  = uFlat[t];
    vPhase = aRand.x;
  }
`;

const CELL_FRAGMENT = /* glsl */ `
  uniform vec3  uFogColor;
  uniform vec3  uLightDir;     // view space, normalised
  uniform float uBrightness;

  varying vec3  vInner;
  varying vec3  vOuter;
  varying float vFlat;
  varying float vPhase;
  varying float vFog;

  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    q.y = -q.y;
    q.y /= vFlat;                       // red blood cells are flat discs, seen at an angle
    float r2 = dot(q, q);
    if (r2 > 1.0) discard;

    vec3 n = vec3(q, sqrt(1.0 - r2));

    // A little membrane texture, so cells don't read as perfect balls.
    float bumps = sin(q.x * 9.0 + vPhase * 40.0) * sin(q.y * 8.0 + vPhase * 23.0);
    n = normalize(n + vec3(q * 0.08 * bumps, 0.0));

    // Nucleus showing through a translucent outer membrane (the game's Inner / Outer materials).
    vec3 base = mix(vOuter, vInner, 0.55 * smoothstep(0.7, 0.05, r2));
    if (vFlat < 0.99) base *= mix(0.65, 1.0, smoothstep(0.05, 0.5, r2));   // RBC's paler dip

    float diffuse = max(dot(n, uLightDir), 0.0);
    float rim     = pow(1.0 - n.z, 2.5);
    float spec    = pow(max(dot(reflect(-uLightDir, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);

    vec3 col = base * (0.18 + 0.70 * diffuse) + vOuter * rim * 0.40 + vec3(1.0, 0.95, 0.85) * spec * 0.10;
    col *= uBrightness;

    col = mix(col, uFogColor, vFog);
    // Soft edge — with alphaToCoverage this antialiases without sorting the sprites.
    float edge = fwidth(r2) * 1.5;
    gl_FragColor = vec4(col, 1.0 - smoothstep(1.0 - edge, 1.0, r2));
    #include <colorspace_fragment>
  }
`;

// Soft dark disc under the cells, so the plane reads as a surface rather than floating dots.
const PLANE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uFogColor;
  varying vec2 vUv;
  void main() {
    float r = length(vUv * 2.0 - 1.0);
    float a = smoothstep(1.0, 0.7, r);
    gl_FragColor = vec4(mix(uFogColor, uColor, a), 1.0);
    #include <colorspace_fragment>
  }
`;

const PLANE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

// ── Setup ────────────────────────────────────────────────────────────────────

export function initCellsBackground(container, options = {}) {
  // Also accepts just the options: initCellsBackground({ parallaxOrbit: 0.2 }).
  if (container && !(container instanceof Element)) {
    options = container;
    container = null;
  }
  const opts = { ...DEFAULTS, ...options };

  // Canvas: fixed behind the page, or filling the given container.
  const host = container || document.body;
  const fixed = !container;
  const wrapper = document.createElement("div");
  wrapper.setAttribute("aria-hidden", "true");
  Object.assign(wrapper.style, {
    position: fixed ? "fixed" : "absolute",
    inset: "0",
    zIndex: fixed ? "-1" : "0",
    pointerEvents: "none",
    overflow: "hidden",
    background: opts.background,   // shown until (or if) WebGL starts
  });
  if (!fixed && getComputedStyle(host).position === "static") host.style.position = "relative";
  host.prepend(wrapper);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "low-power" });
  } catch (e) {
    console.warn("cells-background: WebGL unavailable, keeping the plain background.", e);
    return { settings: opts, progress: 0, setProgress() {}, setPaused() {}, dispose() { wrapper.remove(); } };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.maxPixelRatio));
  Object.assign(renderer.domElement.style, { width: "100%", height: "100%", display: "block" });
  wrapper.appendChild(renderer.domElement);

  if (opts.vignette) {
    const v = document.createElement("div");
    Object.assign(v.style, {
      position: "absolute", inset: "0", pointerEvents: "none",
      background: "radial-gradient(ellipse at 50% 55%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.55) 100%)",
    });
    wrapper.appendChild(v);
  }

  const scene = new THREE.Scene();
  const bg = new THREE.Color(opts.background);
  scene.background = bg;

  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 0.5, 400);
  const lookAt = new THREE.Vector3(0, CAMERA.lookAtY, 0);

  // ── Cells ──
  // One point per slot of the game's data: a cell in stage 1, stage 2 or both (see export_cells.py).
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  const density = opts.density === "auto" ? (small ? 0.7 : 1) : THREE.MathUtils.clamp(+opts.density || 0, 0, 1);
  const count = Math.max(1, Math.floor(CELL_COUNT * density));

  const bytes = Uint8Array.from(atob(DATA), (c) => c.charCodeAt(0));
  const xz = new Int16Array(bytes.buffer, 0, CELL_COUNT * 2);
  const dxz = new Int8Array(bytes.buffer, CELL_COUNT * 4, CELL_COUNT * 2);
  const type0 = bytes.subarray(CELL_COUNT * 6, CELL_COUNT * 7);
  const type1 = bytes.subarray(CELL_COUNT * 7, CELL_COUNT * 8);

  const position = new Float32Array(count * 3);
  const delta = new Float32Array(count * 2);
  const types = new Float32Array(count * 2);
  const rand = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    position[i * 3] = xz[i * 2] * QUANT;
    position[i * 3 + 2] = xz[i * 2 + 1] * QUANT;
    delta[i * 2] = dxz[i * 2] * DELTA_QUANT;
    delta[i * 2 + 1] = dxz[i * 2 + 1] * DELTA_QUANT;
    types[i * 2] = type0[i] < TYPES.length ? type0[i] : NONE;
    types[i * 2 + 1] = type1[i] < TYPES.length ? type1[i] : NONE;
    rand[i * 2] = fract(i * 0.7548776 + 0.3);   // motion phase
    rand[i * 2 + 1] = fract(i * 0.5698403 + 0.1); // when it changes during the transition
  }

  const cellGeo = new THREE.BufferGeometry();
  cellGeo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  cellGeo.setAttribute("aDelta", new THREE.BufferAttribute(delta, 2));
  cellGeo.setAttribute("aTypes", new THREE.BufferAttribute(types, 2));
  cellGeo.setAttribute("aRand", new THREE.BufferAttribute(rand, 2));

  const toVec3 = (hex) => { const c = new THREE.Color(hex); return new THREE.Vector3(c.r, c.g, c.b); };
  const cellUniforms = {
    uInner: { value: TYPES.map((t) => toVec3(t.inner)) },
    uOuter: { value: TYPES.map((t) => toVec3(t.outer)) },
    uSize: { value: TYPES.map((t) => t.size) },
    uFlat: { value: TYPES.map((t) => t.flat || 1) },
    uTime: { value: 0 },
    uMotion: { value: opts.cellMotion ? 1 : 0 },
    uProgress: { value: 0 },
    uSpread: { value: opts.transitionSpread },
    uChaos: { value: opts.transitionChaos },
    uOffset0: { value: new THREE.Vector2() },
    uOffset1: { value: new THREE.Vector2() },
    uPointScale: { value: 1 },
    uFogDensity: { value: opts.fogDensity },
    uFogColor: { value: new THREE.Color(opts.fogColor) },
    uLightDir: { value: new THREE.Vector3() },
    uBrightness: { value: opts.brightness },
  };
  const cellMat = new THREE.ShaderMaterial({
    vertexShader: CELL_VERTEX,
    fragmentShader: CELL_FRAGMENT,
    uniforms: cellUniforms,
    alphaToCoverage: true,
  });
  const cells = new THREE.Points(cellGeo, cellMat);
  cells.frustumCulled = false;   // positions move in the shader; the plane is always in view anyway
  scene.add(cells);

  // ── Plane ──
  const planeMat = new THREE.ShaderMaterial({
    vertexShader: PLANE_VERTEX,
    fragmentShader: PLANE_FRAGMENT,
    uniforms: { uColor: { value: new THREE.Color("#2b0a0b") }, uFogColor: { value: bg } },
    depthWrite: false,
  });
  const plane = new THREE.Mesh(new THREE.CircleGeometry(PLANE_RADIUS * 1.25, 96), planeMat);
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -0.25;
  plane.renderOrder = -1;
  scene.add(plane);

  const disposables = [cellGeo, cellMat, plane.geometry, planeMat];

  // Warm key light from the upper left, like the game's directional light.
  const lightWorld = new THREE.Vector3(-0.45, 0.8, 0.4).normalize();

  // ── Sizing ──
  function resize() {
    const w = wrapper.clientWidth || window.innerWidth;
    const h = wrapper.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Portrait screens: pull back a little so more of the plane fits across (still cropped at the
    // sides — it's a background — but the cells don't get huge).
    camera.userData.distanceScale = THREE.MathUtils.clamp(0.6 / camera.aspect, 1, 1.2);
    camera.updateProjectionMatrix();
    const pointScale = (h * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    cellUniforms.uPointScale.value = pointScale;
    if (!looping()) renderStill();
  }

  // ── Parallax ──
  // Pointer position, -1..1 from the centre of the window (+x right, +y down), and the eased value
  // the camera follows.
  const pointer = new THREE.Vector2();
  const pointerEased = new THREE.Vector2();
  function onPointerMove(e) {
    pointer.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  }
  function onPointerLeave() {
    if (opts.parallaxReturnOnLeave) pointer.set(0, 0);
  }
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", onPointerLeave);
  window.addEventListener("blur", onPointerLeave);

  // Where a stage's circle of cells is moved to: centred (if Center Stages), plus its own offset.
  function stageOffset(stage, out) {
    const nudge = (stage === 0 ? opts.stage1Offset : opts.stage2Offset) || [0, 0];
    const centre = opts.centerStages ? STAGE_CENTERS[stage] : [0, 0];
    return out.set((+nudge[0] || 0) - centre[0], (+nudge[1] || 0) - centre[1]);
  }

  // ── Transition progress ──
  let manualProgress = 0;
  let progress = 0;   // eased, what's drawn

  function targetProgress() {
    if (!opts.scrollTransition) return THREE.MathUtils.clamp(manualProgress, 0, 1);
    const doc = document.documentElement;
    const scrollable = doc.scrollHeight - window.innerHeight;
    if (scrollable <= 0) return 0;
    const f = window.scrollY / scrollable;
    const span = Math.max(opts.transitionEnd - opts.transitionStart, 1e-3);
    return THREE.MathUtils.clamp((f - opts.transitionStart) / span, 0, 1);
  }
  function onScroll() {
    if (!looping()) renderStill();   // reduced motion / paused: still follow the scroll
  }
  window.addEventListener("scroll", onScroll, { passive: true });

  const motionQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  let reducedMotion = !!(opts.respectReducedMotion && motionQuery && motionQuery.matches);

  // ── Loop ──
  let paused = false;
  let rafId = 0;
  let lastTime = 0;
  let prevRenderTime = -1;
  const looping = () => !paused && !reducedMotion;

  function render(time, snap = false) {
    const t = time / 1000;
    const dt = prevRenderTime < 0 ? 0 : THREE.MathUtils.clamp((time - prevRenderTime) / 1000, 0, 0.1);
    prevRenderTime = time;
    // Frame-rate independent easing, so it feels the same at 30 or 144 fps.
    const ease = (seconds) => (snap || seconds <= 0 ? 1 : 1 - Math.exp(-dt / seconds));

    // Transition.
    progress += (targetProgress() - progress) * ease(opts.transitionSmoothing);
    cellUniforms.uProgress.value = progress;
    cellUniforms.uSpread.value = opts.transitionSpread;
    cellUniforms.uChaos.value = reducedMotion ? 0 : opts.transitionChaos;
    stageOffset(0, cellUniforms.uOffset0.value);
    stageOffset(1, cellUniforms.uOffset1.value);
    // The dark disc under the cells follows the plane between the two stages' positions.
    plane.position.x = THREE.MathUtils.lerp(cellUniforms.uOffset0.value.x, cellUniforms.uOffset1.value.x, progress);
    plane.position.z = THREE.MathUtils.lerp(cellUniforms.uOffset0.value.y, cellUniforms.uOffset1.value.y, progress);
    cellUniforms.uTime.value = t;

    // Camera: slow orbit, plus parallax towards the pointer.
    pointerEased.lerp(opts.parallax ? pointer : ZERO, ease(opts.parallaxSmoothing));
    const sign = opts.parallaxInvert ? -1 : 1;
    const angle = t * opts.orbitSpeed + sign * pointerEased.x * opts.parallaxOrbit;
    const height = CAMERA.height - sign * pointerEased.y * opts.parallaxHeight;   // pointer up → camera up
    const dist = CAMERA.distance * (camera.userData.distanceScale || 1);
    camera.position.set(Math.sin(angle) * dist, height, Math.cos(angle) * dist);
    camera.lookAt(lookAt);
    camera.updateMatrixWorld();

    cellUniforms.uLightDir.value.copy(lightWorld).transformDirection(camera.matrixWorldInverse);
    renderer.render(scene, camera);
  }

  // A single frame outside the animation loop (reduced motion, paused): no easing, and a fixed
  // moment in time (not the cells' rest phase) with reduced motion.
  function renderStill() {
    render(reducedMotion ? 12000 : lastTime, true);
  }

  function frame(time) {
    rafId = 0;
    lastTime = time;
    render(time);
    if (looping()) rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(wrapper); else window.addEventListener("resize", resize);

  function onMotionChange() {
    reducedMotion = !!(opts.respectReducedMotion && motionQuery.matches);
    if (looping()) start(); else renderStill();
  }
  if (motionQuery && motionQuery.addEventListener) motionQuery.addEventListener("change", onMotionChange);

  // Start at the page's current scroll position (e.g. after a reload halfway down), not eased in.
  progress = targetProgress();
  resize();
  if (looping()) start(); else renderStill();

  return {
    settings: opts,
    /** The transition's current progress: 0 = stage 1, 1 = stage 2. */
    get progress() { return progress; },
    /** Sets the transition's progress (0–1) when Scroll Transition is off. */
    setProgress(value) {
      manualProgress = +value || 0;
      if (!looping()) renderStill();
    },
    setPaused(value) {
      paused = !!value;
      if (looping()) start(); else renderStill();
    },
    dispose() {
      paused = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (ro) ro.disconnect(); else window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("blur", onPointerLeave);
      window.removeEventListener("scroll", onScroll);
      if (motionQuery && motionQuery.removeEventListener) motionQuery.removeEventListener("change", onMotionChange);
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      wrapper.remove();
    },
  };
}

const ZERO = new THREE.Vector2();

function fract(x) {
  return x - Math.floor(x);
}
