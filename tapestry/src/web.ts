import { ApiError, object, type JsonObject } from "./http.js";

export type WebPage = { html: string; data: Record<string, unknown> };

/** Decode HTML entities once. JSON in Tapestry's hidden divs is HTML-escaped. */
function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|quot|apos|amp|lt|gt);/gi, (entity, key: string) => {
    if (key.startsWith("#")) {
      const code = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return (
      ({ quot: '"', apos: "'", amp: "&", lt: "<", gt: ">" } as Record<string, string>)[key] ??
      entity
    );
  });
}

export function parsePage(html: string): WebPage {
  const data: Record<string, unknown> = {};
  const pattern =
    /<div\b[^>]*data-(?:modern-)?javascript-function-id=["']([\w-]+)["'][^>]*>([\s\S]*?)<\/div>/g;
  for (const match of html.matchAll(pattern)) {
    try {
      data[match[1]] = JSON.parse(decode(match[2].trim()));
    } catch {
      throw new ApiError("Tapestry", 200, "invalid-web-page-data");
    }
  }
  return { html, data };
}

export function webConfig(page: WebPage): JsonObject {
  const config = page.data.tapestry3;
  if (!object(config) || typeof config.csrfToken !== "string" || !object(config.authenticatedUser))
    throw new ApiError("Tapestry", 200, "missing-web-session");
  return config;
}
