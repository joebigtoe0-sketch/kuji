import fs from "node:fs";
import path from "node:path";
import { cfg } from "./config.js";

/**
 * Brand assets are drop-in: put files in public/img/ and they are picked up.
 * Nothing is required — every slot falls back to the CSS wordmark or is
 * simply omitted — so the site never renders a broken image.
 *
 *   public/img/logo.png      the square mark. Favicon + social preview,
 *                            and the header icon next to the wordmark.
 *   public/img/wordmark.png  horizontal lockup. REPLACES the text wordmark
 *                            in the header when present.
 *   public/img/og.png        social preview override (1200x630 ideal).
 *                            Falls back to logo.png.
 *
 * Any of .png .svg .webp .jpg works; first match wins.
 */

const IMG_DIR = path.join(cfg.root, "public", "img");
const EXTS = [".png", ".svg", ".webp", ".jpg", ".jpeg"];

function find(base: string): string | undefined {
  for (const ext of EXTS) {
    if (fs.existsSync(path.join(IMG_DIR, base + ext))) return `/img/${base}${ext}`;
  }
  return undefined;
}

/** Re-read on each request in dev so a dropped file shows up without a restart. */
export function brand(): { logo?: string; wordmark?: string; og?: string } {
  const logo = find("logo");
  return { logo, wordmark: find("wordmark"), og: find("og") ?? logo };
}
