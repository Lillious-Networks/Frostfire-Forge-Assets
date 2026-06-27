import path from "path";
import fs from "fs";
import log from "./logger";
import assetCache from "../services/assetCache";
import zlib from "zlib";
import crypto from "crypto";

// Load assets path from environment variable or use default
function getAssetPath(): string {
  const customAssetPath = process.env.ASSETS_PATH;

  if (customAssetPath) {
    // If custom path is provided, resolve it properly
    let resolvedPath: string;

    if (path.isAbsolute(customAssetPath)) {
      // Absolute path - use as-is
      resolvedPath = customAssetPath;
    } else {
      // Relative path - resolve from current working directory
      // In Docker, cwd is /app, so relative paths work correctly
      // Locally, cwd is project root, so relative paths also work
      resolvedPath = path.resolve(process.cwd(), customAssetPath);
    }

    if (!fs.existsSync(resolvedPath)) {
      log.error(`Assets directory not found at: ${resolvedPath}`);
      process.exit(1);
    }

    log.info(`Using external assets directory: ${resolvedPath}`);
    return resolvedPath;
  }

  // Default to src/assets
  const defaultPath = path.join(import.meta.dir, "..", "assets");
  if (!fs.existsSync(defaultPath)) {
    log.error(`Assets directory not found at default location: ${defaultPath}`);
    process.exit(1);
  }

  log.info(`Using default assets directory: ${defaultPath}`);
  return defaultPath;
}

const assetPath = getAssetPath();
const TILESETS_PATH = "tilesets";
const MAPS_PATH = "maps";
const ANIMATIONS_PATH = "animations";
const SPRITESHEETS_PATH = "spritesheets";
const SPRITES_PATH = "sprites";
const ICONS_PATH = "icons";

const assetLoadingStartTime = performance.now();

async function loadTilesets() {
  const now = performance.now();
  const tilesets = [] as TilesetData[];
  const tilesetDir = path.join(assetPath, TILESETS_PATH);

  if (!fs.existsSync(tilesetDir)) {
    throw new Error(`Tilesets directory not found at ${tilesetDir}`);
  }

  const tilesetFiles = fs.readdirSync(tilesetDir);
  tilesetFiles.forEach((file) => {

    const tilesetData = fs.readFileSync(path.join(tilesetDir, file));

    const compressedData = zlib.gzipSync(tilesetData);

    const originalSize = tilesetData.length;
    const compressedSize = compressedData.length;
    const ratio = (originalSize / compressedSize).toFixed(2);
    const savings = (((originalSize - compressedSize) / originalSize) * 100).toFixed(2);

    log.debug(`Loaded tileset: ${file}`);
    log.debug(`Compressed tileset: ${file}
  - Original: ${originalSize} bytes
  - Compressed: ${compressedSize} bytes
  - Compression Ratio: ${ratio}x
  - Compression Savings: ${savings}%`);

    tilesets.push({ name: file, data: compressedData });
  });

  await assetCache.add(
    "tilesets",
    tilesets.map(t => ({
      name: t.name,
      data: t.data.toString("base64")
    }))
  );

  log.success(`Loaded ${tilesets.length} tileset(s) in ${(performance.now() - now).toFixed(2)}ms`);
}

async function loadSpriteSheetTemplates() {
  const now = performance.now();
  const templates = [] as SpriteSheetTemplate[];

  const animationsDir = path.join(assetPath, ANIMATIONS_PATH);
  const spriteSheetDir = path.join(assetPath, SPRITESHEETS_PATH);

  if (!fs.existsSync(animationsDir)) {
    log.warn(`Animations directory not found at ${animationsDir}, skipping animation template loading`);
    await assetCache.add("spriteSheetTemplates", []);
    return;
  }

  if (!fs.existsSync(spriteSheetDir)) {
    log.warn(`Sprite sheets directory not found at ${spriteSheetDir}, skipping sprite sheet image loading`);
    await assetCache.add("spriteSheetTemplates", []);
    return;
  }

  const templateFiles = fs.readdirSync(animationsDir).filter(file => file.endsWith(".json"));

  if (templateFiles.length === 0) {
    log.warn(`No animation templates found in ${animationsDir}`);
    await assetCache.add("spriteSheetTemplates", []);
    return;
  }

  // Load templates with associated images
  templateFiles.forEach(file => {
    const templatePath = path.join(animationsDir, file);
    const templateData = JSON.parse(fs.readFileSync(templatePath, "utf-8"));

    const templateJson = JSON.stringify(templateData);

    let pngFile = templateData.imageSource;
    let pngPath = path.join(spriteSheetDir, pngFile);

    // Check if file needs directory prefix based on template name (same method as PNG loader)
    const dirPath = path.dirname(pngPath);
    if (file.includes("player_body") && !dirPath.includes("player")) {
      pngFile = path.join("player", "bodies", pngFile);
      pngPath = path.join(spriteSheetDir, pngFile);
    } else if (file.includes("player_head") && !dirPath.includes("player")) {
      pngFile = path.join("player", "heads", pngFile);
      pngPath = path.join(spriteSheetDir, pngFile);
    }

    let imageBuffer: Buffer | null = null;

    if (fs.existsSync(pngPath)) {
      imageBuffer = fs.readFileSync(pngPath);
      log.debug(`Loaded animation template: ${file} with image ${pngFile} (${imageBuffer.length} bytes)`);
    } else {
      log.debug(`Loaded animation template: ${file} (no image - template only, imageSource "${pngFile}" not found)`);
    }

    templates.push({
      name: file.replace(".json", ""),
      template: templateJson,
      image: imageBuffer
    });
  });

  // Load PNG images that don't have templates
  function getAllPngFilesRecursive(dir: string, baseDir: string = dir): string[] {
    let results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(getAllPngFilesRecursive(fullPath, baseDir));
      } else if (entry.name.endsWith(".png")) {
        const relativePath = path.relative(baseDir, fullPath);
        results.push(relativePath);
      }
    }
    return results;
  }

  const allPngFiles = getAllPngFilesRecursive(spriteSheetDir);
  const templatePngFiles = new Set(templateFiles.map(f => {
    const templatePath = path.join(animationsDir, f);
    const templateData = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
    return templateData.imageSource;
  }));

  allPngFiles.forEach(pngFile => {
    if (templatePngFiles.has(pngFile)) {
      return;
    }

    const pngPath = path.join(spriteSheetDir, pngFile);
    const imageBuffer = fs.readFileSync(pngPath);
    let filename = path.basename(pngFile, ".png");

    // Determine which template to use based on the directory
    let templateToUse = null;
    const dirPath = path.dirname(pngPath);

    if (dirPath.includes('armor')) {
      // Helmet uses armor_head_base, shoulderguards use armor_body_base
      if (dirPath.includes('helmet')) {
        const armorHeadTemplate = templates.find((t: any) => t.name === 'armor_head_base');
        templateToUse = armorHeadTemplate?.template || null;
      } else {
        // All other armor (chestplate, gloves, boots, pants, weapon, etc.) use armor_body_base
        const armorBodyTemplate = templates.find((t: any) => t.name === 'armor_body_base');
        templateToUse = armorBodyTemplate?.template || null;
      }
    } else if (dirPath.includes('mounts')) {
      // Mount sprites use player_mount_base template
      const mountTemplate = templates.find((t: any) => t.name === 'player_mount_base');
      templateToUse = mountTemplate?.template || null;
      // Prefix mount images with 'mount_' to match asset server naming
      filename = `mount_${filename}`;
    }

    templates.push({
      name: filename,
      template: templateToUse,
      image: imageBuffer
    });

    let templateName = 'none';
    if (dirPath.includes('armor')) {
      templateName = dirPath.includes('helmet') ? 'armor_head_base' : 'armor_body_base';
    } else if (dirPath.includes('mounts')) {
      templateName = 'player_mount_base';
    }
    log.debug(`Loaded sprite: ${pngFile} (name: ${filename}, ${imageBuffer.length} bytes, using ${templateToUse ? templateName : 'no'} template)`);
  });

  await assetCache.add("spriteSheetTemplates", templates);
  log.success(`Loaded ${templates.length} sprite sheet(s) (${templateFiles.length} with templates, ${templates.length - templateFiles.length} images only) in ${(performance.now() - now).toFixed(2)}ms`);
  if (templates.length > 0) {
    log.debug(`Available sprite templates: ${templates.map((t: any) => t.name).join(", ")}`);
  }
}

async function loadSprites() {
  const now = performance.now();
  const sprites = [] as SpriteData[];

  const spriteDir = path.join(assetPath, SPRITES_PATH);

  if (!fs.existsSync(spriteDir)) {
    log.warn(`Sprites directory not found at ${spriteDir}, skipping sprite loading`);
    await assetCache.add("sprites", []);
    return;
  }

  const spriteFiles = fs.readdirSync(spriteDir).filter(file => file.endsWith(".png"));

  spriteFiles.forEach(file => {
    const name = file.replace(".png", "");
    const rawData = fs.readFileSync(path.join(spriteDir, file));
    const base64Data = rawData.toString("base64");

    log.debug(`Loaded sprite: ${name}`);

    const compressedData = zlib.gzipSync(base64Data);

    sprites.push({ name, data: compressedData.toString("base64") });

    const originalSize = base64Data.length;
    const compressedSize = compressedData.length;
    const ratio = (originalSize / compressedSize).toFixed(2);
    const savings = (((originalSize - compressedSize) / originalSize) * 100).toFixed(2);

    log.debug(`Compressed sprite: ${name}
  - Original: ${originalSize} bytes
  - Compressed: ${compressedSize} bytes
  - Compression Ratio: ${ratio}x
  - Compression Savings: ${savings}%`);
  });

  await assetCache.add("sprites", sprites);
  log.success(`Loaded ${sprites.length} sprite(s) in ${(performance.now() - now).toFixed(2)}ms`);
}

async function loadIcons() {
  const now = performance.now();
  const icons = [] as IconData[];

  const iconDir = path.join(assetPath, ICONS_PATH);

  if (!fs.existsSync(iconDir)) {
    log.warn(`Icons directory not found at ${iconDir}, skipping icon loading`);
    await assetCache.add("icons", []);
    return;
  }

  const iconFiles = fs.readdirSync(iconDir).filter(file => file.endsWith(".png"));

  iconFiles.forEach(file => {
    const name = file.replace(".png", "");
    const rawData = fs.readFileSync(path.join(iconDir, file));
    const base64Data = rawData.toString("base64");

    log.debug(`Loaded icon: ${name}`);

    const compressedData = zlib.gzipSync(base64Data);

    icons.push({ name, data: compressedData.toString("base64") });

    const originalSize = base64Data.length;
    const compressedSize = compressedData.length;
    const ratio = (originalSize / compressedSize).toFixed(2);
    const savings = (((originalSize - compressedSize) / originalSize) * 100).toFixed(2);

    log.debug(`Compressed icon: ${name}
  - Original: ${originalSize} bytes
  - Compressed: ${compressedSize} bytes
  - Compression Ratio: ${ratio}x
  - Compression Savings: ${savings}%`);
  });

  await assetCache.add("icons", icons);
  log.success(`Loaded ${icons.length} icon(s) in ${(performance.now() - now).toFixed(2)}ms`);
}

function loadAllMaps() {
  const now = performance.now();
  const mapDir = path.join(assetPath, MAPS_PATH);
  const maps: MapData[] = [];

  if (!fs.existsSync(mapDir)) throw new Error(`Maps directory not found at ${mapDir}`);

  const mapFiles = fs.readdirSync(mapDir).filter(f => f.endsWith(".json"));
  if (mapFiles.length === 0) throw new Error("No maps found in the maps directory");

  for (const file of mapFiles) {
    const map = processMapFile(file);
    if (map) {
      maps.push(map);
    }
  }

  assetCache.add("maps", maps);
  log.success(`Loaded ${maps.length} map(s) in ${(performance.now() - now).toFixed(2)}ms`);
}

// Tiled stores "infinite" maps as per-layer `chunks` arrays instead of a flat
// `data` array. The /map-chunk endpoint slices from a flat `layer.data` sized
// width*height, so flatten infinite maps in place. Tiles outside the declared
// map bounds are clipped. This must run AFTER the raw-JSON checksum is computed
// so map-sync between engine and asset server stays stable.
// Apply edited chunks to a finite map: grow the flat storage to fit the edits,
// then (for infinite maps) trim the result back to the tight content bounds so
// empty expansion isn't persisted. Existing tiles and object-group objects are
// shifted by the actual amount the content moved. `bounds` is the editor's claimed
// extent (minTileX/minTileY <= 0, width/height exclusive max). Returns the net
// world shift (in tiles) and the final map dimensions.
export function applyChunksWithRebase(
  mapData: any,
  chunks: any[],
  bounds?: { minTileX?: number; minTileY?: number; width?: number; height?: number; infinite?: boolean } | null
): { shiftX: number; shiftY: number; width: number; height: number } {
  if (!mapData || !Array.isArray(mapData.layers)) {
    return { shiftX: 0, shiftY: 0, width: mapData?.width || 0, height: mapData?.height || 0 };
  }

  const refLayer = mapData.layers.find((l: any) => l.type === "tilelayer" && Array.isArray(l.data));
  const oldWidth = refLayer?.width || mapData.width || 0;
  const oldHeight = refLayer?.height || mapData.height || 0;

  const minTileX = Math.min(0, bounds?.minTileX ?? 0);
  const minTileY = Math.min(0, bounds?.minTileY ?? 0);
  const reqWidth = bounds?.width ?? oldWidth;
  const reqHeight = bounds?.height ?? oldHeight;

  // Provisional grow + shift to make room for the claimed expansion.
  const provShiftX = -minTileX;
  const provShiftY = -minTileY;
  const provWidth = Math.max(reqWidth, oldWidth) + provShiftX;
  const provHeight = Math.max(reqHeight, oldHeight) + provShiftY;

  if (provWidth !== oldWidth || provHeight !== oldHeight || provShiftX > 0 || provShiftY > 0) {
    for (const layer of mapData.layers) {
      if (layer.type !== "tilelayer" || !Array.isArray(layer.data)) continue;
      const ow = layer.width || oldWidth;
      const oh = layer.height || oldHeight;
      const newData = new Array(provWidth * provHeight).fill(0);
      for (let oy = 0; oy < oh; oy++) {
        for (let ox = 0; ox < ow; ox++) {
          const v = layer.data[oy * ow + ox];
          if (!v) continue;
          const nx = ox + provShiftX;
          const ny = oy + provShiftY;
          if (nx >= 0 && nx < provWidth && ny >= 0 && ny < provHeight) {
            newData[ny * provWidth + nx] = v;
          }
        }
      }
      layer.data = newData;
      layer.width = provWidth;
      layer.height = provHeight;
    }
    mapData.width = provWidth;
    mapData.height = provHeight;
  }

  for (const chunk of chunks || []) {
    const cw = chunk.width;
    const ch = chunk.height;
    const startX = chunk.chunkX * cw + provShiftX;
    const startY = chunk.chunkY * ch + provShiftY;
    for (const chunkLayer of chunk.layers || []) {
      const mapLayer = mapData.layers.find((l: any) => l.name === chunkLayer.name);
      if (!mapLayer || !Array.isArray(mapLayer.data)) continue;
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const mapX = startX + x;
          const mapY = startY + y;
          if (mapX < 0 || mapX >= provWidth || mapY < 0 || mapY >= provHeight) continue;
          const ci = y * cw + x;
          if (ci < chunkLayer.data.length) {
            mapLayer.data[mapY * provWidth + mapX] = chunkLayer.data[ci];
          }
        }
      }
    }
  }

  let netShiftX = provShiftX;
  let netShiftY = provShiftY;
  let finalWidth = provWidth;
  let finalHeight = provHeight;

  // Trim empty expansion (infinite maps only): shrink back to the tight content
  // bounds. Left/up is only trimmed up to the expansion amount, so intentional
  // empty borders at the original origin are preserved. Use the client's infinite
  // flag when provided (the in-memory map's flag can be stale).
  if ((bounds?.infinite ?? mapData.infinite) === true) {
    let tMinX = Infinity, tMinY = Infinity, tMaxX = -1, tMaxY = -1;
    for (const layer of mapData.layers) {
      if (layer.type !== "tilelayer" || !Array.isArray(layer.data)) continue;
      const w = layer.width;
      const data = layer.data;
      for (let i = 0; i < data.length; i++) {
        if (!data[i]) continue;
        const x = i % w;
        const y = (i - x) / w;
        if (x < tMinX) tMinX = x;
        if (x > tMaxX) tMaxX = x;
        if (y < tMinY) tMinY = y;
        if (y > tMaxY) tMaxY = y;
      }
    }

    if (tMaxX >= 0) {
      const leftTrim = Math.min(tMinX, provShiftX);
      const topTrim = Math.min(tMinY, provShiftY);
      const tightW = (tMaxX + 1) - leftTrim;
      const tightH = (tMaxY + 1) - topTrim;

      if (leftTrim > 0 || topTrim > 0 || tightW < provWidth || tightH < provHeight) {
        for (const layer of mapData.layers) {
          if (layer.type !== "tilelayer" || !Array.isArray(layer.data)) continue;
          const ow = layer.width;
          const old = layer.data;
          const nd = new Array(tightW * tightH).fill(0);
          for (let y = 0; y < tightH; y++) {
            for (let x = 0; x < tightW; x++) {
              const v = old[(y + topTrim) * ow + (x + leftTrim)];
              if (v) nd[y * tightW + x] = v;
            }
          }
          layer.data = nd;
          layer.width = tightW;
          layer.height = tightH;
        }
        mapData.width = tightW;
        mapData.height = tightH;
      }

      finalWidth = tightW;
      finalHeight = tightH;
      netShiftX = provShiftX - leftTrim;
      netShiftY = provShiftY - topTrim;
    }
  }

  if (netShiftX !== 0 || netShiftY !== 0) {
    const dpx = netShiftX * (mapData.tilewidth || 32);
    const dpy = netShiftY * (mapData.tileheight || 32);
    for (const layer of mapData.layers) {
      if (layer.type !== "objectgroup" || !Array.isArray(layer.objects)) continue;
      for (const obj of layer.objects) {
        if (typeof obj.x === "number") obj.x += dpx;
        if (typeof obj.y === "number") obj.y += dpy;
      }
    }
  }

  return { shiftX: netShiftX, shiftY: netShiftY, width: finalWidth, height: finalHeight };
}

function normalizeInfiniteMap(mapData: any): void {
  if (!mapData || mapData.infinite !== true || !Array.isArray(mapData.layers)) return;

  // The map's declared width/height go stale the moment "infinite" is enabled in
  // Tiled. Derive the true size from the actual painted tiles across all layers
  // (not the 16-aligned chunk bounds) so we don't report empty padding that would
  // render as a black border and let the camera pan into nothing. Origin stays at
  // tile 0,0; any negative-coordinate tiles are clipped.
  let mapWidth = 0;
  let mapHeight = 0;
  for (const layer of mapData.layers) {
    if (layer.type !== "tilelayer" || !Array.isArray(layer.chunks)) continue;
    for (const chunk of layer.chunks) {
      const data = chunk?.data;
      if (!Array.isArray(data)) continue;
      const cw = chunk.width || 0;
      const ch = chunk.height || 0;
      const cx = chunk.x || 0;
      const cy = chunk.y || 0;
      for (let row = 0; row < ch; row++) {
        for (let col = 0; col < cw; col++) {
          if (!data[row * cw + col]) continue;
          const gx = cx + col + 1;
          const gy = cy + row + 1;
          if (gx > mapWidth) mapWidth = gx;
          if (gy > mapHeight) mapHeight = gy;
        }
      }
    }
  }
  if (!mapWidth || !mapHeight) return;

  for (const layer of mapData.layers) {
    if (layer.type !== "tilelayer") continue;

    const flat = new Array(mapWidth * mapHeight).fill(0);

    if (Array.isArray(layer.chunks)) {
      for (const chunk of layer.chunks) {
        const data = chunk?.data;
        if (!Array.isArray(data)) continue;
        const cw = chunk.width;
        const ch = chunk.height;
        const cx = chunk.x;
        const cy = chunk.y;
        for (let row = 0; row < ch; row++) {
          const gy = cy + row;
          if (gy < 0 || gy >= mapHeight) continue;
          for (let col = 0; col < cw; col++) {
            const gx = cx + col;
            if (gx < 0 || gx >= mapWidth) continue;
            const val = data[row * cw + col];
            if (val) flat[gy * mapWidth + gx] = val;
          }
        }
      }
    }

    layer.data = flat;
    layer.width = mapWidth;
    layer.height = mapHeight;
    layer.startx = 0;
    layer.starty = 0;
    delete layer.chunks;
  }

  mapData.width = mapWidth;
  mapData.height = mapHeight;
  // Keep mapData.infinite = true so the flag reaches the client/editor. Re-running
  // this is safe: once chunks are flattened away the bounds loop finds none and
  // returns early before touching layer data.
}

function processMapFile(file: string): MapData | null {
  const mapDir = path.join(assetPath, MAPS_PATH);
  const fullPath = path.join(mapDir, file);
  const parsed = tryParse(fs.readFileSync(fullPath, "utf-8"));

  if (!parsed) {
    log.error(`Failed to parse ${file} as a map`);
    return null;
  }

  const jsonString = JSON.stringify(parsed);
  const compressedData = zlib.gzipSync(jsonString);

  // Calculate checksum for map sync
  const checksum = crypto.createHash("sha256").update(jsonString).digest("hex");

  log.debug(`Loaded map: ${file}`);
  log.debug(`Compressed map: ${file}
  - Original: ${jsonString.length} bytes
  - Compressed: ${compressedData.length} bytes
  - Compression Ratio: ${(jsonString.length / compressedData.length).toFixed(2)}x
  - Compression Savings: ${(((jsonString.length - compressedData.length) / jsonString.length) * 100).toFixed(2)}%`);

  normalizeInfiniteMap(parsed);

  return {
    name: file,
    data: parsed,
    compressed: compressedData,
    checksum: checksum,
  };
}

function tryParse(data: string): any {
  try {
    return JSON.parse(data);
  } catch (e: any) {
    log.error(e);
    return null;
  }
}

export async function initializeAssets() {
  await loadTilesets();
  await loadSpriteSheetTemplates();
  await loadSprites();
  await loadIcons();
  loadAllMaps();

  const assetLoadingEndTime = performance.now();
  const totalAssetLoadingTime = (assetLoadingEndTime - assetLoadingStartTime).toFixed(2);
  log.success(`✔ All assets loaded successfully in ${totalAssetLoadingTime}ms`);
}

interface TilesetData {
  name: string;
  data: Buffer;
}

interface SpriteSheetTemplate {
  name: string;
  template: string | null;
  image: Buffer | null;
}

interface SpriteData {
  name: string;
  data: string;
}

interface IconData {
  name: string;
  data: string;
}

interface MapData {
  name: string;
  data: any;
  compressed: Buffer;
  checksum: string;
}
