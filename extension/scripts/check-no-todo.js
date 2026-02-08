const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..', 'core');
const pattern = /(TODO:|FIXME:)/;
const matches = [];

function scanDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath);
      return;
    }
    if (!entry.isFile()) return;
    const content = fs.readFileSync(fullPath, 'utf8');
    content.split('\n').forEach((line, index) => {
      if (pattern.test(line)) {
        matches.push(`${fullPath}:${index + 1} ${line.trim()}`);
      }
    });
  });
}

scanDir(rootDir);

if (matches.length) {
  console.error('Found TODO/FIXME in extension/core:');
  matches.forEach((entry) => console.error(entry));
  process.exit(1);
}
