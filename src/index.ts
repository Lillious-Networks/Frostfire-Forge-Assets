const now = performance.now();
import log from "./modules/logger";
import path from "path";
import fs from "fs";
import zlib from "zlib";

// Load asset loader
import { initializeAssets } from "./modules/assetloader";
import assetCache from "./services/assetCache";


const _cert = process.env.WEBSRV_CERT_PATH || path.join(import.meta.dir, "./src/certs/webserver/cert.pem");
const _key = process.env.WEBSRV_KEY_PATH || path.join(import.meta.dir, "./src/certs/webserver/key.pem");
const _ca = process.env.WEBSRV_CA_PATH || path.join(import.meta.dir, "./src/certs/webserver/cert.ca-bundle");
const _https = process.env.WEBSRV_USESSL === "true" && fs.existsSync(_cert) && fs.existsSync(_key);
const authKey = process.env.ASSET_SERVER_AUTH_KEY || process.env.GATEWAY_AUTH_KEY || "change-this-secret-key";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

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
        const tilesetDir = path.resolve(import.meta.dir, "assets", "tilesets");
        const tilesetPath = path.resolve(tilesetDir, name);

        // Prevent path traversal attacks - ensure resolved path is within tilesets directory
        const relativePath = path.relative(tilesetDir, tilesetPath);
        if (relativePath.startsWith("..")) {
          return new Response(JSON.stringify({ error: "Invalid tileset name" }), {
            status: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
          });
        }

        if (!fs.existsSync(tilesetPath)) {
          return new Response(JSON.stringify({ error: "Tileset not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
          });
        }

        const tilesetData = fs.readFileSync(tilesetPath);
        const compressedData = zlib.gzipSync(tilesetData);
        const base64Data = compressedData.toString("base64");

        return new Response(JSON.stringify({
          name: name,
          data: base64Data
        }), {
          status: 200,
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

        // Extract chunk from map data
        const mapData = map.data;
        const startX = chunkX * chunkSize;
        const startY = chunkY * chunkSize;

        const chunk = {
          chunkX,
          chunkY,
          width: chunkSize,
          height: chunkSize,
          layers: [] as any[]
        };

        // Extract chunk data from each layer
        mapData.layers.forEach((layer: any, index: number) => {
          if (layer.type === "tilelayer" && layer.data) {
            const chunkLayerData: number[] = [];

            for (let y = 0; y < chunkSize; y++) {
              for (let x = 0; x < chunkSize; x++) {
                const mapX = startX + x;
                const mapY = startY + y;
                const mapIndex = mapY * mapData.width + mapX;

                if (mapIndex < layer.data.length) {
                  chunkLayerData.push(layer.data[mapIndex]);
                } else {
                  chunkLayerData.push(0);
                }
              }
            }

            // Get zIndex from layer properties or use layer index as fallback
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

        return new Response(JSON.stringify(chunk), {
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
        return new Response(JSON.stringify({ success: true, outdatedMaps }), { status: 200, headers: CORS_HEADERS });
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
        const checksum = crypto.createHash("sha256").update(JSON.stringify(mapData)).digest("hex");
        const existingIndex = maps.findIndex((m: any) => m.name === mapName);
        if (existingIndex >= 0) {
          maps[existingIndex] = { name: mapName, data: mapData, checksum: checksum };
        } else {
          maps.push({ name: mapName, data: mapData, checksum: checksum });
        }
        await assetCache.set("maps", maps);
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
        const body = await req.json() as { mapName: string; chunks: any[]; authKey: string; serverId?: string };
        const { mapName, chunks, authKey: requestAuthKey, serverId } = body;

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

        // Update chunks in map data
        const mapData = maps[mapIndex].data;
        for (const chunk of chunks) {
          const { chunkX, chunkY, width: chunkWidth, height: chunkHeight, layers } = chunk;
          const startX = chunkX * chunkWidth;
          const startY = chunkY * chunkHeight;

          for (const chunkLayer of layers) {
            const mapLayer = mapData.layers.find((l: any) => l.name === chunkLayer.name);
            if (mapLayer && mapLayer.data) {
              for (let y = 0; y < chunkHeight; y++) {
                for (let x = 0; x < chunkWidth; x++) {
                  const chunkIndex = y * chunkWidth + x;
                  const mapX = startX + x;
                  const mapY = startY + y;
                  const mapIndex = mapY * mapLayer.width + mapX;
                  if (mapIndex < mapLayer.data.length && chunkIndex < chunkLayer.data.length) {
                    mapLayer.data[mapIndex] = chunkLayer.data[chunkIndex];
                  }
                }
              }
            } else if (!mapLayer) {
              log.warn(`[AssetServer] Layer "${chunkLayer.name}" not found in map, skipping`);
            }
          }
        }

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

        // Persist changes to disk
        try {
          const assetPath = pathModule.join(import.meta.dir, "assets");
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
        log.info(`[AssetServer] Updated cache for map: ${mapFile}`);

        // Persist changes to disk
        try {
          const assetPath = pathModule.join(import.meta.dir, "assets");
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
        // Serve sprite PNG files directly from sprites directory
        const spritePath = path.resolve(import.meta.dir, "assets", "sprites", `${name}.png`);

        // Prevent path traversal attacks
        const relativePath = path.relative(path.resolve(import.meta.dir, "assets", "sprites"), spritePath);
        if (relativePath.startsWith("..")) {
          return new Response(JSON.stringify({ error: "Invalid sprite name" }), {
            status: 400,
            headers: CORS_HEADERS
          });
        }

        if (!fs.existsSync(spritePath)) {
          return new Response(JSON.stringify({ error: "Sprite not found" }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        const spriteData = fs.readFileSync(spritePath);
        return new Response(spriteData, {
          status: 200,
          headers: {
            "Cache-Control": "public, max-age=31536000",
            ...CORS_HEADERS
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
        const iconPath = path.resolve(import.meta.dir, "assets", "icons", `${name}.png`);

        // Prevent path traversal attacks
        const relativePath = path.relative(path.resolve(import.meta.dir, "assets", "icons"), iconPath);
        if (relativePath.startsWith("..")) {
          return new Response(JSON.stringify({ error: "Invalid icon name" }), {
            status: 400,
            headers: CORS_HEADERS
          });
        }

        if (!fs.existsSync(iconPath)) {
          return new Response(JSON.stringify({ error: "Icon not found" }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        const iconData = fs.readFileSync(iconPath);
        return new Response(iconData, {
          status: 200,
          headers: {
            "Cache-Control": "public, max-age=31536000",
            ...CORS_HEADERS
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

        const spriteSheets = templates.map((t: any) => ({
          name: t.name,
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

const serverPort = _https ? (parseInt(process.env.WEBSRV_PORTSSL || "") || 443) : (parseInt(process.env.WEBSRV_PORT || "") || 80);

Bun.serve({
    hostname: "0.0.0.0",
    port: serverPort,
    reusePort: false,
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
    // Block potentially dangerous HTTP methods
    if (req.method === "CONNECT" || req.method === "TRACE" || req.method === "TRACK" || req.method === "OPTIONS") {
      return new Response("Forbidden", { status: 403 });
    }

    // Restrict direct ip access to the webserver (only in production)
    if (process.env.DOMAIN && process.env.DOMAIN !== "http://localhost" && process.env.DOMAIN?.replace(/https?:\/\//, "") !== url.host) {
      log.debug(`Domain mismatch: expected "${process.env.DOMAIN?.replace(/https?:\/\//, "")}", got "${url.host}"`);
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }

    // If route exists, handle it
    if (route) {
      return route[req.method as keyof typeof route]?.(req);
    }

    // API routes should NOT fall back to static file serving
    const apiRoutes = ["/icon", "/sprite", "/sprite-sheet-template", "/sprite-sheet-image", "/tileset", "/map-chunk"];
    if (apiRoutes.includes(url.pathname)) {
      return new Response(JSON.stringify({ error: "Route not found" }), {
        status: 404,
        headers: CORS_HEADERS
      });
    }

    // Try to serve as static file from assets directory
    try {
      const assetPath = path.join(import.meta.dir, "assets", url.pathname.replace(/^\//, ""));

      if (fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
        const fileContent = fs.readFileSync(assetPath);
        return new Response(fileContent, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" }
        });
      }
    } catch (e) {
      log.error(`Static file error: ${e}`);
    }

    // Assets (map-chunk, tileset, music) should be requested via WebSocket from game server
    // Unknown routes redirect to homepage
    return Response.redirect("/", 301);
  },
  ...(_https ? {
      tls: {
        cert: fs.existsSync(_ca)
          ? fs.readFileSync(_cert) + "\n" + fs.readFileSync(_ca)
          : fs.readFileSync(_cert),
        key: fs.readFileSync(_key),
      }
    }
  : {}),
});
// If HTTPS is enabled, also start an HTTP server that redirects to HTTPS
if (_https) {
  Bun.serve({
    hostname: "0.0.0.0",
    port: process.env.WEBSRV_PORT || 80,
    fetch(req: Request) {
      const url = tryParseURL(req.url);
      if (!url) {
        return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
      }
      // Always redirect to https with same host/path/query
      // If the port is 443, don't include it in the redirect
      const port = process.env.WEBSRV_PORTSSL === "443" ? "" : `:${process.env.WEBSRV_PORTSSL || 443}`;
      return Response.redirect(`https://${url.hostname}${port}${url.pathname}${url.search}`, 301);
    }
  });
}

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
log.success(`Webserver started on port ${serverPort} (${_https ? "HTTPS" : "HTTP"}) - Ready in ${(readyTimeMs / 1000).toFixed(3)}s (${readyTimeMs.toFixed(0)}ms)`);