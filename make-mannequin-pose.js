// Writes the Pose Studio player's pose animation and the scripts that feed it:
//   packs/PoseStudio_RP/animations/mannequin.animation.json
//   packs/PoseStudio_RP/entity/mannequin.entity.json (scripts.initialize and scripts.pre_animation)
//
// The pose arrives in the pose:a0..14 (turns) and pose:o0..13 (moves) properties, two 12-bit
// numbers each, at most 20 times a second. Shown as they arrive, limbs would jump 20 times a
// second. So every frame the entity works out where each number is on its way from the value it
// had when the last update came in to the new one, a twentieth of a second later (a straight
// line, the short way round for turns), and the animation shows that. A pose that's only set
// once (posing in Blockbench) is reached a twentieth of a second after it arrives.
//
// Run with: node make-mannequin-pose.js
'use strict';
const fs = require('fs');
const path = require('path');

const ANGLE_BONES = ['pose_root', 'waist', 'body', 'head', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg', 'rightItem', 'leftItem'];
const POS_BONES = ['waist', 'body', 'head', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg', 'rightItem', 'leftItem'];
const TICK = 0.05; // seconds between two updates when an animation plays

// the i-th 12-bit number of a set of properties
const part = (prefix, i) => {
  const prop = `q.property('pose:${prefix}${Math.floor(i / 2)}')`;
  return i % 2 === 0 ? `math.floor(${prop} / 4096)` : `(${prop} - math.floor(${prop} / 4096) * 4096)`;
};
const angle = (i) => `${part('a', i)} * 0.087890625 - 180`;
const offset = (i) => `(${part('o', i)} - 2048) / 64`;

// every number of the pose: { key, target: its Molang, turn: whether it's an angle }
const values = [];
ANGLE_BONES.forEach((bone, b) => [0, 1, 2].forEach((axis) => values.push({ key: `a${b * 3 + axis}`, bone, target: angle(b * 3 + axis), turn: true })));
POS_BONES.forEach((bone, b) => [0, 1, 2].forEach((axis) => values.push({ key: `o${b * 3 + axis}`, bone, target: offset(b * 3 + axis), turn: false })));

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (unused, i) => list.slice(i * size, i * size + size));

// v.t<key>: where it's going, v.l<key>: where it was going last frame, v.f<key>: where it came
// from, v.s<key>: where it is now (what's shown)
const initialize = ['v.pose_t = 1.0; v.pose_ch = 0.0; v.pose_d = 0.0; v.pose_al = 1.0;'].concat(
  chunks(values, 9).map((group) => group.map((v) => `v.t${v.key} = 0.0; v.l${v.key} = 0.0; v.f${v.key} = 0.0; v.s${v.key} = 0.0;`).join(' '))
);
const preAnimation = []
  // where every number is going
  .concat(chunks(values, 6).map((group) => group.map((v) => `v.t${v.key} = ${v.target};`).join(' ')))
  // did an update come in since the last frame?
  .concat(chunks(values, 12).map((group, i) => `v.pose_d = ${i ? 'v.pose_d + ' : ''}${group.map((v) => `math.abs(v.t${v.key} - v.l${v.key})`).join(' + ')};`))
  .concat([
    'v.pose_ch = v.pose_d > 0.0001;',
    // how far along the way to it (0 to 1)
    `v.pose_t = (v.pose_ch ? 0.0 : v.pose_t) + q.delta_time; v.pose_al = math.clamp(v.pose_t * ${(1 / TICK).toFixed(1)}, 0.0, 1.0);`,
  ])
  // from where it is now, towards where it's going
  .concat(chunks(values, 6).map((group) => group.map((v) => `v.f${v.key} = v.pose_ch ? v.s${v.key} : v.f${v.key}; v.l${v.key} = v.t${v.key}; v.s${v.key} = ${v.turn ? 'math.lerprotate' : 'math.lerp'}(v.f${v.key}, v.t${v.key}, v.pose_al);`).join(' ')));

const bones = {};
for (const bone of ANGLE_BONES) {
  const b = ANGLE_BONES.indexOf(bone);
  bones[bone] = { rotation: [0, 1, 2].map((axis) => `v.sa${b * 3 + axis}`) };
  const p = POS_BONES.indexOf(bone);
  if (p >= 0) bones[bone].position = [0, 1, 2].map((axis) => `v.so${p * 3 + axis}`);
}

function write() {
  const rp = path.join(__dirname, 'packs', 'PoseStudio_RP');
  const animationFile = path.join(rp, 'animations', 'mannequin.animation.json');
  const entityFile = path.join(rp, 'entity', 'mannequin.entity.json');
  fs.writeFileSync(animationFile, JSON.stringify({ format_version: '1.8.0', animations: { 'animation.pose_studio.mannequin.pose': { loop: true, bones } } }, null, 2) + '\n');
  const entity = JSON.parse(fs.readFileSync(entityFile, 'utf8'));
  const scripts = entity['minecraft:client_entity'].description.scripts;
  // (what was there and isn't the pose's stays: the cloak's angle for armour that reads it)
  const others = (scripts.pre_animation || []).filter((line) => !/v\.(pose_|[tlfs][ao]\d)/.test(line));
  scripts.initialize = initialize;
  scripts.pre_animation = others.concat(preAnimation);
  fs.writeFileSync(entityFile, JSON.stringify(entity, null, 2) + '\n');
  console.log(`${values.length} numbers -> ${path.relative(__dirname, animationFile)}, ${path.relative(__dirname, entityFile)} (${preAnimation.length} script lines)`);
}

module.exports = { initialize, preAnimation, bones, values, TICK };
if (require.main === module) write();
