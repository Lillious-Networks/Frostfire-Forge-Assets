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
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
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
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
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
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
        });
      } catch (error: any) {
        log.error(`Error serving map chunk: ${error.message}`);
        return new Response(JSON.stringify({ error: "Failed to fetch map chunk" }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
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
} as Record<string, any>;

const serverPort = _https ? (parseInt(process.env.WEBSRV_PORTSSL || "") || 443) : (parseInt(process.env.WEBSRV_PORT || "") || 80);

Bun.serve({
    hostname: "0.0.0.0",
    port: serverPort,
    reusePort: false,
    routes: {
      "/tileset": routes["/tileset"],
      "/map-chunk": routes["/map-chunk"],
      "/map-checksums": routes["/map-checksums"],
      "/update-map": routes["/update-map"],
      "/save-map-chunks": routes["/save-map-chunks"],
    },
  async fetch(req: Request, server: any) {
    const url = tryParseURL(req.url);
    if (!url) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }
    const address = server.requestIP(req);
    if (!address) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }
    const ip = address.address;
    log.debug(`Received request: ${req.method} ${req.url} from ${ip}`);
    // Block potentially dangerous HTTP methods
    if (req.method === "CONNECT" || req.method === "TRACE" || req.method === "TRACK" || req.method === "OPTIONS") {
      return new Response("Forbidden", { status: 403 });
    }

    // Restrict direct ip access to the webserver (only in production)
    if (process.env.DOMAIN && process.env.DOMAIN !== "http://localhost" && process.env.DOMAIN?.replace(/https?:\/\//, "") !== url.host) {
      log.debug(`Domain mismatch: expected "${process.env.DOMAIN?.replace(/https?:\/\//, "")}", got "${url.host}"`);
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }

    const route = routes[url.pathname as keyof typeof routes];

    // If route exists, handle it
    if (route) {
      return route[req.method as keyof typeof route]?.(req);
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