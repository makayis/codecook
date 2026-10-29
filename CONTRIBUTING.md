# Contributing

## Setup

```bash
npm install
npm run compile
```

Open this folder in VS Code, Cursor, or Antigravity and press **F5** to launch an Extension Development Host.

## Scripts

```bash
npm run watch   # rebuild out/extension.js as you edit
npm run smoke   # run the local smoke checks
```

## Packaging

```bash
npx @vscode/vsce package --no-dependencies
```
