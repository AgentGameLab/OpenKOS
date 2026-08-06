#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = process.env.KOS_DATA_ROOT || path.resolve(__dirname, '..', '..')
export const GRAPH_HTML = path.join(ROOT, 'team-memory', '.knowledge-graph.html')
const GITIGNORE = path.join(ROOT, '.gitignore')
const HTML_GITIGNORE_ENTRY = '/team-memory/.knowledge-graph.html'

if (isEntrypoint()) main()

export function renderHtmlShell({ generatedAt = new Date().toISOString(), defaultPort = 7321 } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KOS Knowledge Graph</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=JetBrains+Mono:wght@400;500&family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: oklch(15% 0.015 30);
      --surface: oklch(20% 0.02 30);
      --surface-2: oklch(25% 0.025 30);
      --surface-3: oklch(29% 0.028 30);
      --ink: oklch(88% 0.01 75);
      --ink-mute: oklch(60% 0.015 75);
      --accent: oklch(75% 0.18 75);
      --accent-soft: color-mix(in oklab, var(--accent) 22%, transparent);
      --type-rule: oklch(60% 0.12 35);
      --type-playbook: oklch(65% 0.08 145);
      --type-decision: oklch(58% 0.18 25);
      --type-skill: oklch(70% 0.13 85);
      --type-skill-internal: oklch(55% 0.10 130);
      --type-doc: oklch(72% 0.06 80);
      --type-hook: oklch(55% 0.08 290);
      --type-code-file: oklch(40% 0.02 240);
      --type-pointer: oklch(70% 0.005 0);
      --type-rule-paths-scoped: oklch(55% 0.14 50);
      --terracotta: oklch(58% 0.16 38);
      --sage: oklch(63% 0.08 145);
      --vermillion: oklch(60% 0.19 32);
      --ghost-line: oklch(35% 0 0);
      --rule-line: color-mix(in oklab, var(--ink) 14%, transparent);
      --drawer-width: minmax(19rem, 25rem);
      --noise: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.01'/%3E%3C/svg%3E");
    }

    * {
      box-sizing: border-box;
    }

    html, body {
      margin: 0;
      min-height: 100%;
      background:
        radial-gradient(circle at 20% 10%, color-mix(in oklab, var(--accent) 9%, transparent), transparent 26%),
        radial-gradient(circle at 82% 0%, color-mix(in oklab, var(--type-playbook) 10%, transparent), transparent 24%),
        radial-gradient(circle at 50% 120%, color-mix(in oklab, var(--type-rule) 10%, transparent), transparent 28%),
        var(--noise),
        var(--bg);
      color: var(--ink);
      font-family: "Public Sans", "Segoe UI", sans-serif;
      font-size: clamp(0.875rem, 1vw, 1rem);
      line-height: 1.45;
      overflow: hidden;
    }

    button,
    input {
      font: inherit;
      color: inherit;
    }

    button {
      background: none;
      border: 0;
      padding: 0;
      cursor: pointer;
    }

    .shell {
      display: grid;
      grid-template-rows: auto 1fr auto;
      min-height: 100vh;
    }

    .topbar {
      padding: clamp(1.2rem, 2vw, 1.75rem) clamp(1.25rem, 2.4vw, 2rem) 1rem;
      border-bottom: 1px solid var(--rule-line);
      display: grid;
      gap: 1rem;
    }

    .masthead {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      align-items: end;
      flex-wrap: wrap;
    }

    .title-lockup {
      display: grid;
      gap: 0.4rem;
    }

    h1 {
      margin: 0;
      font-family: "Fraunces", Georgia, serif;
      font-size: clamp(2rem, 4vw, 3rem);
      font-weight: 700;
      line-height: 0.95;
      letter-spacing: -0.03em;
    }

    .stats-line {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.45rem;
      color: var(--ink-mute);
    }

    .separator {
      opacity: 0.72;
    }

    .live-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      color: var(--ink);
    }

    .live-pill .dot,
    .status-pulse .dot {
      width: 0.62rem;
      height: 0.62rem;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 0 0 color-mix(in oklab, var(--accent) 45%, transparent);
      animation: live-pulse 1.9s ease-out infinite;
    }

    .meta-line {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .mono {
      font-family: "JetBrains Mono", Consolas, monospace;
      font-size: 0.79rem;
      letter-spacing: -0.02em;
    }

    .controls {
      display: grid;
      grid-template-columns: minmax(14rem, 22rem) minmax(0, 1fr) auto;
      gap: 1rem 1.25rem;
      align-items: start;
    }

    .search-block {
      display: grid;
      gap: 0.4rem;
      min-width: 0;
    }

    .search-frame {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: end;
      gap: 0.75rem;
      border-bottom: 1px solid color-mix(in oklab, var(--ink) 22%, transparent);
      padding-bottom: 0.35rem;
    }

    .search-frame:focus-within {
      border-bottom-color: var(--accent);
    }

    .search-input {
      min-width: 0;
      padding: 0;
      border: 0;
      outline: none;
      background: transparent;
      font-size: 1rem;
    }

    .search-input::placeholder {
      color: color-mix(in oklab, var(--ink-mute) 84%, transparent);
    }

    .search-count {
      color: var(--ink-mute);
      white-space: nowrap;
    }

    .filter-row {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      align-items: center;
      min-width: 0;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      border: 1px solid color-mix(in oklab, var(--ink) 16%, transparent);
      padding: 0.38rem 0.68rem 0.42rem;
      border-radius: 999px;
      color: var(--ink-mute);
      transition: border-color 140ms ease, color 140ms ease, transform 140ms ease;
    }

    .pill:hover {
      color: var(--ink);
      transform: translateY(-1px);
    }

    .pill.is-on {
      color: var(--ink);
      border-color: color-mix(in oklab, var(--ink) 26%, transparent);
      background: color-mix(in oklab, var(--surface-2) 80%, transparent);
    }

    .pill .swatch {
      width: 0.6rem;
      height: 0.6rem;
      border-radius: 999px;
    }

    .layout-switch {
      justify-self: end;
      display: inline-grid;
      grid-auto-flow: column;
      gap: 0.2rem;
      border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
      padding: 0.22rem;
      border-radius: 999px;
    }

    .layout-switch button {
      padding: 0.48rem 0.82rem;
      border-radius: 999px;
      color: var(--ink-mute);
      transition: background-color 140ms ease, color 140ms ease, transform 140ms ease;
    }

    .layout-switch button:hover {
      color: var(--ink);
      transform: translateY(-1px);
    }

    .layout-switch button[aria-pressed="true"] {
      color: var(--ink);
      background: color-mix(in oklab, var(--surface-3) 88%, transparent);
    }

    .stage {
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) clamp(18rem, 24vw, 25rem);
    }

    .viz {
      position: relative;
      min-height: 0;
      overflow: hidden;
    }

    .viz::before,
    .viz::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
    }

    .viz::before {
      background:
        linear-gradient(to right, transparent 0, transparent calc(100% - 1px), color-mix(in oklab, var(--ink) 5%, transparent) calc(100% - 1px)),
        linear-gradient(to bottom, transparent 0, transparent calc(100% - 1px), color-mix(in oklab, var(--ink) 5%, transparent) calc(100% - 1px));
      background-size: 3.8rem 3.8rem;
      opacity: 0.18;
      mix-blend-mode: screen;
    }

    .viz::after {
      background:
        linear-gradient(180deg, color-mix(in oklab, var(--bg) 30%, transparent), transparent 8%, transparent 92%, color-mix(in oklab, var(--bg) 42%, transparent));
    }

    #cy {
      position: absolute;
      inset: 0;
    }

    .selection-halo {
      position: absolute;
      z-index: 9;
      pointer-events: none;
      border-radius: 999px;
      border: 1px solid color-mix(in oklab, var(--accent) 54%, transparent);
      box-shadow:
        0 0 0 1px color-mix(in oklab, var(--accent) 20%, transparent),
        0 0 24px color-mix(in oklab, var(--accent) 18%, transparent);
      transform-origin: center;
    }

    .selection-halo::before {
      content: "";
      position: absolute;
      inset: -0.48rem;
      border-radius: inherit;
      border: 1px dashed color-mix(in oklab, var(--accent) 46%, transparent);
      animation: halo-spin 8.8s linear infinite;
      opacity: 0.82;
    }

    .drawer {
      min-height: 0;
      display: grid;
      grid-template-rows: auto 1fr;
      border-left: 1px solid var(--rule-line);
      background:
        linear-gradient(180deg, color-mix(in oklab, var(--surface) 95%, transparent), color-mix(in oklab, var(--surface-2) 88%, transparent));
    }

    .drawer-head {
      padding: 1rem 1.15rem 0.95rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      border-bottom: 1px solid var(--rule-line);
    }

    .drawer-head strong {
      font-family: "Fraunces", Georgia, serif;
      font-size: 1.1rem;
      font-weight: 600;
    }

    .drawer-head button {
      color: var(--ink-mute);
    }

    .drawer.collapsed {
      grid-template-rows: 1fr;
      width: 3rem;
    }

    .drawer.collapsed .drawer-head {
      padding: 0.9rem 0.62rem;
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      border-bottom: 0;
      justify-content: flex-start;
    }

    .drawer.collapsed .drawer-body {
      display: none;
    }

    .drawer-body {
      min-height: 0;
      overflow: auto;
      padding: 1rem 1.1rem 1.15rem;
      display: grid;
      gap: 1.1rem;
      align-content: start;
    }

    .empty-copy {
      margin: 0;
      color: var(--ink-mute);
      max-width: 28ch;
    }

    .node-title {
      display: grid;
      gap: 0.4rem;
    }

    .eyebrow {
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 0.72rem;
      color: var(--ink-mute);
    }

    .node-name {
      margin: 0;
      font-family: "Fraunces", Georgia, serif;
      font-size: 1.45rem;
      line-height: 1;
    }

    .node-id {
      color: var(--ink-mute);
      word-break: break-word;
    }

    .confidence-wrap {
      display: grid;
      gap: 0.45rem;
    }

    .confidence-bar {
      height: 0.4rem;
      border-radius: 999px;
      background: color-mix(in oklab, var(--ink) 12%, transparent);
      overflow: hidden;
    }

    .confidence-fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, color-mix(in oklab, var(--type-rule) 70%, transparent), var(--accent));
      transform-origin: left center;
    }

    .meta-grid {
      display: grid;
      grid-template-columns: minmax(5.6rem, 7rem) 1fr;
      gap: 0.55rem 0.8rem;
      margin: 0;
    }

    .meta-grid dt {
      color: var(--ink-mute);
    }

    .meta-grid dd {
      margin: 0;
      word-break: break-word;
    }

    .edge-section {
      display: grid;
      gap: 0.8rem;
    }

    .edge-section h3 {
      margin: 0;
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--ink-mute);
    }

    .edge-group {
      display: grid;
      gap: 0.45rem;
    }

    .edge-group-label {
      display: flex;
      justify-content: space-between;
      gap: 0.75rem;
      color: var(--ink);
      font-weight: 600;
      font-size: 0.92rem;
    }

    .edge-list {
      display: grid;
      gap: 0.35rem;
    }

    .edge-link {
      display: grid;
      gap: 0.15rem;
      justify-items: start;
      text-align: left;
      padding: 0.5rem 0.65rem 0.55rem;
      border: 1px solid color-mix(in oklab, var(--ink) 12%, transparent);
      border-radius: 0.85rem;
      background: color-mix(in oklab, var(--surface-2) 80%, transparent);
      transition: border-color 140ms ease, transform 140ms ease, color 140ms ease;
    }

    .edge-link:hover {
      border-color: color-mix(in oklab, var(--accent) 32%, transparent);
      transform: translateY(-1px);
    }

    .edge-link .hint-line {
      color: var(--ink-mute);
    }

    .toast-stack {
      position: absolute;
      right: 1rem;
      bottom: 1rem;
      z-index: 12;
      display: grid;
      gap: 0.55rem;
      pointer-events: none;
    }

    .toast {
      min-width: min(28rem, calc(100vw - 2rem));
      max-width: 28rem;
      padding: 0.72rem 0.9rem 0.78rem;
      border-radius: 0.95rem;
      border: 1px solid color-mix(in oklab, var(--ink) 16%, transparent);
      background: color-mix(in oklab, var(--surface-3) 92%, transparent);
      box-shadow: 0 0.65rem 2rem rgba(0, 0, 0, 0.18);
      opacity: 0;
      transform: translateY(0.5rem);
      animation: toast-in 180ms ease forwards;
    }

    .toast.warn {
      border-color: color-mix(in oklab, var(--accent) 30%, transparent);
    }

    .toast.fade-out {
      animation: toast-out 220ms ease forwards;
    }

    .statusbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      align-items: center;
      gap: 1rem;
      padding: 0.62rem 1.15rem;
      border-top: 1px solid var(--rule-line);
      color: var(--ink-mute);
      background: color-mix(in oklab, var(--surface) 82%, transparent);
    }

    .statusbar .left,
    .statusbar .right {
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .statusbar .center {
      justify-self: center;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
    }

    .status-pulse {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
    }

    .help-hint {
      margin-left: 0.75rem;
      color: color-mix(in oklab, var(--ink-mute) 88%, transparent);
    }

    @keyframes live-pulse {
      0% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--accent) 36%, transparent); }
      70% { box-shadow: 0 0 0 0.55rem color-mix(in oklab, var(--accent) 0%, transparent); }
      100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--accent) 0%, transparent); }
    }

    @keyframes halo-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    @keyframes toast-in {
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @keyframes toast-out {
      to {
        opacity: 0;
        transform: translateY(0.4rem);
      }
    }

    @media (max-width: 1100px) {
      .controls {
        grid-template-columns: 1fr;
      }

      .layout-switch {
        justify-self: start;
      }

      .stage {
        grid-template-columns: minmax(0, 1fr);
      }

      .drawer {
        position: absolute;
        right: 0;
        top: 0;
        bottom: 0;
        width: min(24rem, 88vw);
        box-shadow: -1rem 0 3rem rgba(0, 0, 0, 0.24);
      }

      .statusbar {
        grid-template-columns: 1fr;
        justify-items: start;
      }

      .statusbar .center {
        justify-self: start;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="masthead">
        <div class="title-lockup">
          <h1>KOS Knowledge Graph</h1>
          <div class="stats-line" id="statsLine">
            <span id="nodeCount">0 nodes</span>
            <span class="separator">⟫</span>
            <span id="edgeCount">0 edges</span>
            <span class="separator">⟫</span>
            <span id="healthScore">health --</span>
            <span class="separator">⟫</span>
            <span class="live-pill" id="livePill"><span class="dot" aria-hidden="true"></span><span>live</span></span>
          </div>
        </div>
        <div class="meta-line mono">
          <span>shell ${escapeHtml(generatedAt)}</span>
          <span id="generatedAt">graph pending</span>
        </div>
      </div>
      <div class="controls">
        <div class="search-block">
          <label class="eyebrow" for="searchInput">Search</label>
          <div class="search-frame">
            <input id="searchInput" class="search-input" type="search" autocomplete="off" placeholder="id or name, lowercase fuzzy">
            <span class="search-count mono" id="searchCount">0 of 0</span>
          </div>
        </div>
        <div class="filter-row" id="typeFilters" aria-label="Type filters"></div>
        <div class="layout-switch" id="layoutSwitch" aria-label="Layout switch">
          <button type="button" data-layout="cose-bilkent" aria-pressed="true">Cose Bilkent</button>
          <button type="button" data-layout="dagre" aria-pressed="false">Dagre TB</button>
          <button type="button" data-layout="concentric" aria-pressed="false">Concentric</button>
        </div>
      </div>
    </header>

    <main class="stage">
      <section class="viz">
        <div id="cy" aria-label="Knowledge graph canvas"></div>
        <div id="selectionHalo" class="selection-halo" hidden></div>
        <div id="toastStack" class="toast-stack" aria-live="polite" aria-atomic="true"></div>
      </section>

      <aside class="drawer" id="drawer">
        <div class="drawer-head">
          <strong>Selected Node</strong>
          <button type="button" id="drawerToggle">collapse</button>
        </div>
        <div class="drawer-body" id="drawerBody">
          <p class="empty-copy" id="emptyState">Pick a node to inspect confidence, metadata, and grouped edges. Hover temporarily isolates a one-hop neighborhood.</p>
          <div id="detailState" hidden>
            <section class="node-title">
              <div class="eyebrow" id="detailType">Type</div>
              <h2 class="node-name" id="detailName">Node</h2>
              <div class="node-id mono" id="detailId">id</div>
            </section>

            <section class="confidence-wrap">
              <div class="eyebrow">Confidence</div>
              <div class="confidence-bar"><div id="confidenceFill" class="confidence-fill"></div></div>
              <div class="mono" id="confidenceLabel">0.50</div>
            </section>

            <dl class="meta-grid" id="metaGrid"></dl>

            <section class="edge-section">
              <h3>Outgoing</h3>
              <div id="outgoingGroups"></div>
            </section>

            <section class="edge-section">
              <h3>Incoming</h3>
              <div id="incomingGroups"></div>
            </section>
          </div>
        </div>
      </aside>
    </main>

    <footer class="statusbar mono">
      <div class="left" id="statusSelected">selected: --</div>
      <div class="center">
        <span class="status-pulse"><span class="dot" aria-hidden="true"></span><span id="statusLive">SSE pending</span></span>
        <span id="statusUpdated">update --</span>
      </div>
      <div class="right" id="statusCommit">commit --<span class="help-hint">? hover isolates, / focuses search</span></div>
    </footer>
  </div>

  <script src="https://unpkg.com/cytoscape@3.30.0/dist/cytoscape.min.js"></script>
  <script src="https://unpkg.com/dagre@0.8.5/dist/dagre.min.js"></script>
  <script src="https://unpkg.com/cytoscape-dagre@2.5.0/cytoscape-dagre.js"></script>
  <script src="https://unpkg.com/cytoscape-cose-bilkent@4.1.0/cytoscape-cose-bilkent.js"></script>
  <script>
    (function () {
      var DEFAULT_PORT = ${Number(defaultPort)};
      var TYPE_ORDER = ['rule', 'playbook', 'decision', 'skill', 'skill-internal', 'doc', 'hook', 'rule-paths-scoped', 'pointer', 'code-file'];
      // First paint 只显核心知识层。code-file 711 个噪音默认隐藏，用户需要时点 pill 打开。
      var DEFAULT_VISIBLE_TYPES = ['rule', 'playbook', 'decision', 'skill', 'skill-internal', 'doc', 'hook', 'rule-paths-scoped', 'pointer'];
      var TYPE_SHAPES = {
        rule: 'hexagon',
        decision: 'hexagon',
        playbook: 'round-rectangle',
        skill: 'diamond',
        'skill-internal': 'diamond',
        hook: 'pentagon',
        doc: 'rectangle',
        'code-file': 'ellipse',
        pointer: 'triangle',
        'rule-paths-scoped': 'hexagon'
      };
      var MATURITY_PRIORITY = { proven: 3, verified: 2, draft: 1, unknown: 0 };
      var BORDER_BY_MATURITY = { proven: 3, verified: 1.5, draft: 1, unknown: 1 };
      var state = {
        cy: null,
        graph: { nodes: [], edges: [] },
        nodeIndex: new Map(),
        filters: new Set(DEFAULT_VISIBLE_TYPES),
        selectedId: null,
        hoverFocusIds: null,
        hoverEdgeIds: null,
        hoverTimers: [],
        layout: 'cose-bilkent',
        lastUpdateLabel: '--',
        lastCommit: '--',
        lastCommitSubject: '',
        healthScore: null,
        fetchInFlight: false,
        pendingFetch: false,
        pulseFrame: 0,
        pulseStart: 0
      };

      var palette = {};
      var dom = {
        search: document.getElementById('searchInput'),
        searchCount: document.getElementById('searchCount'),
        typeFilters: document.getElementById('typeFilters'),
        nodeCount: document.getElementById('nodeCount'),
        edgeCount: document.getElementById('edgeCount'),
        healthScore: document.getElementById('healthScore'),
        generatedAt: document.getElementById('generatedAt'),
        livePill: document.getElementById('livePill'),
        drawer: document.getElementById('drawer'),
        drawerToggle: document.getElementById('drawerToggle'),
        emptyState: document.getElementById('emptyState'),
        detailState: document.getElementById('detailState'),
        detailType: document.getElementById('detailType'),
        detailName: document.getElementById('detailName'),
        detailId: document.getElementById('detailId'),
        confidenceFill: document.getElementById('confidenceFill'),
        confidenceLabel: document.getElementById('confidenceLabel'),
        metaGrid: document.getElementById('metaGrid'),
        outgoingGroups: document.getElementById('outgoingGroups'),
        incomingGroups: document.getElementById('incomingGroups'),
        toastStack: document.getElementById('toastStack'),
        selectionHalo: document.getElementById('selectionHalo'),
        statusSelected: document.getElementById('statusSelected'),
        statusLive: document.getElementById('statusLive'),
        statusUpdated: document.getElementById('statusUpdated'),
        statusCommit: document.getElementById('statusCommit')
      };

      if (window.cytoscapeDagre) window.cytoscape.use(window.cytoscapeDagre);
      if (window.cytoscapeCoseBilkent) window.cytoscape.use(window.cytoscapeCoseBilkent);

      bootstrap();

      function bootstrap() {
        hydratePalette();
        buildFilterPills();
        bindChrome();
        initCy();
        fetchGraph({ initial: true, source: 'boot' });
        connectEvents();
      }

      function hydratePalette() {
        var styles = getComputedStyle(document.documentElement);
        palette.ink = styles.getPropertyValue('--ink').trim();
        palette.inkMute = styles.getPropertyValue('--ink-mute').trim();
        palette.accent = styles.getPropertyValue('--accent').trim();
        palette.rule = styles.getPropertyValue('--type-rule').trim();
        palette.playbook = styles.getPropertyValue('--type-playbook').trim();
        palette.decision = styles.getPropertyValue('--type-decision').trim();
        palette.skill = styles.getPropertyValue('--type-skill').trim();
        palette.skillInternal = styles.getPropertyValue('--type-skill-internal').trim();
        palette.doc = styles.getPropertyValue('--type-doc').trim();
        palette.hook = styles.getPropertyValue('--type-hook').trim();
        palette.codeFile = styles.getPropertyValue('--type-code-file').trim();
        palette.pointer = styles.getPropertyValue('--type-pointer').trim();
        palette.scoped = styles.getPropertyValue('--type-rule-paths-scoped').trim();
        palette.terracotta = styles.getPropertyValue('--terracotta').trim();
        palette.sage = styles.getPropertyValue('--sage').trim();
        palette.vermillion = styles.getPropertyValue('--vermillion').trim();
        palette.ghost = styles.getPropertyValue('--ghost-line').trim();
      }

      function bindChrome() {
        dom.search.addEventListener('input', applyVisibility);
        dom.drawerToggle.addEventListener('click', function () {
          var collapsed = dom.drawer.classList.toggle('collapsed');
          dom.drawerToggle.textContent = collapsed ? 'expand' : 'collapse';
          setTimeout(function () {
            if (state.cy) state.cy.resize();
            syncSelectionHalo();
          }, 180);
        });
        document.getElementById('layoutSwitch').addEventListener('click', function (event) {
          var button = event.target.closest('button[data-layout]');
          if (!button) return;
          var nextLayout = button.getAttribute('data-layout');
          state.layout = nextLayout;
          var buttons = this.querySelectorAll('button[data-layout]');
          buttons.forEach(function (entry) {
            entry.setAttribute('aria-pressed', entry === button ? 'true' : 'false');
          });
          runLayout(true);
        });
        document.addEventListener('keydown', function (event) {
          if (event.key === '/' && document.activeElement !== dom.search) {
            event.preventDefault();
            dom.search.focus();
            dom.search.select();
          }
        });
      }

      function buildFilterPills() {
        TYPE_ORDER.forEach(function (type) {
          var pill = document.createElement('button');
          pill.type = 'button';
          pill.className = state.filters.has(type) ? 'pill is-on' : 'pill';
          pill.setAttribute('data-type', type);
          pill.innerHTML = '<span class="swatch" style="background:' + escapeHtml(getTypeColor(type)) + '"></span>' +
            '<span>' + escapeHtml(type) + '</span>' +
            '<span class="mono" data-role="count">0</span>';
          pill.addEventListener('click', function () {
            if (state.filters.has(type)) {
              state.filters.delete(type);
              pill.classList.remove('is-on');
            } else {
              state.filters.add(type);
              pill.classList.add('is-on');
            }
            applyVisibility();
          });
          dom.typeFilters.appendChild(pill);
        });
      }

      function initCy() {
        state.cy = window.cytoscape({
          container: document.getElementById('cy'),
          elements: [],
          wheelSensitivity: 0.16,
          layout: buildLayout(false),
          style: [
            {
              selector: 'node',
              style: {
                shape: 'data(shape)',
                width: 'data(width)',
                height: 'data(height)',
                'background-color': 'data(fill)',
                'border-color': 'data(stroke)',
                'border-width': 'data(borderWidth)',
                'border-style': 'data(borderStyle)',
                label: 'data(label)',
                color: palette.ink,
                'font-size': 'data(fontSize)',
                'font-family': '"Public Sans", sans-serif',
                'text-wrap': 'wrap',
                'text-max-width': 'data(textWidth)',
                'text-valign': 'bottom',
                'text-margin-y': 9,
                'text-outline-width': 0,
                'text-background-opacity': 0,
                'shadow-blur': 'data(shadowBlur)',
                'shadow-color': 'data(shadowColor)',
                'shadow-opacity': 'data(shadowOpacity)',
                opacity: 'data(nodeOpacity)',
                'z-compound-depth': 'top'
              }
            },
            {
              selector: 'node.selected-node',
              style: {
                'shadow-blur': 26,
                'shadow-color': palette.accent,
                'shadow-opacity': 0.48,
                'border-color': palette.accent
              }
            },
            {
              selector: 'edge',
              style: {
                width: 'data(width)',
                'line-color': 'data(lineColor)',
                'target-arrow-color': 'data(lineColor)',
                'target-arrow-shape': 'data(arrow)',
                'line-style': 'data(lineStyle)',
                'curve-style': 'bezier',
                opacity: 'data(edgeOpacity)'
              }
            },
            {
              selector: 'edge.pulse-trigger',
              style: {
                'line-color': palette.sage,
                'target-arrow-color': palette.sage
              }
            }
          ]
        });

        state.cy.on('tap', 'node', function (event) {
          selectNode(event.target.id(), true);
        });

        state.cy.on('tap', function (event) {
          if (event.target === state.cy) clearSelection();
        });

        state.cy.on('mouseover', 'node', function (event) {
          scheduleHover(event.target.id());
        });

        state.cy.on('mouseout', 'node', function () {
          clearHover();
        });

        state.cy.on('render pan zoom resize', function () {
          syncSelectionHalo();
        });

        window.addEventListener('resize', function () {
          if (!state.cy) return;
          state.cy.resize();
          syncSelectionHalo();
        });
      }

      function connectEvents() {
        var source = new window.EventSource(resolveEndpoint('/events'));
        source.onopen = function () {
          dom.statusLive.textContent = 'SSE live';
        };
        source.onerror = function () {
          dom.statusLive.textContent = 'SSE retrying';
        };
        source.addEventListener('graph-updated', function (event) {
          var payload = safeParse(event.data);
          fetchGraph({ source: payload.source || 'local' });
        });
        source.addEventListener('upstream-pending', function (event) {
          var payload = safeParse(event.data);
          if (payload.commit) {
            showToast('Upstream commit ' + payload.commit.slice(0, 7) + ': ' + (payload.message || 'pull manually'), 'warn', 8000);
          } else {
            showToast('Upstream has new commits; pull manually.', 'warn', 8000);
          }
        });
      }

      function fetchGraph(options) {
        if (state.fetchInFlight) {
          state.pendingFetch = true;
          return;
        }

        state.fetchInFlight = true;
        var requestUrl = resolveEndpoint('/graph.json') + '?t=' + Date.now();

        window.fetch(requestUrl, { cache: 'no-store' })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json().then(function (graph) {
              return { graph: graph, response: response };
            });
          })
          .then(function (payload) {
            applyGraph(payload.graph, payload.response, options || {});
          })
          .catch(function (error) {
            showToast('Graph fetch failed · ' + error.message, 'warn', 6000);
            dom.statusLive.textContent = 'SSE degraded';
          })
          .finally(function () {
            state.fetchInFlight = false;
            if (state.pendingFetch) {
              state.pendingFetch = false;
              fetchGraph({ source: 'queued' });
            }
          });
      }

      function applyGraph(graph, response, options) {
        var previous = state.graph;
        var preservedSelection = state.selectedId;
        var elements = buildElements(graph);
        state.graph = graph;
        state.nodeIndex = new Map(graph.nodes.map(function (node) { return [node.id, node]; }));
        state.cy.json({ elements: elements });
        updateMetaChrome(graph, response);
        updateFilterCounts(graph);
        applyVisibility();
        if (preservedSelection && state.nodeIndex.has(preservedSelection)) {
          selectNode(preservedSelection, false);
        } else {
          clearSelection();
        }
        runLayout(!options.initial);
        state.lastUpdateLabel = formatTime(new Date());
        dom.statusUpdated.textContent = 'update ' + state.lastUpdateLabel;
        if (!options.initial) {
          var nodeDelta = graph.nodes.length - (previous.nodes || []).length;
          var edgeDelta = graph.edges.length - (previous.edges || []).length;
          var source = options.source || 'local';
          showToast('Updated · ' + formatDelta(nodeDelta) + ' nodes / ' + formatDelta(edgeDelta) + ' edges (' + source + ')', source === 'github-sync' ? 'warn' : '', 4000);
        }
      }

      function buildElements(graph) {
        var degree = new Map();
        graph.nodes.forEach(function (node) { degree.set(node.id, 0); });
        graph.edges.forEach(function (edge) {
          degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
          degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
        });

        return {
          nodes: graph.nodes.map(function (node) {
            var d = degree.get(node.id) || 0;
            var size = 12 + (Math.sqrt(Math.min(d, 30)) / Math.sqrt(30)) * 48;
            var confidence = clamp(Number(node.confidence || 0.5), 0.4, 1);
            var opacity = 0.55 + ((confidence - 0.4) / 0.6) * 0.45;
            var type = node.type || 'doc';
            var width = type === 'code-file' ? Math.min(size, 24) : size;
            var height = width;
            if (type === 'pointer') height = width * 0.78;
            if (type === 'rule-paths-scoped') height = width * 0.62;
            if (type === 'code-file') height = width * 0.62;
            return {
              data: {
                id: node.id,
                label: node.name || node.id,
                shape: TYPE_SHAPES[type] || 'ellipse',
                fill: getTypeColor(type),
                stroke: palette.ink,
                borderWidth: BORDER_BY_MATURITY[node.maturity || 'unknown'] || 1,
                borderStyle: (node.maturity || 'draft') === 'draft' ? 'dashed' : 'solid',
                width: width,
                height: height,
                fontSize: type === 'code-file' ? 8 : 10,
                textWidth: Math.max(86, width * 2.4),
                nodeOpacity: opacity,
                shadowBlur: (node.maturity || 'draft') === 'proven' ? 18 : 0,
                shadowColor: (node.maturity || 'draft') === 'proven' ? palette.accent : getTypeColor(type),
                shadowOpacity: (node.maturity || 'draft') === 'proven' ? 0.36 : 0,
                maturityRank: MATURITY_PRIORITY[node.maturity || 'unknown'] || 0
              }
            };
          }),
          edges: graph.edges.map(function (edge, index) {
            var visuals = getEdgeVisual(edge.label || 'references');
            return {
              data: {
                id: edge.id || ('edge-' + index + '-' + edge.from + '-' + edge.to + '-' + (edge.label || 'references')),
                source: edge.from,
                target: edge.to,
                label: edge.label || 'references',
                width: visuals.width,
                lineColor: visuals.color,
                lineStyle: visuals.style,
                arrow: visuals.arrow,
                edgeOpacity: visuals.opacity
              }
            };
          })
        };
      }

      function updateMetaChrome(graph, response) {
        var generatedAt = graph.generated_at ? new Date(graph.generated_at) : null;
        var healthHeader = response.headers.get('x-kg-health');
        var commitHeader = response.headers.get('x-kg-commit');
        var subjectHeader = response.headers.get('x-kg-commit-subject');
        state.healthScore = healthHeader ? Number(healthHeader) : fallbackHealth(graph);
        state.lastCommit = commitHeader || '--';
        state.lastCommitSubject = subjectHeader || '';
        dom.nodeCount.textContent = String(graph.nodes.length) + ' nodes';
        dom.edgeCount.textContent = String(graph.edges.length) + ' edges';
        dom.healthScore.textContent = 'health ' + String(state.healthScore);
        dom.generatedAt.textContent = generatedAt ? ('graph ' + generatedAt.toISOString()) : 'graph pending';
        updateCommitLine();
      }

      function updateCommitLine() {
        var text = 'commit ' + state.lastCommit;
        if (state.lastCommitSubject) text += ' · ' + state.lastCommitSubject;
        dom.statusCommit.innerHTML = escapeHtml(text) + '<span class="help-hint">? hover isolates, / focuses search</span>';
      }

      function updateFilterCounts(graph) {
        var counts = Object.create(null);
        graph.nodes.forEach(function (node) {
          var type = node.type || 'doc';
          counts[type] = (counts[type] || 0) + 1;
        });
        dom.typeFilters.querySelectorAll('[data-type]').forEach(function (pill) {
          var type = pill.getAttribute('data-type');
          var badge = pill.querySelector('[data-role="count"]');
          if (badge) badge.textContent = String(counts[type] || 0);
        });
      }

      function applyVisibility() {
        if (!state.cy) return;
        var query = dom.search.value.trim().toLowerCase();
        var visibleNodeIds = new Set();
        var focusNodeIds = state.hoverFocusIds;
        var focusEdgeIds = state.hoverEdgeIds;

        state.cy.nodes().forEach(function (node) {
          var source = state.nodeIndex.get(node.id()) || {};
          var haystack = (source.id || '') + ' ' + (source.name || '');
          var matchesSearch = !query || haystack.toLowerCase().indexOf(query) !== -1;
          var matchesType = state.filters.has(source.type || 'doc');
          var visible = matchesSearch && matchesType;
          node.style('display', visible ? 'element' : 'none');
          if (visible) visibleNodeIds.add(node.id());
          var baseOpacity = Number(node.data('nodeOpacity') || 1);
          if (!visible) {
            node.style('opacity', 0);
            return;
          }
          if (!focusNodeIds) {
            node.style('opacity', baseOpacity);
            return;
          }
          node.style('opacity', focusNodeIds.has(node.id()) ? baseOpacity : 0.15);
        });

        state.cy.edges().forEach(function (edge) {
          var sourceVisible = visibleNodeIds.has(edge.data('source'));
          var targetVisible = visibleNodeIds.has(edge.data('target'));
          var shouldDisplay = sourceVisible && targetVisible;
          edge.style('display', shouldDisplay ? 'element' : 'none');
          if (!shouldDisplay) {
            edge.style('opacity', 0);
            return;
          }
          var baseOpacity = Number(edge.data('edgeOpacity') || 0.8);
          if (!focusNodeIds) {
            edge.style('opacity', baseOpacity);
            return;
          }
          var connected = focusNodeIds.has(edge.data('source')) && focusNodeIds.has(edge.data('target'));
          var explicitEdge = focusEdgeIds && focusEdgeIds.has(edge.id());
          edge.style('opacity', connected || explicitEdge ? baseOpacity : 0.08);
        });

        dom.searchCount.textContent = String(visibleNodeIds.size) + ' of ' + String(state.graph.nodes.length);
        syncSelectionHalo();
        syncPulseEdges();
      }

      function selectNode(nodeId, center) {
        if (!state.nodeIndex.has(nodeId)) return;
        state.selectedId = nodeId;
        state.cy.nodes().removeClass('selected-node');
        var node = state.cy.getElementById(nodeId);
        node.addClass('selected-node');
        if (center) {
          state.cy.animate({
            center: { eles: node },
            duration: 320,
            easing: 'ease-out-quart'
          });
        }
        renderDetails(nodeId);
        dom.statusSelected.textContent = 'selected: ' + nodeId;
        applyVisibility();
        syncSelectionHalo();
      }

      function clearSelection(resetDetails) {
        state.selectedId = null;
        state.cy.nodes().removeClass('selected-node');
        dom.statusSelected.textContent = 'selected: --';
        if (resetDetails !== false) renderDetails(null);
        applyVisibility();
        syncSelectionHalo();
      }

      function scheduleHover(nodeId) {
        clearHover();
        var neighborhood = collectNeighborhood(nodeId);
        state.hoverTimers.push(window.setTimeout(function () {
          state.hoverFocusIds = new Set([nodeId]);
          applyVisibility();
        }, 0));
        state.hoverTimers.push(window.setTimeout(function () {
          state.hoverFocusIds = neighborhood.nodes;
          applyVisibility();
        }, 120));
        state.hoverTimers.push(window.setTimeout(function () {
          state.hoverEdgeIds = neighborhood.edges;
          applyVisibility();
        }, 200));
      }

      function clearHover() {
        while (state.hoverTimers.length) window.clearTimeout(state.hoverTimers.pop());
        state.hoverFocusIds = null;
        state.hoverEdgeIds = null;
        applyVisibility();
      }

      function collectNeighborhood(nodeId) {
        var node = state.cy.getElementById(nodeId);
        if (!node || node.empty()) return { nodes: null, edges: null };
        var nodes = new Set();
        var edges = new Set();
        node.closedNeighborhood().nodes().forEach(function (entry) { nodes.add(entry.id()); });
        node.connectedEdges().forEach(function (entry) { edges.add(entry.id()); });
        return { nodes: nodes, edges: edges };
      }

      function renderDetails(nodeId) {
        if (!nodeId) {
          dom.emptyState.hidden = false;
          dom.detailState.hidden = true;
          dom.metaGrid.innerHTML = '';
          dom.outgoingGroups.innerHTML = '';
          dom.incomingGroups.innerHTML = '';
          return;
        }

        var node = state.nodeIndex.get(nodeId);
        if (!node) return;
        dom.emptyState.hidden = true;
        dom.detailState.hidden = false;
        dom.detailType.textContent = (node.type || 'node') + ' · ' + (node.maturity || 'unknown');
        dom.detailName.textContent = node.name || node.id;
        dom.detailId.textContent = node.id;

        var confidence = clamp(Number(node.confidence || 0.5), 0.4, 1);
        var ratio = (confidence - 0.4) / 0.6;
        dom.confidenceFill.style.transform = 'scaleX(' + String(ratio) + ')';
        dom.confidenceLabel.textContent = confidence.toFixed(2);

        dom.metaGrid.innerHTML = '';
        [
          ['declared', node.declared_type || '—'],
          ['status', node.status || '—'],
          ['audience', node.audience || '—'],
          ['topic', node.topic || '—'],
          ['last verified', node.last_verified || '—'],
          ['created', node.created || '—']
        ].forEach(function (pair) {
          var dt = document.createElement('dt');
          dt.textContent = pair[0];
          var dd = document.createElement('dd');
          dd.textContent = pair[1];
          dom.metaGrid.appendChild(dt);
          dom.metaGrid.appendChild(dd);
        });

        renderEdgeGroups(dom.outgoingGroups, state.graph.edges.filter(function (edge) { return edge.from === nodeId; }), 'to');
        renderEdgeGroups(dom.incomingGroups, state.graph.edges.filter(function (edge) { return edge.to === nodeId; }), 'from');
      }

      function renderEdgeGroups(target, edges, peerKey) {
        target.innerHTML = '';
        if (!edges.length) {
          var empty = document.createElement('div');
          empty.className = 'hint-line';
          empty.textContent = 'No edges.';
          target.appendChild(empty);
          return;
        }

        var groups = new Map();
        edges.forEach(function (edge) {
          var label = edge.label || 'references';
          if (!groups.has(label)) groups.set(label, []);
          groups.get(label).push(edge);
        });

        Array.from(groups.keys()).sort().forEach(function (label) {
          var group = document.createElement('section');
          group.className = 'edge-group';
          var head = document.createElement('div');
          head.className = 'edge-group-label';
          head.innerHTML = '<span>' + escapeHtml(label) + '</span><span class="mono">' + String(groups.get(label).length) + '</span>';
          group.appendChild(head);
          var list = document.createElement('div');
          list.className = 'edge-list';
          groups.get(label).forEach(function (edge) {
            var peerId = edge[peerKey];
            var peer = state.nodeIndex.get(peerId);
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'edge-link';
            button.innerHTML = '<span>' + escapeHtml((peer && peer.name) || peerId) + '</span>' +
              '<span class="hint-line mono">' + escapeHtml(peerId) + '</span>';
            button.addEventListener('click', function () {
              selectNode(peerId, true);
            });
            list.appendChild(button);
          });
          group.appendChild(list);
          target.appendChild(group);
        });
      }

      function runLayout(animate) {
        if (!state.cy) return;
        state.cy.layout(buildLayout(animate)).run();
      }

      function buildLayout(animate) {
        if (state.layout === 'cose-bilkent') {
          return {
            name: 'cose-bilkent',
            fit: true,
            animate: animate,
            animationDuration: 500,
            animationEasing: 'ease-out-quart',
            nodeRepulsion: 6200,
            idealEdgeLength: 130,
            edgeElasticity: 0.08,
            gravity: 0.22,
            padding: 36
          };
        }

        if (state.layout === 'concentric') {
          return {
            name: 'concentric',
            fit: true,
            animate: animate,
            animationDuration: 500,
            animationEasing: 'ease-out-quart',
            padding: 46,
            minNodeSpacing: 24,
            concentric: function (node) {
              return Number(node.data('maturityRank') || 0);
            },
            levelWidth: function () { return 1; }
          };
        }

        return {
          name: 'dagre',
          fit: true,
          animate: animate,
          animationDuration: 500,
          animationEasing: 'ease-out-quart',
          padding: 36,
          rankDir: 'TB',
          nodeSep: 34,
          rankSep: 96,
          edgeSep: 18
        };
      }

      function syncSelectionHalo() {
        if (!state.selectedId || !state.cy) {
          dom.selectionHalo.hidden = true;
          return;
        }
        var node = state.cy.getElementById(state.selectedId);
        if (!node || node.empty() || node.style('display') === 'none') {
          dom.selectionHalo.hidden = true;
          return;
        }
        var pos = node.renderedPosition();
        var width = Math.max(node.renderedOuterWidth() + 18, 26);
        var height = Math.max(node.renderedOuterHeight() + 18, 26);
        dom.selectionHalo.hidden = false;
        dom.selectionHalo.style.width = width + 'px';
        dom.selectionHalo.style.height = height + 'px';
        dom.selectionHalo.style.left = (pos.x - width / 2) + 'px';
        dom.selectionHalo.style.top = (pos.y - height / 2) + 'px';
      }

      function syncPulseEdges() {
        if (state.pulseFrame) {
          window.cancelAnimationFrame(state.pulseFrame);
          state.pulseFrame = 0;
        }

        state.cy.edges().removeClass('pulse-trigger');
        state.cy.edges().forEach(function (edge) {
          edge.style('width', edge.data('width'));
        });
        if (!state.selectedId) return;

        var selectedNode = state.cy.getElementById(state.selectedId);
        var pulseEdges = selectedNode.connectedEdges().filter(function (edge) {
          return edge.data('label') === 'triggers' && edge.style('display') !== 'none';
        });
        if (!pulseEdges.length) return;

        pulseEdges.addClass('pulse-trigger');
        state.pulseStart = performance.now();

        var tick = function (time) {
          var wave = (Math.sin((time - state.pulseStart) / 420) + 1) / 2;
          pulseEdges.forEach(function (edge) {
            edge.style('width', 0.7 + wave * 1.1);
            edge.style('opacity', 0.5 + wave * 0.4);
          });
          state.pulseFrame = window.requestAnimationFrame(tick);
        };

        state.pulseFrame = window.requestAnimationFrame(tick);
      }

      function showToast(message, kind, duration) {
        var toast = document.createElement('div');
        toast.className = 'toast' + (kind ? ' ' + kind : '');
        toast.textContent = message;
        dom.toastStack.appendChild(toast);
        window.setTimeout(function () {
          toast.classList.add('fade-out');
          window.setTimeout(function () {
            toast.remove();
          }, 220);
        }, duration || 4000);
      }

      function getTypeColor(type) {
        if (type === 'rule') return palette.rule;
        if (type === 'playbook') return palette.playbook;
        if (type === 'decision') return palette.decision;
        if (type === 'skill') return palette.skill;
        if (type === 'skill-internal') return palette.skillInternal;
        if (type === 'doc') return palette.doc;
        if (type === 'hook') return palette.hook;
        if (type === 'pointer') return palette.pointer;
        if (type === 'code-file') return palette.codeFile;
        if (type === 'rule-paths-scoped') return palette.scoped;
        return palette.inkMute;
      }

      function getEdgeVisual(label) {
        if (label === 'supersedes') return { width: 2.5, color: palette.terracotta, style: 'solid', arrow: 'triangle', opacity: 0.92 };
        if (label === 'superseded_by') return { width: 1.5, color: palette.terracotta, style: 'dashed', arrow: 'triangle', opacity: 0.68 };
        if (label === 'references') return { width: 0.8, color: palette.inkMute, style: 'solid', arrow: 'none', opacity: 0.72 };
        if (label === 'imports') return { width: 0.6, color: palette.inkMute, style: 'dotted', arrow: 'none', opacity: 0.55 };
        if (label === 'co-located') return { width: 0.4, color: palette.ghost, style: 'solid', arrow: 'none', opacity: 0.2 };
        if (label === 'triggers') return { width: 0.7, color: palette.sage, style: 'solid', arrow: 'triangle', opacity: 0.72 };
        if (label === 'audience-mismatch') return { width: 1.5, color: palette.vermillion, style: 'dashed', arrow: 'triangle', opacity: 0.85 };
        return { width: 0.7, color: palette.inkMute, style: 'solid', arrow: 'none', opacity: 0.5 };
      }

      function fallbackHealth(graph) {
        var incoming = new Map();
        var importTouched = new Set();
        graph.edges.forEach(function (edge) {
          if (!incoming.has(edge.to)) incoming.set(edge.to, []);
          incoming.get(edge.to).push(edge);
          if (edge.label === 'imports') {
            importTouched.add(edge.from);
            importTouched.add(edge.to);
          }
        });
        var staleRefs = 0;
        var cold = 0;
        var audience = 0;
        var maturityMissing = 0;
        var supersededIds = new Set();
        graph.nodes.forEach(function (node) {
          if (String(node.status || '').toLowerCase().indexOf('superseded') === 0) supersededIds.add(node.id);
        });
        graph.edges.forEach(function (edge) {
          if (edge.label === 'superseded_by' || edge.label === 'supersedes') supersededIds.add(edge.from);
          if (edge.label === 'audience-mismatch') audience += 1;
        });
        supersededIds.forEach(function (id) {
          (incoming.get(id) || []).forEach(function (edge) {
            if (edge.label === 'references' || edge.label === 'related') staleRefs += 1;
          });
        });
        var refCounts = new Map();
        graph.edges.forEach(function (edge) {
          if (edge.label === 'references') refCounts.set(edge.to, (refCounts.get(edge.to) || 0) + 1);
        });
        graph.nodes.forEach(function (node) {
          if ((node.type === 'rule' || node.type === 'playbook') && !String(node.status || '').toLowerCase().startsWith('superseded')) {
            if ((refCounts.get(node.id) || 0) === 0) cold += 1;
            if (!node.maturity) maturityMissing += 1;
          }
        });
        var totalIssues = staleRefs + cold + audience + maturityMissing;
        return Math.max(0, 100 - totalIssues * 2);
      }

      function resolveEndpoint(pathname) {
        if (window.location.protocol === 'file:') return 'http://localhost:' + String(DEFAULT_PORT) + pathname;
        return pathname;
      }

      function formatDelta(value) {
        return (value >= 0 ? '+' : '') + String(value);
      }

      function formatTime(date) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }

      function safeParse(raw) {
        try { return raw ? JSON.parse(raw) : {}; } catch (_) { return {}; }
      }

      function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
      }

      function escapeHtml(value) {
        return String(value).replace(/[&<>"]/g, function (ch) {
          return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch];
        });
      }
    }());
  </script>
</body>
</html>
`
}

export function writeHtmlShell({ generatedAt = new Date().toISOString(), defaultPort = 7321 } = {}) {
  const html = renderHtmlShell({ generatedAt, defaultPort })
  fs.writeFileSync(GRAPH_HTML, html, 'utf8')
  ensureGitignoreEntry(GITIGNORE, HTML_GITIGNORE_ENTRY)
  return {
    generatedAt,
    html,
    path: GRAPH_HTML,
    size: Buffer.byteLength(html, 'utf8'),
  }
}

function main() {
  const { shouldOpen } = parseArgs(process.argv.slice(2))
  const result = writeHtmlShell()
  console.log(`Wrote ${toRepoPath(result.path)} (${result.size} bytes)`)
  if (shouldOpen) openTarget(result.path)
}

function parseArgs(argv) {
  return {
    shouldOpen: argv.includes('--open'),
  }
}

function ensureGitignoreEntry(file, entry) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (current.split(/\r?\n/).includes(entry)) return
  const prefix = current && !current.endsWith('\n') ? '\n' : ''
  fs.writeFileSync(file, `${current}${prefix}${entry}\n`, 'utf8')
}

function openTarget(target) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return
  }
  if (process.platform === 'darwin') {
    spawn('open', [target], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref()
}

function toRepoPath(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
}

function isEntrypoint() {
  return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url))
}
