import type { Provider } from "../shared/types.ts";
import { resolveKey } from "./store.ts";

export const LOOK_TIMEOUT_MS = 180_000;
export const LOOK_FILE_RE = /^[a-z0-9-]+\.(png|jpe?g|webp)$/;

export const LOOK_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export interface LookImage {
  data: Buffer;
  ext: "png" | "jpg" | "webp";
}

export function lookPrompt(description: string): string {
  return `16-bit pixel art chibi office worker character sprite sheet in Stardew Valley style, warm cozy office game. Character: ${description}. Exactly three full-body poses side by side in one row, same character, same scale, evenly spaced, not touching: (1) standing facing the camera, (2) walking facing the camera mid-step, (3) standing seen from behind. Big head about one third of the height, dark outline, crisp hard pixel edges. Solid flat pure magenta #FF00FF background everywhere, no shadows, no floor, no text, no labels, no furniture.`;
}

export function lookFileFromSrc(src: string | undefined): string | null {
  if (!src?.startsWith("/api/looks/")) return null;
  const file = src.slice("/api/looks/".length);
  return LOOK_FILE_RE.test(file) ? file : null;
}

export function lookFileName(agentId: string, ext: string, now = Date.now()): string {
  const slug = agentId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return `${slug}-${now}.${ext}`;
}

function sniff(data: Buffer, hint?: string): LookImage["ext"] | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
  if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (hint === "png" || hint === "webp") return hint;
  if (hint === "jpeg" || hint === "jpg") return "jpg";
  return null;
}

export function decodeDataUrl(url: string): LookImage | null {
  const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/is.exec(url.trim());
  if (!m) return null;
  const data = Buffer.from(m[2], "base64");
  const ext = sniff(data, m[1].toLowerCase());
  return ext && data.length > 0 ? { data, ext } : null;
}

async function postJson(url: string, key: string | undefined, body: unknown, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Respuesta que no es JSON: ${text.slice(0, 200)}`);
  }
}

export async function generateLookImage(
  provider: Provider,
  model: string,
  description: string,
  timeoutMs = LOOK_TIMEOUT_MS,
): Promise<LookImage> {
  const base = (provider.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const key = resolveKey(provider);
  const signal = AbortSignal.timeout(timeoutMs);
  const prompt = lookPrompt(description);
  let firstError = "";
  try {
    const json = await postJson(`${base}/chat/completions`, key, { model, messages: [{ role: "user", content: prompt }] }, signal);
    const url = json?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    if (typeof url === "string") {
      const image = decodeDataUrl(url);
      if (image) return image;
      firstError = "la imagen de chat/completions no es un data URL válido";
    } else {
      firstError = "chat/completions no devolvió imágenes";
    }
  } catch (err) {
    if (signal.aborted) throw new Error(`El modelo de imágenes no respondió en ${Math.round(timeoutMs / 1000)} s`);
    firstError = err instanceof Error ? err.message : String(err);
  }
  try {
    const json = await postJson(`${base}/images/generations`, key, { model, prompt, size: "1536x1024" }, signal);
    const b64 = json?.data?.[0]?.b64_json;
    if (typeof b64 !== "string") throw new Error("images/generations no devolvió b64_json");
    const data = Buffer.from(b64, "base64");
    const ext = sniff(data, "png");
    if (!ext || data.length === 0) throw new Error("images/generations devolvió una imagen vacía");
    return { data, ext };
  } catch (err) {
    if (signal.aborted) throw new Error(`El modelo de imágenes no respondió en ${Math.round(timeoutMs / 1000)} s`);
    throw new Error(`No se pudo generar la imagen (${firstError}; ${err instanceof Error ? err.message : String(err)})`);
  }
}
