import { readFileSync } from "node:fs";

export const name = "dsh-plugin-logo";

const ASSETS = Object.freeze({
  "/logo/mark": readFileSync(new URL("../assets/mon3tr-logo.svg", import.meta.url)),
  "/logo/wordmark": readFileSync(new URL("../assets/mon3tr-wordmark.svg", import.meta.url))
});

function sendNotFound(res) {
  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "not found" }));
}

/** Serve one of the bundled Mon3tr SVG assets. */
export function handleLogoAsset(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }
  const pathname = new URL(req.url ?? "/", "http://dsh.local").pathname;
  const asset = ASSETS[pathname];
  if (!asset) {
    sendNotFound(res);
    return;
  }
  res.writeHead(200, {
    "content-type": "image/svg+xml",
    "cache-control": "public, max-age=31536000, immutable",
    "content-length": String(asset.byteLength)
  });
  res.end(req.method === "HEAD" ? undefined : asset);
}

export function apply(ctx) {
  ctx.inject(["webServer"], (httpCtx) => {
    httpCtx.effect(
      () => httpCtx.webServer.register({ kind: "prefix", path: "/logo", handler: handleLogoAsset }),
      "dsh-plugin-logo: asset routes"
    );
  });
}
