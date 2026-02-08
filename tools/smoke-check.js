#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const repoRoot = process.cwd();
const extensionRoot = path.join(repoRoot, 'extension');
const manifestPath = path.join(extensionRoot, 'manifest.json');
const quarantineRoot = path.join(extensionRoot, '_quarantine');

const checkedEntrypoints = [];
const errors = [];

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

const fileExists = (relativePath) => fs.existsSync(path.join(extensionRoot, relativePath));

const addError = (message) => {
  errors.push(message);
};

const assertExists = (relativePath, reason) => {
  if (!relativePath) return;
  if (relativePath.startsWith('_quarantine/')) {
    addError(`Quarantine reference found (${reason}): ${relativePath}`);
    return;
  }
  if (!fileExists(relativePath)) {
    addError(`Missing file (${reason}): ${relativePath}`);
  }
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
  references.forEach((entry) => {
    const resolved = resolveRelative(filePath, entry.target);
    if (resolved) {
      assertExists(resolved, `${entry.reason} from ${filePath}`);
    }
  });
};

const parseImportScripts = (filePath, content) => {
  const importScriptsRegex = /importScripts\(([^)]+)\)/g;
  const stringLiteralRegex = /['"]([^'"]+)['"]/g;
  let match;
  while ((match = importScriptsRegex.exec(content))) {
    const rawArgs = match[1];
    let innerMatch;
    while ((innerMatch = stringLiteralRegex.exec(rawArgs))) {
      const resolved = resolveRelative(filePath, innerMatch[1]);
      if (resolved) {
        assertExists(resolved, `importScripts from ${filePath}`);
      }
    }
  }
};

const ensureNoQuarantineInManifest = (manifest) => {
  const manifestText = JSON.stringify(manifest);
  if (manifestText.includes('_quarantine/')) {
    addError('Quarantine path referenced in manifest.json');
  }
};

const getManifestSeeds = (manifest) => {
  const seeds = [];
  const addSeed = (value, reason) => {
    const normalized = normalizeExtensionPath(value);
    if (normalized) {
      seeds.push({ file: normalized, reason });
    }
  };
  addSeed(manifest.background?.service_worker, 'manifest.background.service_worker');
  (manifest.content_scripts || []).forEach((entry, index) => {
    (entry.js || []).forEach((file) =>
      addSeed(file, `manifest.content_scripts[${index}].js`)
    );
    (entry.css || []).forEach((file) =>
      addSeed(file, `manifest.content_scripts[${index}].css`)
    );
  });
  addSeed(manifest.action?.default_popup, 'manifest.action.default_popup');
  addSeed(manifest.browser_action?.default_popup, 'manifest.browser_action.default_popup');
  addSeed(manifest.options_page, 'manifest.options_page');
  addSeed(manifest.options_ui?.page, 'manifest.options_ui.page');
  (manifest.web_accessible_resources || []).forEach((entry, index) => {
    (entry.resources || []).forEach((file) =>
      addSeed(file, `manifest.web_accessible_resources[${index}]`)
    );
  });
  if (manifest.icons) {
    Object.entries(manifest.icons).forEach(([size, file]) =>
      addSeed(file, `manifest.icons.${size}`)
    );
  }
  return seeds;
};

const run = () => {
  if (!fs.existsSync(manifestPath)) {
    addError('Missing extension/manifest.json');
  }
  const manifest = readJson(manifestPath);
  ensureNoQuarantineInManifest(manifest);
  const seeds = getManifestSeeds(manifest);
  if (!manifest.background?.service_worker) {
    addError('manifest.background.service_worker missing');
  }
  if (!manifest.action?.default_popup && !manifest.browser_action?.default_popup) {
    addError('manifest action/default_popup missing');
  }

  seeds.forEach((seed) => {
    assertExists(seed.file, seed.reason);
    checkedEntrypoints.push(`${seed.file} (${seed.reason})`);
  });

  if (manifest.action?.default_popup) {
    const popupPath = normalizeExtensionPath(manifest.action.default_popup);
    if (popupPath && fileExists(popupPath)) {
      parseHtmlReferences(popupPath, readText(path.join(extensionRoot, popupPath)));
    }
  }
  if (manifest.browser_action?.default_popup) {
    const popupPath = normalizeExtensionPath(manifest.browser_action.default_popup);
    if (popupPath && fileExists(popupPath)) {
      parseHtmlReferences(popupPath, readText(path.join(extensionRoot, popupPath)));
    }
  }
  const debugHtmlPath = 'debug.html';
  if (fileExists(debugHtmlPath)) {
    parseHtmlReferences(debugHtmlPath, readText(path.join(extensionRoot, debugHtmlPath)));
  }

  seeds
    .filter((seed) => seed.file.endsWith('.js'))
    .forEach((seed) => {
      const absPath = path.join(extensionRoot, seed.file);
      parseImportScripts(seed.file, readText(absPath));
    });

  if (fs.existsSync(quarantineRoot)) {
    const quarantineReference = checkedEntrypoints.some((entry) => entry.includes('_quarantine/'));
    if (quarantineReference) {
      addError('Quarantine file referenced by entrypoints.');
    }
  }

  if (errors.length) {
    console.error('Smoke check failed:\n' + errors.map((err) => `- ${err}`).join('\n'));
    process.exit(2);
  }

  console.log('OK');
  console.log('Checked entrypoints:');
  checkedEntrypoints.forEach((entry) => console.log(`- ${entry}`));
};

run();
