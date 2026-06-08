import { defineConfig } from "tsup";
import { sassPlugin } from "esbuild-sass-plugin";
import * as fs from "fs";

export default defineConfig({
  entry: {
    content: "src/content.tsx",
    popup: "src/popup.ts",
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
    // Rename content.global.js to content.js
    if (fs.existsSync("dist/content.global.js")) {
      fs.renameSync("dist/content.global.js", "dist/content.js");
      console.log("Renamed content.global.js to content.js");
    }
    
    // Rename popup.global.js to popup.js
    if (fs.existsSync("dist/popup.global.js")) {
      fs.renameSync("dist/popup.global.js", "dist/popup.js");
      console.log("Renamed popup.global.js to popup.js");
    }
    
    // Copy manifest.json to dist
    fs.copyFileSync("manifest.json", "dist/manifest.json");
    console.log("Copied manifest.json to dist");

    // Copy popup.html to dist
    fs.copyFileSync("src/popup.html", "dist/popup.html");
    console.log("Copied popup.html to dist");
    
    // Copy icon if it exists
    if (fs.existsSync("src/icon.png")) {
      fs.copyFileSync("src/icon.png", "dist/icon.png");
      console.log("Copied icon.png to dist");
    }
  },
});
