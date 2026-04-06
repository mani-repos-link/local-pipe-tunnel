import { readFile } from "node:fs/promises";

const ASSET_ROOT = new URL("./dashboard/", import.meta.url);

const ASSETS = {
  "/dashboard/app.js": {
    fileName: "app.js",
    contentType: "application/javascript; charset=utf-8",
    cacheControl: "private, max-age=300",
  },
  "/dashboard/styles.css": {
    fileName: "styles.css",
    contentType: "text/css; charset=utf-8",
    cacheControl: "private, max-age=300",
  },
};

const assetCache = new Map();

async function loadAsset(fileName) {
  if (assetCache.has(fileName)) {
    return assetCache.get(fileName);
  }

  const body = await readFile(new URL(fileName, ASSET_ROOT), "utf8");
  assetCache.set(fileName, body);
  return body;
}

export async function getDashboardDocument() {
  return {
    body: await loadAsset("index.html"),
    contentType: "text/html; charset=utf-8",
    cacheControl: "no-store",
  };
}

export async function getDashboardAsset(pathname) {
  const asset = ASSETS[pathname];

  if (!asset) {
    return null;
  }

  return {
    body: await loadAsset(asset.fileName),
    contentType: asset.contentType,
    cacheControl: asset.cacheControl,
  };
}
