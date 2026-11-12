import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: [
      "src/index.ts",
      "src/setup.ts",
      "src/transport.ts",
      "src/web.ts",
      "src/node-session.ts",
      "src/provide.ts",
      "src/bootstrap.ts",
    ],
    unbundle: true,
    platform: "neutral",
    deps: { neverBundle: ["cloudflare:workers", /^node:/] },
    dts: true,
  },
});
