import { describe, expect, it } from "vitest";
import { demoRoute, parseRouting } from "../../server/orchestrator.ts";
import { defaultOffice } from "../../server/store.ts";

const agents = defaultOffice().agents;

describe("parseRouting", () => {
  it("parses JSON wrapped in fences and prose", () => {
    const raw = 'Dale, va:\n```json\n{"note":"Lo ve Reva","assignments":[{"agent":"reva","task":"Probá el login"}]}\n```\nlisto';
    expect(parseRouting(raw, agents)).toEqual({ note: "Lo ve Reva", assignments: [{ agentId: "reva", task: "Probá el login" }] });
  });

  it("accepts agents by name, case-insensitive", () => {
    const raw = '{"note":"n","assignments":[{"agent":"BRUNO","task":"API"},{"agent":"olivia","task":"post"}]}';
    expect(parseRouting(raw, agents)?.assignments.map((a) => a.agentId)).toEqual(["bruno", "olivia"]);
  });

  it("drops unknown agents, the lead, duplicates and caps at 4", () => {
    const raw = JSON.stringify({
      note: "x",
      assignments: [
        { agent: "nadie", task: "a" },
        { agent: "mate", task: "b" },
        { agent: "coda", task: "c" },
        { agent: "Coda", task: "c2" },
        { agent: "bruno", task: "d" },
        { agent: "reva", task: "e" },
        { agent: "indu", task: "f" },
        { agent: "olivia", task: "g" },
      ],
    });
    expect(parseRouting(raw, agents)?.assignments.map((a) => a.agentId)).toEqual(["coda", "bruno", "reva", "indu"]);
  });

  it("handles braces inside strings", () => {
    const raw = '{"note":"usa {llaves} y \\"comillas\\"","assignments":[]}';
    expect(parseRouting(raw, agents)).toEqual({ note: 'usa {llaves} y "comillas"', assignments: [] });
  });

  it("returns null for garbage", () => {
    expect(parseRouting("no tengo idea", agents)).toBeNull();
    expect(parseRouting("{roto: ", agents)).toBeNull();
    expect(parseRouting('{"assignments":"reva"}', agents)).toBeNull();
    expect(parseRouting("[1,2]", agents)).toBeNull();
  });
});

describe("demoRoute", () => {
  const ids = (text: string) => demoRoute(text, agents)?.assignments.map((a) => a.agentId) ?? null;

  it("routes by keywords", () => {
    expect(ids("Hay un bug en el login, testealo")).toEqual(["reva"]);
    expect(ids("Escribí un post para LinkedIn")).toEqual(["olivia"]);
    expect(ids("Armá la API y la base de datos")).toEqual(["bruno"]);
    expect(ids("Mejorá el CSS de la pantalla")).toEqual(["coda"]);
    expect(ids("Buscá y compará frameworks")).toEqual(["indu"]);
  });

  it("assigns several people and by name mention", () => {
    expect(ids("Coda, hacé la pantalla y que Reva arme los tests")).toEqual(["coda", "reva"]);
  });

  it("returns null when the lead should answer", () => {
    expect(demoRoute("Hola, ¿cómo andás?", agents)).toBeNull();
  });
});
