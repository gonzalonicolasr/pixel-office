import type { Agent, Layout, OfficeEvent, PublicOffice, Seat } from "../../shared/types.ts";
import { characterFrame } from "./characters.ts";
import type { Dir, Pose } from "./sprites.ts";

type Point = Seat;

type Action =
  | { kind: "walk"; to: Point }
  | { kind: "wait"; ms: number }
  | { kind: "sit" }
  | { kind: "say"; text: string; ms: number }
  | { kind: "vanish" }
  | { kind: "fx"; fx: OfficeEngine["effects"][number] };

export interface Character {
  id: string;
  agent: Agent;
  x: number;
  y: number;
  dir: Dir;
  seated: boolean;
  path: Point[];
  actions: Action[];
  waitLeft: number;
  t: number;
  blinkAt: number;
  working: boolean;
  thinking: boolean;
  bubble: string | null;
  bubbleUntil: number;
  gone: boolean;
}

export interface Snapshot {
  id: string;
  x: number;
  y: number;
  top: number;
  name: string;
  role: string;
  color: string;
  lead: boolean;
  working: boolean;
  thinking: boolean;
  bubble: string | null;
}

const SPEED = 150;
const BODY = 0.95;
const BACKREST = 12.4;

export class OfficeEngine {
  chars = new Map<string, Character>();
  layout: Layout | null = null;
  effects: { kind: "sparkle" | "paper"; x: number; y: number; tx?: number; ty?: number; color: string }[] = [];
  boardText = "";
  boardTitle = "";
  now = 0;

  setOffice(office: PublicOffice) {
    const first = !this.layout;
    this.layout = office.layout;
    const seen = new Set<string>();
    for (const agent of office.agents) {
      seen.add(agent.id);
      const seat = this.seatOf(agent);
      const existing = this.chars.get(agent.id);
      if (!existing) {
        const start = first ? seat : office.layout.entry;
        const c: Character = {
          id: agent.id,
          agent,
          x: start.x,
          y: start.y,
          dir: "up",
          seated: first,
          path: [],
          actions: [],
          waitLeft: 0,
          t: Math.random() * 10,
          blinkAt: 2 + Math.random() * 4,
          working: false,
          thinking: false,
          bubble: first ? null : "¡Hola! 👋",
          bubbleUntil: this.now + 3,
          gone: false,
        };
        this.chars.set(agent.id, c);
        if (!first) c.actions.push({ kind: "walk", to: seat }, { kind: "sit" });
        continue;
      }
      const prevSeat = existing.agent.seat;
      existing.agent = agent;
      existing.gone = false;
      if (prevSeat !== agent.seat) this.sendHome(existing);
    }
    for (const c of this.chars.values()) {
      if (seen.has(c.id) || c.gone) continue;
      c.gone = true;
      c.actions = [{ kind: "say", text: "¡Chau!", ms: 1200 }, { kind: "walk", to: office.layout.entry }, { kind: "vanish" }];
      this.stand(c);
    }
  }

  seatOf(agent: Agent): Point {
    const seats = this.layout!.seats;
    return seats[Math.max(0, Math.min(seats.length - 1, agent.seat))] ?? this.layout!.entry;
  }

  scaleAt(y: number): number {
    const h = this.layout?.height ?? 940;
    return (3.3 + (y / h) * 1.9) * (h / 940);
  }

  private lanes() {
    const seats = this.layout!.seats;
    const rows: number[] = [];
    for (const s of [...seats].sort((a, b) => a.y - b.y)) if (!rows.some((r) => Math.abs(r - s.y) < 70)) rows.push(s.y);
    const hLanes = rows.map((y) => y + 21 * this.scaleAt(y));
    const xs: number[] = [];
    for (const s of [...seats].sort((a, b) => a.x - b.x)) if (!xs.some((x) => Math.abs(x - s.x) < 90)) xs.push(s.x);
    const vLanes: number[] = [];
    for (let i = 0; i < xs.length - 1; i++) vLanes.push((xs[i] + xs[i + 1]) / 2);
    if (xs.length) {
      vLanes.push(Math.max(40, xs[0] - 190));
      vLanes.push(Math.min(this.layout!.width - 40, xs[xs.length - 1] + 190));
    }
    return { hLanes, vLanes };
  }

  route(from: Point, to: Point): Point[] {
    const { hLanes, vLanes } = this.lanes();
    if (!hLanes.length) return [to];
    const near = (y: number) => hLanes.reduce((b, l) => (Math.abs(l - y) < Math.abs(b - y) ? l : b), hLanes[0]);
    const la = near(from.y);
    const lb = near(to.y);
    const pts: Point[] = [{ x: from.x, y: la }];
    if (Math.abs(la - lb) > 1) {
      const v = vLanes.reduce((b, l) => (Math.abs(l - to.x) + Math.abs(l - from.x) < Math.abs(b - to.x) + Math.abs(b - from.x) ? l : b), vLanes[0]);
      pts.push({ x: v, y: la }, { x: v, y: lb });
    }
    pts.push({ x: to.x, y: lb }, to);
    return pts;
  }

  private stand(c: Character) {
    if (!c.seated) return;
    c.seated = false;
    c.y += 4 * this.scaleAt(c.y);
  }

  sendHome(c: Character) {
    c.actions.push({ kind: "walk", to: this.seatOf(c.agent) }, { kind: "sit" });
  }

  say(id: string, text: string, secs = 4) {
    const c = this.chars.get(id);
    if (!c) return;
    c.bubble = text;
    c.bubbleUntil = this.now + secs;
  }

  handle(ev: OfficeEvent) {
    switch (ev.type) {
      case "run_start":
        this.boardTitle = ev.target ? `→ ${this.chars.get(ev.target)?.agent.name ?? ""}` : "TAREA";
        this.boardText = ev.text;
        break;
      case "routing": {
        const c = this.chars.get(ev.leadId);
        if (c) c.thinking = true;
        break;
      }
      case "route": {
        const lead = this.chars.get(ev.leadId);
        if (!lead) break;
        lead.thinking = false;
        if (ev.note) this.say(lead.id, ev.note, 5);
        if (!ev.assignments.length) break;
        for (const a of ev.assignments) {
          const target = this.chars.get(a.agentId);
          if (!target) continue;
          const seat = this.seatOf(target.agent);
          const s = this.scaleAt(seat.y);
          lead.actions.push(
            { kind: "walk", to: { x: seat.x + 15 * s, y: seat.y + 3 * s } },
            { kind: "fx", fx: { kind: "paper", x: 0, y: 0, tx: seat.x, ty: seat.y - 30 * s, color: lead.agent.appearance.shirt } },
            { kind: "say", text: `📄 ${target.agent.name}, esto es tuyo`, ms: 1300 },
          );
        }
        this.sendHome(lead);
        break;
      }
      case "agent_start": {
        const c = this.chars.get(ev.agentId);
        if (c) {
          c.working = true;
          c.thinking = false;
          c.bubble = null;
        }
        break;
      }
      case "delta": {
        const c = this.chars.get(ev.agentId);
        if (c) c.working = true;
        break;
      }
      case "agent_done": {
        const c = this.chars.get(ev.agentId);
        if (c) {
          c.working = false;
          this.say(c.id, "✓ ¡Listo!", 4);
          const r = this.spriteRect(c);
          this.effects.push({ kind: "sparkle", x: c.x, y: r.y + r.h * 0.3, color: c.agent.appearance.shirt });
        }
        break;
      }
      case "agent_error": {
        const c = this.chars.get(ev.agentId);
        if (c) {
          c.working = false;
          c.thinking = false;
          this.say(c.id, "⚠ Algo falló", 6);
        }
        break;
      }
      case "tool_call": {
        const icon = ev.name === "run_command" ? "⌨" : ev.name === "write_file" || ev.name === "edit_file" ? "✎" : "🔍";
        const text = ev.summary.length > 34 ? `${ev.summary.slice(0, 33)}…` : ev.summary;
        this.say(ev.agentId, `${icon} ${text}`, 3);
        break;
      }
      case "permission_request":
        this.say(ev.agentId, "🔐 Necesito tu permiso", 600);
        break;
      case "permission_resolved":
        this.say(ev.agentId, ev.decision === "deny" ? "😕 Ok, no lo hago" : "👍 ¡Gracias!", 2);
        break;
      case "run_done":
        for (const c of this.chars.values()) c.thinking = false;
        break;
      case "office":
        this.setOffice(ev.office);
        break;
    }
  }

  private wanderClock = 12;

  private wander() {
    const idle = [...this.chars.values()].filter((c) => c.seated && !c.working && !c.thinking && !c.actions.length && !c.gone);
    if (!idle.length || !this.layout) return;
    const c = idle[Math.floor(Math.random() * idle.length)];
    const spots = this.layout.spots?.length ? this.layout.spots : [this.layout.entry];
    const spot = spots[Math.floor(Math.random() * spots.length)];
    const lines = ["☕", "🌿", "🤔", "💡", "🎵"];
    c.actions.push(
      { kind: "walk", to: spot },
      { kind: "say", text: lines[Math.floor(Math.random() * lines.length)], ms: 2500 },
    );
    this.sendHome(c);
  }

  update(dt: number) {
    this.now += dt;
    this.wanderClock -= dt;
    if (this.wanderClock <= 0) {
      this.wanderClock = 14 + Math.random() * 22;
      this.wander();
    }
    for (const c of this.chars.values()) {
      c.t += dt;
      if (c.bubble && this.now > c.bubbleUntil) c.bubble = null;
      this.step(c, dt);
    }
  }

  private step(c: Character, dt: number) {
    if (c.path.length) {
      const target = c.path[0];
      const dx = target.x - c.x;
      const dy = target.y - c.y;
      const dist = Math.hypot(dx, dy);
      const sp = SPEED * (this.scaleAt(c.y) / 4) * dt;
      if (Math.abs(dx) > Math.abs(dy)) c.dir = dx > 0 ? "right" : "left";
      else if (Math.abs(dy) > 0.5) c.dir = dy > 0 ? "down" : "up";
      if (dist <= sp) {
        c.x = target.x;
        c.y = target.y;
        c.path.shift();
      } else {
        c.x += (dx / dist) * sp;
        c.y += (dy / dist) * sp;
      }
      return;
    }
    if (c.waitLeft > 0) {
      c.waitLeft -= dt;
      return;
    }
    const next = c.actions.shift();
    if (!next) return;
    if (next.kind === "walk") {
      this.stand(c);
      c.path = this.route({ x: c.x, y: c.y }, next.to);
    } else if (next.kind === "wait") c.waitLeft = next.ms / 1000;
    else if (next.kind === "say") {
      this.say(c.id, next.text, next.ms / 1000);
      c.dir = "down";
      c.waitLeft = next.ms / 1000;
    } else if (next.kind === "sit") {
      const seat = this.seatOf(c.agent);
      c.x = seat.x;
      c.y = seat.y;
      c.seated = true;
      c.dir = "up";
    } else if (next.kind === "vanish") this.chars.delete(c.id);
    else if (next.kind === "fx") {
      const r = this.spriteRect(c);
      this.effects.push({ ...next.fx, x: c.x, y: r.y + r.h * 0.45 });
    }
  }

  pose(c: Character): Pose {
    const blink = c.t % c.blinkAt < 0.14;
    if (c.seated) {
      const typing = c.working ? ((Math.floor(c.t * 7) % 2) + 1) as 1 | 2 : 0;
      return { kind: "sit", typing, blink };
    }
    const moving = c.path.length > 0;
    const step = moving ? (Math.floor(c.t * 8) % 4) as 0 | 1 | 2 | 3 : 0;
    return { kind: "stand", dir: c.dir, step, blink };
  }

  spriteRect(c: Character) {
    const s = this.scaleAt(c.y);
    const u = s * BODY;
    const f = characterFrame(c.agent, this.pose(c));
    const w = f.w * u;
    const h = f.h * u;
    const top = (c.seated ? c.y - BACKREST * s - f.shoulder * h : c.y - h + u) + f.bob * u;
    return { x: c.x - w / 2, y: top, w, h, s, frame: f };
  }

  snapshots(): Snapshot[] {
    return [...this.chars.values()].map((c) => {
      const r = this.spriteRect(c);
      const headTop = c.seated ? c.y - 41 * r.s : r.y;
      return {
        id: c.id,
        x: c.x,
        y: c.y,
        top: headTop,
        name: c.agent.name,
        role: c.agent.role,
        color: c.agent.appearance.shirt,
        lead: !!c.agent.lead,
        working: c.working,
        thinking: c.thinking,
        bubble: c.bubble,
      };
    });
  }

  hit(x: number, y: number): string | null {
    let best: string | null = null;
    let bestY = -Infinity;
    for (const c of this.chars.values()) {
      const r = this.spriteRect(c);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h && c.y > bestY) {
        best = c.id;
        bestY = c.y;
      }
    }
    return best;
  }
}
