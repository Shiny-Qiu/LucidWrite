import { build } from "esbuild"

await build({
  entryPoints: ["src/web/editor/index.ts"],
  outfile: "src/web/public/editor.js",
  bundle: true,
  format: "iife",
  globalName: "LucidEditor",
  target: ["es2022"],
  minify: true,
  legalComments: "eof",
})
