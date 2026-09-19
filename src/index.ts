const now = performance.now();
import log from "./modules/logger";
import path from "path";
import zlib from "zlib";
import { startHttpsServers, getInternalServerOptions } from "./modules/https_servers";

// Load asset loader
import { initializeAssets, applyChunksWithRebase, getAssetsPath, normalizeInfiniteMap } from "./modules/assetloader";
import assetCache from "./services/assetCache";


const authKey = process.env.ASSET_SERVER_AUTH_KEY || process.env.GATEWAY_AUTH_KEY || "change-this-secret-key";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const CORS_AUDIO_ALLOW_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
};

// Extension -> MIME type for audio files served by /audio.
const AUDIO_MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
  ".opus": "audio/opus",
};
const ALLOWED_AUDIO_EXTENSIONS = Object.keys(AUDIO_MIME_TYPES);

function getAudioMimeType(fileName: string): string {
  return AUDIO_MIME_TYPES[path.extname(fileName).toLowerCase()] || "application/octet-stream";
}

function acceptsGzip(req: Request): boolean {
  return (req.headers.get("accept-encoding") || "").includes("gzip");
}

// Cache of precomputed gzip-compressed map chunk payloads. /map-chunk is the
// highest-volume browser endpoint (every client fetches dozens of chunks per
// map load), and each miss costs layer slicing + JSON.stringify + gzipSync.
// Keyed by map name + checksum so map edits invalidate naturally on write.
const chunkCache = new Map<string, Uint8Array>();
const CHUNK_CACHE_MAX_ENTRIES = 10000;

function getChunkCacheKey(mapFile: string, checksum: string, chunkX: number, chunkY: number, chunkSize: number): string {
  return `${mapFile}:${checksum}:${chunkX}:${chunkY}:${chunkSize}`;
}

function rememberChunk(key: string, data: Uint8Array) {
  chunkCache.set(key, data);
  if (chunkCache.size > CHUNK_CACHE_MAX_ENTRIES) {
    const oldestKey = chunkCache.keys().next().value;
    if (oldestKey !== undefined) chunkCache.delete(oldestKey);
  }
}

function clearChunkCacheForMap(mapName: string) {
  const mapFile = mapName.endsWith(".json") ? mapName : `${mapName}.json`;
  const prefix = `${mapFile}:`;
  for (const key of chunkCache.keys()) {
    if (key.startsWith(prefix)) chunkCache.delete(key);
  }
}

// Serialize one map chunk (tile layers sliced from the flat layer.data arrays)
// to a JSON string. Returns null for invalid chunk parameters.
function buildMapChunk(mapData: any, chunkX: number, chunkY: number, chunkSize: number): string | null {
  if (!mapData || !Array.isArray(mapData.layers) || !Number.isInteger(chunkX) || !Number.isInteger(chunkY) || !Number.isInteger(chunkSize) || chunkSize <= 0) {
    return null;
  }

  const startX = chunkX * chunkSize;
  const startY = chunkY * chunkSize;

  const chunk = {
    chunkX,
    chunkY,
    width: chunkSize,
    height: chunkSize,
    layers: [] as any[]
  };

  mapData.layers.forEach((layer: any, index: number) => {
    if (layer.type === "tilelayer" && layer.data) {
      const chunkLayerData: number[] = [];

      for (let y = 0; y < chunkSize; y++) {
        for (let x = 0; x < chunkSize; x++) {
          const mapX = startX + x;
          const mapY = startY + y;
          const mapIndex = mapY * mapData.width + mapX;

          if (mapX >= 0 && mapX < mapData.width && mapY >= 0 && mapY < mapData.height && mapIndex < layer.data.length) {
            chunkLayerData.push(layer.data[mapIndex]);
          } else {
            chunkLayerData.push(0);
          }
        }
      }

      let zIndex = layer.zIndex;
      if (zIndex === undefined) {
        zIndex = index;
      }

      chunk.layers.push({
        name: layer.name,
        zIndex: zIndex,
        data: chunkLayerData,
        width: chunkSize,
        height: chunkSize
      });
    }
  });

  return JSON.stringify(chunk);
}

// Cache keys are flat names (no separators), so anything containing a path
// separator, parent traversal, or null byte is never valid.
function isUnsafeAssetName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed === "" || trimmed.includes("\0") || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\");
}

// Decode a sprite/icon cache entry (stored at load time as gzip of base64 PNG bytes).
function decodeCachedImage(data: string): Buffer {
  const base64 = zlib.gunzipSync(Buffer.from(data, "base64")).toString("utf-8");
  return Buffer.from(base64, "base64");
}

// Decode an audio cache entry (stored at load time as gzip of raw audio bytes).
function decodeCachedAudio(data: string): Buffer {
  return zlib.gunzipSync(Buffer.from(data, "base64"));
}

// Fallback icon served when a requested icon/sprite image does not exist.
// Served from the startup cache (the "missing_icon" entry of the icons cache).
// The X-Asset-Fallback header lets clients detect the fallback and opt out
// of rendering it (e.g. spell projectiles).
async function serveMissingIcon(): Promise<Response> {
  try {
    const icons = await assetCache.get("icons") as any[] | null;
    const entry = icons?.find((i: any) => i.name === "missing_icon");
    if (entry?.data) {
      const missingIconData = decodeCachedImage(entry.data);
      return new Response(missingIconData, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          // Short TTL rather than no-cache: the placeholder is one small static
          // image requested once per missing asset, so no-cache meant every
          // missing sprite re-fetched it on every render. A few minutes still
          // lets a genuinely-added asset show up quickly.
          "Cache-Control": "public, max-age=300",
          "X-Asset-Fallback": "missing_icon",
          "Access-Control-Expose-Headers": "X-Asset-Fallback",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Content-Length": missingIconData.length.toString()
        }
      });
    }
  } catch (error: any) {
    log.error(`Error serving missing icon fallback: ${error.message}`);
  }
  return new Response(JSON.stringify({ error: "Icon not found" }), {
    status: 404,
    headers: CORS_HEADERS
  });
}

function parseRangeHeader(range: string | null, size: number): { start: number; end: number } | null {
  if (!range) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) return null;
  const startStr = match[1] ?? "";
  const endStr = match[2] ?? "";
  let start = startStr === "" ? NaN : parseInt(startStr, 10);
  let end = endStr === "" ? NaN : parseInt(endStr, 10);
  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    // Suffix range: last N bytes
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }
  if (start < 0 || end < start || start >= size) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

// Serve a raw audio buffer with correct MIME type, ETag/conditional GET,
// and Range (206 Partial Content) support so <audio> elements can seek.
function serveAudioBuffer(req: Request, fileName: string, data: Buffer): Response {
  const mime = getAudioMimeType(fileName);
  const size = data.length;
  const etag = `"${size}-${Buffer.from(fileName).toString("base64url")}"`;
  const baseHeaders: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Length": size.toString(),
    "ETag": etag,
    ...CORS_AUDIO_ALLOW_HEADERS,
  };

  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers: baseHeaders });
  }

  const range = parseRangeHeader(req.headers.get("range"), size);
  if (range) {
    const chunk = data.subarray(range.start, range.end + 1);
    return new Response(chunk, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": chunk.length.toString(),
      },
    });
  }

  return new Response(data, { status: 200, headers: baseHeaders });
}

const routes = {
  "/status": {
    GET: () => new Response(JSON.stringify({ status: "OK" }), { status: 200, headers: CORS_HEADERS })
  },
  "/tileset": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const name = url.searchParams.get("name");

      if (!name) {
        return new Response(JSON.stringify({ error: "Missing tileset name" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
        });
      }

      try {
        if (isUnsafeAssetName(name)) {
          return new Response(JSON.stringify({ error: "Invalid tileset name" }), {
            status: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
          });
        }

        // Serve from the startup cache only - everything is loaded into memory at boot.
        const cachedTilesets = await assetCache.get("tilesets") as any[] | null;
        const cachedTileset = cachedTilesets?.find((t: any) => t.name === name);
        if (cachedTileset?.data) {
          return new Response(JSON.stringify({
            name: name,
            data: cachedTileset.data
          }), {
            status: 200,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
          });
        }

        return new Response(JSON.stringify({ error: "Tileset not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
        });
      } catch (error: any) {
        log.error(`Error serving tileset: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
        });
      }
    }
  },
  "/map-chunk": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const mapName = url.searchParams.get("map");
      const chunkX = parseInt(url.searchParams.get("x") || "0");
      const chunkY = parseInt(url.searchParams.get("y") || "0");
      const chunkSize = parseInt(url.searchParams.get("size") || "25");

      if (!mapName) {
        return new Response(JSON.stringify({ error: "Missing map name" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      try {
        // Get map from cache
        const maps = await assetCache.get("maps") as any[];
        const mapFile = mapName.endsWith(".json") ? mapName : `${mapName}.json`;
        const map = maps?.find((m: any) => m.name === mapFile);

        if (!map) {
          return new Response(JSON.stringify({ error: "Map not found" }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        const wantGzip = acceptsGzip(req);

        // Serve precomputed gzip payload when available (browser fetch
        // transparently decompresses Content-Encoding: gzip).
        if (wantGzip) {
          const cacheKey = getChunkCacheKey(mapFile, map.checksum, chunkX, chunkY, chunkSize);
          const cachedChunk = chunkCache.get(cacheKey);
          if (cachedChunk) {
            return new Response(cachedChunk, {
              status: 200,
              headers: {
                ...CORS_HEADERS,
                "Content-Encoding": "gzip",
                "Vary": "Accept-Encoding"
              }
            });
          }

          // Build the chunk (existing slicing logic), compress, and cache it.
          const chunkPayload = buildMapChunk(map.data, chunkX, chunkY, chunkSize);
          if (chunkPayload === null) {
            return new Response(JSON.stringify({ error: "Invalid chunk parameters" }), {
              status: 400,
              headers: CORS_HEADERS
            });
          }
          const gz = zlib.gzipSync(chunkPayload);
          rememberChunk(cacheKey, gz);
          return new Response(gz, {
            status: 200,
            headers: {
              ...CORS_HEADERS,
              "Content-Encoding": "gzip",
              "Vary": "Accept-Encoding"
            }
          });
        }

        // Non-gzip client: build fresh (rare - all modern browsers send gzip)
        const chunkPayload = buildMapChunk(map.data, chunkX, chunkY, chunkSize);
        if (chunkPayload === null) {
          return new Response(JSON.stringify({ error: "Invalid chunk parameters" }), {
            status: 400,
            headers: CORS_HEADERS
          });
        }
        return new Response(chunkPayload, {
          status: 200,
          headers: CORS_HEADERS
        });
      } catch (error: any) {
        log.error(`Error serving map chunk: ${error.message}`);
        return new Response(JSON.stringify({ error: "Failed to fetch map chunk" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
  },
  "/map-checksums": {
    POST: async (req: Request) => {
      try {
        const body = await req.json() as { checksums: Record<string, string>; serverId: string; authKey: string };
        const { checksums, serverId, authKey: requestAuthKey } = body;
        if (requestAuthKey !== authKey) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), { status: 401, headers: CORS_HEADERS });
        }
        const maps = await assetCache.get("maps") as any[];
        if (!maps || maps.length === 0) {
          return new Response(JSON.stringify({ success: true, outdatedMaps: [] }), { status: 200, headers: CORS_HEADERS });
        }
        const outdatedMaps: any[] = [];
        for (const map of maps) {
          const mapName = map.name;
          const clientChecksum = checksums[mapName];
          const mapChecksum = map.checksum;
          if (clientChecksum !== mapChecksum) {
            outdatedMaps.push({ name: mapName, checksum: mapChecksum, data: map.data });
          }
        }
        log.info(`[AssetServer] Map sync for ${serverId}: ${outdatedMaps.length} outdated maps`);
        // Outdated maps carry full map data - this response can be megabytes.
        // gzip cuts it 80-90%; Bun's fetch on the game server decompresses
        // transparently, so no consumer changes are needed.
        const payload = JSON.stringify({ success: true, outdatedMaps });
        if (acceptsGzip(req)) {
          return new Response(zlib.gzipSync(payload), {
            status: 200,
            headers: {
              ...CORS_HEADERS,
              "Content-Encoding": "gzip",
              "Vary": "Accept-Encoding"
            }
          });
        }
        return new Response(payload, { status: 200, headers: CORS_HEADERS });
      } catch (error: any) {
        log.error(`Error in /map-checksums: ${error.message}`);
        return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400, headers: CORS_HEADERS });
      }
    }
  },
  "/update-map": {
    POST: async (req: Request) => {
      try {
        const { mapName, mapData, serverId, authKey: requestAuthKey } = await req.json() as { mapName: string; mapData: any; serverId: string; authKey: string };
        if (requestAuthKey !== authKey) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), { status: 401, headers: CORS_HEADERS });
        }
        if (!mapName || !mapData) {
          return new Response(JSON.stringify({ error: "Missing mapName or mapData" }), { status: 400, headers: CORS_HEADERS });
        }
        let maps = await assetCache.get("maps") as any[];
        if (!maps) maps = [];
        const crypto = await import("crypto");
        normalizeInfiniteMap(mapData);
        const checksum = crypto.createHash("sha256").update(JSON.stringify(mapData)).digest("hex");
        const existingIndex = maps.findIndex((m: any) => m.name === mapName);
        if (existingIndex >= 0) {
          maps[existingIndex] = { name: mapName, data: mapData, checksum: checksum };
        } else {
          maps.push({ name: mapName, data: mapData, checksum: checksum });
        }
        await assetCache.set("maps", maps);
        clearChunkCacheForMap(mapName);
        log.info(`[AssetServer] Map updated: ${mapName} by server ${serverId}`);
        return new Response(JSON.stringify({ success: true, checksum: checksum, message: "Map updated successfully" }), { status: 200, headers: CORS_HEADERS });
      } catch (error: any) {
        log.error(`Error in /update-map: ${error.message}`);
        return new Response(JSON.stringify({ error: "Failed to update map" }), { status: 500, headers: CORS_HEADERS });
      }
    }
  },
  "/save-map-chunks": {
    POST: async (req: Request) => {
      try {
        const body = await req.json() as { mapName: string; chunks: any[]; bounds?: { minTileX?: number; minTileY?: number; width?: number; height?: number; infinite?: boolean } | null; authKey: string; serverId?: string };
        const { mapName, chunks, bounds, authKey: requestAuthKey, serverId } = body;

        if (requestAuthKey !== authKey) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), { status: 401, headers: CORS_HEADERS });
        }

        if (!mapName || !chunks || !Array.isArray(chunks)) {
          return new Response(JSON.stringify({ error: "Invalid request: mapName and chunks are required" }), { status: 400, headers: CORS_HEADERS });
        }

        const pathModule = await import("path");
        const fsModule = await import("fs");
        const crypto = await import("crypto");
        const zlibModule = await import("zlib");

        const maps = (await assetCache.get("maps")) as any[] || [];
        const mapFile = mapName.endsWith(".json") ? mapName : `${mapName}.json`;
        const mapIndex = maps.findIndex((m: any) => m.name === mapFile);

        if (mapIndex === -1) {
          return new Response(JSON.stringify({ error: "Map not found" }), { status: 404, headers: CORS_HEADERS });
        }

        // Update chunks in map data, growing / re-basing the origin for
        // infinite-map expansion as needed.
        const mapData = maps[mapIndex].data;
        applyChunksWithRebase(mapData, chunks, bounds);

        // Recalculate checksum with minified JSON
        const jsonString = JSON.stringify(mapData);
        const newChecksum = crypto.createHash("sha256").update(jsonString).digest("hex");

        // Update map in cache
        maps[mapIndex] = {
          name: mapFile,
          data: mapData,
          checksum: newChecksum,
          compressed: zlibModule.gzipSync(jsonString)
        };

        await assetCache.set("maps", maps);
        clearChunkCacheForMap(mapFile);

        // Persist changes to disk
        try {
          const assetPath = getAssetsPath();
          const mapsPath = pathModule.join(assetPath, "maps");
          const mapFilePath = pathModule.join(mapsPath, mapFile);

          // Write map with minified JSON
          fsModule.writeFileSync(mapFilePath, jsonString, "utf-8");
        } catch (diskError) {
          log.warn(`[AssetServer] Failed to persist map to disk: ${diskError}`);
          // Continue anyway - map is updated in cache
        }

        return new Response(JSON.stringify({ success: true, checksum: newChecksum, message: `Saved ${chunks.length} chunk(s) for map ${mapName}` }), { status: 200, headers: CORS_HEADERS });
      } catch (error: any) {
        log.error(`Error in /save-map-chunks: ${error.message}`);
        return new Response(JSON.stringify({ error: "Failed to save map chunks" }), { status: 500, headers: CORS_HEADERS });
      }
    }
  },
  "/save-map-properties": {
    POST: async (req: Request) => {
      try {
        const body = await req.json() as { mapName: string; graveyards?: any; warps?: any; authKey: string };
        const { mapName, graveyards, warps, authKey: requestAuthKey } = body;

        if (requestAuthKey !== authKey) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), { status: 401, headers: CORS_HEADERS });
        }

        if (!mapName) {
          return new Response(JSON.stringify({ error: "Invalid request: mapName is required" }), { status: 400, headers: CORS_HEADERS });
        }

        const pathModule = await import("path");
        const fsModule = await import("fs");
        const crypto = await import("crypto");
        const zlibModule = await import("zlib");

        const maps = (await assetCache.get("maps")) as any[] || [];
        const mapFile = mapName.endsWith(".json") ? mapName : `${mapName}.json`;
        const mapIndex = maps.findIndex((m: any) => m.name === mapFile);

        if (mapIndex === -1) {
          return new Response(JSON.stringify({ error: "Map not found" }), { status: 404, headers: CORS_HEADERS });
        }

        // Update map data with graveyards and warps
        const mapData = maps[mapIndex].data;

        log.info(`[AssetServer] Before update - mapData has graveyards: ${mapData.graveyards ? 'yes' : 'no'}, warps: ${mapData.warps ? 'yes' : 'no'}`);

        if (graveyards) {
          mapData.graveyards = graveyards;
          log.info(`[AssetServer] Updated graveyards to: ${JSON.stringify(graveyards)}`);

          // Also update the Tiled object layer for graveyards
          let graveyardLayer = mapData.layers.find((l: any) => l.name === "Graveyards" && l.type === "objectgroup");
          if (!graveyardLayer) {
            graveyardLayer = {
              draworder: "topdown",
              id: Math.max(...mapData.layers.map((l: any) => l.id || 0), 0) + 1,
              name: "Graveyards",
              objects: [],
              opacity: 1,
              type: "objectgroup",
              visible: true,
              x: 0,
              y: 0
            };
            mapData.layers.push(graveyardLayer);
            log.info(`[AssetServer] Created Graveyards object layer`);
          }

          graveyardLayer.objects = graveyards.map((g: any, idx: number) => ({
            id: idx + 1,
            name: g.name,
            type: "graveyard",
            x: g.position?.x || 0,
            y: g.position?.y || 0,
            width: 0,
            height: 0,
            rotation: 0,
            visible: true,
            point: true
          }));
          log.info(`[AssetServer] Updated Graveyards object layer with ${graveyards.length} objects`);
        }

        if (warps) {
          mapData.warps = warps;
          log.info(`[AssetServer] Updated warps to: ${JSON.stringify(warps)}`);

          // Also update the Tiled object layer for warps
          let warpLayer = mapData.layers.find((l: any) => l.name === "Warps" && l.type === "objectgroup");
          if (!warpLayer) {
            warpLayer = {
              draworder: "topdown",
              id: Math.max(...mapData.layers.map((l: any) => l.id || 0), 0) + 1,
              name: "Warps",
              objects: [],
              opacity: 1,
              type: "objectgroup",
              visible: true,
              x: 0,
              y: 0
            };
            mapData.layers.push(warpLayer);
            log.info(`[AssetServer] Created Warps object layer`);
          }

          warpLayer.objects = warps.map((w: any, idx: number) => ({
            id: idx + 1,
            name: w.name,
            type: "warp",
            x: w.position?.x || 0,
            y: w.position?.y || 0,
            width: w.size?.width || 32,
            height: w.size?.height || 32,
            rotation: 0,
            visible: true,
            properties: [
              { name: "map", type: "string", value: w.map },
              { name: "x", type: "int", value: w.x },
              { name: "y", type: "int", value: w.y }
            ]
          }));
          log.info(`[AssetServer] Updated Warps object layer with ${warps.length} objects`);
        }

        log.info(`[AssetServer] After update - mapData has graveyards: ${mapData.graveyards ? 'yes' : 'no'}, warps: ${mapData.warps ? 'yes' : 'no'}`);

        // Recalculate checksum with updated data
        const jsonString = JSON.stringify(mapData);
        const newChecksum = crypto.createHash("sha256").update(jsonString).digest("hex");

        // Update map in cache
        maps[mapIndex] = {
          name: mapFile,
          data: mapData,
          checksum: newChecksum,
          compressed: zlibModule.gzipSync(jsonString)
        };

        await assetCache.set("maps", maps);
        clearChunkCacheForMap(mapFile);
        log.info(`[AssetServer] Updated cache for map: ${mapFile}`);

        // Persist changes to disk
        try {
          const assetPath = getAssetsPath();
          const mapsPath = pathModule.join(assetPath, "maps");
          const mapFilePath = pathModule.join(mapsPath, mapFile);

          log.info(`[AssetServer] Writing map to disk at: ${mapFilePath}`);
          // Write map with formatted JSON
          fsModule.writeFileSync(mapFilePath, JSON.stringify(mapData, null, 2), "utf-8");
          log.info(`[AssetServer] Successfully wrote map to disk`);
        } catch (diskError) {
          log.warn(`[AssetServer] Failed to persist map properties to disk: ${diskError}`);
          // Continue anyway - map is updated in cache
        }

        return new Response(JSON.stringify({ success: true, checksum: newChecksum, message: `Saved map properties for ${mapName}` }), { status: 200, headers: CORS_HEADERS });
      } catch (error: any) {
        log.error(`Error in /save-map-properties: ${error.message}`);
        return new Response(JSON.stringify({ error: "Failed to save map properties" }), { status: 500, headers: CORS_HEADERS });
      }
    }
  },
  "/sprite-sheet-template": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const name = url.searchParams.get("name");

      if (!name) {
        return new Response(JSON.stringify({ error: "Missing sprite sheet template name" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      try {
        const templates = await assetCache.get("spriteSheetTemplates") as any[];
        if (!templates || templates.length === 0) {
          return new Response(JSON.stringify({ error: "Sprite sheet templates not found" }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        const template = templates.find((t: any) => t.name === name);
        if (!template) {
          return new Response(JSON.stringify({ error: `Sprite sheet template "${name}" not found. Available: ${templates.map((t: any) => t.name).join(", ")}` }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        if (!template.template) {
          return new Response(JSON.stringify({ error: `Sprite sheet template "${name}" has no template data` }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        // Return the cached template JSON directly
        const templateData = typeof template.template === 'string' ? template.template : JSON.stringify(template.template);
        return new Response(templateData, {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      } catch (error: any) {
        log.error(`Error serving sprite sheet template: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
  },
  "/sprite-sheet-image": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const name = url.searchParams.get("name");

      if (!name) {
        return new Response(JSON.stringify({ error: "Missing sprite sheet image name" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      try {
        const templates = await assetCache.get("spriteSheetTemplates") as any[];
        if (!templates || templates.length === 0) {
          return new Response(JSON.stringify({ error: "Sprite sheet images not found" }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        const template = templates.find((t: any) => t.name === name);
        if (!template) {
          return new Response(JSON.stringify({ error: `Template "${name}" not found. Available: ${templates.map((t: any) => t.name).join(", ")}` }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        if (!template.image) {
          return new Response(JSON.stringify({ error: `Template "${name}" has no image data` }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        // Convert Buffer to Uint8Array if needed
        const imageData = Buffer.isBuffer(template.image) ? template.image : Buffer.from(template.image);

        // Return the cached image buffer directly as PNG
        return new Response(imageData, {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Content-Length": imageData.length.toString()
          }
        });
      } catch (error: any) {
        log.error(`Error serving sprite sheet image: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
  },
  "/sprite": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const name = url.searchParams.get("name");

      if (!name) {
        return new Response(JSON.stringify({ error: "Missing sprite name" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      try {
        // Cache keys omit the extension - accept it either way.
        const key = name.trim().replace(/\.png$/i, "");
        if (isUnsafeAssetName(key)) {
          return new Response(JSON.stringify({ error: "Invalid sprite name" }), {
            status: 400,
            headers: CORS_HEADERS
          });
        }

        // Serve from the startup cache only - everything is loaded into memory at boot.
        const sprites = await assetCache.get("sprites") as any[] | null;
        const entry = sprites?.find((s: any) => s.name === key);

        if (!entry?.data) {
          return serveMissingIcon();
        }

        const spriteData = decodeCachedImage(entry.data);
        return new Response(spriteData, {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=31536000",
            "Content-Length": spriteData.length.toString(),
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
          }
        });
      } catch (error: any) {
        log.error(`Error serving sprite: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
  },
  "/icon": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const name = url.searchParams.get("name");

      if (!name) {
        return new Response(JSON.stringify({ error: "Missing icon name" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      try {
        // Cache keys omit the extension - accept it either way.
        const key = name.trim().replace(/\.png$/i, "");
        if (isUnsafeAssetName(key)) {
          return new Response(JSON.stringify({ error: "Invalid icon name" }), {
            status: 400,
            headers: CORS_HEADERS
          });
        }

        // Serve from the startup cache only - everything is loaded into memory at boot.
        const icons = await assetCache.get("icons") as any[] | null;
        const entry = icons?.find((i: any) => i.name === key);

        if (!entry?.data) {
          return serveMissingIcon();
        }

        const iconData = decodeCachedImage(entry.data);
        return new Response(iconData, {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=31536000",
            "Content-Length": iconData.length.toString(),
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
          }
        });
      } catch (error: any) {
        log.error(`Error serving icon: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
  },
  "/audio": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const name = url.searchParams.get("name");

      if (!name) {
        return new Response(JSON.stringify({ error: "Missing audio name" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      try {
        const cleaned = name.trim().replace(/^\/+/, "");
        if (isUnsafeAssetName(cleaned)) {
          return new Response(JSON.stringify({ error: "Invalid audio name" }), {
            status: 400,
            headers: CORS_HEADERS
          });
        }

        const reqExt = path.extname(cleaned).toLowerCase();
        if (reqExt && !ALLOWED_AUDIO_EXTENSIONS.includes(reqExt)) {
          return new Response(JSON.stringify({ error: "Invalid audio name" }), {
            status: 400,
            headers: CORS_HEADERS
          });
        }

        // Serve from the startup cache only (stored as base64 gzip).
        // Accepts names with or without extension (e.g. "theme", "theme.mp3").
        const cached = await assetCache.get("audio") as any[] | null;
        const stemOf = (n: string) => n.replace(/\.[^.]*$/, "").toLowerCase();
        const entry = cached?.find((a: any) =>
          a.name === cleaned ||
          a.name.toLowerCase() === cleaned.toLowerCase() ||
          stemOf(a.name) === stemOf(cleaned)
        );
        if (!entry?.data) {
          return new Response(JSON.stringify({ error: "Audio not found" }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        const raw = decodeCachedAudio(entry.data);
        return serveAudioBuffer(req, entry.name, raw);
      } catch (error: any) {
        log.error(`Error serving audio: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    },
    HEAD: async (req: Request) => {
      // Reuse GET logic - serveAudioBuffer returns headers-only for HEAD.
      return (routes["/audio"] as any).GET(req);
    }
  },
  "/audios": {
    GET: async () => {
      try {
        // List from the startup cache only.
        const cached = await assetCache.get("audio") as any[] | null;
        return new Response(JSON.stringify({
          audio: (cached ?? []).map((a: any) => ({ name: a.name, mime: getAudioMimeType(a.name) }))
        }), {
          status: 200,
          headers: CORS_HEADERS
        });
      } catch (error: any) {
        log.error(`Error listing audio: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
  },
  "/icons": {
    GET: async () => {
      try {
        // Names only; editors fetch each image from /icon?name=...
        const cached = await assetCache.get("icons") as any[] | null;
        return new Response(JSON.stringify({
          icons: (cached ?? []).map((i: any) => ({ name: i.name }))
        }), {
          status: 200,
          headers: CORS_HEADERS
        });
      } catch (error: any) {
        log.error(`Error listing icons: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
  },
  "/sprite-sheets": {
    GET: async (req: Request) => {
      try {
        const templates = await assetCache.get("spriteSheetTemplates") as any[];
        if (!templates || templates.length === 0) {
          return new Response(JSON.stringify({ spriteSheets: [] }), {
            status: 200,
            headers: CORS_HEADERS
          });
        }

        // Equipment sheets are strips of frames; editors show the matching item
        // icon instead when one exists ("wooden staff" -> "wooden_staff").
        const icons = (await assetCache.get("icons") as any[]) || [];
        const iconNames = new Set(icons.map((i: any) => String(i.name).toLowerCase()));
        const iconFor = (name: string): string | null => {
          for (const candidate of [name, name.replace(/ /g, "_"), name.replace(/_/g, " ")]) {
            if (iconNames.has(candidate.toLowerCase())) return candidate;
          }
          return null;
        };

        const spriteSheets = templates.map((t: any) => ({
          name: t.name,
          slot: t.slot || "other",
          icon: iconFor(t.name),
          hasTemplate: t.template !== null,
          hasImage: t.image !== null
        }));

        return new Response(JSON.stringify({ spriteSheets }), {
          status: 200,
          headers: CORS_HEADERS
        });
      } catch (error: any) {
        log.error(`Error listing sprite sheets: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
  },
} as Record<string, any>;

const serverPort = parseInt(process.env.WEBSRV_INTERNAL_PORT || "") || 8082;

Bun.serve({
    hostname: "127.0.0.1",
    port: serverPort,
    development: false,
    reusePort: true,
    ...getInternalServerOptions(process.env.TLS_CERT_PATH!, process.env.TLS_KEY_PATH!, process.env.TLS_CA_PATH),
  async fetch(req: Request, server: any) {
    const url = tryParseURL(req.url);
    if (!url) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }
    const address = server.requestIP(req);
    if (!address) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }

    const route = routes[url.pathname as keyof typeof routes];
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Block potentially dangerous HTTP methods
    if (req.method === "CONNECT" || req.method === "TRACE" || req.method === "TRACK") {
      return new Response("Forbidden", { status: 403 });
    }

    // Restrict direct ip access to the webserver (only in production)
    if (process.env.DOMAIN && process.env.DOMAIN !== "http://localhost" && process.env.DOMAIN?.replace(/https?:\/\//, "") !== url.host) {
      log.debug(`Domain mismatch: expected "${process.env.DOMAIN?.replace(/https?:\/\//, "")}", got "${url.host}"`);
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }

    // If route exists, handle it
    if (route) {
      const handler = route[req.method as keyof typeof route] ?? (req.method === "HEAD" ? route["GET"] : undefined);
      if (handler) return handler(req);
    }

    // API routes should NOT fall back to static file serving
    const apiRoutes = ["/icon", "/sprite", "/sprite-sheet-template", "/sprite-sheet-image", "/tileset", "/map-chunk", "/audio", "/audios"];
    if (apiRoutes.includes(url.pathname)) {
      return new Response(JSON.stringify({ error: "Route not found" }), {
        status: 404,
        headers: CORS_HEADERS
      });
    }

    // All assets are served from the startup cache via the routes above -
    // there is intentionally no static file fallback to disk.
    // Unknown routes redirect to homepage
    return Response.redirect("/", 301);
  },
});

startHttpsServers({
  name: "Asset Server",
  sslEnabled: process.env.HTTP_USE_SSL === "true",
  httpPort: parseInt(process.env.WEBSRV_PORT || "") || 80,
  httpsPort: parseInt(process.env.WEBSRV_PORTSSL || "") || 443,
  internalPort: serverPort,
  certPath: process.env.TLS_CERT_PATH,
  keyPath: process.env.TLS_KEY_PATH,
  caPath: process.env.TLS_CA_PATH,
  log,
});

function tryParseURL(url: string) : URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// Initialize assets (tilesets and maps)
await initializeAssets();

const readyTimeMs = performance.now() - now;
log.success(`Asset Server ready in ${(readyTimeMs / 1000).toFixed(3)}s (${readyTimeMs.toFixed(0)}ms)`);