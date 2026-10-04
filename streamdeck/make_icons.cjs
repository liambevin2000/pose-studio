// Writes the plugin's key images and action-list icons: pixel art on a 12×12 grid, Minecraft style
// (a stone button with a light/dark bevel, a 10×10 sprite on it). Run: node make_icons.cjs
const fs = require('fs');
const zlib = require('zlib');
const out = __dirname + '/com.posestudio.deck.sdPlugin/images/';

// 10×10 sprites: one character per pixel, '.' shows the button through
const sprites = {
  capture: {
    colours: { k: '#26262b', g: '#8e8e96', h: '#b9b9c2', l: '#7fd6ff', b: '#1f5f8a', r: '#e0362c' },
    rows: [
      '..........',
      '...kkk....',
      '.kkkkkkkk.',
      '.khhhhhrk.',
      '.kggkkggk.',
      '.kgkllkgk.',
      '.kgklbkgk.',
      '.kggkkggk.',
      '.kkkkkkkk.',
      '..........',
    ],
  },
  entities: {
    // the classic face
    colours: { H: '#2f1f0f', S: '#b88a6a', W: '#ffffff', B: '#4a3fb5', N: '#8a5a44', M: '#5a3a22' },
    rows: [
      '..........',
      '.HHHHHHHH.',
      '.HHHHHHHH.',
      '.HSSSSSSH.',
      '.SSSSSSSS.',
      '.SWBSSBWS.',
      '.SSSNNSSS.',
      '.SSMMMMSS.',
      '.SSMSSMSS.',
      '..........',
    ],
  },
  camera: {
    colours: { k: '#26262b', g: '#8e8e96', h: '#b9b9c2', l: '#7fd6ff' },
    rows: [
      '..........',
      '..kk..kk..',
      '.khhkkhhk.',
      '..kk..kk..',
      '.kkkkkkk..',
      '.kgggggk.k',
      '.kglllgkkk',
      '.kglllgkkk',
      '.kgggggk.k',
      '.kkkkkkk..',
    ],
  },
  lamp_off: {
    // a redstone lamp, unlit
    colours: { D: '#2e1a0f', d: '#4a2c18', c: '#5e3b22' },
    rows: [
      '..........',
      '.DDDDDDDD.',
      '.DddDDddD.',
      '.DdccccdD.',
      '.DDccccDD.',
      '.DDccccDD.',
      '.DdccccdD.',
      '.DddDDddD.',
      '.DDDDDDDD.',
      '..........',
    ],
  },
  lamp_on: {
    colours: { D: '#7a4a12', d: '#e0a83a', c: '#fff2a8' },
    rows: [
      '..........',
      '.DDDDDDDD.',
      '.DddDDddD.',
      '.DdccccdD.',
      '.DDccccDD.',
      '.DDccccDD.',
      '.DdccccdD.',
      '.DddDDddD.',
      '.DDDDDDDD.',
      '..........',
    ],
  },
  env: {
    // the square sun, and a cloud
    colours: { y: '#f5c518', w: '#fff3a0', c: '#ffffff', s: '#c9d9e6' },
    rows: [
      '..........',
      '.yyyyy....',
      '.ywwwy....',
      '.ywwwy....',
      '.ywwwy.cc.',
      '.yyyyycccc',
      '...ccccccc',
      '..cccccccc',
      '..ssssssss',
      '..........',
    ],
  },
  run: {
    // a command block
    colours: { k: '#4a2f1f', o: '#d98a4b', l: '#f3c692', y: '#b86a2e', e: '#1d1410' },
    rows: [
      '..........',
      '.kkkkkkkk.',
      '.kolooook.',
      '.koeeeeyk.',
      '.koelleyk.',
      '.koelleyk.',
      '.koeeeeyk.',
      '.kyyyyyyk.',
      '.kkkkkkkk.',
      '..........',
    ],
  },
};

// the button under the sprite: stone (off / plain) or grass (on)
const buttons = {
  stone: { fill: ['#8b8b8b', '#7f7f7f', '#969696'], light: '#d0d0d0', dark: '#3c3c3c' },
  grass: { fill: ['#5d9b3a', '#528c33', '#69aa42'], light: '#9be060', dark: '#2c5519' },
};

const keys = {
  capture: ['stone', 'capture'], entities: ['stone', 'entities'],
  camera: ['stone', 'camera'], camera_on: ['grass', 'camera'],
  toggle: ['stone', 'lamp_off'], toggle_on: ['grass', 'lamp_on'],
  env: ['stone', 'env'], run: ['stone', 'run'],
};

// 12×12 colours ('' = see-through) of a key (button + sprite) or of a sprite alone
function pixels(spriteName, buttonName) {
  const sprite = sprites[spriteName];
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144" shape-rendering="crispEdges">${body}</svg>\n`;
}

function png(grid, size) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const at = y * (size * 4 + 1);
    for (let x = 0; x < size; x++) {
      const colour = grid[Math.floor((y * 12) / size)][Math.floor((x * 12) / size)];
      if (!colour) continue;
      const o = at + 1 + x * 4;
      raw[o] = parseInt(colour.slice(1, 3), 16); raw[o + 1] = parseInt(colour.slice(3, 5), 16); raw[o + 2] = parseInt(colour.slice(5, 7), 16); raw[o + 3] = 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const [name, [button, sprite]] of Object.entries(keys)) {
  fs.writeFileSync(out + name + '.svg', svg(pixels(sprite, button)));
  // the icon in Stream Deck's action list: the sprite alone
  if (!/_on$/.test(name)) fs.writeFileSync(out + name + '_icon.svg', svg(pixels(sprite, null)));
}
fs.writeFileSync(out + 'category.svg', svg(pixels('entities', null)));
// the plugin's own icon (PNG): the face on a grass button
fs.writeFileSync(out + 'plugin.png', png(pixels('entities', 'grass'), 256));
fs.writeFileSync(out + 'plugin@2x.png', png(pixels('entities', 'grass'), 512));
console.log('icons written');

// node make_icons.cjs --preview sheet.png : every key side by side, to look at
const previewAt = process.argv.indexOf('--preview');
if (previewAt > 0) {
  const names = Object.keys(keys);
  const sheet = [];
  for (let y = 0; y < 12; y++) {
    const row = [];
    for (const name of names) row.push(...pixels(keys[name][1], keys[name][0])[y], '#111111');
    sheet.push(row);
  }
  // png() draws a 12-wide grid: draw each key into its own square of one wide image by hand
  const scale = 12;
  const width = sheet[0].length * scale;
  const height = 12 * scale;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const colour = sheet[Math.floor(y / scale)][Math.floor(x / scale)];
      const o = y * (width * 4 + 1) + 1 + x * 4;
      raw[o] = parseInt(colour.slice(1, 3), 16); raw[o + 1] = parseInt(colour.slice(3, 5), 16); raw[o + 2] = parseInt(colour.slice(5, 7), 16); raw[o + 3] = 255;
    }
  }
  fs.writeFileSync(process.argv[previewAt + 1], Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  console.log('preview written');
}
