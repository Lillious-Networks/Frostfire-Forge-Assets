<p align="center">
  <img src="../../blob/main/logo.png?raw=true">
</p>

<h1 align="center">🧊🔥 Frostfire Forge Assets 🔥🧊</h1>

<p align="center">
  <strong>Centralized Asset Server for Frostfire Forge MMO Engine</strong>
</p>

<p align="center">
Frostfire Forge Assets is a dedicated server for managing and distributing game assets in the Frostfire Forge MMO platform. It provides a centralized repository for maps, sprites, animations, and game resources with real-time update capabilities for collaborative world building.
</p>

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/Lillious-Networks/Frostfire-Forge-Assets/release.yml?branch=main&label=Docker&style=flat-square" alt="Docker">
  <img src="https://img.shields.io/badge/status-Alpha-yellow?style=flat-square&label=Status" alt="Work in Progress">
  <img src="https://img.shields.io/github/license/Lillious-Networks/Frostfire-Forge-Assets?style=flat-square&label=License" alt="License">
  <img src="https://img.shields.io/github/stars/Lillious-Networks/Frostfire-Forge-Assets?style=flat-square&label=Stars" alt="GitHub Stars">
</p>

---

> [!NOTE]
> **Project Status**: This project is currently a **work in progress**
>
> **Core Development Team**: [Lillious](https://github.com/Lillious), [Deph0](https://github.com/Deph0)
>
> **Community**: [Join our Discord](https://discord.gg/4spUbuXBvZ)

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Requirements](#-requirements)
- [Architecture](#-architecture)
  - [Asset Management](#asset-management)
  - [Map Data Persistence](#map-data-persistence)
- [Quick Start](#-quick-start)
  - [Development Setup](#development-setup)
  - [Production Setup](#production-setup)
  - [Docker Deployment](#docker-deployment)
- [Environment Variables](#-environment-variables)
- [API Documentation](#-api-documentation)
  - [Map Endpoints](#map-endpoints)
  - [Sprite Endpoints](#sprite-endpoints)
  - [Asset Endpoints](#asset-endpoints)
  - [Authentication](#authentication)

---

## 📖 Overview

The Frostfire Forge Asset Server is a required component of the Frostfire Forge MMO platform. It serves as the centralized distribution point for all game assets and data, including:

- **Map Data** - Complete tile maps with collision layers, spawn points, and environmental data
- **Sprites & Animations** - Character sprites, item graphics, NPC sprites, and animation frames
- **Game Resources** - Particle effects, NPC definitions, quest data, items, spells, and mounts
- **Real-time Updates** - Support for collaborative world building with persistent storage of tile editor changes

The asset server is designed to work in conjunction with the [Frostfire Forge Gateway](https://github.com/Lillious-Networks/Frostfire-Forge-Gateway) and [Frostfire Forge Game Engine](https://github.com/Lillious-Networks/Frostfire-Forge).

---

## 🔧 Requirements

> [!IMPORTANT]
> **Required Software**:
> - [Bun](https://bun.sh/) - JavaScript runtime & package manager
> - [Frostfire Forge Game Engine](https://github.com/Lillious-Networks/Frostfire-Forge) - Game server that requests assets
> - [Docker](https://www.docker.com/) (Optional) - For containerized deployment

---

## 🏗️ Architecture

### Asset Management

The asset server maintains an in-memory cache of all game assets loaded from disk. Assets are organized hierarchically:

- **Maps** - Tile-based map data with multiple layers (terrain, collision, decorative)
- **Sprites & Animations** - Sprite sheets and frame definitions for animated objects
- **Game Data** - NPCs, quests, items, spells, particles, and mounts

Assets are loaded on server startup and can be reloaded dynamically without restarting the service.

### Map Data Persistence

Maps are stored as JSON files and can be edited through the game's tile editor. When changes are made:

1. The game engine sends updated chunk data to the asset server
2. The asset server updates the in-memory cache
3. Changes are persisted to disk immediately
4. The game engine's collision cache is refreshed for immediate gameplay updates

This enables collaborative world building with instant persistence and real-time synchronization across game servers.

---

## ⚙️ Environment Variables

```bash
# Server Configuration
ASSET_PORT=8000                           # HTTP server port
ASSET_HOST=0.0.0.0                       # Server host (0.0.0.0 = accessible from all interfaces)
WEBSRV_PORT=8000                         # Web server port (typically same as ASSET_PORT)
WEBSRV_PORTSSL=8443                      # HTTPS port
WEBSRV_USESSL=false                      # Enable SSL/TLS

# SSL Certificates (if WEBSRV_USESSL=true)
WEBSRV_CERT_PATH=./src/certs/cert.pem
WEBSRV_KEY_PATH=./src/certs/key.pem
WEBSRV_CA_PATH=./src/certs/cert.ca-bundle

# CORS Configuration (Security)
CORS_ALLOWED_ORIGINS="http://localhost:3000,http://localhost:8000" # Comma-separated list of allowed origins

# Authentication
ASSET_SERVER_AUTH_KEY="your_secret_key"   # Shared secret for request authentication
```

---

## 🚀 Quick Start

### Development Setup

**Option 1: Use prebuilt Docker image:**
```bash
docker run -d --name frostfire-assets-dev -p 8000:8000 ghcr.io/lillious-networks/frostfire-forge-assets-dev:latest
```

**Option 2: Build and run from source:**
```bash
bun development
```

**Optional: Update `.env.development` before running**

The asset server will load all assets from the `src/assets/` directory on startup.

---

### Production Setup

**Update the `.env.production` file**

Configure your production environment variables including SSL certificates if needed.

**Start the production server:**
```bash
bun production
```

---

## 🐳 Docker Deployment

### Development Compose

```bash
# Start with docker-compose
docker compose -f src/docker/docker-compose.dev.yml up -d

# View logs
docker compose -f src/docker/docker-compose.dev.yml logs -f

# Stop
docker compose -f src/docker/docker-compose.dev.yml down
```

### Production Compose

```bash
# Start with docker-compose
docker compose -f src/docker/docker-compose.prod.yml up -d

# View logs
docker compose -f src/docker/docker-compose.prod.yml logs -f

# Stop
docker compose -f src/docker/docker-compose.prod.yml down
```

### NPM Commands

```bash
# Development
npm run docker:dev              # Start dev container
npm run docker:dev:logs         # View logs
npm run docker:dev:rebuild      # Rebuild and restart
npm run docker:dev:down         # Stop dev container

# Production
npm run docker:prod             # Start prod container
npm run docker:prod:logs        # View logs
npm run docker:prod:rebuild     # Rebuild and restart
npm run docker:prod:down        # Stop prod container
```

---

### Authentication

All endpoints require authentication via the `Authorization` header with the Bearer token matching the `ASSET_SERVER_AUTH_KEY` environment variable.

**Example:**
```bash
curl -H "Authorization: Bearer your_secret_key" http://localhost:8000/maps
```

If authentication fails, the server responds with a `401 Unauthorized` status.

---

## 🔄 Integration with Game Engine

The asset server is designed to work seamlessly with the Frostfire Forge Game Engine:

1. **Startup** - Game engine requests all assets from the asset server on initialization
2. **Map Loading** - Map data is fetched and cached in-memory with collision layers compressed
3. **Live Updates** - Tile editor changes are sent to the asset server and immediately reflected in-game
4. **Persistent Storage** - All asset changes are saved to disk for recovery and sharing

For game engine integration details, see the [Frostfire Forge documentation](https://github.com/Lillious-Networks/Frostfire-Forge).

---

<p align="center">
  <sub>Built with ❤️ by the Frostfire Forge Team</sub>
</p>
