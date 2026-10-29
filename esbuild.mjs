import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: {
    extension: "src/extension.ts",
    "smoke-tools": "src/smoke-tools.ts",
    "smoke-logic": "src/smoke-logic.ts",
  },
  bundle: true,
  outdir: "out",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  sourcemap: true,
  sourcesContent: false,
  minify: false,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(options);
}
