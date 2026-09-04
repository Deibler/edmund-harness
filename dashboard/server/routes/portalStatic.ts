import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Hono } from "hono";

/**
 * Static files for the USER portal, mounted on both listeners:
 *   /portal/assets/<file>   the built SPA's hashed bundles (dashboard/user-web/dist)
 *   /brand/icon.png         the square mark (home-screen icon / favicon)
 *   /brand/logo.png         the wide wordmark
 * Nothing here is personal: bundles and brand art are the same for everyone,
 * so they need no token. Only a bare filename is honoured — no paths.
 */
export function portalStaticRoutes(p: { distDir: string; mediaDir: string }): Hono {
  const app = new Hono();
  const assetsDir = resolve(p.distDir, "assets");

  app.get("/portal/assets/:file", (c) => {
    const name = basename(c.req.param("file"));
    const abs = join(assetsDir, name);
    if (!abs.startsWith(assetsDir) || !existsSync(abs) || !statSync(abs).isFile()) {
      return c.text("not found", 404);
    }
    return new Response(Bun.file(abs), {
      headers: {
        // Vite names bundles by content hash, so they can be cached forever.
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  const brand: Record<string, string> = {
    "icon.png": join(p.mediaDir, "logo-small.png"),
    "logo.png": join(p.mediaDir, "logo.png"),
  };
  app.get("/brand/:file", (c) => {
    const abs = brand[basename(c.req.param("file"))];
    if (!abs || !existsSync(abs)) return c.text("not found", 404);
    return new Response(Bun.file(abs), {
      headers: { "Cache-Control": "public, max-age=86400", "Content-Type": "image/png" },
    });
  });

  return app;
}

/** The SPA shell, or null when the portal has not been built. */
export function portalIndexHtml(distDir: string): string | null {
  const p = join(distDir, "index.html");
  return existsSync(p) ? p : null;
}
