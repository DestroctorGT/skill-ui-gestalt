#!/usr/bin/env node
// detect.mjs - Detects a project's frontend stack, design-system tokens and UI primitives.
// Zero dependencies (node: built-ins only). Prints JSON to STDOUT. Never writes files.
// Deterministic: stable ordering, no timestamps, no randomness.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep, posix } from 'node:path';

const HELP = `Usage: node detect.mjs [--root <dir>] [--help]

Detects the frontend stack, design-system tokens, UI primitives, class-merge
helper and import alias of a project, and prints a JSON report to stdout.

Options:
  --root <dir>   Directory to scan (default: current working directory).
                 In a monorepo it emits one profile per frontend package found.
  --help, -h     Show this help.

Notes:
  - Read-only: never writes files into the scanned project.
  - Exit code is 0 even when nothing is found (candidates: [] plus warnings).
  - Output is deterministic: same input => byte-identical output.
`;

const LIMITS = {
  maxDepth: 8,
  maxFiles: 12000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 48 * 1024 * 1024,
  maxTokens: 400,
  maxUnclassified: 80,
  maxTokenFiles: 40,
  maxInferred: 12,
  maxComponentsPerDir: 80,
};

const IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'public',
  'storybook-static', '__snapshots__', 'tmp', 'temp', 'bower_components', 'jspm_packages',
]);
const CODE_EXT = new Set([
  '.css', '.scss', '.sass', '.less', '.pcss', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.mts', '.cts', '.vue', '.svelte', '.astro', '.html', '.mdx',
]);
const STYLE_EXT = new Set(['.css', '.scss', '.sass', '.less', '.pcss']);
const FRONTEND_DEPS = [
  'react', 'react-dom', 'vue', 'svelte', '@sveltejs/kit', 'next', 'nuxt', 'astro', '@angular/core',
  'solid-js', 'preact', '@builder.io/qwik', 'lit', 'tailwindcss', 'styled-components',
  '@emotion/react', '@emotion/styled', '@mui/material', '@chakra-ui/react', 'sass',
  '@stitches/react', '@vanilla-extract/css', 'antd', '@mantine/core', 'bootstrap',
  '@remix-run/react', 'gatsby',
];

const toPosix = (p) => p.split(sep).join('/');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const extOf = (p) => {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i).toLowerCase();
};
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirOf = (p) => (p.lastIndexOf('/') < 0 ? '.' : p.slice(0, p.lastIndexOf('/')));

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const out = { root: process.cwd(), help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--root') {
      if (!argv[i + 1]) out.error = '--root requires a directory';
      else out.root = argv[++i];
    } else if (a.startsWith('--root=')) out.root = a.slice(7);
    else out.error = `unknown argument: ${a}`;
  }
  return out;
}

// ---------------------------------------------------------------- fs helpers

function readText(abs, warnings, rel) {
  try {
    const st = statSync(abs);
    if (st.size > LIMITS.maxFileBytes) {
      warnings.add(`skipped large file (>${LIMITS.maxFileBytes / 1024}KB): ${rel}`);
      return null;
    }
    return readFileSync(abs, 'utf8');
  } catch {
    warnings.add(`unreadable file: ${rel}`);
    return null;
  }
}

function readJson(abs, warnings, rel) {
  const t = readText(abs, warnings, rel);
  if (t == null) return null;
  try {
    return JSON.parse(t);
  } catch {
    try {
      const cleaned = t
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:"'])\/\/.*$/gm, '$1')
        .replace(/,(\s*[}\]])/g, '$1');
      return JSON.parse(cleaned);
    } catch {
      warnings.add(`invalid JSON: ${rel}`);
      return null;
    }
  }
}

function walk(rootAbs, warnings) {
  const files = [];
  let truncated = false;
  const rec = (dirAbs, dirRel, depth) => {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      warnings.add(`unreadable directory: ${dirRel || '.'}`);
      return;
    }
    entries.sort((a, b) => cmp(a.name, b.name));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        if (depth < LIMITS.maxDepth) rec(join(dirAbs, e.name), rel, depth + 1);
      } else if (e.isFile()) {
        const ext = extOf(e.name);
        const keep =
          CODE_EXT.has(ext) ||
          (ext === '.json' && !/lock\.json$/.test(e.name)) ||
          false;
        if (!keep) continue;
        if (/\.min\.|\.d\.ts$/.test(e.name)) continue;
        if (files.length >= LIMITS.maxFiles) {
          truncated = true;
          continue;
        }
        files.push(rel);
      }
    }
  };
  rec(rootAbs, '', 0);
  if (truncated) warnings.add(`file limit reached (${LIMITS.maxFiles}); some files were not scanned`);
  return files;
}

// ---------------------------------------------------------------- JS object-literal mini parser

function parseJsObjectAt(src, start) {
  let i = start;
  const n = src.length;
  const ws = () => {
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++;
      if (src.startsWith('//', i)) {
        while (i < n && src[i] !== '\n') i++;
      } else if (src.startsWith('/*', i)) {
        const e = src.indexOf('*/', i + 2);
        i = e < 0 ? n : e + 2;
      } else break;
    }
  };
  const str = (q) => {
    let out = '';
    i++;
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') {
        out += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      out += src[i++];
    }
    i++;
    return out;
  };
  const skipExpr = () => {
    let d = 0;
    while (i < n) {
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') {
        str(c);
        continue;
      }
      if (src.startsWith('//', i)) {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (src.startsWith('/*', i)) {
        const e = src.indexOf('*/', i + 2);
        i = e < 0 ? n : e + 2;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') {
        if (d === 0) break;
        d--;
      } else if (c === ',' && d === 0) break;
      i++;
    }
  };
  const isEnd = () => {
    let k = i;
    while (k < n && /\s/.test(src[k])) k++;
    return k >= n || src[k] === ',' || src[k] === '}' || src[k] === ']';
  };
  const value = () => {
    ws();
    const c = src[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"' || c === "'" || c === '`') {
      const s = str(c);
      if (isEnd()) return c === '`' && s.includes('${') ? { __expr: s } : s;
      skipExpr();
      return { __expr: s };
    }
    const m = /^-?\d*\.?\d+(?:e[+-]?\d+)?/i.exec(src.slice(i, i + 30));
    if (m) {
      const save = i;
      i += m[0].length;
      if (isEnd()) return Number(m[0]);
      i = save;
    }
    const s = i;
    skipExpr();
    return { __expr: src.slice(s, i).trim().slice(0, 80) };
  };
  const array = () => {
    i++;
    const out = [];
    let guard = 0;
    while (i < n && guard++ < 5000) {
      ws();
      if (src[i] === ']') {
        i++;
        return out;
      }
      if (src[i] === ',') {
        i++;
        continue;
      }
      const before = i;
      if (src.startsWith('...', i)) skipExpr();
      else out.push(value());
      if (i === before) i++;
    }
    return out;
  };
  const object = () => {
    i++;
    const out = {};
    let guard = 0;
    while (i < n && guard++ < 20000) {
      ws();
      if (src[i] === '}') {
        i++;
        return out;
      }
      if (src[i] === ',') {
        i++;
        continue;
      }
      const before = i;
      if (src.startsWith('...', i)) {
        skipExpr();
        continue;
      }
      let key = null;
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') key = str(c);
      else if (c === '[') {
        skipExpr();
        ws();
        if (src[i] === ':') {
          i++;
          value();
        }
        continue;
      } else {
        const m = /^[A-Za-z0-9_$-]+/.exec(src.slice(i, i + 100));
        if (!m) {
          i++;
          continue;
        }
        key = m[0];
        i += m[0].length;
      }
      ws();
      if (src[i] === ':') {
        i++;
        out[key] = value();
      } else if (src[i] === '(') {
        skipExpr();
      } else {
        out[key] = { __expr: key };
      }
      ws();
      if (src[i] === ',') i++;
      if (i === before) i++;
    }
    return out;
  };
  if (src[i] !== '{') return null;
  return { value: object(), end: i };
}

const isExpr = (v) => v && typeof v === 'object' && !Array.isArray(v) && '__expr' in v;

// ---------------------------------------------------------------- value & name heuristics

const COLOR_FN = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;
const HSL_TRIPLET = /^\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%(\s*\/\s*[\d.]+%?)?$/;
const isColorValue = (v) => /^#[0-9a-f]{3,8}$/i.test(v) || COLOR_FN.test(v) || HSL_TRIPLET.test(v);
const isDim = (v) => /^-?(\d*\.)?\d+(px|rem|em|%|vh|vw|ch|pt)?$/i.test(v) || /^calc\(/.test(v);
const isDimNonZeroUnit = (v) => /^-?(\d*\.)?\d+(px|rem|em|pt)$/i.test(v);

function words(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function resolveAlias(value, map) {
  let v = String(value).trim();
  for (let hop = 0; hop < 6; hop++) {
    const m = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/.exec(v);
    if (!m || !map.has(m[1])) break;
    v = String(map.get(m[1])).trim();
  }
  return v;
}

function categorize(ws, value) {
  const w = new Set(ws);
  const has = (...a) => a.some((x) => w.has(x));
  const v = String(value).trim();
  if (isColorValue(v)) return 'color';
  if (/gradient\(|url\(/.test(v)) return 'other';
  if (has('radius', 'radii', 'rounded', 'corner', 'corners') && isDim(v)) return 'radius';
  if (has('shadow', 'shadows', 'elevation') && (/\d/.test(v) || v === 'none')) return 'shadow';
  if ((has('zindex', 'zindices') || (has('z') && has('index')) || has('layer', 'layers')) && /^-?\d+$/.test(v)) return 'z-index';
  if (has('weight', 'weights')) return 'font-weight';
  if ((has('family', 'families', 'typeface') || (has('font', 'fonts') && !has('size', 'sizes', 'style', 'height'))) &&
      (/[,"']/.test(v) || /sans|serif|mono|system/i.test(v))) return 'font-family';
  if (((has('font') && has('size', 'sizes')) || has('fontsize', 'fontsizes', 'fs', 'typescale') || has('text')) && isDim(v) && !/^0/.test(v)) return 'font-size';
  if (has('space', 'spacing', 'gap', 'gutter', 'padding', 'margin', 'inset', 'size', 'sizes', 'sizing') && isDim(v)) return 'spacing';
  if (has('color', 'colors', 'colour', 'bg', 'background', 'surface', 'border', 'foreground', 'fill', 'stroke') &&
      !isDim(v) && !/^\d/.test(v)) return 'color';
  return 'other';
}

const COLOR_NAMES = new Set(['gray', 'grey', 'slate', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow', 'lime',
  'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose', 'black', 'white']);

function classify(ws, category) {
  const w = new Set(ws);
  const has = (...a) => a.some((x) => w.has(x));
  if (category === 'spacing') return { role: 'spacing', confidence: 0.9 };
  if (category === 'radius') return { role: 'radius', confidence: 0.9 };
  if (category === 'font-size') return { role: 'font-size', confidence: 0.9 };
  if (category === 'font-family') return { role: 'font-family', confidence: 0.9 };
  if (category === 'shadow') return { role: 'shadow', confidence: 0.85 };
  if (category === 'z-index') return { role: 'z-index', confidence: 0.85 };
  if (category === 'font-weight') return { role: 'other', confidence: 0.6, hint: 'font-weight' };
  if (category === 'other') {
    if (has('breakpoint', 'screen', 'screens', 'ease', 'duration', 'transition', 'animate', 'animation', 'blur',
      'aspect', 'container', 'opacity', 'leading', 'tracking', 'lineheight', 'line', 'delay')) {
      return { role: 'other', confidence: 0.6 };
    }
    return { role: null, confidence: 0.3 };
  }
  // colors
  if (has('live', 'recording', 'record', 'premium', 'vip', 'gold', 'promo', 'sale', 'beta', 'pro')) {
    return { role: 'reserved', confidence: 0.55 };
  }
  if (has('danger', 'error', 'destructive', 'negative', 'critical', 'invalid')) return { role: 'danger', confidence: 0.9 };
  if (has('success', 'positive', 'valid', 'ok')) return { role: 'success', confidence: 0.9 };
  if (has('warning', 'caution', 'warn')) return { role: 'warning', confidence: 0.9 };
  if (has('info', 'notice')) return { role: 'info', confidence: 0.85 };
  const isText = has('text', 'foreground', 'fg', 'ink');
  const isBorder = has('border', 'outline', 'divider', 'stroke', 'separator', 'ring');
  const isAction = has('primary', 'brand', 'cta', 'action', 'interactive');
  const isSurface = has('bg', 'background', 'surface', 'canvas', 'card', 'panel', 'paper', 'layer', 'overlay', 'backdrop',
    'elevated', 'elevation', 'page', 'sheet', 'modal', 'popover', 'dialog');
  if (isText) {
    let level = 2;
    if (has('tertiary', 'muted', 'disabled', 'placeholder', 'faint', 'hint', 'dim', 'low', 'caption')) level = 4;
    else if (has('secondary', 'soft', 'medium', 'subtle')) level = 3;
    else if (has('title', 'heading', 'strong', 'high', 'primary', 'inverse')) level = 1;
    return isAction && has('foreground', 'fg')
      ? { role: 'text', confidence: 0.7 }
      : { role: 'text', confidence: 0.85, level };
  }
  if (isBorder) return { role: 'border', confidence: 0.85 };
  if (isAction) return { role: 'action', confidence: 0.8 };
  if (isSurface) {
    let level = 1;
    if (has('overlay', 'modal', 'popover', 'dialog', 'sheet', 'dropdown', 'tooltip', 'menu', 'backdrop')) level = 3;
    else if (has('raised', 'elevated', 'hover', 'input', 'secondary', 'muted', 'subtle', 'inset', 'well')) level = 2;
    else if (has('background', 'canvas', 'page', 'base', 'app', 'body', 'dark')) level = 0;
    const num = ws.find((x) => /^\d$/.test(x));
    return { role: 'surface', confidence: has('surface', 'bg', 'background', 'card') ? 0.85 : 0.7, level: level * 10 + (num ? Number(num) : 0) };
  }
  if (has('accent', 'highlight', 'emphasis', 'secondary')) return { role: 'emphasis', confidence: 0.55 };
  if (has('muted')) return { role: 'surface', confidence: 0.5, level: 20 };
  const colorName = ws.find((x) => COLOR_NAMES.has(x));
  if (colorName && ws.some((x) => /^\d{2,3}$/.test(x))) return { role: 'other', confidence: 0.6, hint: 'palette' };
  if (has('red')) return { role: 'danger', confidence: 0.6 };
  if (has('green')) return { role: 'success', confidence: 0.6 };
  if (has('amber', 'yellow', 'orange')) return { role: 'warning', confidence: 0.5 };
  if (colorName) return { role: 'other', confidence: 0.5, hint: 'palette' };
  return { role: null, confidence: 0.3 };
}

const ROLE_ORDER = ['surface', 'text', 'border', 'action', 'emphasis', 'success', 'danger', 'warning', 'info', 'reserved',
  'spacing', 'radius', 'font-size', 'font-family', 'shadow', 'z-index', 'other'];

function toPx(v) {
  const m = /^(-?(?:\d*\.)?\d+)(px|rem|em)?$/.exec(String(v).trim());
  if (!m) return Number.POSITIVE_INFINITY;
  const n = Number(m[1]);
  return m[2] === 'rem' || m[2] === 'em' ? n * 16 : n;
}

// ---------------------------------------------------------------- token extraction

const TW4_NAMESPACES = ['drop-shadow', 'inset-shadow', 'text-shadow', 'font-weight', 'breakpoint', 'container', 'perspective',
  'tracking', 'leading', 'spacing', 'radius', 'shadow', 'color', 'font', 'text', 'blur', 'ease', 'animate', 'aspect'];
const TW4_UTILITY_PREFIX = { text: 'text-', radius: 'rounded-', shadow: 'shadow-', font: 'font-', 'font-weight': 'font-' };

function stripCssComments(text, isScss) {
  let t = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  if (isScss) t = t.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return t;
}

function themeRanges(text) {
  const ranges = [];
  const re = /@theme\b[^{;]*\{/g;
  let m;
  while ((m = re.exec(text))) {
    let d = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && d > 0) {
      if (text[i] === '{') d++;
      else if (text[i] === '}') d--;
      i++;
    }
    ranges.push([start, i]);
  }
  return ranges;
}

function extractCssTokens(rel, text) {
  const ext = extOf(rel);
  const out = [];
  const t = stripCssComments(text, ext === '.scss' || ext === '.less');
  const ranges = themeRanges(t);
  const re = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+)/g;
  let m;
  while ((m = re.exec(t))) {
    const name = m[1];
    const value = m[2].trim().replace(/\s+/g, ' ');
    if (!value || name.startsWith('--tw-') || /^--.+--/.test(name.slice(2))) continue;
    const inTheme = ranges.some(([a, b]) => m.index >= a && m.index < b);
    out.push({ name, value, kind: inTheme ? 'tailwind-theme' : 'css-var', source: rel });
  }
  if (ext === '.scss' || ext === '.sass') {
    const rs = /^\$([A-Za-z0-9_-]+)\s*:\s*([^;\n]+)/gm;
    while ((m = rs.exec(t))) {
      const value = m[2].replace(/!default|!global/g, '').trim();
      if (!value || value.startsWith('(') || value.startsWith('map') || value.includes('#{') || /\$[\w-]+\s*[*+/]/.test(value)) continue;
      out.push({ name: `$${m[1]}`, value, kind: 'scss-var', source: rel });
    }
  }
  if (ext === '.less') {
    const rl = /^[ \t]*@([A-Za-z0-9_-]+)\s*:\s*([^;\n]+);/gm;
    while ((m = rl.exec(t))) out.push({ name: `@${m[1]}`, value: m[2].trim(), kind: 'less-var', source: rel });
  }
  return out;
}

const TW_SECTIONS = {
  colors: 'color', spacing: 'spacing', borderRadius: 'radius', fontSize: 'font-size',
  fontFamily: 'font-family', boxShadow: 'shadow', zIndex: 'z-index',
};
const TW_UTIL_PREFIX = { colors: '', spacing: '', borderRadius: 'rounded', fontSize: 'text', fontFamily: 'font', boxShadow: 'shadow', zIndex: 'z' };

function leavesOf(prefix, node, out, depth = 0) {
  if (depth > 8) return;
  if (typeof node === 'string' || typeof node === 'number') out.push([prefix, String(node)]);
  else if (isExpr(node)) out.push([prefix, `expr:${node.__expr}`]);
  else if (Array.isArray(node)) {
    const strs = node.filter((x) => typeof x === 'string' || typeof x === 'number');
    if (strs.length) out.push([prefix, node.length > 1 && typeof node[1] === 'string' ? String(strs[0]) : strs.join(', ')]);
  } else if (node && typeof node === 'object') {
    for (const k of Object.keys(node).sort(cmp)) {
      leavesOf(k === 'DEFAULT' ? prefix : [...prefix, k], node[k], out, depth + 1);
    }
  }
}

function extractTailwindConfig(rel, text) {
  const out = [];
  let tree = null;
  const re = /(?:module\.exports\s*=|export\s+default|const\s+config(?:\s*:\s*[\w.]+)?\s*=)\s*(?:defineConfig\()?\s*(?:\w+\()?\s*\{/;
  const m = re.exec(text);
  if (m) {
    const r = parseJsObjectAt(text, m.index + m[0].length - 1);
    if (r) tree = r.value;
  }
  if (!tree || !tree.theme) {
    const tm = /theme\s*:\s*\{/.exec(text);
    if (tm) {
      const r = parseJsObjectAt(text, tm.index + tm[0].length - 1);
      if (r) tree = { theme: r.value };
    }
  }
  if (!tree || typeof tree.theme !== 'object') return out;
  const seen = new Map();
  const scopes = [tree.theme, tree.theme.extend].filter((s) => s && typeof s === 'object' && !isExpr(s));
  for (const scope of scopes) {
    for (const sec of Object.keys(TW_SECTIONS)) {
      if (!scope[sec] || typeof scope[sec] !== 'object' || isExpr(scope[sec])) continue;
      const leaves = [];
      leavesOf([], scope[sec], leaves);
      for (const [path, value] of leaves) {
        if (!path.length) continue;
        const name = `${sec}.${path.join('.')}`;
        const util = [TW_UTIL_PREFIX[sec], ...path].filter(Boolean).join('-');
        seen.set(name, { name, value, kind: 'tailwind-config', source: rel, section: sec, utility: util });
      }
    }
  }
  return [...seen.values()].concat(out);
}

function extractJsonTokens(rel, obj) {
  const out = [];
  const walkNode = (node, path, type, depth) => {
    if (depth > 10 || node == null) return;
    if (typeof node === 'string' || typeof node === 'number') {
      if (path.length) out.push({ path, value: String(node), type });
      return;
    }
    if (Array.isArray(node)) return;
    if (typeof node === 'object') {
      const t = typeof node.$type === 'string' ? node.$type : typeof node.type === 'string' ? node.type : type;
      const val = '$value' in node ? node.$value : 'value' in node ? node.value : undefined;
      if (val !== undefined && (typeof val === 'string' || typeof val === 'number')) {
        out.push({ path, value: String(val), type: t });
        return;
      }
      for (const k of Object.keys(node).sort(cmp)) {
        if (k.startsWith('$') || k === 'description' || k === 'extensions') continue;
        walkNode(node[k], [...path, k], t, depth + 1);
      }
    }
  };
  walkNode(obj, [], undefined, 0);
  return out.map((o) => ({
    name: o.path.join('.'), value: o.value, kind: 'json', source: rel, typeHint: o.type,
    utility: o.path.join('-'),
  }));
}

const THEME_DECL = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:\w+\(\s*)?\{/g;
const THEME_NAME = /theme|token|palette|colou?rs?|spacing|radii|radius|shadows?|typography|fonts?|sizes|space|zindex/i;
const GENERIC_ROOT = /^(theme|tokens?|designtokens|defaulttheme|lighttheme|darktheme|basetheme)$/i;

function extractThemeObjects(rel, text) {
  const out = [];
  const decls = [];
  let m;
  THEME_DECL.lastIndex = 0;
  while ((m = THEME_DECL.exec(text))) {
    if (THEME_NAME.test(m[1])) decls.push({ name: m[1], at: m.index + m[0].length - 1 });
  }
  const ed = /export\s+default\s+\{/.exec(text);
  if (ed) decls.push({ name: 'theme', at: ed.index + ed[0].length - 1 });
  for (const d of decls.slice(0, 12)) {
    const r = parseJsObjectAt(text, d.at);
    if (!r) continue;
    const leaves = [];
    leavesOf([], r.value, leaves);
    for (const [path, value] of leaves) {
      if (!path.length || value.startsWith('expr:') || value.length > 120) continue;
      const full = GENERIC_ROOT.test(d.name) ? path : [d.name, ...path];
      out.push({ name: full.join('.'), value, kind: 'theme-object', source: rel, utility: full.join('-') });
    }
  }
  return out;
}

// ---------------------------------------------------------------- inferred (hardcoded) values

const HEX_RE = /(?<![\w&/#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const FN_COLOR_RE = /\b(?:rgba?|hsla?|oklch|oklab|hwb)\(\s*[^()$]*\)/gi;
const DIM_TOKEN = /^-?(?:\d*\.)?\d+(?:px|rem|em)$/i;

function normDim(v) {
  const m = /^(-?)((?:\d*\.)?\d+)(px|rem|em)$/i.exec(v);
  if (!m) return null;
  const n = Number(m[2]);
  if (n === 0) return null;
  return `${m[1]}${n}${m[3].toLowerCase()}`;
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function scanHardcoded(text, acc) {
  let m;
  HEX_RE.lastIndex = 0;
  while ((m = HEX_RE.exec(text))) {
    const idx = m.index;
    const before = text.slice(Math.max(0, idx - 8), idx);
    if (/href=\s*["']?$/.test(before) || /url\(\s*["']?$/.test(before)) continue;
    const after = /^\s*\{/.exec(text.slice(idx + m[0].length, idx + m[0].length + 8));
    if (after) continue;
    let h = m[0].toLowerCase();
    if (h.length === 4 || h.length === 5) h = `#${[...h.slice(1)].map((c) => c + c).join('')}`;
    bump(acc.colors, h);
  }
  FN_COLOR_RE.lastIndex = 0;
  while ((m = FN_COLOR_RE.exec(text))) {
    bump(acc.colors, m[0].toLowerCase().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')'));
  }
  const addDims = (str, map) => {
    for (const tok of str.split(/\s+/)) {
      if (!DIM_TOKEN.test(tok)) continue;
      const d = normDim(tok);
      if (d) bump(map, d);
    }
  };
  const cssProp = (re, map) => {
    re.lastIndex = 0;
    let x;
    while ((x = re.exec(text))) if (!/var\(|calc\(/.test(x[1])) addDims(x[1].trim(), map);
  };
  cssProp(/border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius\s*:\s*([^;}\n]+)/g, acc.radii);
  cssProp(/(?<![\w-])(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?\s*:\s*([^;}\n]+)/g, acc.spacing);
  cssProp(/(?<![\w-])font-size\s*:\s*([^;}\n]+)/g, acc.fontSizes);
  const jsProp = (re, map) => {
    re.lastIndex = 0;
    let x;
    while ((x = re.exec(text))) {
      if (x[1] !== undefined) {
        const d = normDim(`${x[1]}px`);
        if (d) bump(map, d);
      } else if (x[2] !== undefined && !/var\(|calc\(/.test(x[2])) addDims(x[2].trim(), map);
    }
  };
  jsProp(/(?<![\w-])border(?:Top|Bottom)?(?:Left|Right)?Radius\s*:\s*(?:(\d+(?:\.\d+)?)(?=\s*[,}\n])|['"]([^'"\n]+)['"])/g, acc.radii);
  jsProp(/(?<![\w-])(?:padding|margin)(?:Top|Right|Bottom|Left|Inline|Block)?\s*:\s*(?:(\d+(?:\.\d+)?)(?=\s*[,}\n])|['"]([^'"\n]+)['"])/g, acc.spacing);
  jsProp(/(?<![\w-])(?:gap|rowGap|columnGap)\s*:\s*(?:(\d+(?:\.\d+)?)(?=\s*[,}\n])|['"]([^'"\n]+)['"])/g, acc.spacing);
  jsProp(/(?<![\w-])fontSize\s*:\s*(?:(\d+(?:\.\d+)?)(?=\s*[,}\n])|['"]([^'"\n]+)['"])/g, acc.fontSizes);
  const arb = (re, map) => {
    re.lastIndex = 0;
    let x;
    while ((x = re.exec(text))) {
      const d = normDim(x[1]);
      if (d) bump(map, d);
    }
  };
  arb(/(?<![\w-])rounded(?:-[a-z]{1,2})?-\[((?:\d*\.)?\d+(?:px|rem|em))\]/g, acc.radii);
  arb(/(?<![\w-])(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy])-\[((?:\d*\.)?\d+(?:px|rem|em))\]/g, acc.spacing);
  arb(/(?<![\w-])text-\[((?:\d*\.)?\d+(?:px|rem|em))\]/g, acc.fontSizes);
}

function topInferred(map, n) {
  const arr = [...map.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
  return {
    items: arr.slice(0, n).map(([value, count]) => ({ value, count, inferred: true })),
    distinct: arr.length,
    truncated: Math.max(0, arr.length - n),
  };
}

// ---------------------------------------------------------------- project analysis

function hasDep(deps, name) {
  return Object.prototype.hasOwnProperty.call(deps, name);
}

function detectFramework(deps) {
  const order = [
    ['next', 'next'], ['nuxt', 'nuxt'], ['astro', 'astro'], ['@sveltejs/kit', 'sveltekit'],
    ['@remix-run/react', 'remix'], ['gatsby', 'gatsby'], ['@angular/core', 'angular'], ['svelte', 'svelte'],
    ['vue', 'vue'], ['solid-js', 'solid'], ['preact', 'preact'], ['@builder.io/qwik', 'qwik'], ['lit', 'lit'], ['react', 'react'],
  ];
  const found = order.filter(([d]) => hasDep(deps, d)).map(([, n]) => n);
  return { framework: found[0] || null, frameworks: found };
}

function importFor(fileRel, alias) {
  if (!alias) return null;
  let best = null;
  const cfgDir = dirOf(alias.configFile);
  const base = posix.normalize(posix.join(cfgDir === '.' ? '' : cfgDir, alias.baseUrl || '.'));
  for (const p of alias.paths) {
    for (const t of p.targets) {
      const star = t.endsWith('/*');
      const tdir = posix.normalize(posix.join(base, star ? t.slice(0, -2) : t));
      const dirPrefix = tdir === '.' ? '' : `${tdir}/`;
      if (star && p.alias.endsWith('/*') && fileRel.startsWith(dirPrefix)) {
        const rest = fileRel.slice(dirPrefix.length).replace(/\.(ts|js|tsx|jsx|mjs)$/, '').replace(/\/index$/, '');
        const cand = `${p.alias.slice(0, -1)}${rest}`;
        if (!best || dirPrefix.length > best.len) best = { len: dirPrefix.length, path: cand };
      }
    }
  }
  return best ? best.path : null;
}

function analyzeCandidate(cand, ctx) {
  const { rootAbs, warnings } = ctx;
  const croot = cand.dir;
  const prefix = croot === '.' ? '' : `${croot}/`;
  const files = cand.files;
  const crel = (f) => f.slice(prefix.length);
  const pkg = cand.pkg || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) };
  const { framework, frameworks } = detectFramework(deps);

  // read code files
  const texts = new Map();
  let totalBytes = 0;
  for (const f of files) {
    const ext = extOf(f);
    if (!CODE_EXT.has(ext)) continue;
    if (totalBytes > LIMITS.maxTotalBytes) {
      warnings.add(`total read limit reached for ${croot}; remaining files skipped`);
      break;
    }
    const t = readText(join(rootAbs, f), warnings, f);
    if (t != null) {
      texts.set(f, t);
      totalBytes += t.length;
    }
  }
  const fileSet = new Set(files);
  const find = (re) => files.filter((f) => re.test(crel(f)));

  // config discovery
  const twConfigs = find(/^tailwind\.config\.(js|cjs|mjs|ts|mts|cts)$/);
  const tsconfig = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json', 'jsconfig.json']
    .map((n) => prefix + n).filter((f) => fileSet.has(f));
  const typescript = fileSet.has(`${prefix}tsconfig.json`) || hasDep(deps, 'typescript');
  const cssFiles = files.filter((f) => STYLE_EXT.has(extOf(f)));
  const moduleStyles = files.filter((f) => /\.module\.(css|scss|sass|less)$/.test(f));

  // shadcn
  let shadcn = null;
  if (fileSet.has(`${prefix}components.json`)) {
    const cj = readJson(join(rootAbs, `${prefix}components.json`), warnings, `${prefix}components.json`);
    if (cj && typeof cj === 'object') {
      shadcn = {
        style: cj.style ?? null,
        baseColor: cj.tailwind?.baseColor ?? null,
        cssVariables: cj.tailwind?.cssVariables ?? null,
        aliases: cj.aliases && typeof cj.aliases === 'object' ? cj.aliases : null,
      };
    }
  }

  // tokens
  const raw = [];
  const tokenFiles = new Map();
  const addTokens = (arr, file, kind) => {
    if (arr.length) tokenFiles.set(file, kind);
    raw.push(...arr);
  };
  for (const f of cssFiles) {
    const t = texts.get(f);
    if (t == null) continue;
    const arr = extractCssTokens(f, t);
    const kind = arr.some((x) => x.kind === 'tailwind-theme') ? 'tailwind-v4-theme'
      : arr.some((x) => x.kind === 'css-var') ? 'css-variables'
        : arr.some((x) => x.kind === 'scss-var') ? 'scss-variables'
          : arr.some((x) => x.kind === 'less-var') ? 'less-variables' : null;
    if (kind) addTokens(arr, f, kind);
  }
  for (const f of twConfigs) {
    const t = texts.get(f);
    if (t != null) addTokens(extractTailwindConfig(f, t), f, 'tailwind-config');
  }
  const jsonTokenFiles = files.filter((f) => /(^|\/)((design-)?tokens?(\.[\w-]+)?|[\w-]+\.tokens)\.json$/i.test(f) ||
    /(^|\/)tokens\/[^/]+\.json$/i.test(crel(f)) || /(^|\/)style-dictionary\/[^/]+\.json$/i.test(crel(f)));
  for (const f of jsonTokenFiles) {
    const obj = readJson(join(rootAbs, f), warnings, f);
    if (obj && typeof obj === 'object') addTokens(extractJsonTokens(f, obj), f, 'design-tokens-json');
  }
  const themeFiles = files.filter((f) => {
    const c = crel(f);
    return /\.(ts|tsx|js|jsx|mjs|mts)$/.test(c) && !/(\.test\.|\.spec\.|\.stories\.|config\.)/.test(c) &&
      /(^|\/)(theme|themes|tokens?|palette|colors?|design-?system|design-?tokens)([.-][\w-]+)?\.(ts|tsx|js|jsx|mjs|mts)$|(^|\/)(theme|tokens|styles)\/index\.(ts|js)$/i.test(c);
  });
  for (const f of themeFiles) {
    const t = texts.get(f);
    if (t != null) addTokens(extractThemeObjects(f, t), f, 'theme-object');
  }

  // dedupe by name (first source in sorted order wins), track definition counts
  const defCount = new Map();
  const byName = new Map();
  for (const t of raw) {
    defCount.set(t.name, (defCount.get(t.name) || 0) + 1);
    if (!byName.has(t.name)) byName.set(t.name, t);
  }
  const varMap = new Map();
  for (const t of byName.values()) if (t.kind === 'css-var' || t.kind === 'tailwind-theme') varMap.set(t.name, t.value);

  // usage index
  const tokenFileSet = new Set(tokenFiles.keys());
  const pureTokenFiles = new Set([...tokenFiles.entries()].filter(([, k]) => /config|json|theme-object/.test(k)).map(([f]) => f));
  const wordIdx = new Map();
  const wre = /\$?-{0,2}[A-Za-z0-9_][A-Za-z0-9_-]*/g;
  const allCode = [];
  for (const [f, t] of texts) {
    if (pureTokenFiles.has(f) || !CODE_EXT.has(extOf(f))) continue;
    allCode.push(t);
    for (const mm of t.matchAll(wre)) {
      const w = mm[0];
      if (w.length > 80) continue;
      bump(wordIdx, w);
      if (w[0] !== '-' && w[0] !== '$') {
        let k = -1;
        bump(wordIdx, `~${w}`);
        while ((k = w.indexOf('-', k + 1)) !== -1) bump(wordIdx, `~${w.slice(k + 1)}`);
      }
    }
  }
  const joined = allCode.join('\n');
  const countSub = (needle) => {
    if (!needle || needle.length < 4) return 0;
    let c = 0;
    let i = joined.indexOf(needle);
    while (i !== -1 && c < 9999) {
      c++;
      i = joined.indexOf(needle, i + needle.length);
    }
    return c;
  };

  const tokens = [];
  const unclassified = [];
  for (const t of [...byName.values()].sort((a, b) => cmp(a.name, b.name))) {
    const resolved = resolveAlias(t.value, varMap);
    let nameWords;
    let hintCategory = null;
    let utilities = [];
    if (t.kind === 'tailwind-theme') {
      const bare = t.name.slice(2);
      const ns = TW4_NAMESPACES.find((n) => bare === n || bare.startsWith(`${n}-`)) || null;
      nameWords = words(bare);
      const rest = ns && bare.length > ns.length ? bare.slice(ns.length + 1) : '';
      if (rest) utilities.push(`${TW4_UTILITY_PREFIX[ns] || ''}${rest}`);
      hintCategory = { color: 'color', text: 'font-size', radius: 'radius', shadow: 'shadow', spacing: 'spacing',
        'font-weight': 'font-weight' }[ns] || null;
      if (ns === 'font' && /[,"']|sans|serif|mono/i.test(resolved)) hintCategory = 'font-family';
    } else if (t.kind === 'tailwind-config') {
      nameWords = words(t.name.replace(/^[^.]+\./, '')).concat(words(t.section));
      hintCategory = TW_SECTIONS[t.section];
      utilities = [t.utility];
    } else if (t.kind === 'json' || t.kind === 'theme-object') {
      nameWords = words(t.name).concat(t.typeHint ? words(t.typeHint) : []);
      utilities = [t.utility];
    } else {
      nameWords = words(t.name);
    }
    let category = categorize(nameWords, resolved);
    if (hintCategory && category === 'other' && (hintCategory !== 'color' || !isDim(resolved))) category = hintCategory;
    if (category === 'other' && (t.kind === 'theme-object' || t.kind === 'json') && !/\d|[a-z]/i.test(resolved)) continue;
    const cls = classify(nameWords, category);

    let usage = 0;
    for (const u of utilities) usage = Math.max(usage, wordIdx.get(`~${u}`) || 0);
    if (t.kind === 'css-var' || t.kind === 'tailwind-theme' || t.kind === 'scss-var' || t.kind === 'less-var') {
      usage = Math.max(usage, Math.max(0, (wordIdx.get(t.name) || 0) - (defCount.get(t.name) || 0)));
    } else if (t.kind === 'json' || t.kind === 'theme-object') {
      const segs = t.name.split('.');
      usage = Math.max(usage, countSub(segs.slice(-2).join('.')), wordIdx.get(`--${t.utility}`) || 0, wordIdx.get(`$${t.utility}`) || 0);
    }
    const rec = {
      name: t.name, value: t.value, source: t.source, kind: t.kind, category,
      role: cls.role, confidence: cls.confidence, usage, inferred: false,
    };
    if (resolved !== t.value) rec.resolvedValue = resolved;
    if (cls.level !== undefined) rec.level = cls.level;
    if (cls.hint) rec.hint = cls.hint;
    if (cls.role === null || cls.confidence < 0.5) {
      unclassified.push({ name: t.name, value: t.value, source: t.source, kind: t.kind, category, usage, inferred: false,
        ...(rec.resolvedValue ? { resolvedValue: rec.resolvedValue } : {}) });
    } else tokens.push(rec);
  }
  tokens.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) ||
    (a.level ?? 99) - (b.level ?? 99) || cmp(a.name, b.name));
  unclassified.sort((a, b) => b.usage - a.usage || cmp(a.name, b.name));

  // scales
  const names = (role, sorter) => tokens.filter((t) => t.role === role).sort(sorter).map((t) => t.name);
  const byLevel = (a, b) => (a.level ?? 99) - (b.level ?? 99) || cmp(a.name, b.name);
  const byPx = (a, b) => toPx(a.resolvedValue ?? a.value) - toPx(b.resolvedValue ?? b.value) || cmp(a.name, b.name);
  const roleCounts = {};
  for (const t of tokens) roleCounts[t.role] = (roleCounts[t.role] || 0) + 1;
  const scales = {
    surfaceElevation: names('surface', byLevel),
    textHierarchy: names('text', byLevel),
    action: names('action', (a, b) => cmp(a.name, b.name)),
    border: names('border', (a, b) => cmp(a.name, b.name)),
    emphasis: names('emphasis', (a, b) => cmp(a.name, b.name)),
    status: {
      success: names('success', (a, b) => cmp(a.name, b.name)),
      danger: names('danger', (a, b) => cmp(a.name, b.name)),
      warning: names('warning', (a, b) => cmp(a.name, b.name)),
      info: names('info', (a, b) => cmp(a.name, b.name)),
    },
    reserved: names('reserved', (a, b) => cmp(a.name, b.name)),
    spacing: names('spacing', byPx),
    radius: names('radius', byPx),
    fontSize: names('font-size', byPx),
  };

  const rolesCovered = Object.keys(roleCounts).filter((r) => ['surface', 'text', 'border', 'action', 'spacing', 'radius', 'font-size'].includes(r));
  const designSystem = tokens.length >= 8 && rolesCovered.length >= 3 ? 'formal' : tokens.length >= 1 ? 'partial' : 'none';

  // inferred
  const acc = { colors: new Map(), radii: new Map(), spacing: new Map(), fontSizes: new Map() };
  for (const [f, t] of texts) {
    if (pureTokenFiles.has(f) || f.endsWith('.json')) continue;
    let s = t;
    if (tokenFileSet.has(f)) s = s.replace(/--[\w-]+\s*:\s*[^;{}]*;?/g, '').replace(/^[ \t]*[$@][\w-]+\s*:[^;\n]*;?/gm, '');
    scanHardcoded(s, acc);
  }
  const inferred = {
    note: 'Inferred by frequency from hardcoded values; NOT official design-system tokens.',
    colors: topInferred(acc.colors, LIMITS.maxInferred),
    radii: topInferred(acc.radii, LIMITS.maxInferred),
    spacing: topInferred(acc.spacing, LIMITS.maxInferred),
    fontSizes: topInferred(acc.fontSizes, LIMITS.maxInferred),
  };

  // primitives
  const dirSet = new Set();
  for (const f of files) {
    const parts = crel(f).split('/');
    for (let k = 1; k < parts.length; k++) dirSet.add(parts.slice(0, k).join('/'));
  }
  const primDirs = [...dirSet].filter((d) => {
    const depth = d.split('/').length;
    return depth <= 5 && !/(__tests__|stories|node_modules|\/pages\/|\/app\/)/.test(d) &&
      /(^|\/)(components\/(ui|primitives|atoms|common|shared|base|core|elements|design-system)|ui|ui-kit|primitives|design-system|atoms)$/i.test(d);
  }).sort(cmp);
  const primitives = [];
  for (const d of primDirs) {
    const comp = new Set();
    for (const f of files) {
      const c = crel(f);
      if (!c.startsWith(`${d}/`)) continue;
      const rest = c.slice(d.length + 1).split('/');
      if (!/\.(tsx|jsx|vue|svelte|astro)$/.test(rest[rest.length - 1]) || /\.(test|spec|stories)\./.test(rest[rest.length - 1])) continue;
      const stem = rest[rest.length - 1].replace(/\.[^.]+$/, '');
      if (rest.length === 1 && stem !== 'index') comp.add(stem);
      else if (rest.length === 2 && (stem === 'index' || stem.toLowerCase().replace(/[-_]/g, '') === rest[0].toLowerCase().replace(/[-_]/g, ''))) comp.add(rest[0]);
    }
    if (!comp.size) continue;
    const list = [...comp].sort(cmp);
    primitives.push({
      dir: croot === '.' ? d : `${croot}/${d}`,
      components: list.slice(0, LIMITS.maxComponentsPerDir),
      truncated: Math.max(0, list.length - LIMITS.maxComponentsPerDir),
    });
  }

  // import alias
  let importAlias = null;
  for (const cfg of tsconfig) {
    const j = readJson(join(rootAbs, cfg), warnings, cfg);
    const paths = j?.compilerOptions?.paths;
    if (paths && typeof paths === 'object' && Object.keys(paths).length) {
      importAlias = {
        configFile: cfg,
        baseUrl: j.compilerOptions.baseUrl ?? null,
        paths: Object.keys(paths).sort(cmp).map((a) => ({ alias: a, targets: Array.isArray(paths[a]) ? paths[a].slice().sort(cmp) : [] })),
      };
      break;
    }
  }

  // class-merge helper
  const libs = ['clsx', 'classnames', 'tailwind-merge', 'class-variance-authority', 'tailwind-variants'].filter((d) => hasDep(deps, d));
  let helper = null;
  const helperCandidates = files.filter((f) => /(^|\/)(cn|classnames|clsx|utils?|helpers?|merge|class-?names?)[^/]*\.(ts|js|tsx|jsx|mjs)$|(^|\/)(lib|helpers|utils)\/[^/]+\.(ts|js)$/.test(crel(f)) &&
    !/\.(test|spec)\./.test(f));
  for (const f of helperCandidates.slice(0, 80)) {
    const t = texts.get(f);
    if (!t) continue;
    const m = /export\s+(?:const|function)\s+(cn|clsx|cx|classNames|classnames|cls|twm)\b/.exec(t) ||
      /export\s*\{[^}]*\b(cn|cx|classNames)\b[^}]*\}/.exec(t);
    if (m) {
      const impl = ['clsx', 'classnames', 'tailwind-merge'].filter((d) => t.includes(`'${d}'`) || t.includes(`"${d}"`));
      const rel = f;
      helper = {
        name: m[1], file: rel,
        importPath: importFor(rel, importAlias && { ...importAlias }) || `./${crel(f)}`,
        implementation: impl,
      };
      break;
    }
  }
  const classMerge = helper || libs.length ? { helper, libraries: libs } : null;

  // conventions
  const sample = (primitives.length ? files.filter((f) => primitives.some((p) => f.startsWith(`${p.dir}/`))) : files)
    .filter((f) => /\.(tsx|jsx|vue|svelte)$/.test(f) && !/\.(test|spec|stories)\./.test(f)).slice(0, 40);
  const conv = { arrow: 0, fn: 0, def: 0, named: 0, sq: 0, dq: 0, semi: 0, nosemi: 0, tab: 0, sp2: 0, sp4: 0,
    className: 0, cssModules: 0, styled: 0 };
  const comps = [];
  for (const f of sample) {
    const t = texts.get(f);
    if (!t) continue;
    comps.push(baseOf(f).replace(/\.[^.]+$/, ''));
    conv.arrow += (t.match(/(?:export\s+)?const\s+[A-Z]\w*\s*(?::[^=]+)?=\s*(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>/g) || []).length;
    conv.fn += (t.match(/(?:export\s+(?:default\s+)?)?function\s+[A-Z]\w*\s*\(/g) || []).length;
    conv.def += (t.match(/export\s+default\b/g) || []).length;
    conv.named += (t.match(/export\s+(?:const|function)\s+[A-Z]/g) || []).length;
    for (const line of t.split('\n').filter((l) => /^\s*import\b.*from\s+['"]/.test(l)).slice(0, 10)) {
      if (/from\s+'/.test(line)) conv.sq++;
      else conv.dq++;
      if (/;\s*$/.test(line)) conv.semi++;
      else conv.nosemi++;
    }
    const ind = /^( +|\t+)\S/m.exec(t);
    if (ind) {
      if (ind[1][0] === '\t') conv.tab++;
      else if (ind[1].length === 2) conv.sp2++;
      else if (ind[1].length === 4) conv.sp4++;
    }
    conv.className += (t.match(/className\s*=/g) || []).length;
    conv.cssModules += (t.match(/import\s+\w+\s+from\s+['"][^'"]+\.module\.\w+['"]/g) || []).length;
    conv.styled += (t.match(/styled\.\w+|styled\(|\bcss`/g) || []).length;
  }
  const pick = (pairs) => {
    const best = pairs.slice().sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0];
    return best && best[1] > 0 ? best[0] : null;
  };
  const casing = (n) => (/^[A-Z][a-z0-9]+([A-Z][a-z0-9]*)*$/.test(n) ? 'PascalCase' : /^[a-z0-9]+(-[a-z0-9]+)+$|^[a-z0-9]+$/.test(n) ? 'kebab-case' : /^[a-z]+[A-Z]/.test(n) ? 'camelCase' : 'other');
  const caseCounts = {};
  for (const c of comps) caseCounts[casing(c)] = (caseCounts[casing(c)] || 0) + 1;
  const conventions = {
    sampledFiles: sample.length,
    fileNaming: pick(Object.entries(caseCounts)),
    componentStyle: pick([['arrow-function', conv.arrow], ['function-declaration', conv.fn]]),
    exportStyle: pick([['default', conv.def], ['named', conv.named]]),
    quotes: pick([['single', conv.sq], ['double', conv.dq]]),
    semicolons: pick([['yes', conv.semi], ['no', conv.nosemi]]),
    indent: pick([['tabs', conv.tab], ['2-spaces', conv.sp2], ['4-spaces', conv.sp4]]),
    dominantStyling: pick([['class-names', conv.className], ['css-modules', conv.cssModules], ['css-in-js', conv.styled]]),
  };

  // stack
  const twV4 = [...tokenFiles.values()].includes('tailwind-v4-theme') ||
    hasDep(deps, '@tailwindcss/vite') || hasDep(deps, '@tailwindcss/postcss') ||
    (hasDep(deps, 'tailwindcss') && /^[\^~>=<\s]*4/.test(String(deps.tailwindcss))) ||
    [...texts.values()].some((t) => /@import\s+["']tailwindcss["']/.test(t));
  const twAny = hasDep(deps, 'tailwindcss') || twConfigs.length > 0 || twV4;
  const styling = [];
  if (twAny) styling.push(twV4 ? 'tailwind-v4' : 'tailwind-v3');
  if ([...tokenFiles.values()].includes('css-variables')) styling.push('css-variables');
  if (moduleStyles.length) styling.push('css-modules');
  if (hasDep(deps, 'sass') || cssFiles.some((f) => /\.(scss|sass)$/.test(f))) styling.push('scss');
  if (cssFiles.some((f) => f.endsWith('.less'))) styling.push('less');
  if (hasDep(deps, 'styled-components')) styling.push('styled-components');
  if (hasDep(deps, '@emotion/react') || hasDep(deps, '@emotion/styled')) styling.push('emotion');
  if (hasDep(deps, '@mui/material')) styling.push('mui');
  if (hasDep(deps, '@chakra-ui/react')) styling.push('chakra');
  if (hasDep(deps, '@mantine/core')) styling.push('mantine');
  if (hasDep(deps, 'antd')) styling.push('antd');
  if (hasDep(deps, '@stitches/react')) styling.push('stitches');
  if (hasDep(deps, '@vanilla-extract/css')) styling.push('vanilla-extract');
  if (hasDep(deps, 'bootstrap')) styling.push('bootstrap');
  if ([...tokenFiles.values()].includes('design-tokens-json')) styling.push('design-tokens-json');
  if ([...tokenFiles.values()].includes('theme-object')) styling.push('theme-object');
  if (shadcn) styling.push('shadcn');
  if (!twAny && !styling.length && cssFiles.length) styling.push('plain-css');
  if (!twAny && styling.length === 1 && styling[0] === 'css-variables' && cssFiles.length) styling.push('plain-css');
  const stylingSorted = [...new Set(styling)];

  const allTokens = tokens.length;
  const tokenFilesOut = [...tokenFiles.entries()].sort((a, b) => cmp(a[0], b[0])).map(([path, kind]) => ({ path, kind }));

  return {
    root: croot,
    packageName: pkg.name ?? null,
    stack: {
      styling: stylingSorted,
      framework,
      frameworks,
      typescript,
      tailwindVersion: twAny ? (twV4 ? 4 : 3) : null,
      shadcn,
      libraries: libs,
    },
    designSystem,
    tokenFiles: tokenFilesOut.slice(0, LIMITS.maxTokenFiles),
    tokenFilesTruncated: Math.max(0, tokenFilesOut.length - LIMITS.maxTokenFiles),
    tokens: tokens.slice(0, LIMITS.maxTokens),
    tokensTruncated: Math.max(0, allTokens - LIMITS.maxTokens),
    roleCounts,
    scales,
    unclassified: unclassified.slice(0, LIMITS.maxUnclassified),
    unclassifiedTruncated: Math.max(0, unclassified.length - LIMITS.maxUnclassified),
    inferred,
    primitives,
    classMerge,
    importAlias,
    conventions,
  };
}

// ---------------------------------------------------------------- main

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const warnings = new Set();
  const rootAbs = resolve(args.root);
  const report = { tool: 'ui-gestalt-detect', schemaVersion: 1, scanRoot: toPosix(rootAbs), candidates: [], warnings: [], limits: LIMITS };
  if (args.error) warnings.add(args.error);

  let files = [];
  try {
    if (!statSync(rootAbs).isDirectory()) throw new Error('not a directory');
    files = walk(rootAbs, warnings);
  } catch {
    warnings.add(`root is not a readable directory: ${toPosix(rootAbs)}`);
  }

  // packages
  const pkgs = [];
  for (const f of files) {
    if (baseOf(f) !== 'package.json') continue;
    const pj = readJson(join(rootAbs, f), warnings, f);
    if (!pj || typeof pj !== 'object') continue;
    const deps = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}), ...(pj.peerDependencies || {}) };
    pkgs.push({ dir: dirOf(f), pkg: pj, frontend: FRONTEND_DEPS.some((d) => hasDep(deps, d)) });
  }
  pkgs.sort((a, b) => cmp(a.dir, b.dir));
  const pkgDirs = pkgs.map((p) => p.dir);
  const ownerOf = (f) => {
    let best = null;
    for (const d of pkgDirs) {
      if (d === '.' || f.startsWith(`${d}/`)) if (best === null || d.length > best.length || best === '.') best = d;
    }
    return best;
  };

  let cands = pkgs.filter((p) => p.frontend);
  if (cands.length > 1) {
    const rootC = cands.find((c) => c.dir === '.');
    if (rootC && rootC.pkg.workspaces) cands = cands.filter((c) => c !== rootC);
  }
  if (!cands.length && files.some((f) => STYLE_EXT.has(extOf(f)) || extOf(f) === '.html')) {
    warnings.add('no frontend package.json found; treating the scan root as a plain project');
    cands = [{ dir: '.', pkg: pkgs.find((p) => p.dir === '.')?.pkg || {}, synthetic: true }];
  }
  if (!cands.length) warnings.add('no frontend project detected under the scan root');

  const candDirs = new Set(cands.map((c) => c.dir));
  for (const c of cands) {
    c.files = c.synthetic
      ? files
      : files.filter((f) => {
        const o = ownerOf(f);
        return o === c.dir;
      });
  }
  // warn about non-frontend packages that hold style/token files
  for (const p of pkgs) {
    if (candDirs.has(p.dir) || p.dir === '.') continue;
    const has = files.some((f) => ownerOf(f) === p.dir && (STYLE_EXT.has(extOf(f)) || /tokens?\.json$/i.test(f)));
    if (has && cands.length) warnings.add(`non-frontend package "${p.dir}" contains style/token files; run with --root ${p.dir} to inspect it`);
  }

  const ctx = { rootAbs, warnings };
  for (const c of cands) {
    try {
      report.candidates.push(analyzeCandidate(c, ctx));
    } catch (e) {
      warnings.add(`failed to analyze "${c.dir}": ${e && e.message ? e.message : 'unknown error'}`);
    }
  }
  report.candidates.sort((a, b) => cmp(a.root, b.root));
  report.warnings = [...warnings].sort(cmp);

  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort(cmp)) o[k] = canon(v[k]);
      return o;
    }
    return v;
  };
  process.stdout.write(`${JSON.stringify(canon(report), null, 2)}\n`);
}

try {
  main();
} catch (e) {
  process.stdout.write(`${JSON.stringify({ tool: 'ui-gestalt-detect', schemaVersion: 1, candidates: [], warnings: [`fatal: ${e && e.message ? e.message : 'unknown error'}`] }, null, 2)}\n`);
}
process.exitCode = 0;
