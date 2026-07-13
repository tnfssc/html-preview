import fs from 'node:fs/promises';

const [tag, manifestPath = '.output/chrome-mv3/manifest.json'] = process.argv.slice(2);
if (!tag) throw new Error('Usage: verify-release-version.mjs <tag> [manifest]');

const match = /^v(\d+\.\d+\.\d+)(?:-debug\.(\d+))?$/.exec(tag);
if (!match) {
  throw new Error(`Unsupported release tag ${tag}. Use vX.Y.Z or vX.Y.Z-debug.N.`);
}

const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const expected = match[1];
for (const [source, actual] of [
  ['package.json', packageJson.version],
  [manifestPath, manifest.version],
]) {
  if (actual !== expected) {
    throw new Error(`${source} version ${actual} does not match tag base ${expected}.`);
  }
}

console.log(`Verified ${tag}: package and manifest version ${expected}`);
