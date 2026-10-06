import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/setup.ts", "src/transport.ts"],
    unbundle: true,
    platform: "neutral",
    deps: { neverBundle: ["cloudflare:workers", "node:url"] },
    dts: true,
  },
});
