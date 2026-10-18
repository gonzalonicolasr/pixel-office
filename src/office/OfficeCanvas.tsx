import { useEffect, useRef, useState } from "react";
import type { Layout, PublicOffice, Seat } from "../../shared/types.ts";
import type { OfficeEngine, Snapshot } from "./engine.ts";
import { ThreeOffice } from "./three-renderer.ts";

interface Props {
  engine: OfficeEngine;
  office: PublicOffice;
  target: string | null;
  onPick: (id: string | null) => void;
  editLayout: boolean;
  onLayout: (l: Layout) => void;
}

export function OfficeCanvas({ engine, office, target, onPick, editLayout, onLayout }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [seats, setSeats] = useState<Seat[]>(office.layout.seats);
  const drag = useRef<number | null>(null);
  const L = office.layout;

  useEffect(() => setSeats(office.layout.seats), [office.layout.seats]);

  const three = useRef<ThreeOffice | null>(null);

  useEffect(() => {
    const view = new ThreeOffice(canvas.current!, engine);
    three.current = view;
    const ro = new ResizeObserver(([e]) => view.resize(e.contentRect.width, e.contentRect.height));
    ro.observe(wrap.current!);
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      engine.update(dt);
      view.render(dt);
      acc += dt;
      if (acc > 1 / 30) {
        acc = 0;
        setSnaps(engine.snapshots());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      view.dispose();
      three.current = null;
    };
  }, [engine]);

  useEffect(() => {
    if (three.current) three.current.picked = target;
  }, [target]);

  const toImage = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * L.width, y: ((e.clientY - r.top) / r.height) * L.height };
  };

  const pct = (x: number, y: number) => ({ left: `${(x / L.width) * 100}%`, top: `${(y / L.height) * 100}%` });

  return (
    <div
      ref={wrap}
      className={`office ${editLayout ? "editing" : ""}`}
      style={{ aspectRatio: `${L.width} / ${L.height}` }}
      onPointerMove={(e) => {
        if (drag.current === null) return;
        const p = toImage(e);
        setSeats((s) => s.map((seat, i) => (i === drag.current ? { x: Math.round(p.x), y: Math.round(p.y) } : seat)));
      }}
      onPointerUp={() => {
        if (drag.current === null) return;
        drag.current = null;
        onLayout({ ...L, seats });
      }}
    >
      <canvas
        ref={canvas}
        onPointerMove={(e) => {
          if (editLayout || !three.current) return;
          const p = toImage(e);
          three.current.hovered = engine.hit(p.x, p.y);
        }}
        onPointerLeave={() => {
          if (three.current) three.current.hovered = null;
        }}
        onClick={(e) => {
          if (editLayout) return;
          const p = toImage(e);
          onPick(engine.hit(p.x, p.y));
        }}
      />
      <div className="overlay">
        {!editLayout &&
          snaps.map((s) => (
            <div
              key={s.id}
              className={`tag ${target === s.id ? "picked" : ""} ${s.working ? "busy" : ""}`}
              style={{ ...pct(s.x, s.top), ["--c" as string]: s.color }}
              onClick={() => onPick(target === s.id ? null : s.id)}
            >
              {s.bubble && <div className="bubble">{s.bubble}</div>}
              {!s.bubble && s.thinking && <div className="bubble think">pensando<span className="dots" /></div>}
              {!s.bubble && !s.thinking && s.working && <div className="bubble typing">escribiendo<span className="dots" /></div>}
              <div className="plate">
                <b>
                  {s.lead && "★ "}
                  {s.name}
                </b>
                <span>{s.role}</span>
              </div>
            </div>
          ))}
        {editLayout &&
          seats.map((seat, i) => (
            <div
              key={i}
              className="seat-handle"
              style={pct(seat.x, seat.y)}
              onPointerDown={(e) => {
                e.preventDefault();
                drag.current = i;
              }}
              onDoubleClick={() => {
                if (seats.length <= 1) return;
                const next = seats.filter((_, j) => j !== i);
                setSeats(next);
                onLayout({ ...L, seats: next });
              }}
            >
              {i + 1}
            </div>
          ))}
        {editLayout && (
          <div className="layout-help">
            Arrastrá los números al centro de cada silla · doble click borra ·{" "}
            <button
              onClick={() => {
                const next = [...seats, { x: Math.round(L.width / 2), y: Math.round(L.height * 0.85) }];
                setSeats(next);
                onLayout({ ...L, seats: next });
              }}
            >
              + escritorio
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
