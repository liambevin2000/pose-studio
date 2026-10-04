// The Stream Deck keys' pixel art: 10×10 sprites on a 12×12 Minecraft-style button (a bevel, a
// little texture). This writes
//   - images/*.svg, the pictures Stream Deck shows before the plugin has set its own, and the
//     action-list icons, and images/plugin.png
//   - art.js, the same sprites and the code that draws them, for the plugin: it picks each key's
//     picture from what the key is set to (a moon for night, bars for the Minecraft link…)
// Run: node make_icons.cjs            (add --preview sheet.png to see every sprite)
const fs = require('fs');
const zlib = require('zlib');
const dir = __dirname + '/com.posestudio.deck.sdPlugin/';

const K = '#26262b'; // outlines
const W = '#ffffff';
const mirror = (rows) => rows.map((r) => r.split('').reverse().join(''));
const sun = (y, w) => ({ y, w });

const arrow = ['..........', '.....k....', '.....kk...', '.kkkkkwk..', '.kwwwwwwk.', '.kwwwwwwk.', '.kkkkkwk..', '.....kk...', '.....k....', '..........'];
const horizon = ['..........', '..........', '....yy....', '..y.yy.y..', '...yyyy...', '..yywwyy..', '.yywwwwyy.', 'oooooooooo', 'bbbbbbbbbb', '..........'];
const cloud = ['..........', '...cccc...', '.cccccccc.', 'cccccccccc', 'ssssssssss'];

const sprites = {
  capture: { colours: { k: K, g: '#8e8e96', h: '#b9b9c2', l: '#7fd6ff', b: '#1f5f8a', r: '#e0362c' }, rows: ['..........', '...kkk....', '.kkkkkkkk.', '.khhhhhrk.', '.kggkkggk.', '.kgkllkgk.', '.kgklbkgk.', '.kggkkggk.', '.kkkkkkkk.', '..........'] },
  face: { colours: { H: '#2f1f0f', S: '#b88a6a', W, B: '#4a3fb5', N: '#8a5a44', M: '#5a3a22' }, rows: ['..........', '.HHHHHHHH.', '.HHHHHHHH.', '.HSSSSSSH.', '.SSSSSSSS.', '.SWBSSBWS.', '.SSSNNSSS.', '.SSMMMMSS.', '.SSMSSMSS.', '..........'] },
  camera: { colours: { k: K, g: '#8e8e96', h: '#b9b9c2', l: '#7fd6ff' }, rows: ['..........', '..kk..kk..', '.khhkkhhk.', '..kk..kk..', '.kkkkkkk..', '.kgggggk.k', '.kglllgkkk', '.kglllgkkk', '.kgggggk.k', '.kkkkkkk..'] },
  next: { colours: { k: K, w: W }, rows: arrow },
  prev: { colours: { k: K, w: W }, rows: mirror(arrow) },
  // toggles
  sync: { colours: { g: '#8fe0ff', w: W }, rows: ['......g...', '.......g..', '.gggggggg.', '.......g..', '......g...', '...w......', '..w.......', '.wwwwwwww.', '..w.......', '...w......'] },
  eye: { colours: { k: K, w: W, g: '#3fae5a' }, rows: ['..........', '..........', '..kkkkkk..', '.kwwggwwk.', 'kwwgkkgwwk', 'kwwgkkgwwk', '.kwwggwwk.', '..kkkkkk..', '..........', '..........'] },
  bars: { colours: { g: '#f4fff0' }, rows: ['..........', '........g.', '........g.', '......g.g.', '......g.g.', '....g.g.g.', '....g.g.g.', '..g.g.g.g.', '..g.g.g.g.', 'g.g.g.g.g.'] },
  bars_off: { colours: { g: '#5a5a5a' }, rows: ['..........', '........g.', '........g.', '......g.g.', '......g.g.', '....g.g.g.', '....g.g.g.', '..g.g.g.g.', '..g.g.g.g.', 'g.g.g.g.g.'] },
  lamp_off: { colours: { D: '#2e1a0f', d: '#4a2c18', c: '#5e3b22' }, rows: ['..........', '.DDDDDDDD.', '.DddDDddD.', '.DdccccdD.', '.DDccccDD.', '.DDccccDD.', '.DdccccdD.', '.DddDDddD.', '.DDDDDDDD.', '..........'] },
  lamp_on: { colours: { D: '#7a4a12', d: '#e0a83a', c: '#fff2a8' }, rows: ['..........', '.DDDDDDDD.', '.DddDDddD.', '.DdccccdD.', '.DDccccDD.', '.DDccccDD.', '.DdccccdD.', '.DddDDddD.', '.DDDDDDDD.', '..........'] },
  // time and weather
  sunrise: { colours: Object.assign(sun('#f5c518', '#fff3a0'), { o: '#f08a2a', b: '#3d6fa8' }), rows: horizon },
  sunset: { colours: Object.assign(sun('#f0742a', '#ffc070'), { o: '#b8392b', b: '#3a3f7a' }), rows: horizon },
  day: { colours: sun('#f5c518', '#fff3a0'), rows: ['..........', '..........', '..yyyyyy..', '..ywwwwy..', '..ywwwwy..', '..ywwwwy..', '..ywwwwy..', '..yyyyyy..', '..........', '..........'] },
  noon: { colours: sun('#f5c518', '#fff3a0'), rows: ['..........', '.yyyyyyyy.', '.ywwwwwwy.', '.ywwwwwwy.', '.ywwwwwwy.', '.ywwwwwwy.', '.ywwwwwwy.', '.ywwwwwwy.', '.yyyyyyyy.', '..........'] },
  night: { colours: { m: '#dfe6ee', c: '#aeb8c4', s: W }, rows: ['.s........', '......s...', '..mmmmm...', '..mcmmm..s', '..mmmmm...', '..mmmcm...', '..mmmmm...', '..........', '.s.....s..', '..........'] },
  rain: { colours: { c: W, s: '#c9d9e6', d: '#4aa3ff' }, rows: cloud.concat(['..........', '.d..d..d..', '..d..d..d.', '.d..d..d..', '..........']) },
  thunder: { colours: { c: '#9aa3ad', s: '#6f7882', y: '#ffd83d' }, rows: cloud.concat(['....yy....', '...yy.....', '..yyyy....', '....yy....', '...y......']) },
  sun_cloud: { colours: { y: '#f5c518', w: '#fff3a0', c: W, s: '#c9d9e6' }, rows: ['..........', '.yyyyy....', '.ywwwy....', '.ywwwy....', '.ywwwy.cc.', '.yyyyycccc', '...ccccccc', '..cccccccc', '..ssssssss', '..........'] },
  // a crafting table (Blockbench: the bench)
  bench: { colours: { k: '#3f2710', l: '#c8964a', m: '#a8763a', b: '#8a5a2a', s: '#d8d8d8', d: '#5a3a1a' }, rows: ['..........', '.kkkkkkkk.', '.klmllmlk.', '.kmllmllk.', '.kkkkkkkk.', '.kbsbbdbk.', '.kbsbbdbk.', '.kbbbbbbk.', '.kkkkkkkk.', '..........'] },
  // the menu's actions
  command: { colours: { k: '#4a2f1f', o: '#d98a4b', l: '#f3c692', y: '#b86a2e', e: '#1d1410' }, rows: ['..........', '.kkkkkkkk.', '.kolooook.', '.koeeeeyk.', '.koelleyk.', '.koelleyk.', '.koeeeeyk.', '.kyyyyyyk.', '.kkkkkkkk.', '..........'] },
  drop: { colours: { w: W, g: '#5d9b3a', d: '#7a5230' }, rows: ['....ww....', '....ww....', '....ww....', '..wwwwww..', '...wwww...', '....ww....', '..........', 'gggggggggg', 'dddddddddd', 'dddddddddd'] },
  compare: { colours: { r: '#ff4a4a', g: '#5be04a' }, rows: ['..........', '.rrrrrr...', '.r....r...', '.r.gggggg.', '.r.g..r.g.', '.r.g..r.g.', '.rrrrrr.g.', '...g....g.', '...gggggg.', '..........'] },
  creeper: { colours: { G: '#5fae4a', g: '#4a9038', k: '#1a1a1a' }, rows: ['..........', '.GgGGgGGg.', '.GGGGGGGG.', '.GkkGGkkG.', '.GkkGGkkG.', '.GGGkkGGG.', '.GGkkkkGG.', '.GGkkkkGG.', '.GGkGGkGG.', '..........'] },
  plus: { colours: { g: '#7be04f' }, rows: ['..........', '....gg....', '....gg....', '....gg....', '.gggggggg.', '.gggggggg.', '....gg....', '....gg....', '....gg....', '..........'] },
  armour: { colours: { i: '#d5dce3', d: '#8a949e' }, rows: ['..........', '.ii....ii.', '.iii..iii.', '.iiiiiiii.', '.diiiiiid.', '..iiiiii..', '..iiiiii..', '..diiiid..', '..dddddd..', '..........'] },
  film: { colours: { k: K, w: W, g: '#8e8e96' }, rows: ['..........', '.kwkwkwkw.', '.wkwkwkwk.', '.kkkkkkkk.', '.kggggggk.', '.kggggggk.', '.kggggggk.', '.kggggggk.', '.kkkkkkkk.', '..........'] },
  saddle: { colours: { b: '#7a3f1c', l: '#b56a3a', y: '#d8d8d8' }, rows: ['..........', '..........', '..bbbbbb..', '.bllllllb.', '.bllllllb.', '.bbbbbbbb.', '.b......b.', '.y......y.', '.yy....yy.', '..........'] },
  grass: { colours: { g: '#5d9b3a', G: '#72b84c', d: '#7a5230', D: '#62401f' }, rows: ['..........', '.gggggggg.', '.gGgggGgg.', '.gdgdggdg.', '.dddddddd.', '.dDdddDdd.', '.dddDdddd.', '.dDddddDd.', '.dddddddd.', '..........'] },
  clock: { colours: { y: '#e0b030', w: '#f4f4f4', k: K }, rows: ['..........', '...yyyy...', '..ywwwwy..', '.ywwkwwwy.', '.ywwkwwwy.', '.ywwkkkwy.', '.ywwwwwwy.', '..ywwwwy..', '...yyyy...', '..........'] },
  barrier: { colours: { r: '#e0362c' }, rows: ['..........', '..rrrrrr..', '.rr....rr.', '.rrr....r.', '.r.rr...r.', '.r..rr..r.', '.r...rr.r.', '.rr...rrr.', '..rrrrrr..', '..........'] },
  target: { colours: { w: W, r: '#e0362c' }, rows: ['....ww....', '....ww....', '..rrrrrr..', '..r....r..', 'www.rr.www', 'www.rr.www', '..r....r..', '..rrrrrr..', '....ww....', '....ww....'] },
  chest: { colours: { k: '#3f2710', b: '#a8712a', y: '#d8d8d8' }, rows: ['..........', '.kkkkkkkk.', '.kbbbbbbk.', '.kbbbbbbk.', '.kkkyykkk.', '.kbbyybbk.', '.kbbbbbbk.', '.kbbbbbbk.', '.kkkkkkkk.', '..........'] },
  lever: { colours: { b: '#a8712a', s: '#4a4a4a' }, rows: ['..........', '.......b..', '......bb..', '.....bb...', '....bb....', '...bb.....', '..ssssss..', '.ssssssss.', '.ssssssss.', '..........'] },
  grid: { colours: { w: W }, rows: ['...w..w...', '...w..w...', '...w..w...', 'wwwwwwwwww', '...w..w...', '...w..w...', 'wwwwwwwwww', '...w..w...', '...w..w...', '...w..w...'] },
};

// the button under the sprite
const buttons = {
  stone: { fill: ['#8b8b8b', '#7f7f7f', '#969696'], light: '#d0d0d0', dark: '#3c3c3c' },
  grass: { fill: ['#5d9b3a', '#528c33', '#69aa42'], light: '#9be060', dark: '#2c5519' },
  sky: { fill: ['#6fb1e8', '#63a6de', '#7bbcf0'], light: '#b5dcff', dark: '#2f6aa0' },
  dusk: { fill: ['#b5653a', '#a85b33', '#c27042'], light: '#f0a070', dark: '#5a2e18' },
  night: { fill: ['#232a4a', '#1e2542', '#2a3256'], light: '#4a5690', dark: '#0e1226' },
  storm: { fill: ['#5a6470', '#525b66', '#636e7a'], light: '#8a96a4', dark: '#2a3038' },
};

// 12×12 colours ('' = see-through) of a key (button + sprite) or of a sprite alone
function pixels(spriteName, buttonName) {
  const sprite = sprites[spriteName] || sprites.command;
  const button = buttonName && buttons[buttonName];
  const grid = [];
  for (let y = 0; y < 12; y++) {
    const row = [];
    for (let x = 0; x < 12; x++) {
      let colour = '';
      if (button) {
        if (y === 0 || x === 0) colour = button.light;
        else if (y === 11 || x === 11) colour = button.dark;
        else colour = button.fill[(x * 7 + y * 13 + ((x * y) % 3)) % 3]; // a little texture
        if ((x === 0 && y === 11) || (x === 11 && y === 0)) colour = button.fill[0];
      }
      const c = x >= 1 && x <= 10 && y >= 1 && y <= 10 ? sprite.rows[y - 1][x - 1] : '.';
      if (c !== '.') colour = sprite.colours[c];
      row.push(colour);
    }
    grid.push(row);
  }
  return grid;
}

function svg(grid) {
  let body = '';
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 12; x++) {
      if (!grid[y][x]) continue;
      // runs of one colour become one rectangle
      let w = 1;
      while (x + w < 12 && grid[y][x + w] === grid[y][x]) w++;
      body += `<rect x="${x * 12}" y="${y * 12}" width="${w * 12}" height="12" fill="${grid[y][x]}"/>`;
      x += w - 1;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144" shape-rendering="crispEdges">${body}</svg>`;
}

function png(grid, width, height) {
  const cells = grid[0].length;
  const scale = width / cells;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const colour = grid[Math.floor(y / scale)][Math.floor(x / scale)];
      if (!colour) continue;
      const o = y * (width * 4 + 1) + 1 + x * 4;
      raw[o] = parseInt(colour.slice(1, 3), 16); raw[o + 1] = parseInt(colour.slice(3, 5), 16); raw[o + 2] = parseInt(colour.slice(5, 7), 16); raw[o + 3] = 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const [name, sprite] of Object.entries(sprites)) {
  if (sprite.rows.length !== 10 || sprite.rows.some((r) => r.length !== 10)) throw new Error(`${name} isn't 10×10`);
  for (const row of sprite.rows) for (const c of row) if (c !== '.' && !sprite.colours[c]) throw new Error(`${name}: no colour for "${c}"`);
}

// the pictures in the manifest (what a key shows before the plugin has set its own)
const fixed = {
  capture: ['capture', 'stone'], entities: ['face', 'stone'],
  camera: ['camera', 'stone'], camera_on: ['camera', 'grass'],
  toggle: ['lamp_off', 'stone'], toggle_on: ['lamp_on', 'grass'],
  env: ['sun_cloud', 'sky'], run: ['command', 'stone'], focus: ['bench', 'stone'],
};
for (const [name, [sprite, button]] of Object.entries(fixed)) {
  fs.writeFileSync(dir + 'images/' + name + '.svg', svg(pixels(sprite, button)) + '\n');
  if (!/_on$/.test(name)) fs.writeFileSync(dir + 'images/' + name + '_icon.svg', svg(pixels(sprite, null)) + '\n'); // the action list
}
fs.writeFileSync(dir + 'images/category.svg', svg(pixels('face', null)) + '\n');
fs.writeFileSync(dir + 'images/plugin.png', png(pixels('face', 'grass'), 252, 252));
fs.writeFileSync(dir + 'images/plugin@2x.png', png(pixels('face', 'grass'), 504, 504));

// the plugin's copy: the sprites, the buttons and the drawing code
fs.writeFileSync(
  dir + 'art.js',
  '// Written by streamdeck/make_icons.cjs: the keys\' pixel art (edit the sprites there).\n' +
    `const sprites = ${JSON.stringify(sprites)};\n` +
    `const buttons = ${JSON.stringify(buttons)};\n` +
    `${pixels.toString()}\n${svg.toString()}\n` +
    '// A key picture, as Stream Deck takes it.\n' +
    "function keyImage(sprite, button) {\n  return 'data:image/svg+xml;base64,' + btoa(svg(pixels(sprite, button)));\n}\n"
);
console.log(`icons written (${Object.keys(sprites).length} sprites)`);

// node make_icons.cjs --preview sheet.png : every sprite, to look at
const previewAt = process.argv.indexOf('--preview');
if (previewAt > 0) {
  const shown = [
    ['capture', 'stone'], ['face', 'stone'], ['camera', 'stone'], ['camera', 'grass'], ['next', 'stone'], ['prev', 'stone'],
    ['sync', 'stone'], ['sync', 'grass'], ['eye', 'stone'], ['eye', 'grass'], ['bars_off', 'stone'], ['bars', 'grass'],
    ['sunrise', 'dusk'], ['day', 'sky'], ['noon', 'sky'], ['sunset', 'dusk'], ['night', 'night'], ['rain', 'storm'],
    ['thunder', 'storm'], ['rain', 'night'], ['sun_cloud', 'sky'], ['command', 'stone'], ['drop', 'stone'], ['compare', 'stone'],
    ['creeper', 'stone'], ['plus', 'stone'], ['armour', 'stone'], ['film', 'stone'], ['saddle', 'stone'], ['grass', 'stone'],
    ['bench', 'stone'], ['grass', 'grass'], ['clock', 'stone'], ['barrier', 'stone'], ['target', 'stone'], ['chest', 'stone'], ['lever', 'stone'], ['grid', 'stone'],
  ];
  const perRow = 6;
  const sheet = [];
  for (let r = 0; r < Math.ceil(shown.length / perRow); r++) {
    for (let y = 0; y < 12; y++) {
      const row = [];
      for (const [sprite, button] of shown.slice(r * perRow, (r + 1) * perRow)) row.push(...pixels(sprite, button)[y], '#111111');
      sheet.push(row);
    }
    sheet.push(new Array(sheet[0].length).fill('#111111'));
  }
  const scale = 8;
  fs.writeFileSync(process.argv[previewAt + 1], png(sheet, sheet[0].length * scale, sheet.length * scale));
  console.log('preview written');
}
