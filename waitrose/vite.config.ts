import { defineConfig } from "vite-plus";

export default defineConfig({
  // `vp pack`: one ESM file and its declarations per source file, as the package ships
  pack: {
    entry: ["src/index.ts"],
    unbundle: true,
    platform: "neutral",
    dts: true,
  },
  test: {
    // `Waitrose` extends workerd's RpcTarget, which Node has not: the tests load the shipped module
    // with a bare stand-in, so they reach `waitrose()` and the target's methods
    alias: {
      "cloudflare:workers": new URL("./test/cloudflare-workers.ts", import.meta.url).pathname,
    },
  },
});
