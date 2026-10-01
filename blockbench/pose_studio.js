// Pose Studio — Blockbench half.
// Blockbench is the editor; Minecraft Bedrock (with Vibrant Visuals) is the live viewport.
// Minecraft connects to this plugin with `/connect 127.0.0.1:19131`, and every pose change is
// sent back as a `/scriptevent pose:*` command that the Pose Studio behavior pack applies.
(function () {
  'use strict';

  // ---- Settings / calibration ---------------------------------------------------------------
  const PLUGIN_VERSION = '0.41.0'; // set by release.js from changelog.json
  const PORT = 19131;
  const TICK_MS = 50;          // 20 updates/sec max
  const MAX_IN_FLIGHT = 40;    // Minecraft drops requests past ~100 queued commands
  const COMMAND_TIMEOUT_MS = 5000;

  // Blockbench model space (pixels) -> block offset from the in-game anchor.
  // Blockbench displays Bedrock models mirrored on X and facing -Z; a 180° turn around Y maps
  // that onto the game, where an entity at yaw 0 faces +Z. If the scene comes out mirrored or
  // backwards in game, this is the one function to change.
  function toWorld(v) {
    return [round(-v[0] / 16, 3), round(v[1] / 16, 3), round(-v[2] / 16, 3)];
  }
  // Inverse of toWorld: block offset from the anchor -> Blockbench model space.
  function toModel(w) {
    return [-w[0] * 16, w[1] * 16, -w[2] * 16];
  }
  // Blockbench group rotation -> Bedrock animation rotation (Blockbench's own convention).
  function toBedrockRot(r) {
    return [wrap(-r[0]), wrap(-r[1]), wrap(r[2])];
  }

  // Bones in the order the behavior pack expects (after the root).
  const BONES = [
    { key: 'head',     pivot: [0, 24, 0],    from: [-4, 24, -4],   to: [4, 32, 4],    color: 0 },
    { key: 'body',     pivot: [0, 24, 0],    from: [-4, 12, -2],   to: [4, 24, 2],    color: 1 },
    { key: 'rightArm', pivot: [5, 22, 0],    from: [4, 12, -2],    to: [8, 24, 2],    color: 2 },
    { key: 'leftArm',  pivot: [-5, 22, 0],   from: [-8, 12, -2],   to: [-4, 24, 2],   color: 2 },
    { key: 'rightLeg', pivot: [1.9, 12, 0],  from: [-0.1, 0, -2],  to: [3.9, 12, 2],  color: 3 },
    { key: 'leftLeg',  pivot: [-1.9, 12, 0], from: [-3.9, 0, -2],  to: [0.1, 12, 2],  color: 3 },
  ];
  const MANNEQUIN_PREFIX = /^(player_|mq_)/i; // Player_N (older scenes: mq_N)
  // The hand bones items attach to (the player model's rightItem / leftItem), inside the arms.
  // They can be turned and moved (a weapon's holding pose does both), and Minecraft follows.
  // The player model's bone chain, as in Minecraft: waist > body > head and arms, legs on their own,
  // so leaning the waist or body carries the head and arms (a sprint leans forward).
  const RIG_PARENTS = { waist: '', body: 'waist', head: 'body', rightArm: 'body', leftArm: 'body', rightLeg: '', leftLeg: '' };
  const RIG_KEYS = new Set(['waist', 'body', 'head', 'rightarm', 'leftarm', 'rightleg', 'leftleg', 'rightitem', 'leftitem']);
  const RIG_REST = {
    waist: [0, 12, 0], body: [0, 24, 0], head: [0, 24, 0], rightarm: [5, 22, 0], leftarm: [-5, 22, 0],
    rightleg: [1.9, 12, 0], leftleg: [-1.9, 12, 0], rightitem: [6, 15, 1], leftitem: [-6, 15, 1],
  };
  const RIG_HOLDER = { waist: '', body: 'waist', head: 'body', rightarm: 'body', leftarm: 'body', rightleg: '', leftleg: '', rightitem: 'rightarm', leftitem: 'leftarm' };
  // the order Minecraft gets them in (turns: the whole player first; moves: the bones)
  const SENT_TURNS = ['waist', 'body', 'head', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg', 'rightItem', 'leftItem'];
  const SENT_MOVES = SENT_TURNS;
  const ITEM_BONES = [
    { key: 'rightItem', arm: 'rightArm', offset: [1, -7, 1] },
    { key: 'leftItem', arm: 'leftArm', offset: [-1, -7, 1] },
  ];

  // ---- Small helpers -------------------------------------------------------------------------
  function round(n, digits) {
    const f = Math.pow(10, digits);
    return Math.round(n * f) / f;
  }
  function wrap(deg) {
    let d = ((deg + 180) % 360 + 360) % 360 - 180;
    return round(d, 2);
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function nodeRequire(name, why) {
    if (typeof requireNativeModule === 'function') {
      return requireNativeModule(name, { message: `Pose Studio needs this to ${why || 'talk to Minecraft'}.` });
    }
    return require(name);
  }
  function bufferClass() {
    return typeof Buffer !== 'undefined' ? Buffer : nodeRequire('buffer').Buffer;
  }
  function boneKey(name) {
    return String(name).replace(/[\d_.]+$/, '').toLowerCase();
  }
  // In-game id of a mannequin or entity: its name, prefixed with the scene's location for every
  // location but the first, so several locations in one world don't take each other's entities.
  function mannequinId(name) {
    const link = typeof Project !== 'undefined' && Project && Project.pose_world;
    const loc = link && link.loc && link.loc !== 'main' ? `${link.loc}_` : '';
    return (loc + String(name)).replace(/[^a-z0-9_]/gi, '_');
  }

  // ---- Minimal WebSocket server (Minecraft's /connect speaks plain RFC 6455) -----------------
  const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

  function encodeFrame(opcode, payload) {
    const B = bufferClass();
    const len = payload.length;
    let header;
    if (len < 126) {
      header = B.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = B.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = B.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return B.concat([header, payload]);
  }

  function createFrameParser(socket, onText) {
    const B = bufferClass();
    let buf = B.alloc(0);
    let fragments = [];
    return function (chunk) {
      buf = B.concat([buf, chunk]);
      while (buf.length >= 2) {
        const fin = buf[0] & 0x80;
        const opcode = buf[0] & 0x0f;
        const masked = buf[1] & 0x80;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < offset + maskLen + len) return;

        let payload = B.from(buf.subarray(offset + maskLen, offset + maskLen + len));
        if (masked) {
          const mask = buf.subarray(offset, offset + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        buf = buf.subarray(offset + maskLen + len);

        if (opcode === 0x8) {
          socket.end(encodeFrame(0x8, B.alloc(0)));
          return;
        } else if (opcode === 0x9) {
          socket.write(encodeFrame(0xa, payload));
        } else if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
          fragments.push(payload);
          if (fin) {
            const text = B.concat(fragments).toString('utf8');
            fragments = [];
            onText(text);
          }
        }
      }
    };
  }

  const link = {
    server: null,
    socket: null,
    pending: new Map(),
    nodeCrypto: null,
    onConnect: null,

    get connected() {
      return !!this.socket;
    },
    get inFlight() {
      return this.pending.size;
    },

    // Blockbench only lets plugins use a whitelist of Node modules ('http' isn't on it),
    // so the HTTP upgrade request is parsed by hand on a raw 'net' socket.
    start() {
      if (this.server) return;
      const net = nodeRequire('net', 'accept a connection from Minecraft on 127.0.0.1');
      if (!net) throw new Error('Network permission was denied');
      this.nodeCrypto = nodeRequire('crypto');

      const server = net.createServer((socket) => this.handshake(socket));
      server.on('error', (e) => {
        this.server = null;
        Blockbench.showMessageBox({ title: 'Pose Studio', message: `Could not listen on port ${PORT}: ${e.message}` });
        if (linkToggle && linkToggle.value) linkToggle.set(false);
      });
      server.listen(PORT, '127.0.0.1');
      this.server = server;
    },

    handshake(socket) {
      const B = bufferClass();
      let head = B.alloc(0);
      const onData = (chunk) => {
        head = B.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) {
          if (head.length > 16384) socket.destroy();
          return;
        }
        socket.removeListener('data', onData);
        const headers = {};
        for (const line of head.subarray(0, end).toString('latin1').split('\r\n').slice(1)) {
          const i = line.indexOf(':');
          if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        if (!headers['sec-websocket-key']) {
          socket.end(
            'HTTP/1.1 426 Upgrade Required\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n' +
              `Pose Studio: in Minecraft run /connect 127.0.0.1:${PORT}`
          );
          return;
        }
        this.accept(headers['sec-websocket-key'], socket, head.subarray(end + 4));
      };
      socket.on('data', onData);
      socket.on('error', () => {});
    },

    accept(key, socket, leftover) {
      const acceptKey = this.nodeCrypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
      );
      socket.setNoDelay(true);

      if (this.socket) this.socket.destroy(); // one game client at a time
      this.socket = socket;
      this.heard = false;
      const connectedAt = Date.now();
      const parse = createFrameParser(socket, (text) => this.receive(text));
      socket.on('data', parse);
      if (leftover && leftover.length) parse(leftover);
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;
        // dropped straight away, before answering anything: Minecraft wants an encrypted connection
        const dropped = !this.heard && Date.now() - connectedAt < 15000;
        this.failPending('Minecraft disconnected');
        if (dropped) {
          Blockbench.showMessageBox({
            title: 'Pose Studio',
            message:
              'Minecraft closed the connection straight away ("Could not connect to server" in its chat).\n\n' +
              'In Minecraft: Settings > General > turn Require Encrypted Websockets OFF, then run /connect again.\n\n' +
              'Still failing? Check that cheats are on in this world.',
          });
        } else Blockbench.showQuickMessage('Pose Studio: Minecraft disconnected', 2000);
      });
      Blockbench.showQuickMessage('Pose Studio: Minecraft connected', 2000);
      if (this.onConnect) this.onConnect();
    },

    receive(text) {
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return;
      }
      this.heard = true;
      const id = data && data.header && data.header.requestId;
      const entry = id && this.pending.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      const body = data.body || {};
      if (typeof body.statusCode === 'number' && body.statusCode < 0) {
        entry.reject(new Error(body.statusMessage || `command failed (${body.statusCode})`));
      } else {
        entry.resolve(body);
      }
    },

    command(commandLine) {
      if (!this.socket) return Promise.reject(new Error('Minecraft is not connected'));
      const requestId = this.nodeCrypto.randomUUID();
      const message = JSON.stringify({
        header: { version: 1, requestId, messagePurpose: 'commandRequest', messageType: 'commandRequest' },
        body: { version: 1, commandLine, origin: { type: 'player' } },
      });
      this.socket.write(encodeFrame(0x1, bufferClass().from(message, 'utf8')));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error(`timed out: ${commandLine}`));
        }, COMMAND_TIMEOUT_MS);
        this.pending.set(requestId, { resolve, reject, timer });
      });
    },

    failPending(reason) {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
      }
      this.pending.clear();
    },

    stop() {
      if (this.socket) {
        // end() flushes queued commands (e.g. "show the player again") before closing
        const socket = this.socket;
        socket.end();
        setTimeout(() => socket.destroy(), 500);
      }
      this.socket = null;
      this.failPending('Pose Studio stopped');
      if (this.server) this.server.close();
      this.server = null;
    },
  };

  // ---- Cameras -------------------------------------------------------------------------------
  // A camera is a top-level group named cam_N. Its origin is the eye position; with no rotation it
  // looks down -Z (like a three.js camera). Rotations use the format's own Euler order, so what
  // the gizmo shows is exactly what gets sent to the game.
  const CAMERA_PREFIX = /^cam_/i;
  const DEG = Math.PI / 180;

  function eulerOrder() {
    return (typeof Format !== 'undefined' && Format && Format.euler_order) || 'ZYX';
  }

  function cameraRoots() {
    if (typeof Project === 'undefined' || !Project) return [];
    return Outliner.root.filter((node) => node instanceof Group && CAMERA_PREFIX.test(node.name));
  }

  // The cam_ group that is selected, or that contains the selected element.
  function selectedCamera() {
    let node = Group.first_selected !== undefined ? Group.first_selected : Group.selected;
    if (!node && Outliner.selected && Outliner.selected.length) node = Outliner.selected[0];
    while (node && node !== 'root') {
      if (node instanceof Group && node.parent === 'root' && CAMERA_PREFIX.test(node.name)) return node;
      node = node.parent;
    }
    return null;
  }

  function cameraForward(group) {
    const r = group.rotation;
    return new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG, eulerOrder()));
  }

  // ---- Rotating several things together --------------------------------------------------------
  // Blockbench turns each selected group around its own pivot. With two or more mannequins,
  // entities or cameras selected, Pose Studio also swings them around their shared centre, so the
  // selection turns as one piece (like rotating a group). The moves join Blockbench's own undo step.
  const POSE_ROOT_PREFIX = /^(player_|mq_|ent_|cam_)/i;
  let groupSpin = null; // { key, rotations: Map(uuid -> [x, y, z]), undoSave }
  let groupSpinTimer = null;
  const onRenderFrame = () => {
    try {
      checkGroupSpin();
    } catch (e) {
      console.warn('[Pose Studio] group rotation', e);
    }
    try {
      if (povPreview) updatePovViewport();
    } catch (e) {
      // the camera view went away
    }
  };
  function startGroupSpin() {
    // every frame where Blockbench offers it, so the swing keeps up with the gizmo
    if (typeof Blockbench !== 'undefined' && Blockbench.on && Blockbench.removeListener) Blockbench.on('render_frame', onRenderFrame);
    else groupSpinTimer = setInterval(onRenderFrame, 30);
  }
  function stopGroupSpin() {
    if (groupSpinTimer) clearInterval(groupSpinTimer);
    else if (typeof Blockbench !== 'undefined' && Blockbench.removeListener) Blockbench.removeListener('render_frame', onRenderFrame);
    groupSpinTimer = null;
    groupSpin = null;
  }

  function selectedPoseRoots() {
    if (typeof Group === 'undefined' || typeof Project === 'undefined' || !Project) return [];
    const selected = Group.multi_selected || (Group.all || []).filter((g) => g.selected);
    return selected.filter((g) => g instanceof Group && g.parent === 'root' && POSE_ROOT_PREFIX.test(g.name));
  }

  const eulerQuaternion = (r) => new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG, eulerOrder()));

  function eachDescendant(group, cb) {
    for (const child of group.children || []) {
      cb(child);
      if (child instanceof Group) eachDescendant(child, cb);
    }
  }

  // A mannequin's bones, wherever they sit in its chain: lower-case name -> group.
  function mannequinBones(root) {
    const map = new Map();
    const walk = (g, depth) => {
      for (const c of g.children || []) {
        if (!(c instanceof Group) || /^eq_/.test(c.name)) continue;
        const key = boneKey(c.name);
        if (RIG_KEYS.has(key) && !map.has(key)) map.set(key, c);
        if (depth < 8) walk(c, depth + 1);
      }
    };
    walk(root, 0);
    return map;
  }
  function mannequinBone(root, key) {
    return mannequinBones(root).get(String(key).toLowerCase()) || null;
  }
  // A mannequin's arm and hand bone (older mannequins get their hand bones when needed).
  function mannequinArm(root, armKey) {
    return mannequinBone(root, armKey);
  }
  function itemBoneOf(root, key) {
    const def = ITEM_BONES.find((b) => b.key.toLowerCase() === key.toLowerCase());
    const arm = def && mannequinArm(root, def.arm);
    return (arm && arm.children.find((g) => g instanceof Group && g.name.toLowerCase() === def.key.toLowerCase())) || null;
  }
  // Gives a mannequin the player's bone chain: a waist, the body in it, the head and arms in the
  // body, hand bones in the arms. Mannequins from older versions are rebuilt the first time they're
  // seen; every bone keeps facing the way it faced.
  function ensureRig(root) {
    if (!root || !MANNEQUIN_PREFIX.test(root.name)) return false;
    let changed = false;
    const bones = mannequinBones(root);
    const body = bones.get('body');
    if (body && !bones.get('waist')) {
      bones.set('waist', new Group({ name: 'waist', origin: [body.origin[0], body.origin[1] - 12, body.origin[2]] }).addTo(root).init());
      changed = true;
    }
    // a bone's turn relative to the mannequin (its chain of parents included)
    const turnOf = (g) => {
      const q = new THREE.Quaternion();
      const chain = [];
      for (let n = g; n && n !== root && n instanceof Group; n = n.parent) chain.unshift(n);
      for (const n of chain) q.multiply(eulerQuaternion(n.rotation));
      return q;
    };
    for (const [name, parentName] of Object.entries(RIG_PARENTS)) {
      const g = bones.get(name.toLowerCase());
      const parent = parentName ? bones.get(parentName.toLowerCase()) : root;
      if (!g || !parent || g.parent === parent) continue;
      const local = turnOf(parent).invert().multiply(turnOf(g));
      const e = new THREE.Euler().setFromQuaternion(local, eulerOrder());
      g.rotation = [round(e.x / DEG, 3), round(e.y / DEG, 3), round(e.z / DEG, 3)].map((v) => (Math.abs(v) < 1e-3 ? 0 : v));
      g.addTo(parent);
      changed = true;
    }
    for (const def of ITEM_BONES) {
      const arm = mannequinArm(root, def.arm);
      if (!arm || itemBoneOf(root, def.key)) continue;
      new Group({ name: def.key, origin: arm.origin.map((v, i) => v + def.offset[i]) }).addTo(arm).init();
      changed = true;
    }
    if (changed && Canvas.updateAll) Canvas.updateAll();
    return changed;
  }
  // How far a mannequin bone has been moved from where it sits on what holds it (Blockbench
  // space): a pose can move bones as well as turn them, and moving a bone moves what it holds.
  function boneOffset(root, key) {
    const k = String(key).toLowerCase();
    const g = mannequinBone(root, k);
    if (!g || !RIG_REST[k]) return [0, 0, 0];
    const holderKey = RIG_HOLDER[k];
    const holder = holderKey ? mannequinBone(root, holderKey) : root;
    const from = holder ? holder.origin : root.origin;
    const restFrom = holderKey ? RIG_REST[holderKey] : [0, 0, 0];
    return g.origin.map((v, i) => round(v - from[i] - (RIG_REST[k][i] - restFrom[i]), 4));
  }
  function itemOffset(root, def) {
    return boneOffset(root, def.key);
  }

  // Moves a group and everything in it (Blockbench keeps absolute coordinates on every node).
  function translateTree(group, o) {
    const add = (v) => {
      if (Array.isArray(v)) for (let i = 0; i < 3; i++) v[i] += o[i];
    };
    add(group.origin);
    eachDescendant(group, (node) => {
      if (node instanceof Group) add(node.origin);
      else {
        add(node.from);
        add(node.to);
        add(node.origin);
        add(node.position);
      }
    });
  }

  // Adds the moved nodes to the undo step Blockbench opened for the rotation, before they move,
  // so one undo puts everything back.
  function joinUndo(roots) {
    const save = typeof Undo !== 'undefined' && Undo.current_save;
    if (!save || !save.aspects) return;
    const aspects = save.aspects;
    // copies: Blockbench may have passed its live selection arrays
    aspects.groups = (aspects.groups || []).slice();
    aspects.elements = (aspects.elements || []).slice();
    save.groups = save.groups || [];
    save.elements = save.elements || {};
    for (const root of roots) {
      for (const node of [root].concat(collectDescendants(root))) {
        if (node instanceof Group) {
          if (!aspects.groups.includes(node)) {
            save.groups.push(node.getChildlessCopy(true));
            aspects.groups.push(node);
          }
        } else if (!save.elements[node.uuid]) {
          save.elements[node.uuid] = node.getUndoCopy(aspects);
          aspects.elements.push(node);
        }
      }
    }
  }
  function collectDescendants(group) {
    const out = [];
    eachDescendant(group, (node) => out.push(node));
    return out;
  }

  function checkGroupSpin() {
    if (navDrag) {
      groupSpin = null; // the camera view's buttons are moving a camera
      return;
    }
    const roots = selectedPoseRoots();
    if (roots.length < 2) {
      groupSpin = null;
      return;
    }
    const key = roots.map((g) => g.uuid).sort().join('|');
    const save = typeof Undo !== 'undefined' ? Undo.current_save : null;
    if (!groupSpin || groupSpin.key !== key) {
      groupSpin = { key, rotations: new Map(roots.map((g) => [g.uuid, g.rotation.slice()])), undoSave: null };
      return;
    }
    const changed = roots.find((g) => g.rotation.some((v, i) => Math.abs(v - groupSpin.rotations.get(g.uuid)[i]) > 1e-6));
    if (!changed) return;
    // Only while Blockbench is recording a rotation (the gizmo or a slider): undo, redo and
    // Pose Studio's own changes just update the snapshot.
    if (!save) {
      for (const g of roots) groupSpin.rotations.set(g.uuid, g.rotation.slice());
      return;
    }
    // the turn since last check, taken from the group that moved (the gizmo turns them alike)
    const delta = eulerQuaternion(changed.rotation).multiply(eulerQuaternion(groupSpin.rotations.get(changed.uuid)).invert());
    if (groupSpin.undoSave !== save) {
      joinUndo(roots);
      groupSpin.undoSave = save;
    }
    const centre = new THREE.Vector3();
    for (const g of roots) centre.add(new THREE.Vector3().fromArray(g.origin));
    centre.divideScalar(roots.length);
    for (const g of roots) {
      const at = new THREE.Vector3().fromArray(g.origin);
      const to = at.clone().sub(centre).applyQuaternion(delta).add(centre);
      if (to.distanceToSquared(at) > 1e-10) translateTree(g, to.sub(at).toArray());
      groupSpin.rotations.set(g.uuid, g.rotation.slice());
    }
    if (typeof Canvas !== 'undefined') refreshGroups(roots);
  }

  // Rotation (degrees, format Euler order) that points a camera along `dir` with no roll.
  function rotationFacing(dir) {
    const d = dir.clone().normalize();
    const yaw = Math.atan2(-d.x, -d.z);
    const pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    const e = new THREE.Euler().setFromQuaternion(q, eulerOrder());
    return [e.x, e.y, e.z].map((v) => round(v / DEG, 2));
  }

  function createCamera(pos, dir) {
    if (typeof Project === 'undefined' || !Project) newProject(Formats.free);
    const used = cameraRoots()
      .map((g) => parseInt(String(g.name).replace(CAMERA_PREFIX, ''), 10))
      .filter((n) => !isNaN(n));
    const n = used.length ? Math.max(...used) + 1 : 1;
    const [x, y, z] = pos;

    Undo.initEdit({ outliner: true, elements: [] });
    const group = new Group({ name: `cam_${n}`, origin: [x, y, z], rotation: rotationFacing(dir) }).init();
    let elements = null;
    try {
      elements = cameraSpline(group, [x, y, z]);
    } catch (e) {
      console.warn('[Pose Studio] spline camera', e);
      elements = null;
    }
    if (!elements) {
      // formats without splines: a box body and lens
      elements = [
        new Cube({ name: 'body', from: [x - 3, y - 3, z], to: [x + 3, y + 3, z + 8], color: 4 }).addTo(group).init(),
        new Cube({ name: 'lens', from: [x - 1.5, y - 1.5, z - 3], to: [x + 1.5, y + 1.5, z], color: 5 }).addTo(group).init(),
      ];
    }
    Undo.finishEdit('Add Pose Studio camera', { outliner: true, elements });
    Canvas.updateAll();
    group.select();
    return group;
  }

  // The camera drawn as lines (a spline mesh shown as a path): a body, a lens widening to a 16:9
  // frame at the eye point, and a triangle on top marking "up". Everything sits behind the eye
  // (+Z, the camera looks down -Z) so it never shows in its own camera view. Null when the
  // project's format has no splines.
  const CAMERA_LINES = (() => {
    const box = (x0, y0, z0, x1, y1, z1) => {
      const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
      return [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]].map(([a, b]) => [c[a], c[b]]);
    };
    const body = box(-3, -3, 4, 3, 3, 12);
    const small = [[-1.5, -1.5, 4], [1.5, -1.5, 4], [1.5, 1.5, 4], [-1.5, 1.5, 4]];
    const frame = [[-3.2, -1.8, 0.05], [3.2, -1.8, 0.05], [3.2, 1.8, 0.05], [-3.2, 1.8, 0.05]];
    const lens = [];
    for (let i = 0; i < 4; i++) {
      lens.push([frame[i], frame[(i + 1) % 4]], [small[i], frame[i]]);
    }
    const up = [[-1.5, 3.5, 8], [1.5, 3.5, 8], [0, 5.5, 8]];
    return body.concat(lens, [[up[0], up[1]], [up[1], up[2]], [up[2], up[0]]]);
  })();

  function cameraSpline(group, eye) {
    if (typeof SplineMesh === 'undefined' || typeof SplineHandle === 'undefined' || typeof SplineCurve === 'undefined') return null;
    if (!Format || !Format.splines) return null;
    const spline = new SplineMesh({ name: 'camera', origin: eye.slice(), vertices: {}, render_mode: 'path', color: 4 });
    // one handle per corner; straight segments keep both control points on the corner
    const handles = new Map();
    const handleAt = (p) => {
      const key = p.join(',');
      if (!handles.has(key)) {
        const [joint, control1, control2] = spline.addVertices(p, p, p);
        handles.set(key, spline.addHandles(new SplineHandle(spline, { control1, joint, control2 }))[0]);
      }
      return handles.get(key);
    };
    for (const [a, b] of CAMERA_LINES) {
      spline.addCurves(new SplineCurve(spline, { start_handle: handleAt(a), end_handle: handleAt(b) }));
    }
    spline.addTo(group).init();
    return [spline];
  }

  // The camera the game (and the POV viewport) follows: the last cam_ group you selected, until
  // you select another one or choose "Follow Viewport". Selecting a mannequin keeps it active.
  let activeCam = null;
  function activeCamera() {
    const selected = selectedCamera();
    if (selected) activeCam = selected;
    if (activeCam && (activeCam.parent !== 'root' || !Outliner.root.includes(activeCam) || !CAMERA_PREFIX.test(activeCam.name))) {
      activeCam = null; // deleted or renamed
    }
    return activeCam;
  }

  function followViewport() {
    activeCam = null;
    Blockbench.showQuickMessage('Pose Studio: game camera follows the viewport', 2000);
  }

  // ---- Camera POV viewport -------------------------------------------------------------------
  // Splits the viewport top/bottom; the bottom view is locked to the active camera every frame
  // and labelled. Optionally it takes the shape of the Minecraft window, so what you frame in
  // Blockbench is what the game (and a capture) shows.
  let povPreview = null;
  let povTimer = null;
  let povLabel = null;
  let playerHidden = false; // the player's own model is hidden in game while the camera view is on

  function setPlayerHidden(hidden) {
    playerHidden = hidden;
    if (link.connected) send(`scriptevent pose:hideplayer ${JSON.stringify({ hide: hidden })}`);
  }
  let mcWindow = null; // { width, height } of Minecraft's client area, or null if not found

  // The camera view is locked to the camera: its orbit controls are switched off entirely (their
  // update would otherwise keep applying leftover zoom/orbit from the mouse and drift the view).
  function attachPov(preview) {
    povPreview = preview || null;
    if (!povPreview) return;
    if (povPreview.setNormalCamera) povPreview.setNormalCamera();
    const controls = povPreview.controls;
    if (controls) {
      controls.enabled = false;
      if (!controls.__poseUpdate) {
        controls.__poseUpdate = controls.update;
        controls.update = () => false;
      }
    }
    povLabel = document.createElement('div');
    povLabel.className = 'pose_studio_pov_label';
    Object.assign(povLabel.style, {
      position: 'absolute', top: '8px', left: '50%', transform: 'translateX(-50%)', zIndex: 5,
      padding: '3px 10px', borderRadius: '4px', pointerEvents: 'none', whiteSpace: 'nowrap',
      background: 'rgba(0, 0, 0, 0.6)', color: '#fff', font: '600 12px sans-serif', letterSpacing: '0.02em',
    });
    povPreview.node.appendChild(povLabel);
    povNav = createPovNav(povPreview.node);
  }

  function detachPov() {
    if (povLabel) povLabel.remove();
    povLabel = null;
    if (povNav) povNav.remove();
    povNav = null;
    if (povFov) povFov.box.remove();
    povFov = null;
    removePovTimeBox();
    if (povPreview) {
      const controls = povPreview.controls;
      if (controls) {
        controls.enabled = true;
        if (controls.__poseUpdate) {
          controls.update = controls.__poseUpdate;
          delete controls.__poseUpdate;
        }
      }
      povPreview.aspect_ratio = undefined;
    }
    povPreview = null;
  }

  function setPovViewport(enabled) {
    const split = typeof Preview !== 'undefined' && Preview.split_screen;
    if (!split) return;
    if (enabled) {
      split.setMode('double_horizontal');
      setPlayerHidden(true);
      attachPov(split.previews[1]);
      applyPovAspect();
      if (!povTimer) povTimer = setInterval(updatePovViewport, 33);
    } else {
      if (povTimer) clearInterval(povTimer);
      povTimer = null;
      detachPov();
      split.setMode('single');
      setPlayerHidden(false);
    }
  }

  function applyPovAspect() {
    if (!povPreview) return;
    const ratio = targetAspect();
    if (povPreview.aspect_ratio === ratio) return;
    povPreview.aspect_ratio = ratio;
    if (povPreview.resize) povPreview.resize();
  }

  function povLabelText(cam) {
    let text = cam ? `CAMERA VIEW · ${cam.name}` : 'CAMERA VIEW · no camera (select a cam_ group)';
    const preset = aspectPreset();
    if (preset && preset.ratio) {
      text += ` · ${preset.id}`;
      if (mcWindow && Math.abs(mcWindow.width / mcWindow.height - preset.ratio) > 0.01) {
        text += ` · Minecraft is ${mcWindow.width}×${mcWindow.height}, not ${preset.id} (fullscreen? press F11 and pick the ratio again)`;
      }
    } else if (aspectMode === 'window') {
      text += mcWindow ? ` · Minecraft ${mcWindow.width}×${mcWindow.height}` : ' · Minecraft window not found (16:9)';
    }
    return text;
  }

  // Switching projects (going to another location opens its project) makes Blockbench restore each
  // view's saved state and can leave the camera view drawn at a stale size, or with a stale aspect
  // or zoom: the picture is then cropped and looks far more zoomed in than Minecraft. Put it right.
  function checkPovProjection() {
    const pv = povPreview;
    if (pv.isOrtho && pv.setProjectionMode) pv.setProjectionMode(false);
    const pers = pv.camPers || pv.camera;
    let fix = false;
    if (pers.zoom !== undefined && pers.zoom !== 1) {
      pers.zoom = 1;
      fix = true;
    }
    if (pers.view && pers.clearViewOffset) {
      pers.clearViewOffset();
      fix = true;
    }
    const parent = pv.node && pv.node.parentElement;
    if (parent && parent.clientWidth && parent.clientHeight && pv.resize) {
      let w = parent.clientWidth;
      let h = parent.clientHeight;
      if (pv.aspect_ratio && Math.abs(w / h - pv.aspect_ratio) > 0.02) {
        if (w / h < pv.aspect_ratio) h = w / pv.aspect_ratio;
        else w = h * pv.aspect_ratio;
      }
      const sized = Math.abs(pv.width - w) < 2 && Math.abs(pv.height - h) < 2;
      const shaped = pv.height > 0 && Math.abs(pers.aspect - pv.width / pv.height) < 0.01;
      const canvas = pv.canvas;
      const drawn = !canvas || !canvas.clientWidth || (Math.abs(canvas.clientWidth - pv.width) < 2 && Math.abs(canvas.clientHeight - pv.height) < 2);
      if (!sized || !shaped || !drawn) {
        pv.resize();
        fix = false; // resize rebuilt the projection
      }
    }
    if (fix && pers.updateProjectionMatrix) pers.updateProjectionMatrix();
  }

  function updatePovViewport() {
    // Blockbench can rebuild its split views (switching tabs, for one): take over the new one
    const split = typeof Preview !== 'undefined' && Preview.split_screen;
    if (povTimer && split && split.previews && split.previews[1] && split.previews[1] !== povPreview) {
      detachPov();
      attachPov(split.previews[1]);
      applyPovAspect();
    }
    if (!povPreview || !povPreview.camera || typeof Project === 'undefined' || !Project) return;
    checkPovProjection();
    const cam = activeCamera();
    syncPovFovSlider();
    if (povLabel) {
      const text = povLabelText(cam);
      if (povLabel.textContent !== text) povLabel.textContent = text;
    }
    if (!cam) return;
    const space = modelSpace();
    const pos = new THREE.Vector3().fromArray(cam.origin);
    const target = pos.clone().add(cameraForward(cam).multiplyScalar(32));
    if (space) {
      space.localToWorld(pos);
      space.localToWorld(target);
    }
    povPreview.camera.position.copy(pos);
    povPreview.controls.target.copy(target);
    povPreview.camera.lookAt(target);
    const fov = cam.pose_fov || mainViewportFov();
    if (povPreview.camera.fov !== fov && povPreview.setFOV) povPreview.setFOV(fov);
  }

  // ---- Camera view navigation ----------------------------------------------------------------
  // Three drag buttons down the camera view's left side, like Cinema 4D's: the hand moves the camera
  // sideways and up/down, the arrows move it forward/back, the circle orbits it around what it's
  // looking at (Shift: turns it on the spot). Each drag is one undo step.
  const NAV_BUTTONS = [
    { mode: 'pan', icon: 'pan_tool', title: 'Move the camera left/right/up/down (drag)' },
    { mode: 'dolly', icon: 'height', title: 'Move the camera forward/back (drag up/down)' },
    { mode: 'orbit', icon: 'autorenew', title: 'Orbit the camera around what it looks at (drag). Hold Shift to turn it on the spot' },
  ];
  const NAV_DEFAULT_DISTANCE = 48; // 3 blocks, when nothing is in front of the camera
  let povNav = null;
  let navDrag = null;

  function createPovNav(node) {
    const bar = document.createElement('div');
    bar.className = 'pose_studio_pov_nav';
    Object.assign(bar.style, {
      position: 'absolute', top: '36px', left: '8px', zIndex: 6, display: 'flex', flexDirection: 'column', gap: '2px', padding: '2px',
      borderRadius: '6px', background: 'rgba(0, 0, 0, 0.55)',
    });
    for (const b of NAV_BUTTONS) {
      const button = document.createElement('div');
      button.title = b.title;
      Object.assign(button.style, {
        width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#fff', borderRadius: '4px', cursor: 'grab', userSelect: 'none', touchAction: 'none',
      });
      button.innerHTML = `<i class="material-icons" style="font-size: 20px; pointer-events: none;">${b.icon}</i>`;
      button.addEventListener('pointerenter', () => (button.style.background = 'rgba(255, 255, 255, 0.18)'));
      button.addEventListener('pointerleave', () => {
        if (!navDrag || navDrag.button !== button) button.style.background = '';
      });
      button.addEventListener('pointerdown', (e) => startNavDrag(b.mode, e, button));
      bar.appendChild(button);
    }
    node.appendChild(bar);
    createPovFovSlider(node);
    createPovTimeBox(node);
    return bar;
  }

  // FOV slider along the camera view's bottom-left corner, for the active camera.
  let povFov = null; // { box, input, label }
  function createPovFovSlider(node) {
    const box = document.createElement('div');
    box.className = 'pose_studio_pov_fov';
    Object.assign(box.style, {
      position: 'absolute', bottom: '8px', left: '8px', zIndex: 6, display: 'flex', alignItems: 'center', gap: '6px',
      padding: '3px 8px', borderRadius: '6px', background: 'rgba(0, 0, 0, 0.55)', color: '#fff', font: '600 12px sans-serif',
    });
    const label = document.createElement('span');
    label.style.minWidth = '64px';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '30';
    input.max = '110';
    input.step = '1';
    input.title = 'Field of view of the camera (degrees)';
    input.style.width = '140px';
    input.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      povFov.dragging = true;
    });
    input.addEventListener('change', () => (povFov.dragging = false));
    input.addEventListener('input', () => {
      const cam = activeCamera();
      if (!cam) return;
      const fov = Number(input.value);
      applyFov(cam, fov);
      label.textContent = `FOV ${fov}°`;
      updatePovViewport();
    });
    box.appendChild(label);
    box.appendChild(input);
    node.appendChild(box);
    povFov = { box, input, label, dragging: false };
    syncPovFovSlider();
  }

  // Keeps the slider on the active camera's value (unless it's being dragged).
  function syncPovFovSlider() {
    if (!povFov) return;
    const cam = activeCamera();
    povFov.box.style.opacity = cam ? '1' : '0.5';
    povFov.input.disabled = !cam;
    const fov = Math.round((cam && cam.pose_fov) || mainViewportFov());
    if (povFov.dragging) return;
    if (String(povFov.input.value) !== String(fov)) povFov.input.value = String(fov);
    const text = `FOV ${fov}°`;
    if (povFov.label.textContent !== text) povFov.label.textContent = text;
  }

  const camQuaternion = (cam) => eulerQuaternion(cam.rotation);

  // How far ahead the orbit pivot is: the nearest mannequin or entity roughly in view, else 3 blocks.
  function orbitDistance(cam) {
    const pos = new THREE.Vector3().fromArray(cam.origin);
    const forward = cameraForward(cam);
    let best = null;
    for (const g of Outliner.root) {
      if (!(g instanceof Group) || !/^(player_|mq_|ent_)/i.test(g.name)) continue;
      const to = new THREE.Vector3().fromArray(g.origin).add(new THREE.Vector3(0, 16, 0)).sub(pos);
      const along = to.dot(forward);
      if (along < 4 || to.angleTo(forward) > 0.6) continue;
      if (best === null || along < best) best = along;
    }
    return best || NAV_DEFAULT_DISTANCE;
  }

  function refreshGroups(groups) {
    if (Canvas.updateView) Canvas.updateView({ groups, group_aspects: { transform: true } });
    else Canvas.updateAll();
  }

  function startNavDrag(mode, e, button) {
    const cam = activeCamera();
    if (!cam) {
      Blockbench.showQuickMessage('Add or select a camera first', 2000);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    try {
      button.setPointerCapture(e.pointerId);
    } catch (err) {
      // pointer capture unavailable
    }
    const nodes = [cam].concat(collectDescendants(cam));
    Undo.initEdit({ groups: nodes.filter((n) => n instanceof Group), elements: nodes.filter((n) => !(n instanceof Group)) });
    const distance = orbitDistance(cam);
    navDrag = {
      mode, cam, button, distance, moved: false, x: e.clientX, y: e.clientY,
      pivot: new THREE.Vector3().fromArray(cam.origin).add(cameraForward(cam).multiplyScalar(distance)),
    };
    button.style.background = 'rgba(255, 255, 255, 0.3)';
    button.style.cursor = 'grabbing';
    const move = (ev) => navMove(ev);
    const up = () => {
      button.removeEventListener('pointermove', move);
      button.removeEventListener('pointerup', up);
      button.removeEventListener('pointercancel', up);
      button.style.background = '';
      button.style.cursor = 'grab';
      const drag = navDrag;
      navDrag = null;
      if (drag && drag.moved) {
        Undo.finishEdit(`Camera ${drag.mode}`);
        if (typeof updateSelection === 'function') updateSelection();
      } else if (Undo.cancelEdit) Undo.cancelEdit();
    };
    button.addEventListener('pointermove', move);
    button.addEventListener('pointerup', up);
    button.addEventListener('pointercancel', up);
  }

  function navMove(e) {
    const drag = navDrag;
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!dx && !dy) return;
    const cam = drag.cam;
    const q = camQuaternion(cam);
    const pos = new THREE.Vector3().fromArray(cam.origin);
    let next = pos.clone();
    let turn = null;
    if (drag.mode === 'pan') {
      // grab the scene: the camera moves the opposite way to the mouse
      const scale = Math.max(drag.distance, 8) * 0.004;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const upAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      next.add(right.multiplyScalar(-dx * scale)).add(upAxis.multiplyScalar(dy * scale));
    } else if (drag.mode === 'dolly') {
      const step = Math.max(drag.distance, 8) * 0.01;
      next.add(cameraForward(cam).multiplyScalar(-dy * step));
    } else {
      // yaw around the world's up axis, pitch around the camera's own right axis
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      turn = new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dx * 0.3 * DEG)
        .multiply(new THREE.Quaternion().setFromAxisAngle(right, -dy * 0.3 * DEG));
      const pivot = e.shiftKey ? pos : drag.pivot;
      next = pos.clone().sub(pivot).applyQuaternion(turn).add(pivot);
    }
    const offset = next.clone().sub(pos);
    if (offset.lengthSq() > 1e-12) translateTree(cam, offset.toArray());
    if (drag.mode !== 'orbit') drag.pivot.add(offset);
    else if (e.shiftKey) drag.pivot.sub(pos).applyQuaternion(turn).add(pos);
    if (turn) {
      const e2 = new THREE.Euler().setFromQuaternion(turn.clone().multiply(q), eulerOrder());
      [e2.x, e2.y, e2.z].forEach((v, i) => (cam.rotation[i] = round(v / DEG, 3)));
    }
    drag.moved = true;
    refreshGroups([cam]);
    updatePovViewport();
  }

  // Watches the Minecraft window's client size with one long-running PowerShell process that
  // prints "width height" (or "none") every second. It exits when Blockbench goes away.
  const WINDOW_WATCH_PS1 = String.raw`$ProgressPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PoseStudioWatch {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[PoseStudioWatch]::SetProcessDPIAware() | Out-Null
$parentId = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
while ($true) {
  if (-not (Get-Process -Id $parentId -ErrorAction SilentlyContinue)) { exit }
  $proc = Get-Process | Where-Object { $_.ProcessName -like 'Minecraft.Windows*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  $line = 'none'
  if ($proc -and -not [PoseStudioWatch]::IsIconic($proc.MainWindowHandle)) {
    $rect = New-Object PoseStudioWatch+RECT
    if ([PoseStudioWatch]::GetClientRect($proc.MainWindowHandle, [ref]$rect)) {
      $w = $rect.R - $rect.L; $h = $rect.B - $rect.T
      if ($w -gt 0 -and $h -gt 0) { $line = "$w $h" }
    }
  }
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1000
}
`;
  let windowWatcher = null;

  function startWindowWatch() {
    if (windowWatcher) return;
    const childProcess = nodeRequire('child_process', 'watch the Minecraft window size');
    if (!childProcess) return;
    const encoded = bufferClass().from(WINDOW_WATCH_PS1, 'utf16le').toString('base64');
    windowWatcher = childProcess.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
    });
    let buffered = '';
    windowWatcher.stdout.on('data', (chunk) => {
      buffered += chunk.toString();
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop();
      const last = lines.filter(Boolean).pop();
      if (!last) return;
      const m = last.match(/^(\d+) (\d+)$/);
      const next = m ? { width: Number(m[1]), height: Number(m[2]) } : null;
      if (JSON.stringify(next) === JSON.stringify(mcWindow)) return;
      mcWindow = next;
      applyPovAspect();
    });
    windowWatcher.on('exit', () => {
      windowWatcher = null;
    });
  }

  function stopWindowWatch() {
    if (windowWatcher) windowWatcher.kill();
    windowWatcher = null;
    mcWindow = null;
  }


  // ---- Camera aspect ratio -------------------------------------------------------------------
  // 'fill' = the camera view fills its half; 'window' = it follows the Minecraft window's shape;
  // a fixed ratio also resizes the Minecraft window to that shape (as large as fits its monitor).
  const ASPECT_PRESETS = [
    { id: 'fill', name: 'Fill View' },
    { id: 'window', name: 'Match Minecraft Window' },
    '_',
    { id: '16:9', name: '16:9 Widescreen', ratio: 16 / 9 },
    { id: '21:9', name: '21:9 Ultrawide', ratio: 21 / 9 },
    { id: '3:2', name: '3:2', ratio: 3 / 2 },
    { id: '4:3', name: '4:3', ratio: 4 / 3 },
    { id: '1:1', name: '1:1 Square', ratio: 1 },
    { id: '4:5', name: '4:5 Portrait', ratio: 4 / 5 },
    { id: '9:16', name: '9:16 Vertical', ratio: 9 / 16 },
  ];
  let aspectMode = 'fill';

  function aspectPreset(id = aspectMode) {
    return ASPECT_PRESETS.find((p) => p !== '_' && p.id === id);
  }

  function aspectMenuItems() {
    return ASPECT_PRESETS.map((p) =>
      p === '_'
        ? '_'
        : {
            name: p.name,
            id: `pose_studio_aspect_${p.id.replace(':', '_')}`,
            icon: aspectMode === p.id ? 'radio_button_checked' : 'radio_button_unchecked',
            description: p.ratio ? 'Resizes the Minecraft window to this shape and frames the camera view to match.' : undefined,
            click: () => setAspectMode(p.id),
          }
    );
  }

  function setAspectMode(id) {
    const preset = aspectPreset(id);
    if (!preset) return;
    aspectMode = id;
    if (id === 'fill') stopWindowWatch();
    else startWindowWatch();
    if (preset.ratio) resizeMinecraftWindow(preset);
    applyPovAspect();
  }

  function targetAspect() {
    const preset = aspectPreset();
    if (!preset || preset.id === 'fill') return undefined;
    if (preset.ratio) return preset.ratio;
    return mcWindow ? mcWindow.width / mcWindow.height : 16 / 9;
  }

  // Resizes Minecraft's window so its game area has the given aspect ratio, as large as fits the
  // work area of the monitor it's on, and centres it there.
  const RESIZE_PS1 = String.raw`$ProgressPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PoseStudioResize {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO info);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public uint Flags; }
}
"@
[PoseStudioResize]::SetProcessDPIAware() | Out-Null
$proc = Get-Process | Where-Object { $_.ProcessName -like $NamePattern -and $_.MainWindowHandle -ne 0 -and ($TitlePattern -eq '' -or $_.MainWindowTitle -like $TitlePattern) } | Select-Object -First 1
if (-not $proc) { [Console]::Error.WriteLine('Minecraft window not found'); exit 2 }
$h = $proc.MainWindowHandle
if ([PoseStudioResize]::IsIconic($h) -or [PoseStudioResize]::IsZoomed($h)) { [PoseStudioResize]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 250 }
$wr = New-Object PoseStudioResize+RECT; [PoseStudioResize]::GetWindowRect($h, [ref]$wr) | Out-Null
$cr = New-Object PoseStudioResize+RECT; [PoseStudioResize]::GetClientRect($h, [ref]$cr) | Out-Null
$borderW = ($wr.R - $wr.L) - ($cr.R - $cr.L)
$borderH = ($wr.B - $wr.T) - ($cr.B - $cr.T)
$info = New-Object PoseStudioResize+MONITORINFO
$info.Size = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
[PoseStudioResize]::GetMonitorInfo([PoseStudioResize]::MonitorFromWindow($h, 2), [ref]$info) | Out-Null
$workW = $info.Work.R - $info.Work.L
$workH = $info.Work.B - $info.Work.T
$availW = $workW - $borderW
$availH = $workH - $borderH
if ($availW / $availH -gt $Ratio) { $ch = $availH; $cw = [int][Math]::Round($ch * $Ratio) } else { $cw = $availW; $ch = [int][Math]::Round($cw / $Ratio) }
$ww = $cw + $borderW
$wh = $ch + $borderH
$x = $info.Work.L + [int](($workW - $ww) / 2)
$y = $info.Work.T + [int](($workH - $wh) / 2)
[PoseStudioResize]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, $ww, $wh, 0x0014) | Out-Null
Start-Sleep -Milliseconds 300
[PoseStudioResize]::GetClientRect($h, [ref]$cr) | Out-Null
Write-Output "$($cr.R - $cr.L) $($cr.B - $cr.T)"
`;

  // `target` lets tests point this at a harmless window instead of Minecraft.
  function resizeMinecraftWindow(preset, target = { name: 'Minecraft.Windows*', title: '' }) {
    const childProcess = nodeRequire('child_process', 'resize the Minecraft window');
    if (!childProcess) return Promise.resolve(null);
    const quote = (v) => `'${String(v).replace(/'/g, "''")}'`;
    const script =
      `$Ratio = ${preset.ratio}\n$NamePattern = ${quote(target.name)}\n$TitlePattern = ${quote(target.title)}\n` + RESIZE_PS1;
    const encoded = bufferClass().from(script, 'utf16le').toString('base64');
    return new Promise((resolve) => {
      childProcess.execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true },
        (err, stdout, stderr) => {
          const m = String(stdout).match(/(\d+) (\d+)/);
          if (err || !m) {
            Blockbench.showQuickMessage(`Pose Studio: couldn't resize Minecraft (${String(stderr || (err && err.message) || 'no window').trim()})`, 3000);
            return resolve(null);
          }
          const size = { width: Number(m[1]), height: Number(m[2]) };
          Blockbench.showQuickMessage(`Pose Studio: Minecraft resized to ${size.width}×${size.height} (${preset.id})`, 2500);
          resolve(size);
        }
      );
    });
  }

  function mainViewportFov() {
    const preview = viewportPreview();
    return (preview && preview.camera && preview.camera.fov) || 70;
  }

  function viewportPreview() {
    if (typeof Preview === 'undefined') return null;
    if (Preview.selected && Preview.selected !== povPreview) return Preview.selected;
    const all = (Preview.split_screen && Preview.split_screen.previews) || Preview.all || [];
    return all.find((p) => p && p !== povPreview) || null;
  }


  function modelSpace() {
    return (Project && Project.model_3d) || (Canvas && Canvas.scene) || null;
  }

  // ---- Scene -> game sync --------------------------------------------------------------------
  const lastSent = new Map(); // mannequin id -> last JSON sent
  let lastCamera = null;
  let lastProjectUuid = null;
  let cameraSync = false;
  let lastErrorLog = 0;
  let tickTimer = null;

  function logFailure(e) {
    const now = Date.now();
    if (now - lastErrorLog > 2000) console.warn('[Pose Studio]', e.message || e);
    lastErrorLog = now;
  }

  // Minecraft can drop the whole world on long commands, so nothing over MAX_COMMAND is sent.
  const MAX_COMMAND = 400;
  let warnedLong = false;
  function send(commandLine) {
    if (commandLine.length > MAX_COMMAND) {
      console.warn(`[Pose Studio] not sent (${commandLine.length} characters): ${commandLine.slice(0, 80)}…`);
      if (!warnedLong) Blockbench.showQuickMessage('Pose Studio: an update was too long to send to Minecraft safely and was skipped', 3000);
      warnedLong = true;
      return;
    }
    link.command(commandLine).catch(logFailure);
  }

  function mannequinRoots() {
    if (typeof Project === 'undefined' || !Project) return [];
    return Outliner.root.filter((node) => node instanceof Group && MANNEQUIN_PREFIX.test(node.name));
  }

  const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const code12 = (n) => CODE_CHARS[(n >> 6) & 63] + CODE_CHARS[n & 63];
  const encodeAngle12 = (deg) => ((Math.round((wrap(deg) + 180) * 4096 / 360) % 4096) + 4096) % 4096;
  const encodeOffset12 = (u) => Math.max(0, Math.min(4095, Math.round((Number(u) || 0) * 64) + 2048));

  function poseMessage(root) {
    ensureRig(root);
    const bones = Object.fromEntries(mannequinBones(root));
    const turns = toBedrockRot(root.rotation);
    const moves = [];
    for (const key of SENT_TURNS) {
      const g = bones[key.toLowerCase()];
      turns.push(...(g ? toBedrockRot(g.rotation) : [0, 0, 0]));
      const o = g ? boneOffset(root, key) : [0, 0, 0];
      moves.push(round(-o[0], 3), round(o[1], 3), round(o[2], 3));
    }
    // two characters per value keeps the command short: 12-bit turns (360/4096 steps) then moves
    // (1/64 pixel steps, ±32 pixels)
    const vars = ownerVariables(root);
    const extra = OWNER_VARIABLES.map((name) => encodeAngle12(Math.max(-180, Math.min(180, Number(vars[name]) || 0))));
    const code = turns.map(encodeAngle12).concat(moves.map(encodeOffset12)).map(code12).join('') + extra.map(code12).join('');
    return JSON.stringify({ id: mannequinId(root.name), p: toWorld(root.origin), q: code, s: root.pose_skin_slot || 0, sl: root.pose_slim ? 1 : 0 });
  }

  // The game camera follows the selected cam_ group, or the Blockbench viewport if none is selected.
  function cameraMessage() {
    const preview = viewportPreview();
    const fov = preview && !preview.isOrtho && preview.camera && preview.camera.fov ? round(preview.camera.fov, 1) : undefined;
    const cam = activeCamera();
    if (cam) {
      const origin = new THREE.Vector3().fromArray(cam.origin);
      const target = origin.clone().add(cameraForward(cam).multiplyScalar(160));
      return JSON.stringify({ p: toWorld(origin.toArray()), t: toWorld(target.toArray()), f: cam.pose_fov || fov });
    }
    if (!preview || !preview.camera || !preview.controls) return null;
    const space = modelSpace();
    const pos = preview.camera.position.clone();
    const target = preview.controls.target.clone();
    if (space) {
      space.worldToLocal(pos);
      space.worldToLocal(target);
    }
    const msg = { p: toWorld(pos.toArray()), t: toWorld(target.toArray()) };
    if (!preview.isOrtho && preview.camera.fov) msg.f = round(preview.camera.fov, 1);
    return JSON.stringify(msg);
  }

  function tick() {
    if (!link.connected || typeof Project === 'undefined' || !Project) return;

    // Switching tabs shouldn't delete the other project's mannequins from the world.
    if (Project.uuid !== lastProjectUuid) {
      lastProjectUuid = Project.uuid;
      lastSent.clear();
      lastCamera = null;
      // a location of this world: nothing goes out until its anchor is in place (positions are
      // relative to it), see onProjectSelected
      const l = Project.pose_world;
      if (l && connectedWorld && l.id === connectedWorld.id) holdUpdates(10000);
    }
    if (Date.now() < holdUntil) return;

    const seen = new Set();
    for (const root of mannequinRoots()) {
      const id = mannequinId(root.name);
      if (seen.has(id)) continue;
      seen.add(id);
      const msg = poseMessage(root);
      if (lastSent.get(id) === msg) continue;
      if (link.inFlight >= MAX_IN_FLIGHT) return; // retry next tick with the newest state
      send(`scriptevent pose:set ${msg}`);
      lastSent.set(id, msg);
    }
    // equipment goes separately and only when it changes (a pose plus a full set of pack items
    // would make one command too long); Minecraft remembers it per mannequin
    for (const root of mannequinRoots()) {
      const id = mannequinId(root.name);
      const msg = JSON.stringify({ id, e: root.pose_equipment || {} });
      if (lastSent.get(`${id}#eq`) === msg) continue;
      if (link.inFlight >= MAX_IN_FLIGHT) return;
      send(`scriptevent pose:eq ${msg}`);
      lastSent.set(`${id}#eq`, msg);
    }
    for (const root of entityRoots()) {
      const id = mannequinId(root.name);
      if (seen.has(id)) continue;
      seen.add(id);
      const msg = entityMessage(root);
      if (!msg) continue;
      if (lastSent.get(id) !== msg) {
        if (link.inFlight >= MAX_IN_FLIGHT) return;
        send(`scriptevent pose:ent ${msg}`);
        lastSent.set(id, msg);
      }
      for (const side of ['main', 'off']) {
        const key = `${id}__${side}`;
        seen.add(key);
        const hand = entityHeldItems ? handMessage(root, side) : JSON.stringify({ id, s: side });
        if (lastSent.get(key) === hand) continue;
        if (link.inFlight >= MAX_IN_FLIGHT) return;
        send(`scriptevent pose:hold ${hand}`);
        lastSent.set(key, hand);
      }
    }
    for (const id of Array.from(lastSent.keys())) {
      if (seen.has(id)) continue;
      send(`scriptevent pose:remove ${JSON.stringify({ id })}`);
      lastSent.delete(id);
    }

    if (cameraSync && link.inFlight < MAX_IN_FLIGHT) {
      const cam = cameraMessage();
      if (cam && cam !== lastCamera) {
        send(`scriptevent pose:cam ${cam}`);
        lastCamera = cam;
      }
    }
  }

  function resync() {
    lastSent.clear();
    lastCamera = null;
  }

  // While a location is being put in place (anchor, teleport), updates wait; at most `ms`.
  let holdUntil = 0;
  function holdUpdates(ms) {
    holdUntil = Date.now() + ms;
  }
  function releaseUpdates() {
    holdUntil = 0;
    resync();
  }

  // ---- Actions -------------------------------------------------------------------------------
  function requireConnection() {
    if (link.connected) return true;
    Blockbench.showMessageBox({
      title: 'Pose Studio',
      message: `Minecraft isn't connected yet.\n\nTurn on Pose Studio → Connect to Minecraft, then in Minecraft chat type:\n/connect 127.0.0.1:${PORT}`,
    });
    return false;
  }

  function startLink() {
    try {
      link.start();
    } catch (e) {
      Blockbench.showMessageBox({ title: 'Pose Studio', message: `Could not start the Minecraft link: ${e.message || e}` });
      return false;
    }
    link.onConnect = () => {
      resync();
      if (playerHidden) setPlayerHidden(true);
      // match the open scene with the world first; an empty scene is only centred on the player
      // when the world has no scene of its own
      // a saved location waits until its anchor is in place (an unlinked scene has nothing to wait for)
      if (projectLink()) holdUpdates(30000);
      setTimeout(async () => {
        await freezeWorldClock().catch(() => {});
        await checkWorldScene().catch(() => {});
        await autoAnchor();
        releaseUpdates();
      }, 1000);
    };
    if (!tickTimer) tickTimer = setInterval(tick, TICK_MS);
    const command = `/connect 127.0.0.1:${PORT}`;
    const noPacks = !!installedPacks().missing;
    Blockbench.showMessageBox(
      {
        title: 'Pose Studio',
        message:
          `Listening on 127.0.0.1:${PORT}.\n\nIn Minecraft (cheats on), open chat and run:\n` +
          `${command}\n\nAn empty scene is centred on wherever you're standing in Minecraft.` +
          (noPacks ? "\n\nThe Pose Studio Minecraft packs aren't installed on this PC yet: Install Packs downloads them, then add them to the world (Edit World > Behavior Packs and Resource Packs)." : ''),
        buttons: noPacks ? ['Copy Command', 'Install Packs', 'OK'] : ['Copy Command', 'OK'],
        confirm: 0,
        cancel: noPacks ? 2 : 1,
      },
      (button) => {
        if (button === 0) copyText(command);
        if (noPacks && button === 1) installPacksNow();
      }
    );
    return true;
  }

  function copyText(text) {
    try {
      if (typeof Clipbench !== 'undefined' && Clipbench.setText) Clipbench.setText(text);
      else navigator.clipboard.writeText(text);
      Blockbench.showQuickMessage('Copied: paste it into Minecraft chat (Ctrl+V)', 2500);
    } catch (e) {
      showError('Pose Studio: copying the command', e);
    }
  }

  // ---- Placement ----
  // New mannequins and entities go where the viewport is looking: the scanned terrain in the
  // middle of the view if there is a scan, otherwise the point the view orbits around. They turn
  // to face the camera.
  function placement() {
    const preview = viewportPreview();
    if (!preview || !preview.camera || !preview.controls) return { origin: [0, 0, 0], yaw: 0 };
    const space = modelSpace();
    const toLocal = (v) => (space ? space.worldToLocal(v.clone()) : v.clone());
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), preview.camera);
    const hits = [];
    for (const el of Project.elements || []) {
      if (el.name !== WORLD_GROUP || !el.mesh || !el.mesh.isMesh) continue;
      el.mesh.updateMatrixWorld(true);
      // the scan ignores clicks (see disableWorldPicking), so call three's raycast directly
      THREE.Mesh.prototype.raycast.call(el.mesh, raycaster, hits);
    }
    hits.sort((a, b) => a.distance - b.distance);
    const point = hits.length ? toLocal(hits[0].point) : toLocal(preview.controls.target);
    const cam = toLocal(preview.camera.position);
    const yaw = Math.atan2(-(cam.x - point.x), -(cam.z - point.z)) / DEG;
    return { origin: [Math.round(point.x), Math.round(point.y), Math.round(point.z)], yaw: round(yaw, 1) };
  }

  // The anchor (the world block Blockbench's origin sits on) is set automatically: whenever the
  // scene is empty, connecting, scanning or grabbing a camera centres it on the player.
  function sceneIsEmpty() {
    if (typeof Project === 'undefined' || !Project) return true;
    const scan = (Project.elements || []).some((el) => el.name === WORLD_GROUP);
    return !scan && !mannequinRoots().length && !entityRoots().length && !cameraRoots().length;
  }

  async function autoAnchor() {
    if (!link.connected || !sceneIsEmpty()) return;
    // a world with a scene keeps that scene's anchor
    if (connectedWorld && connectedWorld.locations && connectedWorld.locations.length) return;
    if (typeof Project !== 'undefined' && Project && Project.pose_world && Project.pose_world.anchor) return;
    await link.command('scriptevent pose:anchor').catch(logFailure);
    resync();
  }

  function addMannequin() {
    if (typeof Project === 'undefined' || !Project) newProject(Formats.free);

    const used = mannequinRoots()
      .map((g) => parseInt(String(g.name).replace(MANNEQUIN_PREFIX, ''), 10))
      .filter((n) => !isNaN(n));
    const n = used.length ? Math.max(...used) + 1 : 1;
    const { origin, yaw } = placement();
    const shift = (v) => [v[0] + origin[0], v[1] + origin[1], v[2] + origin[2]];

    Undo.initEdit({ outliner: true, elements: [] });
    const root = new Group({ name: `Player_${n}`, origin: origin.slice(), rotation: [0, yaw, 0] }).init();
    const cubes = [];
    for (const bone of BONES) {
      const group = new Group({ name: bone.key, origin: shift(bone.pivot) }).addTo(root).init();
      const cube = new Cube({ name: bone.key, from: shift(bone.from), to: shift(bone.to), color: bone.color })
        .addTo(group)
        .init();
      cubes.push(cube);
    }
    ensureRig(root);
    Undo.finishEdit('Add Pose Studio mannequin', { outliner: true, elements: cubes });
    Canvas.updateAll();
    root.select();
  }

  function setAnchor() {
    if (!requireConnection()) return;
    link
      .command('scriptevent pose:anchor')
      .then(async () => {
        resync();
        // the scene now lives here: remember it (Save Scene keeps it in the file)
        const fresh = await readWorldScene().catch(() => null);
        if (fresh && connectedWorld) connectedWorld.anchor = fresh.anchor;
        if (fresh && typeof Project !== 'undefined' && Project && Project.pose_world && Project.pose_world.id === fresh.id) {
          Project.pose_world = Object.assign({}, Project.pose_world, { anchor: fresh.anchor });
          tellWorldLocation();
          ensureTickingArea().catch(() => {});
        }
      })
      .catch(logFailure);
  }

  function setCameraSync(value) {
    cameraSync = value;
    lastCamera = null;
    // what the game shows is the Minecraft window, so the camera view takes its shape (unless a
    // shape was already picked)
    if (value && aspectMode === 'fill') setAspectMode('window');
    if (!value && link.connected) send('scriptevent pose:camclear');
  }

  async function stopLink() {
    if (!link.server && !link.socket) return;
    // Give the player their model and camera back before the socket goes away.
    if (playerHidden && link.connected) await link.command('scriptevent pose:hideplayer {"hide":false}').catch(logFailure);
    if (cameraSync && link.connected) await link.command('scriptevent pose:camclear').catch(logFailure);
    await unfreezeWorldClock().catch(() => {});
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    link.onConnect = null;
    connectedWorld = null;
    tickingAreas.clear();
    link.stop();
    resync();
    if (cameraSync && cameraToggle) cameraToggle.set(false);
    Blockbench.showQuickMessage('Pose Studio: Minecraft link stopped', 2000);
  }

  // Shows what the plugin sees and what it last sent, to compare with /scriptevent pose:debug.
  async function showDebug() {
    const lines = [
      `Link: ${link.server ? 'listening' : 'stopped'}, Minecraft ${link.connected ? 'connected' : 'not connected'}, ${link.inFlight} commands awaiting reply`,
      `Project: ${typeof Project !== 'undefined' && Project ? (Project.format && Project.format.id) || '?' : 'none'}`,
    ];
    // where the open location is, where Minecraft's anchor is, and where the player stands
    const fmt = (a) => (a ? `${round(a.x, 1)} ${round(a.y, 1)} ${round(a.z, 1)}${a.dim ? ' (' + String(a.dim).replace('minecraft:', '') + ')' : ''}` : 'not set');
    const linkInfo = projectLink();
    const world = link.connected ? await readWorldScene().catch(() => null) : null;
    lines.push('', `Location: ${linkInfo ? `${linkInfo.locName || 'Main'} (id ${linkInfo.loc || 'main'}) in ${linkInfo.name || '?'}` : 'this scene is not a saved location'}`);
    if (linkInfo) lines.push(`  saved at: ${fmt(linkInfo.anchor)}`);
    if (world) {
      const matches = linkInfo && linkInfo.anchor && world.anchor ? (sameAnchor(linkInfo.anchor, world.anchor) ? ' (matches)' : ' (DIFFERENT)') : '';
      lines.push(`  Minecraft anchor now: ${fmt(world.anchor)}${matches}`);
      lines.push(`  you are at: ${fmt(world.player)}${world.player && world.anchor ? `, ${Math.round(distanceTo(world.player, world.anchor))} blocks from the anchor` : ''}`);
      const otherWorld = linkInfo && linkInfo.id !== world.id ? ` (NOT the world this scene belongs to: ${linkInfo.id})` : '';
      lines.push(`  world ${world.id}${otherWorld}, pack protocol ${world.protocol} (plugin expects ${EXPECTED_PACK_PROTOCOL})`);
      lines.push(`  locations: ${(world.locations || []).map((l) => `${l.name} @ ${fmt(l.anchor)}`).join('; ') || 'none'}`);
      lines.push(`  in-game ids here: ${mannequinRoots().concat(entityRoots()).map((r) => mannequinId(r.name)).join(', ') || 'none'}`);
      send('scriptevent pose:debug');
      lines.push('  (Minecraft also lists its Pose Studio entities and where they are in chat.)');
    }
    const roots = mannequinRoots();
    if (!roots.length) lines.push('No top-level groups named Player_… found.');
    for (const root of roots) {
      const bones = [...mannequinBones(root).values()].map((g) => `${g.name} [${g.rotation.map((v) => round(v, 1)).join(', ')}]`);
      lines.push('', `${root.name}: origin [${root.origin.join(', ')}], rotation [${root.rotation.map((v) => round(v, 1)).join(', ')}]`);
      lines.push(`  bones: ${bones.join('; ') || 'none'}`);
      lines.push(`  last sent: ${lastSent.get(mannequinId(root.name)) || 'nothing yet'}`);
    }
    // Entity copies: the hand messages (only sent while Held Items on Entities is on)
    for (const root of entityRoots()) {
      lines.push('', `${root.name}: origin [${root.origin.map((v) => round(v, 2)).join(', ')}], rotation [${root.rotation.map((v) => round(v, 1)).join(', ')}]`);
      const eq = root.pose_equipment || {};
      for (const [side, slot] of [['main', 'mainhand'], ['off', 'offhand']]) {
        if (!eq[slot]) continue;
        let text;
        try {
          text = `scriptevent pose:hold ${handMessage(root, side)}`;
        } catch (e) {
          text = `error: ${e.message || e}`;
        }
        lines.push(`  ${side} hand (${text.length} chars): /${text}`);
      }
    }
    const text = lines.join('\n');
    console.log('[Pose Studio debug]\n' + text);
    Blockbench.showMessageBox({ title: 'Pose Studio debug', message: text });
  }

  function clearWorld() {
    if (!requireConnection()) return;
    send('scriptevent pose:clear');
    resync();
  }

  // Runs via -EncodedCommand so the plugin needs no file-system permission; the script picks
  // the output path itself and prints it.
  const CAPTURE_PS1 = String.raw`$dir = Join-Path ([Environment]::GetFolderPath('MyPictures')) 'Pose Studio'
New-Item -ItemType Directory -Force $dir | Out-Null
$Out = Join-Path $dir ('pose_' + (Get-Date -Format 'yyyy-MM-dd_HH-mm-ss') + '.png')
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PoseStudioWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@
[PoseStudioWin]::SetProcessDPIAware() | Out-Null
$proc = Get-Process | Where-Object { $_.ProcessName -like 'Minecraft.Windows*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { [Console]::Error.WriteLine('Minecraft window not found'); exit 2 }
$hwnd = $proc.MainWindowHandle
if ([PoseStudioWin]::IsIconic($hwnd)) { [PoseStudioWin]::ShowWindow($hwnd, 9) | Out-Null }
[PoseStudioWin]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 600
$rect = New-Object PoseStudioWin+RECT
[PoseStudioWin]::GetClientRect($hwnd, [ref]$rect) | Out-Null
$pt = New-Object PoseStudioWin+POINT
[PoseStudioWin]::ClientToScreen($hwnd, [ref]$pt) | Out-Null
$width = $rect.R - $rect.L
$height = $rect.B - $rect.T
$bmp = New-Object System.Drawing.Bitmap $width, $height
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($pt.X, $pt.Y, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose(); $bmp.Dispose()
Write-Output $Out
`;

  async function capture() {
    if (!requireConnection()) return;
    const childProcess = nodeRequire('child_process', 'run PowerShell to screenshot the Minecraft window');
    if (!childProcess) return;
    const encoded = bufferClass().from(CAPTURE_PS1, 'utf16le').toString('base64');

    await link.command('hud @s hide all').catch(logFailure);
    await sleep(250);
    try {
      const out = await new Promise((resolve, reject) => {
        childProcess.execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
          { windowsHide: true },
          (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(String(stdout).trim()))
        );
      });
      Blockbench.showQuickMessage(`Saved ${out}`, 3000);
    } catch (e) {
      Blockbench.showMessageBox({ title: 'Pose Studio capture failed', message: String(e.message || e) });
    } finally {
      link.command('hud @s reset all').catch(logFailure);
      if (typeof currentwindow !== 'undefined' && currentwindow.focus) currentwindow.focus();
    }
  }

  // ---- Game -> Blockbench transfers ----------------------------------------------------------
  // The websocket can only run commands, so the behavior pack publishes results as fake-player
  // names on a hidden scoreboard objective (`PSD[op|page|item]`). We ask for a batch of pages at a
  // time and read them back from the output of `scoreboard players list`. Page 0 says how many
  // items there are, so a batch that comes back short is noticed and fetched again in smaller batches.
  let transferRunning = false;
  const MAX_PAGE_BATCH = 16;

  // Map(page -> items) for one op.
  function parseItems(text, op) {
    const pages = new Map();
    const re = /PSD\[(\w+)\|(-?\d+)\|([^\]]*)\]/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[1] !== op) continue;
      const n = Number(m[2]);
      if (!pages.has(n)) pages.set(n, []);
      pages.get(n).push(m[3]);
    }
    return pages;
  }

  async function readPages(op, page, count = 1, attempts = 8) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      await link.command(`scriptevent pose:page ${JSON.stringify({ n: page, k: count })}`);
      await sleep(50 + attempt * 100); // give the script a tick to write the pages
      const body = await link.command('scoreboard players list').catch((e) => ({ statusMessage: String(e.message || e) }));
      const pages = parseItems(JSON.stringify(body), op);
      const first = pages.get(page) || [];
      if (page === 0 ? first.some((i) => i.startsWith('M|')) : first.length) return pages;
    }
    throw new Error(`Minecraft didn't return page ${page}. Is the Pose Studio behavior pack active in this world?`);
  }
  async function readPage(op, page) {
    return (await readPages(op, page, 1)).get(page) || [];
  }

  // Runs `/scriptevent <eventId>` and returns every item the script publishes for it.
  async function runGameQuery(eventId, payload, label) {
    // one transfer at a time: wait for the one in progress (e.g. the scene check after connecting)
    for (let waited = 0; transferRunning; waited += 100) {
      if (waited > 60000) throw new Error('Another Pose Studio transfer is still running.');
      await sleep(100);
    }
    transferRunning = true;
    const op = Math.random().toString(36).slice(2, 8);
    try {
      await link.command(`scriptevent ${eventId} ${JSON.stringify(Object.assign({}, payload, { op }))}`);
      const started = Date.now();
      let first;
      let meta;
      for (;;) {
        first = await readPage(op, 0);
        meta = first.find((i) => i.startsWith('M|')).split('|');
        if (meta[1] === 'ready') break;
        if (meta[1] === 'error') throw new Error(meta.slice(2).join('|'));
        Blockbench.showQuickMessage(`${label}… ${meta[2] || 0}%`, 700);
        if (Date.now() - started > 180000) throw new Error(`${label} timed out.`);
        await sleep(500);
      }
      const pages = Number(meta[2]) || 1;
      const total = Number(meta[3]);
      const perPage = Number(meta[4]);
      const items = first.filter((i) => !i.startsWith('M|'));
      // an older behavior pack sends no counts: one page at a time
      const checked = Number.isFinite(total) && perPage > 0;
      const expected = (n) => Math.min(perPage, total - n * perPage);
      let batch = checked ? 8 : 1;
      for (let n = 1; n < pages; ) {
        const count = Math.min(batch, pages - n);
        let got;
        try {
          // a big batch gets two tries; if Minecraft won't send that much, smaller batches follow
          got = checked ? await readPages(op, n, count, count > 1 ? 2 : 8) : new Map([[n, await readPage(op, n)]]);
        } catch (e) {
          if (count <= 1) throw e;
          batch = Math.max(1, Math.floor(count / 2));
          continue;
        }
        let done = 0;
        while (done < count && (!checked || (got.get(n + done) || []).length === expected(n + done))) {
          items.push(...(got.get(n + done) || []));
          done++;
        }
        if (done < count) batch = Math.max(1, Math.floor(batch / 2)); // the reply was cut short
        else if (batch < MAX_PAGE_BATCH) batch++;
        if (!done && batch === 1 && checked) {
          // even a single page came back short: take what arrived rather than loop forever
          items.push(...(got.get(n) || []));
          done = 1;
        }
        n += done;
        Blockbench.setProgress(n / pages);
      }
      return items;
    } finally {
      transferRunning = false;
      Blockbench.setProgress(0);
      send('scriptevent pose:page {"n":-1}'); // remove the objective again
    }
  }

  function showError(title, e) {
    Blockbench.showMessageBox({ title, message: String((e && e.message) || e) });
  }

  // ---- Camera actions ------------------------------------------------------------------------
  async function grabCameraFromPlayer() {
    if (!requireConnection()) return;
    // While the game camera is synced, what Minecraft shows is the active camera's view: save that
    // as a new camera (a spare, or a starting point to tweak). To frame a shot from your own view,
    // turn Sync Game Camera off first.
    if (cameraSync) {
      const source = activeCamera();
      if (source) {
        const copy = createCamera(source.origin.slice(), cameraForward(source));
        for (let i = 0; i < 3; i++) copy.rotation[i] = source.rotation[i]; // keeps any roll too
        if (source.pose_fov) copy.pose_fov = source.pose_fov;
        Canvas.updateAll();
        useNewCamera(copy);
        Blockbench.showQuickMessage(`Saved Minecraft's current view (${source.name}) as ${copy.name}. To frame a shot from your own view, turn off Camera ▸ Sync Game Camera first.`, 5000);
        return;
      }
      // synced to the viewport (no camera): the player's view is hidden, so give it back
      if (cameraToggle) cameraToggle.set(false);
      else setCameraSync(false);
      Blockbench.showMessageBox({
        title: 'Pose Studio',
        message: 'The game camera is back to your own view. Frame the shot in Minecraft, then choose Add Camera ▸ From Minecraft View again.',
      });
      return;
    }
    try {
      await autoAnchor();
      const items = await runGameQuery('pose:grabcam', {}, 'Grabbing camera');
      const c = items.find((i) => i.startsWith('C|'));
      if (!c) throw new Error('No camera data came back.');
      const [, x, y, z, pitch, yaw] = c.split('|').map(Number);
      const p = pitch * DEG;
      const w = yaw * DEG;
      // Minecraft: yaw 0 looks toward +Z, 90 toward -X; positive pitch looks down.
      const worldDir = [-Math.sin(w) * Math.cos(p), -Math.sin(p), Math.cos(w) * Math.cos(p)];
      const dir = new THREE.Vector3(-worldDir[0], worldDir[1], -worldDir[2]);
      const cam = createCamera(toModel([x, y, z]), dir);
      // the same field of view as Minecraft's own camera (only the camera view changes, not the
      // viewport you work in)
      const fov = readGameFov();
      if (fov) cam.pose_fov = fov;
      useNewCamera(cam);
    } catch (e) {
      showError('Pose Studio: grab camera failed', e);
    }
  }

  // Minecraft's Field of View setting (options.txt of the most recently used Minecraft account on
  // this PC), or null when it can't be read.
  function readGameFov() {
    try {
      const fs = bedrockFs();
      const users = `${bedrockRoot()}\\Users`;
      let best = null;
      for (const id of fs.readdirSync(users)) {
        if (id.toLowerCase() === 'shared') continue;
        const file = `${users}\\${id}\\games\\com.mojang\\minecraftpe\\options.txt`;
        if (!fs.existsSync(file)) continue;
        const time = fs.statSync(file).mtimeMs;
        if (!best || time > best.time) best = { file, time };
      }
      if (!best) return null;
      const m = String(fs.readFileSync(best.file, 'utf8')).match(/^gfx_field_of_view:([\d.]+)/m);
      const fov = m ? Number(m[1]) : NaN;
      return fov >= 10 && fov <= 150 ? fov : null;
    } catch (e) {
      return null;
    }
  }

  // A new camera becomes the active one: the camera view opens on it and Minecraft's camera
  // follows it.
  function useNewCamera(cam) {
    activeCam = cam;
    if (povToggle && !povToggle.value) povToggle.set(true);
    if (cameraToggle && !cameraToggle.value) cameraToggle.set(true);
    lastCamera = null; // send it to the game on the next tick
    Blockbench.showQuickMessage(`Pose Studio: saved ${cam.name}: camera view and game camera now follow it`, 2500);
  }

  function saveViewportAsCamera() {
    const preview = viewportPreview();
    const space = modelSpace();
    if (!preview || !preview.camera || !preview.controls) return;
    const pos = preview.camera.position.clone();
    const target = preview.controls.target.clone();
    if (space) {
      space.worldToLocal(pos);
      space.worldToLocal(target);
    }
    const cam = createCamera(pos.toArray().map((v) => round(v, 2)), target.sub(pos));
    useNewCamera(cam);
  }

  // Moves the Blockbench viewport so it looks through the camera.
  function lookThroughCamera(cam) {
    cam = cam || selectedCamera() || activeCamera();
    if (!cam) {
      Blockbench.showQuickMessage('Select a cam_ group first', 2000);
      return;
    }
    const preview = viewportPreview();
    if (!preview || !preview.camera || !preview.controls) return;
    const space = modelSpace();
    const pos = new THREE.Vector3().fromArray(cam.origin);
    const target = pos.clone().add(cameraForward(cam).multiplyScalar(32));
    if (space) {
      space.localToWorld(pos);
      space.localToWorld(target);
    }
    preview.camera.position.copy(pos);
    preview.controls.target.copy(target);
    preview.controls.update();
    if (cam.pose_fov && preview.setFOV) preview.setFOV(cam.pose_fov);
  }

  // ---- World scan ----------------------------------------------------------------------------
  const WORLD_GROUP = 'world_scan';
  const WORLD_TEXTURE = 'world_scan_palette';
  const DYES = {
    light_blue: '#3aafd9', light_gray: '#8e8e86', magenta: '#bd44b3', orange: '#f07613', yellow: '#f8c527',
    purple: '#792aac', white: '#e9ecec', brown: '#724728', green: '#546d1b', black: '#141519', lime: '#70b919',
    pink: '#ed8dac', gray: '#3e4447', cyan: '#158991', blue: '#35399d', red: '#a12722',
  };
  const BLOCK_COLORS = [
    [/water/, '#3f76e4'], [/lava|magma/, '#e2621b'], [/grass_block|^grass$|short_grass/, '#6fa84a'],
    [/leaves/, '#4a7a2e'], [/log|wood|stem|hyphae/, '#6b5132'], [/planks|bookshelf|crafting|barrel|chest/, '#a2824e'],
    [/snow/, '#f0f7f7'], [/ice/, '#9dbef5'], [/red_sand/, '#be6621'], [/sandstone/, '#d8cb9b'], [/sand/, '#dbcfa3'],
    [/gravel/, '#857f7e'], [/dirt|farmland|podzol|mud|path|mycelium/, '#866043'], [/clay/, '#a0a6b3'],
    [/deepslate|basalt|blackstone|bedrock/, '#4d4d51'], [/netherrack|nether|crimson|warped/, '#6f3535'],
    [/end_stone|purpur/, '#dbde9e'], [/glass/, '#c0e0ea'], [/moss|azalea|vine|kelp|seagrass|fern|bush|lily/, '#5a8a3a'],
    [/diorite|quartz|calcite/, '#d0cfca'], [/granite|terracotta/, '#9a6a55'], [/copper/, '#c0704f'],
    [/brick/, '#976253'], [/obsidian/, '#1b1729'], [/ore|cobble|stone|andesite|tuff/, '#7d7d7d'],
  ];

  function blockColor(type) {
    for (const dye of Object.keys(DYES)) if (type.startsWith(dye + '_')) return DYES[dye];
    for (const [re, color] of BLOCK_COLORS) if (re.test(type)) return color;
    let h = 0;
    for (const ch of type) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${h % 360}, 25%, 50%)`;
  }

  const CODE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

  function scanWorldDialog() {
    if (!requireConnection()) return;
    new Dialog({
      id: 'pose_studio_scan',
      title: 'Import World Around Player',
      form: {
        info: { type: 'info', text: 'Traces the ground from above in a circle around you, then casts rays from your eyes to pick up trunks, walls and overhangs. Every block found becomes a coloured cube.' },
        radius: { label: 'Terrain radius (blocks, 0 = off)', type: 'number', value: 48, min: 0, max: 128, step: 8 },
        rays: { label: 'Eye rays (0 = off)', type: 'number', value: 20000, min: 0, max: 200000, step: 1000 },
        dist: { label: 'Eye ray distance (blocks)', type: 'number', value: 64, min: 8, max: 256, step: 8 },
      },
      onConfirm(form) {
        scanWorld(form.radius, form.rays, form.dist);
      },
    }).show();
  }

  async function scanWorld(radius, rays, dist) {
    let items;
    try {
      await autoAnchor();
      items = await runGameQuery('pose:scan', { radius, rays, dist }, 'Importing world');
    } catch (e) {
      showError('Pose Studio: world import failed', e);
      return;
    }
    const { palette, blocks } = parseScanItems(items);
    await buildWorld(palette, blocks);
  }

  function parseScanItems(items) {
    const palette = [];
    const blocks = [];
    for (const item of items) {
      const parts = item.split('|');
      if (parts[0] === 'P') palette[Number(parts[1])] = parts[2];
      if (parts[0] === 'B') {
        for (const entry of parts[1].split(';')) blocks.push(entry.split('.').map(Number));
      } else if (parts[0] === 'Q') {
        // 8 characters a block: x, y, z (offset by 2048) and palette index, 2 characters each
        const s = parts[1];
        const d = (i) => CODE_ALPHABET.indexOf(s[i]) * 64 + CODE_ALPHABET.indexOf(s[i + 1]);
        for (let i = 0; i + 8 <= s.length; i += 8) blocks.push([d(i) - 2048, d(i + 2) - 2048, d(i + 4) - 2048, d(i + 6)]);
      }
    }
    return { palette, blocks };
  }

  // Builds the scan as ONE mesh element. Neighbouring faces that share a direction and block
  // type are merged into larger rectangles (greedy meshing), so thousands of blocks become a
  // few thousand quads in a single object instead of thousands of cubes.
  function greedyQuads(blocks) {
    const occupied = new Map(blocks.map((b) => [`${b[0]},${b[1]},${b[2]}`, b[3]]));
    const quads = [];
    // For each axis a, (u, v) are the other two axes in cyclic order, so u × v points along +a.
    const AXES = [[0, 1, 2], [1, 2, 0], [2, 0, 1]];
    for (const [a, u, v] of AXES) {
      for (const sign of [1, -1]) {
        // slice -> Map("cu,cv" -> palette index) of visible faces in this direction
        const slices = new Map();
        for (const b of blocks) {
          const n = [b[0], b[1], b[2]];
          n[a] += sign;
          if (occupied.has(`${n[0]},${n[1]},${n[2]}`)) continue;
          let slice = slices.get(b[a]);
          if (!slice) slices.set(b[a], (slice = new Map()));
          slice.set(`${b[u]},${b[v]}`, b[3]);
        }
        for (const [s, cells] of slices) {
          const keys = Array.from(cells.keys(), (k) => k.split(',').map(Number)).sort((p, q) => p[1] - q[1] || p[0] - q[0]);
          const done = new Set();
          for (const [cu, cv] of keys) {
            const start = `${cu},${cv}`;
            if (done.has(start)) continue;
            const p = cells.get(start);
            const free = (x, y) => !done.has(`${x},${y}`) && cells.get(`${x},${y}`) === p;
            let w = 1;
            while (free(cu + w, cv)) w++;
            let h = 1;
            grow: for (;;) {
              for (let i = 0; i < w; i++) if (!free(cu + i, cv + h)) break grow;
              h++;
            }
            for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) done.add(`${cu + i},${cv + j}`);
            const plane = s + (sign > 0 ? 1 : 0);
            const corner = (du, dv) => {
              const c = [0, 0, 0];
              c[a] = plane;
              c[u] = cu + du;
              c[v] = cv + dv;
              return c;
            };
            const loop = [corner(0, 0), corner(w, 0), corner(w, h), corner(0, h)];
            quads.push({ corners: sign > 0 ? loop : loop.reverse(), p });
          }
        }
      }
    }
    return quads;
  }

  function removeOldScans() {
    const old = [];
    for (const node of Outliner.root) {
      if (node.name !== WORLD_GROUP) continue;
      if (node instanceof Group) node.forEachChild((c) => c instanceof OutlinerElement && old.push(c));
      old.push(node);
    }
    return old;
  }

  async function buildWorld(palette, blocks) {
    if (typeof Project === 'undefined' || !Project) newProject(Formats.free);

    // One 16x16 texture with a 1px colour cell per block type.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const ctx = canvas.getContext('2d');
    palette.forEach((type, i) => {
      ctx.fillStyle = blockColor(type || '');
      ctx.fillRect(i % 16, Math.floor(i / 16) % 16, 1, 1);
    });

    const quads = greedyQuads(blocks);

    const old = removeOldScans();
    const oldElements = old.filter((n) => !(n instanceof Group));
    const oldTexture = Texture.all.find((t) => t.name === WORLD_TEXTURE);
    Undo.initEdit({ outliner: true, elements: oldElements, textures: oldTexture ? [oldTexture] : [] });
    for (const node of old) node.remove();
    if (oldTexture) oldTexture.remove(true);

    const texture = new Texture({ name: WORLD_TEXTURE }).fromDataURL(canvas.toDataURL('image/png'));
    texture.add(false);
    texture.uv_width = 16;
    texture.uv_height = 16;

    const mesh = new Mesh({ name: WORLD_GROUP, origin: [0, 0, 0], vertices: {} });
    for (const key of Object.keys(mesh.vertices)) delete mesh.vertices[key];
    for (const key of Object.keys(mesh.faces)) delete mesh.faces[key];

    // Grid corner (block units, anchor block's corner at 0) -> Blockbench model space.
    const vertexKeys = new Map();
    const vertex = (c) => {
      const id = c.join(',');
      let key = vertexKeys.get(id);
      if (!key) {
        [key] = mesh.addVertices([-(c[0] - 0.5) * 16, c[1] * 16, -(c[2] - 0.5) * 16]);
        vertexKeys.set(id, key);
      }
      return key;
    };
    for (const { corners, p } of quads) {
      const u = p % 16;
      const v = Math.floor(p / 16) % 16;
      const keys = corners.map(vertex);
      const cellUV = [[u + 0.25, v + 0.25], [u + 0.75, v + 0.25], [u + 0.75, v + 0.75], [u + 0.25, v + 0.75]];
      const uv = {};
      keys.forEach((k, i) => (uv[k] = cellUV[i]));
      mesh.addFaces(new MeshFace(mesh, { vertices: keys, uv, texture: texture.uuid }));
    }
    mesh.init();

    Undo.finishEdit('Pose Studio world scan', { outliner: true, elements: [mesh], textures: [texture] });
    Canvas.updateAll();
    disableWorldPicking();
    Blockbench.showQuickMessage(`Pose Studio: ${blocks.length} blocks → ${quads.length} faces`, 3000);
  }

  // The scan can't be clicked in the viewport (select or delete it from the outliner instead).
  // three.js raycasting is switched off on its scene objects; Blockbench rebuilds those objects
  // when projects load, so this is re-applied every second.
  function disableWorldPicking() {
    if (typeof Project === 'undefined' || !Project) return;
    for (const el of Project.elements || []) {
      if (el.name !== WORLD_GROUP || !(el instanceof Mesh)) continue;
      const obj = el.mesh || el.scene_object;
      if (!obj || !obj.traverse) continue;
      obj.traverse((o) => {
        if (o.__poseStudioNoPick) return;
        o.raycast = () => {};
        o.__poseStudioNoPick = true;
      });
    }
  }

  // ---- Field of view -------------------------------------------------------------------------
  // Each cam_ group keeps its own FOV (saved with the project); 0 means "use the viewport's".
  function viewportFov() {
    const preview = viewportPreview();
    return (preview && preview.camera && preview.camera.fov) || 70;
  }

  function applyFov(cam, fov) {
    if (cam) cam.pose_fov = fov;
    if (cam && povPreview) return;
    const preview = viewportPreview();
    if (preview && preview.setFOV) preview.setFOV(fov);
  }

  function fovDialog() {
    const cam = activeCamera();
    const previousCamFov = cam ? cam.pose_fov : 0;
    const previousViewportFov = viewportFov();
    new Dialog({
      id: 'pose_studio_fov',
      title: cam ? `Field of View: ${cam.name}` : 'Field of View: viewport',
      form: {
        info: { type: 'info', text: cam ? 'Changes this camera. The game updates live while Sync Game Camera is on.' : 'No camera selected, so this changes the Blockbench viewport. Select a cam_ group to give it its own FOV.' },
        fov: { label: 'FOV (degrees)', type: 'range', min: 10, max: 120, step: 1, value: Math.round((cam && cam.pose_fov) || previousViewportFov), editable_range_label: true },
      },
      onFormChange(form) {
        applyFov(cam, form.fov);
      },
      onConfirm(form) {
        applyFov(cam, form.fov);
        if (cam) Project.saved = false;
      },
      onCancel() {
        if (cam) cam.pose_fov = previousCamFov;
        const preview = viewportPreview();
        if (preview && preview.setFOV) preview.setFOV(previousViewportFov);
      },
    }).show();
  }

  // ---- Skins ---------------------------------------------------------------------------------
  // Minecraft only loads textures when a world opens, so skins go into 16 numbered slots in the
  // development resource pack (textures/entity/pose_studio/skin_N.png). Choosing which slot a
  // mannequin uses (and slim vs classic arms) is live; a new or changed skin image needs the
  // world to be reopened once.
  const SKIN_SLOTS = 16;

  // Standard 64x64 player skin layout, in Bedrock geometry coordinates (origin, size, uv).
  // Every part has a base cube and an outer-layer cube.
  const SKIN_PARTS = {
    head: [{ o: [-4, 24, -4], s: [8, 8, 8], uv: [0, 0] }, { o: [-4, 24, -4], s: [8, 8, 8], uv: [32, 0], inflate: 0.5 }],
    body: [{ o: [-4, 12, -2], s: [8, 12, 4], uv: [16, 16] }, { o: [-4, 12, -2], s: [8, 12, 4], uv: [16, 32], inflate: 0.25 }],
    rightArm: {
      classic: [{ o: [-8, 12, -2], s: [4, 12, 4], uv: [40, 16] }, { o: [-8, 12, -2], s: [4, 12, 4], uv: [40, 32], inflate: 0.25 }],
      slim: [{ o: [-7, 12, -2], s: [3, 12, 4], uv: [40, 16] }, { o: [-7, 12, -2], s: [3, 12, 4], uv: [40, 32], inflate: 0.25 }],
    },
    leftArm: {
      classic: [{ o: [4, 12, -2], s: [4, 12, 4], uv: [32, 48] }, { o: [4, 12, -2], s: [4, 12, 4], uv: [48, 48], inflate: 0.25 }],
      slim: [{ o: [4, 12, -2], s: [3, 12, 4], uv: [32, 48] }, { o: [4, 12, -2], s: [3, 12, 4], uv: [48, 48], inflate: 0.25 }],
    },
    rightLeg: [{ o: [-3.9, 0, -2], s: [4, 12, 4], uv: [0, 16] }, { o: [-3.9, 0, -2], s: [4, 12, 4], uv: [0, 32], inflate: 0.25 }],
    leftLeg: [{ o: [-0.1, 0, -2], s: [4, 12, 4], uv: [16, 48] }, { o: [-0.1, 0, -2], s: [4, 12, 4], uv: [0, 48], inflate: 0.25 }],
  };

  // `/reload all` makes Minecraft leave and rejoin the world, reloading every pack (and so any new
  // skin images). The websocket may drop while it does; if so, run /connect again.
  function reloadMinecraftPacks() {
    if (!requireConnection()) return;
    link.command('reload all').catch(() => {}); // the reply may never arrive
    markLibraryLoaded();
    resync(); // resend poses and the camera once the world is back
    Blockbench.showQuickMessage('Pose Studio: Minecraft is reloading its packs…', 3000);
    setTimeout(() => {
      if (link.connected) return;
      Blockbench.showMessageBox({
        title: 'Pose Studio',
        message: `Minecraft reloaded its packs, and the link dropped while it did.

Run /connect 127.0.0.1:${PORT} in Minecraft again.`,
      });
    }, 10000);
  }

  function selectedMannequin() {
    let node = Group.first_selected !== undefined ? Group.first_selected : Group.selected;
    if (!node && Outliner.selected && Outliner.selected.length) node = Outliner.selected[0];
    while (node && node !== 'root') {
      if (node instanceof Group && node.parent === 'root' && MANNEQUIN_PREFIX.test(node.name)) return node;
      node = node.parent;
    }
    return null;
  }

  function devSkinFolder() {
    return `${devPackDir('resource')}\\textures\\entity\\pose_studio`;
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That file could not be read as an image.'));
      img.src = dataUrl;
    });
  }

  // Slim skins leave the 4th column of the right arm's front face empty.
  function detectSlim(img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(54, 20, 1, 1).data[3] === 0;
  }

  // ---- Skin library --------------------------------------------------------------------------
  // The 16 slot images live in the development resource pack together with library.json
  // (names, arm type, and which slots changed since Minecraft last loaded them). Once Minecraft
  // has loaded a slot, putting that skin on any mannequin is instant.
  const PLACEHOLDER_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAmUlEQVR4nO3YsQkAMQwEQfVfgpr11/BgmMAbbCqOCTW7e3AjmwACCCCAAAIIIIAAAggggAACCOC5AtADdAHoAboA9ABdAHqALgA9QBeAHqALQA/QBaAfEjo+QMcH6PgAHR+g4wN0fICOD9DxATo+QMcH6PgAHR+g4wN0fICOD9DdOKKfGgEEEEAAAQQQQAABBBBAAAEEEMC/PmIc2h3ic/WrAAAAAElFTkSuQmCC';

  let libraryFsCache = null;
  function libraryFs() {
    if (libraryFsCache) return libraryFsCache;
    const folder = devSkinFolder();
    const fs = requireNativeModule('fs', { scope: folder, message: 'Pose Studio keeps its skin library in its development resource pack.' });
    if (!fs) throw new Error('File access was denied.');
    if (!fs.existsSync(folder)) throw new Error(`The Pose Studio resource pack isn't in development_resource_packs:\n${folder}`);
    libraryFsCache = fs;
    return fs;
  }

  const slotPath = (slot) => `${devSkinFolder()}\\skin_${slot}.png`;
  const manifestPath = () => `${devSkinFolder()}\\library.json`;

  function readManifest() {
    const fs = libraryFs();
    try {
      const data = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
      return { slots: data.slots || {} };
    } catch (e) {
      return { slots: {} };
    }
  }

  function writeManifest(manifest) {
    libraryFs().writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2));
  }

  // Face thumbnail (head front + hat layer), scaled up with hard pixels.
  function faceThumbnail(img) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 48;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 48, 48);
    ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 48, 48);
    return canvas.toDataURL('image/png');
  }

  // All 16 slots with what's in them, for the library dialog.
  async function readLibrary() {
    const fs = libraryFs();
    const manifest = readManifest();
    const slots = [];
    for (let slot = 1; slot <= SKIN_SLOTS; slot++) {
      const info = manifest.slots[slot] || {};
      const entry = { slot, name: info.name || '', slim: !!info.slim, dirty: !!info.dirty, filled: false, dataUrl: '', face: '' };
      try {
        const bytes = fs.readFileSync(slotPath(slot));
        const base64 = bufferClass().from(bytes).toString('base64');
        if (base64 !== PLACEHOLDER_PNG_BASE64) {
          entry.filled = true;
          entry.dataUrl = 'data:image/png;base64,' + base64;
          entry.face = faceThumbnail(await loadImage(entry.dataUrl));
          if (!entry.name) entry.name = `Skin ${slot}`;
        }
      } catch (e) {
        // missing file = empty slot
      }
      slots.push(entry);
    }
    return slots;
  }

  function pickSkinFile() {
    return new Promise((resolve) => {
      // Read the raw bytes: in the desktop app readtype 'image' only returns the file path.
      Blockbench.import({ extensions: ['png'], type: 'Minecraft skin', readtype: 'buffer' }, async (files) => {
        const file = files && files[0];
        if (!file) return resolve(null);
        try {
          const bytes = file.content instanceof ArrayBuffer ? new Uint8Array(file.content) : file.content;
          if (!bytes || typeof bytes === 'string') throw new Error('The skin file could not be read.');
          const dataUrl = 'data:image/png;base64,' + bufferClass().from(bytes).toString('base64');
          const img = await loadImage(dataUrl);
          if (img.width !== 64 || img.height !== 64) {
            throw new Error(`Skins must be 64×64 pixels; this one is ${img.width}×${img.height}. (Old 64×32 skins aren't supported.)`);
          }
          resolve({ name: String(file.name).replace(/\.png$/i, ''), dataUrl, slim: detectSlim(img) });
        } catch (e) {
          showError('Pose Studio: skin', e);
          resolve(null);
        }
      });
    });
  }

  async function addSkinToSlot(slot) {
    const skin = await pickSkinFile();
    if (!skin) return false;
    libraryFs().writeFileSync(slotPath(slot), bufferClass().from(skin.dataUrl.split(',')[1], 'base64'));
    const manifest = readManifest();
    manifest.slots[slot] = { name: skin.name, slim: skin.slim, dirty: true };
    writeManifest(manifest);
    refreshMannequinsUsing(slot, skin.dataUrl, skin.slim);
    return true;
  }

  // Fills empty slots with every 64×64 PNG in a folder (in name order). Skins already in the
  // library, other sizes and anything past the last free slot are skipped and reported.
  async function importSkinFolder() {
    const dir = Blockbench.pickDirectory({ title: 'Choose a folder of skins', resource_id: 'pose_studio_skins' });
    if (!dir) return null;
    const folderFs = requireNativeModule('fs', { scope: dir, message: 'Pose Studio reads the skin PNGs in this folder.' });
    if (!folderFs) throw new Error('Access to that folder was denied.');
    const names = folderFs
      .readdirSync(dir)
      .filter((n) => /\.png$/i.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const library = await readLibrary();
    const known = new Set(library.filter((e) => e.filled).map((e) => e.dataUrl));
    const freeSlots = library.filter((e) => !e.filled).map((e) => e.slot);
    const manifest = readManifest();
    const report = { folder: dir, added: [], duplicates: [], wrongSize: [], noRoom: [] };

    for (const name of names) {
      const bytes = folderFs.readFileSync(`${dir}\\${name}`);
      const dataUrl = 'data:image/png;base64,' + bufferClass().from(bytes).toString('base64');
      if (known.has(dataUrl)) {
        report.duplicates.push(name);
        continue;
      }
      let img;
      try {
        img = await loadImage(dataUrl);
      } catch (e) {
        report.wrongSize.push(`${name} (not a readable image)`);
        continue;
      }
      if (img.width !== 64 || img.height !== 64) {
        report.wrongSize.push(`${name} (${img.width}×${img.height})`);
        continue;
      }
      const slot = freeSlots.shift();
      if (!slot) {
        report.noRoom.push(name);
        continue;
      }
      libraryFs().writeFileSync(slotPath(slot), bytes);
      manifest.slots[slot] = { name: name.replace(/\.png$/i, ''), slim: detectSlim(img), dirty: true };
      known.add(dataUrl);
      report.added.push(name);
    }
    writeManifest(manifest);
    return report;
  }

  function showImportReport(report) {
    const list = (items) => items.map((n) => `  • ${n}`).join('\n');
    const parts = [`Added ${report.added.length} skin${report.added.length === 1 ? '' : 's'} from ${report.folder}.`];
    if (report.duplicates.length) parts.push(`Already in the library (skipped):\n${list(report.duplicates)}`);
    if (report.wrongSize.length) parts.push(`Not 64×64 skins (skipped):\n${list(report.wrongSize)}`);
    if (report.noRoom.length) parts.push(`No free slots left (remove skins to make room):\n${list(report.noRoom)}`);
    if (report.added.length) parts.push('Press Reload Minecraft Packs once so Minecraft loads them.');
    Blockbench.showMessageBox({ title: 'Pose Studio: import skins', message: parts.join('\n\n') });
  }

  function clearSlot(slot) {
    libraryFs().writeFileSync(slotPath(slot), bufferClass().from(PLACEHOLDER_PNG_BASE64, 'base64'));
    const manifest = readManifest();
    delete manifest.slots[slot];
    writeManifest(manifest);
    for (const m of mannequinRoots().filter((g) => g.pose_skin_slot === slot)) removeSkin(m);
    const texture = Texture.all.find((t) => t.name === `skin_slot_${slot}`);
    if (texture) texture.remove(true);
  }

  function setSlotSlim(slot, slim, dataUrl) {
    const manifest = readManifest();
    manifest.slots[slot] = Object.assign({}, manifest.slots[slot], { slim });
    writeManifest(manifest);
    refreshMannequinsUsing(slot, dataUrl, slim);
  }

  function markLibraryLoaded() {
    try {
      const manifest = readManifest();
      for (const key of Object.keys(manifest.slots)) manifest.slots[key].dirty = false;
      writeManifest(manifest);
    } catch (e) {
      // no library yet
    }
  }

  // One Blockbench texture per slot, shared by every mannequin wearing it.
  function slotTexture(slot, dataUrl, replace) {
    const name = `skin_slot_${slot}`;
    let texture = Texture.all.find((t) => t.name === name);
    if (texture && replace) {
      texture.remove(true);
      texture = null;
    }
    if (!texture) {
      texture = new Texture({ name }).fromDataURL(dataUrl);
      texture.add(false);
      texture.uv_width = 64;
      texture.uv_height = 64;
    }
    return texture;
  }

  function refreshMannequinsUsing(slot, dataUrl, slim) {
    const users = mannequinRoots().filter((g) => g.pose_skin_slot === slot);
    const texture = slotTexture(slot, dataUrl, true);
    for (const m of users) buildSkinnedCubes(m, texture, slim, slot);
  }

  function wearSkin(mannequin, entry) {
    const texture = slotTexture(entry.slot, entry.dataUrl, false);
    buildSkinnedCubes(mannequin, texture, entry.slim, entry.slot);
  }

  // Replaces the mannequin's cubes with the skin layout (base + outer layer per part).
  function buildSkinnedCubes(mannequin, texture, slim, slot) {
    const oldCubes = [];
    mannequin.forEachChild((c) => c instanceof Cube && oldCubes.push(c));
    Undo.initEdit({ outliner: true, elements: oldCubes });
    for (const cube of oldCubes) cube.remove();

    const [rx, ry, rz] = mannequin.origin;
    const cubes = [];
    ensureRig(mannequin);
    for (const group of mannequinBones(mannequin).values()) {
      const key = Object.keys(SKIN_PARTS).find((k) => k.toLowerCase() === boneKey(group.name));
      if (!key) continue;
      const def = SKIN_PARTS[key];
      const parts = Array.isArray(def) ? def : def[slim ? 'slim' : 'classic'];
      parts.forEach((p, i) => {
        // Bedrock geometry -> Blockbench model space: X is mirrored (see toWorld), then offset
        // by where the mannequin has been moved to.
        const cube = new Cube({
          name: i === 0 ? key : `${key}_layer`,
          from: [rx - (p.o[0] + p.s[0]), ry + p.o[1], rz + p.o[2]],
          to: [rx - p.o[0], ry + p.o[1] + p.s[1], rz + p.o[2] + p.s[2]],
          inflate: p.inflate || 0,
          box_uv: true,
          uv_offset: p.uv.slice(),
        })
          .addTo(group)
          .init();
        cube.applyTexture(texture, true);
        cubes.push(cube);
      });
    }
    mannequin.pose_skin_slot = slot;
    mannequin.pose_slim = slim;
    Undo.finishEdit('Set mannequin skin', { outliner: true, elements: cubes });
    Canvas.updateAll();
    refreshEquipmentPreview(mannequin);
    lastSent.delete(mannequinId(mannequin.name)); // resend with the new slot
  }

  // Back to plain untextured cubes (Steve in Minecraft).
  function removeSkin(mannequin) {
    const oldCubes = [];
    mannequin.forEachChild((c) => c instanceof Cube && oldCubes.push(c));
    Undo.initEdit({ outliner: true, elements: oldCubes });
    for (const cube of oldCubes) cube.remove();
    const [rx, ry, rz] = mannequin.origin;
    const cubes = [];
    ensureRig(mannequin);
    for (const group of mannequinBones(mannequin).values()) {
      const bone = BONES.find((b) => b.key.toLowerCase() === boneKey(group.name));
      if (!bone) continue;
      const shift = (v) => [v[0] + rx, v[1] + ry, v[2] + rz];
      cubes.push(new Cube({ name: bone.key, from: shift(bone.from), to: shift(bone.to), color: bone.color }).addTo(group).init());
    }
    mannequin.pose_skin_slot = 0;
    mannequin.pose_slim = false;
    Undo.finishEdit('Remove mannequin skin', { outliner: true, elements: cubes });
    Canvas.updateAll();
    refreshEquipmentPreview(mannequin);
    lastSent.delete(mannequinId(mannequin.name));
  }

  // Skin library contents for a dialog (on its own, or as the Skin tab of Skin & Equipment).
  function skinParts(mannequin, slots) {
    return {
        data: () => ({ slots, target: mannequin ? mannequin.name : '', busy: false }),
        computed: {
          anyDirty() {
            return this.slots.some((s) => s.filled && s.dirty);
          },
        },
        methods: {
          async reload() {
            this.slots.splice(0, this.slots.length, ...(await readLibrary()));
          },
          async importFolder() {
            if (this.busy) return;
            this.busy = true;
            try {
              const report = await importSkinFolder();
              if (report) {
                await this.reload();
                showImportReport(report);
              }
            } catch (e) {
              showError('Pose Studio: import skins', e);
            }
            this.busy = false;
          },
          async add(entry) {
            if (this.busy) return;
            this.busy = true;
            try {
              if (await addSkinToSlot(entry.slot)) await this.reload();
            } catch (e) {
              showError('Pose Studio: skin library', e);
            }
            this.busy = false;
          },
          wear(entry) {
            if (!entry.filled) return this.add(entry);
            if (!mannequin) {
              Blockbench.showQuickMessage('Select a mannequin first, then open the library again', 2500);
              return;
            }
            wearSkin(mannequin, entry);
            Blockbench.showQuickMessage(`${mannequin.name} is wearing ${entry.name}`, 1500);
          },
          toggleArms(entry) {
            entry.slim = !entry.slim;
            setSlotSlim(entry.slot, entry.slim, entry.dataUrl);
          },
          async remove(entry) {
            clearSlot(entry.slot);
            await this.reload();
          },
          takeOff() {
            if (mannequin) removeSkin(mannequin);
          },
        },
        template: `
          <div class="pose_studio_library">
            <div style="display: flex; justify-content: flex-end; margin-bottom: 8px;">
              <button @click="importFolder()" :disabled="busy">Import Folder…</button>
            </div>
            <p style="margin: 0 0 10px">
              <template v-if="target">Click a skin to put it on <b>{{ target }}</b>. <a href="#" @click.prevent="takeOff()">Take skin off</a></template>
              <template v-else>Select a mannequin before opening the library to dress it. You can still add and manage skins here.</template>
            </p>
            <p v-if="anyDirty" style="margin: 0 0 10px; color: var(--color-warning, #e8a33d)">
              Skins marked "needs reload" were added or changed since Minecraft last loaded them. Press Reload Minecraft Packs once when you're done.
            </p>
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;">
              <div v-for="entry in slots" :key="entry.slot"
                   style="border: 1px solid var(--color-border); border-radius: 6px; padding: 8px; display: flex; gap: 8px; align-items: center; cursor: pointer; min-height: 64px;"
                   :title="entry.filled ? 'Put this skin on the selected mannequin' : 'Add a skin to this slot'"
                   @click="wear(entry)">
                <img v-if="entry.filled" :src="entry.face" width="48" height="48" style="image-rendering: pixelated; flex: none;">
                <div v-else style="width: 48px; height: 48px; flex: none; display: flex; align-items: center; justify-content: center; border: 1px dashed var(--color-border); border-radius: 4px; font-size: 22px; opacity: 0.6;">+</div>
                <div style="min-width: 0; flex: 1;">
                  <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ entry.filled ? entry.name : 'Empty slot ' + entry.slot }}</div>
                  <div v-if="entry.filled" style="font-size: 0.85em; opacity: 0.75; display: flex; gap: 6px; flex-wrap: wrap;">
                    <a href="#" @click.prevent.stop="toggleArms(entry)" title="Switch arm width">{{ entry.slim ? 'Slim arms' : 'Classic arms' }}</a>
                    <a href="#" @click.prevent.stop="add(entry)" title="Replace this skin">Replace</a>
                    <a href="#" @click.prevent.stop="remove(entry)" title="Empty this slot">Remove</a>
                  </div>
                  <div v-if="entry.filled && entry.dirty" style="font-size: 0.8em; color: var(--color-warning, #e8a33d);">needs reload</div>
                </div>
              </div>
            </div>
          </div>`,
    };
  }

  // Pose Studio ▸ More ▸ Skin Library…: manage skins without a mannequin selected.
  async function openSkinLibrary() {
    let slots;
    try {
      slots = await readLibrary();
    } catch (e) {
      showError('Pose Studio: skin library', e);
      return;
    }
    new Dialog({
      id: 'pose_studio_skin_library',
      title: 'Skin Library',
      width: 780,
      buttons: ['Reload Minecraft Packs', 'Close'],
      cancelIndex: 1,
      component: skinParts(selectedMannequin(), slots),
      onButton(index) {
        if (index === 0) reloadMinecraftPacks();
      },
    }).show();
  }

  // <scanner>
  // ---- Content scanner -----------------------------------------------------------------------
  // Builds the list of entities for the world you're in: vanilla (layered from the versioned
  // packs in the Minecraft install) plus the world's resource packs, in priority order.
  // Pure Node + JSON: takes an fs-like object so it can be tested outside Blockbench.

  // Tolerant JSON: Bedrock files may contain comments and trailing commas.
  function parseLooseJson(text) {
    text = String(text).replace(/^﻿/, '');
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];
      if (inString) {
        out += ch;
        if (ch === '\\') {
          out += next || '';
          i++;
        } else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
        out += ch;
      } else if (ch === '/' && next === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        out += '\n';
      } else if (ch === '/' && next === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i++;
      } else out += ch;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  }

  // Minecraft's .brarchive: 16-byte header (magic, count, version), then a 256-byte record per
  // file (name length, name, offset, size), then the data.
  function readBrarchive(buffer) {
    const count = buffer.readUInt32LE(8);
    const dataStart = 16 + count * 256;
    const entries = [];
    for (let i = 0; i < count; i++) {
      const at = 16 + i * 256;
      const name = buffer.toString('utf8', at + 1, at + 1 + buffer[at]);
      const offset = buffer.readUInt32LE(at + 248);
      const size = buffer.readUInt32LE(at + 252);
      entries.push({ name, size, read: () => buffer.subarray(dataStart + offset, dataStart + offset + size) });
    }
    return entries;
  }

  const INDEXED_FOLDERS = /^(entity|models|render_controllers|animations|animation_controllers|attachables|textures|texts)\//;

  // A pack's files, from plain folders and from __brarchive archives. Keys are lower-case paths
  // without extension handling, e.g. "textures/entity/cow/cow.png".
  function indexPack(fs, root, label) {
    const files = new Map();
    const archiveWanted = (rel) => /^(entity|models|render_controllers|animations|animation_controllers|texts|textures\/(entity|models|items))/.test(rel);
    function walk(dir, rel) {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch (e) {
        return;
      }
      for (const name of names) {
        const full = `${dir}\\${name}`;
        const relPath = rel ? `${rel}/${name}` : name;
        let stat;
        try {
          stat = fs.statSync(full);
        } catch (e) {
          continue;
        }
        if (stat.isDirectory()) {
          if (name === '__brarchive') walkArchives(full, '');
          else if (!rel ? /^(entity|models|render_controllers|animations|animation_controllers|attachables|textures|texts)$/i.test(name) : true) walk(full, relPath);
        } else if (INDEXED_FOLDERS.test(relPath.toLowerCase())) {
          files.set(relPath.toLowerCase(), { plain: true, read: () => fs.readFileSync(full) });
        }
      }
    }
    function walkArchives(dir, rel) {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch (e) {
        return;
      }
      for (const name of names) {
        const full = `${dir}\\${name}`;
        if (/\.brarchive$/i.test(name)) {
          const prefix = (rel ? `${rel}/` : '') + name.replace(/\.brarchive$/i, '');
          if (!archiveWanted(prefix.toLowerCase() + '/')) continue;
          let entries;
          try {
            entries = readBrarchive(fs.readFileSync(full));
          } catch (e) {
            continue;
          }
          // Plain files win over archive copies; the vanilla archives contain empty placeholders
          // (e.g. texts/en_US.lang) that must not hide the real file.
          for (const entry of entries) {
            const key = `${prefix}/${entry.name}`.toLowerCase();
            if (entry.size && !(files.get(key) || {}).plain) files.set(key, entry);
          }
        } else {
          try {
            if (fs.statSync(full).isDirectory()) walkArchives(full, rel ? `${rel}/${name}` : name);
          } catch (e) {
            // skip
          }
        }
      }
    }
    walk(root, '');
    return { label, root, files };
  }

  function readPackManifest(fs, dir) {
    try {
      return parseLooseJson(fs.readFileSync(`${dir}\\manifest.json`, 'utf8'));
    } catch (e) {
      return null;
    }
  }

  function compareVersions(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  // Vanilla resource packs in the install, oldest first: vanilla, vanilla_1.14, ..., newest.
  function vanillaPackDirs(fs, installData) {
    const base = `${installData}\\resource_packs`;
    const versioned = fs
      .readdirSync(base)
      .map((name) => ({ name, m: name.match(/^vanilla_(\d+(?:\.\d+)*)$/) }))
      .filter((p) => p.m)
      .sort((a, b) => compareVersions(a.m[1].split('.').map(Number), b.m[1].split('.').map(Number)));
    return [`${base}\\vanilla`, ...versioned.map((p) => `${base}\\${p.name}`)];
  }

  // com.mojang folders: Users\Shared\games\com.mojang and Users\<id>\games\com.mojang.
  function mojangFolders(fs, bedrockRoot) {
    const users = `${bedrockRoot}\\Users`;
    let names = [];
    try {
      names = fs.readdirSync(users);
    } catch (e) {
      return [];
    }
    return names.map((n) => `${users}\\${n}\\games\\com.mojang`).filter((p) => fs.existsSync(p));
  }

  function listWorlds(fs, bedrockRoot) {
    const worlds = [];
    for (const mojang of mojangFolders(fs, bedrockRoot)) {
      const dir = `${mojang}\\minecraftWorlds`;
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch (e) {
        continue;
      }
      for (const id of names) {
        const path = `${dir}\\${id}`;
        const name = worldFolderName(fs, path) || id;
        // The open world keeps writing to its database, so its newest db file is the most recent.
        let lastActive = 0;
        try {
          for (const f of fs.readdirSync(`${path}\\db`)) {
            lastActive = Math.max(lastActive, fs.statSync(`${path}\\db\\${f}`).mtimeMs);
          }
        } catch (e) {
          // no db yet
        }
        worlds.push({ id, name, path, mojang, lastActive });
      }
    }
    return worlds.sort((a, b) => b.lastActive - a.lastActive);
  }

  // Finds pack folders by UUID in the world itself and in the (development_)resource_packs folders.
  function findPackDirs(fs, world, bedrockRoot, kind) {
    const byUuid = new Map();
    const roots = [`${world.path}\\${kind}_packs`];
    for (const mojang of mojangFolders(fs, bedrockRoot)) roots.push(`${mojang}\\development_${kind}_packs`, `${mojang}\\${kind}_packs`);
    for (const root of roots) {
      let names = [];
      try {
        names = fs.readdirSync(root);
      } catch (e) {
        continue;
      }
      for (const name of names) {
        const dir = `${root}\\${name}`;
        const manifest = readPackManifest(fs, dir);
        const uuid = manifest && manifest.header && manifest.header.uuid;
        if (uuid && !byUuid.has(uuid.toLowerCase())) {
          byUuid.set(uuid.toLowerCase(), { dir, name: (manifest.header.name || name).replace(/§./g, ''), version: manifest.header.version });
        }
      }
    }
    return byUuid;
  }

  // The world's packs, highest priority first (as listed in world_*_packs.json).
  function worldPacks(fs, world, bedrockRoot, kind) {
    let list = [];
    try {
      list = parseLooseJson(fs.readFileSync(`${world.path}\\world_${kind}_packs.json`, 'utf8'));
    } catch (e) {
      return [];
    }
    const found = findPackDirs(fs, world, bedrockRoot, kind);
    return list.map((entry) => {
      const pack = found.get(String(entry.pack_id).toLowerCase());
      return { uuid: entry.pack_id, version: entry.version, dir: pack ? pack.dir : null, name: pack ? pack.name : `Missing pack ${entry.pack_id}` };
    });
  }

  // ---- Geometry ----
  // Normalises both geometry formats to { id, texture_width, texture_height, bones, parent }.
  function collectGeometries(json, out) {
    if (Array.isArray(json['minecraft:geometry'])) {
      for (const g of json['minecraft:geometry']) {
        const d = g.description || {};
        if (!d.identifier) continue;
        out.set(d.identifier, { id: d.identifier, texture_width: d.texture_width, texture_height: d.texture_height, bones: g.bones || [] });
      }
      return;
    }
    for (const key of Object.keys(json)) {
      if (!/^geometry\./.test(key) || typeof json[key] !== 'object') continue;
      const [id, parent] = key.split(':');
      const g = json[key];
      out.set(id, { id, parent, texture_width: g.texturewidth || g.texture_width, texture_height: g.textureheight || g.texture_height, bones: g.bones || [] });
    }
  }

  // Legacy geometry can inherit ("geometry.child:geometry.parent"): parent bones first, then the
  // child's bones replace same-named ones.
  function resolveGeometry(geometries, id, depth = 0) {
    const g = geometries.get(id);
    if (!g) return null;
    const withDefaults = (x) => Object.assign({}, x, { texture_width: x.texture_width || 64, texture_height: x.texture_height || 64 });
    if (!g.parent || depth > 8) return depth ? g : withDefaults(g);
    const parent = resolveGeometry(geometries, g.parent, depth + 1);
    if (!parent) return depth ? g : withDefaults(g);
    // A child's bone is merged over the parent's: armour models, for example, only switch bones
    // on and keep the parent's cubes.
    const lower = (b) => String(b.name).toLowerCase();
    const mergedNames = new Set();
    const bones = parent.bones.map((b) => {
      const own = g.bones.find((c) => lower(c) === lower(b));
      if (!own) return b;
      mergedNames.add(lower(own));
      // The child's cubes are added to the parent's (the sheep's wool goes over its shorn body);
      // "reset": true clears the parent's cubes (armour pieces reset the parts they don't cover)
      return Object.assign({}, b, own, { cubes: (own.reset ? [] : b.cubes || []).concat(own.cubes || []) });
    });
    for (const b of g.bones) if (!mergedNames.has(lower(b))) bones.push(b);
    const merged = { id: g.id, texture_width: g.texture_width || parent.texture_width, texture_height: g.texture_height || parent.texture_height, bones };
    return depth ? merged : withDefaults(merged);
  }

  // ---- Content for a world ----
  function loadContent(fs, { installData, bedrockRoot, world }) {
    const layers = []; // lowest priority first
    for (const dir of vanillaPackDirs(fs, installData)) layers.push(indexPack(fs, dir, 'Minecraft'));
    const rp = world ? worldPacks(fs, world, bedrockRoot, 'resource') : [];
    const bp = world ? worldPacks(fs, world, bedrockRoot, 'behavior') : [];
    for (const pack of rp.slice().reverse()) if (pack.dir) layers.push(indexPack(fs, pack.dir, pack.name));

    const entities = new Map();
    const geometries = new Map();
    const controllers = new Map();
    const animations = new Map();
    const animationControllers = new Map();
    const names = new Map();
    const attachables = new Map(); // item id -> [{ description, layer, condition }]
    const itemNames = new Map();
    const itemTextures = new Map(); // item_texture.json short name -> texture path
    for (const layer of layers) {
      for (const [path, file] of layer.files) {
        if (!path.endsWith('.json') && !path.endsWith('.lang')) continue;
        if (path.endsWith('.lang')) {
          if (!/texts\/en_us\.lang$/.test(path)) continue;
          for (const line of String(file.read()).split(/\r?\n/)) {
            const m = line.match(/^entity\.([^=]+)\.name=([^\t#]+)/);
            if (m) names.set(m[1].trim(), m[2].trim());
            const item = line.match(/^item\.([^=]+?)(?:\.name)?=([^\t#]+)/);
            if (item) itemNames.set(item[1].trim(), item[2].trim());
          }
          continue;
        }
        let json;
        try {
          json = parseLooseJson(file.read());
        } catch (e) {
          continue;
        }
        if (path.startsWith('entity/')) {
          const d = json['minecraft:client_entity'] && json['minecraft:client_entity'].description;
          if (d && d.identifier) entities.set(d.identifier, { description: d, layer });
        } else if (path.startsWith('models/')) {
          collectGeometries(json, geometries);
        } else if (path.startsWith('render_controllers/')) {
          for (const [id, def] of Object.entries(json.render_controllers || {})) controllers.set(id, def);
        } else if (path.startsWith('animations/')) {
          for (const [id, def] of Object.entries(json.animations || {})) animations.set(id, def);
        } else if (path.startsWith('animation_controllers/')) {
          for (const [id, def] of Object.entries(json.animation_controllers || {})) animationControllers.set(id, def);
        } else if (path.startsWith('attachables/') && layer.label !== 'Minecraft') {
          // pack attachables only: they're what draws custom (and restyled vanilla) armour
          const d = json['minecraft:attachable'] && json['minecraft:attachable'].description;
          if (d && d.identifier) {
            const targets = d.item && typeof d.item === 'object' ? Object.entries(d.item) : [[d.identifier, '']];
            for (const [item, condition] of targets) {
              const list = attachables.get(item) || [];
              list.push({ description: d, layer, condition: typeof condition === 'string' ? condition : '' });
              attachables.set(item, list);
            }
          }
        } else if (path === 'textures/item_texture.json') {
          for (const [key, def] of Object.entries(json.texture_data || {})) {
            let t = def && def.textures;
            if (Array.isArray(t)) t = t[0];
            if (t && typeof t === 'object') t = t.path;
            if (typeof t === 'string') itemTextures.set(key, t);
          }
        }
      }
    }
    const items = new Map();
    for (const pack of bp) if (pack.dir) readPackItems(fs, pack, items);
    return { layers, rp, bp, entities, geometries, controllers, animations, animationControllers, names, attachables, itemNames, itemTextures, items };
  }

  // A behavior pack's items: { id -> { slot (for armour), icon, name, source } }.
  function readPackItems(fs, pack, out) {
    const walk = (dir, depth) => {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch (e) {
        return;
      }
      for (const name of names) {
        const full = `${dir}\\${name}`;
        if (/\.json$/i.test(name)) {
          let item;
          try {
            item = parseLooseJson(fs.readFileSync(full))['minecraft:item'];
          } catch (e) {
            continue;
          }
          const id = item && item.description && item.description.identifier;
          if (!id) continue;
          const c = item.components || {};
          const wearable = c['minecraft:wearable'];
          const slot = ARMOR_SLOTS[String((wearable && (wearable.slot || wearable.equip_slot)) || '').toLowerCase()] || '';
          let icon = c['minecraft:icon'];
          if (icon && typeof icon === 'object') icon = icon.texture || (icon.textures && (icon.textures.default || Object.values(icon.textures)[0]));
          const display = c['minecraft:display_name'];
          const tagList = c['minecraft:tags'] && Array.isArray(c['minecraft:tags'].tags) ? c['minecraft:tags'].tags.slice() : [];
          for (const key of Object.keys(c)) if (/^tag:/.test(key)) tagList.push(key.slice(4));
          out.set(id, { id, slot, icon: typeof icon === 'string' ? icon : '', name: display && typeof display.value === 'string' ? display.value : '', source: pack.name, tags: tagList });
        } else if (depth < 6 && !/\.[a-z0-9]{1,5}$/i.test(name)) walk(full, depth + 1);
      }
    };
    walk(`${pack.dir}\\items`, 0);
  }
  const ARMOR_SLOTS = { 'slot.armor.head': 'head', 'slot.armor.chest': 'chest', 'slot.armor.legs': 'legs', 'slot.armor.feet': 'feet' };

  // Evaluates a render-controller condition for an idle entity: every query/variable is 0.
  // Anything too complex counts as "on".
  function idleCondition(expr, flags = null) {
    if (typeof expr !== 'string') return true;
    const js = expr
      .toLowerCase()
      .replace(/\b(query|q|variable|v|temp|t|context|c)\.([a-z0-9_.]+)(\s*\([^)]*\))?/g, (m, kind, name) =>
        flags && (kind === 'query' || kind === 'q') && name in flags ? `(${Number(flags[name]) || 0})` : '0'
      );
    if (/[^0-9.\s<>=!&|?:()+\-*/]/.test(js)) return true;
    try {
      return !!Function(`return (${js});`)();
    } catch (e) {
      return true;
    }
  }

  // The controller that draws the entity itself: on for an idle entity, and not an overlay that
  // hides every part by default (saddles, armour, glow layers).
  function mainController(content, description) {
    const candidates = (description.render_controllers || ['controller.render.default']).map((rc) =>
      typeof rc === 'string' ? { id: rc, on: true } : { id: Object.keys(rc)[0], on: idleCondition(Object.values(rc)[0]) }
    );
    const overlay = (def) => ((def && def.part_visibility) || []).some((p) => p['*'] === false);
    const withDefs = candidates.map((c) => Object.assign(c, { def: content.controllers.get(c.id) }));
    // prefer a controller that draws the entity's default geometry (the copper golem's first one
    // only draws its flower)
    const drawsDefault = (def) => !def || !def.geometry || /geometry\.default/i.test(def.geometry);
    return (
      withDefs.find((c) => c.on && !overlay(c.def) && drawsDefault(c.def)) ||
      withDefs.find((c) => c.on && !overlay(c.def)) ||
      withDefs.find((c) => c.on) ||
      withDefs[0] ||
      {}
    ).def || {};
  }

  // Picks the geometry and texture an entity shows by default (first render controller, first
  // array entry for variants like villager professions or sheep colours).
  function resolveLook(content, description) {
    const controller = mainController(content, description);
    const pick = (expr, kind) => {
      const map = description[kind === 'geometry' ? 'geometry' : 'textures'] || {};
      const arrays = (controller.arrays || {})[kind === 'geometry' ? 'geometries' : 'textures'] || {};
      for (let i = 0; i < 4 && typeof expr === 'string'; i++) {
        let m = expr.match(/^(?:geometry|texture)\.(\w+)$/i);
        if (m) return map[m[1]] || map[m[1].toLowerCase()];
        m = expr.match(/^(array\.\w+)/i);
        if (m) {
          const key = Object.keys(arrays).find((k) => k.toLowerCase() === m[1].toLowerCase());
          expr = key && arrays[key][0];
          continue;
        }
        break;
      }
      return map.default || Object.values(map)[0];
    };
    const geometryId = pick(controller.geometry || 'Geometry.default', 'geometry');
    const texturePath = pick((controller.textures || ['Texture.default'])[0], 'texture');
    const materials = description.materials || {};
    return { geometryId, texturePath, material: materials.default || Object.values(materials)[0] || 'entity_alphatest' };
  }

  // ---- Variants and babies ----
  // An entity's looks come from its render controllers: which geometry and which textures they
  // pick for a given state. A state is a value for each "choice" the controllers index arrays with
  // (query.variant = coat, query.mark_variant = markings or biome, variable.armor_texture_slot =
  // horse armour, variable.profession_index...) plus whether it's a baby. Several texture layers
  // (a horse's coat, markings and armour; a villager's skin, biome outfit and profession) are
  // merged into one texture, since Minecraft's posable copy draws one.
  const LOOK_SKIP_CHOICES = /level|tier|armor_texture_slot_baby/i; // villager level badges stay at the first level
  const MAX_LOOKS_PER_ENTITY = 320;
  const LEATHER_TINT = '#a06540'; // undyed leather (horse armour)

  // A render-controller expression as JavaScript, with queries and variables taken from `state`
  // (else the idle values) and arrays as A(name, index) calls. Null if it's anything fancier.
  function controllerJs(expr, state) {
    const js = String(expr)
      .replace(/\b(array)\.(\w+)\s*\[/gi, (m, a, name) => `A(${JSON.stringify(name)},`)
      .replace(/\]/g, ')')
      .replace(/\b(texture|geometry|material)\.(\w+)/gi, (m, k, name) => JSON.stringify('K:' + name))
      .replace(/\b(query|q|variable|v|temp|t|context|c)\.([a-z0-9_.]+)(\s*\([^()]*\))?/gi, (m, k, name) => {
        const n = name.toLowerCase();
        return `(${Number(state[n] !== undefined ? state[n] : IDLE_QUERIES[n] || 0) || 0})`;
      })
      .replace(/\bmath\.\w+/gi, '0');
    return /[^\s\w"':.,()!?&|<>=+\-*/%]/.test(js) ? null : js;
  }

  // True when a controller condition holds in `state` (unreadable conditions count as true).
  function stateCondition(expr, state) {
    if (expr === true || expr === undefined) return true;
    if (expr === false) return false;
    const js = controllerJs(expr, state);
    if (js === null) return true;
    try {
      return !!Function('A', `return (${js});`)(() => null);
    } catch (e) {
      return true;
    }
  }

  // Evaluates a render-controller expression to a texture/geometry/material key, or null.
  function controllerPick(controller, description, expr, kind, state) {
    if (typeof expr !== 'string') return null;
    const maps = { geometry: 'geometry', texture: 'textures', material: 'materials' };
    const arrayKinds = { geometry: 'geometries', texture: 'textures', material: 'materials' };
    const map = description[maps[kind]] || {};
    const arrays = (controller.arrays || {})[arrayKinds[kind]] || {};
    const find = (obj, key) => obj[Object.keys(obj).find((k) => k.toLowerCase() === String(key).toLowerCase())];
    const js = controllerJs(expr, state);
    if (js === null) return null;
    const A = (name, index) => {
      const list = find(arrays, `Array.${name}`) || [];
      const item = list[Math.max(0, Math.min(list.length - 1, Math.floor(Number(index) || 0)))];
      const m = typeof item === 'string' && item.match(/^(?:texture|geometry|material)\.(\w+)$/i);
      return m ? 'K:' + m[1] : null;
    };
    let result;
    try {
      result = Function('A', `return (${js});`)(A);
    } catch (e) {
      return null;
    }
    const key = typeof result === 'string' && result.startsWith('K:') ? result.slice(2) : null;
    return key ? { key, value: find(map, key) } : null;
  }

  // The controllers that draw the body: the main one, plus same-geometry layers that pick from
  // arrays (a villager's biome/profession outfit and level badge). Overlays that hide everything
  // but a saddle or armour piece are left out.
  function lookControllers(content, description) {
    const main = mainController(content, description);
    const out = [main];
    for (const rc of description.render_controllers || ['controller.render.default']) {
      const id = typeof rc === 'string' ? rc : Object.keys(rc)[0];
      const def = content.controllers.get(id);
      if (!def || def === main) continue;
      const hidesAll = (def.part_visibility || []).some((p) => p['*'] === false);
      const usesArrays = (def.textures || []).some((t) => /\barray\./i.test(String(t)));
      if (!hidesAll && usesArrays) out.push(def);
    }
    return out;
  }

  // The choices an entity's looks depend on: { name, size, labels } for each index expression
  // like query.mark_variant, with labels from the texture keys it selects.
  function lookChoices(content, description) {
    const controllers = lookControllers(content, description);
    const choices = new Map();
    for (const def of controllers) {
      const all = Object.assign({}, (def.arrays || {}).textures, (def.arrays || {}).geometries);
      for (const expr of [def.geometry].concat(def.textures || [])) {
        for (const m of String(expr || '').matchAll(/\barray\.(\w+)\s*\[\s*(?:query|q|variable|v)\.(\w+)\s*\]/gi)) {
          const name = m[2].toLowerCase();
          if (LOOK_SKIP_CHOICES.test(name) || /^baby/i.test(m[1])) continue;
          const key = Object.keys(all).find((k) => k.toLowerCase() === `array.${m[1]}`.toLowerCase());
          if (!key) continue;
          const labels = all[key].map((t) => String(t).replace(/^(texture|geometry)\./i, ''));
          // a choice whose options all look the same (a villager's six identical skins) isn't one
          const map = Object.assign({}, description.textures, description.geometry);
          const paths = new Set(labels.map((l) => map[l] || l));
          if (paths.size < 2) continue;
          // name the options from the plain array (not the angry/tame/sleeping ones)
          const plainness = (arr) => (/angry|tame|sleep|saddle|baby/i.test(arr) ? 0 : 2) + (/^(default|skins?|base|textures?|variants?)$/i.test(arr) ? 1 : 0);
          const known = choices.get(name);
          if (!known || plainness(m[1]) > plainness(known.array) || (plainness(m[1]) === plainness(known.array) && labels.length > known.size)) {
            choices.set(name, { name, array: m[1], size: labels.length, labels });
          }
        }
      }
    }
    return [...choices.values()];
  }

  // Geometry and texture layers for one state.
  function lookFor(content, description, state) {
    const controllers = lookControllers(content, description);
    const main = controllers[0];
    const geometry = controllerPick(main, description, main.geometry || 'Geometry.default', 'geometry', state);
    const layers = [];
    controllers.forEach((def, n) => {
      // a layer controller only draws when its visibility rule holds for this state
      if (n > 0) {
        const all = (def.part_visibility || []).find((p) => '*' in p);
        if (all && !stateCondition(all['*'], state)) return;
      }
      let textures = def.textures || (n === 0 ? ['Texture.default'] : []);
      // a material chosen by a condition that lands on the plain one draws only the first texture
      // (a baby villager's outfit shows its biome, not a profession)
      const matExpr = def.materials && def.materials[0] && Object.values(def.materials[0])[0];
      if (n > 0 && typeof matExpr === 'string' && matExpr.includes('?')) {
        const mat = controllerPick(def, description, matExpr, 'material', state);
        if (mat && !/mask|multi|layer/i.test(mat.key)) textures = textures.slice(0, 1);
      }
      for (const expr of textures) {
        const pick = controllerPick(def, description, expr, 'texture', state);
        if (pick && pick.value && !/_none$|^none$/i.test(pick.key)) layers.push({ key: pick.key, path: pick.value });
      }
    });
    return { geometry, layers };
  }

  const cleanLabel = (key) =>
    String(key || '')
      .replace(/^baby_?/i, '')
      .replace(/_?(default|base|skin)$/i, '')
      .replace(/^(base|skin|markings|armor|armour|decor|biome)_/i, '')
      .replace(/_/g, ' ')
      .trim() || 'default';

  // Every look of a list entry, baby versions included (the plain entry first). Each is an entry of
  // its own: { ...entry, geometryId, texturePath, layers, choices, flags, variant, baby }.
  function variantEntries(content, entry) {
    const entity = content.entities.get(entry.id);
    if (!entity) return [entry];
    const description = entity.description;
    const choices = lookChoices(content, description);
    const out = [];
    const seen = new Set();
    // every combination of choices (capped), adults then babies
    const combos = [{}];
    for (const c of choices) {
      const next = [];
      for (const combo of combos) for (let i = 0; i < c.size && next.length < MAX_LOOKS_PER_ENTITY * 4; i++) next.push(Object.assign({}, combo, { [c.name]: i }));
      combos.splice(0, combos.length, ...next);
    }
    for (const baby of [0, 1]) {
      for (const combo of combos) {
        if (out.length >= MAX_LOOKS_PER_ENTITY) break;
        // pre-animation variables that follow a query (villager: profession_index = query.variant)
        const state = Object.assign({ is_baby: baby }, combo);
        if (combo.profession_index !== undefined && state.variant === undefined) state.variant = combo.profession_index;
        const look = lookFor(content, description, state);
        const geometryId = (look.geometry && look.geometry.value) || entry.geometryId;
        const layers = look.layers.length ? look.layers : [{ key: 'default', path: entry.texturePath }];
        const geometry = geometryId && resolveGeometry(content.geometries, geometryId);
        if (!geometry || !geometry.bones.length || !layers.every((l) => findTexture(content, l.path))) continue;
        const signature = `${geometryId}|${layers.map((l) => l.path).join('+')}`;
        // a baby only counts when it looks different from every adult
        if (baby && out.some((v) => !v.baby && v.signature === signature)) continue;
        if (seen.has(`${signature}|${baby}`)) continue;
        seen.add(`${signature}|${baby}`);
        const labels = choices.map((c) => cleanLabel(c.labels[combo[c.name]]));
        out.push(Object.assign({}, entry, {
          geometryId,
          texturePath: layers.length === 1 ? layers[0].path : `textures/entity/pose_studio/looks/${hashString(signature)}`,
          layers: layers.length > 1 ? layers : null,
          signature,
          choices: Object.assign({}, combo),
          baby: !!baby,
          flags: baby ? { is_baby: 1 } : null,
          variant: labels.filter((l) => l !== 'default' && l !== 'none' && l !== 'unskilled').join(' ') || 'default',
        }));
      }
    }
    const plain = out.findIndex((v) => !v.baby && v.geometryId === entry.geometryId && v.texturePath === entry.texturePath);
    if (plain > 0) out.unshift(out.splice(plain, 1)[0]);
    else if (plain < 0 && !out.some((v) => !v.baby)) out.unshift(Object.assign({}, entry, { baby: false, flags: null, variant: 'default', choices: {} }));
    out.choiceList = choices.map((c) => ({ name: c.name, label: choiceTitle(c), values: c.labels.map(cleanLabel) }));
    return out;
  }

  function choiceTitle(choice) {
    const a = choice.array.toLowerCase();
    if (/armou?r/.test(a)) return 'Armour';
    if (/marking/.test(a)) return 'Markings';
    if (/biome/.test(a)) return 'Biome';
    if (/profession/.test(a)) return 'Profession';
    if (/decor/.test(a)) return 'Decor';
    if (/default|base|skin|coat|variant|texture/.test(a)) return 'Variant';
    return a.replace(/_/g, ' ').replace(/^\w/, (ch) => ch.toUpperCase());
  }

  // The merged texture of a multi-layer look, as a PNG data URL (layers drawn bottom to top at the
  // first layer's size; undyed leather armour tinted brown as in game).
  const layerImageCache = new Map();
  async function layeredTextureUrl(content, entry) {
    const images = [];
    for (const layer of entry.layers) {
      let img = layerImageCache.get(layer.path);
      if (!img) {
        const found = findTexture(content, layer.path);
        if (!found) continue;
        img = await loadImage(textureDataUrl(found.file.read(), found.ext));
        layerImageCache.set(layer.path, img);
      }
      images.push({ img, tint: /leather/i.test(layer.key) ? LEATHER_TINT : null });
    }
    if (!images.length) return null;
    const w = images[0].img.width;
    const h = images[0].img.height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    for (const { img, tint } of images) {
      if (!tint) {
        ctx.drawImage(img, 0, 0, w, h);
        continue;
      }
      // tint just this layer, then draw it over the others
      const layer = document.createElement('canvas');
      layer.width = w;
      layer.height = h;
      const lctx = layer.getContext('2d');
      lctx.drawImage(img, 0, 0, w, h);
      lctx.globalCompositeOperation = 'multiply';
      lctx.fillStyle = tint;
      lctx.fillRect(0, 0, w, h);
      lctx.globalCompositeOperation = 'destination-in';
      lctx.drawImage(img, 0, 0, w, h);
      ctx.drawImage(layer, 0, 0);
    }
    return canvas.toDataURL('image/png');
  }

  // Finds a texture file in the highest-priority layer that has it.
  function findTexture(content, texturePath) {
    if (!texturePath) return null;
    const base = texturePath.toLowerCase().replace(/\\/g, '/');
    for (let i = content.layers.length - 1; i >= 0; i--) {
      for (const ext of ['.png', '.tga', '.jpg', '.jpeg']) {
        const file = content.layers[i].files.get(base + ext);
        if (file) return { ext, file, layer: content.layers[i] };
      }
    }
    return null;
  }

  function prettyName(id) {
    return id.replace(/^[^:]+:/, '').replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // The browser list: every client entity with a resolvable model.
  function entityList(content) {
    const list = [];
    for (const [id, { description, layer }] of content.entities) {
      if (/^pose:/.test(id)) continue;
      const look = resolveLook(content, description);
      const geometry = look.geometryId && resolveGeometry(content.geometries, look.geometryId);
      if (!geometry || !geometry.bones.length) continue;
      const short = id.replace(/^minecraft:/, '');
      list.push({
        id,
        name: content.names.get(short) || content.names.get(id) || prettyName(id),
        source: layer.label,
        geometryId: look.geometryId,
        texturePath: look.texturePath,
        material: look.material,
      });
    }
    return list.sort((a, b) => (a.source === 'Minecraft') - (b.source === 'Minecraft') || a.name.localeCompare(b.name));
  }
  // </scanner>

  // <model>
  // ---- Bedrock geometry -> Blockbench data / three.js ---------------------------------------
  // bedrockToBlockbench mirrors Blockbench's own Bedrock importer (X mirrored, X/Y rotations
  // flipped, up/down face UVs swapped), so imported entities look exactly like opening the model
  // in Blockbench. buildThreeModel renders that data the way Blockbench's viewport does; it's used
  // for thumbnails.
  const FACE_ORDER = ['east', 'west', 'up', 'down', 'south', 'north']; // THREE.BoxGeometry order

  function bedrockToBlockbench(geometry) {
    const bones = [];
    for (const b of geometry.bones || []) {
      const bone = {
        name: b.name,
        parent: b.parent || null,
        origin: b.pivot ? [-b.pivot[0], b.pivot[1], b.pivot[2]] : [0, 0, 0],
        rotation: b.rotation ? [-b.rotation[0], -b.rotation[1], b.rotation[2]] : [0, 0, 0],
        mirror: b.mirror === true,
        cubes: [],
      };
      // neverRender bones (hand / armour attachment points) stay as empty groups
      for (const c of b.neverRender ? [] : b.cubes || []) {
        if (!c.origin || !c.size) continue;
        const from = [-(c.origin[0] + c.size[0]), c.origin[1], c.origin[2]];
        const cube = {
          from,
          to: [from[0] + c.size[0], from[1] + c.size[1], from[2] + c.size[2]],
          // Bedrock rotates a cube around its centre when no pivot is given.
          origin: c.pivot ? [-c.pivot[0], c.pivot[1], c.pivot[2]] : [from[0] + c.size[0] / 2, c.origin[1] + c.size[1] / 2, c.origin[2] + c.size[2] / 2],
          rotation: c.rotation ? [-c.rotation[0], -c.rotation[1], c.rotation[2]] : [0, 0, 0],
          inflate: typeof c.inflate === 'number' ? c.inflate : typeof b.inflate === 'number' ? b.inflate : 0,
          mirror_uv: c.mirror === undefined ? bone.mirror : c.mirror === true,
          box_uv: !c.uv || Array.isArray(c.uv),
          uv_offset: Array.isArray(c.uv) ? c.uv.slice(0, 2) : [0, 0],
          faces: {},
        };
        if (!cube.box_uv) {
          const [sx, sy, sz] = c.size;
          const auto = { north: [sx, sy], south: [sx, sy], east: [sz, sy], west: [sz, sy], up: [sx, sz], down: [sx, sz] };
          for (const key of FACE_ORDER) {
            const f = c.uv[key];
            if (!f || !f.uv) {
              cube.faces[key] = { enabled: false };
              continue;
            }
            const [w, h] = f.uv_size || auto[key];
            let uv = [f.uv[0], f.uv[1], f.uv[0] + w, f.uv[1] + h];
            if (key === 'up' || key === 'down') uv = [uv[2], uv[3], uv[0], uv[1]];
            cube.faces[key] = { enabled: true, uv, rotation: f.uv_rotation || 0 };
          }
        }
        bone.cubes.push(cube);
      }
      bones.push(bone);
    }
    return { bones, texture_width: geometry.texture_width, texture_height: geometry.texture_height };
  }

  // Box UV face rectangles, exactly as Blockbench lays them out.
  function boxUvFaces(cube) {
    const size = [0, 1, 2].map((i) => Math.floor(cube.to[i] - cube.from[i] + 0.0000001));
    const list = [
      { face: 'east', from: [0, size[2]], size: [size[2], size[1]] },
      { face: 'west', from: [size[2] + size[0], size[2]], size: [size[2], size[1]] },
      { face: 'up', from: [size[2] + size[0], size[2]], size: [-size[0], -size[2]] },
      { face: 'down', from: [size[2] + size[0] * 2, 0], size: [-size[0], size[2]] },
      { face: 'south', from: [size[2] * 2 + size[0], size[2]], size: [size[0], size[1]] },
      { face: 'north', from: [size[2], size[2]], size: [size[0], size[1]] },
    ];
    if (cube.mirror_uv) {
      for (const f of list) {
        f.from[0] += f.size[0];
        f.size[0] *= -1;
      }
      [list[0].from, list[1].from] = [list[1].from, list[0].from];
      [list[0].size, list[1].size] = [list[1].size, list[0].size];
    }
    const faces = {};
    for (const f of list) {
      const [ou, ov] = cube.uv_offset;
      faces[f.face] = { enabled: true, rotation: 0, uv: [f.from[0] + ou, f.from[1] + ov, f.from[0] + f.size[0] + ou, f.from[1] + f.size[1] + ov] };
    }
    return faces;
  }

  function euler(rotation, order) {
    return new THREE.Euler((rotation[0] * Math.PI) / 180, (rotation[1] * Math.PI) / 180, (rotation[2] * Math.PI) / 180, order || 'ZYX');
  }

  // Builds a THREE.Group like Blockbench's viewport: bones are nested pivots, each cube is a box
  // around its own pivot, UVs follow Blockbench's per-face vertex mapping.
  function buildThreeModel(model, material, order) {
    const pw = model.texture_width || 64;
    const ph = model.texture_height || 64;
    const root = new THREE.Group();
    const nodes = new Map();
    for (const bone of model.bones) {
      const node = new THREE.Group();
      node.rotation.copy(euler(bone.rotation, order));
      nodes.set(bone.name.toLowerCase(), { node, bone });
    }
    for (const { node, bone } of nodes.values()) {
      const parent = bone.parent && nodes.get(bone.parent.toLowerCase());
      const parentOrigin = parent ? parent.bone.origin : [0, 0, 0];
      node.position.set(bone.origin[0] - parentOrigin[0], bone.origin[1] - parentOrigin[1], bone.origin[2] - parentOrigin[2]);
      (parent ? parent.node : root).add(node);

      for (const cube of bone.cubes) {
        const inflate = cube.inflate || 0;
        const size = [0, 1, 2].map((i) => Math.max(cube.to[i] - cube.from[i] + inflate * 2, 0.001));
        const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
        const faces = cube.box_uv ? boxUvFaces(cube) : cube.faces;
        const uvAttr = geometry.attributes.uv;
        const index = [];
        FACE_ORDER.forEach((key, i) => {
          const face = faces[key];
          if (!face || !face.enabled) return;
          let uv = face.uv.slice();
          if (cube.box_uv) {
            for (let si = 0; si < 2; si++) {
              const margin = uv[si] > uv[si + 2] ? -1 / 64 : 1 / 64;
              uv[si] += margin;
              uv[si + 2] -= margin;
            }
          }
          let arr = [
            [uv[0] / pw, 1 - uv[1] / ph],
            [uv[2] / pw, 1 - uv[1] / ph],
            [uv[0] / pw, 1 - uv[3] / ph],
            [uv[2] / pw, 1 - uv[3] / ph],
          ];
          for (let rot = face.rotation || 0; rot > 0; rot -= 90) arr = [arr[2], arr[0], arr[3], arr[1]];
          arr.forEach((p, v) => uvAttr.setXY(i * 4 + v, p[0], p[1]));
          index.push(i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 2, i * 4 + 3, i * 4 + 1);
        });
        geometry.setIndex(index);
        uvAttr.needsUpdate = true;
        const mesh = new THREE.Mesh(geometry, material);
        const pivot = new THREE.Group();
        pivot.position.set(cube.origin[0] - bone.origin[0], cube.origin[1] - bone.origin[1], cube.origin[2] - bone.origin[2]);
        pivot.rotation.copy(euler(cube.rotation, order));
        mesh.position.set(
          (cube.from[0] + cube.to[0]) / 2 - cube.origin[0],
          (cube.from[1] + cube.to[1]) / 2 - cube.origin[1],
          (cube.from[2] + cube.to[2]) / 2 - cube.origin[2]
        );
        pivot.add(mesh);
        node.add(pivot);
      }
    }
    return root;
  }

  // Minimal TGA decoder (true-colour/greyscale, raw or RLE) -> RGBA ImageData-like object.
  function decodeTga(bytes) {
    const type = bytes[2];
    const width = bytes[12] | (bytes[13] << 8);
    const height = bytes[14] | (bytes[15] << 8);
    const depth = bytes[16];
    const topLeft = (bytes[17] & 0x20) !== 0;
    const bpp = depth / 8;
    const rle = type === 10 || type === 11;
    const grey = type === 3 || type === 11;
    if (![2, 3, 10, 11].includes(type) || ![1, 3, 4].includes(bpp)) throw new Error(`Unsupported TGA (type ${type}, ${depth}-bit)`);
    const data = new Uint8ClampedArray(width * height * 4);
    let p = 18 + bytes[0];
    let n = 0;
    const put = (at) => {
      const x = n % width;
      const y = Math.floor(n / width);
      const o = ((topLeft ? y : height - 1 - y) * width + x) * 4;
      if (grey) {
        data[o] = data[o + 1] = data[o + 2] = bytes[at];
        data[o + 3] = 255;
      } else {
        data[o] = bytes[at + 2];
        data[o + 1] = bytes[at + 1];
        data[o + 2] = bytes[at];
        data[o + 3] = bpp === 4 ? bytes[at + 3] : 255;
      }
      n++;
    };
    while (n < width * height) {
      if (!rle) {
        put(p);
        p += bpp;
        continue;
      }
      const header = bytes[p++];
      const count = (header & 0x7f) + 1;
      if (header & 0x80) {
        for (let i = 0; i < count; i++) put(p);
        p += bpp;
      } else {
        for (let i = 0; i < count; i++) {
          put(p);
          p += bpp;
        }
      }
    }
    return { width, height, data };
  }

  // Texture file bytes -> PNG data URL (TGA converted through a canvas).
  function textureDataUrl(bytes, ext) {
    if (ext !== '.tga') return `data:image/${ext === '.png' ? 'png' : 'jpeg'};base64,` + bufferClass().from(bytes).toString('base64');
    const img = decodeTga(bytes);
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    return canvas.toDataURL('image/png');
  }

  // Renders a model to a small PNG. One shared offscreen renderer.
  let thumbRenderer = null;
  function renderThumbnail(model, image, size = 128) {
    if (!thumbRenderer) {
      thumbRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
      thumbRenderer.setPixelRatio(1);
    }
    thumbRenderer.setSize(size, size, false);
    const texture = new THREE.Texture(image);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    const material = new THREE.MeshLambertMaterial({ map: image ? texture : null, color: image ? 0xffffff : 0xb0b0b0, alphaTest: 0.05, side: THREE.DoubleSide });
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 0.55);
    sun.position.set(-0.4, 1, -0.7);
    scene.add(sun);
    const object = buildThreeModel(model, material);
    scene.add(object);

    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, radius * 20);
    // three-quarter view from the front (entities face -Z in Blockbench space)
    const dir = new THREE.Vector3(-0.55, 0.45, -1).normalize();
    camera.position.copy(center).addScaledVector(dir, radius / Math.sin((15 * Math.PI) / 180));
    camera.lookAt(center);
    thumbRenderer.render(scene, camera);
    const url = thumbRenderer.domElement.toDataURL('image/png');
    object.traverse((o) => o.geometry && o.geometry.dispose());
    material.dispose();
    texture.dispose();
    return url;
  }
  // </model>

  // ---- Entities ------------------------------------------------------------------------------
  // "Add Entity…" lists every entity available in the world you're in (vanilla plus the world's
  // resource packs), with thumbnails. Picking one builds its real model in Blockbench as an ent_
  // group. In Minecraft it appears as a generated "posable copy" (pose:px_<hash>) that uses the
  // same geometry, texture and material, with its bones driven from Blockbench.
  const ENTITY_PREFIX = /^ent_/i;
  const MAX_POSABLE_BONES = 19; // 30 int properties, two 12-bit angles each: pose_root + 19 bones
  const PROXY_ROOT_BONE = 'pose_root';
  const PACKED_PROPS = 30;
  const ANGLE_STEP = 360 / 4096;
  const NEUTRAL_PACKED = 2048 * 4096 + 2048; // both angles 0°

  function bedrockRoot() {
    return storedFolder('pose_studio_bedrock_folder') || defaultBedrockRoot();
  }
  const defaultBedrockRoot = () => `${SystemInfo.appdata_directory}\\Minecraft Bedrock`;

  // ---- Folders -------------------------------------------------------------------------------
  // Where scenes are saved (a shared Dropbox folder, say) and where Minecraft keeps its data
  // (worlds and development packs). Both are set in Pose Studio ▸ More ▸ Folders…
  const defaultScenesFolder = () => `${SystemInfo.home_directory}\\Documents\\Pose Studio\\Scenes`;
  function storedFolder(key) {
    try {
      return localStorage.getItem(key) || '';
    } catch (e) {
      return '';
    }
  }
  function storeFolder(key, value) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch (e) {
      // storage unavailable
    }
  }
  function scenesFolder() {
    return storedFolder('pose_studio_scenes_folder') || defaultScenesFolder();
  }
  // the scenes folder, plus the default one (scenes saved before the folder was changed)
  function sceneFolders() {
    const folders = [scenesFolder()];
    if (!samePath(folders[0], defaultScenesFolder())) folders.push(defaultScenesFolder());
    return folders;
  }
  // File access to a scenes folder (the default one keeps the permission it always asked for).
  function sceneFs(folder, quiet) {
    const scope = samePath(folder, defaultScenesFolder()) ? dirName(folder) : folder;
    return requireNativeModule('fs', { scope, message: `Pose Studio saves scenes in, and finds them in, ${folder}.`, show_permission_dialog: !quiet });
  }

  // Every .bbmodel in the scenes folders (and up to three folders deep), listed every few seconds.
  let sceneIndex = null;
  function sceneFileList() {
    if (sceneIndex && Date.now() - sceneIndex.at < 5000) return sceneIndex.files;
    const files = [];
    sceneFolders().forEach((folder, i) => {
      let sfs = null;
      try {
        sfs = sceneFs(folder, i > 0);
      } catch (e) {
        sfs = null;
      }
      if (!sfs || !sfs.existsSync(folder)) return;
      const walk = (dir, depth) => {
        let names = [];
        try {
          names = sfs.readdirSync(dir);
        } catch (e) {
          return;
        }
        for (const name of names) {
          if (files.length >= 5000 || name.startsWith('.')) continue;
          const path = `${dir}\\${name}`;
          if (/\.bbmodel$/i.test(name)) {
            files.push({ path, fs: sfs });
            continue;
          }
          if (depth >= 3 || /\.[a-z0-9]{1,5}$/i.test(name)) continue; // files other than scenes
          try {
            if (sfs.statSync(path).isDirectory()) walk(path, depth + 1);
          } catch (e) {
            // gone or unreadable
          }
        }
      };
      walk(folder, 0);
    });
    sceneIndex = { at: Date.now(), files };
    return files;
  }

  // A location's scene path as saved in the world can come from someone else's PC (worlds shared
  // through git): it's found in this PC's scenes folder by its file name.
  function resolveScenePath(path) {
    if (!path) return path;
    const files = sceneFileList();
    if (files.some((f) => samePath(f.path, path))) return path;
    const home = forwardSlashes(SystemInfo.home_directory || '').toLowerCase();
    const mine = home && forwardSlashes(path).toLowerCase().startsWith(home + '/');
    if (mine) {
      // a scene of yours saved somewhere else: keep it unless it's known to be gone
      let exists = null;
      try {
        const dfs = requireNativeModule('fs', { scope: dirName(path), show_permission_dialog: false });
        if (dfs) exists = dfs.existsSync(path);
      } catch (e) {
        exists = null;
      }
      if (exists !== false) return path;
    }
    const name = fileName(path).toLowerCase();
    const match = files.find((f) => fileName(f.path).toLowerCase() === name);
    return match ? match.path : path;
  }

  // A world's name as Minecraft shows it: levelname.txt, otherwise level.dat's LevelName.
  function worldFolderName(wfs, worldPath) {
    try {
      const name = String(wfs.readFileSync(`${worldPath}\\levelname.txt`, 'utf8')).trim();
      if (name) return name;
    } catch (e) {
      // no levelname.txt
    }
    return levelDatName(wfs, worldPath);
  }
  function levelDatName(wfs, worldPath) {
    try {
      const buf = wfs.readFileSync(`${worldPath}\\level.dat`);
      for (let i = buf.indexOf('LevelName'); i >= 3; i = buf.indexOf('LevelName', i + 1)) {
        if (buf[i - 3] !== 8 || buf.readUInt16LE(i - 2) !== 9) continue; // a string tag named LevelName
        const length = buf.readUInt16LE(i + 9);
        const name = buf.toString('utf8', i + 11, i + 11 + length).trim();
        if (name) return name;
      }
    } catch (e) {
      // no level.dat
    }
    return '';
  }

  // A world picked by hand (Locations ▸ Pick Minecraft World…), kept per world.
  function pickedWorlds() {
    try {
      return JSON.parse(localStorage.getItem('pose_studio_world_folders') || '{}') || {};
    } catch (e) {
      return {};
    }
  }
  function storePickedWorlds(map) {
    try {
      localStorage.setItem('pose_studio_world_folders', JSON.stringify(map));
    } catch (e) {
      // storage unavailable
    }
  }
  function pickedWorldFolder() {
    const map = pickedWorlds();
    const id = connectedWorld && connectedWorld.id;
    return (id ? map[id] : map['']) || '';
  }
  // a world picked before Minecraft connected belongs to the world that connects
  function adoptPickedWorld(worldId) {
    const map = pickedWorlds();
    if (!worldId || !map[''] || map[worldId]) return;
    map[worldId] = map[''];
    delete map[''];
    storePickedWorlds(map);
  }
  function pickedWorldInfo() {
    const path = pickedWorldFolder();
    if (!path) return null;
    try {
      const wfs = bedrockFs();
      if (!wfs.existsSync(`${path}\\level.dat`)) return null;
      return { id: fileName(path), name: worldFolderName(wfs, path) || fileName(path), path, lastActive: Infinity, picked: true };
    } catch (e) {
      return null;
    }
  }
  // the worlds for the entity browser: the picked one first
  function worldChoices() {
    const worlds = listWorlds(bedrockFs(), bedrockRoot());
    const picked = pickedWorldInfo();
    if (!picked) return worlds;
    return [picked].concat(worlds.filter((w) => !samePath(w.path, picked.path)));
  }

  // Locations ▸ Pick Minecraft World…: for when the open world isn't found by itself (the most
  // recently played world folder is used otherwise).
  function pickWorldFolder() {
    const current = pickedWorldFolder();
    if (current) {
      Blockbench.showMessageBox(
        {
          title: 'Pose Studio',
          message: `Pose Studio is using this world folder:\n${current}`,
          buttons: ['Pick Another…', 'Find It Automatically', 'Cancel'],
          confirm: 0,
          cancel: 2,
        },
        (button) => {
          if (button === 0) chooseWorldFolder();
          if (button === 1) {
            const map = pickedWorlds();
            delete map[(connectedWorld && connectedWorld.id) || ''];
            storePickedWorlds(map);
            browserWorlds = [];
            Blockbench.showQuickMessage('Pose Studio finds the world by itself again (the most recently played one)', 3000);
          }
        }
      );
      return;
    }
    chooseWorldFolder();
  }

  function chooseWorldFolder() {
    let start = bedrockRoot();
    try {
      const bfs = bedrockFs();
      const mojang = mojangFolders(bfs, bedrockRoot()).find((m) => bfs.existsSync(`${m}\\minecraftWorlds`));
      if (mojang) start = `${mojang}\\minecraftWorlds`;
    } catch (e) {
      // start at the data folder
    }
    const picked = Blockbench.pickDirectory({ title: 'Pick the Minecraft world folder (the one with level.dat)', startpath: start, resource_id: 'pose_studio_world' });
    if (picked) useWorldFolder(String(picked).replace(/[\\/]+$/, ''));
  }

  function useWorldFolder(folder) {
    // it has to be inside the Minecraft data folder Pose Studio reads (a different install, like
    // Preview, changes the data folder)
    const inside = (root) => forwardSlashes(folder).toLowerCase().startsWith(forwardSlashes(root).toLowerCase() + '/');
    if (!inside(bedrockRoot())) {
      const m = /^(.*?)[\\/]Users[\\/][^\\/]+[\\/]games[\\/]com\.mojang[\\/]/i.exec(folder);
      if (!m) {
        Blockbench.showMessageBox({ title: 'Pose Studio', message: `That folder isn't in the Minecraft data folder Pose Studio uses:\n${bedrockRoot()}\n\nWorlds live in ...\\Users\\<account>\\games\\com.mojang\\minecraftWorlds. If Minecraft keeps its data elsewhere, set it in Pose Studio ▸ More ▸ Folders….` });
        return;
      }
      storeFolder('pose_studio_bedrock_folder', samePath(m[1], defaultBedrockRoot()) ? '' : m[1]);
      foldersChanged();
      Blockbench.showQuickMessage(`Minecraft data folder is now ${m[1]}`, 3000);
    }
    const wfs = bedrockFs();
    let world = folder;
    if (!wfs.existsSync(`${world}\\level.dat`)) {
      let names = [];
      try {
        names = wfs.readdirSync(folder);
      } catch (e) {
        names = [];
      }
      const inner = names.filter((n) => wfs.existsSync(`${folder}\\${n}\\level.dat`));
      if (inner.length === 1) world = `${folder}\\${inner[0]}`;
      else {
        const zips = names.some((n) => /\.(zip|mcworld)$/i.test(n));
        Blockbench.showMessageBox({
          title: 'Pose Studio',
          message: zips
            ? "That folder holds zipped worlds (like ToolBox's world_files). Pick the world folder Minecraft plays from instead: the one with level.dat and a db folder (for ToolBox, the folder that contains world_files)."
            : "That folder isn't a Minecraft world: pick the folder with level.dat and a db folder in it.",
        });
        return;
      }
    }
    const map = pickedWorlds();
    map[(connectedWorld && connectedWorld.id) || ''] = world;
    storePickedWorlds(map);
    browserWorlds = [];
    const name = worldFolderName(wfs, world) || fileName(world);
    if (connectedWorld && !connectedWorld.name) connectedWorld.name = name;
    Blockbench.showQuickMessage(`Pose Studio is using the world "${name}"`, 3000);
  }

  // Pose Studio ▸ More ▸ Folders…
  function foldersDialog() {
    const dialog = new Dialog({
      id: 'pose_studio_folders',
      title: 'Pose Studio Folders',
      width: 640,
      form: {
        scenes: { label: 'Scenes folder', type: 'folder', value: scenesFolder() },
        scenes_info: { type: 'info', text: "Where Save Location saves scenes, and where they're looked for when a world opens (with its subfolders). A shared folder (Dropbox, say) lets everyone open the same locations: scenes are found by file name, wherever each person's copy of the folder is." },
        bedrock: { label: 'Minecraft data folder', type: 'folder', value: bedrockRoot() },
        bedrock_info: { type: 'info', text: 'Where Minecraft keeps its worlds and development packs. Normally %APPDATA%\\Minecraft Bedrock; change it for another install (Minecraft Preview: Minecraft Bedrock Preview).' },
      },
      buttons: ['Save', 'Use Defaults', 'Cancel'],
      confirmIndex: 0,
      cancelIndex: 2,
      onButton(index) {
        if (index !== 1) return;
        storeFolder('pose_studio_scenes_folder', '');
        storeFolder('pose_studio_bedrock_folder', '');
        foldersChanged();
        Blockbench.showQuickMessage('Pose Studio uses the default folders', 2500);
      },
      onConfirm(form) {
        const scenes = String(form.scenes || '').replace(/[\\/]+$/, '');
        const bedrock = String(form.bedrock || '').replace(/[\\/]+$/, '');
        storeFolder('pose_studio_scenes_folder', !scenes || samePath(scenes, defaultScenesFolder()) ? '' : scenes);
        storeFolder('pose_studio_bedrock_folder', !bedrock || samePath(bedrock, defaultBedrockRoot()) ? '' : bedrock);
        foldersChanged();
        try {
          if (!bedrockFs().existsSync(`${bedrockRoot()}\\Users`)) {
            Blockbench.showMessageBox({ title: 'Pose Studio', message: `There's no Users folder in ${bedrockRoot()}, so it doesn't look like Minecraft's data folder. Worlds and packs won't be found there.` });
            return;
          }
        } catch (e) {
          // permission denied: reported when it's used
        }
        Blockbench.showQuickMessage(`Scenes: ${scenesFolder()}`, 3000);
      },
    });
    dialog.show();
  }
  function foldersChanged() {
    bedrockFsCache = null;
    sceneIndex = null;
    browserWorlds = [];
  }

  // 0.40 could write tilted copies of a world's lighting into Pose Studio's resource pack (the sun
  // tilt, since removed). Take them away so the packs' own lighting applies again.
  function removeSunTiltLighting() {
    try {
      const fs = bedrockFs();
      const dir = `${devPackDir('resource')}\\lighting`;
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      localStorage.removeItem('pose_studio_sun_written');
    } catch (e) {
      // nothing to remove, or no access
    }
  }

  // Pose Studio ▸ More ▸ Install Minecraft Packs: downloads the packs into this PC's development
  // pack folders, ready to add to any world.
  async function installPacksNow() {
    const base = updateBase();
    if (!base) {
      Blockbench.showMessageBox({ title: 'Pose Studio', message: `This copy was installed from a file, so it can't download the packs. Install the plugin with File > Plugins > Load Plugin from URL:\n\n${PLUGIN_URL}` });
      return;
    }
    let packList;
    try {
      packList = await fetchRepo(base, 'packs.json');
    } catch (e) {
      return showError('Pose Studio: downloading the Minecraft packs', e);
    }
    const firstInstall = !!installedPacks().missing;
    try {
      await installPacks(base, packList);
    } catch (e) {
      Blockbench.setProgress(0);
      return showError('Pose Studio: installing the Minecraft packs', e);
    }
    if (!firstInstall && link.connected) reloadMinecraftPacks();
    Blockbench.showMessageBox({
      title: 'Pose Studio',
      message:
        `The Pose Studio packs are installed in:\n${devPackDir('behavior')}\n${devPackDir('resource')}\n\n` +
        'In Minecraft: Edit World > Behavior Packs and Resource Packs > add "Pose Studio" to both, and turn on cheats. Then open the world and Connect to Minecraft.' +
        (firstInstall ? '' : '\n\nWorlds that already have the packs pick up the update when they reopen.'),
    });
  }
  function devPackDir(kind) {
    const folder = kind === 'behavior' ? 'development_behavior_packs\\PoseStudio_BP' : 'development_resource_packs\\PoseStudio_RP';
    return `${bedrockRoot()}\\Users\\Shared\\games\\com.mojang\\${folder}`;
  }

  let bedrockFsCache = null;
  function bedrockFs() {
    if (bedrockFsCache) return bedrockFsCache;
    const fs = requireNativeModule('fs', { scope: bedrockRoot(), message: 'Pose Studio reads your worlds and packs, and writes its posable copies into its development packs.' });
    if (!fs) throw new Error('Access to the Minecraft Bedrock folder was denied.');
    return (bedrockFsCache = fs);
  }

  // The Minecraft install's data folder (vanilla packs), found once via PowerShell.
  let installDataCache = null;
  function findInstallData() {
    if (installDataCache) return Promise.resolve(installDataCache);
    try {
      const saved = localStorage.getItem('pose_studio_install_data');
      if (saved) return Promise.resolve((installDataCache = saved));
    } catch (e) {
      // storage unavailable
    }
    const childProcess = nodeRequire('child_process', 'find where Minecraft is installed');
    if (!childProcess) return Promise.reject(new Error('Permission to find the Minecraft install was denied.'));
    const script = "$p = Get-AppxPackage -Name Microsoft.MinecraftUWP; if (-not $p) { $p = Get-AppxPackage -Name Microsoft.MinecraftWindowsBeta }; if ($p) { Write-Output $p.InstallLocation }";
    return new Promise((resolve, reject) => {
      childProcess.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err, stdout) => {
        const dir = String(stdout || '').trim();
        if (err || !dir) return reject(new Error('Could not find the Minecraft Bedrock install.'));
        installDataCache = `${dir}\\data`;
        try {
          localStorage.setItem('pose_studio_install_data', installDataCache);
        } catch (e) {
          // storage unavailable
        }
        resolve(installDataCache);
      });
    });
  }

  let installFsCache = null;
  function installFs(installData) {
    if (installFsCache) return installFsCache;
    const fs = requireNativeModule('fs', { scope: installData, message: "Pose Studio reads Minecraft's built-in models and textures." });
    if (!fs) throw new Error('Access to the Minecraft install was denied.');
    return (installFsCache = fs);
  }

  // One fs-like object over both roots (the scanner only reads).
  function combinedFs(installData) {
    const pick = (p) => (String(p).toLowerCase().startsWith(installData.toLowerCase()) ? installFs(installData) : bedrockFs());
    return {
      readdirSync: (p) => pick(p).readdirSync(p),
      statSync: (p) => pick(p).statSync(p),
      existsSync: (p) => pick(p).existsSync(p),
      readFileSync: (p, o) => pick(p).readFileSync(p, o),
    };
  }

  let contentCache = null; // { worldPath, content, list }
  async function loadWorldContent(world, force) {
    const installData = await findInstallData();
    if (!force && contentCache && contentCache.worldPath === (world && world.path)) return contentCache;
    const fs = combinedFs(installData);
    const content = loadContent(fs, { installData, bedrockRoot: bedrockRoot(), world });
    const list = entityList(content).filter((e) => findTexture(content, e.texturePath));
    content.world = world ? world.name : '';
    contentCache = { worldPath: world && world.path, world, content, list };
    return contentCache;
  }

  // Some mob materials read colour from nearly transparent pixels: the sheep's skin (its wool is
  // the opaque part, tinted by the game) and the spider's glowing eyes. Copies use a standard
  // material that treats those pixels as holes, so they're made solid. Returns a PNG data URL,
  // or null when the texture doesn't need it.
  function maskedTextureUrl(content, entry) {
    if (!entry.material || /^entity(_|$)/.test(entry.material)) return null;
    const found = findTexture(content, entry.texturePath);
    if (!found || found.ext !== '.tga') return null;
    const img = decodeTga(found.file.read());
    let changed = 0;
    for (let i = 3; i < img.data.length; i += 4) {
      if (img.data[i] > 0 && img.data[i] < 255) {
        img.data[i] = 255;
        changed++;
      }
    }
    if (!changed) return null;
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    return canvas.toDataURL('image/png');
  }

  // Texture of a look as a data URL: merged layers for multi-layer looks.
  async function lookTextureUrl(content, entry) {
    if (entry.layers && entry.layers.length > 1) {
      try {
        return await layeredTextureUrl(content, entry);
      } catch (e) {
        return null;
      }
    }
    return entityTextureUrl(content, entry);
  }

  function entityTextureUrl(content, entry) {
    const found = findTexture(content, entry.texturePath);
    if (!found) return null;
    try {
      return maskedTextureUrl(content, entry) || textureDataUrl(found.file.read(), found.ext);
    } catch (e) {
      return null;
    }
  }

  // ---- Rest pose -----------------------------------------------------------------------------
  // Many models aren't built in the pose you see in game: an always-running "setup" animation lays
  // the wolf's body flat, spreads the guardian's spikes, arranges the dragon's neck... restGeometry
  // bakes those animations (evaluated for an idle mob) and legacy bind_pose_rotation into a copy
  // of the geometry, used for Blockbench and for the in-game copy alike.
  const MOLANG_MATH = {
    sin: (d) => Math.sin((d * Math.PI) / 180),
    cos: (d) => Math.cos((d * Math.PI) / 180),
    asin: (v) => (Math.asin(v) * 180) / Math.PI,
    acos: (v) => (Math.acos(v) * 180) / Math.PI,
    atan: (v) => (Math.atan(v) * 180) / Math.PI,
    atan2: (y, x) => (Math.atan2(y, x) * 180) / Math.PI,
    abs: Math.abs, sqrt: Math.sqrt, floor: Math.floor, ceil: Math.ceil, round: Math.round, trunc: Math.trunc,
    min: Math.min, max: Math.max, pow: Math.pow, exp: Math.exp, ln: Math.log,
    mod: (a, b) => a % b,
    clamp: (v, a, b) => Math.min(Math.max(v, a), b),
    lerp: (a, b, t) => a + (b - a) * t,
    lerprotate: (a, b, t) => a + (b - a) * t,
    hermite_blend: (t) => 3 * t * t - 2 * t * t * t,
    random: (a, b) => (a + b) / 2,
    random_integer: (a) => a,
    die_roll: () => 0,
    die_roll_integer: () => 0,
    pi: Math.PI,
  };

  // Queries that aren't 0 for a mob standing still.
  const IDLE_QUERIES = { is_on_ground: 1, is_alive: 1 };

  // Value of a Molang expression for an idle entity: queries are 0 (except IDLE_QUERIES),
  // variables come from `vars` (the entity's pre-animation scripts) or are 0, context is 0.
  // Statements and anything unrecognised count as 0.
  function idleValue(expr, self = 0, vars = null, queries = IDLE_QUERIES) {
    if (typeof expr === 'number') return expr;
    if (typeof expr !== 'string') return 0;
    let js = expr.toLowerCase().trim();
    if (!js) return 0;
    if (/;|(^|[^=!<>])=(?!=)/.test(js)) return 0; // assignments / multiple statements
    js = js
      .replace(/\b(query|q|variable|v|temp|t|context|c)\.([a-z0-9_.]+)(\s*\([^()]*\))?/g, (m, kind, name) => {
        let value = 0;
        if (kind === 'query' || kind === 'q') value = queries[name] || 0;
        else if ((kind === 'variable' || kind === 'v') && vars && name in vars) value = vars[name];
        return `(${Number(value) || 0})`;
      })
      .replace(/\bthis\b/g, `(${Number(self) || 0})`)
      .replace(/\bmath\.([a-z_0-9]+)/g, (m, name) => (name in MOLANG_MATH ? `M.${name}` : '0'));
    if (/[^0-9.\s+\-*/%()<>=!&|?:,M_a-z]/.test(js)) return 0;
    if (/[a-z_]/.test(js.replace(/M\.[a-z_0-9]+/g, ''))) return 0; // unknown identifiers
    try {
      const v = Function('M', `return (${js});`)(MOLANG_MATH);
      return Number.isFinite(Number(v)) ? Number(v) : 0;
    } catch (e) {
      return 0;
    }
  }

  // [x, y, z] from an animation channel at time 0 (plain value, array, or keyframes).
  // "this" is the channel's value before the animation: the bone's own rotation, or for position
  // its pivot in the legacy frame (Y measured as pivot - 24), so "C - this" sets an absolute value.
  function channelAtStart(channel, self = [0, 0, 0], vars = null, queries = IDLE_QUERIES) {
    if (channel === undefined || channel === null) return null;
    if (typeof channel === 'object' && !Array.isArray(channel)) {
      const times = Object.keys(channel).filter((k) => !isNaN(parseFloat(k)));
      if (!times.length) return null;
      const first = channel[times.sort((a, b) => parseFloat(a) - parseFloat(b))[0]];
      return channelAtStart(first && typeof first === 'object' && !Array.isArray(first) ? first.post || first.pre || first.value : first, self, vars, queries);
    }
    if (!Array.isArray(channel)) return [0, 1, 2].map((i) => idleValue(channel, self[i], vars, queries));
    return [0, 1, 2].map((i) => idleValue(channel[i], self[i], vars, queries));
  }

  // Variables the entity's initialize / pre_animation scripts set, evaluated for an idle mob
  // (e.g. the parrot's variable.state: standing).
  function idleVariables(description, queries = IDLE_QUERIES) {
    const scripts = description.scripts || {};
    // set by the game itself: humanoid walks divide by it (1 when not gliding)
    const vars = { gliding_speed_value: 1 };
    for (const line of [].concat(scripts.initialize || [], scripts.pre_animation || [])) {
      for (const statement of String(line).split(';')) {
        const m = statement.match(/^\s*(?:variable|v)\.([a-z0-9_.]+)\s*=(?!=)\s*([\s\S]+?)\s*$/i);
        if (m) vars[m[1].toLowerCase()] = idleValue(m[2], 0, vars, queries);
      }
    }
    return vars;
  }

  // The animations an idle entity plays: scripts.animate plus (older files) animation_controllers,
  // following controllers into their initial state.
  function idleAnimations(content, description, flags = null) {
    const names = description.animations || {};
    const found = [];
    const queries = flags ? Object.assign({}, IDLE_QUERIES, flags) : IDLE_QUERIES;
    const vars = idleVariables(description, queries);
    // Variables the game sets itself (attack_time, the cat's state...) are unknown; they aren't
    // really 0 for an idle mob (attack_time, for one, is negative).
    const unknownVars = (condition) =>
      [...String(condition).toLowerCase().matchAll(/\b(?:variable|v)\.([a-z0-9_.]+)/g)].some((m) => !(m[1] in vars));
    // The state a controller sits in for an idle mob: its initial state, then any transition whose
    // condition already holds (e.g. "!query.is_riding" back to default). When the state hangs on a
    // variable only the game knows, a walking/standing state is the idle look.
    const IDLE_STATES = ['default', 'idle', 'standing', 'stand', 'walking', 'walk', 'moving', 'move'];
    const idleState = (controller) => {
      let name = controller.initial_state || 'default';
      if (!controller.states[name]) name = Object.keys(controller.states)[0];
      for (let hop = 0; hop < 4; hop++) {
        const transitions = ((controller.states[name] || {}).transitions || []).map((t) => [Object.keys(t)[0], Object.values(t)[0]]);
        let next = transitions.find(([target, condition]) => controller.states[target] && !unknownVars(condition) && idleValue(condition, 0, vars, queries) !== 0);
        if (!next && !IDLE_STATES.includes(name) && transitions.length && transitions.every(([, condition]) => unknownVars(condition))) {
          const idle = IDLE_STATES.find((s) => controller.states[s]);
          if (idle) next = [idle];
        }
        if (!next || next[0] === name) break;
        name = next[0];
      }
      return controller.states[name];
    };
    const playController = (id, depth) => {
      const controller = content.animationControllers.get(id);
      if (!controller || !controller.states) return;
      const state = idleState(controller);
      for (const a of (state && state.animations) || []) visit(a, depth + 1);
    };
    const visit = (entry, depth) => {
      if (depth > 6 || !entry) return;
      const [name, condition] = typeof entry === 'string' ? [entry, true] : [Object.keys(entry)[0], Object.values(entry)[0]];
      if (condition !== true && !idleCondition(condition, flags)) return;
      const id = names[name] || name;
      if (/^controller\.animation\./.test(id)) playController(id, depth);
      else if (content.animations.has(id)) found.push(content.animations.get(id));
    };
    for (const entry of (description.scripts && description.scripts.animate) || []) visit(entry, 0);
    // Older files list controllers as { short name: controller id } (the value isn't a condition).
    for (const entry of description.animation_controllers || []) {
      const id = typeof entry === 'string' ? entry : Object.values(entry)[0];
      if (typeof id === 'string' && /^controller\.animation\./.test(id)) playController(id, 0);
      else visit(entry, 0);
    }
    found.vars = vars;
    found.queries = queries;
    return found;
  }

  const MISSING_BIND_POSE = { 'geometry.polarbear': 'body', 'geometry.cat': 'body', 'geometry.ocelot.v1.8': 'body' };
  const CAT_TAILS = ['geometry.cat', 'geometry.ocelot.v1.8'];

  // flags: query values for this look, e.g. { is_baby: 1 } for a baby
  function restGeometry(content, entityId, geometryId, flags = null) {
    const base = resolveGeometry(content.geometries, geometryId);
    if (!base) return null;
    const geometry = JSON.parse(JSON.stringify(base));
    const byName = new Map(geometry.bones.map((b) => [b.name.toLowerCase(), b]));
    const add = (a, b) => [0, 1, 2].map((i) => (a ? a[i] || 0 : 0) + (b ? b[i] || 0 : 0));
    // Bind poses turn only the bone's own cubes (around its pivot), not the bones attached to it:
    // a cow's or polar bear's legs hang from its body but must stay put when the body is laid flat.
    // They go on after the animations ("this" in an animation excludes them). Minecraft's 1.21.90
    // polar bear, cat and ocelot models dropped their body's bind pose from the file but still
    // need it, so it's added back here.
    const applyBindPose = () => {
      for (const bone of geometry.bones) {
        const turn = bone.bind_pose_rotation || (MISSING_BIND_POSE[geometryId] === bone.name.toLowerCase() ? [90, 0, 0] : null);
        if (!turn) continue;
        for (const cube of bone.cubes || []) {
          cube.rotation = add(cube.rotation, turn);
          if (!cube.pivot) cube.pivot = (bone.pivot || [0, 0, 0]).slice();
        }
      }
    };
    const entity = content.entities.get(entityId);
    if (!entity) {
      applyBindPose();
      return geometry;
    }
    const rotation = new Map();
    const offset = new Map();
    const animations = idleAnimations(content, entity.description, flags);
    for (const animation of animations) {
      for (const [name, channels] of Object.entries(animation.bones || {})) {
        const key = name.toLowerCase();
        if (!byName.has(key) || !channels) continue;
        const bone = byName.get(key);
        const ownRotation = bone.rotation ? bone.rotation.slice() : [0, 0, 0];
        const pivot = bone.pivot || [0, 0, 0];
        const r = channelAtStart(channels.rotation, ownRotation, animations.vars, animations.queries);
        const p = channelAtStart(channels.position, [pivot[0], pivot[1] - 24, pivot[2]], animations.vars, animations.queries);
        if (r) rotation.set(key, add(rotation.get(key), r));
        if (p) offset.set(key, add(offset.get(key), p));
      }
    }
    for (const [key, r] of rotation) {
      const bone = byName.get(key);
      bone.rotation = add(bone.rotation, r);
    }
    // A position offset moves the bone and everything under it.
    const shift = (bone, o, depth = 0) => {
      if (depth > 64) return;
      if (bone.pivot) bone.pivot = add(bone.pivot, o);
      for (const cube of bone.cubes || []) {
        if (cube.origin) cube.origin = add(cube.origin, o);
        if (cube.pivot) cube.pivot = add(cube.pivot, o);
      }
      for (const child of geometry.bones) {
        if (child !== bone && child.parent && child.parent.toLowerCase() === bone.name.toLowerCase()) shift(child, o, depth + 1);
      }
    };
    for (const [key, o] of offset) if (o.some((v) => v)) shift(byName.get(key), o);
    // The cat's and ocelot's tail tip hangs from the tail's base, 8 px behind it, so it floats
    // clear of the tail, and the tail's idle angle points it under the belly. Rebuild the resting
    // tail: the first segment angled down and back, the tip on its end pointing back.
    if (CAT_TAILS.includes(geometryId)) {
      const [tail1, tail2] = [byName.get('tail1'), byName.get('tail2')];
      if (tail1 && tail2 && tail1.pivot && tail2.pivot && (tail2.parent || '').toLowerCase() === 'tail1') {
        shift(tail2, [tail1.pivot[0] - tail2.pivot[0], tail1.pivot[1] - 8 - tail2.pivot[1], tail1.pivot[2] - tail2.pivot[2]]);
        tail1.rotation = [51.57, 0, 0];
        tail2.rotation = [47.43, 0, 0];
      }
    }
    applyBindPose();
    // Parts the render controller hides on an idle mob (saddles, chest bags, reins...) lose their
    // cubes. Rules are "bone name (with *) -> condition", later rules win.
    const rules = mainController(content, entity.description).part_visibility || [];
    const hidden = (name) => {
      let visible = true;
      for (const rule of rules) {
        for (const [pattern, condition] of Object.entries(rule)) {
          const glob = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, (ch) => '\\' + ch).replace(/\*/g, '.*');
          if (new RegExp('^' + glob + '$').test(name.toLowerCase())) {
            visible = condition === true || (condition !== false && idleCondition(condition, flags));
          }
        }
      }
      return !visible;
    };
    for (const bone of geometry.bones) if (hidden(bone.name)) bone.cubes = [];
    return geometry;
  }

  function entityModel(content, entry) {
    const geometry = restGeometry(content, entry.id, entry.geometryId, entry.flags);
    return geometry ? bedrockToBlockbench(geometry) : null;
  }

  // ---- Animation frames ----------------------------------------------------------------------
  // Poses a player or an entity copy with frames of its animations (walk, attack, sit...). Frames
  // add to the pose it already has, and several animations can be stacked, each at its own frame.
  // Bone rotations only: Minecraft's copies can't move or scale bones.
  const ANIM_FPS = 20; // one frame per game tick
  const ANIM_WALK_SPEED = 6; // blocks per second fed to walk cycles (query.modified_distance_moved)
  const ANIM_DEFAULT_LENGTH = 2; // seconds to scrub through for animations without a length
  // looking at a target, first-person arms and UI renders don't make sense as poses
  const ANIM_SKIP = /look_at|first_person|paperdoll|map_player|inventory|\.fp\b|_fp\b|\.first\b|attack\.positions/i;

  // The animations of an entity type that turn at least one of `bones` (lower-case names), as
  // { name, id, def, length, keyframed }.
  function entityAnimations(content, entityId, bones = null) {
    const entity = content.entities.get(entityId);
    if (!entity) return [];
    const out = [];
    const seen = new Set();
    for (const [name, id] of Object.entries(entity.description.animations || {})) {
      if (typeof id !== 'string' || /^controller\./.test(id) || seen.has(id) || ANIM_SKIP.test(name) || ANIM_SKIP.test(id)) continue;
      const def = content.animations.get(id);
      if (!def || !def.bones) continue;
      const turned = Object.entries(def.bones).filter(([, b]) => b && b.rotation !== undefined).map(([n]) => n.toLowerCase());
      if (!turned.length || (bones && !turned.some((n) => bones.has(n)))) continue;
      seen.add(id);
      const keyframed = Object.values(def.bones).some((b) => b && b.rotation && typeof b.rotation === 'object' && !Array.isArray(b.rotation));
      const length = Number(def.animation_length) > 0 ? Number(def.animation_length) : ANIM_DEFAULT_LENGTH;
      out.push({ name, id, def, length, keyframed });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Queries at time t of an animation: a mob walking along at ANIM_WALK_SPEED, and an attack
  // (attack_time 0..1) spread over the animation's length.
  function animQueries(t, length) {
    const attack = length > 0 ? (t % length) / length : 0;
    return Object.assign({}, IDLE_QUERIES, {
      anim_time: t, life_time: t, time_stamp: t * ANIM_FPS,
      modified_distance_moved: t * ANIM_WALK_SPEED, walk_distance: t * ANIM_WALK_SPEED,
      modified_move_speed: 0.5, ground_speed: ANIM_WALK_SPEED, is_moving: 1, attack_time: attack,
    });
  }

  // How strongly the entity plays an animation: entries like { "walk": "query.modified_move_speed" }
  // in its animate list or its controllers blend it by that amount. A plain on/off condition that
  // is off (the mob isn't a baby, say) still shows the animation in full, since it was picked.
  function animationWeight(content, description, name, vars, queries) {
    let expr = null;
    const look = (list) => {
      for (const entry of list || []) {
        if (entry && typeof entry === 'object' && name in entry) expr = entry[name];
      }
    };
    look((description.scripts || {}).animate);
    for (const id of Object.values(description.animations || {})) {
      const controller = typeof id === 'string' && content.animationControllers.get(id);
      for (const state of Object.values((controller && controller.states) || {})) look(state.animations);
    }
    if (typeof expr !== 'string' && typeof expr !== 'number') return 1;
    const w = idleValue(expr, 0, vars, queries);
    return w > 0 && w < 1 ? w : 1;
  }

  // [x, y, z] of a rotation channel at time t (Bedrock convention), or null.
  function channelAt(channel, t, self, vars, queries) {
    if (channel === undefined || channel === null) return null;
    const value = (v) => (Array.isArray(v) ? [0, 1, 2].map((i) => idleValue(v[i], self[i], vars, queries)) : [0, 1, 2].map((i) => idleValue(v, self[i], vars, queries)));
    if (typeof channel !== 'object' || Array.isArray(channel)) return value(channel);
    const keys = Object.keys(channel).filter((k) => !isNaN(parseFloat(k))).sort((a, b) => parseFloat(a) - parseFloat(b));
    if (!keys.length) return null;
    const side = (k, which) => {
      const kf = channel[k];
      if (kf && typeof kf === 'object' && !Array.isArray(kf)) return which === 'pre' ? kf.pre || kf.post || kf.value : kf.post || kf.pre || kf.value;
      return kf;
    };
    const after = keys.findIndex((k) => parseFloat(k) > t);
    if (after === -1) return value(side(keys[keys.length - 1], 'post'));
    if (after === 0) return value(side(keys[0], 'pre'));
    const k0 = keys[after - 1];
    const k1 = keys[after];
    const t0 = parseFloat(k0);
    const t1 = parseFloat(k1);
    const a = value(side(k0, 'post'));
    const b = value(side(k1, 'pre'));
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    return a.map((v, i) => v + (b[i] - v) * f);
  }

  // What an animation can pose: an entity copy (its own type's animations, its rest pose) or a
  // player (the player's animations; a player's rest pose is all zeros).
  function animationTarget(root) {
    const groups = new Map();
    eachDescendant(root, (node) => {
      if (node instanceof Group && !groups.has(node.name.toLowerCase())) groups.set(node.name.toLowerCase(), node);
    });
    const rest = new Map();
    if (ENTITY_PREFIX.test(root.name) && root.pose_entity) {
      for (const [name, r] of Object.entries(root.pose_entity.rest || {})) rest.set(name.toLowerCase(), r.slice());
      return { root, entityId: root.pose_entity.entity, groups, rest };
    }
    for (const name of groups.keys()) rest.set(name, [0, 0, 0]);
    // the rig's bones also move (their offset is kept as "<bone>@p")
    const movable = new Map();
    for (const key of Object.keys(RIG_REST)) if (mannequinBone(root, key)) movable.set(key, true);
    return { root, entityId: 'minecraft:player', groups, rest, movable };
  }

  function carriedCubes(root) {
    const cubes = [];
    root.forEachChild((c) => c instanceof Cube && cubes.push(c));
    return cubes;
  }

  // The pose a model has now: bone rotations, and bone offsets.
  function capturePose(target) {
    const pose = new Map([...target.groups].map(([k, g]) => [k, g.rotation.slice()]));
    for (const key of (target.movable || new Map()).keys()) pose.set(`${key}@p`, boneOffset(target.root, key));
    return pose;
  }

  // The animation state of a model: its animations, its pose now, and the pose the remembered
  // animations (pose_animation) were added to, worked out again from the pose now so bones turned
  // by hand since then keep that change.
  function poseState(root, content) {
    const target = animationTarget(root);
    const animations = entityAnimations(content, target.entityId, new Set(target.groups.keys()));
    const byId = new Map(animations.map((a) => [a.id, a]));
    const current = capturePose(target);
    const saved = root.pose_animation && Array.isArray(root.pose_animation.layers) ? root.pose_animation : null;
    const savedLayers = saved ? saved.layers.filter((l) => byId.has(l.id)) : [];
    let base = current;
    if (savedLayers.length) {
      const savedBase = new Map(Object.entries(saved.base || {}).map(([k, r]) => [k, r.slice()]));
      for (const [k, r] of current) if (!savedBase.has(k)) savedBase.set(k, r.slice());
      const applied = composePose(target, content, savedBase, savedLayers.map((l) => ({ anim: byId.get(l.id), frame: l.frame })));
      base = new Map([...current].map(([k, r]) => {
        const a = applied.get(k) || savedBase.get(k);
        const b = savedBase.get(k);
        return [k, r.map((v, i) => v - (a[i] - b[i]))];
      }));
    }
    return { target, animations, byId, current, savedLayers, base };
  }

  // How far one animation turns each bone at time t, as Blockbench rotations to add (Bedrock
  // animations turn X and Y the other way round). "this" in its Molang is the bone's rotation
  // before the animation: `base`.
  function animationDelta(target, content, anim, t, base) {
    const entity = content.entities.get(target.entityId);
    const queries = animQueries(t, anim.length);
    const vars = Object.assign({ attack_time: queries.attack_time }, entity ? idleVariables(entity.description, queries) : {});
    // walk cycles run on distance moved rather than time ("anim_time_update")
    if (anim.def.anim_time_update !== undefined) queries.anim_time = idleValue(anim.def.anim_time_update, 0, vars, queries);
    const weight = entity ? animationWeight(content, entity.description, anim.name, vars, queries) : 1;
    const delta = new Map();
    for (const [name, channels] of Object.entries(anim.def.bones)) {
      const key = name.toLowerCase();
      if (!channels || !target.groups.has(key)) continue;
      const before = base.get(key) || target.rest.get(key) || [0, 0, 0];
      const r = channelAt(channels.rotation, queries.anim_time, toBedrockRot(before), vars, queries);
      if (r) delta.set(key, [-r[0] * weight, -r[1] * weight, r[2] * weight]);
      if (channels.relative_to && channels.relative_to.rotation === 'entity') (delta.relative || (delta.relative = new Set())).add(key);
      if (target.movable && target.movable.has(key) && channels.position !== undefined) {
        const at = base.get(`${key}@p`) || [0, 0, 0];
        const p = channelAt(channels.position, queries.anim_time, [-at[0], at[1], at[2]], vars, queries);
        if (p) delta.set(`${key}@p`, [-p[0] * weight, p[1] * weight, p[2] * weight]);
      }
    }
    return delta;
  }

  // The base pose plus every layer's frame.
  function composePose(target, content, base, layers) {
    const pose = new Map([...base].map(([k, r]) => [k, r.slice()]));
    const relative = new Set();
    for (const layer of layers) {
      const delta = animationDelta(target, content, layer.anim, layer.frame / ANIM_FPS, base);
      for (const [key, d] of delta) {
        const r = pose.get(key) || (target.rest.get(key) || [0, 0, 0]).slice();
        pose.set(key, [r[0] + d[0], r[1] + d[1], r[2] + d[2]]);
      }
      for (const key of delta.relative || []) relative.add(key);
    }
    // "relative_to": { "rotation": "entity" }: the bone's turn is measured from the entity, not
    // from what holds it (a head keeps looking ahead while the body leans), so take out the
    // turns of the bones it hangs from
    for (const key of relative) {
      const group = target.groups.get(key);
      const r = pose.get(key);
      if (!group || !r) continue;
      const chain = [];
      for (let n = group.parent; n && n instanceof Group && n !== target.root; n = n.parent) chain.unshift(n.name.toLowerCase());
      const above = new THREE.Quaternion();
      for (const k of chain) {
        const pr = pose.get(k) || (target.groups.get(k) ? target.groups.get(k).rotation : null);
        if (pr) above.multiply(eulerQuaternion(pr));
      }
      const local = above.invert().multiply(eulerQuaternion(r));
      const e = new THREE.Euler().setFromQuaternion(local, eulerOrder());
      pose.set(key, [e.x / DEG, e.y / DEG, e.z / DEG]);
    }
    return pose;
  }

  // One animation at time t on top of the rest pose (used by tests and thumbnails).
  function animationPose(root, content, anim, t) {
    const target = animationTarget(root);
    return composePose(target, content, target.rest, [{ anim, frame: t * ANIM_FPS }]);
  }

  function applyPose(target, pose) {
    for (const [key, group] of target.groups) {
      const r = pose.get(key);
      if (r) for (let i = 0; i < 3; i++) group.rotation[i] = round(wrap(r[i]), 3);
    }
    // holders first, so a moved bone's own offset is measured after its holder moved
    for (const key of Object.keys(RIG_REST)) {
      if (!target.movable || !target.movable.has(key)) continue;
      const want = pose.get(`${key}@p`);
      if (!want) continue;
      const now = boneOffset(target.root, key);
      const d = want.map((v, i) => round(v - now[i], 4));
      if (d.some((v) => Math.abs(v) > 1e-4)) translateTree(target.groups.get(key), d);
    }
    refreshGroups([...target.groups.values()]);
  }

  // A small live view of the model for the animation window. It draws the model's own meshes
  // from the scene with a second renderer, so skins, textures and equipment show as they are.
  function createAnimationPreview(root, size = 260) {
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch (e) {
      return null;
    }
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(size, size, false);
    renderer.domElement.style.width = `${size}px`;
    renderer.domElement.style.height = `${size}px`;
    renderer.domElement.style.borderRadius = '6px';
    renderer.domElement.style.background = 'var(--color-back, #1e1e1e)';
    const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 4000);
    let framing = null;
    const draw = () => {
      const object = root.mesh;
      if (!object) return;
      object.updateMatrixWorld(true);
      if (!framing) {
        // frame the model once, from the front three-quarter side, so animating doesn't jitter it
        const box = new THREE.Box3().setFromObject(object);
        if (box.isEmpty()) return;
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 4);
        const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(object.getWorldQuaternion(new THREE.Quaternion()));
        facing.y = 0;
        if (facing.lengthSq() < 1e-6) facing.set(0, 0, -1);
        facing.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), -0.6);
        framing = { center, dir: facing.add(new THREE.Vector3(0, 0.45, 0)).normalize(), distance: radius / Math.sin((15 * Math.PI) / 180) };
      }
      camera.position.copy(framing.center).addScaledVector(framing.dir, framing.distance);
      camera.lookAt(framing.center);
      // hide selection outlines while drawing
      const hidden = [];
      object.traverse((o) => {
        if ((o.isLineSegments || o.isLine) && o.visible) {
          o.visible = false;
          hidden.push(o);
        }
      });
      renderer.render(object, camera);
      for (const o of hidden) o.visible = true;
    };
    const timer = setInterval(() => {
      try {
        draw();
      } catch (e) {
        // the model went away; nothing to draw
      }
    }, 33);
    return {
      canvas: renderer.domElement,
      dispose() {
        clearInterval(timer);
        renderer.dispose();
      },
    };
  }

  // ---- Weapons ----
  // A pack's player model picks animations for the held item in its controllers, e.g.
  // { "battle_axe": "q.equipped_item_any_tag('slot.weapon.mainhand', 'spark_dc:battle_axe')" },
  // whose state plays "battle_axe.hold.third". The held weapon's animations are that state's
  // (the holding pose) and every player animation named after it ("battle_axe.attack.third"…).
  function heldWeapon(content, root) {
    const id = root && root.pose_equipment && root.pose_equipment.mainhand;
    const player = content && content.entities.get('minecraft:player');
    if (!id || !player || ENTITY_PREFIX.test(root.name)) return null;
    const info = content.items && content.items.get(id);
    const tags = new Set(((info && info.tags) || []).map((t) => t.toLowerCase()));
    const anims = player.description.animations || {};
    const list = (args) => args.split(',').map((t) => t.trim().replace(/^'|'$/g, '').toLowerCase());
    const matches = (expr) => {
      const s = String(expr).replace(/\s+/g, '');
      let m = s.match(/^(?:q|query)\.equipped_item_any_tag\('slot\.weapon\.mainhand',(.+)\)$/i);
      if (m) return list(m[1]).some((t) => tags.has(t));
      m = s.match(/^(?:q|query)\.is_item_name_any\('slot\.weapon\.mainhand',(.+)\)$/i);
      if (m) return list(m[1]).includes(id.toLowerCase());
      m = s.match(/^(?:q|query)\.get_equipped_item_name(?:\((?:'main_hand'|0)?\))?==(?:'([^']+)')$/i);
      if (m) return m[1].toLowerCase() === id.toLowerCase().replace(/^[^:]+:/, '') || m[1].toLowerCase() === id.toLowerCase();
      return false;
    };
    for (const ctrlId of Object.values(anims)) {
      const ctrl = typeof ctrlId === 'string' && content.animationControllers.get(ctrlId);
      if (!ctrl || !ctrl.states) continue;
      for (const state of Object.values(ctrl.states)) {
        for (const transition of state.transitions || []) {
          for (const [to, expr] of Object.entries(transition || {})) {
            if (!ctrl.states[to] || !matches(expr)) continue;
            const holdKeys = (ctrl.states[to].animations || []).map((a) => (typeof a === 'string' ? a : Object.keys(a)[0]));
            const hold = holdKeys.map((k) => anims[k]).filter((a) => typeof a === 'string' && !/^controller\./.test(a));
            const prefix = `${to.toLowerCase()}.`;
            const related = Object.entries(anims).filter(([k, a]) => k.toLowerCase().startsWith(prefix) && typeof a === 'string' && !/^controller\./.test(a)).map(([, a]) => a);
            return { id, kind: to, name: itemName(content, id), hold, ids: new Set(hold.concat(related)) };
          }
        }
      }
    }
    return null;
  }

  // Puts the held weapon's holding pose on (or takes it off): it's an animation layer marked
  // "hold", so it can also be adjusted or removed in Animation….
  async function setHoldingPose(root, on) {
    if (!root || ENTITY_PREFIX.test(root.name)) return false;
    const content = await previewContent();
    ensureRig(root);
    const state = poseState(root, content);
    const weapon = on ? heldWeapon(content, root) : null;
    const layers = state.savedLayers.filter((l) => !l.hold);
    for (const id of (weapon && weapon.hold) || []) if (state.byId.has(id)) layers.push({ id, frame: 0, hold: true });
    const had = state.savedLayers.some((l) => l.hold);
    const has = layers.some((l) => l.hold);
    if (!had && !has) return false;
    Undo.initEdit({ groups: [root].concat([...state.target.groups.values()]), elements: carriedCubes(root) });
    applyPose(state.target, composePose(state.target, content, state.base, layers.map((l) => ({ anim: state.byId.get(l.id), frame: l.frame }))));
    root.pose_animation = layers.length ? { base: Object.fromEntries([...state.base].map(([k, r]) => [k, r.slice()])), layers } : null;
    Undo.finishEdit(has ? 'Weapon holding pose' : 'Remove weapon holding pose');
    refreshGroups([...state.target.groups.values()]);
    lastSent.delete(mannequinId(root.name));
    return has;
  }

  // The attachable's own third-person animations at their first frame (the "offset" that puts a
  // weapon in the hand): bone -> { rotation, position, scale } (Bedrock convention).
  // Variables the mannequin offers the items it wears (an attachable reads them with
  // "c.owning_entity -> v.cloak_angle"). Minecraft gets them in the pose's spare slot.
  const OWNER_VARIABLES = ['cloak_angle'];

  function attachableOffsets(content, description, ownerVars = {}) {
    const out = new Map();
    const vars = Object.assign(idleVariables(description), ownerVars);
    for (const entry of (description.scripts && description.scripts.animate) || []) {
      const key = typeof entry === 'string' ? entry : Object.keys(entry)[0];
      const cond = typeof entry === 'string' ? true : Object.values(entry)[0];
      if (cond !== true && !idleCondition(cond)) continue;
      const animId = description.animations && description.animations[key];
      const def = typeof animId === 'string' && !/^controller\./.test(animId) && content.animations.get(animId);
      for (const [bone, ch] of Object.entries((def && def.bones) || {})) {
        if (!ch) continue;
        const k = bone.toLowerCase();
        const cur = out.get(k) || { rotation: [0, 0, 0], position: [0, 0, 0], scale: [1, 1, 1] };
        const r = channelAt(ch.rotation, 0, [0, 0, 0], vars, IDLE_QUERIES);
        if (r) cur.rotation = cur.rotation.map((v, i) => v + r[i]);
        const pos = channelAt(ch.position, 0, [0, 0, 0], vars, IDLE_QUERIES);
        if (pos) cur.position = cur.position.map((v, i) => v + pos[i]);
        const s = channelAt(ch.scale, 0, [1, 1, 1], vars, IDLE_QUERIES);
        if (s) cur.scale = cur.scale.map((v, i) => v * s[i]);
        out.set(k, cur);
      }
    }
    return out;
  }

  // Bones an attachable turns by one of the wearer's variables ("v.cloak_angle * 0.8"): turning such
  // a bone in Blockbench sets the variable, which is what Minecraft can follow.
  function attachableDrivers(content, description) {
    const out = new Map();
    const scripts = description.scripts || {};
    const fromOwner = (name) => [].concat(scripts.pre_animation || [], scripts.initialize || []).some((line) => new RegExp(`owning_entity\\s*->\\s*(?:v|variable)\\.${name}\\b`, 'i').test(String(line)));
    for (const entry of scripts.animate || []) {
      const key = typeof entry === 'string' ? entry : Object.keys(entry)[0];
      const cond = typeof entry === 'string' ? true : Object.values(entry)[0];
      if (cond !== true && !idleCondition(cond)) continue;
      const animId = description.animations && description.animations[key];
      const def = typeof animId === 'string' && !/^controller\./.test(animId) && content.animations.get(animId);
      for (const [bone, ch] of Object.entries((def && def.bones) || {})) {
        if (!ch || !Array.isArray(ch.rotation)) continue;
        ch.rotation.forEach((expr, axis) => {
          const m = typeof expr === 'string' && expr.match(/^\s*(?:v|variable)\.(\w+)\s*(?:\*\s*(-?[\d.]+))?\s*$/i);
          if (!m || out.has(bone.toLowerCase())) return;
          const variable = m[1].toLowerCase();
          if (!OWNER_VARIABLES.includes(variable) || !fromOwner(variable)) return;
          out.set(bone.toLowerCase(), { variable, axis, factor: m[2] ? Number(m[2]) : 1 });
        });
      }
    }
    return out;
  }

  // Remembers which bone sets a variable, and the turn it was built with.
  function markDriver(group, driver, ownerVars) {
    group.pose_driver = { variable: driver.variable, axis: driver.axis, factor: driver.factor, built: group.rotation[driver.axis], value: Number(ownerVars[driver.variable]) || 0 };
  }

  // The wearer's variables from the bones that drive them (turned by hand since they were built).
  function ownerVariables(root) {
    const vars = Object.assign({}, root.pose_vars || {});
    root.forEachChild((g) => {
      const d = g instanceof Group && g.pose_driver;
      if (!d || !d.factor) return;
      const sign = d.axis === 2 ? 1 : -1; // Blockbench -> Bedrock turns
      vars[d.variable] = round(d.value + (sign * (g.rotation[d.axis] - d.built)) / d.factor, 2);
    });
    const changed = JSON.stringify(vars) !== JSON.stringify(root.pose_vars || {});
    if (changed) root.pose_vars = vars;
    return vars;
  }

  // A 3D item (a weapon) in the hand: its model's bound bones go on the hand bone it binds to,
  // placed the way Minecraft and Blockbench do it (the bone's pivot 24 below the hand bone's), then
  // moved by the attachable's offset animation.
  async function addWeaponPreview(root, content, itemId, side, cubes, textures) {
    const attachable = findAttachable(content, itemId);
    if (!attachable) return false;
    const d = attachable.description;
    const geometryId = d.geometry && (d.geometry.default || Object.values(d.geometry)[0]);
    const geometry = geometryId && resolveGeometry(content.geometries, geometryId);
    if (!geometry) return false;
    const slotBone = side === 'rightArm' ? 'rightitem' : 'leftitem';
    if (!boneGroupOf(root, slotBone)) return false;
    const texturePath = d.textures && (d.textures.default || Object.values(d.textures)[0]);
    const texture = await previewTexture(content, `eq_${String(texturePath).split('/').pop()}`, texturePath, geometry.texture_width, geometry.texture_height);
    if (texture && !textures.includes(texture)) textures.push(texture);
    const visible = attachableVisibility(content, attachable, {});
    const ownerVars = ownerVariables(root);
    const offsets = attachableOffsets(content, d, ownerVars);
    const drivers = attachableDrivers(content, d);
    const raw = new Map(geometry.bones.map((b) => [String(b.name).toLowerCase(), b]));
    const model = bedrockToBlockbench({ bones: geometry.bones, texture_width: geometry.texture_width, texture_height: geometry.texture_height });
    const byName = new Map(model.bones.map((b) => [b.name.toLowerCase(), b]));
    const childrenOf = (key) => model.bones.filter((b) => b.parent && b.parent.toLowerCase() === key);
    const hiddenByScale = (key) => {
      const o = offsets.get(key);
      return !!o && o.scale.some((v) => Math.abs(v) < 1e-6);
    };
    const shows = new Map();
    const showsSomething = (bone, depth = 0) => {
      const key = bone.name.toLowerCase();
      if (shows.has(key)) return shows.get(key);
      shows.set(key, false);
      if (hiddenByScale(key)) return false;
      const result = (bone.cubes.length > 0 && visible(bone.name)) || (depth < 64 && childrenOf(key).some((c) => showsSomething(c, depth + 1)));
      shows.set(key, result);
      return result;
    };
    const hostOf = (bone) => {
      const binding = String((raw.get(bone.name.toLowerCase()) || {}).binding || '');
      const named = binding.match(/'(\w+)'/);
      return boneGroupOf(root, named ? named[1] : slotBone) || boneGroupOf(root, slotBone);
    };
    const built = [];
    const build = (bone, parentGroup, shift, depth = 0) => {
      if (depth > 64 || !showsSomething(bone)) return;
      const group = new Group({ name: `eq_${bone.name}`, origin: shift(bone.origin), rotation: bone.rotation.slice() }).addTo(parentGroup).init();
      built.push({ key: bone.name.toLowerCase(), group });
      if (visible(bone.name)) addPreviewCubes(group, bone, shift, texture, `eq_${slotBone === 'rightitem' ? 'mainhand' : 'offhand'}`, cubes);
      for (const child of childrenOf(bone.name.toLowerCase())) build(child, group, shift, depth + 1);
    };
    for (const bone of model.bones) {
      if (bone.parent && byName.has(bone.parent.toLowerCase())) continue;
      const host = hostOf(bone);
      if (!host) continue;
      const shift = (v) => [v[0] + host.origin[0], v[1] + host.origin[1] - 24, v[2] + host.origin[2]];
      build(bone, host, shift);
    }
    // the offset animation: turn, then move each bone (moving a bone moves what's inside it)
    for (const { key, group } of built) {
      const o = offsets.get(key);
      if (!o) continue;
      group.rotation = [group.rotation[0] - o.rotation[0], group.rotation[1] - o.rotation[1], group.rotation[2] + o.rotation[2]];
      translateTree(group, [-o.position[0], o.position[1], o.position[2]]);
    }
    for (const { key, group } of built) if (drivers.has(key)) markDriver(group, drivers.get(key), ownerVars);
    return built.length > 0;
  }

  // Pose Studio ▸ Animation… (a player or an entity copy selected).
  async function openAnimationFrames() {
    const root = selectedPoseRoot();
    if (root) ensureRig(root);
    if (!root) {
      Blockbench.showQuickMessage('Select a player (Player_) or entity (ent_) first', 2000);
      return;
    }
    let content;
    try {
      content = await previewContent();
    } catch (e) {
      showError('Pose Studio: animations', e);
      return;
    }
    ensureRig(root);
    const { target, animations, byId, current, savedLayers, base } = poseState(root, content);
    // the held weapon's animations go first
    const weapon = heldWeapon(content, root);
    if (weapon) animations.sort((a, b) => weapon.ids.has(b.id) - weapon.ids.has(a.id));
    if (!animations.length) {
      Blockbench.showMessageBox({ title: 'Pose Studio', message: `No animations found that move ${root.name}'s bones.` });
      return;
    }
    const groups = [...target.groups.values()];
    // the pose it has now (restored on Cancel): `current`
    Undo.initEdit({ groups: [root].concat(groups), elements: carriedCubes(root) });
    let timer = null;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    let preview = null;
    let vm = null;
    let uid = 0;
    const baseNow = () => (vm && vm.fromRest ? target.rest : base);
    const update = () => {
      if (!vm) return;
      const layers = vm.layers.map((l) => ({ anim: byId.get(l.id), frame: l.frame }));
      applyPose(target, composePose(target, content, baseNow(), layers));
    };
    const frameCount = (a) => Math.max(1, Math.round(a.length * ANIM_FPS));
    const dialog = new Dialog({
      id: 'pose_studio_animation_frames',
      title: `Animation: ${root.name}`,
      width: 820,
      buttons: ['Apply', 'Cancel'],
      cancelIndex: 1,
      component: {
        data: () => ({
          animations: animations.map((a) => ({ name: a.name, id: a.id, frames: frameCount(a), keyframed: a.keyframed, weapon: !!(weapon && weapon.ids.has(a.id)) })),
          weaponName: weapon ? weapon.name : '',
          search: '',
          layers: savedLayers.map((l) => ({ uid: ++uid, id: l.id, name: byId.get(l.id).name, frames: frameCount(byId.get(l.id)), frame: Math.min(l.frame, frameCount(byId.get(l.id))), hold: !!l.hold })),
          active: uid,
          playing: false,
          fromRest: false,
          hasPreview: false,
          smallButton: { minWidth: '0', width: '28px', height: '24px', padding: '0', flex: 'none' },
        }),
        mounted() {
          vm = this;
          preview = createAnimationPreview(root);
          if (preview && this.$refs && this.$refs.preview) {
            this.$refs.preview.appendChild(preview.canvas);
            this.hasPreview = true;
          }
        },
        computed: {
          shown() {
            const q = this.search.trim().toLowerCase();
            return this.animations.filter((a) => !q || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q));
          },
          activeLayer() {
            return this.layers.find((l) => l.uid === this.active) || null;
          },
        },
        methods: {
          inStack(a) {
            return this.layers.some((l) => l.id === a.id);
          },
          // clicking an animation adds it to the stack, clicking it again takes it off
          pick(a) {
            const found = this.layers.find((l) => l.id === a.id);
            if (found) {
              this.remove(found);
              return;
            }
            const layer = { uid: ++uid, id: a.id, name: a.name, frames: a.frames, frame: 0 };
            this.layers.push(layer);
            this.active = layer.uid;
            update();
          },
          remove(layer) {
            this.layers.splice(this.layers.indexOf(layer), 1);
            if (this.active === layer.uid) {
              this.active = this.layers.length ? this.layers[this.layers.length - 1].uid : 0;
              if (this.playing) this.toggle();
            }
            update();
          },
          setFrame(layer, frame) {
            layer.frame = Math.max(0, Math.min(layer.frames, frame));
            update();
          },
          step(layer, n) {
            this.active = layer.uid;
            layer.frame = (layer.frame + n + layer.frames + 1) % (layer.frames + 1);
            update();
          },
          toggle() {
            if (this.playing) {
              stop();
              this.playing = false;
              return;
            }
            const layer = this.activeLayer;
            if (!layer) return;
            this.playing = true;
            timer = setInterval(() => this.step(this.activeLayer || layer, 1), 1000 / ANIM_FPS);
          },
          changedBase() {
            update();
          },
        },
        template: `
          <div class="pose_studio_animation" style="display: flex; gap: 14px; overflow: hidden;">
            <div style="flex: 1; min-width: 0; display: flex; flex-direction: column;">
              <input type="text" v-model="search" placeholder="Search animations…" class="dark_bordered" style="width: 100%; margin-bottom: 6px;">
              <div style="flex: 1; max-height: 340px; overflow-y: auto; border: 1px solid var(--color-border); border-radius: 4px;">
                <div v-for="a in shown" :key="a.id" @click="pick(a)" :title="(inStack(a) ? 'Take ' : 'Add ') + a.id + (inStack(a) ? ' off the stack' : ' to the stack')"
                     :style="{ padding: '4px 8px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: '8px',
                               background: inStack(a) ? 'var(--color-selected)' : '' }">
                  <span>{{ inStack(a) ? '✓ ' : '' }}<span v-if="a.weapon" :title="'An animation of ' + weaponName" style="color: var(--color-accent);">⚔ </span>{{ a.name }}</span>
                  <span style="opacity: 0.55; font-size: 0.85em;">{{ a.keyframed ? a.frames + ' frames' : 'loop' }}</span>
                </div>
                <p v-if="!shown.length" style="padding: 6px 8px; opacity: 0.7;">No animations match.</p>
              </div>
            </div>
            <div style="width: 320px; flex: none; min-width: 0; display: flex; flex-direction: column; gap: 8px;">
              <div ref="preview" style="display: flex; justify-content: center; min-height: 40px;"></div>
              <p v-if="!hasPreview" style="opacity: 0.6; margin: 0;">(The viewport shows the pose.)</p>
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
                <b>Stack</b>
                <button @click="toggle()" :disabled="!activeLayer" style="min-width: 0; padding: 0 14px;">{{ playing ? 'Pause' : 'Play' }}</button>
              </div>
              <p v-if="!layers.length" style="opacity: 0.7; margin: 0;">Click animations on the left to stack them (click again to take one off). Each adds to the pose at its own frame.</p>
              <div v-for="l in layers" :key="l.uid" @click="active = l.uid"
                   :style="{ border: '1px solid var(--color-border)', borderRadius: '4px', padding: '4px 6px',
                             background: l.uid === active ? 'var(--color-selected)' : '' }">
                <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ l.name }}</div>
                <div style="display: flex; align-items: center; gap: 4px;">
                  <button @click.stop="step(l, -1)" title="Previous frame" :style="smallButton">◀</button>
                  <input type="range" min="0" :max="l.frames" step="1" :value="l.frame" @input="setFrame(l, Number($event.target.value))" @mousedown="active = l.uid" style="flex: 1; min-width: 0;">
                  <button @click.stop="step(l, 1)" title="Next frame" :style="smallButton">▶</button>
                  <span style="flex: none; width: 52px; text-align: right; font-size: 0.85em;">{{ l.frame }} / {{ l.frames }}</span>
                </div>
              </div>
              <label style="display: flex; gap: 6px; align-items: center;" title="Off: animations add to the pose you've already made. On: start from the model's default pose.">
                <input type="checkbox" v-model="fromRest" @change="changedBase()"> Reset pose (start from the default pose)
              </label>
              <p style="opacity: 0.6; margin: 0; font-size: 0.85em;">Walk cycles move at a steady pace; attacks play once per loop. Bones turn and move as in Minecraft (sizes aren't copied).</p>
            </div>
          </div>`,
      },
      onButton(index) {
        if (index === 0 && vm) {
          const b = baseNow();
          root.pose_animation = vm.layers.length
            ? { base: Object.fromEntries([...b].map(([k, r]) => [k, r.slice()])), layers: vm.layers.map((l) => (l.hold ? { id: l.id, frame: l.frame, hold: true } : { id: l.id, frame: l.frame })) }
            : null;
          finish(true);
        } else finish(false);
      },
      onCancel() {
        finish(false);
      },
    });
    // Keep the pose (one undo step) or put it back. Runs once, whichever way the window closes.
    let done = false;
    function finish(keep) {
      stop();
      if (preview) preview.dispose();
      preview = null;
      if (done) return;
      done = true;
      if (keep) Undo.finishEdit('Animation pose');
      else {
        for (const [key, g] of target.groups) {
          const r = current.get(key);
          for (let i = 0; i < 3; i++) g.rotation[i] = r[i];
        }
        applyPose(target, current); // hand bones back where they were
        refreshGroups(groups);
        if (Undo.cancelEdit) Undo.cancelEdit();
      }
    }
    dialog.show();
  }

  // ---- Thumbnail cache (IndexedDB, per viewer) ----
  let thumbDb = null;
  function openThumbDb() {
    if (thumbDb) return thumbDb;
    thumbDb = new Promise((resolve) => {
      try {
        const req = indexedDB.open('pose_studio_thumbnails', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('thumbs');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
    return thumbDb;
  }
  async function thumbGet(key) {
    const db = await openThumbDb();
    if (!db) return null;
    return new Promise((resolve) => {
      const req = db.transaction('thumbs').objectStore('thumbs').get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }
  async function thumbPut(key, value) {
    const db = await openThumbDb();
    if (db) db.transaction('thumbs', 'readwrite').objectStore('thumbs').put(value, key);
  }
  const thumbKey = (entry) => `v7|${entry.id}|${entry.geometryId}|${entry.texturePath}|${entry.source}`;

  async function makeThumbnail(content, entry) {
    const key = thumbKey(entry);
    const cached = await thumbGet(key);
    if (cached) return cached;
    const model = entityModel(content, entry);
    if (!model) return '';
    const url = await lookTextureUrl(content, entry);
    const image = url ? await loadImage(url).catch(() => null) : null;
    const thumb = renderThumbnail(model, image, 128);
    thumbPut(key, thumb);
    return thumb;
  }

  // ---- Import into the scene ----
  function entityRoots() {
    if (typeof Project === 'undefined' || !Project) return [];
    return Outliner.root.filter((node) => node instanceof Group && ENTITY_PREFIX.test(node.name) && node.pose_entity && node.pose_entity.entity);
  }

  // Which bones can be posed in game (first 20): named limbs first, then bones with cubes.
  function posableBones(model) {
    const score = (b) =>
      (/head|neck|body|torso|arm|leg|wing|tail|jaw|hand|foot|spine|chest|hip/i.test(b.name) ? 2 : 0) + (b.cubes.length ? 1 : 0);
    return model.bones
      .map((b, i) => ({ b, i, s: score(b) }))
      .sort((x, y) => y.s - x.s || x.i - y.i)
      .slice(0, MAX_POSABLE_BONES)
      .sort((x, y) => x.i - y.i)
      .map((x) => x.b.name);
  }

  // The texture for an entity look (shared by copies with the same look).
  async function entityTexture(content, entry, model) {
    const short = entry.id.replace(/^[^:]+:/, '').replace(/[^a-z0-9_]/gi, '_');
    const look = [entry.variant && entry.variant !== 'default' ? entry.variant : '', entry.baby ? 'baby' : ''].filter(Boolean).join('_').replace(/\s+/g, '_');
    const name = `ent_${short}${look ? '_' + look.replace(/[^a-z0-9_]/gi, '_') : ''}`;
    let texture = Texture.all.find((t) => t.name === name);
    let created = false;
    if (!texture) {
      const url = await lookTextureUrl(content, entry);
      if (url) {
        texture = new Texture({ name }).fromDataURL(url);
        texture.add(false);
        texture.uv_width = model.texture_width;
        texture.uv_height = model.texture_height;
        created = true;
      }
    }
    return { texture, created };
  }

  // Builds a model's bones and cubes inside `root`, offset by `at`. Returns the cubes and the
  // rest rotation of every bone.
  function buildEntityBones(root, model, texture, at) {
    const shift = (v) => [v[0] + at[0], v[1] + at[1], v[2] + at[2]];
    const rest = {};
    const cubes = [];
    const groups = new Map();
    // Blockbench needs a parent group set up before its children; model files don't always list
    // bones in that order (e.g. armour attachment bones inherited from geometry.humanoid).
    const byName = new Map(model.bones.map((b) => [b.name.toLowerCase(), b]));
    const ordered = [];
    const placed = new Set();
    const visit = (b, depth = 0) => {
      const key = b.name.toLowerCase();
      if (placed.has(key) || depth > 64) return;
      const parent = b.parent && byName.get(b.parent.toLowerCase());
      if (parent && parent !== b) visit(parent, depth + 1);
      if (!placed.has(key)) {
        placed.add(key);
        ordered.push(b);
      }
    };
    model.bones.forEach((b) => visit(b));
    for (const bone of ordered) {
      const group = new Group({ name: bone.name, origin: shift(bone.origin), rotation: bone.rotation.slice() });
      group.mirror_uv = bone.mirror;
      groups.set(bone.name.toLowerCase(), group); // Minecraft matches bone names case-insensitively
      rest[bone.name] = bone.rotation.slice();
    }
    for (const bone of ordered) {
      const group = groups.get(bone.name.toLowerCase());
      group.addTo(groups.get(String(bone.parent || '').toLowerCase()) || root).init();
      for (const c of bone.cubes) {
        const cube = new Cube({
          name: bone.name,
          from: shift(c.from),
          to: shift(c.to),
          origin: shift(c.origin),
          rotation: c.rotation.slice(),
          inflate: c.inflate,
          mirror_uv: c.mirror_uv,
          box_uv: c.box_uv,
          uv_offset: c.uv_offset.slice(),
          autouv: 0,
        })
          .addTo(group)
          .init();
        if (texture) cube.applyTexture(texture, true);
        if (!c.box_uv) {
          for (const key of Object.keys(cube.faces)) {
            const face = c.faces[key];
            if (!face || !face.enabled) {
              cube.faces[key].texture = null;
              continue;
            }
            cube.faces[key].uv = face.uv.slice();
            cube.faces[key].rotation = face.rotation || 0;
          }
        }
        cubes.push(cube);
      }
    }
    return { cubes, rest };
  }

  function entityInfo(entry, model, rest) {
    return {
      entity: entry.id, key: entryKey(entry), bones: posableBones(model), rest, source: entry.source,
      variant: entry.variant || 'default', baby: !!entry.baby, choices: entry.choices || {},
    };
  }

  async function importEntity(content, entry) {
    if (typeof Project === 'undefined' || !Project) newProject(Formats.free);
    const model = entityModel(content, entry);
    if (!model) throw new Error(`No model found for ${entry.id}.`);
    const short = entry.id.replace(/^[^:]+:/, '').replace(/[^a-z0-9_]/gi, '_');
    const used = Outliner.root.filter((n) => n instanceof Group && n.name.startsWith(`ent_${short}_`)).length;
    const name = `ent_${short}_${used + 1}`;
    const { origin: at, yaw } = placement();
    const { texture } = await entityTexture(content, entry, model);
    Undo.initEdit({ outliner: true, elements: [], textures: [] });
    const root = new Group({ name, origin: at.slice(), rotation: [0, yaw, 0] }).init();
    const { cubes, rest } = buildEntityBones(root, model, texture, at);
    root.pose_entity = entityInfo(entry, model, rest);
    Undo.finishEdit('Add entity', { outliner: true, elements: cubes, textures: texture ? [texture] : [] });
    Canvas.updateAll();
    root.select();
    return { root };
  }

  // Swaps an entity copy to another look (variant, baby or adult) where it stands. Bones keep how
  // far they were turned from their rest pose, and animations stay applied.
  async function setEntityVariant(root, content, entry) {
    const model = entityModel(content, entry);
    if (!model) throw new Error(`No model found for this variant of ${entry.id}.`);
    const { texture } = await entityTexture(content, entry, model);
    const info = root.pose_entity || {};
    const oldRest = new Map(Object.entries(info.rest || {}).map(([k, r]) => [k.toLowerCase(), r]));
    const turned = new Map();
    const oldNodes = [];
    eachDescendant(root, (node) => {
      oldNodes.push(node);
      if (node instanceof Group) {
        const r0 = oldRest.get(node.name.toLowerCase()) || [0, 0, 0];
        turned.set(node.name.toLowerCase(), node.rotation.map((v, i) => v - r0[i]));
      }
    });
    Undo.initEdit({ outliner: true, elements: oldNodes.filter((n) => !(n instanceof Group)), groups: [root], textures: [] });
    for (const node of oldNodes.slice().reverse()) {
      if (!(node instanceof Group) && node.remove) node.remove();
    }
    for (const node of oldNodes.slice().reverse()) {
      if (node instanceof Group && node.remove) node.remove(false);
    }
    const { cubes, rest } = buildEntityBones(root, model, texture, root.origin.slice());
    eachDescendant(root, (node) => {
      if (!(node instanceof Group)) return;
      const d = turned.get(node.name.toLowerCase());
      if (d) for (let i = 0; i < 3; i++) node.rotation[i] += d[i];
    });
    // remembered animations were added to a pose measured from the old rest pose
    if (root.pose_animation && root.pose_animation.base) {
      const base = {};
      for (const [k, r] of Object.entries(root.pose_animation.base)) {
        const r0 = oldRest.get(k) || [0, 0, 0];
        const r1 = Object.entries(rest).find(([n]) => n.toLowerCase() === k);
        base[k] = r.map((v, i) => v - r0[i] + (r1 ? r1[1][i] : 0));
      }
      root.pose_animation = Object.assign({}, root.pose_animation, { base });
    }
    root.pose_entity = entityInfo(entry, model, rest);
    Undo.finishEdit('Change entity variant', { outliner: true, elements: cubes, groups: [root], textures: texture ? [texture] : [] });
    if (root.pose_equipment && Object.values(root.pose_equipment).some(Boolean)) refreshEquipmentPreview(root);
    Canvas.updateAll();
    lastSent.delete(mannequinId(root.name));
  }


  // ---- The universal posable copy (generated into the development packs) ----
  // Minecraft only loads entity types when packs load, so instead of one generated entity per
  // model, one entity (pose:proxy) lists every model in the world: render-controller arrays pick
  // its geometry, texture and material from the pose:model property, and one animation per model
  // (gated on pose:model) maps that model's bones to the 30 packed-angle properties. It's rebuilt
  // only when the world's entity catalogue changes; then Minecraft needs one reload.
  const PROXY_TYPE = 'pose:proxy';
  const PROXY_REGISTRY = () => `${devPackDir('resource')}\\pose_studio_proxies.json`;

  const entryKey = (entry) => `${entry.id}|${entry.geometryId}|${entry.texturePath}${entry.flags && entry.flags.is_baby ? '|baby' : ''}`;

  let registryCache = null;
  function proxyRegistry() {
    if (registryCache) return registryCache;
    try {
      registryCache = JSON.parse(bedrockFs().readFileSync(PROXY_REGISTRY(), 'utf8'));
    } catch (e) {
      registryCache = {};
    }
    if (!registryCache.models) registryCache = { models: {}, hash: '' };
    return registryCache;
  }

  function hashString(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
    return h.toString(16).padStart(8, '0');
  }

  function angleExpr(index) {
    const prop = `q.property('pose:p${Math.floor(index / 2)}')`;
    const value = index % 2 === 0 ? `math.floor(${prop} / 4096)` : `(${prop} - math.floor(${prop} / 4096) * 4096)`;
    return `${value} * ${ANGLE_STEP} - 180`;
  }

  // Makes sure pose:proxy covers every entity in this world's catalogue. Returns the number of
  // models when files were (re)written, 0 when they were already up to date.
  function proxyMaterial(material) {
    return /^entity(_|$)/.test(material || '') ? material : 'entity_alphatest';
  }

  async function prepareProxy(content, list) {
    const models = list.map((entry) => {
      const geometry = restGeometry(content, entry.id, entry.geometryId, entry.flags);
      const model = geometry ? bedrockToBlockbench(geometry) : null;
      return { key: entryKey(entry), entry, geometry, bones: model ? posableBones(model) : [] };
    });
    const hash = hashString('v12|' + JSON.stringify(models.map((m) => [m.key, m.entry.material, m.bones, m.geometry && m.geometry.bones.length])));
    const registry = proxyRegistry();
    if (registry.hash === hash) return 0;

    const fs = bedrockFs();
    const bp = devPackDir('behavior');
    const rp = devPackDir('resource');
    if (!fs.existsSync(bp) || !fs.existsSync(rp)) throw new Error('The Pose Studio packs are not in development_behavior_packs / development_resource_packs.');
    for (const dir of [`${bp}\\entities`, `${rp}\\entity`, `${rp}\\animations`, `${rp}\\render_controllers`, `${rp}\\models\\entity`, `${rp}\\textures\\entity\\pose_studio\\baked`]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    // Remove per-model copies from the previous version.
    for (const dir of [`${bp}\\entities\\proxies`, `${rp}\\entity\\proxies`, `${rp}\\animations\\proxies`]) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }

    const properties = { 'pose:model': { type: 'int', range: [0, Math.max(0, models.length - 1)], default: 0, client_sync: true } };
    for (let i = 0; i < PACKED_PROPS; i++) {
      properties[`pose:p${i}`] = { type: 'int', range: [0, 16777215], default: NEUTRAL_PACKED, client_sync: true };
    }
    const behavior = {
      format_version: '1.20.80',
      'minecraft:entity': {
        description: { identifier: PROXY_TYPE, is_spawnable: false, is_summonable: true, properties },
        components: {
          'minecraft:type_family': { family: ['pose_studio', 'inanimate'] },
          'minecraft:collision_box': { width: 0.6, height: 1.8 },
          'minecraft:health': { value: 20, max: 20 },
          'minecraft:physics': { has_gravity: false, has_collision: false },
          'minecraft:pushable': { is_pushable: false, is_pushable_by_piston: false },
          'minecraft:knockback_resistance': { value: 1 },
          'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: false }] },
          'minecraft:fire_immune': {},
          'minecraft:persistent': {},
        },
      },
    };

    const description = {
      identifier: PROXY_TYPE,
      materials: {},
      textures: {},
      geometry: {},
      animations: {},
      scripts: { animate: [] },
      render_controllers: ['controller.render.pose_studio.proxy'],
      enable_attachables: true,
    };
    const animations = { format_version: '1.8.0', animations: {} };
    const arrays = { geos: [], skins: [], mats: [] };
    const registryModels = {};
    // merged textures of multi-layer looks (a horse's coat + markings + armour...)
    const looksDir = `${rp}\\textures\\entity\\pose_studio\\looks`;
    if (!fs.existsSync(looksDir)) fs.mkdirSync(looksDir, { recursive: true });
    for (const m of models) {
      if (!m.entry.layers || m.entry.layers.length < 2) continue;
      const url = await lookTextureUrl(content, m.entry);
      if (url) fs.writeFileSync(`${rp}\\${m.entry.texturePath.split('/').join('\\')}.png`, bufferClass().from(url.split(',')[1], 'base64'));
    }
    const geometries = [];
    // variants that only change the texture share a geometry (and its pose animation)
    const shared = new Map(); // geometry key -> { g, indices }
    const geometryOf = [];
    models.forEach((m, i) => {
      const geoKey = `${m.entry.id}|${m.entry.geometryId}|${m.entry.flags && m.entry.flags.is_baby ? 'baby' : ''}`;
      let slot = shared.get(geoKey);
      if (!slot) {
        const g = shared.size;
        const geometryId = `geometry.pose_studio.proxy.${g}`;
        geometries.push({
          description: { identifier: geometryId, texture_width: m.geometry.texture_width, texture_height: m.geometry.texture_height, visible_bounds_width: 8, visible_bounds_height: 8, visible_bounds_offset: [0, 2, 0] },
          bones: [
            { name: PROXY_ROOT_BONE, pivot: [0, 0, 0] },
            // legacy "neverRender" bones keep their place in the hierarchy but lose their cubes
            ...m.geometry.bones.map((b) => Object.assign({}, b, { parent: b.parent || PROXY_ROOT_BONE }, b.neverRender ? { cubes: [] } : {})),
          ],
        });
        description.geometry[`g${g}`] = geometryId;
        description.animations[`a${g}`] = `animation.pose_studio.proxy.${g}`;
        // angles 0-2: the whole model (pose_root); then 3 per posable bone
        const bones = { [PROXY_ROOT_BONE]: { rotation: [angleExpr(0), angleExpr(1), angleExpr(2)] } };
        m.bones.forEach((bone, k) => {
          const a = (k + 1) * 3;
          bones[bone] = { rotation: [angleExpr(a), angleExpr(a + 1), angleExpr(a + 2)] };
        });
        animations.animations[`animation.pose_studio.proxy.${g}`] = { loop: true, bones };
        slot = { g, indices: [] };
        shared.set(geoKey, slot);
      }
      slot.indices.push(i);
      geometryOf[i] = slot.g;
      description.textures[`t${i}`] = m.entry.texturePath;
      let masked = null;
      try {
        masked = maskedTextureUrl(content, m.entry);
      } catch (e) {
        masked = null;
      }
      if (masked) {
        const name = m.key.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
        fs.writeFileSync(`${rp}\\textures\\entity\\pose_studio\\baked\\${name}.png`, bufferClass().from(masked.split(',')[1], 'base64'));
        description.textures[`t${i}`] = `textures/entity/pose_studio/baked/${name}`;
      }
      description.materials[`m${i}`] = proxyMaterial(m.entry.material);
      arrays.geos.push(`Geometry.g${slot.g}`);
      arrays.skins.push(`Texture.t${i}`);
      arrays.mats.push(`Material.m${i}`);
      registryModels[m.key] = { index: i, bones: m.bones, entity: m.entry.id, source: m.entry.source };
    });
    // each pose animation plays for every model that uses its geometry
    for (const { g, indices } of shared.values()) {
      description.scripts.animate.push({ [`a${g}`]: indices.map((i) => `q.property('pose:model') == ${i}`).join(' || ') });
    }
    // Minecraft finds the hand bones for held items in the entity's "default" geometry, which the
    // arrays above never use. Point it at a humanoid model (the zombie's if there is one) so
    // humanoid copies draw what they hold.
    const hasHands = (m) => m.geometry && m.geometry.bones.some((b) => b.name === 'rightItem');
    const handModel = models.findIndex((m) => m.entry.id === 'minecraft:zombie' && hasHands(m));
    const fallback = models.findIndex(hasHands);
    const defaultIndex = handModel >= 0 ? handModel : fallback;
    if (defaultIndex >= 0) {
      description.geometry.default = description.geometry[`g${geometryOf[defaultIndex]}`];
      description.textures.default = description.textures[`t${defaultIndex}`];
      description.materials.default = description.materials[`m${defaultIndex}`];
    }

    const controller = {
      format_version: '1.8.0',
      render_controllers: {
        'controller.render.pose_studio.proxy': {
          arrays: {
            geometries: { 'Array.geos': arrays.geos },
            textures: { 'Array.skins': arrays.skins },
            materials: { 'Array.mats': arrays.mats },
          },
          geometry: "Array.geos[q.property('pose:model')]",
          textures: ["Array.skins[q.property('pose:model')]"],
          materials: [{ '*': "Array.mats[q.property('pose:model')]" }],
        },
      },
    };
    fs.writeFileSync(`${bp}\\entities\\pose_proxy.json`, JSON.stringify(behavior, null, 2));
    fs.writeFileSync(`${rp}\\entity\\pose_proxy.entity.json`, JSON.stringify({ format_version: '1.10.0', 'minecraft:client_entity': { description } }, null, 2));
    fs.writeFileSync(`${rp}\\animations\\pose_proxy.animation.json`, JSON.stringify(animations));
    fs.writeFileSync(`${rp}\\models\\entity\\pose_proxy.geo.json`, JSON.stringify({ format_version: '1.12.0', 'minecraft:geometry': geometries }));
    fs.writeFileSync(`${rp}\\render_controllers\\pose_proxy.render_controllers.json`, JSON.stringify(controller, null, 2));
    registryCache = { hash, models: registryModels, world: content.world || '' };
    fs.writeFileSync(PROXY_REGISTRY(), JSON.stringify(registryCache, null, 2));
    return models.length;
  }

  // Two 12-bit angles per int: high = even index, low = odd index.
  function packAngles(angles) {
    const q = [];
    for (let i = 0; i < PACKED_PROPS; i++) {
      const enc = (deg) => ((Math.round((wrap(deg) + 180) / ANGLE_STEP) % 4096) + 4096) % 4096;
      q.push(enc(angles[i * 2] || 0) * 4096 + enc(angles[i * 2 + 1] || 0));
    }
    return q;
  }

  function findBoneGroup(root, name) {
    let found = null;
    root.forEachChild((c) => {
      if (!found && c instanceof Group && c.name === name) found = c;
    });
    return found;
  }

  // Which model of pose:proxy an ent_ group is. Groups from 0.11.0 only stored the entity id.
  function proxyModelFor(info) {
    const models = proxyRegistry().models;
    if (info.key && models[info.key]) return models[info.key];
    return Object.entries(models).find(([key]) => key.startsWith(`${info.entity}|`))?.[1] || null;
  }

  // Where a hand bone is and how it's turned, in the model's space (every parent bone and the
  // pose included).
  function handMatrix(root, boneName) {
    const group = boneGroupOf(root, boneName);
    const object = group && (group.mesh || group.scene_object);
    if (!object) return null;
    const space = modelSpace();
    (space || object).updateMatrixWorld(true);
    const matrix = object.matrixWorld.clone();
    if (space) matrix.premultiply(new THREE.Matrix4().copy(space.matrixWorld).invert());
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    matrix.decompose(position, quaternion, new THREE.Vector3());
    return { position, quaternion };
  }

  // Held items on entity copies are drawn by invisible mannequins: each one is placed and turned
  // so that its own hand bone (rightItem / leftItem, at [±6, 15, 1] from its feet in Blockbench
  // space) lands exactly on the copy's hand.
  const MANNEQUIN_HAND = { rightItem: [6, 15, 1], leftItem: [-6, 15, 1] };
  function heldItems(root) {
    const eq = root.pose_equipment || {};
    const hands = {};
    for (const [side, slot, bone] of [['main', 'mainhand', 'rightItem'], ['off', 'offhand', 'leftItem']]) {
      if (!eq[slot]) continue;
      const hand = handMatrix(root, bone);
      if (!hand) continue;
      // both holders hold the item in their main hand (Bedrock's off hand refuses most items), so
      // each is placed by its right hand
      const feet = hand.position.clone().sub(new THREE.Vector3(...MANNEQUIN_HAND.rightItem).applyQuaternion(hand.quaternion));
      const e = new THREE.Euler().setFromQuaternion(hand.quaternion, eulerOrder());
      const p = toWorld(feet.toArray());
      const r = toBedrockRot([e.x / DEG, e.y / DEG, e.z / DEG]);
      if (![...p, ...r].every(Number.isFinite)) continue;
      hands[side] = { p, r, item: eq[slot] };
    }
    return hands;
  }

  // Held items on entity copies disconnect the world (cause still being tracked down), so they're
  // switched off: the Blockbench preview still shows them, Minecraft doesn't.
  // More ▸ Held Items on Entities: on unless turned off (remembered per Blockbench install)
  function savedHeldItems() {
    try {
      return localStorage.getItem('pose_studio_entity_held_items') !== 'off';
    } catch (e) {
      return true;
    }
  }
  let entityHeldItems = savedHeldItems();

  function handMessage(root, side) {
    const hand = heldItems(root)[side];
    const id = mannequinId(root.name);
    return JSON.stringify(hand ? { id, s: side, p: hand.p, r: hand.r, i: hand.item } : { id, s: side });
  }

  // Pose message for an entity: which model, bone rotations relative to the model's rest pose
  // (Bedrock convention, packed), and the root group's Y rotation as the entity's yaw.
  let warnedMissing = new Set();
  function entityMessage(root) {
    const info = root.pose_entity;
    const model = proxyModelFor(info);
    if (!model) {
      if (!warnedMissing.has(root.name)) {
        warnedMissing.add(root.name);
        Blockbench.showQuickMessage(`${root.name}: open Add Entity… for this world so Minecraft can show it`, 3000);
      }
      return null;
    }
    const angles = toBedrockRot(root.rotation);
    for (const bone of model.bones) {
      const group = findBoneGroup(root, bone);
      const now = group ? toBedrockRot(group.rotation) : [0, 0, 0];
      const rest = toBedrockRot((info.rest && info.rest[bone]) || [0, 0, 0]);
      angles.push(wrap(now[0] - rest[0]), wrap(now[1] - rest[1]), wrap(now[2] - rest[2]));
    }
    // only worn armour goes to the copy; held items are sent separately (see handMessage)
    const armour = {};
    for (const slot of ['head', 'chest', 'legs', 'feet']) if ((root.pose_equipment || {})[slot]) armour[slot] = root.pose_equipment[slot];
    return JSON.stringify({ id: mannequinId(root.name), t: PROXY_TYPE, m: model.index, p: toWorld(root.origin), y: 0, q: packAngles(angles).map((n) => n.toString(36)).join(','), e: armour });
  }

  // Prepares pose:proxy for the browser's world and offers the one reload it needs.
  async function prepareForWorld(state) {
    // every variant and baby of every entity, so switching variants never needs a reload
    const count = await prepareProxy(state.content, state.list.flatMap((e) => variantEntries(state.content, e)));
    if (!count) return;
    Blockbench.showMessageBox(
      {
        title: 'Pose Studio: entities prepared',
        message:
          `Pose Studio prepared all ${state.list.length} entities in this world for Minecraft (${count} looks, counting variants and babies). Minecraft needs to reload its packs once to load them. ` +
          "After that, adding any of these entities is instant.\n\nYou'll only be asked again when this world's packs change. Reload now?",
        buttons: ['Reload now', 'Later'],
        confirm: 0,
        cancel: 1,
      },
      (button) => button === 0 && reloadMinecraftPacks()
    );
  }

  // ---- Variants window ----
  // Pose Studio ▸ Variant… (an entity copy selected): every look of that mob, adults and babies,
  // with thumbnails. Clicking one swaps the copy's model and texture where it stands.
  async function openVariants() {
    const root = selectedPoseRoot();
    if (!root || !ENTITY_PREFIX.test(root.name) || !root.pose_entity) {
      Blockbench.showQuickMessage('Select an entity (ent_) first', 2000);
      return;
    }
    let state;
    try {
      state = contentCache || (await loadWorldContent(null));
    } catch (e) {
      showError('Pose Studio: variants', e);
      return;
    }
    const base = state.list.find((e) => e.id === root.pose_entity.entity);
    const looks = base ? variantEntries(state.content, base) : [];
    if (looks.length < 2) {
      Blockbench.showMessageBox({ title: 'Pose Studio', message: `${base ? base.name : root.pose_entity.entity} has no other variants.` });
      return;
    }
    const choices = looks.choiceList || [];
    const currentLook = looks.find((l) => entryKey(l) === root.pose_entity.key) || looks[0];
    // the closest look to a set of choices (a baby can't wear horse armour, for instance)
    const closest = (sel, baby) => {
      let best = null;
      let score = -1;
      for (const l of looks) {
        if (l.baby !== baby) continue;
        const s = choices.reduce((n, c, i) => n + ((l.choices || {})[c.name] === sel[c.name] ? (i === 0 ? 100 : 10) : 0), 0);
        if (s > score) {
          score = s;
          best = l;
        }
      }
      return best;
    };
    const hasBabies = looks.some((l) => l.baby);
    let busy = Promise.resolve();
    new Dialog({
      id: 'pose_studio_variants',
      title: `Variant: ${root.name}`,
      width: 680,
      buttons: ['Done'],
      component: {
        data: () => ({
          choices: choices.map((c) => ({ name: c.name, label: c.label, values: c.values })),
          sel: Object.assign({}, ...choices.map((c) => ({ [c.name]: (currentLook.choices || {})[c.name] || 0 }))),
          baby: !!currentLook.baby,
          hasBabies,
          current: entryKey(currentLook),
          thumbs: {},
        }),
        computed: {
          // the grid: looks that differ only in the first choice (or every look when there's none)
          grid() {
            const first = this.choices[0];
            return looks
              .map((l, i) => ({ i, key: entryKey(l), label: first ? first.values[(l.choices || {})[first.name]] || l.variant : l.variant + (l.baby ? ' (baby)' : ''), look: l }))
              .filter(({ look }) => !first || (look.baby === this.baby && this.choices.slice(1).every((c) => (look.choices || {})[c.name] === this.sel[c.name])));
          },
        },
        watch: {
          grid: {
            immediate: true,
            handler(list) {
              this.loadThumbs(list);
            },
          },
        },
        methods: {
          async loadThumbs(list) {
            for (const g of list) {
              if (this.thumbs[g.key]) continue;
              this.$set ? this.$set(this.thumbs, g.key, '…') : (this.thumbs[g.key] = '…');
              let url = 'none';
              try {
                url = (await makeThumbnail(state.content, g.look)) || 'none';
              } catch (e) {
                url = 'none';
              }
              this.$set ? this.$set(this.thumbs, g.key, url) : (this.thumbs[g.key] = url);
              await sleep(0);
            }
          },
          apply(look) {
            if (!look) return;
            this.current = entryKey(look);
            for (const c of this.choices) if ((look.choices || {})[c.name] !== undefined) this.sel[c.name] = look.choices[c.name];
            this.baby = look.baby;
            busy = busy.then(() => setEntityVariant(root, state.content, look)).catch((e) => showError('Pose Studio: variant', e));
            return busy;
          },
          pickTile(g) {
            return this.apply(this.choices.length ? closest(Object.assign({}, this.sel, { [this.choices[0].name]: (g.look.choices || {})[this.choices[0].name] }), this.baby) : g.look);
          },
          changed() {
            return this.apply(closest(this.sel, this.baby));
          },
        },
        template: `
          <div class="pose_studio_variants">
            <div v-if="choices.length > 1 || hasBabies" style="display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; margin-bottom: 10px;">
              <label v-for="c in choices.slice(1)" :key="c.name" style="display: flex; gap: 6px; align-items: center;">
                <span>{{ c.label }}</span>
                <select v-model.number="sel[c.name]" @change="changed()">
                  <option v-for="(v, i) in c.values" :value="i">{{ v }}</option>
                </select>
              </label>
              <label v-if="hasBabies" style="display: flex; gap: 6px; align-items: center;">
                <input type="checkbox" v-model="baby" @change="changed()"> Baby
              </label>
            </div>
            <h3 v-if="choices.length" style="margin: 0 0 6px;">{{ choices[0].label }}</h3>
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; max-height: 420px; overflow-y: auto;">
              <div v-for="g in grid" :key="g.key" @click="pickTile(g)" :title="g.look.variant + (g.look.baby ? ' (baby)' : '')"
                   :style="{ cursor: 'pointer', border: '1px solid var(--color-border)', borderRadius: '6px', padding: '4px', textAlign: 'center',
                             background: g.key === current ? 'var(--color-selected)' : '' }">
                <img v-if="thumbs[g.key] && thumbs[g.key] !== 'none' && thumbs[g.key] !== '…'" :src="thumbs[g.key]" style="width: 72px; height: 72px; image-rendering: pixelated;">
                <div v-else style="width: 72px; height: 72px; margin: auto; display: flex; align-items: center; justify-content: center; opacity: 0.4;">{{ thumbs[g.key] === 'none' ? '' : '…' }}</div>
                <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-transform: capitalize;">{{ g.label }}</div>
              </div>
            </div>
          </div>`,
      },
    }).show();
  }

  // ---- The browser ----
  // A floating Blockbench panel: it can be moved, resized or docked, and stays open while you
  // add entities and work in the viewport.
  let browserState = null; // loaded world content for the panel
  let browserWorlds = [];
  let browserVm = null;
  let entityPanel = null;

  const browserEntries = (list) => list.map((e) => Object.assign({ thumb: '' }, e));

  function createEntityPanel() {
    entityPanel = new Panel('pose_studio_entities', {
      name: 'Add Entity',
      icon: 'pets',
      resizable: true,
      growable: true,
      default_position: {
        slot: 'hidden',
        float_position: [120, 90],
        float_size: [620, 560],
        height: 560,
        folded: false,
      },
      component: {
        data: () => ({
          ready: false,
          worlds: [],
          worldPath: '',
          packs: [],
          items: [],
          search: '',
          source: 'all',
          busy: false,
          baby: false,
        }),
        computed: {
          sources() {
            return Array.from(new Set(this.items.map((i) => i.source)));
          },
          shown() {
            const q = this.search.trim().toLowerCase();
            return this.items.filter(
              (i) => (this.source === 'all' || i.source === this.source) && (!q || i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q))
            );
          },
        },
        methods: {
          // Loads (or reloads) the entity list; the first time it picks the last-played world.
          async load(force) {
            this.busy = true;
            try {
              await findInstallData();
              if (!browserWorlds.length || force) browserWorlds = worldChoices();
              const lastPlayed = browserWorlds.find((w) => !w.picked);
              this.worlds = browserWorlds.map((w) => ({ path: w.path, label: `${w.name}${w.picked ? ' (picked)' : w === lastPlayed ? ' (last played)' : ''}` }));
              const world = browserWorlds.find((w) => w.path === this.worldPath) || browserWorlds[0] || null;
              browserState = await loadWorldContent(world, force);
              this.worldPath = world ? world.path : '';
              this.packs = browserState.content.rp.map((p) => ({ name: p.name, found: !!p.dir }));
              this.items = browserEntries(browserState.list);
              this.source = 'all';
              this.ready = true;
              try {
                await prepareForWorld(browserState);
              } catch (e) {
                showError('Pose Studio: preparing entities for Minecraft', e);
              }
              this.fillThumbnails();
            } catch (e) {
              showError('Pose Studio: entities', e);
            }
            this.busy = false;
          },
          async fillThumbnails() {
            const items = this.items;
            for (const item of items) {
              if (this.items !== items) return; // world changed
              if (item.thumb) continue;
              try {
                item.thumb = (await makeThumbnail(browserState.content, item)) || 'none';
              } catch (e) {
                item.thumb = 'none';
              }
              await sleep(0);
            }
          },
          async add(item) {
            try {
              let entry = item;
              if (this.baby) {
                entry = variantEntries(browserState.content, item).find((v) => v.baby);
                if (!entry) {
                  Blockbench.showQuickMessage(`${item.name} has no baby version`, 2000);
                  return;
                }
              }
              const { root } = await importEntity(browserState.content, entry);
              Blockbench.showQuickMessage(`Added ${entry.baby ? 'baby ' : ''}${item.name} as ${root.name}`, 1500);
            } catch (e) {
              showError('Pose Studio: add entity', e);
            }
          },
          close() {
            entityPanel.moveTo('hidden');
          },
        },
        mounted() {
          browserVm = this;
        },
        template: `
          <div class="pose_studio_entities" style="display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 6px 8px; box-sizing: border-box;">
            <div style="display: flex; gap: 6px; align-items: center; margin-bottom: 6px; flex-wrap: wrap;">
              <label>World</label>
              <select v-model="worldPath" @change="load(false)" style="flex: 1; min-width: 160px;">
                <option v-for="w in worlds" :value="w.path">{{ w.label }}</option>
              </select>
              <button @click="load(true)" :disabled="busy" title="Re-read worlds and packs (after editing them)">Rescan</button>
              <a href="#" @click.prevent="close()" title="Hide this panel (Pose Studio ▸ Add Entity… opens it again)">Close</a>
            </div>
            <div style="margin-bottom: 6px; font-size: 0.9em; opacity: 0.85;">
              Resource packs:
              <span v-if="!packs.length">none, showing Minecraft's own entities</span>
              <span v-for="p in packs" :style="{ marginRight: '10px', color: p.found ? '' : 'var(--color-warning, #e8a33d)' }">{{ p.name }}{{ p.found ? '' : ' (not found)' }}</span>
            </div>
            <div style="display: flex; gap: 6px; margin-bottom: 8px;">
              <input type="text" v-model="search" placeholder="Search entities…" style="flex: 1;" class="dark_bordered">
              <select v-model="source">
                <option value="all">All sources</option>
                <option v-for="s in sources" :value="s">{{ s }}</option>
              </select>
              <label style="display: flex; align-items: center; gap: 4px; white-space: nowrap;" title="Add the baby version (for mobs that have one). Other variants: select the entity, then Pose Studio ▸ Variant…">
                <input type="checkbox" v-model="baby"> Baby
              </label>
            </div>
            <p v-if="!ready" style="opacity: 0.7;">{{ busy ? 'Loading entities…' : '' }}</p>
            <div style="flex: 1; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); grid-auto-rows: min-content; gap: 6px;">
              <div v-for="item in shown" :key="item.id" @click="add(item)" :title="'Add ' + item.name + ' (' + item.id + ' · ' + item.source + ')'"
                   style="cursor: pointer; border: 1px solid var(--color-border); border-radius: 6px; padding: 4px; text-align: center;">
                <img v-if="item.thumb && item.thumb !== 'none'" :src="item.thumb" style="width: 80px; height: 80px; image-rendering: pixelated;">
                <div v-else style="width: 80px; height: 80px; margin: auto; display: flex; align-items: center; justify-content: center; opacity: 0.4;">{{ item.thumb === 'none' ? 'no preview' : '…' }}</div>
                <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ item.name }}</div>
                <div style="font-size: 0.8em; opacity: 0.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ item.source }}</div>
              </div>
              <p v-if="ready && !shown.length" style="opacity: 0.7;">No entities match.</p>
            </div>
          </div>`,
      },
    });
  }

  // Pose Studio ▸ Add Entity…: shows the panel (floating, in front) and loads it the first time.
  function openEntityBrowser() {
    if (!entityPanel) createEntityPanel();
    if (entityPanel.slot !== 'float' && entityPanel.slot !== 'left_bar' && entityPanel.slot !== 'right_bar') entityPanel.moveTo('float');
    if (entityPanel.moveToFront) entityPanel.moveToFront();
    if (browserVm && !browserVm.ready && !browserVm.busy) return browserVm.load(false);
    return Promise.resolve();
  }

  // ---- Equipment (armour and held items) ----------------------------------------------------
  // Stored on the mannequin as pose_equipment { head, chest, legs, feet, mainhand, offhand } of item
  // ids. Minecraft gets real items in those slots (so its own armour and item rendering is used);
  // Blockbench shows a preview built from the same armour models and item icons.
  const ARMOR_PIECES = [
    { slot: 'head', piece: 'helmet', label: 'Head', layer: 1 },
    { slot: 'chest', piece: 'chestplate', label: 'Chest', layer: 1 },
    { slot: 'legs', piece: 'leggings', label: 'Legs', layer: 2 },
    { slot: 'feet', piece: 'boots', label: 'Feet', layer: 1 },
  ];
  const ARMOR_MATERIALS = [
    { item: 'leather', name: 'Leather', texture: 'cloth', tint: '#a06540' },
    { item: 'chainmail', name: 'Chainmail', texture: 'chain' },
    { item: 'iron', name: 'Iron', texture: 'iron' },
    { item: 'golden', name: 'Gold', texture: 'gold' },
    { item: 'diamond', name: 'Diamond', texture: 'diamond' },
    { item: 'netherite', name: 'Netherite', texture: 'netherite' },
    { item: 'copper', name: 'Copper', texture: 'copper' },
    { item: 'turtle', name: 'Turtle Shell', texture: 'turtle', only: 'head' },
  ];
  const TIERS = [
    ['wooden', 'wood', 'Wooden'],
    ['stone', 'stone', 'Stone'],
    ['iron', 'iron', 'Iron'],
    ['golden', 'gold', 'Golden'],
    ['diamond', 'diamond', 'Diamond'],
    ['netherite', 'netherite', 'Netherite'],
  ];
  const HAND_ITEMS = [
    ...['sword', 'axe', 'pickaxe', 'shovel', 'hoe'].flatMap((tool) =>
      TIERS.map(([id, tex, name]) => ({ id: `${id}_${tool}`, name: `${name} ${tool[0].toUpperCase()}${tool.slice(1)}`, texture: `textures/items/${tex}_${tool}` }))
    ),
    { id: 'bow', name: 'Bow', texture: 'textures/items/bow_standby' },
    { id: 'crossbow', name: 'Crossbow', texture: 'textures/items/crossbow_standby' },
    { id: 'trident', name: 'Trident', texture: 'textures/items/trident' },
    { id: 'mace', name: 'Mace', texture: 'textures/items/mace' },
    { id: 'shield', name: 'Shield', texture: 'textures/items/shield' },
    { id: 'fishing_rod', name: 'Fishing Rod', texture: 'textures/items/fishing_rod_uncast' },
    { id: 'shears', name: 'Shears', texture: 'textures/items/shears' },
    { id: 'flint_and_steel', name: 'Flint and Steel', texture: 'textures/items/flint_and_steel' },
    { id: 'stick', name: 'Stick', texture: 'textures/items/stick' },
    { id: 'apple', name: 'Apple', texture: 'textures/items/apple' },
    { id: 'golden_apple', name: 'Golden Apple', texture: 'textures/items/apple_golden' },
    { id: 'bread', name: 'Bread', texture: 'textures/items/bread' },
    { id: 'cooked_beef', name: 'Steak', texture: 'textures/items/beef_cooked' },
    { id: 'book', name: 'Book', texture: 'textures/items/book_normal' },
    { id: 'bucket', name: 'Bucket', texture: 'textures/items/bucket_empty' },
    { id: 'water_bucket', name: 'Water Bucket', texture: 'textures/items/bucket_water' },
    { id: 'spyglass', name: 'Spyglass', texture: 'textures/items/spyglass' },
    { id: 'totem_of_undying', name: 'Totem of Undying', texture: 'textures/items/totem' },
  ];

  const armorItem = (material, piece) => (material.item === 'turtle' ? 'minecraft:turtle_helmet' : `minecraft:${material.item}_${piece.piece}`);
  const shortItem = (id) => String(id || '').replace(/^minecraft:/, '');

  // Content for previews: the browser's world if it has been opened, otherwise vanilla only.
  async function previewContent() {
    // the open world's packs: the picked world, else the last played one (loaded again only when
    // that's a different world from the one loaded last)
    let world = null;
    try {
      world = worldChoices()[0] || null;
    } catch (e) {
      world = null;
    }
    if (contentCache && (!world || contentCache.worldPath === world.path)) return contentCache.content;
    return (await loadWorldContent(world)).content;
  }

  // ---- Custom armour ----
  // Armour from the world's packs: items with a wearable armour slot (behavior pack) drawn by an
  // attachable (resource pack). Attachable models are built on the player's bones (head, body,
  // rightArm, leftLeg…), so each piece snaps onto the same bones of the mannequin; the attachable's
  // render controller decides which parts of a shared armour model a piece shows.
  const ARMOR_SLOT_ORDER = ['head', 'chest', 'legs', 'feet'];
  const SLOT_WORDS = /\b(helmet|helm|hood|hat|cap|mask|crown|chestplate|chest|tunic|robe|armou?r|leggings|legs|pants|trousers|boots|shoes|feet|greaves|sabatons)\b/gi;

  function itemName(content, id) {
    const info = content.items && content.items.get(id);
    const key = info && info.name && /^[\w.:-]+$/.test(info.name) ? info.name.replace(/^item\./, '').replace(/\.name$/, '') : id;
    return (content.itemNames && (content.itemNames.get(key) || content.itemNames.get(id))) || (info && info.name && !/^[\w.:-]+$/.test(info.name) ? info.name : '') || prettyName(id);
  }

  function itemIconPath(content, id) {
    const info = content.items && content.items.get(id);
    const key = info && info.icon;
    return (key && content.itemTextures && content.itemTextures.get(key)) || '';
  }

  // The attachable that draws an item on the mannequin (not one meant only for players).
  function findAttachable(content, itemId) {
    const list = (content.attachables && content.attachables.get(itemId)) || [];
    const forOwner = (a) => {
      const c = String(a.condition || '').toLowerCase();
      if (!c) return true;
      const m = c.match(/owner_identifier\s*(==|!=)\s*'([^']+)'/);
      if (m) return (m[2] === 'minecraft:player') === (m[1] === '!=');
      return idleCondition(c);
    };
    return list.slice().reverse().find((a) => !a.condition && forOwner(a)) || list.slice().reverse().find(forOwner) || null;
  }

  function armorSlotOf(content, id) {
    const info = content.items && content.items.get(id);
    if (info && info.slot) return info.slot;
    const n = id.toLowerCase();
    if (/helmet|helm|hood|_hat|_cap|mask|crown/.test(n)) return 'head';
    if (/chestplate|chest|tunic|robe/.test(n)) return 'chest';
    if (/leggings|_legs|pants|trousers|greaves/.test(n)) return 'legs';
    if (/boots|shoes|feet|sabatons/.test(n)) return 'feet';
    return '';
  }

  // Every 3D armour piece in the world's packs, grouped into sets (pieces sharing one model and
  // texture): [{ key, name, source, icon, pieces: { head, chest, legs, feet } }] and a flat list.
  function customArmour(content) {
    const pieces = [];
    const ids = new Set([...((content.items && content.items.keys()) || [])].concat([...((content.attachables && content.attachables.keys()) || [])]));
    for (const id of ids) {
      if (/^minecraft:/.test(id)) continue; // vanilla armour has its own list (and uses a pack's restyle automatically)
      const info = content.items && content.items.get(id);
      const attachable = findAttachable(content, id);
      if (!attachable) continue;
      const slot = (info && info.slot) || (!info ? armorSlotOf(content, id) : '');
      if (!slot) continue;
      const d = attachable.description;
      const geometry = (d.geometry && (d.geometry.default || Object.values(d.geometry)[0])) || '';
      const texture = (d.textures && (d.textures.default || Object.values(d.textures)[0])) || '';
      pieces.push({ id, slot, name: itemName(content, id), source: (info && info.source) || attachable.layer.label, iconPath: itemIconPath(content, id), setKey: `${geometry}|${texture}` });
    }
    const sets = new Map();
    for (const piece of pieces) {
      const set = sets.get(piece.setKey) || { key: piece.setKey, source: piece.source, pieces: {} };
      if (!set.pieces[piece.slot]) set.pieces[piece.slot] = piece;
      sets.set(piece.setKey, set);
    }
    for (const set of sets.values()) set.name = setName(Object.values(set.pieces));
    const list = [...sets.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { sets: list, pieces: pieces.sort((a, b) => ARMOR_SLOT_ORDER.indexOf(a.slot) - ARMOR_SLOT_ORDER.indexOf(b.slot) || a.name.localeCompare(b.name)) };
  }

  // A set's name: the words its pieces' names share ("Helmet of the Elder Raze" and "Boots of the
  // Elder Raze" -> "Elder Raze"), else the item id without the piece word.
  function setName(pieces) {
    const words = pieces.map((p) => p.name.replace(SLOT_WORDS, ' ').split(/\s+/).filter(Boolean));
    let shared = words[0] || [];
    for (const w of words.slice(1)) shared = shared.filter((x) => w.includes(x));
    const name = shared.join(' ').replace(/^(of|the)\s+/i, '').replace(/^(of|the)\s+/i, '').trim();
    if (name && pieces.length > 1) return name;
    if (pieces.length === 1) return pieces[0].name;
    return prettyName(pieces[0].id.replace(/_?(helmet|chestplate|leggings|boots)$/i, ''));
  }

  // Which bones of the attachable's model this piece shows (its render controllers' part_visibility).
  function attachableVisibility(content, attachable, vars) {
    const rules = [];
    for (const rc of attachable.description.render_controllers || []) {
      const id = typeof rc === 'string' ? rc : Object.keys(rc)[0];
      const def = content.controllers.get(id);
      for (const entry of (def && def.part_visibility) || []) {
        for (const [pattern, value] of Object.entries(entry)) {
          const re = new RegExp('^' + pattern.toLowerCase().replace(/[.+?^$(){}|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
          let on = value;
          if (typeof value === 'string') {
            const expr = value.replace(/\b(variable|v)\.([a-z0-9_]+)/gi, (m, k, n) => (n.toLowerCase() in vars ? `(${Number(vars[n.toLowerCase()]) || 0})` : m));
            on = idleCondition(expr);
          }
          rules.push({ re, on: !!on });
        }
      }
    }
    return (bone) => {
      let on = true;
      for (const r of rules) if (r.re.test(bone.toLowerCase())) on = r.on;
      return on;
    };
  }

  const MANNEQUIN_BONE_KEYS = ['waist', 'head', 'body', 'rightarm', 'leftarm', 'rightleg', 'leftleg'];

  // Adds an attachable's model to the mannequin (or entity): its bones snap onto the bones of the
  // same name; parts in between (armour pieces) become eq_ groups that keep their own pivots.
  async function addAttachablePreview(mannequin, content, itemId, slot, shift, cubes, textures) {
    const attachable = findAttachable(content, itemId);
    if (!attachable) return false;
    const d = attachable.description;
    const geometryId = d.geometry && (d.geometry.default || Object.values(d.geometry)[0]);
    const geometry = geometryId && resolveGeometry(content.geometries, geometryId);
    if (!geometry) return false;
    const texturePath = d.textures && (d.textures.default || Object.values(d.textures)[0]);
    const texture = await previewTexture(content, `eq_${String(texturePath).split('/').pop()}`, texturePath, geometry.texture_width, geometry.texture_height);
    if (texture && !textures.includes(texture)) textures.push(texture);
    const visible = attachableVisibility(content, attachable, { slim_arms: mannequin.pose_slim ? 1 : 0, is_enchanted: 0, has_trim: 0 });
    const model = bedrockToBlockbench({ bones: geometry.bones, texture_width: geometry.texture_width, texture_height: geometry.texture_height });
    const byName = new Map(model.bones.map((b) => [b.name.toLowerCase(), b]));
    const anchorOf = (bone) => {
      for (let b = bone, i = 0; b && i < 64; b = b.parent && byName.get(b.parent.toLowerCase()), i++) {
        const key = b.name.toLowerCase();
        if (MANNEQUIN_BONE_KEYS.includes(key)) return key;
      }
      return '';
    };
    // only bones that show something (themselves or below)
    const shows = new Map();
    const showsSomething = (bone, depth = 0) => {
      const key = bone.name.toLowerCase();
      if (shows.has(key)) return shows.get(key);
      shows.set(key, false);
      const own = bone.cubes.length > 0 && visible(bone.name);
      const below = depth < 64 && model.bones.some((b) => b.parent && b.parent.toLowerCase() === key && showsSomething(b, depth + 1));
      shows.set(key, own || below);
      return own || below;
    };
    const groups = new Map();
    const groupFor = (bone, depth = 0) => {
      const key = bone.name.toLowerCase();
      if (MANNEQUIN_BONE_KEYS.includes(key)) return boneGroupOf(mannequin, bone.name);
      if (groups.has(key)) return groups.get(key);
      const parentBone = bone.parent && byName.get(bone.parent.toLowerCase());
      const parentGroup = parentBone && depth < 64 ? groupFor(parentBone, depth + 1) : null;
      // bones above the waist (root) hang off the mannequin itself
      const host = parentGroup || (anchorOf(bone) ? boneGroupOf(mannequin, anchorOf(bone)) : mannequin) || mannequin;
      const isArmourPart = key !== 'root';
      const group = isArmourPart
        ? new Group({ name: `eq_${bone.name}`, origin: shift(bone.origin), rotation: bone.rotation.slice() }).addTo(host).init()
        : host;
      groups.set(key, group);
      return group;
    };
    for (const bone of model.bones) {
      if (!bone.cubes.length || !visible(bone.name) || !showsSomething(bone)) continue;
      const group = groupFor(bone);
      if (!group) continue;
      addPreviewCubes(group, bone, shift, texture, `eq_${slot}`, cubes);
    }
    // the armour's own animations (a cloak's angle), on its parts only (not the player's bones)
    const ownerVars = ownerVariables(mannequin);
    const offsets = attachableOffsets(content, d, ownerVars);
    const drivers = attachableDrivers(content, d);
    for (const [key, group] of groups) {
      if (!group || group === mannequin || !/^eq_/.test(group.name)) continue;
      const o = offsets.get(key);
      if (o) {
        group.rotation = [group.rotation[0] - o.rotation[0], group.rotation[1] - o.rotation[1], group.rotation[2] + o.rotation[2]];
        translateTree(group, [-o.position[0], o.position[1], o.position[2]]);
      }
      if (drivers.has(key)) markDriver(group, drivers.get(key), ownerVars);
    }
    return true;
  }

  function addPreviewCubes(group, bone, shift, texture, name, cubes) {
    for (const c of bone.cubes) {
      const cube = new Cube({
        name,
        from: shift(c.from),
        to: shift(c.to),
        origin: shift(c.origin),
        rotation: c.rotation.slice(),
        inflate: c.inflate,
        mirror_uv: c.mirror_uv,
        box_uv: c.box_uv,
        uv_offset: c.uv_offset.slice(),
        autouv: 0,
      })
        .addTo(group)
        .init();
      if (texture) cube.applyTexture(texture, true);
      if (!c.box_uv) {
        for (const key of Object.keys(cube.faces)) {
          const face = c.faces[key];
          if (!face || !face.enabled) {
            cube.faces[key].texture = null;
            continue;
          }
          cube.faces[key].uv = face.uv.slice();
          cube.faces[key].rotation = face.rotation || 0;
        }
      }
      cubes.push(cube);
    }
  }

  // Every 3D item in the world's packs that isn't armour (weapons, tools…): [{ id, name, iconPath }].
  function customHandItems(content) {
    const out = [];
    const ids = new Set([...((content.items && content.items.keys()) || [])].concat([...((content.attachables && content.attachables.keys()) || [])]));
    for (const id of ids) {
      if (/^minecraft:/.test(id) || /\.player$/.test(id)) continue;
      const info = content.items && content.items.get(id);
      if ((info && info.slot) || (!info && armorSlotOf(content, id))) continue;
      if (!findAttachable(content, id)) continue;
      out.push({ id, name: itemName(content, id), iconPath: itemIconPath(content, id) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Leather armour is grey in its texture and tinted in game; tint the preview the default brown.
  async function tintedDataUrl(url, tint) {
    if (!tint) return url;
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, img.width, img.height);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  }

  async function previewTexture(content, name, path, uvWidth, uvHeight, tint) {
    let texture = Texture.all.find((t) => t.name === name);
    if (texture) return texture;
    const found = findTexture(content, path);
    if (!found) return null;
    const url = await tintedDataUrl(textureDataUrl(found.file.read(), found.ext), tint);
    texture = new Texture({ name }).fromDataURL(url);
    texture.add(false);
    texture.uv_width = uvWidth;
    texture.uv_height = uvHeight;
    return texture;
  }

  function boneGroupOf(root, boneName) {
    const key = boneName.toLowerCase();
    if (!ENTITY_PREFIX.test(root.name)) {
      if (key === 'rightitem' || key === 'leftitem') return itemBoneOf(root, key);
      const mannequinKey = key === 'hat' ? 'head' : key;
      return mannequinBone(root, mannequinKey);
    }
    let found = null;
    root.forEachChild((c) => {
      if (!found && c instanceof Group && c.name.toLowerCase() === key) found = c;
    });
    return found;
  }

  // Entity models hold items at their rightItem / leftItem bones (humanoid mobs all have them).
  function handPoint(root, side) {
    const itemBone = boneGroupOf(root, side === 'rightArm' ? 'rightItem' : 'leftItem');
    if (itemBone && ENTITY_PREFIX.test(root.name)) return { group: itemBone, at: itemBone.origin.slice() };
    const arm = boneGroupOf(root, side);
    if (!arm) return null;
    const hand = itemBoneOf(root, side === 'rightArm' ? 'rightItem' : 'leftItem');
    if (hand) return { group: hand, at: hand.origin.slice() };
    // mannequin: the player's rightItem / leftItem pivot, in Blockbench space
    const [rx, ry, rz] = root.origin;
    return { group: arm, at: [(side === 'rightArm' ? 6 : -6) + rx, 15 + ry, 1 + rz] };
  }

  // The mannequin or entity group that is selected (or contains the selection).
  function selectedPoseRoot() {
    let node = Group.first_selected !== undefined ? Group.first_selected : Group.selected;
    if (!node && Outliner.selected && Outliner.selected.length) node = Outliner.selected[0];
    while (node && node !== 'root') {
      if (node instanceof Group && node.parent === 'root' && (MANNEQUIN_PREFIX.test(node.name) || (ENTITY_PREFIX.test(node.name) && node.pose_entity))) return node;
      node = node.parent;
    }
    return null;
  }

  // What's selected, for the menu: 'mannequin', 'entity' or ''.
  function selectionIs(kind) {
    try {
      const root = selectedPoseRoot();
      return !!root && (ENTITY_PREFIX.test(root.name) ? 'entity' : 'mannequin') === kind;
    } catch (e) {
      return false;
    }
  }

  // Rebuilds the eq_ preview cubes inside the mannequin's bone groups.
  let equipmentBuild = Promise.resolve();
  function refreshEquipmentPreview(mannequin) {
    equipmentBuild = equipmentBuild.then(() => buildEquipmentPreview(mannequin)).catch((e) => console.warn('[Pose Studio] equipment preview', e));
    return equipmentBuild;
  }

  async function buildEquipmentPreview(mannequin) {
    ensureRig(mannequin);
    ownerVariables(mannequin); // a cloak turned by hand keeps its angle through the rebuild
    const old = [];
    const oldGroups = [];
    mannequin.forEachChild((c) => {
      if (c instanceof Cube && /^eq_/.test(c.name)) old.push(c);
      else if (c instanceof Group && /^eq_/.test(c.name) && !(c.parent instanceof Group && /^eq_/.test(c.parent.name))) oldGroups.push(c);
    });
    const equipment = mannequin.pose_equipment || {};
    const content = Object.values(equipment).some(Boolean) ? await previewContent() : null;
    Undo.initEdit({ outliner: true, elements: old, textures: [] });
    for (const cube of old) cube.remove();
    for (const group of oldGroups) group.remove(false);
    const [rx, ry, rz] = mannequin.origin;
    const shift = (v) => [v[0] + rx, v[1] + ry, v[2] + rz];
    const cubes = [];
    const textures = [];

    for (const piece of ARMOR_PIECES) {
      const itemId = equipment[piece.slot];
      if (!itemId || !content) continue;
      if (await addAttachablePreview(mannequin, content, itemId, piece.slot, shift, cubes, textures)) continue;
      const material = ARMOR_MATERIALS.find((m) => armorItem(m, piece) === itemId);
      if (!material) continue;
      const geometry = resolveGeometry(content.geometries, `geometry.humanoid.armor.${piece.piece}`);
      const layer = material.item === 'turtle' ? 1 : piece.layer;
      const texture = await previewTexture(content, `eq_armor_${material.texture}_${layer}`, `textures/models/armor/${material.texture}_${layer}`, geometry ? geometry.texture_width : 64, geometry ? geometry.texture_height : 32, material.tint);
      if (!geometry) continue;
      if (texture && !textures.includes(texture)) textures.push(texture);
      const model = bedrockToBlockbench({ bones: geometry.bones.filter((b) => !b.neverRender), texture_width: geometry.texture_width, texture_height: geometry.texture_height });
      for (const bone of model.bones) {
        const group = boneGroupOf(mannequin, bone.name);
        if (!group) continue;
        for (const c of bone.cubes) {
          const cube = new Cube({
            name: `eq_${piece.piece}`,
            from: shift(c.from),
            to: shift(c.to),
            origin: shift(c.origin),
            rotation: c.rotation.slice(),
            inflate: c.inflate,
            mirror_uv: c.mirror_uv,
            box_uv: true,
            uv_offset: c.uv_offset.slice(),
            autouv: 0,
          })
            .addTo(group)
            .init();
          if (texture) cube.applyTexture(texture, true);
          cubes.push(cube);
        }
      }
    }

    // Held items: a flat card of the item icon in each hand, handle at the hand, pointing forward.
    for (const [slot, side] of [['mainhand', 'rightArm'], ['offhand', 'leftArm']]) {
      const id = shortItem(equipment[slot]);
      if (!id || !content) continue;
      if (await addWeaponPreview(mannequin, content, equipment[slot], side, cubes, textures)) continue;
      const hand = handPoint(mannequin, side);
      if (!hand) continue;
      const group = hand.group;
      const [hx, hy, hz] = hand.at;
      const known = HAND_ITEMS.find((i) => i.id === id);
      const texture = await previewTexture(content, `eq_item_${id}`, known ? known.texture : `textures/items/${id}`, 16, 16);
      if (texture && !textures.includes(texture)) textures.push(texture);
      const cube = new Cube({
        name: `eq_${slot}`,
        from: [hx - 0.5, hy - 5, hz - 16],
        to: [hx + 0.5, hy + 11, hz],
        origin: [hx, hy - 3, hz - 2],
        rotation: [-45, 0, 0],
        box_uv: false,
        autouv: 0,
      })
        .addTo(group)
        .init();
      for (const key of Object.keys(cube.faces)) {
        cube.faces[key].texture = null;
        cube.faces[key].uv = [0, 0, 0, 0];
      }
      for (const [key, uv] of [['east', [0, 0, 16, 16]], ['west', [16, 0, 0, 16]]]) {
        cube.faces[key].texture = texture ? texture.uuid : false;
        cube.faces[key].uv = uv;
      }
      cubes.push(cube);
    }
    Undo.finishEdit('Mannequin equipment', { outliner: true, elements: cubes, textures });
    Canvas.updateAll();
  }

  function setEquipment(mannequin, slot, item) {
    mannequin.pose_equipment = Object.assign({}, mannequin.pose_equipment, { [slot]: item || '' });
    lastSent.delete(mannequinId(mannequin.name));
    return refreshEquipmentPreview(mannequin);
  }

  // Pose Studio ▸ Skin & Equipment… (a mannequin is selected) or Equipment… (an entity copy):
  // one window with a Skin tab (mannequins only) and an Equipment tab.
  async function openOutfit(tab = 'skin') {
    const target = selectedPoseRoot();
    if (!target) {
      Blockbench.showQuickMessage('Select a player (Player_) or entity (ent_) first', 2000);
      return;
    }
    const isEntity = ENTITY_PREFIX.test(target.name);
    let slots = [];
    let content;
    try {
      if (!isEntity) {
        // without the skin library the Equipment tab still works
        slots = await readLibrary().catch((e) => {
          Blockbench.showQuickMessage(`Skin library unavailable: ${(e && e.message) || e}`, 4000);
          return [];
        });
      }
      if (!contentCache) Blockbench.showQuickMessage("Reading the world's packs for armour and items (only the first time)…", 4000);
      content = await previewContent();
    } catch (e) {
      showError('Pose Studio: skin & equipment', e);
      return;
    }
    const skin = isEntity ? null : skinParts(target, slots);
    const equipment = equipmentParts(target, content);
    const parts = skin ? [skin, equipment] : [equipment];
    new Dialog({
      id: 'pose_studio_outfit',
      title: isEntity ? `Equipment: ${target.name}` : `Skin & Equipment: ${target.name}`,
      width: 780,
      buttons: isEntity ? ['Done'] : ['Reload Minecraft Packs', 'Done'],
      cancelIndex: isEntity ? 0 : 1,
      component: {
        data: () => Object.assign({ tab: isEntity ? 'equipment' : tab, hasSkin: !isEntity }, ...parts.map((p) => p.data())),
        computed: Object.assign({}, ...parts.map((p) => p.computed || {})),
        methods: Object.assign({}, ...parts.map((p) => p.methods || {})),
        template: `
          <div>
            <div v-if="hasSkin" style="display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid var(--color-border);">
              <button v-for="t in [['skin', 'Skin'], ['equipment', 'Equipment']]" :key="t[0]" @click="tab = t[0]"
                      :style="{ borderRadius: '4px 4px 0 0', background: tab === t[0] ? 'var(--color-selected)' : '', fontWeight: tab === t[0] ? 'bold' : '' }">{{ t[1] }}</button>
            </div>
            <div v-if="hasSkin" v-show="tab === 'skin'">${skin ? skin.template : ''}</div>
            <div v-show="tab === 'equipment'">${equipment.template}</div>
          </div>`,
      },
      onButton(index) {
        if (!isEntity && index === 0) reloadMinecraftPacks();
      },
    }).show();
  }

  // Equipment contents for the Skin & Equipment window.
  function equipmentParts(mannequin, content) {
    const isEntity = ENTITY_PREFIX.test(mannequin.name);
    const canHold = !isEntity || !!boneGroupOf(mannequin, 'rightItem') || !!boneGroupOf(mannequin, 'leftItem');
    const canWear = !isEntity || ['head', 'body', 'rightArm', 'rightLeg'].every((b) => boneGroupOf(mannequin, b));
    const icon = (path) => {
      const found = findTexture(content, path);
      try {
        return found ? textureDataUrl(found.file.read(), found.ext) : '';
      } catch (e) {
        return '';
      }
    };
    const items = HAND_ITEMS.map((i) => Object.assign({ icon: icon(i.texture) }, i));
    const eq = mannequin.pose_equipment || {};
    const custom = customArmour(content);
    const armorSets = custom.sets.map((s) => {
      const shown = s.pieces.chest || s.pieces.head || Object.values(s.pieces)[0];
      return { key: s.key, name: s.name, source: s.source, icon: shown.iconPath ? icon(shown.iconPath) : '', pieces: ARMOR_SLOT_ORDER.map((slot) => s.pieces[slot] && s.pieces[slot].id).filter(Boolean), slots: Object.assign({}, ...Object.entries(s.pieces).map(([slot, piece]) => ({ [slot]: piece.id }))) };
    });
    const armorValue = (piece) => eq[piece.slot] || '';
    const packItems = customHandItems(content).map((i) => ({ id: i.id, name: i.name, icon: i.iconPath ? icon(i.iconPath) : '' }));
    const weaponNow = () => {
      const w = isEntity ? null : heldWeapon(content, mannequin);
      return w && w.hold.length ? w.name : '';
    };
    const holdNow = () => !!(mannequin.pose_animation && (mannequin.pose_animation.layers || []).some((l) => l.hold));
    return {
        data: () => ({
          pieces: ARMOR_PIECES.map((p) => ({
            slot: p.slot,
            label: p.label,
            value: armorValue(p),
            options: ARMOR_MATERIALS.filter((m) => !m.only || m.only === p.slot).map((m) => ({ id: armorItem(m, p), name: m.name })),
            custom: custom.pieces.filter((c) => c.slot === p.slot).map((c) => ({ id: c.id, name: c.name })),
            other: armorValue(p) && !ARMOR_MATERIALS.some((m) => armorItem(m, p) === armorValue(p)) && !custom.pieces.some((c) => c.id === armorValue(p)) ? armorValue(p) : '',
          })),
          armorSets,
          items,
          hand: 'mainhand',
          mainhand: eq.mainhand || '',
          offhand: eq.offhand || '',
          custom: '',
          canHold,
          canWear,
          packItems,
          weaponName: weaponNow(),
          holdOn: holdNow(),
        }),
        methods: {
          setArmor(p) {
            setEquipment(mannequin, p.slot, p.value || '');
          },
          // a whole set at once (one preview rebuild)
          wearSet(set) {
            const on = this.setWorn(set);
            const next = Object.assign({}, mannequin.pose_equipment);
            for (const p of this.pieces) {
              if (!set.slots[p.slot]) continue;
              p.value = on ? '' : set.slots[p.slot];
              next[p.slot] = p.value;
            }
            mannequin.pose_equipment = next;
            lastSent.delete(mannequinId(mannequin.name));
            refreshEquipmentPreview(mannequin);
          },
          setWorn(set) {
            return this.pieces.every((p) => !set.slots[p.slot] || p.value === set.slots[p.slot]);
          },
          pick(id) {
            const value = !id ? '' : id.includes(':') ? id : `minecraft:${id}`;
            this.give(value);
          },
          setCustom() {
            const id = this.custom.trim();
            if (!id) return;
            this.give(id.includes(':') ? id : `minecraft:${id}`);
          },
          // a weapon brings its holding pose (and changing weapons swaps it)
          give(value) {
            const hand = this.hand;
            this[hand] = value;
            const done = setEquipment(mannequin, hand, value);
            if (hand !== 'mainhand' || isEntity) return;
            Promise.resolve(done)
              .then(() => setHoldingPose(mannequin, true))
              .catch((e) => console.warn('[Pose Studio] holding pose', e))
              .then(() => {
                this.weaponName = weaponNow();
                this.holdOn = holdNow();
              });
          },
          toggleHold(on) {
            setHoldingPose(mannequin, on)
              .catch((e) => console.warn('[Pose Studio] holding pose', e))
              .then(() => {
                this.holdOn = holdNow();
              });
          },
          picked(id) {
            const now = this.hand === 'mainhand' ? this.mainhand : this.offhand;
            return id.includes(':') ? now === id : shortItem(now) === id;
          },
          label(id) {
            const known = this.items.find((i) => i.id === shortItem(id)) || this.packItems.find((i) => i.id === id);
            return id ? (known ? known.name : id) : 'nothing';
          },
        },
        template: `
          <div class="pose_studio_equipment">
            <p v-if="!canHold || !canWear" style="margin: 0 0 10px; color: var(--color-warning, #e8a33d);">
              This model {{ !canHold && !canWear ? "has no hand bones or humanoid body bones, so Minecraft probably won't show items or armour on it" : !canHold ? "has no hand bones (rightItem / leftItem), so Minecraft probably won't show held items" : "doesn't have humanoid body bones, so armour probably won't fit" }}.
            </p>
            <h3 style="margin: 0 0 6px;">Armour</h3>
            <div v-if="armorSets.length" style="margin-bottom: 10px;">
              <div style="opacity: 0.8; margin-bottom: 4px;">Armour sets from your packs (click to put on or take off the whole set):</div>
              <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 6px; max-height: 170px; overflow-y: auto;">
                <div v-for="s in armorSets" :key="s.key" @click="wearSet(s)" :title="s.name + ' (' + s.source + '): ' + s.pieces.join(', ')"
                     :style="{ border: '1px solid var(--color-border)', borderRadius: '4px', padding: '4px', cursor: 'pointer', textAlign: 'center',
                               background: setWorn(s) ? 'var(--color-selected)' : '' }">
                  <img v-if="s.icon" :src="s.icon" style="width: 32px; height: 32px; image-rendering: pixelated;">
                  <div style="font-size: 0.8em; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ s.name }}</div>
                </div>
              </div>
            </div>
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px;">
              <label v-for="p in pieces" :key="p.slot" style="display: flex; flex-direction: column; gap: 4px; min-width: 0;">
                <span>{{ p.label }}</span>
                <select v-model="p.value" @change="setArmor(p)" style="max-width: 100%;">
                  <option value="">None</option>
                  <option v-for="m in p.options" :value="m.id">{{ m.name }}</option>
                  <optgroup v-if="p.custom.length" label="From your packs">
                    <option v-for="m in p.custom" :value="m.id">{{ m.name }}</option>
                  </optgroup>
                  <option v-if="p.other" :value="p.other">{{ p.other }}</option>
                </select>
              </label>
            </div>
            <h3 style="margin: 0 0 6px;">Hands</h3>
            <div style="display: flex; gap: 16px; margin-bottom: 8px; flex-wrap: wrap;">
              <label><input type="radio" value="mainhand" v-model="hand"> Main hand: <b>{{ label(mainhand) }}</b></label>
              <label><input type="radio" value="offhand" v-model="hand"> Off hand: <b>{{ label(offhand) }}</b></label>
              <a href="#" @click.prevent="pick('')">Empty this hand</a>
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(44px, 1fr)); gap: 4px; max-height: 240px; overflow-y: auto; margin-bottom: 8px;">
              <div v-for="i in items" :key="i.id" @click="pick(i.id)" :title="i.name"
                   :style="{ border: '1px solid var(--color-border)', borderRadius: '4px', padding: '4px', cursor: 'pointer', textAlign: 'center',
                             background: picked(i.id) ? 'var(--color-selected)' : '' }">
                <img v-if="i.icon" :src="i.icon" style="width: 32px; height: 32px; image-rendering: pixelated;">
                <div v-else style="height: 32px; font-size: 0.7em; overflow: hidden;">{{ i.name }}</div>
              </div>
            </div>
            <div v-if="packItems.length" style="margin-bottom: 8px;">
              <div style="opacity: 0.8; margin-bottom: 4px;">3D items from your packs:</div>
              <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(44px, 1fr)); gap: 4px; max-height: 150px; overflow-y: auto;">
                <div v-for="i in packItems" :key="i.id" @click="pick(i.id)" :title="i.name + ' (' + i.id + ')'"
                     :style="{ border: '1px solid var(--color-border)', borderRadius: '4px', padding: '4px', cursor: 'pointer', textAlign: 'center',
                               background: picked(i.id) ? 'var(--color-selected)' : '' }">
                  <img v-if="i.icon" :src="i.icon" style="width: 32px; height: 32px; image-rendering: pixelated;">
                  <div v-else style="height: 32px; font-size: 0.7em; overflow: hidden;">{{ i.name }}</div>
                </div>
              </div>
            </div>
            <label v-if="weaponName" style="display: flex; gap: 6px; align-items: center; margin-bottom: 8px;"
                   title="The pose the weapon puts the player in. It's a layer in Animation… too, where its attacks and other animations are listed first.">
              <input type="checkbox" :checked="holdOn" @change="toggleHold($event.target.checked)"> Holding pose for {{ weaponName }}
            </label>
            <div style="display: flex; gap: 6px; align-items: center;">
              <span>Any item id:</span>
              <input type="text" v-model="custom" placeholder="e.g. minecraft:torch or mypack:magic_staff" class="dark_bordered" style="flex: 1;" @keydown.enter="setCustom()">
              <button @click="setCustom()">Give</button>
            </div>
            <p style="opacity: 0.7; margin-top: 8px;">Minecraft shows the real items. The Blockbench preview shows armour and 3D items from your packs on the matching bones, and a flat icon for other held items.</p>
          </div>`,
    };
  }

  // ---- Plugin registration -------------------------------------------------------------------
  // Everything lives in one "Pose Studio" menu next to Tools; rarely used items sit under More.
  let actions = [];
  let menu = null;
  let linkToggle = null;
  let cameraToggle = null;
  let povToggle = null;
  let pluginSettings = [];
  let fovProperty = null;
  let skinProperties = [];
  let pickTimer = null;

  function onLinkToggle(on) {
    if (!on) return stopLink();
    if (!startLink()) setTimeout(() => linkToggle && linkToggle.set(false), 0);
  }

  // ---- Time of day and weather --------------------------------------------------------------------
  // While Blockbench is connected, the day/night and weather cycles are frozen (the previous
  // gamerules come back on disconnect), so a shot looks the same every time. Each location keeps
  // its own time and weather (Project.pose_env) and puts them back when it opens. Set them with the
  // slider and buttons in the camera view, or Camera ▸ Time & Weather….
  const WEATHERS = [
    { id: 'clear', icon: 'wb_sunny', title: 'Clear' },
    { id: 'rain', icon: 'water_drop', title: 'Rain' },
    { id: 'thunder', icon: 'thunderstorm', title: 'Thunder' },
  ];
  let envProperty = null;
  let frozenRules = null; // the gamerules as they were before we froze them
  let freezeEnabled = true;
  let pendingTime = null;
  let timeTimer = null;
  let povTime = null; // { box, input, label, buttons }
  const envListeners = new Set();

  // Minecraft time (0 = 6:00 in the morning, 24000 ticks a day) as a clock time.
  function clockTime(ticks) {
    const hours = ((Number(ticks) || 0) / 1000 + 6) % 24;
    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  const firstNumber = (body) => {
    const m = String((body && body.statusMessage) || '').match(/-?\d+/);
    return m ? Number(m[0]) : null;
  };

  async function readGamerule(name) {
    const body = await link.command(`gamerule ${name}`).catch(() => null);
    const m = String((body && body.statusMessage) || '').match(/\b(true|false)\b/i);
    return m ? m[1].toLowerCase() === 'true' : null;
  }

  // On connect: freeze the day/night and weather cycles (remembering how they were).
  async function freezeWorldClock() {
    if (!freezeEnabled || !link.connected) return;
    if (!frozenRules) {
      frozenRules = { dodaylightcycle: await readGamerule('dodaylightcycle'), doweathercycle: await readGamerule('doweathercycle') };
    }
    await link.command('gamerule dodaylightcycle false').catch(logFailure);
    await link.command('gamerule doweathercycle false').catch(logFailure);
  }

  // On disconnect (or when the setting is turned off): the cycles run again if they did before.
  async function unfreezeWorldClock() {
    if (!frozenRules || !link.connected) {
      frozenRules = null;
      return;
    }
    for (const [rule, value] of Object.entries(frozenRules)) {
      if (value === true) await link.command(`gamerule ${rule} true`).catch(logFailure); // only what we know was on
    }
    frozenRules = null;
  }

  async function readEnvironment() {
    if (!link.connected) return null;
    const time = firstNumber(await link.command('time query daytime').catch(() => null));
    const body = await link.command('weather query').catch(() => null);
    const w = String((body && body.statusMessage) || '').toLowerCase();
    const weather = /thunder/.test(w) ? 'thunder' : /rain/.test(w) ? 'rain' : /clear/.test(w) ? 'clear' : null;
    return { time: time === null ? null : ((time % 24000) + 24000) % 24000, weather };
  }

  function projectEnv() {
    return (typeof Project !== 'undefined' && Project && Project.pose_env) || null;
  }
  function setProjectEnv(change) {
    if (typeof Project === 'undefined' || !Project) return;
    Project.pose_env = Object.assign({}, Project.pose_env || {}, change);
    if (Project.saved !== undefined) Project.saved = false;
    for (const fn of envListeners) fn(Project.pose_env);
  }

  // Sends the time (throttled while a slider is dragged).
  function setTimeOfDay(ticks) {
    const t = Math.round(((Number(ticks) % 24000) + 24000) % 24000);
    setProjectEnv({ time: t });
    pendingTime = t;
    if (timeTimer) return;
    const flush = () => {
      timeTimer = null;
      if (pendingTime === null || !link.connected) return;
      send(`time set ${pendingTime}`);
      pendingTime = null;
      timeTimer = setTimeout(() => {
        timeTimer = null;
        if (pendingTime !== null) flush();
      }, 120);
    };
    flush();
  }

  function setWeather(weather) {
    if (!WEATHERS.some((w) => w.id === weather)) return;
    setProjectEnv({ weather });
    if (link.connected) send(`weather ${weather}`);
  }

  // Puts the open location's time and weather into the world.
  function applySceneEnvironment() {
    const env = projectEnv();
    if (!env || !link.connected) return;
    if (Number.isFinite(env.time)) send(`time set ${env.time}`);
    if (env.weather) send(`weather ${env.weather}`);
    for (const fn of envListeners) fn(env);
  }

  // Remembers the world's current time and weather in the open scene (on Save Location).
  async function captureSceneEnvironment() {
    const env = await readEnvironment().catch(() => null);
    if (!env || typeof Project === 'undefined' || !Project) return;
    const keep = {};
    if (env.time !== null) keep.time = env.time;
    if (env.weather) keep.weather = env.weather;
    Project.pose_env = Object.assign({}, Project.pose_env || {}, keep);
  }

  // Time slider and weather buttons, bottom right of the camera view.
  function createPovTimeBox(node) {
    const box = document.createElement('div');
    box.className = 'pose_studio_pov_time';
    Object.assign(box.style, {
      position: 'absolute', bottom: '8px', right: '8px', zIndex: 6, display: 'flex', alignItems: 'center', gap: '6px',
      padding: '3px 8px', borderRadius: '6px', background: 'rgba(0, 0, 0, 0.55)', color: '#fff', font: '600 12px sans-serif',
    });
    const icon = document.createElement('i');
    icon.className = 'material-icons';
    icon.textContent = 'schedule';
    icon.style.fontSize = '16px';
    const label = document.createElement('span');
    label.style.minWidth = '38px';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '23999';
    input.step = '50';
    input.title = 'Time of day in Minecraft';
    input.style.width = '140px';
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('input', () => {
      label.textContent = clockTime(input.value);
      setTimeOfDay(Number(input.value));
    });
    box.appendChild(icon);
    box.appendChild(label);
    box.appendChild(input);
    const buttons = {};
    for (const w of WEATHERS) {
      const b = document.createElement('div');
      b.title = w.title;
      Object.assign(b.style, { width: '22px', height: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px', cursor: 'pointer' });
      b.innerHTML = `<i class="material-icons" style="font-size: 16px; pointer-events: none;">${w.icon}</i>`;
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', () => setWeather(w.id));
      box.appendChild(b);
      buttons[w.id] = b;
    }
    node.appendChild(box);
    povTime = { box, input, label, buttons };
    envListeners.add(syncPovTimeBox);
    syncPovTimeBox(projectEnv());
    return box;
  }

  function syncPovTimeBox(env) {
    if (!povTime) return;
    env = env || projectEnv() || {};
    if (Number.isFinite(env.time) && String(povTime.input.value) !== String(env.time) && pendingTime === null) povTime.input.value = String(env.time);
    povTime.label.textContent = Number.isFinite(env.time) ? clockTime(env.time) : '--:--';
    for (const [id, b] of Object.entries(povTime.buttons)) b.style.background = env.weather === id ? 'rgba(255, 255, 255, 0.3)' : '';
  }

  function removePovTimeBox() {
    if (povTime) povTime.box.remove();
    envListeners.delete(syncPovTimeBox);
    povTime = null;
  }

  // Camera ▸ Time & Weather…
  async function timeWeatherDialog() {
    if (!requireConnection()) return;
    const now = (await readEnvironment().catch(() => null)) || {};
    const env = Object.assign({ time: 6000, weather: 'clear' }, now, projectEnv() || {});
    let vm = null;
    const listener = (e) => {
      if (vm && e) {
        if (Number.isFinite(e.time)) vm.time = e.time;
        if (e.weather) vm.weather = e.weather;
      }
    };
    envListeners.add(listener);
    new Dialog({
      id: 'pose_studio_time_weather',
      title: 'Time & Weather',
      width: 440,
      buttons: ['Done'],
      component: {
        data: () => ({ time: env.time, weather: env.weather, weathers: WEATHERS, presets: [['Sunrise', 23000], ['Morning', 1000], ['Noon', 6000], ['Sunset', 12000], ['Night', 18000]] }),
        mounted() {
          vm = this;
        },
        methods: {
          clock: clockTime,
          slide(v) {
            this.time = Number(v);
            setTimeOfDay(this.time);
          },
          pick(id) {
            this.weather = id;
            setWeather(id);
          },
        },
        template: `
          <div>
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
              <b style="min-width: 48px;">{{ clock(time) }}</b>
              <input type="range" min="0" max="23999" step="50" :value="time" @input="slide($event.target.value)" style="flex: 1;">
            </div>
            <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px;">
              <button v-for="p in presets" :key="p[0]" @click="slide(p[1])" style="min-width: 0; padding: 0 10px;">{{ p[0] }}</button>
            </div>
            <div style="display: flex; gap: 6px;">
              <button v-for="w in weathers" :key="w.id" @click="pick(w.id)"
                      :style="{ minWidth: 0, padding: '0 12px', display: 'flex', alignItems: 'center', gap: '4px', background: weather === w.id ? 'var(--color-selected)' : '' }">
                <i class="material-icons" style="font-size: 16px;">{{ w.icon }}</i>{{ w.title }}
              </button>
            </div>
            <p style="opacity: 0.65; margin-top: 10px;">The day/night and weather cycles are frozen while Blockbench is connected. Save Location keeps the time and weather with the location.</p>
          </div>`,
      },
      onButton() {
        envListeners.delete(listener);
      },
      onCancel() {
        envListeners.delete(listener);
      },
    }).show();
  }

  // ---- Locations: scenes linked to worlds ---------------------------------------------------------
  // A world can hold several set-ups ("locations"), each a scene file of its own with its own
  // imported terrain, entities, cameras and anchor (where in the world it sits). The scene
  // remembers its world and location (Project.pose_world); the world keeps the list of its
  // locations (a dynamic property the behavior pack keeps). In-game ids of a location's
  // mannequins and entities carry the location, so every location stays set up in the world.
  // When Minecraft connects, Pose Studio offers the location you're standing nearest.
  let connectedWorld = null; // { id, name, anchor, player, locations } of the world Minecraft has open
  let worldProperty = null;

  const hexToText = (hex) => decodeURIComponent(String(hex).replace(/[^0-9a-f]/gi, '').replace(/../g, (h) => String.fromCharCode(parseInt(h, 16))));
  // paths are kept with forward slashes in the world (plain in commands) and compared loosely
  const forwardSlashes = (p) => String(p || '').replace(/\\/g, '/');
  const samePath = (a, b) => !!a && !!b && forwardSlashes(a).toLowerCase() === forwardSlashes(b).toLowerCase();
  const windowsPath = (p) => String(p || '').replace(/\//g, '\\');
  const newLocationId = () => Math.random().toString(36).slice(2, 6);

  // The world Minecraft has open: its id, anchor, where the player stands and its locations.
  async function readWorldScene() {
    const items = await runGameQuery('pose:scene', {}, 'Checking the world');
    const idItem = items.find((i) => i.startsWith('W|'));
    if (!idItem) return null;
    const hex = items
      .filter((i) => i.startsWith('S|'))
      .map((i) => i.split('|'))
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map((p) => p[2])
      .join('');
    let scene = {};
    try {
      scene = hex ? JSON.parse(hexToText(hex)) : {};
    } catch (e) {
      scene = {};
    }
    // a link saved by an older behavior pack: one scene
    if (!Array.isArray(scene.locations)) scene = { world: scene.name || '', locations: scene.path ? [{ loc: 'main', name: 'Main', path: scene.path }] : [] };
    const point = (prefix) => {
      const item = items.find((i) => i.startsWith(prefix));
      const parts = item ? item.split('|') : null;
      return parts ? { x: Number(parts[1]), y: Number(parts[2]), z: Number(parts[3]), dim: parts[4] || '' } : null;
    };
    const locations = scene.locations.map((l) => Object.assign({}, l, { path: resolveScenePath(windowsPath(l.path)) }));
    const version = items.find((i) => i.startsWith('V|'));
    return { id: idItem.slice(2), name: scene.world || '', anchor: point('A|'), player: point('P|'), locations, removed: scene.removed || [], protocol: version ? Number(version.slice(2)) : 0 };
  }

  const EXPECTED_PACK_PROTOCOL = 11; // the behavior pack this plugin expects (main.js PACK_PROTOCOL)
  let warnedOldPack = false;

  // Scene files in the scenes folders that belong to a world (their pose_world says so), as
  // locations. They're found even if the world's own list was never written (or was written on
  // someone else's PC). Each file is only read again when it changes.
  const sceneLinks = new Map(); // path -> { mtime, link }
  function sceneFilesForWorld(worldId) {
    const found = [];
    for (const { path, fs: sfs } of sceneFileList()) {
      let link = null;
      try {
        const mtime = sfs.statSync(path).mtimeMs;
        const known = sceneLinks.get(path);
        if (known && known.mtime === mtime) link = known.link;
        else {
          link = extractJsonValue(String(sfs.readFileSync(path, 'utf8')), '"pose_world"');
          sceneLinks.set(path, { mtime, link });
        }
      } catch (e) {
        continue;
      }
      if (!link || link.id !== worldId) continue;
      found.push({ loc: link.loc || 'main', name: link.locName || 'Main', path, anchor: link.anchor || null, worldName: link.name || '' });
    }
    return found;
  }

  // The JSON value after "key": in a big JSON text, without parsing the whole file.
  function extractJsonValue(text, key) {
    const at = text.indexOf(key + ':');
    if (at < 0) return null;
    let i = at + key.length + 1;
    while (/\s/.test(text[i] || '')) i++;
    if (text[i] !== '{') return null;
    let depth = 0;
    let inString = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (ch === '\\') j++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          return JSON.parse(text.slice(i, j + 1));
        } catch (e) {
          return null;
        }
      }
    }
    return null;
  }

  // The world's name, from the most recently played world folder (the one that's open).
  function currentWorldName() {
    try {
      const picked = pickedWorldInfo();
      if (picked) return picked.name;
      const worlds = listWorlds(bedrockFs(), bedrockRoot());
      return (worlds[0] && worlds[0].name) || 'Minecraft world';
    } catch (e) {
      return 'Minecraft world';
    }
  }

  const projectPath = () => (typeof Project !== 'undefined' && Project && (Project.save_path || '')) || '';
  const fileName = (path) => String(path).split(/[\\/]/).pop();
  const dirName = (path) => String(path).replace(/[\\/][^\\/]*$/, '');
  const projectLink = () => (typeof Project !== 'undefined' && Project && Project.pose_world) || null;
  // the location of the open scene ("main" for scenes linked before locations existed)
  const projectLocation = () => {
    const l = projectLink();
    return l ? l.loc || 'main' : '';
  };

  // Tells the world about the open scene's location (path, name, anchor).
  function tellWorldLocation() {
    const l = projectLink();
    if (!link.connected || !l || !connectedWorld || l.id !== connectedWorld.id) return;
    const msg = { loc: l.loc || 'main', p: forwardSlashes(projectPath()), n: l.locName || 'Main', w: l.name || connectedWorld.name || '' };
    if (l.anchor) {
      msg.a = [l.anchor.x, l.anchor.y, l.anchor.z];
      msg.d = l.anchor.dim || undefined;
    }
    send(`scriptevent pose:setloc ${JSON.stringify(msg)}`);
    const list = connectedWorld.locations || (connectedWorld.locations = []);
    const entry = { loc: msg.loc, name: msg.n, path: projectPath(), anchor: l.anchor || null };
    const i = list.findIndex((x) => x.loc === msg.loc);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
  }

  function fileExists(path) {
    try {
      const fs = requireNativeModule('fs', { scope: dirName(path), message: 'Pose Studio checks for the scene files linked to this world.' });
      return !!fs && fs.existsSync(path);
    } catch (e) {
      return false;
    }
  }

  function openSceneFile(path) {
    const open = typeof ModelProject !== 'undefined' && ModelProject.all.find((p) => samePath(p.save_path, path));
    if (open) {
      open.select();
      return;
    }
    Blockbench.read([path], { readtype: 'text', errorbox: true }, (files) => {
      if (files && files[0]) loadModelFile(files[0]);
    });
  }

  const sameAnchor = (a, b) => !!a && !!b && ['x', 'y', 'z'].every((k) => Math.abs(Number(a[k]) - Number(b[k])) < 0.01);
  const distanceTo = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity);

  // Puts the world's anchor where the open location sits, if it belongs to this world.
  async function restoreSceneAnchor() {
    const linked = projectLink();
    if (!link.connected || !connectedWorld || !linked || linked.id !== connectedWorld.id || !linked.anchor) return false;
    if (sameAnchor(linked.anchor, connectedWorld.anchor)) return false;
    const a = linked.anchor;
    await link.command(`scriptevent pose:anchor ${JSON.stringify({ at: [a.x, a.y, a.z], dim: a.dim || undefined, quiet: true })}`).catch(logFailure);
    connectedWorld.anchor = Object.assign({}, a);
    resync();
    return true;
  }

  // Minecraft only lets scripts place entities in chunks that are loaded and ticking, which is just
  // the area around the player (the simulation distance). A ticking area keeps each location's
  // chunks ticking wherever the player is (Minecraft allows 10 per world).
  const tickingAreas = new Map(); // location id -> "x y z" the area was made for (this session)

  // Commands name dimensions without the "minecraft:" (`execute in overworld`); scripts use the full id.
  function commandDimension(dim) {
    const d = String(dim || '').replace(/^minecraft:/, '');
    return { the_nether: 'nether' }[d] || d;
  }
  // Runs a command in a dimension; resolves to the reply, or null when Minecraft refused it.
  async function commandIn(dim, cmd) {
    const d = commandDimension(dim);
    const body = await link.command(d ? `execute in ${d} run ${cmd}` : cmd).catch(() => null);
    return body && (body.statusCode === undefined || body.statusCode >= 0) ? body : null;
  }
  let warnedTickingArea = false;
  async function ensureTickingArea() {
    const l = projectLink();
    if (!link.connected || !l || !l.anchor || !connectedWorld || l.id !== connectedWorld.id) return;
    const a = l.anchor;
    const at = `${Math.floor(a.x)} ${Math.floor(a.y)} ${Math.floor(a.z)}`;
    const name = `pose_${String(l.loc || 'main').replace(/[^a-z0-9_]/gi, '_')}`;
    if (tickingAreas.get(name) === at) return;
    await commandIn(a.dim, `tickingarea remove ${name}`); // it may be from an older position
    const body = await commandIn(a.dim, `tickingarea add circle ${at} 4 ${name} true`);
    tickingAreas.set(name, at);
    if (!body && !warnedTickingArea) {
      warnedTickingArea = true;
      Blockbench.showQuickMessage("Pose Studio: Minecraft wouldn't add a ticking area for this location (a world allows 10). Its players appear once you're there.", 6000);
    }
    // the chunks load over the next ticks; send everything again then
    setTimeout(resync, 1500);
    return body;
  }
  async function removeTickingArea(loc) {
    const name = `pose_${String(loc || 'main').replace(/[^a-z0-9_]/gi, '_')}`;
    tickingAreas.delete(name);
    if (link.connected) await link.command(`tickingarea remove ${name}`).catch(() => null);
  }

  // Beyond this, a location is probably not loaded around the player (Minecraft only lets scripts
  // place entities in loaded chunks), so Pose Studio offers to go there.
  const FAR_AWAY = 96;
  let followLocations = true; // setting: go to a location when switching to it

  // Teleports the player to a location (a little above its centre, in its dimension).
  async function goToLocation(anchor) {
    if (!link.connected || !anchor) return false;
    const at = [Number(anchor.x), Number(anchor.y) + 1, Number(anchor.z)];
    await link.command(`scriptevent pose:goto ${JSON.stringify({ at, dim: anchor.dim || undefined })}`).catch(logFailure);
    await sleep(400);
    let after = await readWorldScene().catch(() => null);
    const arrived = (w) => w && w.player && distanceTo(w.player, { x: at[0], y: at[1], z: at[2] }) < 4;
    if (!arrived(after)) {
      // an older behavior pack: the command (dimension named the command way)
      const body = await commandIn(anchor.dim, `tp @s ${at.join(' ')}`);
      await sleep(400);
      after = await readWorldScene().catch(() => null);
      if (!arrived(after)) {
        Blockbench.showMessageBox({
          title: 'Pose Studio',
          message: `Minecraft didn't take you to this location (${at.map((v) => Math.round(v)).join(' ')}${anchor.dim ? ', ' + commandDimension(anchor.dim) : ''}).${body ? '' : ' The teleport command was refused.'}\n\nUpdate the Minecraft packs (Check for Updates, then reload the world), or go there yourself; the location appears when you arrive.`,
        });
        return false;
      }
    }
    // Once the area has loaded around you, the location's entities are made again: ones created
    // while you were away (kept by the ticking area) aren't always sent to your screen.
    setTimeout(refreshLocationEntities, 2000);
    setTimeout(resync, 5000);
    return true;
  }

  // Locations ▸ Refresh in Minecraft: removes the open location's players and entities in the
  // world and places them again (fixes ones Minecraft has but isn't drawing).
  function refreshLocationEntities() {
    if (!link.connected || typeof Project === 'undefined' || !Project) return;
    for (const root of mannequinRoots().concat(entityRoots())) send(`scriptevent pose:remove ${JSON.stringify({ id: mannequinId(root.name) })}`);
    // the next updates place them all again
    setTimeout(resync, 300);
  }

  // After switching to a location: offer to go there when the player is far from it.
  async function offerToGoThere() {
    const linked = projectLink();
    if (!link.connected || !linked || !linked.anchor || !connectedWorld || linked.id !== connectedWorld.id) return;
    const fresh = await readWorldScene().catch(() => null);
    if (!fresh || !fresh.player) return;
    const sameDim = !linked.anchor.dim || !fresh.player.dim || linked.anchor.dim === fresh.player.dim;
    const away = distanceTo(linked.anchor, fresh.player);
    if (sameDim && away <= FAR_AWAY) return;
    const name = linked.locName || 'This location';
    // Minecraft only draws the world (terrain and entities) around the player, so the player goes
    // with you. You're hidden and the camera is Pose Studio's anyway.
    if (followLocations) {
      const went = await goToLocation(linked.anchor);
      if (!went) return false;
      Blockbench.showQuickMessage(`Pose Studio: took you to ${name} (${sameDim ? `${Math.round(away)} blocks` : 'another dimension'}) so Minecraft loads it`, 3500);
      await sleep(2000); // let the area load before anything reads it
      return true;
    }
    Blockbench.showMessageBox(
      {
        title: 'Pose Studio',
        message: sameDim
          ? `${name} is ${Math.round(away)} blocks away. Minecraft only shows the world around you.\n\nTeleport there to see it?`
          : `${name} is in another dimension.\n\nTeleport there?`,
        buttons: ['Teleport There', 'Stay Here'],
        confirm: 0,
        cancel: 1,
      },
      (button) => {
        if (button === 0) goToLocation(linked.anchor);
      }
    );
    return false;
  }

  // Switching to (or opening) a location of this world puts it in place.
  function onProjectSelected() {
    if (!link.connected || !connectedWorld) return;
    setTimeout(async () => {
      await restoreSceneAnchor().catch(() => {});
      const linked = projectLink();
      if (linked && linked.id === connectedWorld.id) {
        applySceneEnvironment();
        await ensureTickingArea().catch(() => {});
        await offerToGoThere().catch(() => {});
        releaseUpdates();
        await realignScene({ auto: true }).catch(() => false);
      }
      for (const fn of envListeners) fn(projectEnv());
    }, 300);
  }

  function safeFileName(text) {
    return String(text).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'Scene';
  }

  // Locations ▸ Save Location: saves the open location (to the scenes folder the first
  // time) and links it with the world Minecraft has open.
  async function saveScene() {
    if (typeof Project === 'undefined' || !Project) {
      Blockbench.showQuickMessage('Nothing to save yet', 2000);
      return;
    }
    if (link.connected) {
      const fresh = await readWorldScene().catch(() => null);
      if (fresh) connectedWorld = Object.assign(connectedWorld || {}, fresh, { name: fresh.name || (connectedWorld && connectedWorld.name) || currentWorldName() });
    }
    const world = connectedWorld;
    const old = projectLink();
    const worldName = (world && world.name) || (old && old.name) || currentWorldName();
    if (world && (!old || old.id === world.id)) {
      // the world's anchor now is where this location sits
      Project.pose_world = {
        id: world.id,
        name: worldName,
        loc: (old && old.loc) || 'main',
        locName: (old && old.locName) || 'Main',
        anchor: world.anchor || (old && old.anchor) || null,
      };
    }
    // the world's time and weather go with the location
    if (link.connected && world && (!old || old.id === world.id)) await captureSceneEnvironment();
    const l = projectLink();
    let path = projectPath();
    if (!path) {
      const dir = scenesFolder();
      const fs = sceneFs(dir);
      if (!fs) {
        Blockbench.showMessageBox({ title: 'Pose Studio', message: `Permission to save in ${dir} was denied. Use File > Save Project instead, or pick another scenes folder in Pose Studio ▸ More ▸ Folders….` });
        return;
      }
      sceneIndex = null;
      fs.mkdirSync(dir, { recursive: true });
      const base = safeFileName(l && l.loc && l.loc !== 'main' ? `${worldName} - ${l.locName}` : worldName);
      path = `${dir}\\${base}.bbmodel`;
      for (let n = 2; fs.existsSync(path); n++) path = `${dir}\\${base} ${n}.bbmodel`;
      Project.save_path = path;
      Project.name = fileName(path).replace(/\.bbmodel$/i, '');
      Codecs.project.write(Codecs.project.compile(), path);
    } else if (BarItems.save_project) {
      BarItems.save_project.trigger();
    } else {
      Codecs.project.write(Codecs.project.compile(), path);
    }
    if (world && l && l.id === world.id) tellWorldLocation();
    const where = l && l.locName && l.loc !== 'main' ? `${l.locName} in ${worldName}` : worldName;
    Blockbench.showQuickMessage(world ? `Saved ${fileName(path)}, linked to ${where}` : `Saved ${fileName(path)} (connect Minecraft to link it to a world)`, 3000);
  }

  // Locations ▸ New Location Here…: a new, empty scene tab for this world, anchored where you stand.
  async function newLocationHere() {
    if (!requireConnection()) return;
    const name = await new Promise((resolve) => {
      if (Blockbench.textPrompt) Blockbench.textPrompt('New location', '', (text) => resolve(text), 'Name this location, e.g. Birch forest');
      else resolve(window.prompt('Name this location', ''));
    });
    if (!name || !String(name).trim()) return;
    // keep the location you're leaving
    const leaving = projectLink();
    if (leaving && typeof Project !== 'undefined' && Project && (projectPath() || !Project.saved)) await saveScene();
    newProject(Formats.free);
    await link.command('scriptevent pose:anchor').catch(logFailure); // centred where you stand
    const world = await readWorldScene().catch(() => null);
    if (!world) {
      Blockbench.showMessageBox({ title: 'Pose Studio', message: "Couldn't read the world. Is the Pose Studio behavior pack up to date?" });
      return;
    }
    connectedWorld = Object.assign(connectedWorld || {}, world, { name: world.name || (connectedWorld && connectedWorld.name) || currentWorldName() });
    Project.pose_world = { id: world.id, name: connectedWorld.name, loc: newLocationId(), locName: String(name).trim(), anchor: world.anchor };
    resync();
    await saveScene();
    await ensureTickingArea().catch(() => {});
    Blockbench.showQuickMessage(`New location "${String(name).trim()}" set up where you stand. Use Import World… to bring in its terrain.`, 5000);
  }

  // Locations ▸ Locations…: this world's locations, nearest first.
  async function openLocations() {
    if (!requireConnection()) return;
    sceneIndex = null; // look at the scenes folder afresh
    const world = await readWorldScene().catch(() => null);
    if (!world) {
      Blockbench.showMessageBox({ title: 'Pose Studio', message: "Couldn't read the world. Is the Pose Studio behavior pack up to date?" });
      return;
    }
    connectedWorld = Object.assign(connectedWorld || {}, world, { name: world.name || (connectedWorld && connectedWorld.name) || currentWorldName() });
    const current = projectLink() && projectLink().id === world.id ? projectLocation() : '';
    const rows = () =>
      (connectedWorld.locations || [])
        .map((l) => ({ loc: l.loc, name: l.name, path: l.path, anchor: l.anchor, distance: Math.round(distanceTo(l.anchor, world.player)), current: l.loc === current }))
        .sort((a, b) => a.distance - b.distance);
    const dialog = new Dialog({
      id: 'pose_studio_locations',
      title: `Locations in ${connectedWorld.name}`,
      width: 560,
      buttons: ['New Location Here…', 'Close'],
      cancelIndex: 1,
      component: {
        data: () => ({ rows: rows() }),
        methods: {
          open(r) {
            if (!fileExists(r.path)) {
              Blockbench.showMessageBox({ title: 'Pose Studio', message: `The scene for ${r.name} wasn't found:\n${r.path}\n\nScenes are looked for in ${scenesFolder()} (set it in Pose Studio ▸ More ▸ Folders…).` });
              return;
            }
            dialog.hide();
            openSceneFile(r.path);
          },
          go(r) {
            if (!r.anchor) {
              Blockbench.showQuickMessage(`${r.name} has no saved position yet`, 2500);
              return;
            }
            goToLocation(r.anchor);
            Blockbench.showQuickMessage(`Teleported to ${r.name}`, 2000);
          },
          rename(r) {
            const apply = (text) => {
              if (!text || !String(text).trim()) return;
              send(`scriptevent pose:setloc ${JSON.stringify({ loc: r.loc, n: String(text).trim() })}`);
              const entry = (connectedWorld.locations || []).find((l) => l.loc === r.loc);
              if (entry) entry.name = String(text).trim();
              const open = typeof ModelProject !== 'undefined' && ModelProject.all.find((p) => p.pose_world && p.pose_world.id === world.id && (p.pose_world.loc || 'main') === r.loc);
              if (open) open.pose_world = Object.assign({}, open.pose_world, { locName: String(text).trim() });
              this.rows = rows();
            };
            if (Blockbench.textPrompt) Blockbench.textPrompt('Rename location', r.name, apply);
            else apply(window.prompt('Rename location', r.name));
          },
          remove(r) {
            Blockbench.showMessageBox(
              {
                title: 'Pose Studio',
                message: `Remove "${r.name}" from this world's locations?\n\nIts scene file stays where it is; you can link it again by opening it and using Save Location.`,
                buttons: ['Remove', 'Cancel'],
                confirm: 0,
                cancel: 1,
              },
              (button) => {
                if (button !== 0) return;
                send(`scriptevent pose:setloc ${JSON.stringify({ loc: r.loc, del: true })}`);
                removeTickingArea(r.loc).catch(() => {});
                connectedWorld.locations = (connectedWorld.locations || []).filter((l) => l.loc !== r.loc);
                this.rows = rows();
              }
            );
          },
        },
        template: `
          <div class="pose_studio_locations">
            <p v-if="!rows.length" style="opacity: 0.7;">No locations yet. Build a scene and use Save Location, or stand somewhere and use New Location Here….</p>
            <div v-for="r in rows" :key="r.loc" :style="{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '4px', marginBottom: '4px', border: '1px solid var(--color-border)', background: r.current ? 'var(--color-selected)' : '' }">
              <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ r.name }}{{ r.current ? '  (open)' : '' }}</div>
                <div style="opacity: 0.6; font-size: 0.85em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ isFinite(r.distance) ? r.distance + ' blocks away' : '' }}</div>
              </div>
              <button @click="open(r)" :disabled="r.current" style="min-width: 0; padding: 0 10px;">Open</button>
              <button @click="go(r)" :disabled="!r.anchor" style="min-width: 0; padding: 0 10px;" title="Teleport there in Minecraft">Go There</button>
              <button @click="rename(r)" style="min-width: 0; padding: 0 10px;">Rename</button>
              <button @click="remove(r)" style="min-width: 0; padding: 0 10px;">Remove</button>
            </div>
          </div>`,
      },
      onButton(index) {
        if (index === 0) setTimeout(() => newLocationHere(), 100);
      },
    });
    dialog.show();
  }

  // Locations ▸ Realign with World: finds where the scene was built by matching its imported
  // terrain (world_scan) against the terrain around the player now, then puts the anchor back there.
  // For scenes whose position was lost (saved before scenes remembered it).
  let realignDebug = null;
  const REALIGN_RADIUS = 24; // blocks of terrain read around the player
  const REALIGN_SEARCH = 128; // how far away (blocks) the scene may have been built

  // Highest block top per column of the scene's imported terrain: Map "x,z" -> top.
  function sceneHeights() {
    const mesh = (Outliner.elements || Project.elements || []).find((e) => e.name === WORLD_GROUP && e.vertices && e.faces);
    if (!mesh) return null;
    const o = mesh.origin || [0, 0, 0];
    const heights = new Map();
    for (const face of Object.values(mesh.faces)) {
      const v = (face.vertices || []).map((k) => mesh.vertices[k]).filter(Boolean);
      if (v.length < 3 || v.some((p) => Math.abs(p[1] - v[0][1]) > 1e-6)) continue; // horizontal faces only
      const xs = v.map((p) => 0.5 - (p[0] + o[0]) / 16);
      const zs = v.map((p) => 0.5 - (p[2] + o[2]) / 16);
      const top = Math.round((v[0][1] + o[1]) / 16);
      for (let x = Math.round(Math.min(...xs)); x < Math.round(Math.max(...xs)); x++) {
        for (let z = Math.round(Math.min(...zs)); z < Math.round(Math.max(...zs)); z++) {
          const key = x + ',' + z;
          if (!(heights.get(key) >= top)) heights.set(key, top);
        }
      }
    }
    return heights;
  }

  // The offset (scene = now + offset) that makes two height maps line up best, or null.
  function matchHeights(scene, now, range = REALIGN_SEARCH) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const key of scene.keys()) {
      const [x, z] = key.split(',').map(Number);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const w = maxX - minX + 1;
    const d = maxZ - minZ + 1;
    const grid = new Int32Array(w * d).fill(-100000);
    for (const [key, h] of scene) {
      const [x, z] = key.split(',').map(Number);
      grid[(x - minX) * d + (z - minZ)] = h;
    }
    const cells = [...now].map(([key, h]) => [...key.split(',').map(Number), h]);
    const counts = new Int32Array(4096);
    const touched = [];
    const candidates = [];
    for (let dx = -range; dx <= range; dx++) {
      for (let dz = -range; dz <= range; dz++) {
        let overlap = 0;
        let top = 0;
        let topDiff = 0;
        for (const [x, z, h] of cells) {
          const sx = x + dx - minX;
          const sz = z + dz - minZ;
          if (sx < 0 || sz < 0 || sx >= w || sz >= d) continue;
          const sh = grid[sx * d + sz];
          if (sh === -100000) continue;
          overlap++;
          const diff = sh - h;
          if (diff < -2048 || diff >= 2048) continue;
          const i = diff + 2048;
          if (!counts[i]) touched.push(i);
          if (++counts[i] > top) {
            top = counts[i];
            topDiff = diff;
          }
        }
        for (const i of touched) counts[i] = 0;
        touched.length = 0;
        if (overlap >= 40) candidates.push({ dx, dz, dy: topDiff, score: top, overlap, quality: top - 3 * (overlap - top) });
      }
    }
    // Flat ground matches almost anywhere, so what tells places apart is how few columns disagree:
    // matches count, mismatches count against (three times).
    let best = null;
    for (const c of candidates) if (!best || c.quality > best.quality) best = c;
    if (!best) return null;
    let second = null;
    for (const c of candidates) {
      if (Math.abs(c.dx - best.dx) <= 2 && Math.abs(c.dz - best.dz) <= 2) continue;
      if (!second || c.quality > second.quality) second = c;
    }
    const rate = (c) => (c ? (c.overlap - c.score) / c.overlap : 1);
    const here = candidates.find((c) => c.dx === 0 && c.dz === 0);
    return Object.assign(best, { errorRate: rate(best), secondErrorRate: rate(second), hereErrorRate: rate(here), hereOverlap: here ? here.overlap : 0, cells: cells.length });
  }

  // auto: run quietly when a scene opens. It only moves the scene when it clearly doesn't line up
  // where it is and the match elsewhere is unmistakable; otherwise it leaves everything alone.
  async function realignScene({ auto = false } = {}) {
    if (auto ? !link.connected : !requireConnection()) return false;
    const scene = sceneHeights();
    if (!scene || scene.size < 30) {
      if (!auto) Blockbench.showMessageBox({ title: 'Pose Studio', message: 'Realigning needs imported terrain in the scene (Import World…) to compare with Minecraft.' });
      return false;
    }
    let world;
    let items;
    try {
      world = await readWorldScene();
      items = await runGameQuery('pose:scan', { radius: REALIGN_RADIUS, rays: 0, dist: 8 }, auto ? 'Checking the scene lines up' : 'Reading the terrain around you');
    } catch (e) {
      if (!auto) showError('Pose Studio: realign', e);
      return false;
    }
    const { blocks } = parseScanItems(items);
    const now = new Map();
    for (const [x, y, z] of blocks) {
      const key = x + ',' + z;
      if (!(now.get(key) >= y + 1)) now.set(key, y + 1);
    }
    const found = matchHeights(scene, now);
    realignDebug = { found, scene: scene.size, now: now.size }; // for troubleshooting
    // a clear match: few mismatching columns, and clearly fewer than anywhere else
    const clear = found && found.errorRate <= 0.2 && found.secondErrorRate >= Math.max(found.errorRate * 2, found.errorRate + 0.01);
    if (auto) {
      // only when you're standing in the scene's area (so there's something to compare), the scene
      // clearly doesn't fit where it is, and one spot clearly fits
      const inArea = found && found.hereOverlap >= 60;
      const fitsHere = found && found.hereErrorRate <= Math.max(0.1, found.errorRate * 2);
      const sure = clear && found.overlap >= 150 && found.errorRate <= 0.1;
      if (!inArea || fitsHere || !sure || (!found.dx && !found.dy && !found.dz)) return false;
    }
    if (!clear) {
      Blockbench.showMessageBox({
        title: 'Pose Studio',
        message: "Couldn't find a clear match between the scene's terrain and the terrain around you.\n\nStand somewhere inside the area you imported, ideally near trees, slopes or buildings (flat ground all looks alike), and try again.",
      });
      return;
    }
    const a = world.anchor || { x: 0.5, y: 0, z: 0.5, dim: '' };
    const anchor = { x: a.x - found.dx, y: a.y - found.dy, z: a.z - found.dz, dim: a.dim || '' };
    await link.command(`scriptevent pose:anchor ${JSON.stringify({ at: [anchor.x, anchor.y, anchor.z], dim: anchor.dim || undefined })}`).catch(logFailure);
    connectedWorld = Object.assign(connectedWorld || world, { anchor });
    if (typeof Project !== 'undefined' && Project) {
      Project.pose_world = Object.assign({}, Project.pose_world || { id: world.id, name: connectedWorld.name || currentWorldName() }, { anchor });
    }
    resync();
    tellWorldLocation();
    ensureTickingArea().catch(() => {});
    const moved = Math.round(Math.hypot(found.dx, found.dy, found.dz));
    // keep it in the scene file straight away if the file was otherwise saved
    let kept = false;
    if (moved && Project && Project.save_path && Project.saved !== false && typeof Codecs !== 'undefined') {
      try {
        Codecs.project.write(Codecs.project.compile(), Project.save_path);
        kept = true;
      } catch (e) {
        kept = false;
      }
    }
    const keep = kept ? '' : ' Use Locations ▸ Save Location to keep this.';
    if (auto) {
      Blockbench.showQuickMessage(`Pose Studio: moved the scene ${moved} blocks to line up with the world.${keep}`, 6000);
    } else {
      Blockbench.showMessageBox({
        title: 'Pose Studio',
        message: moved ? `Found where the scene was built (${moved} blocks from where it was showing) and put it back.${keep}` : 'The scene already lines up with the world.',
      });
    }
    return !!moved;
  }

  // Locations ▸ Remove Location from World: the open scene stops being one of this world's locations.
  function unlinkScene() {
    const l = projectLink();
    if (link.connected && l && connectedWorld && l.id === connectedWorld.id) {
      send(`scriptevent pose:setloc ${JSON.stringify({ loc: l.loc || 'main', del: true })}`);
      removeTickingArea(l.loc).catch(() => {});
      connectedWorld.locations = (connectedWorld.locations || []).filter((x) => x.loc !== (l.loc || 'main'));
    }
    if (typeof Project !== 'undefined' && Project) Project.pose_world = null;
    Blockbench.showQuickMessage('Location removed from the world (the scene file is kept)', 2500);
  }

  // Runs when Minecraft connects: matches the open scene with the world's locations.
  async function checkWorldScene() {
    sceneIndex = null; // look at the scenes folder afresh
    let world;
    try {
      world = await readWorldScene();
    } catch (e) {
      world = null;
    }
    if (!world) {
      if (!link.connected) return; // the connection dropped: said already
      Blockbench.showQuickMessage("Pose Studio couldn't read this world's locations: the Pose Studio behavior pack may be missing or out of date (File > Plugins > Pose Studio > Settings > Check for Updates, then reload the world).", 8000);
      return;
    }
    if (world.protocol < EXPECTED_PACK_PROTOCOL && !warnedOldPack) {
      warnedOldPack = true;
      Blockbench.showMessageBox({
        title: 'Pose Studio',
        message: "The Pose Studio behavior pack in this world is older than the plugin, so some features (like locations) won't work fully.\n\nUpdate it with File > Plugins > Pose Studio > Settings > Check for Updates, then reload the world in Minecraft.",
      });
    }
    // scene files that belong to this world but aren't on its list (saved while disconnected, or
    // before the world could keep a list) are added, and the world's list is repaired
    for (const f of sceneFilesForWorld(world.id)) {
      if ((world.removed || []).includes(f.loc)) continue; // taken off the list on purpose
      const known = world.locations.find((l) => l.loc === f.loc || samePath(l.path, f.path));
      if (known) {
        if (!known.path) known.path = f.path;
        continue;
      }
      world.locations.push({ loc: f.loc, name: f.name, path: f.path, anchor: f.anchor });
      const msg = { loc: f.loc, p: forwardSlashes(f.path), n: f.name, w: world.name || f.worldName || '' };
      if (f.anchor) {
        msg.a = [f.anchor.x, f.anchor.y, f.anchor.z];
        msg.d = f.anchor.dim || undefined;
      }
      send(`scriptevent pose:setloc ${JSON.stringify(msg)}`);
      if (!world.name && f.worldName) world.name = f.worldName;
    }
    adoptPickedWorld(world.id);
    connectedWorld = world;
    const worldName = world.name || currentWorldName();
    connectedWorld.name = worldName;
    const project = typeof Project !== 'undefined' && Project ? Project : null;
    const linked = projectLink();
    const hasContent = project && (mannequinRoots().length || entityRoots().length || cameraRoots().length);
    const locations = world.locations || [];
    // the open scene is one of this world's locations: keep the world's copy up to date, put it in place
    if (linked && linked.id === world.id) {
      const mine = locations.find((l) => l.loc === (linked.loc || 'main'));
      if (projectPath() && (!mine || !samePath(projectPath(), mine.path))) tellWorldLocation();
      const moved = await restoreSceneAnchor();
      applySceneEnvironment();
      await ensureTickingArea().catch(() => {});
      await offerToGoThere().catch(() => {});
      releaseUpdates(); // in place: send its players now (the terrain check below can take a moment)
      const where = linked.loc && linked.loc !== 'main' ? `${linked.locName} (${worldName})` : worldName;
      Blockbench.showQuickMessage(`Location: ${where}${moved ? ', put back in place' : ''}`, 3000);
      await realignScene({ auto: true }).catch(() => false);
      return;
    }
    // the world has locations: offer the nearest (or switch to it if it's open in a tab)
    if (locations.length) {
      const sorted = locations.slice().sort((a, b) => distanceTo(a.anchor, world.player) - distanceTo(b.anchor, world.player));
      const nearest = sorted[0];
      const open = typeof ModelProject !== 'undefined' && ModelProject.all.find((p) => samePath(p.save_path, nearest.path));
      if (open) {
        open.select();
        Blockbench.showQuickMessage(`Switched to ${nearest.name}, the nearest location in ${worldName}`, 3000);
        return;
      }
      const away = distanceTo(nearest.anchor, world.player);
      const others = locations.length > 1 ? ` (${locations.length} locations in this world)` : '';
      Blockbench.showMessageBox(
        {
          title: 'Pose Studio',
          message: `${worldName} has Pose Studio locations${others}.\n\nNearest: ${nearest.name}${isFinite(away) ? `, ${Math.round(away)} blocks away` : ''}. Open it?`,
          buttons: [`Open ${nearest.name}`, 'All Locations…', 'Not Now'],
          confirm: 0,
          cancel: 2,
        },
        (button) => {
          if (button === 0) {
            if (fileExists(nearest.path)) openSceneFile(nearest.path);
            else Blockbench.showMessageBox({ title: 'Pose Studio', message: `The scene for ${nearest.name} wasn't found:\n${nearest.path}\n\nScenes are looked for in ${scenesFolder()} (set it in Pose Studio ▸ More ▸ Folders…).` });
          } else if (button === 1) openLocations();
        }
      );
      return;
    }
    // the world has no locations yet
    if (linked && linked.id !== world.id) {
      Blockbench.showMessageBox(
        {
          title: 'Pose Studio',
          message: `The open scene belongs to ${linked.name || 'another world'}, not ${worldName}.\n\nStart a new scene for ${worldName}?`,
          buttons: ['New Scene', 'Keep This One'],
          confirm: 0,
          cancel: 1,
        },
        (button) => {
          if (button === 0) newProject(Formats.free);
        }
      );
      return;
    }
    if (!hasContent) {
      Blockbench.showQuickMessage(`Connected to ${worldName}. No saved locations here yet: build a scene and use Locations ▸ Save Location.`, 5000);
    }
    if (hasContent) {
      Blockbench.showMessageBox(
        {
          title: 'Pose Studio',
          message: `Save this scene as a location in ${worldName}?\n\nPose Studio saves it, and offers it whenever you connect near it in this world.`,
          buttons: ['Save Location', 'Not Now'],
          confirm: 0,
          cancel: 1,
        },
        (button) => {
          if (button === 0) saveScene();
        }
      );
    }
  }

  // ---- Updates and changelog -----------------------------------------------------------------
  // Shared through a GitHub repository: people load blockbench/pose_studio.js from its raw URL
  // (File > Plugins > Load Plugin from URL), and Blockbench downloads it again on every start.
  // The Minecraft packs are copied into the development pack folders from the same repository.
  // CHANGELOG is written by release.js from changelog.json; don't edit it by hand.
  // <changelog>
  const CHANGELOG = [
    {
      "version": "0.41.0",
      "date": "2026-10-01",
      "changes": [
        "Removed the sun tilt from Time & Weather. If you applied a tilt, Pose Studio takes its lighting copies out of its pack when Blockbench starts, so the packs' own lighting applies again (reopen the world to see it)."
      ]
    },
    {
      "version": "0.40.2",
      "date": "2026-10-01",
      "changes": [
        "Fixed: Time & Weather opened empty (a broken tooltip stopped the window from drawing)."
      ]
    },
    {
      "version": "0.40.1",
      "date": "2026-10-01",
      "changes": [
        "New: Put Pose Studio on Top (Time & Weather, when the pack order stops the sun tilt). With the world closed, it moves Pose Studio's resource pack to first in the world's list, keeping a backup of the old order.",
        "The pack-order note now points at the Resource packs tab (not Behavior packs)."
      ]
    },
    {
      "version": "0.40.0",
      "date": "2026-10-01",
      "changes": [
        "New: Sun tilt in Camera > Time & Weather. Tilts the path the sun and moon take across the sky (Vibrant Visuals), so together with the time of day the sun can be put anywhere in the sky. Apply writes the world's lighting with that tilt into Pose Studio's pack and Minecraft reloads its packs (the world blinks). Pack Default goes back to the packs' own tilt.",
        "Each location keeps its sun tilt; opening a location with a different tilt offers to apply it.",
        "Pose Studio's resource pack has to be above packs with their own lighting (DragonCraft's) in the world's resource pack list; Time & Weather says when it isn't.",
        "Fixed: after switching worlds, Skin & Equipment could list the previous world's armour and items."
      ]
    },
    {
      "version": "0.39.0",
      "date": "2026-10-01",
      "changes": [
        "Fixed: cloaks (and other armour parts a pack animates from the wearer) can be posed. Turn the eq_cloak group forward or back in Blockbench and Minecraft follows: the mannequin passes the angle to the armour the way a player does (DragonCraft's cloak_angle).",
        "Armour previews now include the armour's own animations, so a cloak hangs at the same angle as in Minecraft.",
        "Update the Minecraft packs (Check for Updates, then close and reopen the world)."
      ]
    },
    {
      "version": "0.38.0",
      "date": "2026-10-01",
      "changes": [
        "Fixed: animations now move bones as well as turn them, like in Minecraft. A block drops and shifts the waist and steps the legs apart; holds pull the arms in. This works in Blockbench and in Minecraft (waist, body, head, arms, legs and hand bones).",
        "Fixed: animations that keep the head relative to the entity (it stays level while the body leans) now do so.",
        "Moving a player's bone by hand (the waist, an arm, a leg) now shows in Minecraft too.",
        "Equipment is sent to Minecraft separately and only when it changes, so a fully equipped player's pose always fits in one command.",
        "Update the Minecraft packs (Check for Updates, then close and reopen the world): the mannequin's pose is stored in a new, more compact way."
      ]
    },
    {
      "version": "0.37.0",
      "date": "2026-10-01",
      "changes": [
        "Fixed: players now have the same bone chain as Minecraft's player model: a waist, the body in the waist, the head and arms in the body (legs on their own). Animations that lean the waist or body (a sprint leans forward) carry the head and arms with them, in Blockbench and in Minecraft.",
        "Players from older scenes are rebuilt into the new chain the first time they're used. Every bone keeps facing the way it faced.",
        "The waist can be turned by hand too, to lean the whole upper body.",
        "Update the Minecraft packs (Check for Updates, then reopen the world): the mannequin has the new bone chain."
      ]
    },
    {
      "version": "0.36.0",
      "date": "2026-10-01",
      "changes": [
        "New: 3D weapons and items from your packs (DragonCraft's battle axes, daggers, greatswords, longbows…) in Skin & Equipment, shown in the hand as their real models, placed the way Minecraft places them. Daggers put their second blade in the left hand.",
        "New: weapon holding poses. A weapon that makes the player hold it a certain way brings that pose with it (arms and grip). Turn it on or off with the Holding pose tickbox; changing weapons swaps it, and bones you posed yourself are kept.",
        "New: Animation… lists the held weapon's animations first (attacks, blocks, combos, marked ⚔), to stack and pick frames as usual. First-person animations are no longer listed.",
        "New: players have rightItem / leftItem hand bones inside the arms. Turn or move them to adjust how an item is held; Minecraft follows.",
        "Update the Minecraft packs (Check for Updates, then reopen the world): the mannequin has the new hand bones."
      ]
    },
    {
      "version": "0.35.0",
      "date": "2026-10-01",
      "changes": [
        "New: 3D armour from your packs (DragonCraft's, say) in Skin & Equipment. Whole sets are listed with icons (click a set to put it on or take it off), and every piece appears in its slot's list under From your packs.",
        "Custom armour snaps onto the mannequin in Blockbench: each piece's model goes on the matching bones (head, body, arms, legs) and shows only the parts that piece shows, with slim or classic sleeves to match the skin. Minecraft shows the real items.",
        "Packs that restyle vanilla armour (like DragonCraft's iron armour) are previewed restyled.",
        "Skin & Equipment reads the open world's packs (the picked world, else the last played one) even if Add Entity hasn't been opened yet."
      ]
    },
    {
      "version": "0.34.2",
      "date": "2026-10-01",
      "changes": [
        "When Minecraft drops the connection straight away (\"Could not connect to server\", usually because Require Encrypted Websockets is on), Blockbench now says so and how to fix it, instead of blaming the behavior pack."
      ]
    },
    {
      "version": "0.34.1",
      "date": "2026-10-01",
      "changes": [
        "World names come from levelname.txt first, as in Minecraft, and from level.dat only when there's no levelname.txt."
      ]
    },
    {
      "version": "0.34.0",
      "date": "2026-10-01",
      "changes": [
        "New: More > Folders… sets the scenes folder (a shared Dropbox folder, say) and the Minecraft data folder (for Minecraft Preview or other installs). Locations are looked for in the scenes folder and its subfolders.",
        "New: worlds shared through git work for everyone. A location saved on someone else's PC is found in your scenes folder by its file name.",
        "New: Locations > Pick Minecraft World… points Pose Studio at the open world's folder when it isn't found by itself (worlds opened through ToolBox, say). It's remembered for that world, and a folder of zipped worlds is caught with advice.",
        "New: More > Install Minecraft Packs downloads the behavior and resource packs into the development pack folders. Connect to Minecraft offers it when they aren't installed.",
        "World names now come from level.dat (what ToolBox sets) rather than levelname.txt."
      ]
    },
    {
      "version": "0.33.6",
      "date": "2026-10-01",
      "changes": [
        "Fixed: after going to another location, the camera view could show a much narrower (more zoomed in) picture than Minecraft, even though the game camera was right. Switching projects left the view drawn at an old size and shape, so the picture was cropped. The camera view now checks its size, aspect and zoom every frame and puts them right."
      ]
    },
    {
      "version": "0.33.5",
      "date": "2026-10-01",
      "changes": [
        "Fixed: the camera view could drift away from its camera (showing the camera from behind, or the inside of the terrain). Blockbench's orbit controls kept applying leftover movement to it, and a split view rebuilt by Blockbench (after switching tabs) was no longer followed. The camera view is now locked to its camera on every frame."
      ]
    },
    {
      "version": "0.33.4",
      "date": "2026-10-01",
      "changes": [
        "Add Camera ▸ From Minecraft View while Sync Game Camera is on now saves the view Minecraft is showing as a new camera (same position, angle and field of view), instead of switching the camera off. To frame a new shot from your own view, turn Sync Game Camera off first."
      ]
    },
    {
      "version": "0.33.3",
      "date": "2026-10-01",
      "changes": [
        "Fixed: going to a far location and keeping locations loaded never actually worked in game. The teleport and ticking-area commands named the dimension \"minecraft:overworld\", which Bedrock's execute command rejects (it wants \"overworld\"), and the failure was silent.",
        "Teleporting to a location is now done by the behavior pack's script (works across dimensions) and checked: if Minecraft did not take you there, Pose Studio says so instead of claiming it did.",
        "A ticking area that Minecraft refuses (a world allows 10) is reported.",
        "Needs the updated Minecraft behavior pack (Check for Updates, then reload the world)."
      ]
    },
    {
      "version": "0.33.2",
      "date": "2026-10-01",
      "changes": [
        "Fixed: a location's players could turn up at a different location. When switching, updates went out before Minecraft's anchor had moved, and an update waiting for an unloaded area was later placed at whichever location was active by then. Updates now wait until the location is in place, and waiting updates are dropped when the anchor moves.",
        "Fixed: entity copies in an unloaded area reported \"Pose Studio's entities aren't loaded yet\" instead of waiting for the area like players do.",
        "Needs the updated Minecraft behavior pack (Check for Updates, then reload the world)."
      ]
    },
    {
      "version": "0.33.1",
      "date": "2026-10-01",
      "changes": [
        "Fixed: after going to a far location, its players and entities could exist in Minecraft without being drawn. Entities created while you were away are not always sent to your screen when you arrive, so Pose Studio now places them again once you are there.",
        "New: Locations ▸ Refresh in Minecraft removes and re-places the open location's players and entities, for whenever they are missing."
      ]
    },
    {
      "version": "0.33.0",
      "date": "2026-09-30",
      "changes": [
        "Switching between far-apart locations now works reliably: Minecraft only draws terrain and entities around the player, so switching to a location more than about 100 blocks away takes you there automatically. The area loads, then its players and entities are placed. Turn off Go to Locations in the plugin settings to be asked instead."
      ]
    },
    {
      "version": "0.32.3",
      "date": "2026-09-30",
      "changes": [
        "Locations now keep their area loaded with a ticking area, so their players and entities appear even when you are far away or outside your simulation distance. Minecraft only lets scripts place entities in ticking chunks, which caused players to go missing.",
        "Debug Info (File > Plugins > Pose Studio > Settings) now shows where the open location is saved, where Minecraft's anchor is, where you are, and which world and pack version it sees. Minecraft also lists each Pose Studio entity's position in chat.",
        "Needs the updated Minecraft behavior pack (Check for Updates, then reload the world)."
      ]
    },
    {
      "version": "0.32.2",
      "date": "2026-09-30",
      "changes": [
        "Fixed: a location far from the player showed no players and filled chat with LocationInUnloadedChunkError. Minecraft only loads the area around you, so its updates now wait and appear as soon as you get there.",
        "Switching to (or connecting with) a location that is far away offers to teleport you there.",
        "Locations… has a Go There button.",
        "Needs the updated Minecraft behavior pack (Check for Updates, then reload the world)."
      ]
    },
    {
      "version": "0.32.1",
      "date": "2026-09-30",
      "changes": [
        "Connecting to a world now finds its locations even if the world never stored them (for example scenes saved while Blockbench was disconnected): Pose Studio also looks in DocumentsPose StudioScenes for scene files that belong to the world, offers them, and repairs the world's list.",
        "Pose Studio now always says something on connect: the location it found, that the world has none yet, or that the world's behavior pack is missing or out of date.",
        "A location removed from a world stays removed.",
        "Needs the updated Minecraft behavior pack (Check for Updates, then reload the world)."
      ]
    },
    {
      "version": "0.32.0",
      "date": "2026-09-30",
      "changes": [
        "The day/night and weather cycles are frozen while Blockbench is connected (doDaylightCycle and doWeatherCycle off), and turned back on when it disconnects. There is a setting to turn this off.",
        "New time of day slider and clear/rain/thunder buttons in the camera view, and Camera ▸ Time & Weather… with presets.",
        "Each location saves its time and weather, and puts them back when it opens or you switch to it."
      ]
    },
    {
      "version": "0.31.0",
      "date": "2026-09-30",
      "changes": [
        "Locations: one world can hold several set-ups, each a scene of its own with its own imported terrain, entities, cameras and position in the world. The Scene menu is now Locations.",
        "Locations ▸ New Location Here… starts a new scene tab centred where you stand, so you can import that area and set up cameras without disturbing your other locations.",
        "Locations ▸ Locations… lists the world's locations nearest first, to open, rename or remove them. Switching tabs moves Minecraft to that location, and every location's entities stay set up in the world at once.",
        "When you connect, Pose Studio offers the location you are standing nearest.",
        "Needs the updated Minecraft behavior pack (Check for Updates). Scenes linked with 0.30 become the location \"Main\"."
      ]
    },
    {
      "version": "0.30.2",
      "date": "2026-09-30",
      "changes": [
        "Scenes line themselves up automatically: when a linked scene connects or opens, Pose Studio compares its imported terrain with the terrain around you and moves it back if it is clearly offset. It only acts when you are standing in the scene's area and the match is unmistakable, and saves the corrected position into the scene file."
      ]
    },
    {
      "version": "0.30.1",
      "date": "2026-09-30",
      "changes": [
        "Fixed: opening a saved scene could put it in the wrong place in Minecraft. Connecting with an empty scene moved the world anchor to where you stood before the saved scene opened. Worlds with a scene now keep their anchor.",
        "Scenes remember where in the world they were built and put themselves back there when they open or when you switch to their tab.",
        "New: Scene ▸ Realign Scene with World finds the original position of a scene that lost it, by matching its imported terrain with the terrain around you.",
        "Minecraft requests now wait their turn instead of failing with \"another transfer is running\".",
        "Needs the updated Minecraft behavior pack (Check for Updates)."
      ]
    },
    {
      "version": "0.30.0",
      "date": "2026-09-30",
      "changes": [
        "Scenes linked to worlds: Scene ▸ Save Scene saves with one click (to DocumentsPose StudioScenes the first time) and links the scene with the Minecraft world you have open.",
        "When you connect, Pose Studio offers to open that world's scene (or switches to its tab), warns if the open scene belongs to another world, and offers to link an unlinked scene.",
        "Scene ▸ Open This World's Scene and Unlink Scene from World.",
        "Needs the updated Minecraft behavior pack (Check for Updates)."
      ]
    },
    {
      "version": "0.29.0",
      "date": "2026-09-30",
      "changes": [
        "Horse armour: Variant… on a horse has Markings and Armour dropdowns (leather, iron, gold, diamond, copper, netherite) alongside the coat.",
        "Villager variants: Variant… on a villager or zombie villager picks the biome (plains, desert, jungle, savanna, snow, swamp, taiga) and the profession, with the level badge as in game. Llamas get their decor too.",
        "The Variant window now has a grid for the main choice plus a dropdown for each other choice and a Baby tickbox.",
        "The camera view FOV slider now goes from 30° to 110°.",
        "Minecraft needs one pack reload after this update (open Add Entity… and accept the prompt) to load the new looks."
      ]
    },
    {
      "version": "0.28.0",
      "date": "2026-09-30",
      "changes": [
        "New: Variant… (with an entity selected) shows every look of that mob with thumbnails: biome and colour variants and baby versions. Click one to swap it where it stands, keeping its pose.",
        "New: a Baby checkbox in Add Entity adds baby versions directly.",
        "All variants and babies are prepared for Minecraft along with the entities, so switching is instant in game too (one pack reload after this update).",
        "Scan World is now Import World, and it is several times faster: the data comes back from Minecraft in large, checked batches and a more compact format. Update the Minecraft packs (Check for Updates) to get the speed-up.",
        "Turning on Sync Game Camera sets the camera view to Match Minecraft Window.",
        "The Animation window fits without a scroll bar."
      ]
    },
    {
      "version": "0.27.1",
      "date": "2026-09-30",
      "changes": [
        "The Animation window remembers what you applied: reopening it shows the same stack and frames instead of adding the animation a second time. Bones you posed by hand in between keep that posing.",
        "Click an animation in the list to add it, and click it again to take it off (the ✕ buttons are gone)."
      ]
    },
    {
      "version": "0.27.0",
      "date": "2026-09-30",
      "changes": [
        "Animation Frame… is now Animation… and works for players as well as entities.",
        "Animations add to the pose you already made (a head you turned stays turned). Tick Reset pose to start from the default pose instead.",
        "Stack several animations, each at its own frame (for example walk plus attack), and remove any with ✕.",
        "A live preview of the model in the Animation window.",
        "Look-at-target and first-person animations are no longer listed.",
        "New mannequins are named Player_1, Player_2… (older mq_ mannequins still work)."
      ]
    },
    {
      "version": "0.26.0",
      "date": "2026-09-30",
      "changes": [
        "New: Animation Frame… (with an entity selected). Pick one of the entity's animations, play or scrub through it, and keep the frame you like as its pose. Works with keyframed animations and with Minecraft's walk, attack and idle cycles.",
        "New: a field of view slider in the bottom-left corner of the camera view."
      ]
    },
    {
      "version": "0.25.0",
      "date": "2026-09-30",
      "changes": [
        "Add Camera ▸ From Minecraft View no longer moves the viewport you work in; only the camera view shows the new camera.",
        "Cameras grabbed from Minecraft get the same field of view as your Minecraft FOV setting.",
        "The camera view buttons (move, forward/back, orbit) moved to the left side of the camera view."
      ]
    },
    {
      "version": "0.24.0",
      "date": "2026-09-30",
      "changes": [
        "The camera view has Cinema 4D style buttons in its top-right corner: drag the hand to move the camera sideways and up/down, the arrows to move it forward/back, and the circle to orbit it around what it looks at (hold Shift to turn it on the spot). Each drag is one undo step.",
        "New cameras are drawn as a line outline (spline mesh) in the Generic Model format, with a triangle marking the top. Other formats keep the block camera.",
        "Smoother rotation when turning several selected objects together: only the moved objects are redrawn."
      ]
    },
    {
      "version": "0.23.0",
      "date": "2026-09-30",
      "changes": [
        "Rotating two or more selected mannequins, entities and cameras now turns them around their shared centre as one piece, instead of each spinning in place. One undo reverts the whole turn."
      ]
    },
    {
      "version": "0.22.0",
      "date": "2026-09-30",
      "changes": [
        "Add Camera now opens the camera view on the new camera and makes the Minecraft camera follow it.",
        "From Minecraft View while the game camera is synced first gives you your own view back to frame the next shot; choose it again to save.",
        "Tidier menu: the camera options are grouped under Camera (view, sync, FOV, aspect ratio, look through, follow viewport).",
        "The changelog is now in File > Plugins > Pose Studio > Changelog. Check for Updates, Debug Info and Held Items on Entities moved to that page's Settings tab."
      ]
    },
    {
      "version": "0.21.0",
      "date": "2026-09-30",
      "changes": [
        "Simpler menu: with no mannequin selected it shows Add Mannequin; select a mannequin and the same spot becomes Skin & Equipment…, one window with a Skin tab and an Equipment tab.",
        "With an entity selected, Equipment… appears for its armour and held items.",
        "Skin Library… (for adding and removing skins with nothing selected) moved to More."
      ]
    },
    {
      "version": "0.20.1",
      "date": "2026-09-30",
      "changes": [
        "Connect to Minecraft has a Copy Command button: paste the /connect command straight into Minecraft chat."
      ]
    },
    {
      "version": "0.20.0",
      "date": "2026-09-30",
      "changes": [
        "Pose Studio can now be shared from GitHub: install it with File > Plugins > Load Plugin from URL and Blockbench fetches the latest version every time it starts.",
        "New: More > Check for Updates installs or updates the Pose Studio Minecraft packs straight into your development pack folders (no .mcaddon needed), and updates the plugin.",
        "New: More > What's New shows this changelog, and it pops up once after each update."
      ]
    },
    {
      "version": "0.19.3",
      "date": "2026-09-30",
      "changes": [
        "Sheep show their face and legs in Minecraft instead of being all white.",
        "Spider and enderman eyes, the blaze, glow squid, magma cube and phantom no longer have see-through parts on entity copies."
      ]
    },
    {
      "version": "0.19.2",
      "date": "2026-09-30",
      "changes": [
        "Sheep have their body and legs under the wool again.",
        "The cat's and ocelot's tail is one piece, hanging down and back."
      ]
    },
    {
      "version": "0.19.1",
      "date": "2026-09-30",
      "changes": [
        "Skeletons, strays, bogged and wither skeletons stand normally instead of mixing attack, bow and sneaking poses.",
        "Cats and ocelots stand instead of lying or sitting; parrots stand instead of dancing.",
        "Fixed the default pose of villagers, zombie villagers, the wandering trader, enderman, witch, vex, sniffer, panda, snow golem, hoglin, turtle, wolf, spiders and llamas.",
        "Fixed doubled body parts on sheep, witches and zombie villagers."
      ]
    },
    {
      "version": "0.19.0",
      "date": "2026-09-30",
      "changes": [
        "Add Entity opens a floating panel you can move, resize or dock, and it stays open while you add entities."
      ]
    },
    {
      "version": "0.18.1",
      "changes": [
        "Earlier versions: posable mannequins, live link to Minecraft, cameras from Minecraft or Blockbench, world scan, camera FOV, split camera viewport with aspect ratios, skins and a skin library, every entity from your world with thumbnails, whole-body tilt, armour and held items, and correct resting poses for vanilla mobs."
      ]
    }
  ];
  // </changelog>
  const DEFAULT_UPDATE_BASE = '';
  const PLUGIN_URL = 'https://raw.githubusercontent.com/liambevin2000/pose-studio/main/blockbench/pose_studio.js';
  const INSTALLED_PACKS_FILE = 'pose_studio_packs.json';
  let startupTimer = null;

  function compareVersions(a, b) {
    const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
    }
    return 0;
  }

  // Where the repository's files are: next to the URL this plugin was loaded from.
  function updateBase() {
    const self = typeof Plugins !== 'undefined' && Plugins.registered && Plugins.registered.pose_studio;
    if (self && self.source === 'url' && /^https?:/.test(self.path || '')) {
      return self.path.replace(/\/blockbench\/pose_studio\.js(\?.*)?$/, '');
    }
    return DEFAULT_UPDATE_BASE;
  }

  async function fetchRepo(base, file, as = 'json') {
    const response = await fetch(`${base}/${file}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${file}: ${response.status} ${response.statusText}`);
    return as === 'json' ? response.json() : response.arrayBuffer();
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  function changelogHtml(entries) {
    return entries
      .map((e) => `<h3 style="margin: 12px 0 4px;">${escapeHtml(e.version)}${e.date ? ` <span style="opacity: 0.6; font-size: 0.8em;">${escapeHtml(e.date)}</span>` : ''}</h3>` +
        `<ul style="margin: 0 0 0 18px; padding: 0;">${(e.changes || []).map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`)
      .join('');
  }

  function showChangelog(title, entries, extraHtml = '', buttons = ['Close'], onButton = null) {
    new Dialog({
      id: 'pose_studio_changelog',
      title,
      width: 560,
      buttons,
      lines: [`<div style="max-height: 60vh; overflow-y: auto;">${extraHtml}${changelogHtml(entries) || '<p>No changes listed.</p>'}</div>`],
      onButton: (index) => (onButton ? onButton(index) : undefined),
    }).show();
  }

  // CHANGELOG in the shape of the plugin page's Changelog tab (newest first).
  function pluginPageChangelog() {
    const out = {};
    for (const e of CHANGELOG) {
      out[e.version] = { title: e.version, date: e.date || undefined, categories: [{ title: 'Changes', list: e.changes || [] }] };
    }
    return out;
  }

  // After an update, says so once and points to the Changelog tab.
  function showWhatsNewOnce() {
    let seen = null;
    try {
      seen = localStorage.getItem('pose_studio_seen_version');
      localStorage.setItem('pose_studio_seen_version', PLUGIN_VERSION);
    } catch (e) {
      return;
    }
    if (!seen || compareVersions(PLUGIN_VERSION, seen) <= 0) return;
    // just a note: the full list is on the plugin page
    Blockbench.showQuickMessage(`Pose Studio updated to ${PLUGIN_VERSION}. See what changed in File > Plugins > Pose Studio > Changelog`, 6000);
  }

  function installedPacks() {
    try {
      const fs = bedrockFs();
      const file = `${devPackDir('behavior')}\\${INSTALLED_PACKS_FILE}`;
      if (!fs.existsSync(devPackDir('behavior')) || !fs.existsSync(devPackDir('resource'))) return { missing: true };
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    } catch (e) {
      return {};
    }
  }

  // Copies the repository's packs into development_behavior_packs / development_resource_packs.
  // Skin slots the skin library has already filled are kept.
  async function installPacks(base, list) {
    const fs = bedrockFs();
    const root = `${bedrockRoot()}\\Users\\Shared\\games\\com.mojang`;
    let done = 0;
    for (const file of list.files) {
      Blockbench.setProgress(done++ / list.files.length);
      const kind = file.path.startsWith('PoseStudio_BP/') ? 'development_behavior_packs' : 'development_resource_packs';
      const dest = `${root}\\${kind}\\${file.path.split('/').join('\\')}`;
      if (/\/skin_\d+\.png$/.test(file.path) && fs.existsSync(dest)) continue;
      const data = await fetchRepo(base, `packs/${file.path.split('/').map(encodeURIComponent).join('/')}`, 'buffer');
      fs.mkdirSync(dest.replace(/\\[^\\]+$/, ''), { recursive: true });
      fs.writeFileSync(dest, bufferClass().from(data));
    }
    Blockbench.setProgress(0);
    fs.writeFileSync(`${devPackDir('behavior')}\\${INSTALLED_PACKS_FILE}`, JSON.stringify({ revision: list.revision, version: list.version }, null, 2));
  }

  // Pose Studio ▸ More ▸ Check for Updates (and quietly at startup: only speaks up when
  // something is out of date).
  async function checkForUpdates(manual = true) {
    const base = updateBase();
    if (!base) {
      if (manual) {
        Blockbench.showMessageBox({
          title: 'Pose Studio updates',
          message: `This copy was installed from a file, so it can't update itself. Install it with File > Plugins > Load Plugin from URL, and updates will arrive automatically:

${PLUGIN_URL}`,
        });
      }
      return;
    }
    let changelog;
    let packList;
    try {
      [changelog, packList] = await Promise.all([fetchRepo(base, 'changelog.json'), fetchRepo(base, 'packs.json')]);
    } catch (e) {
      if (manual) showError('Pose Studio: checking for updates', e);
      return;
    }
    const latest = (changelog[0] && changelog[0].version) || PLUGIN_VERSION;
    const pluginOld = compareVersions(latest, PLUGIN_VERSION) > 0;
    const installed = installedPacks();
    const packsOld = installed.missing || installed.revision !== packList.revision;
    if (!pluginOld && !packsOld) {
      if (manual) Blockbench.showQuickMessage(`Pose Studio ${PLUGIN_VERSION} is up to date`, 2000);
      return;
    }
    const notes = [];
    if (pluginOld) notes.push(`Pose Studio <b>${escapeHtml(latest)}</b> is available (you have ${escapeHtml(PLUGIN_VERSION)}).`);
    if (installed.missing) notes.push('The Pose Studio Minecraft packs aren\'t installed yet. Update copies them into your development pack folders.');
    else if (packsOld) notes.push('The Pose Studio Minecraft packs have changed.');
    const entries = pluginOld ? changelog.filter((e) => compareVersions(e.version, PLUGIN_VERSION) > 0) : [];
    showChangelog('Pose Studio update', entries, `<p>${notes.join('<br>')}</p>`, ['Update', 'Later'], (index) => {
      if (index === 0) applyUpdate(base, { pluginOld, packsOld, packList, firstInstall: !!installed.missing });
    });
  }

  async function applyUpdate(base, { pluginOld, packsOld, packList, firstInstall }) {
    if (packsOld) {
      try {
        await installPacks(base, packList);
      } catch (e) {
        Blockbench.setProgress(0);
        return showError('Pose Studio: installing the Minecraft packs', e);
      }
      const how = firstInstall
        ? 'Installed. In Minecraft, add "Pose Studio" under the world\'s Behavior Packs and Resource Packs (Edit World), then open the world.'
        : link.connected
          ? 'Minecraft packs updated. Minecraft is reloading them now.'
          : 'Minecraft packs updated. Reopen your world (or run /reload all) to load them.';
      if (!firstInstall && link.connected) reloadMinecraftPacks();
      Blockbench.showMessageBox({ title: 'Pose Studio', message: how });
    }
    if (pluginOld) {
      const self = Plugins.registered && Plugins.registered.pose_studio;
      // reloading replaces this code with the new version; nothing may run after it
      if (self && self.source === 'url' && typeof self.reload === 'function') setTimeout(() => self.reload(), 300);
      else Blockbench.showMessageBox({ title: 'Pose Studio', message: 'Restart Blockbench to load the new version.' });
    }
  }

  Plugin.register('pose_studio', {
    title: 'Pose Studio',
    author: 'Pose Studio',
    icon: 'accessibility_new',
    description: 'Pose mannequins in Blockbench and see them live in Minecraft Bedrock (Vibrant Visuals).',
    version: PLUGIN_VERSION,
    variant: 'desktop',

    onload() {
      fovProperty = new Property(Group, 'number', 'pose_fov', { default: 0 });
      if (typeof ModelProject !== 'undefined') {
        worldProperty = new Property(ModelProject, 'object', 'pose_world', { default: null, exposed: false });
        envProperty = new Property(ModelProject, 'object', 'pose_env', { default: null, exposed: false });
      }
      skinProperties = [
        new Property(Group, 'object', 'pose_entity'),
        new Property(Group, 'object', 'pose_equipment'),
        new Property(Group, 'object', 'pose_animation'),
        new Property(Group, 'object', 'pose_vars'),
        new Property(Group, 'object', 'pose_driver'),
        new Property(Group, 'number', 'pose_skin_slot', { default: 0 }),
        new Property(Group, 'boolean', 'pose_slim', { default: false }),
      ];
      pickTimer = setInterval(disableWorldPicking, 1000);
      startGroupSpin();
      if (Blockbench.on) Blockbench.on('select_project', onProjectSelected);

      const a = {
        link: (linkToggle = new Toggle('pose_studio_link', {
          name: 'Connect to Minecraft', icon: 'cable', value: false, onChange: onLinkToggle,
          description: 'Listens for Minecraft on 127.0.0.1:19131 (run /connect 127.0.0.1:19131 in game).',
        })),
        // One slot in the menu: Add Mannequin with no mannequin selected, Skin & Equipment… with one
        savescene: new Action('pose_studio_save_scene', {
          name: 'Save Location', icon: 'save', click: saveScene,
          description: 'Saves this location\'s scene (to Documents\\Pose Studio\\Scenes the first time) and links it with the Minecraft world you have open.',
        }),
        newlocation: new Action('pose_studio_new_location', {
          name: 'New Location Here…', icon: 'add_location_alt', click: newLocationHere,
          description: 'Starts a new scene tab for another spot in this world, centred where you stand, with its own terrain, entities and cameras.',
        }),
        locations: new Action('pose_studio_locations', {
          name: 'Locations…', icon: 'place', click: openLocations,
          description: "This world's locations, nearest first: open, rename or remove them.",
        }),
        refreshloc: new Action('pose_studio_refresh_location', {
          name: 'Refresh in Minecraft', icon: 'refresh', click: () => refreshLocationEntities(),
          description: "Removes this location's players and entities in Minecraft and places them again, for when they're missing or not drawn.",
        }),
        unlinkscene: new Action('pose_studio_unlink_scene', { name: 'Remove Location from World', icon: 'wrong_location', click: unlinkScene }),
        realign: new Action('pose_studio_realign_scene', {
          name: 'Realign with World', icon: 'my_location', click: () => realignScene(),
          description: "Finds where the scene was built by matching its imported terrain with the terrain around you, and puts it back there.",
        }),
        add: new Action('pose_studio_add', {
          name: 'Add Mannequin', icon: 'accessibility_new', click: addMannequin,
          condition: () => !selectionIs('mannequin'),
        }),
        outfit: new Action('pose_studio_outfit', {
          name: 'Skin & Equipment…', icon: 'checkroom', click: () => openOutfit('skin'),
          description: 'Skin, armour and held items for the selected mannequin.',
          condition: () => selectionIs('mannequin'),
        }),
        entity: new Action('pose_studio_entity', {
          name: 'Add Entity…', icon: 'pets', click: openEntityBrowser,
          description: "Every entity in the world you're in (Minecraft's and your packs'), with thumbnails.",
        }),
        equipment: new Action('pose_studio_equipment', {
          name: 'Equipment…', icon: 'shield', click: () => openOutfit('equipment'),
          description: 'Armour and held items for the selected entity.',
          condition: () => selectionIs('entity'),
        }),
        variant: new Action('pose_studio_variant', {
          name: 'Variant…', icon: 'palette', click: openVariants,
          description: 'Other looks of the selected entity: biome and colour variants, and its baby version.',
          condition: () => selectionIs('entity'),
        }),
        animation: new Action('pose_studio_animation', {
          name: 'Animation…', icon: 'animation', click: openAnimationFrames,
          description: 'Pose the selected player or entity with frames of its animations (walk, attack, sit...), stacked on the pose it has.',
          condition: () => selectionIs('entity') || selectionIs('mannequin'),
        }),
        skin: new Action('pose_studio_skin', {
          name: 'Skin Library…', icon: 'checkroom', click: openSkinLibrary,
          description: 'Add, replace and remove skins (dress a mannequin from Skin & Equipment…).',
        }),
        grabcam: new Action('pose_studio_grabcam', {
          name: 'From Minecraft View', icon: 'add_a_photo', click: grabCameraFromPlayer,
          description: 'Saves your current in-game view as a cam_ group.',
        }),
        savecam: new Action('pose_studio_savecam', { name: 'From Blockbench View', icon: 'switch_video', click: saveViewportAsCamera }),
        timeweather: new Action('pose_studio_time_weather', {
          name: 'Time & Weather…', icon: 'schedule', click: timeWeatherDialog,
          description: 'Time of day and weather in Minecraft, kept with each location.',
        }),
        fov: new Action('pose_studio_fov', {
          name: 'Camera FOV…', icon: 'camera', click: fovDialog,
          description: 'Field of view of the active camera (or the viewport).',
        }),
        pov: (povToggle = new Toggle('pose_studio_pov', {
          name: 'Camera POV Viewport', icon: 'splitscreen', value: false, onChange: setPovViewport,
          description: 'Splits the viewport: one view to work in, one locked to the active camera.',
        })),
        camera: (cameraToggle = new Toggle('pose_studio_camera', {
          name: 'Sync Game Camera', icon: 'videocam', value: false, onChange: setCameraSync,
          description: 'The Minecraft camera follows the active camera, or the viewport if there is none.',
        })),
        scan: new Action('pose_studio_scan', { name: 'Import World…', icon: 'travel_explore', click: scanWorldDialog,
          description: 'Brings the terrain around you in Minecraft into Blockbench as one mesh.' }),
        capture: new Action('pose_studio_capture', { name: 'Capture Screenshot', icon: 'photo_camera', click: capture }),
        anchor: new Action('pose_studio_anchor', {
          name: 'Recenter Scene on Me', icon: 'my_location', click: setAnchor,
          description: "Moves the whole scene in Minecraft so Blockbench's origin is where you're standing.",
        }),
        lookcam: new Action('pose_studio_lookcam', { name: 'Look Through Camera', icon: 'visibility', click: () => lookThroughCamera() }),
        follow: new Action('pose_studio_follow_viewport', { name: 'Follow Viewport (No Active Camera)', icon: '3d_rotation', click: followViewport }),
        clear: new Action('pose_studio_clear', { name: 'Remove Mannequins from World', icon: 'delete_sweep', click: clearWorld }),
        pickworld: new Action('pose_studio_pick_world', {
          name: 'Pick Minecraft World…', icon: 'folder_open', click: pickWorldFolder,
          description: "Points Pose Studio at the open world's folder when it isn't found by itself (worlds opened through other tools, say).",
        }),
        folders: new Action('pose_studio_folders', {
          name: 'Folders…', icon: 'folder_shared', click: foldersDialog,
          description: 'Where scenes are saved (a shared Dropbox folder, say) and where Minecraft keeps its worlds and packs.',
        }),
        installpacks: new Action('pose_studio_install_packs', {
          name: 'Install Minecraft Packs', icon: 'download', click: () => installPacksNow(),
          description: 'Downloads the Pose Studio behavior and resource packs into your development pack folders.',
        }),
        reloadpacks: new Action('pose_studio_reload_packs', {
          name: 'Reload Minecraft Packs', icon: 'refresh', click: reloadMinecraftPacks,
          description: 'Runs /reload all so Minecraft loads new skin images (the world briefly closes and reopens).',
        }),
      };
      actions = Object.values(a);

      // Rarely needed options live on the plugin's page (File > Plugins > Pose Studio > Settings).
      const setting = (id, options) => new Setting(id, Object.assign({ category: 'general', plugin: 'pose_studio' }, options));
      pluginSettings = [
        setting('pose_studio_entity_held_items', {
          name: 'Pose Studio: Held Items on Entities', type: 'toggle', value: entityHeldItems,
          description: 'Shows held items on entity copies in Minecraft using invisible mannequins. Turn off if Minecraft disconnects.',
          onChange: (value) => {
            entityHeldItems = value;
          },
        }),
        setting('pose_studio_freeze_clock', {
          name: 'Pose Studio: Freeze Time and Weather', type: 'toggle', value: true,
          description: 'Turns off the day/night and weather cycles (doDaylightCycle, doWeatherCycle) while Blockbench is connected, and turns them back on when it disconnects.',
          onChange: (value) => {
            freezeEnabled = value;
            if (value) freezeWorldClock().catch(() => {});
            else unfreezeWorldClock().catch(() => {});
          },
        }),
        setting('pose_studio_follow_locations', {
          name: 'Pose Studio: Go to Locations', type: 'toggle', value: true,
          description: 'When you switch to a location far from where you stand, teleport there (Minecraft only shows the world around the player). Off: ask first.',
          onChange: (value) => {
            followLocations = value;
          },
        }),
        setting('pose_studio_folders', {
          name: 'Pose Studio: Folders', type: 'click', icon: 'folder_shared', click: foldersDialog,
          description: 'Where scenes are saved (a shared Dropbox folder, say) and where Minecraft keeps its worlds and packs.',
        }),
        setting('pose_studio_check_updates', {
          name: 'Pose Studio: Check for Updates', type: 'click', icon: 'update', click: () => checkForUpdates(true),
          description: 'Updates this plugin and installs or updates the Pose Studio Minecraft packs.',
        }),
        setting('pose_studio_debug_info', {
          name: 'Pose Studio: Debug Info', type: 'click', icon: 'bug_report', click: showDebug,
          description: 'What Blockbench is sending to Minecraft, for troubleshooting.',
        }),
      ];
      entityHeldItems = !!pluginSettings[0].value;
      freezeEnabled = pluginSettings[1].value !== false;
      followLocations = pluginSettings[2].value !== false;
      // The plugin page's Changelog tab shows this; Blockbench otherwise looks for it in its plugin store.
      const self = typeof Plugins !== 'undefined' && Plugins.registered && Plugins.registered.pose_studio;
      if (self) {
        self.has_changelog = true;
        self.changelog = pluginPageChangelog();
      }

      menu = new BarMenu('pose_studio', [
        a.link,
        { name: 'Locations', id: 'pose_studio_scene_menu', icon: 'place', children: [a.savescene, a.newlocation, a.locations, '_', a.refreshloc, a.realign, a.unlinkscene, '_', a.pickworld] },
        '_',
        a.add,
        a.outfit,
        a.entity,
        a.equipment,
        a.variant,
        a.animation,
        { name: 'Add Camera', id: 'pose_studio_add_camera', icon: 'videocam', children: [a.grabcam, a.savecam] },
        {
          name: 'Camera', id: 'pose_studio_camera_menu', icon: 'photo_camera_front',
          children: [a.pov, a.camera, '_', a.fov, { name: 'Aspect Ratio', id: 'pose_studio_aspect', icon: 'aspect_ratio', children: aspectMenuItems }, a.timeweather, '_', a.lookcam, a.follow],
        },
        '_',
        a.scan,
        a.capture,
        '_',
        { name: 'More', id: 'pose_studio_more', icon: 'more_horiz', children: [a.folders, a.installpacks, '_', a.anchor, a.skin, a.reloadpacks, a.clear] },
      ], { name: 'Pose Studio' });
      MenuBar.addMenu(menu, 'tools');
      startupTimer = setTimeout(() => {
        startupTimer = null;
        showWhatsNewOnce();
        checkForUpdates(false).catch(() => {});
        removeSunTiltLighting();
      }, 4000);
    },

    onunload() {
      stopGroupSpin();
      if (Blockbench.removeListener) Blockbench.removeListener('select_project', onProjectSelected);
      if (startupTimer) clearTimeout(startupTimer);
      startupTimer = null;
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = null;
      if (cameraSync && link.connected) send('scriptevent pose:camclear');
      if (playerHidden && link.connected) send('scriptevent pose:hideplayer {"hide":false}');
      link.stop();
      if (povPreview) setPovViewport(false);
      stopWindowWatch();
      if (pickTimer) clearInterval(pickTimer);
      pickTimer = null;
      for (const action of actions) action.delete();
      actions = [];
      linkToggle = cameraToggle = povToggle = null;
      for (const s of pluginSettings) s.delete();
      pluginSettings = [];
      if (menu) {
        delete MenuBar.menus.pose_studio;
        MenuBar.update();
      }
      menu = null;
      for (const p of skinProperties) p.delete();
      skinProperties = [];
      if (entityPanel) entityPanel.delete();
      entityPanel = null;
      browserVm = null;
      if (worldProperty) worldProperty.delete();
      worldProperty = null;
      if (envProperty) envProperty.delete();
      envProperty = null;
      if (fovProperty) fovProperty.delete();
      fovProperty = null;
    },
  });
})();
