import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/cli.ts"],
    unbundle: true,
    platform: "neutral",
    deps: { neverBundle: [/^node:/] },
    dts: true,
  },
});
