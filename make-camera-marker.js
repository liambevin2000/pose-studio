// Writes the little camera that shows a Blockbench camera in the world (pose:camera):
//   packs/PoseStudio_RP/models/entity/camera.geo.json
//   packs/PoseStudio_RP/textures/entity/pose_studio/camera.png
//
// The model looks north (-Z), like every Minecraft model, with the entity where the camera's eye
// is. Two bones, one in the other: "yaw" turns it round, "pitch" tips it up and down (see
// animations/camera.animation.json). A thin line runs out of the lens the way it looks.
// Every face is one flat colour: a pixel of the texture. The texture's alpha is 0, which the
// entity_emissive material shows at full brightness, so the camera can be seen in the dark.
//
// Run with: node make-camera-marker.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 8; // the texture, pixels each way
const COLOURS = { body: '#2b2b33', lens: '#8e8e96', glass: '#7fd6ff', line: '#ffd83d', reel: '#4a4a55', light: '#e0362c' };
const names = Object.keys(COLOURS);
const swatch = (name) => {
  const i = names.indexOf(name);
  const uv = { uv: [i + 0.25, 0.25], uv_size: [0.5, 0.5] };
  return { north: uv, east: uv, south: uv, west: uv, up: uv, down: uv };
};
const cube = (colour, origin, size) => ({ origin, size, uv: swatch(colour) });

const geometry = {
  format_version: '1.12.0',
  'minecraft:geometry': [
    {
      description: { identifier: 'geometry.pose_studio.camera', texture_width: SIZE, texture_height: SIZE, visible_bounds_width: 5, visible_bounds_height: 5, visible_bounds_offset: [0, 0, 0] },
      bones: [
        { name: 'yaw', pivot: [0, 0, 0] },
        {
          name: 'pitch', parent: 'yaw', pivot: [0, 0, 0],
          cubes: [
            cube('body', [-3, -3, -4], [6, 6, 8]),
            cube('lens', [-2, -2, -7], [4, 4, 3]),
            cube('glass', [-1.5, -1.5, -7.2], [3, 3, 0.2]),
            cube('reel', [-1, 3, -3.5], [2, 4, 4]),
            cube('reel', [-1, 3, 0.5], [2, 3, 3]),
            cube('light', [1.5, 3, 2.5], [1, 1, 1]),
            // the way it looks: a line 20 pixels (a block and a quarter) out of the lens
            cube('line', [-0.3, -0.3, -27.2], [0.6, 0.6, 20]),
          ],
        },
      ],
    },
  ],
};

function png(pixels) {
  const crcTable = Array.from({ length: 256 }, (unused, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = ~0;
    for (const byte of buf) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bits a channel
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = pixels(x, y);
      raw.set([r, g, b, 0], y * (SIZE * 4 + 1) + 1 + x * 4); // (alpha 0: full brightness)
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function write() {
  const rp = path.join(__dirname, 'packs', 'PoseStudio_RP');
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  fs.writeFileSync(path.join(rp, 'models', 'entity', 'camera.geo.json'), JSON.stringify(geometry, null, 2) + '\n');
  // one colour a column, all the way down
  fs.writeFileSync(path.join(rp, 'textures', 'entity', 'pose_studio', 'camera.png'), png((x) => rgb(COLOURS[names[Math.min(x, names.length - 1)]])));
  console.log(`camera marker written (${geometry['minecraft:geometry'][0].bones[1].cubes.length} cubes, ${names.length} colours)`);
}

module.exports = { geometry, COLOURS };
if (require.main === module) write();
