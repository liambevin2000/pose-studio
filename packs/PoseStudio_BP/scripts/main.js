// Pose Studio — in-game half.
// The Blockbench plugin runs commands through the /connect websocket as the player,
// e.g. `/scriptevent pose:set {"id":"mq_1","p":[x,y,z],"b":[...21 angles]}`.
// Positions arrive as block offsets from the anchor; angles are already in Bedrock convention.
import { world, system, BlockVolume, StructureSaveMode } from "@minecraft/server";

const TYPE = "pose:mannequin";
const TAG_PREFIX = "pose_id.";
// The mannequin's pose, packed two 12-bit values per int property: turns (x, y, z per bone, in
// 360/4096 steps) in pose:a0..14 and moves (x, y, z per bone, in 1/64 pixel steps) in pose:o0..13.
const ANGLE_BONES = ["pose_root","waist","body","head","rightArm","leftArm","rightLeg","leftLeg","rightItem","leftItem"];
const POS_BONES = ["waist","body","head","rightArm","leftArm","rightLeg","leftLeg","rightItem","leftItem"];
const ANGLE_PROPS = Array.from({ length: 15 }, (_, i) => `pose:a${i}`);
const POS_PROPS = Array.from({ length: 14 }, (_, i) => `pose:o${i}`);
const encodeAngle = (deg) => ((Math.round(((Number(deg) || 0) + 180) * 4096 / 360) % 4096) + 4096) % 4096;
const encodeOffset = (u) => Math.max(0, Math.min(4095, Math.round((Number(u) || 0) * 64) + 2048));
function packPairs(values, count, encode) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(encode(values[i * 2]) * 4096 + encode(values[i * 2 + 1]));
  return out;
}
// turns: ANGLE_BONES x 3 (Bedrock convention), moves: POS_BONES x 3
function setPoseProperties(entity, turns, moves) {
  const a = packPairs(Array.isArray(turns) ? turns : [], ANGLE_PROPS.length, encodeAngle);
  const o = packPairs(Array.isArray(moves) ? moves : [], POS_PROPS.length, encodeOffset);
  for (let i = 0; i < a.length; i++) entity.setProperty(ANGLE_PROPS[i], a[i]);
  for (let i = 0; i < o.length; i++) entity.setProperty(POS_PROPS[i], o[i]);
}
// What Blockbench sends: two characters per 12-bit value, the turns then the moves.
const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function setPoseCode(entity, code) {
  const text = String(code || "");
  const values = [];
  for (let i = 0; i + 1 < text.length; i += 2) {
    const a = CODE_CHARS.indexOf(text[i]);
    const b = CODE_CHARS.indexOf(text[i + 1]);
    values.push(a < 0 || b < 0 ? 2048 : a * 64 + b);
  }
  const turns = ANGLE_BONES.length * 3;
  const pair = (list, i) => (list[i] ?? 2048) * 4096 + (list[i + 1] ?? 2048);
  const t = values.slice(0, turns);
  const o = values.slice(turns);
  for (let i = 0; i < ANGLE_PROPS.length; i++) entity.setProperty(ANGLE_PROPS[i], pair(t, i * 2));
  for (let i = 0; i < POS_PROPS.length; i++) entity.setProperty(POS_PROPS[i], pair(o, i * 2));
}
function decodePose(entity) {
  const values = (props, decode) => props.flatMap((p) => {
    const v = Number(entity.getProperty(p));
    if (!Number.isFinite(v)) return [NaN, NaN];
    return [decode(Math.floor(v / 4096)), decode(v % 4096)];
  });
  return {
    turns: values(ANGLE_PROPS, (n) => Math.round(n * 360 / 4096 - 180)),
    moves: values(POS_PROPS, (n) => Math.round(((n - 2048) / 64) * 10) / 10),
  };
}

let warnedFov = false;
const reportedErrors = new Set();

function getAnchor() {
  const raw = world.getDynamicProperty("pose:anchor");
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function setAnchorAt(player) {
  const l = player.location;
  const anchor = { x: Math.floor(l.x) + 0.5, y: Math.floor(l.y), z: Math.floor(l.z) + 0.5, dim: player.dimension.id };
  world.setDynamicProperty("pose:anchor", JSON.stringify(anchor));
  return anchor;
}

function requireAnchor(player) {
  const anchor = getAnchor();
  if (anchor) return anchor;
  if (!player) throw new Error("no anchor set and no player to set it from");
  const a = setAnchorAt(player);
  player.sendMessage(`§b[Pose Studio]§r Anchor set at ${a.x} ${a.y} ${a.z}`);
  return a;
}

function toWorld(anchor, p) {
  return { x: anchor.x + p[0], y: anchor.y + p[1], z: anchor.z + p[2] };
}

function fmt(v) {
  return `${v.x.toFixed(3)} ${v.y.toFixed(3)} ${v.z.toFixed(3)}`;
}

function clampAngle(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-180, Math.min(180, n)) : 0;
}

// Everything Pose Studio spawns (mannequins and posable copies) is tagged with its Blockbench id.
function findMannequins(dim, id) {
  return dim.getEntities({ tags: [TAG_PREFIX + id] });
}

function setPose(player, data) {
  if (!finite(data.p)) throw new Error("invalid position");
  const anchor = requireAnchor(player);
  const dim = world.getDimension(anchor.dim);
  const loc = toWorld(anchor, data.p);

  let entity = findMannequins(dim, data.id)[0];
  if (!entity) {
    entity = dim.spawnEntity(TYPE, loc);
    entity.addTag(TAG_PREFIX + data.id);
  }
  entity.teleport(loc, { rotation: { x: 0, y: 0 } });

  setPoseCode(entity, data.q);
  // skin slot (0 = default Steve, 1-16 = textures/entity/pose_studio/skin_N.png) and arm type
  entity.setProperty("pose:skin", Math.max(0, Math.min(16, Math.round(Number(data.s) || 0))));
  entity.setProperty("pose:slim", !!data.sl);
  entity.setProperty("pose:hidden", false);
  if (data.e) wantedEquipment.set(data.id, data.e);
  const equipment = wantedEquipment.get(data.id);
  if (equipment) applyEquipment(entity, equipment);
}

// `pose:eq {"id","e"}` — a mannequin's equipment, sent only when it changes. It's remembered, so
// a mannequin made again later (after a refresh, say) gets it back.
const wantedEquipment = new Map(); // mannequin id -> equipment
function setEquipmentFor(player, data) {
  if (!data.id) return;
  wantedEquipment.set(data.id, data.e || {});
  const anchor = requireAnchor(player);
  const entity = findMannequins(world.getDimension(anchor.dim), data.id)[0];
  if (entity) applyEquipment(entity, data.e || {});
}

// `pose:ent {"id","t","m","p","y","q"}` — a posable copy of an entity: t is pose:proxy, m which of
// its models to show, y the yaw, q 30 packed ints (two 12-bit bone angles each).
function setEntity(player, data) {
  if (!finite(data.p)) throw new Error("invalid position");
  const anchor = requireAnchor(player);
  const dim = world.getDimension(anchor.dim);
  const loc = toWorld(anchor, data.p);

  let entity = findMannequins(dim, data.id)[0];
  if (entity && entity.typeId !== data.t) {
    entity.remove();
    entity = undefined;
  }
  if (!entity) {
    try {
      entity = dim.spawnEntity(data.t, loc);
    } catch (e) {
      if (isUnloaded(e)) throw e; // the area isn't loaded: the update waits for it
      throw new Error("Pose Studio's entities aren't loaded yet. Reload Minecraft's packs (Pose Studio ▸ More ▸ Reload Minecraft Packs).");
    }
    entity.addTag(TAG_PREFIX + data.id);
  }
  const yaw = Number(data.y) || 0;
  entity.teleport(loc, { rotation: { x: 0, y: yaw } });
  entity.setRotation({ x: 0, y: yaw });
  if (data.m !== undefined) {
    try {
      entity.setProperty("pose:model", Math.max(0, Math.round(Number(data.m) || 0)));
    } catch (e) {
      throw new Error("This entity was added after Minecraft last loaded Pose Studio's entities. Reload Minecraft's packs once.");
    }
  }
  // packed angles arrive as one comma-separated base-36 string to keep the command short
  const q = typeof data.q === "string" ? data.q.split(",").map((v) => parseInt(v, 36)) : data.q || [];
  for (let i = 0; i < q.length; i++) entity.setProperty(`pose:p${i}`, Math.max(0, Math.min(16777215, Math.round(q[i]))));
  applyEquipment(entity, data.e || {}, ARMOUR_SLOTS);
}

// Held items on entity copies: the copy itself doesn't draw what it holds, so an invisible
// mannequin (pose:hidden, body parts not drawn) is placed so its hand lands on the copy's hand
// and holds the item. data.h = { main: { p, r, item }, off: { p, r, item } }: p is where that
// mannequin stands (block offset from the anchor), r its whole-body rotation (Bedrock convention).
const finite = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(Number(n)));

// `pose:hold {"id","s":"main"|"off","p","r","i"}` places the hidden mannequin for one hand; without
// "i" it removes it.
// Spawning a holder in the same tick as the copy's own update (pose:ent) disconnects the world,
// so hand updates are applied a couple of ticks later; only the latest one per hand is used.
const pendingHolders = new Map();

function setHolder(player, data) {
  const key = `${data.id}__${data.s === "off" ? "off" : "main"}`;
  const waiting = pendingHolders.has(key);
  pendingHolders.set(key, { player, data });
  if (waiting) return;
  system.runTimeout(() => {
    const next = pendingHolders.get(key);
    pendingHolders.delete(key);
    try {
      applyHolder(next.player, next.data);
    } catch (e) {
      const msg = `pose:hold failed: ${e}`;
      console.warn(`[Pose Studio] ${msg}`);
      if (!reportedErrors.has(msg) && next.player) {
        reportedErrors.add(msg);
        next.player.sendMessage(`§c[Pose Studio] ${msg}`);
      }
    }
  }, 2);
}

function applyHolder(player, data) {
  const anchor = requireAnchor(player);
  const dim = world.getDimension(anchor.dim);
  const side = data.s === "off" ? "off" : "main";
  const tag = `${TAG_PREFIX}${data.id}__${side}`;
  let holder = dim.getEntities({ tags: [tag] })[0];
  if (!data.i || !finite(data.p) || !finite(data.r)) {
    if (holder) holder.remove();
    return;
  }
  const loc = toWorld(anchor, data.p.map(Number));
  if (!holder) {
    holder = dim.spawnEntity(TYPE, loc);
    holder.addTag(tag);
    holder.setProperty("pose:hidden", !data.v);
  }
  holder.teleport(loc, { rotation: { x: 0, y: 0 } });
  setPoseProperties(holder, data.r.map(Number), []);
  holder.setProperty("pose:hidden", !data.v); // "v":1 = visible, for testing
  // always the main hand: the off hand refuses most items (swords, tools...)
  applyEquipment(holder, { mainhand: data.i });
}

// Equipment: real items in the mannequin's armour and hand slots, so Minecraft renders them the
// way it does on mobs. Only re-applied when it changes.
const EQUIP_SLOTS = {
  head: "slot.armor.head",
  chest: "slot.armor.chest",
  legs: "slot.armor.legs",
  feet: "slot.armor.feet",
  mainhand: "slot.weapon.mainhand",
  offhand: "slot.weapon.offhand",
};
const appliedEquipment = new Map(); // entity id -> equipment JSON

// Entity copies (pose:proxy) only ever get armour: changing what a copy holds in its hands
// disconnects the world (its held-item drawing is broken), so their hand slots are never touched.
// Their held items are drawn by hidden mannequins instead (see updateHolders).
const ARMOUR_SLOTS = ["head", "chest", "legs", "feet"];

function applyEquipment(entity, equipment, slots = Object.keys(EQUIP_SLOTS)) {
  const key = JSON.stringify([slots, equipment || {}]);
  if (appliedEquipment.get(entity.id) === key) return;
  appliedEquipment.set(entity.id, key);
  const problems = [];
  for (const [slot, target] of Object.entries(EQUIP_SLOTS).filter(([slot]) => slots.includes(slot))) {
    const wanted = String((equipment && equipment[slot]) || "air");
    if (!/^[a-z0-9_.:-]+$/i.test(wanted)) {
      problems.push(`${slot}: "${wanted}" isn't a valid item id`);
      continue;
    }
    try {
      entity.runCommand(`replaceitem entity @s ${target} 0 ${wanted}`);
    } catch (e) {
      problems.push(`${slot}: ${wanted} (${e})`);
    }
  }
  if (problems.length) throw new Error(`some equipment couldn't be set: ${problems.join("; ")}`);
}

function removeMannequin(data) {
  const anchor = getAnchor();
  if (!anchor) return;
  const dim = world.getDimension(anchor.dim);
  for (const tag of [data.id, `${data.id}__main`, `${data.id}__off`]) for (const e of findMannequins(dim, tag)) e.remove();
}

function clearAll() {
  for (const dimId of ["overworld", "nether", "the_end"]) {
    for (const e of world.getDimension(dimId).getEntities({ families: ["pose_studio"] })) e.remove();
  }
}

function setCamera(player, data) {
  if (!player) return;
  const anchor = requireAnchor(player);
  const pos = toWorld(anchor, data.p);
  const target = toWorld(anchor, data.t);
  player.runCommand(`camera @s set minecraft:free pos ${fmt(pos)} facing ${fmt(target)}`);
  if (data.f) {
    try {
      player.runCommand(`camera @s fov_set ${Number(data.f).toFixed(1)}`);
    } catch (e) {
      if (!warnedFov) console.warn(`[Pose Studio] fov_set not supported here: ${e}`);
      warnedFov = true;
    }
  }
}

function clearCamera(player) {
  if (!player) return;
  player.runCommand("camera @s clear");
  try {
    player.runCommand("camera @s fov_clear");
  } catch {
    // older versions without fov support
  }
}

// `pose:hideplayer {"hide":true}` — hides the player's own model (invisibility, no particles)
// while Blockbench's camera view is on, so it doesn't end up in shots.
const HIDDEN_TAG = "pose_hidden";

function setPlayerHidden(player, hide) {
  if (!player) return;
  if (hide) {
    player.addEffect("invisibility", 20000000, { amplifier: 0, showParticles: false });
    player.addTag(HIDDEN_TAG);
  } else if (player.hasTag(HIDDEN_TAG)) {
    // only undo invisibility we added ourselves
    player.removeEffect("invisibility");
    player.removeTag(HIDDEN_TAG);
  }
}

// `pose:backdrop {"c":0|1,"p":[x,y,z],"h":[hx,hy,hz]}` — Entity Shots: for a moment, the blocks in
// the box (centre p from the anchor, h blocks each way) are saved and cleared, and a box of one
// flat, unlit colour (c: magenta or green) goes just inside its walls, so only Pose Studio's players
// and mobs are left in front of it. Blockbench takes its two shots, then `{"off":1}` puts every block
// back exactly as it was and removes the box. Nothing Pose Studio placed moves; players standing in
// the box are held where they are. The saved blocks are kept in the world until they're back, so a
// world closed mid-shot gets them back when it opens again.
const BACKDROP_TYPE = "pose:backdrop";
const BACKDROP_TAG = "pose_backdrop";
const CLEARED_PROPERTY = "pose:cleared";
const PIECE = 32; // 32×32×32 = the most one fill can change
let heldPlayers = []; // [{ player, at, rotation }] while the box is cleared
let shotActive = false; // blocks are out for a shot right now
let holdRun; // the every-tick hold, only while blocks are out

function holdPlayers() {
  for (const held of heldPlayers) {
    try {
      const l = held.player.location;
      if (Math.hypot(l.x - held.at.x, l.y - held.at.y, l.z - held.at.z) > 0.01) held.player.teleport(held.at, { rotation: held.rotation, keepVelocity: false });
    } catch {
      // left the game
    }
  }
}

function removeBackdropBoxes() {
  for (const dimension of ["overworld", "nether", "the_end"]) {
    try {
      for (const e of world.getDimension(dimension).getEntities({ tags: [BACKDROP_TAG] })) e.remove();
    } catch {
      // dimension not loaded
    }
  }
}

function restoreCleared() {
  heldPlayers = [];
  shotActive = false;
  if (holdRun !== undefined) system.clearRun(holdRun);
  holdRun = undefined;
  const raw = world.getDynamicProperty(CLEARED_PROPERTY);
  if (typeof raw !== "string") return;
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    world.setDynamicProperty(CLEARED_PROPERTY, undefined);
    return;
  }
  const dim = world.getDimension(record.dim);
  const left = [];
  for (const piece of record.pieces || []) {
    try {
      world.structureManager.place(piece.id, dim, piece.at, { includeEntities: false });
      world.structureManager.delete(piece.id);
    } catch (e) {
      console.warn(`[Pose Studio] couldn't put back blocks at ${fmt(piece.at)} yet: ${e}`);
      left.push(piece);
    }
  }
  if (record.drops !== undefined) {
    try {
      world.gameRules.doTileDrops = record.drops;
    } catch {
      // older versions
    }
  }
  world.setDynamicProperty(CLEARED_PROPERTY, left.length ? JSON.stringify(Object.assign(record, { pieces: left })) : undefined);
}

function clearBox(player, dim, min, max) {
  restoreCleared(); // anything still out from an earlier shot goes back first
  const record = { dim: dim.id, pieces: [] };
  const stamp = Date.now().toString(36);
  // saved first, all of it, then cleared; if any of it can't be saved (not loaded yet), nothing is cleared
  try {
    for (let x = min.x; x < max.x; x += PIECE) {
      for (let y = min.y; y < max.y; y += PIECE) {
        for (let z = min.z; z < max.z; z += PIECE) {
          const from = { x, y, z };
          const to = { x: Math.min(max.x, x + PIECE) - 1, y: Math.min(max.y, y + PIECE) - 1, z: Math.min(max.z, z + PIECE) - 1 };
          const id = `pose:cleared_${stamp}_${record.pieces.length}`;
          world.structureManager.createFromWorld(id, dim, from, to, { includeBlocks: true, includeEntities: false, saveMode: StructureSaveMode.World });
          record.pieces.push({ id, at: from, to });
        }
      }
    }
  } catch (e) {
    for (const piece of record.pieces) {
      try {
        world.structureManager.delete(piece.id);
      } catch {
        // already gone
      }
    }
    throw e;
  }
  try {
    record.drops = world.gameRules.doTileDrops;
    world.gameRules.doTileDrops = false; // a torch losing its wall drops nothing
  } catch {
    // older versions
  }
  world.setDynamicProperty(CLEARED_PROPERTY, JSON.stringify(record));
  shotActive = true;
  for (const piece of record.pieces) dim.fillBlocks(new BlockVolume(piece.at, piece.to), "minecraft:air");
  // players in the box would fall: held where they are until the blocks are back
  heldPlayers = world.getAllPlayers()
    .filter((p) => p.dimension.id === dim.id)
    .filter((p) => ["x", "y", "z"].every((k) => p.location[k] >= min[k] - 2 && p.location[k] <= max[k] + 2))
    .map((p) => ({ player: p, at: Object.assign({}, p.location), rotation: p.getRotation() }));
  if (heldPlayers.length) holdRun = system.runInterval(holdPlayers, 1);
}

// The box's chunks are kept loaded (a ticking area) while a shot uses them: the camera can be far
// from where the player stands.
const SHOT_AREA = "pose_shot";
function removeShotArea() {
  for (const dimension of ["overworld", "nether", "the_end"]) {
    try {
      world.getDimension(dimension).runCommand(`tickingarea remove ${SHOT_AREA}`);
    } catch {
      // none there
    }
  }
}

// With "op" (Blockbench waits for the answer): ready once the blocks are out and the box is up,
// retried for up to 15 seconds while the chunks load.
function setBackdrop(player, data) {
  if (data.off) {
    removeBackdropBoxes();
    restoreCleared();
    removeShotArea();
    return;
  }
  if (data.op) beginResult(data.op);
  const anchor = requireAnchor(player);
  if (!finite(data.p) || !finite(data.h)) throw new Error("backdrop needs p:[x,y,z] and h:[x,y,z]");
  const dim = world.getDimension(anchor.dim);
  const centre = toWorld(anchor, data.p.map(Number));
  const half = data.h.map((v) => Math.max(1, Math.min(64, Number(v))));
  // the blocks: whole blocks covering the box
  const min = { x: Math.floor(centre.x - half[0]), y: Math.floor(centre.y - half[1]), z: Math.floor(centre.z - half[2]) };
  const max = { x: Math.ceil(centre.x + half[0]), y: Math.ceil(centre.y + half[1]), z: Math.ceil(centre.z + half[2]) };
  // the walls: just inside the cleared blocks, so the blocks beyond are hidden without flicker
  const place = () => {
    const mid = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
    let box = dim.getEntities({ tags: [BACKDROP_TAG] })[0];
    if (!box) {
      box = dim.spawnEntity(BACKDROP_TYPE, mid);
      box.addTag(BACKDROP_TAG);
    } else {
      box.teleport(mid, { dimension: dim });
    }
    box.setProperty("pose:hx", Math.round(((max.x - min.x) / 2 - 0.05) * 100));
    box.setProperty("pose:hy", Math.round(((max.y - min.y) / 2 - 0.05) * 100));
    box.setProperty("pose:hz", Math.round(((max.z - min.z) / 2 - 0.05) * 100));
    box.setProperty("pose:c", data.c ? 1 : 0);
  };
  const clearing = data.clear && world.getDynamicProperty(CLEARED_PROPERTY) === undefined;
  if (clearing) {
    try {
      dim.runCommand(`tickingarea add ${min.x} ${min.y} ${min.z} ${max.x - 1} ${max.y - 1} ${max.z - 1} ${SHOT_AREA} true`);
    } catch {
      // there already, or the world has its 10; the chunks may be loaded anyway
    }
  }
  let tries = 0;
  const attempt = () => {
    try {
      if (clearing) clearBox(player, dim, min, max);
      place();
      if (data.op) finishResult(["ok"]);
      return true;
    } catch (e) {
      if (isUnloaded(e) && ++tries < 60) return false;
      if (!data.op) throw e;
      failResult(isUnloaded(e) ? "The area around the camera and the entities wouldn't load. Stand closer to the scene and try again." : e);
      return true;
    }
  };
  if (attempt()) return;
  const run = system.runInterval(() => {
    if (attempt()) system.clearRun(run);
  }, 5);
}


// `pose:shothide {"ids":[...]}` — Entity Shots of one player or mob on its own: the others (and
// what they hold) go deep under the ground, straight down, for the shot; `{"ids":[]}` brings them
// all back. Blockbench also sends every pose again afterwards, which puts anything still away back.
const shotHidden = new Map(); // entity id -> { entity, at }

function setShotHidden(data) {
  for (const [, away] of shotHidden) {
    try {
      away.entity.teleport(away.at, { keepVelocity: false });
    } catch {
      // gone since
    }
  }
  shotHidden.clear();
  const anchor = getAnchor();
  const ids = Array.isArray(data.ids) ? data.ids.map(String) : [];
  if (!anchor || !ids.length) return;
  const dim = world.getDimension(anchor.dim);
  const bottom = dim.heightRange ? dim.heightRange.min + 2 : -60;
  for (const id of ids) {
    for (const tag of [id, `${id}__main`, `${id}__off`]) {
      for (const e of findMannequins(dim, tag)) {
        const at = Object.assign({}, e.location);
        e.teleport({ x: at.x, y: bottom, z: at.z }, { keepVelocity: false });
        shotHidden.set(e.id, { entity: e, at });
      }
    }
  }
}

// `/scriptevent pose:debug` — prints what each mannequin has actually received.
function debug(player) {
  const anchor = getAnchor();
  const say = (m) => (player ? player.sendMessage(m) : console.warn(m));
  say(`§b[Pose Studio]§r anchor: ${anchor ? `${anchor.x} ${anchor.y} ${anchor.z}` : "not set"}`);
  if (player) {
    const l = player.location;
    say(`§b[Pose Studio]§r you: ${l.x.toFixed(1)} ${l.y.toFixed(1)} ${l.z.toFixed(1)} (${player.dimension.id}) | updates waiting for an unloaded area: ${waiting.size}`);
  }
  if (!anchor) return;
  for (const e of world.getDimension(anchor.dim).getEntities({ families: ["pose_studio"] })) {
    const id = e.getTags().find((t) => t.startsWith(TAG_PREFIX))?.slice(TAG_PREFIX.length) ?? "?";
    const l = e.location;
    say(`§7  ${id} at ${l.x.toFixed(1)} ${l.y.toFixed(1)} ${l.z.toFixed(1)}`);
  }
  for (const e of world.getDimension(anchor.dim).getEntities({ type: TYPE })) {
    const id = e.getTags().find((t) => t.startsWith(TAG_PREFIX))?.slice(TAG_PREFIX.length) ?? "?";
    const { turns, moves } = decodePose(e);
    const parts = ANGLE_BONES.map((b, i) => {
      const t = turns.slice(i * 3, i * 3 + 3).map((v) => (Number.isFinite(v) ? v : "MISSING"));
      const p = POS_BONES.indexOf(b);
      const o = p >= 0 ? moves.slice(p * 3, p * 3 + 3) : [];
      return `${b} ${t.join("/")}${o.some((v) => v) ? ` moved ${o.join("/")}` : ""}`;
    });
    say(`§e${id}§r ${parts.join(", ")}`);
  }
  // Equipment on every Pose Studio entity: what the script set, and whether Minecraft confirms
  // the item is really in that slot (hasitem).
  for (const e of world.getDimension(anchor.dim).getEntities({ families: ["pose_studio"] })) {
    const id = e.getTags().find((t) => t.startsWith(TAG_PREFIX))?.slice(TAG_PREFIX.length) ?? "?";
    let applied = {};
    try {
      const stored = JSON.parse(appliedEquipment.get(e.id) || "{}");
      applied = Array.isArray(stored) ? stored[1] : stored;
    } catch {
      applied = {};
    }
    const slots = Object.entries(EQUIP_SLOTS)
      .filter(([slot]) => applied[slot])
      .map(([slot, location]) => {
        let confirmed = "?";
        try {
          confirmed = e.runCommand(`testfor @s[hasitem={item=${applied[slot]},location=${location}}]`).successCount > 0 ? "yes" : "NO";
        } catch (err) {
          confirmed = `NO (${err})`;
        }
        return `${slot}=${applied[slot]} in slot: ${confirmed}`;
      });
    say(`§e${id}§r (${e.typeId}) equipment: ${slots.length ? slots.join(", ") : "none sent"}`);
  }
}

// ---- Game -> Blockbench channel -------------------------------------------------------------
// The websocket can only run commands, so results travel back as fake-player names on a scoreboard
// objective that is never shown on screen. Blockbench asks for a batch of pages at a time
// (`pose:page {"n":1,"k":8}` = pages 1 to 8), then reads them with `scoreboard players list`.
// Every name looks like `PSD[op|page|item]`; page 0 always carries
// `M|ready|<pages>|<items>|<items per page>` or `M|busy|<percent>`.
// What this script understands; Blockbench warns when the world runs an older one.
const PACK_PROTOCOL = 17;
const IO_OBJECTIVE = "pose_io";
const ITEMS_PER_PAGE = 30;
const MAX_PAGES_PER_BATCH = 16;
const MAX_ITEM_LENGTH = 90;
const MAX_SCAN_BLOCKS = 30000;

const result = { op: "none", busy: false, progress: 0, error: "", pages: [[]] };

function beginResult(op) {
  result.op = String(op || "none").replace(/[^a-z0-9]/gi, "");
  result.busy = true;
  result.progress = 0;
  result.error = "";
  result.pages = [[]];
}

function failResult(error) {
  result.busy = false;
  result.error = String(error).replace(/[^\w .:'"-]/g, " ").slice(0, 120);
}

function finishResult(items) {
  const pages = [];
  for (let i = 0; i < items.length; i += ITEMS_PER_PAGE) pages.push(items.slice(i, i + ITEMS_PER_PAGE));
  result.pages = pages.length ? pages : [[]];
  result.busy = false;
}

function publishPage(n, k = 1) {
  const scoreboard = world.scoreboard;
  if (scoreboard.getObjective(IO_OBJECTIVE)) scoreboard.removeObjective(IO_OBJECTIVE);
  if (n < 0) return; // -1 = clean up
  const objective = scoreboard.addObjective(IO_OBJECTIVE, IO_OBJECTIVE);
  const count = Math.max(1, Math.min(MAX_PAGES_PER_BATCH, Math.floor(k) || 1));
  let score = 0;
  for (let page = n; page < n + count; page++) {
    const items = [];
    if (page === 0) {
      const total = result.pages.reduce((sum, list) => sum + list.length, 0);
      let meta = `M|ready|${result.pages.length}|${total}|${ITEMS_PER_PAGE}`;
      if (result.busy) meta = `M|busy|${Math.round(result.progress * 100)}`;
      else if (result.error) meta = `M|error|${result.error}`;
      items.push(meta);
    }
    if (!result.busy) items.push(...(result.pages[page] ?? []));
    for (const item of items) objective.setScore(`PSD[${result.op}|${page}|${item}]`, score++);
    if (result.busy) break;
  }
}

// Packs short entries into items of at most MAX_ITEM_LENGTH characters: `B|a;b;c`.
function packItems(prefix, entries) {
  const items = [];
  let current = "";
  for (const entry of entries) {
    if (current && current.length + entry.length + 1 > MAX_ITEM_LENGTH - prefix.length) {
      items.push(prefix + current);
      current = "";
    }
    current += (current ? ";" : "") + entry;
  }
  if (current) items.push(prefix + current);
  return items;
}

// Blocks as `Q|` items: 8 characters each, no separators: x, y, z (offset by 2048) and the palette
// index, 2 characters of CODE_ALPHABET apiece.
const CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
const code2 = (n) => CODE_ALPHABET[(n >> 6) & 63] + CODE_ALPHABET[n & 63];
function packBlocks(blocks) {
  const perItem = Math.floor((MAX_ITEM_LENGTH - 2) / 8);
  const items = [];
  let current = "";
  let count = 0;
  for (const [key, palette] of blocks) {
    const [x, y, z] = key.split(".").map(Number);
    current += code2(x + 2048) + code2(y + 2048) + code2(z + 2048) + code2(palette);
    if (++count === perItem) {
      items.push("Q|" + current);
      current = "";
      count = 0;
    }
  }
  if (current) items.push("Q|" + current);
  return items;
}

// ---- Scene link ----
// Each world gets a permanent Pose Studio id, and remembers which Blockbench scene file belongs to
// it. `pose:scene` reports both (`W|<id>` and the scene as hex text in `S|<n>|<chunk>` items);
// `pose:setscene {"p":"C:/…/scene.bbmodel","n":"World name"}` stores the link (an empty p unlinks).
const WORLD_ID_PROPERTY = "pose:world_id";
const SCENE_PROPERTY = "pose:scene";

function worldId() {
  let id = world.getDynamicProperty(WORLD_ID_PROPERTY);
  if (typeof id !== "string" || !id) {
    id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    world.setDynamicProperty(WORLD_ID_PROPERTY, id);
  }
  return id;
}

// text <-> hex (of its URI encoding, so every character survives)
const toHex = (text) => Array.from(encodeURIComponent(text), (ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");

// The world's locations: { world, locations: [{ loc, name, path, anchor }] }. A link saved by an
// older version ({ path, name }) becomes the location "main".
function readLocations() {
  const raw = world.getDynamicProperty(SCENE_PROPERTY);
  let data = {};
  try {
    data = typeof raw === "string" && raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  if (!Array.isArray(data.locations)) {
    data = { world: data.name || "", locations: data.path ? [{ loc: "main", name: "Main", path: data.path }] : [] };
  }
  return data;
}

function reportScene(data, player) {
  beginResult(data.op);
  const hex = toHex(JSON.stringify(readLocations()));
  const items = [`W|${worldId()}`, `V|${PACK_PROTOCOL}`];
  const anchor = getAnchor();
  if (anchor) items.push(`A|${anchor.x}|${anchor.y}|${anchor.z}|${anchor.dim || ""}`);
  if (player) {
    const l = player.location;
    items.push(`P|${l.x.toFixed(1)}|${l.y.toFixed(1)}|${l.z.toFixed(1)}|${player.dimension.id}`);
  }
  const size = MAX_ITEM_LENGTH - 10;
  for (let i = 0; i * size < hex.length; i++) items.push(`S|${i}|${hex.slice(i * size, (i + 1) * size)}`);
  finishResult(items);
}

// `pose:setloc {"loc":"k3x9","p":"C:/…/x.bbmodel","n":"Birch forest","w":"World name","a":[x,y,z],"d":"minecraft:overworld"}`
// adds or updates a location; {"loc":"k3x9","del":true} removes it.
function storeLocation(data) {
  const loc = String(data.loc || "main");
  const saved = readLocations();
  const list = saved.locations.filter((l) => l.loc !== loc);
  if (!data.del) {
    const old = saved.locations.find((l) => l.loc === loc) || {};
    const a = Array.isArray(data.a) && data.a.length === 3 ? { x: Number(data.a[0]), y: Number(data.a[1]), z: Number(data.a[2]), dim: String(data.d || "") } : old.anchor;
    list.push({ loc, name: String(data.n || old.name || "Location"), path: String(data.p || old.path || ""), anchor: a || null });
  }
  // removed locations are remembered, so Blockbench does not bring them back from their scene files
  const removed = (saved.removed || []).filter((r) => r !== loc);
  if (data.del) removed.push(loc);
  const next = { world: String(data.w || saved.world || ""), locations: list, removed };
  world.setDynamicProperty(SCENE_PROPERTY, list.length || removed.length ? JSON.stringify(next) : undefined);
}

// the older single-scene link
function storeScene(data) {
  storeLocation({ loc: "main", p: data.p, n: data.n ? "Main" : "", del: !data.p });
}

// `pose:grabcam` — the player's eye position (relative to the anchor) and view rotation.
function grabCamera(player, data) {
  beginResult(data.op);
  if (!player) throw new Error("grabcam must be run by a player");
  const anchor = requireAnchor(player);
  const head = player.getHeadLocation();
  const rot = player.getRotation();
  const f = (v) => v.toFixed(3);
  finishResult([`C|${f(head.x - anchor.x)}|${f(head.y - anchor.y)}|${f(head.z - anchor.z)}|${f(rot.x)}|${f(rot.y)}`]);
}

// `pose:scan {"radius":48,"rays":20000,"dist":64}` — builds a picture of the area in two passes:
//  1. Terrain: one ray straight down per block column within `radius`, so the ground has no gaps.
//     Rays continue through leaves and logs to find the ground under trees, and cliff sides are
//     filled in down to the lowest neighbouring column.
//  2. Eye rays: `rays` rays in every direction from the player's eyes (up to `dist` blocks), which
//     pick up trunks, overhangs, walls and anything under a canopy.
// Runs as a job so big scans don't stall the game.
function startScan(player, data) {
  beginResult(data.op);
  if (!player) throw new Error("scan must be run by a player");
  const anchor = requireAnchor(player);
  const settings = {
    radius: Math.max(0, Math.min(128, Number(data.radius ?? 48))),
    rays: Math.max(0, Math.min(200000, Number(data.rays ?? 20000))),
    dist: Math.max(4, Math.min(256, Number(data.dist) || 64)),
  };
  system.runJob(scanJob(player.dimension, player.getHeadLocation(), anchor, settings));
}

const FOLIAGE = /leaves|log$|_wood$|stem$|hyphae|vine|mushroom_block|bamboo|azalea/;
const TERRAIN = /grass_block|dirt|podzol|mycelium|mud|stone|deepslate|andesite|granite|diorite|tuff|calcite|sand|gravel|clay|terracotta|snow|ice|netherrack|end_stone|moss_block|ore$/;
const MAX_CLIFF_FILL = 16;

function* scanJob(dimension, eye, anchor, { radius, rays, dist }) {
  const ax = Math.floor(anchor.x);
  const ay = Math.floor(anchor.y);
  const az = Math.floor(anchor.z);
  const palette = new Map();
  const blocks = new Map();
  const add = (x, y, z, typeId) => {
    if (blocks.size >= MAX_SCAN_BLOCKS) return;
    const key = `${x - ax}.${y - ay}.${z - az}`;
    if (blocks.has(key)) return;
    const type = typeId.replace(/^minecraft:/, "");
    if (!palette.has(type)) palette.set(type, palette.size);
    blocks.set(key, palette.get(type));
  };
  const cast = (from, dir, maxDistance) => {
    try {
      return dimension.getBlockFromRay(from, dir, { maxDistance, includeLiquidBlocks: true, includePassableBlocks: false });
    } catch {
      return undefined; // unloaded chunk or outside the world
    }
  };

  // ---- Pass 1: terrain columns ----
  const top = Math.min(dimension.heightRange.max - 1, Math.floor(eye.y) + 64);
  const bottom = Math.max(dimension.heightRange.min, Math.floor(eye.y) - 96);
  const ex = Math.floor(eye.x);
  const ez = Math.floor(eye.z);
  const ground = new Map(); // "x,z" -> { y, typeId }
  const columns = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) if (dx * dx + dz * dz <= radius * radius) columns.push([ex + dx, ez + dz]);
  }
  const down = { x: 0, y: -1, z: 0 };
  for (let i = 0; i < columns.length; i++) {
    const [x, z] = columns[i];
    let y = top + 1;
    for (let hits = 0; hits < 8; hits++) {
      const hit = cast({ x: x + 0.5, y: y - 0.001, z: z + 0.5 }, down, y - bottom);
      if (!hit) break;
      const b = hit.block;
      add(b.location.x, b.location.y, b.location.z, b.typeId);
      y = b.location.y;
      if (!FOLIAGE.test(b.typeId)) {
        ground.set(`${x},${z}`, { y, typeId: b.typeId });
        break;
      }
    }
    if (i % 200 === 0) {
      result.progress = rays ? 0.6 * (i / columns.length) : i / columns.length;
      yield;
    }
  }

  // Fill cliff and slope sides so steps don't float.
  for (const [key, g] of ground) {
    if (!TERRAIN.test(g.typeId)) continue;
    const [x, z] = key.split(",").map(Number);
    let lowest = g.y;
    for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
      const n = ground.get(`${nx},${nz}`);
      if (n) lowest = Math.min(lowest, n.y);
    }
    const fillType = /grass_block|mycelium|podzol/.test(g.typeId) ? "minecraft:dirt" : g.typeId;
    for (let y = g.y - 1; y > lowest && y >= g.y - MAX_CLIFF_FILL; y--) add(x, y, z, fillType);
  }
  yield;

  // ---- Pass 2: rays from the eyes ----
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < rays; i++) {
    // Fibonacci sphere: evenly spread directions.
    const y = 1 - (2 * (i + 0.5)) / rays;
    const r = Math.sqrt(1 - y * y);
    const a = golden * i;
    const hit = cast(eye, { x: Math.cos(a) * r, y, z: Math.sin(a) * r }, dist);
    if (hit) add(hit.block.location.x, hit.block.location.y, hit.block.location.z, hit.block.typeId);
    if (i % 250 === 0) {
      result.progress = 0.6 + 0.4 * (i / rays);
      yield;
    }
  }

  const items = [];
  for (const [type, index] of palette) items.push(`P|${index}|${type}`);
  items.push(...packBlocks(blocks));
  finishResult(items);
}

function handle(ev) {
  const player = ev.sourceEntity?.typeId === "minecraft:player" ? ev.sourceEntity : undefined;
  const data = ev.message ? JSON.parse(ev.message) : {};

  switch (ev.id) {
    case "pose:anchor": {
      // held updates were relative to the old anchor; Blockbench sends everything again after a move
      waiting.clear();
      // {"at":[x,y,z],"dim":"..."} puts the anchor back where a saved scene had it
      if (Array.isArray(data.at) && data.at.length === 3 && data.at.every((v) => Number.isFinite(Number(v)))) {
        const [x, y, z] = data.at.map(Number);
        const dim = String(data.dim || (player ? player.dimension.id : "minecraft:overworld"));
        world.setDynamicProperty("pose:anchor", JSON.stringify({ x, y, z, dim }));
        if (player && !data.quiet) player.sendMessage(`§b[Pose Studio]§r Scene placed at ${x} ${y} ${z}`);
        return;
      }
      if (!player) return;
      const a = setAnchorAt(player);
      player.sendMessage(`§b[Pose Studio]§r Anchor set at ${a.x} ${a.y} ${a.z}`);
      return;
    }
    case "pose:set":
      return setPose(player, data);
    case "pose:eq":
      return setEquipmentFor(player, data);
    case "pose:ent":
      return setEntity(player, data);
    case "pose:hold":
      return setHolder(player, data);
    case "pose:remove":
      return removeMannequin(data);
    case "pose:clear":
      return clearAll();
    case "pose:cam":
      return setCamera(player, data);
    case "pose:shothide":
      return setShotHidden(data);
    case "pose:backdrop":
      return setBackdrop(player, data);
    case "pose:camclear":
      return clearCamera(player);
    case "pose:debug":
      return debug(player);
    case "pose:goto": {
      // takes the player to a location (any dimension), so Minecraft loads and draws it
      if (!player || !Array.isArray(data.at)) return;
      const [x, y, z] = data.at.map(Number);
      const dim = data.dim ? world.getDimension(String(data.dim)) : player.dimension;
      player.teleport({ x, y, z }, { dimension: dim, keepVelocity: false });
      return;
    }
    case "pose:hideplayer":
      return setPlayerHidden(player, !!data.hide);
    case "pose:page":
      return publishPage(Number(data.n) || 0, Number(data.k) || 1);
    case "pose:scene":
      return reportScene(data, player);
    case "pose:setscene":
      return storeScene(data);
    case "pose:setloc":
      return storeLocation(data);
    case "pose:grabcam":
      return grabCamera(player, data);
    case "pose:scan":
      return startScan(player, data);
  }
}

// Hand holders are recreated by Blockbench on the next update; clear any saved in the world so a
// broken one from an older version can't linger.
function removeLeftoverHolders() {
  for (const dimId of ["overworld", "nether", "the_end"]) {
    try {
      for (const e of world.getDimension(dimId).getEntities({ families: ["pose_studio"] })) {
        if (e.getTags().some((t) => /__(main|off)$/.test(t))) e.remove();
      }
    } catch {
      // dimension not loaded yet
    }
  }
}
system.runTimeout(removeLeftoverHolders, 20);
// an Entity Shot backdrop left behind (the world closed mid-shot)
system.runTimeout(removeBackdropBoxes, 20);
// blocks still out (the world closed mid-shot, or their chunks weren't loaded yet) go back as soon as they can
system.runInterval(() => {
  if (!shotActive && world.getDynamicProperty(CLEARED_PROPERTY) !== undefined) restoreCleared();
}, 40);
// invisible seats left by first-person shots (0.45, since removed)
system.runTimeout(() => {
  for (const dimension of ["overworld", "nether", "the_end"]) {
    try {
      for (const e of world.getDimension(dimension).getEntities({ tags: ["pose_seat"] })) e.remove();
    } catch {
      // dimension not loaded
    }
  }
}, 20);

// Updates for a spot whose chunks aren't loaded (a location far from the player) wait here and
// are retried every second, so the location appears as soon as you get there.
const WAITING_EVENTS = new Set(["pose:set", "pose:ent", "pose:hold"]);
const waiting = new Map(); // "event|id" -> the latest event for it
let toldAboutWaiting = false;

function isUnloaded(e) {
  return /UnloadedChunk|not in a chunk|OutOfWorldBounds/i.test(`${e && e.name} ${e}`);
}

function waitForChunk(ev, e) {
  let id = "";
  try {
    id = JSON.parse(ev.message || "{}").id || "";
  } catch {
    id = "";
  }
  waiting.set(`${ev.id}|${id}`, { id: ev.id, message: ev.message, sourceEntity: ev.sourceEntity });
  if (!toldAboutWaiting && ev.sourceEntity?.typeId === "minecraft:player") {
    toldAboutWaiting = true;
    ev.sourceEntity.sendMessage("§e[Pose Studio]§r This location is too far away to load. It will appear when you go there.");
  }
}

if (system.runInterval) {
  system.runInterval(() => {
    for (const [key, ev] of waiting) {
      try {
        handle(ev);
        waiting.delete(key);
      } catch (e) {
        if (!isUnloaded(e)) waiting.delete(key); // a different problem: stop retrying
      }
    }
    if (!waiting.size) toldAboutWaiting = false;
  }, 20);
}

system.afterEvents.scriptEventReceive.subscribe(
  (ev) => {
    try {
      // a newer update for the same thing replaces one that was waiting
      if (WAITING_EVENTS.has(ev.id) && waiting.size) {
        try {
          waiting.delete(`${ev.id}|${JSON.parse(ev.message || "{}").id || ""}`);
        } catch {
          // not JSON: nothing waiting for it
        }
      }
      handle(ev);
    } catch (e) {
      if (WAITING_EVENTS.has(ev.id) && isUnloaded(e)) {
        waitForChunk(ev, e);
        return;
      }
      if (ev.id === "pose:scan" || ev.id === "pose:grabcam" || ev.id === "pose:scene" || ev.id === "pose:backdrop") failResult(e);
      const msg = `${ev.id} failed: ${e}`;
      console.warn(`[Pose Studio] ${msg}`);
      if (!reportedErrors.has(msg) && ev.sourceEntity?.typeId === "minecraft:player") {
        reportedErrors.add(msg);
        ev.sourceEntity.sendMessage(`§c[Pose Studio] ${msg}`);
      }
    }
  },
  { namespaces: ["pose"] }
);
