import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { Layout } from "../../shared/types.ts";
import type { Character, OfficeEngine } from "./engine.ts";
import type { Frame } from "./characters.ts";

const GradeShader = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, aspect: { value: 1.6 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time; uniform float aspect; varying vec2 vUv;
    float rand(vec2 c){ return fract(sin(dot(c, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = (vUv - 0.5) * vec2(aspect, 1.0);
      float v = smoothstep(1.15, 0.35, length(d));
      c.rgb *= mix(0.62, 1.0, v);
      c.rgb = mix(c.rgb, c.rgb * vec3(1.06, 0.98, 0.9), 0.5);
      c.rgb += (rand(vUv * 900.0 + time) - 0.5) * 0.025;
      gl_FragColor = c;
    }`,
};

function radialTexture(stops: [number, string][], size = 128) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function rayTexture() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 256;
  const g = c.getContext("2d")!;
  const v = g.createLinearGradient(0, 0, 0, 256);
  v.addColorStop(0, "rgba(255,226,160,0.9)");
  v.addColorStop(0.7, "rgba(255,200,120,0.35)");
  v.addColorStop(1, "rgba(255,190,110,0)");
  g.fillStyle = v;
  g.fillRect(0, 0, 64, 256);
  g.globalCompositeOperation = "destination-in";
  const h = g.createLinearGradient(0, 0, 64, 0);
  h.addColorStop(0, "rgba(0,0,0,0)");
  h.addColorStop(0.5, "rgba(0,0,0,1)");
  h.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = h;
  g.fillRect(0, 0, 64, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface CharView {
  group: THREE.Group;
  body: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  ring: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  chair: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  chairTex: THREE.Texture | null;
  pose: string;
}

interface ScreenView {
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  glow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  level: number;
  line: number;
}

interface Particle {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  vx: number;
  vy: number;
  life: number;
  max: number;
  spin: number;
  tx?: number;
  ty?: number;
  sx?: number;
  sy?: number;
}

const plane = new THREE.PlaneGeometry(1, 1);

export class ThreeOffice {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.OrthographicCamera;
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  grade: ShaderPass;
  bgTex: THREE.Texture | null = null;
  bgMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  layoutKey = "";
  chars = new Map<string, CharView>();
  screens = new Map<string, ScreenView>();
  lights: { mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; phase: number }[] = [];
  rays: { mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; phase: number }[] = [];
  dust: THREE.Points;
  dustSeed: Float32Array;
  board: { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; text: string } | null = null;
  particles: Particle[] = [];
  glowTex = radialTexture([[0, "rgba(255,210,130,1)"], [0.25, "rgba(255,170,80,0.45)"], [1, "rgba(255,150,60,0)"]]);
  softTex = radialTexture([[0, "rgba(255,255,255,1)"], [0.5, "rgba(255,255,255,0.35)"], [1, "rgba(255,255,255,0)"]], 64);
  shadowTex = radialTexture([[0, "rgba(20,10,8,0.55)"], [0.6, "rgba(20,10,8,0.25)"], [1, "rgba(20,10,8,0)"]], 64);
  ringTex = radialTexture([[0, "rgba(255,255,255,0)"], [0.62, "rgba(255,255,255,0)"], [0.78, "rgba(255,255,255,0.9)"], [1, "rgba(255,255,255,0)"]], 128);
  rayTex = rayTexture();
  bodyTextures = new Map<string, THREE.CanvasTexture>();
  hovered: string | null = null;
  picked: string | null = null;
  width = 1672;
  height = 940;

  constructor(
    public canvas: HTMLCanvasElement,
    public engine: OfficeEngine,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color("#140d0a");
    this.camera = new THREE.OrthographicCamera(0, 1, 0, -1, -10, 10);
    this.bgMesh = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false }));
    this.bgMesh.renderOrder = 0;
    this.scene.add(this.bgMesh);

    const n = 140;
    const pos = new Float32Array(n * 3);
    this.dustSeed = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.dustSeed[i * 3] = Math.random();
      this.dustSeed[i * 3 + 1] = Math.random();
      this.dustSeed[i * 3 + 2] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(
      g,
      new THREE.PointsMaterial({ size: 3, map: this.softTex, color: "#ffe2a8", transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, sizeAttenuation: false }),
    );
    this.dust.renderOrder = 5000;
    this.scene.add(this.dust);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.55, 0.55, 0.78);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
  }

  resize(w: number, h: number) {
    if (w < 2 || h < 2) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.grade.uniforms.aspect.value = w / h;
  }

  private setLayout(L: Layout) {
    const key = JSON.stringify(L);
    if (key === this.layoutKey) return;
    const bgChanged = !this.layoutKey || JSON.parse(this.layoutKey).background !== L.background;
    this.layoutKey = key;
    this.width = L.width;
    this.height = L.height;
    Object.assign(this.camera, { left: 0, right: L.width, top: 0, bottom: -L.height });
    this.camera.updateProjectionMatrix();
    this.bgMesh.scale.set(L.width, L.height, 1);
    this.bgMesh.position.set(L.width / 2, -L.height / 2, 0);
    if (bgChanged) {
      new THREE.TextureLoader().load(L.background, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        this.bgTex = t;
        this.bgMesh.material.map = t;
        this.bgMesh.material.needsUpdate = true;
        for (const v of this.chars.values()) this.attachChairTexture(v);
      });
    }

    for (const l of this.lights) this.scene.remove(l.mesh);
    this.lights = (L.lights ?? []).map((p, i) => {
      const r = L.height * 0.36;
      const m = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: this.glowTex, transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, opacity: 0.55 }));
      m.scale.set(r, r, 1);
      m.position.set(p.x, -p.y, 0);
      m.renderOrder = 4000;
      this.scene.add(m);
      return { mesh: m, phase: i * 1.7 };
    });

    for (const r of this.rays) this.scene.remove(r.mesh);
    this.rays = [0, 1, 2, 3].map((i) => {
      const m = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: this.rayTex, transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, opacity: 0.18 }));
      const h = L.height * 0.78;
      m.scale.set(L.width * (0.05 + i * 0.012), h, 1);
      m.rotation.z = 0.78 + i * 0.05;
      m.position.set(L.width * (0.12 + i * 0.045), -L.height * (0.42 + i * 0.03), 0);
      m.renderOrder = 4100;
      this.scene.add(m);
      return { mesh: m, phase: i * 2.1 };
    });

    for (const s of this.screens.values()) this.scene.remove(s.mesh, s.glow);
    this.screens.clear();

    if (this.board) this.scene.remove(this.board.mesh);
    this.board = null;
    if (L.board) {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = Math.round((640 * L.board.h) / L.board.w);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
      mesh.scale.set(L.board.w, L.board.h, 1);
      mesh.position.set(L.board.x + L.board.w / 2, -(L.board.y + L.board.h / 2), 0);
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      this.board = { canvas, tex, mesh, text: "\u0000" };
    }
  }

  private attachChairTexture(v: CharView) {
    if (!this.bgTex) return;
    v.chairTex?.dispose();
    const t = this.bgTex.clone();
    t.needsUpdate = true;
    v.chairTex = t;
    v.chair.material.map = t;
    v.chair.material.needsUpdate = true;
  }

  private bodyTexture(f: Frame) {
    let t = this.bodyTextures.get(f.key);
    if (!t) {
      t = new THREE.CanvasTexture(f.canvas);
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.colorSpace = THREE.SRGBColorSpace;
      if (this.bodyTextures.size > 600) {
        for (const old of this.bodyTextures.values()) old.dispose();
        this.bodyTextures.clear();
      }
      this.bodyTextures.set(f.key, t);
    }
    return t;
  }

  private view(c: Character): CharView {
    let v = this.chars.get(c.id);
    if (v) return v;
    const group = new THREE.Group();
    const mat = (o: THREE.MeshBasicMaterialParameters) => new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, ...o });
    const shadow = new THREE.Mesh(plane, mat({ map: this.shadowTex }));
    const ring = new THREE.Mesh(plane, mat({ map: this.ringTex, blending: THREE.AdditiveBlending, opacity: 0 }));
    const body = new THREE.Mesh(plane, mat({ alphaTest: 0.5 }));
    const chair = new THREE.Mesh(plane, mat({}));
    group.add(shadow, ring, body, chair);
    this.scene.add(group);
    v = { group, body, shadow, ring, chair, chairTex: null, pose: "" };
    this.attachChairTexture(v);
    this.chars.set(c.id, v);
    return v;
  }

  private screenFor(seatIdx: number, c: Character): ScreenView {
    const key = String(seatIdx);
    let s = this.screens.get(key);
    if (s) return s;
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 52;
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, opacity: 0 }));
    const glow = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: this.softTex, color: "#7fb4ff", transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, opacity: 0 }));
    const sc = this.engine.scaleAt(c.y);
    const seat = this.engine.seatOf(c.agent);
    const w = 25 * sc;
    const h = 13 * sc;
    mesh.scale.set(w, h, 1);
    mesh.position.set(seat.x, -(seat.y - 38 * sc + h / 2), 0);
    glow.scale.set(w * 2.6, h * 3.4, 1);
    glow.position.copy(mesh.position);
    mesh.renderOrder = 2;
    glow.renderOrder = 3;
    this.scene.add(mesh, glow);
    s = { canvas, tex, mesh, glow, level: 0, line: 0 };
    this.screens.set(key, s);
    return s;
  }

  private paintScreen(s: ScreenView, t: number) {
    const g = s.canvas.getContext("2d")!;
    const W = s.canvas.width;
    const H = s.canvas.height;
    g.fillStyle = "#0a1020";
    g.fillRect(0, 0, W, H);
    const colors = ["#7be08a", "#5fc9e8", "#f2c14e", "#e86fa8", "#c8c8d8", "#9b7bf2"];
    const lh = 5;
    const scroll = t * 22;
    const first = Math.floor(scroll / lh);
    for (let i = 0; i < H / lh + 2; i++) {
      const n = first + i;
      const y = H - ((scroll % lh) + i * lh);
      const seed = Math.abs(Math.sin(n * 91.7) * 1000) % 1;
      const indent = (Math.abs(n) % 4) * 6;
      g.fillStyle = colors[Math.abs(n) % colors.length];
      g.fillRect(4 + indent, y, (W - 12 - indent) * (0.25 + seed * 0.7), 3);
    }
    if (Math.floor(t * 2) % 2 === 0) {
      g.fillStyle = "#ffffff";
      g.fillRect(4, H - 7, 4, 4);
    }
    s.tex.needsUpdate = true;
  }

  private paintBoard() {
    const b = this.board;
    if (!b) return;
    const text = `${this.engine.boardTitle}\u0001${this.engine.boardText}`;
    if (text === b.text) return;
    b.text = text;
    const g = b.canvas.getContext("2d")!;
    const W = b.canvas.width;
    const H = b.canvas.height;
    g.clearRect(0, 0, W, H);
    if (!this.engine.boardText) {
      b.tex.needsUpdate = true;
      return;
    }
    g.fillStyle = "#2f3b8f";
    g.font = `bold ${Math.round(H * 0.15)}px Silkscreen, monospace`;
    g.fillText(this.engine.boardTitle, W * 0.05, H * 0.2);
    g.fillStyle = "#e0564d";
    g.fillRect(W * 0.05, H * 0.25, W * 0.18, 3);
    const size = Math.round(H * 0.13);
    g.fillStyle = "#1f1a2b";
    g.font = `${size}px "Pixelify Sans", monospace`;
    const lines: string[] = [];
    let cur = "";
    for (const w of this.engine.boardText.split(/\s+/)) {
      const next = cur ? `${cur} ${w}` : w;
      if (g.measureText(next).width > W * 0.9) {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) lines.push(cur);
    const max = Math.floor((H * 0.66) / (size * 1.25));
    lines.slice(0, max).forEach((l, i) => {
      const txt = i === max - 1 && lines.length > max ? `${l.slice(0, -2)}…` : l;
      g.fillText(txt, W * 0.05, H * 0.42 + i * size * 1.25);
    });
    b.tex.needsUpdate = true;
  }

  private spawn(fx: OfficeEngine["effects"][number]) {
    const mk = (color: string, size: number, blend = true) => {
      const m = new THREE.Mesh(
        plane,
        new THREE.MeshBasicMaterial({ map: this.softTex, color, transparent: true, depthTest: false, depthWrite: false, blending: blend ? THREE.AdditiveBlending : THREE.NormalBlending }),
      );
      m.scale.set(size, size, 1);
      m.renderOrder = 6000;
      this.scene.add(m);
      return m;
    };
    if (fx.kind === "sparkle") {
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * Math.PI * 2;
        const sp = 60 + Math.random() * 120;
        const m = mk(i % 3 === 0 ? "#fff3c4" : fx.color, 6 + Math.random() * 8);
        m.position.set(fx.x, -fx.y, 0);
        this.particles.push({ mesh: m, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 80, life: 0, max: 0.9 + Math.random() * 0.5, spin: 0 });
      }
    } else if (fx.kind === "paper" && fx.tx !== undefined && fx.ty !== undefined) {
      const c = document.createElement("canvas");
      c.width = 10;
      c.height = 12;
      const g = c.getContext("2d")!;
      g.fillStyle = "#1a1320";
      g.fillRect(0, 0, 10, 12);
      g.fillStyle = "#fffaf0";
      g.fillRect(1, 1, 8, 10);
      g.fillStyle = "#9b93ad";
      for (let y = 3; y < 10; y += 2) g.fillRect(2, y, 6, 1);
      const t = new THREE.CanvasTexture(c);
      t.magFilter = THREE.NearestFilter;
      t.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false }));
      m.scale.set(30, 36, 1);
      m.renderOrder = 6001;
      m.position.set(fx.x, -fx.y, 0);
      this.scene.add(m);
      this.particles.push({ mesh: m, vx: 0, vy: 0, life: 0, max: 0.75, spin: 6, sx: fx.x, sy: fx.y, tx: fx.tx, ty: fx.ty });
    }
  }

  render(dt: number) {
    const E = this.engine;
    if (!E.layout) return;
    this.setLayout(E.layout);
    const t = E.now;

    for (const fx of E.effects.splice(0)) this.spawn(fx);

    const alive = new Set<string>();
    for (const c of E.chars.values()) {
      alive.add(c.id);
      const v = this.view(c);
      const r = E.spriteRect(c);
      const base = 100 + c.y;
      const tex = this.bodyTexture(r.frame);
      if (r.frame.key !== v.pose) {
        v.body.material.map = tex;
        v.body.material.needsUpdate = true;
        v.pose = r.frame.key;
      }
      const hot = this.hovered === c.id || this.picked === c.id;
      v.body.material.color.setScalar(hot ? 1.18 : 1);
      v.body.scale.set(r.frame.flip ? -r.w : r.w, r.h, 1);
      v.body.position.set(r.x + r.w / 2, -(r.y + r.h / 2), 0);
      v.body.renderOrder = base + 0.2;

      const sw = r.s * (c.seated ? 22 : 13);
      v.shadow.scale.set(sw, sw * 0.32, 1);
      v.shadow.position.set(c.x, -(c.seated ? c.y + 9 * r.s : c.y), 0);
      v.shadow.renderOrder = base;
      v.shadow.visible = !c.seated;

      const ringW = r.s * (c.seated ? 26 : 16);
      v.ring.scale.set(ringW, ringW * 0.34, 1);
      v.ring.position.set(c.x, -(c.seated ? c.y + 10 * r.s : c.y), 0);
      v.ring.renderOrder = base + 0.1;
      v.ring.material.color.set(c.agent.appearance.shirt);
      const ringTarget = this.picked === c.id ? 0.95 : this.hovered === c.id ? 0.5 : c.working ? 0.35 + 0.2 * Math.sin(t * 5) : 0;
      v.ring.material.opacity += (ringTarget - v.ring.material.opacity) * Math.min(1, dt * 10);

      v.chair.visible = c.seated && !!v.chairTex;
      if (v.chair.visible && v.chairTex) {
        const cx = c.x - 12 * r.s;
        const cy = c.y - 12.4 * r.s;
        const cw = 24 * r.s;
        const ch = 17.5 * r.s;
        v.chairTex.repeat.set(cw / this.width, ch / this.height);
        v.chairTex.offset.set(cx / this.width, 1 - (cy + ch) / this.height);
        v.chair.scale.set(cw, ch, 1);
        v.chair.position.set(cx + cw / 2, -(cy + ch / 2), 0);
        v.chair.renderOrder = base + 0.3;
      }

      if (c.seated) {
        const s = this.screenFor(c.agent.seat, c);
        const target = c.working ? 1 : 0;
        s.level += (target - s.level) * Math.min(1, dt * 4);
        s.mesh.material.opacity = s.level * 0.95;
        s.glow.material.opacity = s.level * (0.35 + 0.08 * Math.sin(t * 9));
        if (s.level > 0.02) this.paintScreen(s, t);
      }
    }
    for (const [id, v] of this.chars) {
      if (alive.has(id)) continue;
      this.scene.remove(v.group);
      v.chairTex?.dispose();
      this.chars.delete(id);
    }
    for (const [key, s] of this.screens) {
      const used = [...E.chars.values()].some((c) => c.seated && String(c.agent.seat) === key && c.working);
      if (!used) {
        s.level += (0 - s.level) * Math.min(1, dt * 4);
        s.mesh.material.opacity = s.level * 0.95;
        s.glow.material.opacity = s.level * 0.35;
      }
    }

    for (const l of this.lights) {
      const flick = 0.82 + 0.12 * Math.sin(t * 2.6 + l.phase) + (Math.sin(t * 23 + l.phase * 5) > 0.985 ? -0.35 : 0);
      l.mesh.material.opacity = 0.55 * flick;
    }
    for (const r of this.rays) r.mesh.material.opacity = 0.13 + 0.06 * Math.sin(t * 0.7 + r.phase);

    const pos = this.dust.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const a = this.dustSeed[i * 3];
      const b = this.dustSeed[i * 3 + 1];
      const sp = this.dustSeed[i * 3 + 2];
      const u = (a + t * 0.01 * (0.5 + sp)) % 1;
      const along = u * this.height * 0.85;
      const x = this.width * 0.04 + along * 0.62 + b * this.width * 0.22 + Math.sin(t * 0.6 + a * 20) * 10;
      const y = this.height * 0.08 + along + Math.cos(t * 0.5 + b * 30) * 8;
      pos.setXYZ(i, x, -y, 0);
    }
    pos.needsUpdate = true;
    (this.dust.material as THREE.PointsMaterial).size = Math.max(2, (this.renderer.domElement.width / this.width) * 3.2);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      const k = p.life / p.max;
      if (p.tx !== undefined && p.ty !== undefined && p.sx !== undefined && p.sy !== undefined) {
        const e = 1 - Math.pow(1 - Math.min(1, k), 3);
        const x = p.sx + (p.tx - p.sx) * e;
        const y = p.sy + (p.ty - p.sy) * e - Math.sin(Math.min(1, k) * Math.PI) * 70;
        p.mesh.position.set(x, -y, 0);
        p.mesh.rotation.z = Math.sin(k * p.spin) * 0.4;
        p.mesh.material.opacity = k > 0.85 ? (1 - k) / 0.15 : 1;
      } else {
        p.vy -= 260 * dt;
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.material.opacity = Math.max(0, 1 - k);
      }
      if (k >= 1) {
        this.scene.remove(p.mesh);
        p.mesh.material.map?.dispose();
        p.mesh.material.dispose();
        this.particles.splice(i, 1);
      }
    }

    this.paintBoard();
    this.grade.uniforms.time.value = t;
    this.composer.render(dt);
  }

  dispose() {
    for (const t of this.bodyTextures.values()) t.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
