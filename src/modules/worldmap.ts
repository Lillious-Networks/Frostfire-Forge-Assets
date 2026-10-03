// World map bake (the game's full-map view, M): one pixel per tile, each tile's alpha-weighted average colour from the
// map's own tilesets, composited over the visible tile layers in order. Baked in memory at startup for every map
// (assetloader.ts loadWorldMaps), so a new or edited map never needs a hand-baked <map>.worldmap.png. Same algorithm as
// the Map Generation project's worldmap.ts.
import fs from "fs";
import path from "path";
import { decodePng, encodePng, type RGBAImage } from "./png";

/** Layers that are game data, not art (never drawn). */
const HIDDEN = /collision|nopvp|no-pvp/i;
const GID_MASK = 0x1fffffff;
/** The sea / void behind transparent tiles (a map's own backgroundcolor wins). */
const BACKGROUND: [number, number, number] = [16, 20, 32];

/** Decoded tileset images by file name, shared by every map baked in one pass (read only; null when unreadable). */
export class TilesetImages {
  private images = new Map<string, RGBAImage | null>();
  constructor(private dir: string) {}
  get(name: string): RGBAImage | null {
    if (this.images.has(name)) return this.images.get(name)!;
    let img: RGBAImage | null = null;
    const file = path.join(this.dir, name);
    try { if (fs.existsSync(file)) img = decodePng(fs.readFileSync(file)); } catch { img = null; }
    this.images.set(name, img);
    return img;
  }
}

export function bakeWorldMap(map: any, images: TilesetImages): Buffer {
  const W = Number(map.width) || 0, H = Number(map.height) || 0;
  if (!W || !H) throw new Error("map without a size");
  const bg = typeof map.backgroundcolor === "string" && /^#[0-9a-f]{6}$/i.test(map.backgroundcolor)
    ? [1, 3, 5].map(i => parseInt(map.backgroundcolor.slice(i, i + 2), 16)) as [number, number, number] : BACKGROUND;
  const rgb = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { rgb[i * 3] = bg[0]; rgb[i * 3 + 1] = bg[1]; rgb[i * 3 + 2] = bg[2]; }

  const sheets = (map.tilesets ?? []).filter((t: any) => t?.image).sort((a: any, b: any) => b.firstgid - a.firstgid).map((t: any) => {
    const img = images.get(path.basename(String(t.image)));
    const tw = Number(t.tilewidth) || 16, th = Number(t.tileheight) || 16;
    return { first: Number(t.firstgid), img, tw, th, cols: Number(t.columns) || (img ? Math.floor(img.width / tw) : 1) };
  });
  // average colour and coverage of a gid, cached
  const avg = new Map<number, [number, number, number, number]>();
  const colourOf = (gid: number) => {
    let c = avg.get(gid);
    if (c) return c;
    c = [0, 0, 0, 0];
    const s = sheets.find((t: any) => gid >= t.first);
    if (s?.img) {
      const id = gid - s.first, cx = (id % s.cols) * s.tw, cy = Math.floor(id / s.cols) * s.th;
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = 0; y < s.th; y++) for (let x = 0; x < s.tw; x++) {
        const px = cx + x, py = cy + y;
        if (px >= s.img.width || py >= s.img.height) continue;
        const i = (py * s.img.width + px) * 4, al = s.img.data[i + 3]! / 255;
        r += s.img.data[i]! * al; g += s.img.data[i + 1]! * al; b += s.img.data[i + 2]! * al; a += al;
      }
      c = a > 0 ? [r / a, g / a, b / a, a / (s.tw * s.th)] : [0, 0, 0, 0];
    }
    avg.set(gid, c);
    return c;
  };

  for (const layer of map.layers ?? []) {
    if (layer?.type !== "tilelayer" || layer.visible === false || HIDDEN.test(String(layer.name ?? ""))) continue;
    const chunks = Array.isArray(layer.chunks) ? layer.chunks : Array.isArray(layer.data) ? [{ x: 0, y: 0, width: W, height: H, data: layer.data }] : [];
    for (const ch of chunks) {
      const data = ch?.data;
      if (!Array.isArray(data)) continue;
      const cw = Number(ch.width) || W, cx0 = Number(ch.x) || 0, cy0 = Number(ch.y) || 0;
      for (let k = 0; k < data.length; k++) {
        const gid = data[k] & GID_MASK;
        if (!gid) continue;
        const x = cx0 + (k % cw), y = cy0 + Math.floor(k / cw);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const [r, g, b, a] = colourOf(gid);
        if (a <= 0) continue;
        const i = (y * W + x) * 3;
        rgb[i] = rgb[i]! * (1 - a) + r * a; rgb[i + 1] = rgb[i + 1]! * (1 - a) + g * a; rgb[i + 2] = rgb[i + 2]! * (1 - a) + b * a;
      }
    }
  }
  const px = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) px[i] = Math.round(rgb[i]!);
  return encodePng(W, H, px, 3);
}
