import esbuild from "esbuild";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2018",
  platform: "browser",
  logLevel: "info",
  treeShaking: true,
  sourcemap: prod ? false : "inline",
  minify: prod,
  outfile: "main.js",
};

if (prod) {
  await esbuild.build(options);
  console.log("✓ production build → main.js");
} else {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("watching for changes…");
}
