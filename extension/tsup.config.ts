import { defineConfig } from "tsup";
import { sassPlugin } from "esbuild-sass-plugin";
import * as fs from "fs";

export default defineConfig({
  entry: {
    loader: "src/loader.ts",
    content: "src/content.tsx",
    popup: "src/popup.ts",
    sidepanel: "src/sidepanel.ts",
    background: "src/background.ts",
  },
  format: ["iife"], // Extensions need IIFE for content scripts
  outDir: "dist",
  clean: true,
  dts: false,
  minify: true,
  sourcemap: false,
  splitting: false,
  // We need to bundle React because it's not available in the host page
  noExternal: ["agentation", "react", "react-dom"],
  esbuildPlugins: [sassPlugin()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  async onSuccess() {
    // Rename <entry>.global.js to <entry>.js
    for (const name of ["loader", "content", "popup", "sidepanel", "background"]) {
      if (fs.existsSync(`dist/${name}.global.js`)) {
        fs.renameSync(`dist/${name}.global.js`, `dist/${name}.js`);
        console.log(`Renamed ${name}.global.js to ${name}.js`);
      }
    }
    
    // Copy manifest.json to dist. For self-hosted installs, EXTENSION_UPDATE_URL
    // (your update.xml) is added at build time so it never lives in the repo.
    const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf-8"));
    if (process.env.EXTENSION_UPDATE_URL) {
      manifest.update_url = process.env.EXTENSION_UPDATE_URL;
    }
    fs.writeFileSync("dist/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    console.log(`Copied manifest.json to dist${manifest.update_url ? " (with update_url)" : ""}`);

    // Copy static files to dist
    for (const file of ["popup.html", "sidepanel.html", "managed_schema.json"]) {
      fs.copyFileSync(`src/${file}`, `dist/${file}`);
      console.log(`Copied ${file} to dist`);
    }
    
    // Copy icon if it exists
    if (fs.existsSync("src/icon.png")) {
      fs.copyFileSync("src/icon.png", "dist/icon.png");
      console.log("Copied icon.png to dist");
    }
  },
});
