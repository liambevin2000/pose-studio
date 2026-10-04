// Prepares a release from changelog.json (newest entry first):
//  - sets the plugin's version and its built-in changelog
//  - writes CHANGELOG.md
//  - writes packs.json (the pack file list the plugin's updater downloads)
//  - rebuilds dist/PoseStudio.mcaddon
// Then commit and push; everyone gets the update the next time Blockbench starts.
// Usage: node release.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = __dirname;
const pluginFile = path.join(root, 'blockbench', 'pose_studio.js');
const changelog = JSON.parse(fs.readFileSync(path.join(root, 'changelog.json'), 'utf8'));

// ---- check the changelog
if (!Array.isArray(changelog) || !changelog.length) throw new Error('changelog.json must be a non-empty array, newest first');
const semver = /^\d+\.\d+\.\d+$/;
changelog.forEach((e, i) => {
  if (!semver.test(e.version || '')) throw new Error(`changelog.json entry ${i}: version "${e.version}" should look like 1.2.3`);
  if (!Array.isArray(e.changes) || !e.changes.length) throw new Error(`changelog.json ${e.version}: add at least one line to "changes"`);
});
const newer = (a, b) => {
  const [pa, pb] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
};
for (let i = 1; i < changelog.length; i++) {
  if (!newer(changelog[i - 1].version, changelog[i].version)) throw new Error(`changelog.json: ${changelog[i - 1].version} should be newer than the entry below it (${changelog[i].version})`);
}
const version = changelog[0].version;

// ---- plugin: version and built-in changelog
let plugin = fs.readFileSync(pluginFile, 'utf8');
const replaceOnce = (pattern, value, what) => {
  if (!pattern.test(plugin)) throw new Error(`Couldn't find ${what} in pose_studio.js`);
  plugin = plugin.replace(pattern, () => value);
};
replaceOnce(/const PLUGIN_VERSION = '[^']*';/, `const PLUGIN_VERSION = '${version}';`, 'PLUGIN_VERSION');
const embedded = JSON.stringify(changelog, null, 2).split('\n').map((line, i) => (i ? '  ' + line : line)).join('\n');
replaceOnce(/\/\/ <changelog>\n[\s\S]*?\n  \/\/ <\/changelog>/, `// <changelog>\n  const CHANGELOG = ${embedded};\n  // </changelog>`, 'the <changelog> markers');
fs.writeFileSync(pluginFile, plugin);

// ---- CHANGELOG.md
const md = ['# Changelog', ''];
for (const e of changelog) {
  md.push(`## ${e.version}${e.date ? ` (${e.date})` : ''}`, '');
  for (const c of e.changes) md.push(`- ${c}`);
  md.push('');
}
fs.writeFileSync(path.join(root, 'CHANGELOG.md'), md.join('\n'));

// ---- packs.json
const packsDir = path.join(root, 'packs');
const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(packsDir);
const all = crypto.createHash('sha1');
const list = files.map((p) => {
  const rel = path.relative(packsDir, p).split(path.sep).join('/');
  const data = fs.readFileSync(p);
  const sha1 = crypto.createHash('sha1').update(data).digest('hex');
  all.update(rel + ':' + sha1 + '\n');
  return { path: rel, size: data.length, sha1 };
});
const revision = all.digest('hex').slice(0, 12);
fs.writeFileSync(path.join(root, 'packs.json'), JSON.stringify({ version, revision, files: list }, null, 2) + '\n');

// ---- .mcaddon
execFileSync(process.execPath, [path.join(root, 'build-mcaddon.js')], { stdio: 'inherit' });

// ---- the Stream Deck plugin
execFileSync(process.execPath, [path.join(root, 'build-streamdeck.js')], { stdio: 'inherit' });

console.log(`Release ${version} ready (packs revision ${revision}, ${list.length} files). Commit and push to publish it.`);
