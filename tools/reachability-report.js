#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const repoRoot = process.cwd();
const extensionRoot = path.join(repoRoot, 'extension');
const manifestPath = path.join(extensionRoot, 'manifest.json');
const outputJsonPath = path.join(repoRoot, 'tools', 'reachability-report.json');
const outputMdPath = path.join(repoRoot, 'tools', 'reachability-report.md');

const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '_quarantine']);
const EXCLUDED_EXTENSIONS = new Set(['.map', '.ts', '.psd', '.blend', '.bak']);

const toPosix = (value) => value.split(path.sep).join('/');

const isUrlLike = (value) => /^https?:\/\//i.test(value) || value.startsWith('data:');

const normalizeExtensionPath = (value) => {
  if (!value || typeof value !== 'string') return null;
  if (isUrlLike(value)) return null;
  const trimmed = value.replace(/^\.\/+/, '').trim();
  if (!trimmed) return null;
  return toPosix(trimmed);
};

const resolveRelative = (baseFile, target) => {
  const normalizedTarget = normalizeExtensionPath(target);
  if (!normalizedTarget) return null;
  if (normalizedTarget.startsWith('/')) {
    return normalizeExtensionPath(normalizedTarget.slice(1));
  }
  if (normalizedTarget.startsWith('extension/')) {
    return normalizeExtensionPath(normalizedTarget.replace(/^extension\//, ''));
  }
  const baseDir = path.dirname(baseFile);
  return normalizeExtensionPath(path.join(baseDir, normalizedTarget));
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const readText = (filePath) => fs.readFileSync(filePath, 'utf8');

const listFilesRecursive = (dir) => {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach((entry) => {
    if (EXCLUDED_DIRS.has(entry.name)) return;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath));
      return;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (EXCLUDED_EXTENSIONS.has(ext)) return;
    results.push(fullPath);
  });
  return results;
};

const allFiles = listFilesRecursive(extensionRoot)
  .map((filePath) => toPosix(path.relative(extensionRoot, filePath)))
  .sort();

const fileExists = (relativePath) => fs.existsSync(path.join(extensionRoot, relativePath));

const edges = [];
const reachable = new Set();
const missingFiles = new Set();

const addEdge = (from, to, reason) => {
  if (!to) return;
  edges.push({ from, to, reason });
};

const enqueue = (filePath, reason, from) => {
  if (!filePath) return;
  if (!reachable.has(filePath)) {
    reachable.add(filePath);
  }
  if (from) {
    addEdge(from, filePath, reason);
  }
};

const collectManifestSeeds = () => {
  const manifest = readJson(manifestPath);
  const seeds = [];
  const addSeed = (value, reason) => {
    const normalized = normalizeExtensionPath(value);
    if (normalized) {
      seeds.push({ file: normalized, reason });
    }
  };
  addSeed('manifest.json', 'manifest.root');
  if (manifest.background?.service_worker) {
    addSeed(manifest.background.service_worker, 'manifest.background.service_worker');
  }
  (manifest.content_scripts || []).forEach((entry, index) => {
    (entry.js || []).forEach((file) =>
      addSeed(file, `manifest.content_scripts[${index}].js`)
    );
    (entry.css || []).forEach((file) =>
      addSeed(file, `manifest.content_scripts[${index}].css`)
    );
  });
  if (manifest.action?.default_popup) {
    addSeed(manifest.action.default_popup, 'manifest.action.default_popup');
  }
  if (manifest.browser_action?.default_popup) {
    addSeed(manifest.browser_action.default_popup, 'manifest.browser_action.default_popup');
  }
  if (manifest.options_page) {
    addSeed(manifest.options_page, 'manifest.options_page');
  }
  if (manifest.options_ui?.page) {
    addSeed(manifest.options_ui.page, 'manifest.options_ui.page');
  }
  if (manifest.web_accessible_resources) {
    manifest.web_accessible_resources.forEach((entry, index) => {
      (entry.resources || []).forEach((file) =>
        addSeed(file, `manifest.web_accessible_resources[${index}]`)
      );
    });
  }
  if (manifest.icons) {
    Object.entries(manifest.icons).forEach(([size, file]) =>
      addSeed(file, `manifest.icons.${size}`)
    );
  }
  return seeds;
};

const parseHtmlReferences = (filePath, content) => {
  const references = [];
  const scriptRegex = /<script[^>]+src=["']([^"']+)["']/gi;
  const linkRegex = /<link[^>]+href=["']([^"']+)["']/gi;
  let match;
  while ((match = scriptRegex.exec(content))) {
    references.push({ target: match[1], reason: 'html.script' });
  }
  while ((match = linkRegex.exec(content))) {
    references.push({ target: match[1], reason: 'html.link' });
  }
  return references.map((entry) => ({
    ...entry,
    resolved: resolveRelative(filePath, entry.target)
  }));
};

const parseJsReferences = (filePath, content) => {
  const references = [];
  const importScriptsRegex = /importScripts\(([^)]+)\)/g;
  const stringLiteralRegex = /['"]([^'"]+)['"]/g;
  let match;
  while ((match = importScriptsRegex.exec(content))) {
    const rawArgs = match[1];
    let innerMatch;
    while ((innerMatch = stringLiteralRegex.exec(rawArgs))) {
      references.push({ target: innerMatch[1], reason: 'importScripts' });
    }
  }
  const runtimeUrlRegex = /(chrome|browser)\.runtime\.getURL\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = runtimeUrlRegex.exec(content))) {
    references.push({ target: match[2], reason: 'runtime.getURL' });
  }
  const fetchRuntimeUrlRegex = /fetch\(\s*(?:chrome|browser)\.runtime\.getURL\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g;
  while ((match = fetchRuntimeUrlRegex.exec(content))) {
    references.push({ target: match[1], reason: 'fetch(runtime.getURL)' });
  }
  const workerRegex = /new\s+Worker\(\s*(['"])([^'"]+)\1\s*\)/g;
  while ((match = workerRegex.exec(content))) {
    references.push({ target: match[2], reason: 'worker' });
  }
  const workerRuntimeRegex = /new\s+Worker\(\s*(?:chrome|browser)\.runtime\.getURL\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g;
  while ((match = workerRuntimeRegex.exec(content))) {
    references.push({ target: match[1], reason: 'worker.runtime.getURL' });
  }
  return references.map((entry) => ({
    ...entry,
    resolved: resolveRelative(filePath, entry.target)
  }));
};

const processFile = (filePath) => {
  const absolutePath = path.join(extensionRoot, filePath);
  if (!fs.existsSync(absolutePath)) {
    missingFiles.add(filePath);
    return [];
  }
  const ext = path.extname(filePath).toLowerCase();
  const content = readText(absolutePath);
  if (ext === '.html') {
    return parseHtmlReferences(filePath, content);
  }
  if (ext === '.js') {
    return parseJsReferences(filePath, content);
  }
  return [];
};

const seeds = collectManifestSeeds();
const allowUnused =
  process.argv.includes('--allow-unused') || process.env.REACHABILITY_ALLOW_UNUSED === '1';
const queue = [];
seeds.forEach((seed) => {
  enqueue(seed.file, seed.reason, 'manifest');
  queue.push(seed.file);
});

const visited = new Set();
while (queue.length) {
  const current = queue.shift();
  if (visited.has(current)) continue;
  visited.add(current);
  const references = processFile(current);
  references.forEach((ref) => {
    if (!ref.resolved) return;
    if (!fileExists(ref.resolved)) {
      missingFiles.add(ref.resolved);
      addEdge(current, ref.resolved, `${ref.reason} (missing)`);
      return;
    }
    enqueue(ref.resolved, ref.reason, current);
    if (!visited.has(ref.resolved)) {
      queue.push(ref.resolved);
    }
  });
}

const reachableFiles = Array.from(reachable).sort();
const missing = Array.from(missingFiles).sort();
const unusedCandidates = allFiles.filter((file) => !reachable.has(file));

const edgeCounts = edges.reduce((acc, edge) => {
  acc[edge.from] = (acc[edge.from] || 0) + 1;
  return acc;
}, {});
const topReferenced = Object.entries(edgeCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([file, count]) => ({ file, count }));

const jsonReport = {
  reachableFiles,
  edges,
  missingFiles: missing,
  allFiles,
  unusedCandidates
};

fs.writeFileSync(outputJsonPath, JSON.stringify(jsonReport, null, 2));

const seedLines = seeds.map((seed) => `- \`${seed.file}\` (${seed.reason})`);
const missingLines = missing.length ? missing.map((file) => `- \`${file}\``) : ['- (none)'];
const unusedLines = unusedCandidates.length ? unusedCandidates.map((file) => `- \`${file}\``) : ['- (none)'];
const topLines = topReferenced.length
  ? topReferenced.map((entry) => `- \`${entry.file}\` (${entry.count})`)
  : ['- (none)'];

const mdReport = `# Reachability report (extension/)\n\n` +
  `## Summary\n` +
  `- Total files: ${allFiles.length}\n` +
  `- Reachable: ${reachableFiles.length}\n` +
  `- Missing references: ${missing.length}\n` +
  `- Unused candidates: ${unusedCandidates.length}\n\n` +
  `## Seeds (from manifest)\n` +
  `${seedLines.join('\n')}\n\n` +
  `## Missing references\n` +
  `${missingLines.join('\n')}\n\n` +
  `## Unused candidates\n` +
  `${unusedLines.join('\n')}\n\n` +
  `## Top referenced files (out-degree)\n` +
  `${topLines.join('\n')}\n`;

fs.writeFileSync(outputMdPath, mdReport);

if (missing.length > 0) {
  process.exit(2);
}
if (!allowUnused && unusedCandidates.length > 0) {
  process.exit(3);
}
