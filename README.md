<picture>
  <source media="(prefers-color-scheme: dark)" srcset="package/logo-dark.svg">
  <img src="package/logo.svg" alt="Agentation" width="200">
</picture>

<br>

[![npm version](https://img.shields.io/npm/v/agentation)](https://www.npmjs.com/package/agentation)
[![downloads](https://img.shields.io/npm/dm/agentation)](https://www.npmjs.com/package/agentation)

**[Agentation](https://agentation.com)** is an agent-agnostic visual feedback tool. Click elements on any web page, add notes, and copy structured output that helps AI coding agents find the exact code you're referring to.

## Chrome Extension (Recommended)

The easiest way to use Agentation on any website without modifying your code.

### 1. Build the extension
```bash
pnpm build:extension
```

### 2. Install in Chrome
1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `extension/dist` folder in this repository

### 3. Usage
- Click the Agentation icon in your browser toolbar to configure settings.
- **Enable on this domain:** Toggle the toolbar on/off for the current site.
- **MCP Server:** Set your local MCP server domain and port (default is `localhost:4747`).
- The toolbar will appear in the bottom-right corner of enabled sites.

## React Component

For developers who want to bundle Agentation directly into their applications.

### Install

```bash
npm install agentation -D
```

### Usage

```tsx
import { Agentation } from 'agentation';

function App() {
  return (
    <>
      <YourApp />
      <Agentation />
    </>
  );
}
```

## MCP Server

To bridge your browser annotations to AI agents (like Claude or Cursor), start the Model Context Protocol server:

```bash
pnpm mcp
```

This starts a local server at `http://localhost:4747` that stores your annotations in a local SQLite database.

## Features

- **Click to annotate** – Click any element with automatic selector identification
- **Text selection** – Select text to annotate specific content
- **Multi-select** – Drag to select multiple elements at once
- **Area selection** – Drag to annotate any region, even empty space
- **Animation pause** – Freeze all animations (CSS, JS, videos) to capture specific states
- **Structured output** – Copy markdown with selectors, positions, and context
- **Dark/light mode** – Matches your preference or set manually
- **Zero dependencies** – Pure CSS animations, no runtime libraries

## How it works

Agentation captures class names, selectors, and element positions so AI agents can `grep` for the exact code you're referring to. Instead of describing "the blue button in the sidebar," you give the agent `.sidebar > button.primary` and your feedback.

## Requirements

- React 18+
- Desktop browser (mobile not supported)

## Docs

Full documentation at [agentation.com](https://agentation.com)

## License

© 2026 Benji Taylor

Licensed under PolyForm Shield 1.0.0
