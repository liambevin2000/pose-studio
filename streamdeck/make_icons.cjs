// Writes the plugin's key images and action-list icons (SVG). Run: node make_icons.cjs
const fs = require('fs');
const out = __dirname + '/com.posestudio.deck.sdPlugin/images/';
const W = 'fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"';
const glyphs = {
  capture: `<path ${W} d="M30 52h20l8-12h28l8 12h20v54H30z"/><circle ${W} cx="72" cy="78" r="17"/>`,
  entities: `<circle ${W} cx="72" cy="46" r="17"/><path ${W} d="M38 112V94c0-12 10-20 22-20h24c12 0 22 8 22 20v18"/>`,
  camera: `<rect ${W} x="24" y="48" width="64" height="48" rx="8"/><path ${W} d="M88 64l30-16v48L88 80z"/>`,
  toggle: `<rect ${W} x="26" y="50" width="92" height="44" rx="22"/><circle fill="#fff" cx="50" cy="72" r="12"/>`,
  toggle_on: `<rect ${W} x="26" y="50" width="92" height="44" rx="22"/><circle fill="#fff" cx="94" cy="72" r="12"/>`,
  env: `<circle ${W} cx="60" cy="60" r="16"/><path ${W} d="M60 26v8M60 86v8M26 60h8M34 34l6 6M86 34l-6 6M34 86l6-6"/><path ${W} d="M70 112h36a14 14 0 0 0 0-28 20 20 0 0 0-38 4 12 12 0 0 0 2 24z"/>`,
  run: `<path ${W} d="M52 40l52 32-52 32z"/>`,
};
const keys = {
  capture: ['#2563eb', 'capture'], entities: ['#0d9488', 'entities'],
  camera: ['#3f4652', 'camera'], camera_on: ['#ea580c', 'camera'],
  toggle: ['#3f4652', 'toggle'], toggle_on: ['#16a34a', 'toggle_on'],
  env: ['#b7791f', 'env'], run: ['#7c3aed', 'run'],
};
const svg = (body, bg) => `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">${bg ? `<rect width="144" height="144" fill="${bg}"/>` : ''}${body}</svg>\n`;
for (const [name, [bg, glyph]] of Object.entries(keys)) fs.writeFileSync(out + name + '.svg', svg(glyphs[glyph], bg));
// the category icon in the actions list: the capture glyph, no background
fs.writeFileSync(out + 'category.svg', svg(glyphs.entities, ''));
console.log('icons written');
