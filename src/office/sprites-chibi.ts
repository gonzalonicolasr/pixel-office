import type { Appearance } from "../../shared/types.ts";
import { type Dir, type Pose, shade } from "./sprites.ts";

export const CHIBI_W = 26;
export const CHIBI_H = 38;

type Px = (string | null)[][];

class P {
  px: Px = Array.from({ length: CHIBI_H }, () => Array<string | null>(CHIBI_W).fill(null));
  constructor(public flip = false) {}
  set(x: number, y: number, c: string | null) {
    const xx = this.flip ? CHIBI_W - 1 - (x + 1) : x + 1;
    const yy = y + 1;
    if (yy >= 0 && yy < CHIBI_H && xx >= 0 && xx < CHIBI_W) this.px[yy][xx] = c;
  }
  rect(x: number, y: number, w: number, h: number, c: string | null) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c);
  }
  row(y: number, x0: number, x1: number, c: string) {
    for (let x = x0; x <= x1; x++) this.set(x, y, c);
  }
  outline() {
    const src = this.px.map((r) => r.slice());
    for (let y = 0; y < CHIBI_H; y++)
      for (let x = 0; x < CHIBI_W; x++) {
        if (src[y][x]) continue;
        const n = src[y + 1]?.[x] ?? src[y]?.[x - 1] ?? src[y]?.[x + 1] ?? src[y - 1]?.[x];
        if (n) this.px[y][x] = shade(n, -0.62);
      }
  }
}

const HEAD_Y = 2;

function headShape(p: P, c: string, x0 = 5, w = 14, h = 14) {
  for (let j = 0; j < h; j++) {
    const inset = j === 0 ? 3 : j === 1 ? 1 : j === h - 1 ? 2 : j === h - 2 ? 1 : 0;
    p.row(HEAD_Y + j, x0 + inset, x0 + w - 1 - inset, c);
  }
}

function face(p: P, a: Appearance, blink: boolean) {
  const skin = a.skin;
  const sk2 = shade(skin, -0.16);
  headShape(p, skin);
  p.rect(16, HEAD_Y + 5, 2, 8, sk2);
  p.row(HEAD_Y + 13, 8, 15, sk2);
  p.set(4, HEAD_Y + 8, skin);
  p.set(4, HEAD_Y + 9, sk2);
  p.set(19, HEAD_Y + 8, sk2);
  p.set(19, HEAD_Y + 9, sk2);
  const ink = "#2a1d2e";
  if (blink) {
    p.row(HEAD_Y + 9, 7, 9, shade(skin, -0.45));
    p.row(HEAD_Y + 9, 14, 16, shade(skin, -0.45));
  } else {
    p.rect(8, HEAD_Y + 7, 2, 3, ink);
    p.rect(14, HEAD_Y + 7, 2, 3, ink);
    p.set(9, HEAD_Y + 7, "#ffffff");
    p.set(15, HEAD_Y + 7, "#ffffff");
    p.set(8, HEAD_Y + 9, "#4b3a5c");
    p.set(14, HEAD_Y + 9, "#4b3a5c");
  }
  const blush = "#ef8f86";
  p.set(7, HEAD_Y + 10, blush);
  p.set(16, HEAD_Y + 10, blush);
  p.row(HEAD_Y + 11, 11, 12, shade(skin, -0.4));
}

function hairFront(p: P, a: Appearance) {
  const h = a.hair;
  const h2 = shade(h, -0.28);
  const h3 = shade(h, 0.28);
  const top = (rows: number) => {
    for (let j = 0; j < rows; j++) {
      const inset = j === 0 ? 3 : j === 1 ? 1 : 0;
      p.row(HEAD_Y + j, 5 + inset, 18 - inset, h);
    }
    p.row(HEAD_Y + 1, 8, 11, h3);
    p.set(7, HEAD_Y + 2, h3);
    p.row(HEAD_Y + rows - 1, 15, 18, h2);
  };
  switch (a.hairStyle) {
    case "bald":
      p.row(HEAD_Y + 1, 8, 10, shade(a.skin, 0.25));
      return;
    case "cap": {
      top(5);
      p.row(HEAD_Y + 5, 4, 19, h2);
      p.row(HEAD_Y + 6, 3, 13, shade(h, -0.4));
      p.set(11, HEAD_Y + 2, "#ffffff");
      p.set(12, HEAD_Y + 2, "#ffffff");
      p.rect(5, HEAD_Y + 7, 1, 2, shade(a.skin, -0.5));
      return;
    }
    case "long":
      top(5);
      p.rect(4, HEAD_Y + 3, 2, 15, h);
      p.rect(18, HEAD_Y + 3, 2, 15, h2);
      p.rect(3, HEAD_Y + 8, 1, 9, h2);
      p.rect(20, HEAD_Y + 8, 1, 9, h2);
      for (let x = 6; x <= 17; x += 3) p.set(x, HEAD_Y + 5, h);
      return;
    case "bun":
      p.rect(9, HEAD_Y - 2, 6, 3, h);
      p.row(HEAD_Y - 2, 10, 11, h3);
      top(4);
      p.rect(5, HEAD_Y + 4, 1, 4, h);
      p.rect(18, HEAD_Y + 4, 1, 4, h2);
      return;
    case "curly": {
      for (let j = -1; j < 6; j++) p.row(HEAD_Y + j, 4, 19, h);
      for (let x = 4; x <= 19; x++) {
        if (x % 3 !== 0) p.set(x, HEAD_Y - 2, h);
        if (x % 3 === 1) p.set(x, HEAD_Y + 6, h2);
      }
      for (let j = 0; j < 8; j++) {
        p.set(j % 2 ? 3 : 4, HEAD_Y + j, h);
        p.set(j % 2 ? 20 : 19, HEAD_Y + j, h2);
      }
      for (const [x, y] of [[6, 0], [9, -1], [12, 1], [15, 0], [7, 3], [11, 3], [17, 2]]) {
        p.set(x, HEAD_Y + y, h3);
        p.set(x + 1, HEAD_Y + y + 1, h2);
      }
      p.rect(4, HEAD_Y + 6, 1, 3, h);
      p.rect(19, HEAD_Y + 6, 1, 3, h2);
      return;
    }
    default:
      top(5);
      p.set(6, HEAD_Y + 5, h);
      p.set(9, HEAD_Y + 5, h);
      p.set(10, HEAD_Y + 5, h);
      p.set(14, HEAD_Y + 5, h2);
      p.rect(5, HEAD_Y + 5, 1, 3, h);
      p.rect(18, HEAD_Y + 5, 1, 3, h2);
  }
}

function hairBack(p: P, a: Appearance) {
  const h = a.hair;
  const h2 = shade(h, -0.28);
  const h3 = shade(h, 0.25);
  if (a.hairStyle === "bald") {
    headShape(p, a.skin);
    p.rect(15, HEAD_Y + 3, 3, 10, shade(a.skin, -0.16));
    p.row(HEAD_Y + 2, 8, 10, shade(a.skin, 0.25));
    return;
  }
  headShape(p, h);
  p.rect(15, HEAD_Y + 4, 3, 9, h2);
  p.row(HEAD_Y + 12, 7, 16, h2);
  p.row(HEAD_Y + 2, 8, 11, h3);
  p.set(7, HEAD_Y + 3, h3);
  p.rect(10, HEAD_Y + 13, 4, 1, shade(a.skin, -0.2));
  if (a.hairStyle === "long") {
    p.rect(5, HEAD_Y + 12, 14, 6, h);
    p.rect(15, HEAD_Y + 12, 4, 6, h2);
  }
  if (a.hairStyle === "bun") {
    p.rect(9, HEAD_Y - 2, 6, 4, h2);
    p.row(HEAD_Y - 2, 10, 12, h);
  }
  if (a.hairStyle === "curly") {
    for (let j = -1; j < 13; j++) p.row(HEAD_Y + j, 4, 19, j > 8 ? h2 : h);
    for (let j = -1; j < 13; j++) {
      p.set(j % 2 ? 3 : 4, HEAD_Y + j, h);
      p.set(j % 2 ? 20 : 19, HEAD_Y + j, h2);
    }
    for (let x = 4; x <= 19; x++) if (x % 3 !== 0) p.set(x, HEAD_Y - 2, h);
    for (const [x, y] of [[6, 1], [10, 0], [14, 2], [8, 5], [12, 6], [16, 5], [7, 9], [13, 10]]) {
      p.set(x, HEAD_Y + y, h3);
      p.set(x + 1, HEAD_Y + y + 1, h2);
    }
  }
  if (a.hairStyle === "cap") {
    p.rect(5, HEAD_Y, 14, 6, shade(h, 0.08));
    p.row(HEAD_Y + 5, 5, 18, h2);
    p.rect(10, HEAD_Y + 4, 4, 1, shade(h, -0.45));
  }
}

function sideHead(p: P, a: Appearance, blink: boolean) {
  const skin = a.skin;
  headShape(p, skin, 6, 13);
  p.set(5, HEAD_Y + 9, skin);
  p.set(5, HEAD_Y + 10, shade(skin, -0.16));
  const h = a.hair;
  const h2 = shade(h, -0.28);
  if (a.hairStyle !== "bald") {
    for (let j = 0; j < 5; j++) p.row(HEAD_Y + j, 6 + (j === 0 ? 3 : j === 1 ? 1 : 0), 18 - (j === 0 ? 2 : 0), h);
    p.rect(12, HEAD_Y + 4, 7, 8, h);
    p.rect(16, HEAD_Y + 6, 3, 6, h2);
    p.row(HEAD_Y + 1, 9, 12, shade(h, 0.28));
    if (a.hairStyle === "long") p.rect(13, HEAD_Y + 11, 6, 7, h2);
    if (a.hairStyle === "bun") p.rect(16, HEAD_Y - 1, 4, 4, h2);
    if (a.hairStyle === "curly") {
      p.rect(9, HEAD_Y - 1, 11, 6, h);
      p.rect(14, HEAD_Y + 4, 6, 9, h2);
    }
    if (a.hairStyle === "cap") p.row(HEAD_Y + 5, 3, 11, shade(h, -0.4));
  }
  p.rect(13, HEAD_Y + 8, 2, 3, skin);
  p.set(13, HEAD_Y + 9, shade(skin, -0.3));
  if (blink) p.row(HEAD_Y + 9, 8, 9, shade(skin, -0.45));
  else {
    p.rect(8, HEAD_Y + 7, 2, 3, "#2a1d2e");
    p.set(8, HEAD_Y + 7, "#ffffff");
  }
  p.set(9, HEAD_Y + 11, "#ef8f86");
}

function accessory(p: P, a: Appearance, view: "front" | "back" | "side") {
  if (a.accessory === "headphones") {
    const band = "#2a2735";
    const cup = "#e0564d";
    if (view === "side") {
      p.row(HEAD_Y - 1, 8, 16, band);
      p.rect(13, HEAD_Y + 6, 3, 4, cup);
      p.set(14, HEAD_Y + 7, shade(cup, 0.3));
    } else {
      p.row(HEAD_Y - 1, 7, 16, band);
      p.set(5, HEAD_Y, band);
      p.set(18, HEAD_Y, band);
      p.rect(3, HEAD_Y + 7, 2, 4, cup);
      p.rect(19, HEAD_Y + 7, 2, 4, cup);
    }
  }
  if (a.accessory === "glasses" && view !== "back") {
    const f = "#2a1d2e";
    if (view === "side") {
      p.row(HEAD_Y + 6, 7, 10, f);
      p.set(7, HEAD_Y + 7, f);
      p.set(10, HEAD_Y + 7, f);
      p.row(HEAD_Y + 10, 7, 10, f);
      p.row(HEAD_Y + 7, 11, 13, f);
      return;
    }
    for (const x0 of [7, 13]) {
      p.row(HEAD_Y + 6, x0, x0 + 3, f);
      p.row(HEAD_Y + 10, x0, x0 + 3, f);
      p.set(x0, HEAD_Y + 7, f);
      p.set(x0, HEAD_Y + 8, f);
      p.set(x0, HEAD_Y + 9, f);
      p.set(x0 + 3, HEAD_Y + 7, f);
      p.set(x0 + 3, HEAD_Y + 8, f);
      p.set(x0 + 3, HEAD_Y + 9, f);
    }
    p.row(HEAD_Y + 7, 11, 12, f);
    for (const x of [8, 9, 14, 15]) p.set(x, HEAD_Y + 7, "#d8ecff");
  }
}

const BODY_Y = HEAD_Y + 14;

function torso(p: P, a: Appearance, view: "front" | "back" | "side", armL: number, armR: number) {
  const s = a.shirt;
  const s2 = shade(s, -0.22);
  const s3 = shade(s, 0.2);
  const skin = a.skin;
  if (view === "side") {
    p.rect(9, BODY_Y, 7, 8, s);
    p.rect(14, BODY_Y, 2, 8, s2);
    p.row(BODY_Y, 9, 13, s3);
    p.rect(11, BODY_Y + 1 + armL, 3, 6, s2);
    p.rect(11, BODY_Y + 7 + armL, 3, 1, skin);
    return;
  }
  p.rect(7, BODY_Y, 10, 8, s);
  p.rect(15, BODY_Y, 2, 8, s2);
  p.rect(7, BODY_Y, 1, 7, s3);
  p.row(BODY_Y + 7, 7, 16, s2);
  if (view === "front") {
    p.row(BODY_Y, 10, 13, shade(skin, -0.12));
    p.set(10, BODY_Y + 1, s3);
    p.set(13, BODY_Y + 1, s3);
  } else p.rect(11, BODY_Y + 1, 2, 6, s2);
  p.rect(5, BODY_Y + 1 + armL, 2, 6, s2);
  p.rect(5, BODY_Y + 7 + armL, 2, 1, skin);
  p.rect(17, BODY_Y + 1 + armR, 2, 6, shade(s, -0.32));
  p.rect(17, BODY_Y + 7 + armR, 2, 1, shade(skin, -0.12));
}

function legs(p: P, a: Appearance, view: "front" | "back" | "side", step: number) {
  const pa = a.pants;
  const pa2 = shade(pa, -0.25);
  const shoe = "#3a2a33";
  const y = BODY_Y + 8;
  if (view === "side") {
    const f = step === 1 ? 2 : step === 3 ? -2 : 0;
    p.rect(10 + f, y, 3, 5, pa);
    p.rect(12 - f, y, 3, 5, pa2);
    p.rect(9 + f, y + 5, 4, 2, shoe);
    p.rect(11 - f, y + 5, 4, 2, shade(shoe, -0.2));
    return;
  }
  const lUp = step === 1 ? 1 : 0;
  const rUp = step === 3 ? 1 : 0;
  p.rect(8, y, 4, 5 - lUp, pa);
  p.rect(12, y, 4, 5 - rUp, pa2);
  p.rect(7, y + 5 - lUp, 5, 2, shoe);
  p.rect(12, y + 5 - rUp, 5, 2, shade(shoe, -0.2));
}

function shifted(dst: P, src: P, dy: number) {
  for (let y = 0; y < CHIBI_H; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= CHIBI_H) continue;
    for (let x = 0; x < CHIBI_W; x++) if (src.px[y][x]) dst.px[ty][x] = src.px[y][x];
  }
}

export function paintChibi(a: Appearance, pose: Pose): Px {
  if (pose.kind === "sit") {
    const out = new P();
    const head = new P();
    hairBack(head, a);
    accessory(head, a, "back");
    const body = new P();
    const t = pose.typing;
    torso(body, a, "back", t === 1 ? -1 : 0, t === 2 ? -1 : 0);
    shifted(out, body, 0);
    shifted(out, head, t === 2 ? 1 : 0);
    out.outline();
    return out.px;
  }
  const dir: Dir = pose.dir;
  const view = dir === "up" ? "back" : dir === "down" ? "front" : "side";
  const flip = dir === "right";
  const out = new P(flip);
  const bob = pose.step === 1 || pose.step === 3 ? -1 : 0;
  const lower = new P(flip);
  legs(lower, a, view, pose.step);
  const upper = new P(flip);
  const swing = pose.step === 1 ? 1 : pose.step === 3 ? -1 : 0;
  torso(upper, a, view, swing, -swing);
  if (view === "front") {
    face(upper, a, !!pose.blink);
    hairFront(upper, a);
  } else if (view === "back") hairBack(upper, a);
  else sideHead(upper, a, !!pose.blink);
  accessory(upper, a, view);
  shifted(out, lower, 0);
  shifted(out, upper, bob);
  out.outline();
  return out.px;
}

const cache = new Map<string, HTMLCanvasElement>();

export function chibiCanvas(a: Appearance, pose: Pose): HTMLCanvasElement {
  const key = JSON.stringify([a.skin, a.hair, a.hairStyle, a.shirt, a.pants, a.accessory, pose]);
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = CHIBI_W;
  c.height = CHIBI_H;
  const ctx = c.getContext("2d")!;
  paintChibi(a, pose).forEach((row, y) =>
    row.forEach((col, x) => {
      if (!col) return;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }),
  );
  if (cache.size > 2000) cache.clear();
  cache.set(key, c);
  return c;
}
