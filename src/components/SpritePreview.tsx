import { useEffect, useRef } from "react";
import type { Agent } from "../../shared/types.ts";
import { characterFrame } from "../office/characters.ts";

const BOX_W = 30;
const BOX_H = 44;

export function SpritePreview({ agent, scale = 4, walk = true }: { agent: Agent; scale?: number; walk?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const ctx = ref.current?.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, BOX_W * scale, BOX_H * scale);
      const step = (walk ? frame % 4 : 0) as 0 | 1 | 2 | 3;
      const f = characterFrame(agent, { kind: "stand", dir: "down", step, blink: frame % 12 === 0 });
      const k = Math.min((BOX_H - 2) / f.h, (BOX_W - 2) / f.w) * scale;
      const w = f.w * k;
      const h = f.h * k;
      const x = (BOX_W * scale - w) / 2;
      const y = BOX_H * scale - h - scale + f.bob * k;
      ctx.save();
      if (f.flip) {
        ctx.translate(x + w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(f.canvas, 0, y, w, h);
      } else ctx.drawImage(f.canvas, x, y, w, h);
      ctx.restore();
      frame++;
    };
    draw();
    const id = setInterval(draw, 170);
    return () => clearInterval(id);
  }, [agent, scale, walk]);
  return <canvas ref={ref} width={BOX_W * scale} height={BOX_H * scale} className="sprite-preview" />;
}
