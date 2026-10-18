import type { Agent } from "../../shared/types.ts";
import { CHIBI_H, chibiCanvas } from "./sprites-chibi.ts";
import type { Pose } from "./sprites.ts";

export interface Frame {
  canvas: HTMLCanvasElement;
  key: string;
  w: number;
  h: number;
  shoulder: number;
  flip: boolean;
  bob: number;
}

interface LookFrames {
  front: HTMLCanvasElement;
  walk: HTMLCanvasElement;
  back: HTMLCanvasElement;
}

type LookState = { status: "loading" } | { status: "ready"; frames: LookFrames } | { status: "error" };

const looks = new Map<string, LookState>();
const AI_HEIGHT = 41;
const TARGET_PX = 72;

export function isKeyColor(r: number, g: number, b: number, a: number): boolean {
  if (a < 128) return true;
  return r > 120 && b > 120 && Math.min(r, b) - g > 85;
}

export function findSegments(counts: number[], want = 3, minCount = 3, mergeGap = 8): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  counts.forEach((n, x) => {
    if (n >= minCount && start < 0) start = x;
    if (n < minCount && start >= 0) {
      runs.push([start, x - 1]);
      start = -1;
    }
  });
  if (start >= 0) runs.push([start, counts.length - 1]);
  const merged: [number, number][] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] <= mergeGap) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  const widest = [...merged].sort((a, b) => b[1] - b[0] - (a[1] - a[0])).slice(0, want);
  if (widest.length < want) {
    const w = counts.length / want;
    return Array.from({ length: want }, (_, i) => [Math.round(i * w), Math.round((i + 1) * w) - 1] as [number, number]);
  }
  return widest.sort((a, b) => a[0] - b[0]);
}

function sliceSheet(img: HTMLImageElement): LookFrames {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const src = document.createElement("canvas");
  src.width = W;
  src.height = H;
  const sctx = src.getContext("2d", { willReadFrequently: true })!;
  sctx.drawImage(img, 0, 0);
  const data = sctx.getImageData(0, 0, W, H).data;
  const fg = new Uint8Array(W * H);
  const counts = new Array<number>(W).fill(0);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (!isKeyColor(data[i], data[i + 1], data[i + 2], data[i + 3])) {
        fg[y * W + x] = 1;
        counts[x]++;
      }
    }
  const segs = findSegments(counts);
  const boxes = segs.map(([x0, x1]) => {
    let y0 = H;
    let y1 = 0;
    for (let y = 0; y < H; y++)
      for (let x = x0; x <= x1; x++)
        if (fg[y * W + x]) {
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    return { x0, x1, y0: Math.min(y0, y1), y1 };
  });
  const tallest = Math.max(...boxes.map((b) => b.y1 - b.y0 + 1));
  const scale = TARGET_PX / tallest;
  const out = boxes.map((b) => {
    const bw = b.x1 - b.x0 + 1;
    const bh = b.y1 - b.y0 + 1;
    const cut = document.createElement("canvas");
    cut.width = bw;
    cut.height = bh;
    const cctx = cut.getContext("2d")!;
    const id = cctx.createImageData(bw, bh);
    for (let y = 0; y < bh; y++)
      for (let x = 0; x < bw; x++) {
        const sx = b.x0 + x;
        const sy = b.y0 + y;
        const si = (sy * W + sx) * 4;
        const di = (y * bw + x) * 4;
        if (!fg[sy * W + sx]) continue;
        let r = data[si];
        let g = data[si + 1];
        let bl = data[si + 2];
        if (Math.min(r, bl) - g > 35) {
          r = Math.round(r * 0.35);
          g = Math.round(g * 0.35);
          bl = Math.round(bl * 0.35);
        }
        id.data[di] = r;
        id.data[di + 1] = g;
        id.data[di + 2] = bl;
        id.data[di + 3] = 255;
      }
    cctx.putImageData(id, 0, 0);
    const dw = Math.max(1, Math.round(bw * scale));
    const dh = Math.max(1, Math.round(bh * scale));
    const small = document.createElement("canvas");
    small.width = dw;
    small.height = dh;
    const sm = small.getContext("2d", { willReadFrequently: true })!;
    sm.imageSmoothingEnabled = true;
    sm.imageSmoothingQuality = "high";
    sm.drawImage(cut, 0, 0, dw, dh);
    const px = sm.getImageData(0, 0, dw, dh);
    for (let i = 0; i < px.data.length; i += 4) {
      if (px.data[i + 3] < 110) px.data[i + 3] = 0;
      else {
        const a = px.data[i + 3] / 255;
        px.data[i] = Math.min(255, px.data[i] / a);
        px.data[i + 1] = Math.min(255, px.data[i + 1] / a);
        px.data[i + 2] = Math.min(255, px.data[i + 2] / a);
        px.data[i + 3] = 255;
      }
    }
    sm.putImageData(px, 0, 0);
    return small;
  });
  return { front: out[0], walk: out[1], back: out[2] };
}

function lookState(src: string): LookState {
  let st = looks.get(src);
  if (st) return st;
  st = { status: "loading" };
  looks.set(src, st);
  const img = new Image();
  img.onload = () => {
    try {
      looks.set(src, { status: "ready", frames: sliceSheet(img) });
    } catch {
      looks.set(src, { status: "error" });
    }
  };
  img.onerror = () => looks.set(src, { status: "error" });
  img.src = src;
  return st;
}

export function characterFrame(agent: Agent, pose: Pose): Frame {
  const st = agent.look ? lookState(agent.look.src) : null;
  if (st?.status === "ready") {
    const f = st.frames;
    let canvas = f.front;
    let flip = false;
    let bob = 0;
    let name = "front";
    if (pose.kind === "sit") {
      canvas = f.back;
      name = "back";
      bob = pose.typing === 2 ? 0.6 : 0;
    } else if (pose.dir === "up") {
      canvas = f.back;
      name = "back";
      bob = pose.step === 1 || pose.step === 3 ? -0.8 : 0;
    } else {
      const moving = pose.step === 1 || pose.step === 3;
      canvas = moving ? f.walk : f.front;
      name = moving ? "walk" : "front";
      flip = pose.dir === "left" || (pose.dir === "down" && pose.step === 3);
      bob = moving ? -0.8 : 0;
    }
    const h = AI_HEIGHT;
    return { canvas, key: `${agent.look!.src}#${name}`, w: (h * canvas.width) / canvas.height, h, shoulder: 0.56, flip, bob };
  }
  const canvas = chibiCanvas(agent.appearance, pose);
  return {
    canvas,
    key: JSON.stringify([agent.appearance, pose]),
    w: canvas.width,
    h: CHIBI_H,
    shoulder: 0.58,
    flip: false,
    bob: 0,
  };
}

export function lookStatus(src: string): LookState["status"] {
  return lookState(src).status;
}
