import { defineConfig, type Options } from "tsup";
import * as sass from "sass";
import postcss, { type AtRule, type Plugin as PostcssPlugin } from "postcss";
import postcssModules from "postcss-modules";
import * as path from "path";
import * as fs from "fs";
import type { Plugin } from "esbuild";

// Read version from package.json at build time
const pkg = JSON.parse(fs.readFileSync("./package.json", "utf-8"));
const VERSION = pkg.version;

// Host pages can beat our single-class selectors (e.g. `#app button`) and rescale
// `rem` via `html { font-size }`. Every rule gets an id-specificity scope bound to
// our root elements, and `rem` is pinned to px so sizes stay as designed.
const AGENTATION_SCOPE =
  ":is(#agentation-root, #agentation-root *, #agentation-popup, #agentation-popup *)";

// Attach the scope to the first compound selector (before any pseudo-element), so
// `[data-agentation-theme] .x` still matches when the attribute sits on the root itself.
function scopeSelector(selector: string): string {
  if (selector.includes("#agentation-") || /^(:root|html|body)\b/.test(selector)) {
    return selector;
  }
  let depth = 0;
  let quote: string | null = null;
  let end = selector.length;
  let pseudoElementAt = -1;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote) {
      if (ch === quote && selector[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0) {
      if (/[\s>+~]/.test(ch)) {
        end = i;
        break;
      }
      if (ch === ":" && selector[i + 1] === ":" && pseudoElementAt < 0) pseudoElementAt = i;
    }
  }
  const at = pseudoElementAt >= 0 ? pseudoElementAt : end;
  return selector.slice(0, at) + AGENTATION_SCOPE + selector.slice(at);
}

function agentationScopePlugin(): PostcssPlugin {
  return {
    postcssPlugin: "agentation-scope",
    Once(root) {
      root.walkRules((rule) => {
        const parent = rule.parent;
        if (parent?.type === "atrule" && /keyframes$/i.test((parent as AtRule).name)) return;
        rule.selectors = rule.selectors.map(scopeSelector);
      });
      root.walkDecls((decl) => {
        decl.value = decl.value.replace(
          /(-?\d*\.?\d+)rem\b/g,
          (_, n: string) => `${parseFloat(n) * 16}px`,
        );
      });
    },
  };
}

// Custom SCSS CSS Modules plugin with SSR-safe style injection
function scssModulesPlugin(): Plugin {
  return {
    name: "scss-modules",
    setup(build) {
      // Handle all .scss files
      build.onLoad({ filter: /\.scss$/ }, async (args) => {
        const isModule = args.path.includes(".module.");
        // Use parent directory + filename for unique style IDs
        const parentDir = path.basename(path.dirname(args.path));
        const baseName = path.basename(args.path, isModule ? ".module.scss" : ".scss");
        const styleId = `${parentDir}-${baseName}`;

        // Compile SCSS to CSS
        const result = sass.compile(args.path);
        let css = result.css;

        if (isModule) {
          // Process with postcss-modules to get class name mappings
          let classNames: Record<string, string> = {};
          const postcssResult = await postcss([
            postcssModules({
              getJSON(cssFileName, json) {
                classNames = json;
              },
              generateScopedName: "[name]__[local]___[hash:base64:5]",
            }),
          ]).process(css, { from: args.path });

          css = (await postcss([agentationScopePlugin()]).process(postcssResult.css, { from: args.path })).css;

          // Generate JS that exports class names and injects styles (SSR-safe)
          const contents = `
const css = ${JSON.stringify(css)};
const classNames = ${JSON.stringify(classNames)};

// SSR-safe style injection (always update for HMR)
if (typeof document !== 'undefined') {
  let style = document.getElementById('feedback-tool-styles-${styleId}');
  if (!style) {
    style = document.createElement('style');
    style.id = 'feedback-tool-styles-${styleId}';
    document.head.appendChild(style);
  }
  style.textContent = css;
}

export default classNames;
`;
          return { contents, loader: "js" };
        } else {
          // Regular SCSS - no CSS modules processing
          const contents = `
const css = ${JSON.stringify(css)};
if (typeof document !== 'undefined') {
  let style = document.getElementById('feedback-tool-styles-${styleId}');
  if (!style) {
    style = document.createElement('style');
    style.id = 'feedback-tool-styles-${styleId}';
    document.head.appendChild(style);
  }
  style.textContent = css;
}
export default {};
`;
          return { contents, loader: "js" };
        }
      });
    },
  };
}

export default defineConfig((options) => [
  // React component
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: !options.watch,
    external: ["react", "react-dom"],
    esbuildPlugins: [scssModulesPlugin()],
    define: {
      __VERSION__: JSON.stringify(VERSION),
    },
    banner: {
      js: '"use client";',
    },
  },
]);
