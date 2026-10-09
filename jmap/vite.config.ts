import { defineConfig } from "vite-plus";

export default defineConfig({
  // `vp pack`: one ESM file and its declarations, with jmap-jam compiled in. The platform loads a
  // package from its tarball and installs none of its dependencies, so the output imports no
  // package: `onlyImport: []` fails the build if it would.
  pack: {
    entry: ["src/index.ts"],
    platform: "neutral",
    dts: true,
    deps: { onlyBundle: ["jmap-jam"], onlyImport: [] },
  },
});
