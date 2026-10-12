// Writes the Pose Studio player's pose animation and the scripts that feed it:
//   packs/PoseStudio_RP/animations/mannequin.animation.json
//   packs/PoseStudio_RP/entity/mannequin.entity.json (scripts.initialize and scripts.pre_animation)
// and, for a player drawn far away from close by (see FAR below):
//   packs/PoseStudio_BP/entities/mannequin.json (its properties: pose:far, and pose:skin that also says "not drawn")
//   packs/PoseStudio_RP/models/entity/mannequin.geo.json (how far from the entity its model may be drawn)
//   packs/PoseStudio_RP/render_controllers/mannequin.render_controllers.json (the skin, or nothing)
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

// ---- Drawn far away from close by ----
// Minecraft only shows a player the entities near them, so one that's too far off is kept near
// the player (see the behavior pack's script), a whole number of 16-block steps from where it
// belongs on each axis, with pose:far saying how many: 0 in its place, else
// (x steps + 64) + 128 * (y steps + 64) + 16384 * (z steps + 64). The root of the model is moved
// that many steps, so it's drawn where it belongs. The pose:proxy copies of mobs get the same
// (see prepareProxy in the plugin, which has these lines too).
//
// An entity can have 32 properties and the player's were all taken: "not drawn" (what a mob copy
// holds is held by a player that isn't drawn) is now a skin number of 64 or more, which freed one.
const far = "q.property('pose:far')";
const FAR = {
  property: { type: 'int', range: [0, 2097151], default: 0, client_sync: true },
  // (16 blocks are 256 of a bone's units; a bone's x and y go the world's way, its z the other way)
  position: [
    `${far} > 0 ? (math.mod(${far}, 128) - 64) * 256 : 0`,
    `${far} > 0 ? (math.mod(math.floor(${far} / 128), 128) - 64) * 256 : 0`,
    `${far} > 0 ? (64 - math.floor(${far} / 16384)) * 256 : 0`,
  ],
  // the model is drawn up to 1008 blocks from the entity: this much to its side and height
  bounds: 2048,
};

const bones = { root: { position: FAR.position } };
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
  // its properties: how far from its place it's kept; and whether it's drawn, as part of the skin number
  const behaviorFile = path.join(__dirname, 'packs', 'PoseStudio_BP', 'entities', 'mannequin.json');
  const behavior = JSON.parse(fs.readFileSync(behaviorFile, 'utf8'));
  const properties = behavior['minecraft:entity'].description.properties;
  delete properties['pose:hidden'];
  properties['pose:skin'] = { type: 'int', range: [0, 127], default: 0, client_sync: true };
  properties['pose:far'] = FAR.property;
  if (Object.keys(properties).length > 32) throw new Error(`${Object.keys(properties).length} properties: an entity can have 32`);
  fs.writeFileSync(behaviorFile, JSON.stringify(behavior, null, 2) + '\n');
  const controllerFile = path.join(rp, 'render_controllers', 'mannequin.render_controllers.json');
  const controllers = JSON.parse(fs.readFileSync(controllerFile, 'utf8'));
  for (const controller of Object.values(controllers.render_controllers)) {
    controller.textures = controller.textures.map((line) => (/Array\.skins/.test(line) ? "q.property('pose:skin') >= 64 ? Texture.clear : Array.skins[math.mod(q.property('pose:skin'), 32)]" : line));
  }
  fs.writeFileSync(controllerFile, JSON.stringify(controllers, null, 2) + '\n');
  // …and its model allowed that far from the entity (or it's left out as soon as the entity is out of view)
  const geometryFile = path.join(rp, 'models', 'entity', 'mannequin.geo.json');
  const geometry = JSON.parse(fs.readFileSync(geometryFile, 'utf8'));
  for (const g of geometry['minecraft:geometry']) Object.assign(g.description, { visible_bounds_width: FAR.bounds, visible_bounds_height: FAR.bounds });
  fs.writeFileSync(geometryFile, JSON.stringify(geometry, null, 2) + '\n');
  console.log(`${values.length} numbers -> ${path.relative(__dirname, animationFile)}, ${path.relative(__dirname, entityFile)} (${preAnimation.length} script lines)`);
}

module.exports = { initialize, preAnimation, bones, values, TICK, FAR };
if (require.main === module) write();
