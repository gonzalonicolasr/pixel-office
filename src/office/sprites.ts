import type { Appearance } from "../../shared/types.ts";

export type Dir = "down" | "up" | "left" | "right";

export type Pose =
  | { kind: "stand"; dir: Dir; step: 0 | 1 | 2 | 3; blink?: boolean }
  | { kind: "sit"; typing: 0 | 1 | 2; blink?: boolean };

function hex(c: string): [number, number, number] {
  const h = c.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((x) => x + x).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function shade(c: string, amt: number): string {
  const [r, g, b] = hex(c);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
  return `#${[f(r), f(g), f(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const SKINS = ["#f1c7a5", "#e0a97e", "#c68a5c", "#a0683f", "#7a4a2a", "#5a3520"];
const HAIRS = ["#2b1d16", "#5a3a22", "#c9893a", "#e8d27a", "#a33b2b", "#3b3b48", "#d8d8e0", "#6d3fa0"];
const SHIRTS = ["#5fc9e8", "#7be08a", "#f2c14e", "#e86fa8", "#9b7bf2", "#f08a4b", "#4b8df0", "#e05a5a"];
const PANTS = ["#3a3550", "#2f4a6b", "#4a3b2f", "#2b2b33", "#5b4a6b"];
const STYLES: Appearance["hairStyle"][] = ["short", "long", "bun", "cap", "curly", "bald"];

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function randomAppearance(seed: string): Appearance {
  const h = hash(seed);
  const pick = <T,>(arr: T[], n: number) => arr[(h >>> n) % arr.length];
  return {
    skin: pick(SKINS, 0),
    hair: pick(HAIRS, 3),
    hairStyle: pick(STYLES, 7),
    shirt: pick(SHIRTS, 11),
    pants: pick(PANTS, 15),
    accessory: (["none", "none", "glasses", "headphones"] as const)[(h >>> 19) % 4],
  };
}

export const PALETTES = { SKINS, HAIRS, SHIRTS, PANTS, STYLES };
