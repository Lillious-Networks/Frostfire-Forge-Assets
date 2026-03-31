import path from "path";
import fs from "fs";
import log from "./logger";
import assetCache from "../services/assetCache";
import zlib from "zlib";
import crypto from "crypto";

const assetPath = path.join(import.meta.dir, "..", "assets");
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
      // Helmet and shoulderguards use armor_head_base
      if (dirPath.includes('helmet') || dirPath.includes('shoulderguards')) {
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
      templateName = dirPath.includes('helmet') || dirPath.includes('shoulderguards') ? 'armor_head_base' : 'armor_body_base';
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
