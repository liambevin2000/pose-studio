// Pose Studio — Blockbench half.
// Blockbench is the editor; Minecraft Bedrock (with Vibrant Visuals) is the live viewport.
// Minecraft connects to this plugin with `/connect 127.0.0.1:19131`, and every pose change is
// sent back as a `/scriptevent pose:*` command that the Pose Studio behavior pack applies.
(function () {
  'use strict';

  // ---- Settings / calibration ---------------------------------------------------------------
  const PLUGIN_VERSION = '0.20.1'; // set by release.js from changelog.json
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
  const MANNEQUIN_PREFIX = /^mq_/i;

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
  function mannequinId(name) {
    return String(name).replace(/[^a-z0-9_]/gi, '_');
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
      const parse = createFrameParser(socket, (text) => this.receive(text));
      socket.on('data', parse);
      if (leftover && leftover.length) parse(leftover);
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.failPending('Minecraft disconnected');
        Blockbench.showQuickMessage('Pose Studio: Minecraft disconnected', 2000);
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
    const cubes = [
      new Cube({ name: 'body', from: [x - 3, y - 3, z], to: [x + 3, y + 3, z + 8], color: 4 }).addTo(group).init(),
      new Cube({ name: 'lens', from: [x - 1.5, y - 1.5, z - 3], to: [x + 1.5, y + 1.5, z], color: 5 }).addTo(group).init(),
    ];
    Undo.finishEdit('Add Pose Studio camera', { outliner: true, elements: cubes });
    Canvas.updateAll();
    group.select();
    return group;
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

  function setPovViewport(enabled) {
    const split = typeof Preview !== 'undefined' && Preview.split_screen;
    if (!split) return;
    if (enabled) {
      split.setMode('double_horizontal');
      setPlayerHidden(true);
      povPreview = split.previews[1] || null;
      if (povPreview) {
        if (povPreview.setNormalCamera) povPreview.setNormalCamera();
        if (povPreview.controls) povPreview.controls.enabled = false;
        povLabel = document.createElement('div');
        povLabel.className = 'pose_studio_pov_label';
        Object.assign(povLabel.style, {
          position: 'absolute', top: '8px', left: '50%', transform: 'translateX(-50%)', zIndex: 5,
          padding: '3px 10px', borderRadius: '4px', pointerEvents: 'none', whiteSpace: 'nowrap',
          background: 'rgba(0, 0, 0, 0.6)', color: '#fff', font: '600 12px sans-serif', letterSpacing: '0.02em',
        });
        povPreview.node.appendChild(povLabel);
      }
      applyPovAspect();
      if (!povTimer) povTimer = setInterval(updatePovViewport, 33);
    } else {
      if (povTimer) clearInterval(povTimer);
      povTimer = null;
      if (povLabel) povLabel.remove();
      povLabel = null;
      if (povPreview) {
        if (povPreview.controls) povPreview.controls.enabled = true;
        povPreview.aspect_ratio = undefined;
      }
      povPreview = null;
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

  function updatePovViewport() {
    if (!povPreview || !povPreview.camera || typeof Project === 'undefined' || !Project) return;
    const cam = activeCamera();
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

  function poseMessage(root) {
    const bones = {};
    for (const child of root.children) {
      if (child instanceof Group) bones[boneKey(child.name)] = child;
    }
    const angles = toBedrockRot(root.rotation);
    for (const bone of BONES) {
      const g = bones[bone.key.toLowerCase()];
      angles.push(...(g ? toBedrockRot(g.rotation) : [0, 0, 0]));
    }
    return JSON.stringify({ id: mannequinId(root.name), p: toWorld(root.origin), b: angles, s: root.pose_skin_slot || 0, sl: root.pose_slim ? 1 : 0, e: root.pose_equipment || {} });
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
    }

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
      autoAnchor();
    };
    if (!tickTimer) tickTimer = setInterval(tick, TICK_MS);
    const command = `/connect 127.0.0.1:${PORT}`;
    Blockbench.showMessageBox(
      {
        title: 'Pose Studio',
        message:
          `Listening on 127.0.0.1:${PORT}.\n\nIn Minecraft (cheats on), open chat and run:\n` +
          `${command}\n\nAn empty scene is centred on wherever you're standing in Minecraft.`,
        buttons: ['Copy Command', 'OK'],
        confirm: 0,
        cancel: 1,
      },
      (button) => {
        if (button === 0) copyText(command);
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
    const root = new Group({ name: `mq_${n}`, origin: origin.slice(), rotation: [0, yaw, 0] }).init();
    const cubes = [];
    for (const bone of BONES) {
      const group = new Group({ name: bone.key, origin: shift(bone.pivot) }).addTo(root).init();
      const cube = new Cube({ name: bone.key, from: shift(bone.from), to: shift(bone.to), color: bone.color })
        .addTo(group)
        .init();
      cubes.push(cube);
    }
    Undo.finishEdit('Add Pose Studio mannequin', { outliner: true, elements: cubes });
    Canvas.updateAll();
    root.select();
  }

  function setAnchor() {
    if (!requireConnection()) return;
    link
      .command('scriptevent pose:anchor')
      .then(resync)
      .catch(logFailure);
  }

  function setCameraSync(value) {
    cameraSync = value;
    lastCamera = null;
    if (!value && link.connected) send('scriptevent pose:camclear');
  }

  async function stopLink() {
    if (!link.server && !link.socket) return;
    // Give the player their model and camera back before the socket goes away.
    if (playerHidden && link.connected) await link.command('scriptevent pose:hideplayer {"hide":false}').catch(logFailure);
    if (cameraSync && link.connected) await link.command('scriptevent pose:camclear').catch(logFailure);
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    link.onConnect = null;
    link.stop();
    resync();
    if (cameraSync && cameraToggle) cameraToggle.set(false);
    Blockbench.showQuickMessage('Pose Studio: Minecraft link stopped', 2000);
  }

  // Shows what the plugin sees and what it last sent, to compare with /scriptevent pose:debug.
  function showDebug() {
    const lines = [
      `Link: ${link.server ? 'listening' : 'stopped'}, Minecraft ${link.connected ? 'connected' : 'not connected'}, ${link.inFlight} commands awaiting reply`,
      `Project: ${typeof Project !== 'undefined' && Project ? (Project.format && Project.format.id) || '?' : 'none'}`,
    ];
    const roots = mannequinRoots();
    if (!roots.length) lines.push('No top-level groups named mq_… found.');
    for (const root of roots) {
      const bones = root.children.filter((c) => c instanceof Group).map((g) => `${g.name} [${g.rotation.map((v) => round(v, 1)).join(', ')}]`);
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
  // names on a hidden scoreboard objective (`PSD[op|page|item]`). We request one page at a time
  // and read it back from the output of `scoreboard players list`.
  let transferRunning = false;

  function parseItems(text, op, page) {
    const items = [];
    const re = /PSD\[(\w+)\|(-?\d+)\|([^\]]*)\]/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[1] === op && Number(m[2]) === page) items.push(m[3]);
    }
    return items;
  }

  async function readPage(op, page) {
    for (let attempt = 0; attempt < 8; attempt++) {
      await link.command(`scriptevent pose:page ${JSON.stringify({ n: page })}`);
      await sleep(100 + attempt * 100); // give the script a tick or two to write the page
      const body = await link.command('scoreboard players list').catch((e) => ({ statusMessage: String(e.message || e) }));
      const items = parseItems(JSON.stringify(body), op, page);
      if (page === 0 ? items.some((i) => i.startsWith('M|')) : items.length) return items;
    }
    throw new Error(`Minecraft didn't return page ${page}. Is the Pose Studio behavior pack active in this world?`);
  }

  // Runs `/scriptevent <eventId>` and returns every item the script publishes for it.
  async function runGameQuery(eventId, payload, label) {
    if (transferRunning) throw new Error('Another Pose Studio transfer is still running.');
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
      const items = first.filter((i) => !i.startsWith('M|'));
      for (let n = 1; n < pages; n++) {
        items.push(...(await readPage(op, n)));
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
      lookThroughCamera(cam);
      Blockbench.showQuickMessage(`Pose Studio: saved ${cam.name}`, 2000);
    } catch (e) {
      showError('Pose Studio: grab camera failed', e);
    }
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
    Blockbench.showQuickMessage(`Pose Studio: saved ${cam.name}`, 2000);
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

  function scanWorldDialog() {
    if (!requireConnection()) return;
    new Dialog({
      id: 'pose_studio_scan',
      title: 'Scan World Around Player',
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
      items = await runGameQuery('pose:scan', { radius, rays, dist }, 'Scanning world');
    } catch (e) {
      showError('Pose Studio: scan failed', e);
      return;
    }
    const palette = [];
    const blocks = [];
    for (const item of items) {
      const parts = item.split('|');
      if (parts[0] === 'P') palette[Number(parts[1])] = parts[2];
      if (parts[0] === 'B') {
        for (const entry of parts[1].split(';')) blocks.push(entry.split('.').map(Number));
      }
    }
    await buildWorld(palette, blocks);
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
    const appdata = (typeof SystemInfo !== 'undefined' && SystemInfo.appdata_directory) || '';
    return [appdata, 'Minecraft Bedrock', 'Users', 'Shared', 'games', 'com.mojang', 'development_resource_packs', 'PoseStudio_RP', 'textures', 'entity', 'pose_studio'].join('\\');
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
    for (const group of mannequin.children) {
      if (!(group instanceof Group)) continue;
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
    for (const group of mannequin.children) {
      if (!(group instanceof Group)) continue;
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

  async function openSkinLibrary() {
    let slots;
    try {
      slots = await readLibrary();
    } catch (e) {
      showError('Pose Studio: skin library', e);
      return;
    }
    const mannequin = selectedMannequin();
    const dialog = new Dialog({
      id: 'pose_studio_skin_library',
      title: 'Skin Library',
      width: 780,
      buttons: ['Reload Minecraft Packs', 'Close'],
      cancelIndex: 1,
      component: {
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
      },
      onButton(index) {
        if (index === 0) reloadMinecraftPacks();
      },
    });
    dialog.show();
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

  const INDEXED_FOLDERS = /^(entity|models|render_controllers|animations|animation_controllers|textures|texts)\//;

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
          else if (!rel ? /^(entity|models|render_controllers|animations|animation_controllers|textures|texts)$/i.test(name) : true) walk(full, relPath);
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
        let name = id;
        try {
          name = String(fs.readFileSync(`${path}\\levelname.txt`, 'utf8')).trim() || id;
        } catch (e) {
          // no name file
        }
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
    for (const layer of layers) {
      for (const [path, file] of layer.files) {
        if (!path.endsWith('.json') && !path.endsWith('.lang')) continue;
        if (path.endsWith('.lang')) {
          if (!/texts\/en_us\.lang$/.test(path)) continue;
          for (const line of String(file.read()).split(/\r?\n/)) {
            const m = line.match(/^entity\.([^=]+)\.name=([^\t#]+)/);
            if (m) names.set(m[1].trim(), m[2].trim());
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
        }
      }
    }
    return { layers, rp, bp, entities, geometries, controllers, animations, animationControllers, names };
  }

  // Evaluates a render-controller condition for an idle entity: every query/variable is 0.
  // Anything too complex counts as "on".
  function idleCondition(expr) {
    if (typeof expr !== 'string') return true;
    const js = expr
      .toLowerCase()
      .replace(/\b(query|q|variable|v|temp|t|context|c)\.[a-z0-9_.]+(\s*\([^)]*\))?/g, '0');
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
    return `${SystemInfo.appdata_directory}\\Minecraft Bedrock`;
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
  function idleValue(expr, self = 0, vars = null) {
    if (typeof expr === 'number') return expr;
    if (typeof expr !== 'string') return 0;
    let js = expr.toLowerCase().trim();
    if (!js) return 0;
    if (/;|(^|[^=!<>])=(?!=)/.test(js)) return 0; // assignments / multiple statements
    js = js
      .replace(/\b(query|q|variable|v|temp|t|context|c)\.([a-z0-9_.]+)(\s*\([^()]*\))?/g, (m, kind, name) => {
        let value = 0;
        if (kind === 'query' || kind === 'q') value = IDLE_QUERIES[name] || 0;
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
  function channelAtStart(channel, self = [0, 0, 0], vars = null) {
    if (channel === undefined || channel === null) return null;
    if (typeof channel === 'object' && !Array.isArray(channel)) {
      const times = Object.keys(channel).filter((k) => !isNaN(parseFloat(k)));
      if (!times.length) return null;
      const first = channel[times.sort((a, b) => parseFloat(a) - parseFloat(b))[0]];
      return channelAtStart(first && typeof first === 'object' && !Array.isArray(first) ? first.post || first.pre || first.value : first, self, vars);
    }
    if (!Array.isArray(channel)) return [0, 1, 2].map((i) => idleValue(channel, self[i], vars));
    return [0, 1, 2].map((i) => idleValue(channel[i], self[i], vars));
  }

  // Variables the entity's initialize / pre_animation scripts set, evaluated for an idle mob
  // (e.g. the parrot's variable.state: standing).
  function idleVariables(description) {
    const scripts = description.scripts || {};
    const vars = {};
    for (const line of [].concat(scripts.initialize || [], scripts.pre_animation || [])) {
      for (const statement of String(line).split(';')) {
        const m = statement.match(/^\s*(?:variable|v)\.([a-z0-9_.]+)\s*=(?!=)\s*([\s\S]+?)\s*$/i);
        if (m) vars[m[1].toLowerCase()] = idleValue(m[2], 0, vars);
      }
    }
    return vars;
  }

  // The animations an idle entity plays: scripts.animate plus (older files) animation_controllers,
  // following controllers into their initial state.
  function idleAnimations(content, description) {
    const names = description.animations || {};
    const found = [];
    const vars = idleVariables(description);
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
        let next = transitions.find(([target, condition]) => controller.states[target] && !unknownVars(condition) && idleValue(condition, 0, vars) !== 0);
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
      if (condition !== true && !idleCondition(condition)) return;
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
    return found;
  }

  const MISSING_BIND_POSE = { 'geometry.polarbear': 'body', 'geometry.cat': 'body', 'geometry.ocelot.v1.8': 'body' };
  const CAT_TAILS = ['geometry.cat', 'geometry.ocelot.v1.8'];

  function restGeometry(content, entityId, geometryId) {
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
    const animations = idleAnimations(content, entity.description);
    for (const animation of animations) {
      for (const [name, channels] of Object.entries(animation.bones || {})) {
        const key = name.toLowerCase();
        if (!byName.has(key) || !channels) continue;
        const bone = byName.get(key);
        const ownRotation = bone.rotation ? bone.rotation.slice() : [0, 0, 0];
        const pivot = bone.pivot || [0, 0, 0];
        const r = channelAtStart(channels.rotation, ownRotation, animations.vars);
        const p = channelAtStart(channels.position, [pivot[0], pivot[1] - 24, pivot[2]], animations.vars);
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
            visible = condition === true || (condition !== false && idleCondition(condition));
          }
        }
      }
      return !visible;
    };
    for (const bone of geometry.bones) if (hidden(bone.name)) bone.cubes = [];
    return geometry;
  }

  function entityModel(content, entry) {
    const geometry = restGeometry(content, entry.id, entry.geometryId);
    return geometry ? bedrockToBlockbench(geometry) : null;
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
    const url = entityTextureUrl(content, entry);
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

  async function importEntity(content, entry) {
    if (typeof Project === 'undefined' || !Project) newProject(Formats.free);
    const model = entityModel(content, entry);
    if (!model) throw new Error(`No model found for ${entry.id}.`);
    const bones = posableBones(model);

    const short = entry.id.replace(/^[^:]+:/, '').replace(/[^a-z0-9_]/gi, '_');
    const used = Outliner.root.filter((n) => n instanceof Group && n.name.startsWith(`ent_${short}_`)).length;
    const name = `ent_${short}_${used + 1}`;
    const { origin: at, yaw } = placement();

    const textureName = `ent_${short}`;
    let texture = Texture.all.find((t) => t.name === textureName);
    const cubes = [];
    Undo.initEdit({ outliner: true, elements: [], textures: [] });
    if (!texture) {
      const url = entityTextureUrl(content, entry);
      if (url) {
        texture = new Texture({ name: textureName }).fromDataURL(url);
        texture.add(false);
        texture.uv_width = model.texture_width;
        texture.uv_height = model.texture_height;
      }
    }
    const shift = (v) => [v[0] + at[0], v[1] + at[1], v[2] + at[2]];
    const root = new Group({ name, origin: at.slice(), rotation: [0, yaw, 0] }).init();
    const rest = {};
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
    root.pose_entity = { entity: entry.id, key: entryKey(entry), bones, rest, source: entry.source };
    Undo.finishEdit('Add entity', { outliner: true, elements: cubes, textures: texture ? [texture] : [] });
    Canvas.updateAll();
    root.select();
    return { root };
  }

  // ---- The universal posable copy (generated into the development packs) ----
  // Minecraft only loads entity types when packs load, so instead of one generated entity per
  // model, one entity (pose:proxy) lists every model in the world: render-controller arrays pick
  // its geometry, texture and material from the pose:model property, and one animation per model
  // (gated on pose:model) maps that model's bones to the 30 packed-angle properties. It's rebuilt
  // only when the world's entity catalogue changes; then Minecraft needs one reload.
  const PROXY_TYPE = 'pose:proxy';
  const PROXY_REGISTRY = () => `${devPackDir('resource')}\\pose_studio_proxies.json`;

  const entryKey = (entry) => `${entry.id}|${entry.geometryId}|${entry.texturePath}`;

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

  function prepareProxy(content, list) {
    const models = list.map((entry) => {
      const geometry = restGeometry(content, entry.id, entry.geometryId);
      const model = geometry ? bedrockToBlockbench(geometry) : null;
      return { key: entryKey(entry), entry, geometry, bones: model ? posableBones(model) : [] };
    });
    const hash = hashString('v10|' + JSON.stringify(models.map((m) => [m.key, m.entry.material, m.bones, m.geometry && m.geometry.bones.length])));
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
    const geometries = [];
    models.forEach((m, i) => {
      const geometryId = `geometry.pose_studio.proxy.${i}`;
      geometries.push({
        description: { identifier: geometryId, texture_width: m.geometry.texture_width, texture_height: m.geometry.texture_height, visible_bounds_width: 8, visible_bounds_height: 8, visible_bounds_offset: [0, 2, 0] },
        bones: [
          { name: PROXY_ROOT_BONE, pivot: [0, 0, 0] },
          // legacy "neverRender" bones keep their place in the hierarchy but lose their cubes
          ...m.geometry.bones.map((b) => Object.assign({}, b, { parent: b.parent || PROXY_ROOT_BONE }, b.neverRender ? { cubes: [] } : {})),
        ],
      });
      description.geometry[`g${i}`] = geometryId;
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
      description.animations[`a${i}`] = `animation.pose_studio.proxy.${i}`;
      description.scripts.animate.push({ [`a${i}`]: `q.property('pose:model') == ${i}` });
      arrays.geos.push(`Geometry.g${i}`);
      arrays.skins.push(`Texture.t${i}`);
      arrays.mats.push(`Material.m${i}`);
      // angles 0-2: the whole model (pose_root); then 3 per posable bone
      const bones = { [PROXY_ROOT_BONE]: { rotation: [angleExpr(0), angleExpr(1), angleExpr(2)] } };
      m.bones.forEach((bone, k) => {
        const a = (k + 1) * 3;
        bones[bone] = { rotation: [angleExpr(a), angleExpr(a + 1), angleExpr(a + 2)] };
      });
      animations.animations[`animation.pose_studio.proxy.${i}`] = { loop: true, bones };
      registryModels[m.key] = { index: i, bones: m.bones, entity: m.entry.id, source: m.entry.source };
    });
    // Minecraft finds the hand bones for held items in the entity's "default" geometry, which the
    // arrays above never use. Point it at a humanoid model (the zombie's if there is one) so
    // humanoid copies draw what they hold.
    const hasHands = (m) => m.geometry && m.geometry.bones.some((b) => b.name === 'rightItem');
    const handModel = models.findIndex((m) => m.entry.id === 'minecraft:zombie' && hasHands(m));
    const fallback = models.findIndex(hasHands);
    const defaultIndex = handModel >= 0 ? handModel : fallback;
    if (defaultIndex >= 0) {
      description.geometry.default = description.geometry[`g${defaultIndex}`];
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
  function prepareForWorld(state) {
    const count = prepareProxy(state.content, state.list);
    if (!count) return;
    Blockbench.showMessageBox(
      {
        title: 'Pose Studio: entities prepared',
        message:
          `Pose Studio prepared all ${count} entities in this world for Minecraft. Minecraft needs to reload its packs once to load them. ` +
          "After that, adding any of these entities is instant.\n\nYou'll only be asked again when this world's packs change. Reload now?",
        buttons: ['Reload now', 'Later'],
        confirm: 0,
        cancel: 1,
      },
      (button) => button === 0 && reloadMinecraftPacks()
    );
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
              if (!browserWorlds.length || force) browserWorlds = listWorlds(bedrockFs(), bedrockRoot());
              this.worlds = browserWorlds.map((w, i) => ({ path: w.path, label: `${w.name}${i === 0 ? ' (last played)' : ''}` }));
              const world = browserWorlds.find((w) => w.path === this.worldPath) || browserWorlds[0] || null;
              browserState = await loadWorldContent(world, force);
              this.worldPath = world ? world.path : '';
              this.packs = browserState.content.rp.map((p) => ({ name: p.name, found: !!p.dir }));
              this.items = browserEntries(browserState.list);
              this.source = 'all';
              this.ready = true;
              try {
                prepareForWorld(browserState);
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
              const { root } = await importEntity(browserState.content, item);
              Blockbench.showQuickMessage(`Added ${item.name} as ${root.name}`, 1500);
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
    const state = contentCache || (await loadWorldContent(null));
    return state.content;
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
      const mannequinKey = key === 'hat' ? 'head' : key;
      return root.children.find((g) => g instanceof Group && boneKey(g.name) === mannequinKey) || null;
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

  // Rebuilds the eq_ preview cubes inside the mannequin's bone groups.
  let equipmentBuild = Promise.resolve();
  function refreshEquipmentPreview(mannequin) {
    equipmentBuild = equipmentBuild.then(() => buildEquipmentPreview(mannequin)).catch((e) => console.warn('[Pose Studio] equipment preview', e));
    return equipmentBuild;
  }

  async function buildEquipmentPreview(mannequin) {
    const old = [];
    mannequin.forEachChild((c) => c instanceof Cube && /^eq_/.test(c.name) && old.push(c));
    const equipment = mannequin.pose_equipment || {};
    const content = Object.values(equipment).some(Boolean) ? await previewContent() : null;
    Undo.initEdit({ outliner: true, elements: old, textures: [] });
    for (const cube of old) cube.remove();
    const [rx, ry, rz] = mannequin.origin;
    const shift = (v) => [v[0] + rx, v[1] + ry, v[2] + rz];
    const cubes = [];
    const textures = [];

    for (const piece of ARMOR_PIECES) {
      const material = ARMOR_MATERIALS.find((m) => armorItem(m, piece) === equipment[piece.slot]);
      if (!material || !content) continue;
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

  async function openEquipment() {
    const mannequin = selectedPoseRoot();
    if (!mannequin) {
      Blockbench.showQuickMessage('Select a mannequin (mq_) or entity (ent_) first', 2000);
      return;
    }
    const isEntity = ENTITY_PREFIX.test(mannequin.name);
    const canHold = !isEntity || !!boneGroupOf(mannequin, 'rightItem') || !!boneGroupOf(mannequin, 'leftItem');
    const canWear = !isEntity || ['head', 'body', 'rightArm', 'rightLeg'].every((b) => boneGroupOf(mannequin, b));
    let content;
    try {
      content = await previewContent();
    } catch (e) {
      showError('Pose Studio: equipment', e);
      return;
    }
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
    const armorValue = (piece) => {
      const m = ARMOR_MATERIALS.find((mat) => armorItem(mat, piece) === eq[piece.slot]);
      return m ? m.item : '';
    };
    new Dialog({
      id: 'pose_studio_equipment',
      title: `Equipment: ${mannequin.name}`,
      width: 640,
      buttons: ['Done'],
      component: {
        data: () => ({
          pieces: ARMOR_PIECES.map((p) => ({ slot: p.slot, label: p.label, value: armorValue(p), options: ARMOR_MATERIALS.filter((m) => !m.only || m.only === p.slot) })),
          items,
          hand: 'mainhand',
          mainhand: eq.mainhand || '',
          offhand: eq.offhand || '',
          custom: '',
          canHold,
          canWear,
        }),
        methods: {
          setArmor(p) {
            const piece = ARMOR_PIECES.find((x) => x.slot === p.slot);
            const material = ARMOR_MATERIALS.find((m) => m.item === p.value);
            setEquipment(mannequin, p.slot, material ? armorItem(material, piece) : '');
          },
          pick(id) {
            const value = id ? `minecraft:${shortItem(id)}` : '';
            this[this.hand] = value;
            setEquipment(mannequin, this.hand, value);
          },
          setCustom() {
            const id = this.custom.trim();
            if (!id) return;
            const value = id.includes(':') ? id : `minecraft:${id}`;
            this[this.hand] = value;
            setEquipment(mannequin, this.hand, value);
          },
          picked(id) {
            return shortItem(this.hand === 'mainhand' ? this.mainhand : this.offhand) === id;
          },
          label(id) {
            const known = this.items.find((i) => i.id === shortItem(id));
            return id ? (known ? known.name : id) : 'nothing';
          },
        },
        template: `
          <div class="pose_studio_equipment">
            <p v-if="!canHold || !canWear" style="margin: 0 0 10px; color: var(--color-warning, #e8a33d);">
              This model {{ !canHold && !canWear ? "has no hand bones or humanoid body bones, so Minecraft probably won't show items or armour on it" : !canHold ? "has no hand bones (rightItem / leftItem), so Minecraft probably won't show held items" : "doesn't have humanoid body bones, so armour probably won't fit" }}.
            </p>
            <h3 style="margin: 0 0 6px;">Armour</h3>
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px;">
              <label v-for="p in pieces" :key="p.slot" style="display: flex; flex-direction: column; gap: 4px;">
                <span>{{ p.label }}</span>
                <select v-model="p.value" @change="setArmor(p)">
                  <option value="">None</option>
                  <option v-for="m in p.options" :value="m.item">{{ m.name }}</option>
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
            <div style="display: flex; gap: 6px; align-items: center;">
              <span>Any item id:</span>
              <input type="text" v-model="custom" placeholder="e.g. minecraft:torch or mypack:magic_staff" class="dark_bordered" style="flex: 1;" @keydown.enter="setCustom()">
              <button @click="setCustom()">Give</button>
            </div>
            <p style="opacity: 0.7; margin-top: 8px;">Minecraft shows the real items. The Blockbench preview shows armour and a flat icon for held items.</p>
          </div>`,
      },
    }).show();
  }

  // ---- Plugin registration -------------------------------------------------------------------
  // Everything lives in one "Pose Studio" menu next to Tools; rarely used items sit under More.
  let actions = [];
  let menu = null;
  let linkToggle = null;
  let cameraToggle = null;
  let povToggle = null;
  let heldToggle = null;
  let fovProperty = null;
  let skinProperties = [];
  let pickTimer = null;

  function onLinkToggle(on) {
    if (!on) return stopLink();
    if (!startLink()) setTimeout(() => linkToggle && linkToggle.set(false), 0);
  }

  // ---- Updates and changelog -----------------------------------------------------------------
  // Shared through a GitHub repository: people load blockbench/pose_studio.js from its raw URL
  // (File > Plugins > Load Plugin from URL), and Blockbench downloads it again on every start.
  // The Minecraft packs are copied into the development pack folders from the same repository.
  // CHANGELOG is written by release.js from changelog.json; don't edit it by hand.
  // <changelog>
  const CHANGELOG = [
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

  // After an update, lists what changed since the version this person last used.
  function showWhatsNewOnce() {
    let seen = null;
    try {
      seen = localStorage.getItem('pose_studio_seen_version');
      localStorage.setItem('pose_studio_seen_version', PLUGIN_VERSION);
    } catch (e) {
      return;
    }
    if (!seen || compareVersions(PLUGIN_VERSION, seen) <= 0) return;
    const entries = CHANGELOG.filter((e) => compareVersions(e.version, seen) > 0);
    if (entries.length) showChangelog(`Pose Studio updated to ${PLUGIN_VERSION}`, entries);
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
      skinProperties = [
        new Property(Group, 'object', 'pose_entity'),
        new Property(Group, 'object', 'pose_equipment'),
        new Property(Group, 'number', 'pose_skin_slot', { default: 0 }),
        new Property(Group, 'boolean', 'pose_slim', { default: false }),
      ];
      pickTimer = setInterval(disableWorldPicking, 1000);

      const a = {
        link: (linkToggle = new Toggle('pose_studio_link', {
          name: 'Connect to Minecraft', icon: 'cable', value: false, onChange: onLinkToggle,
          description: 'Listens for Minecraft on 127.0.0.1:19131 (run /connect 127.0.0.1:19131 in game).',
        })),
        add: new Action('pose_studio_add', { name: 'Add Mannequin', icon: 'accessibility_new', click: addMannequin }),
        entity: new Action('pose_studio_entity', {
          name: 'Add Entity…', icon: 'pets', click: openEntityBrowser,
          description: "Every entity in the world you're in (Minecraft's and your packs'), with thumbnails.",
        }),
        equipment: new Action('pose_studio_equipment', {
          name: 'Equipment…', icon: 'shield', click: openEquipment,
          description: 'Armour and held items for the selected mannequin.',
        }),
        skin: new Action('pose_studio_skin', {
          name: 'Skin Library…', icon: 'checkroom', click: openSkinLibrary,
          description: 'Add skins once, then dress the selected mannequin instantly.',
        }),
        grabcam: new Action('pose_studio_grabcam', {
          name: 'From Minecraft View', icon: 'add_a_photo', click: grabCameraFromPlayer,
          description: 'Saves your current in-game view as a cam_ group.',
        }),
        savecam: new Action('pose_studio_savecam', { name: 'From Blockbench View', icon: 'switch_video', click: saveViewportAsCamera }),
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
        scan: new Action('pose_studio_scan', { name: 'Scan World…', icon: 'travel_explore', click: scanWorldDialog }),
        capture: new Action('pose_studio_capture', { name: 'Capture Screenshot', icon: 'photo_camera', click: capture }),
        anchor: new Action('pose_studio_anchor', {
          name: 'Recenter Scene on Me', icon: 'my_location', click: setAnchor,
          description: "Moves the whole scene in Minecraft so Blockbench's origin is where you're standing.",
        }),
        lookcam: new Action('pose_studio_lookcam', { name: 'Look Through Camera', icon: 'visibility', click: () => lookThroughCamera() }),
        follow: new Action('pose_studio_follow_viewport', { name: 'Follow Viewport (No Active Camera)', icon: '3d_rotation', click: followViewport }),
        clear: new Action('pose_studio_clear', { name: 'Remove Mannequins from World', icon: 'delete_sweep', click: clearWorld }),
        reloadpacks: new Action('pose_studio_reload_packs', {
          name: 'Reload Minecraft Packs', icon: 'refresh', click: reloadMinecraftPacks,
          description: 'Runs /reload all so Minecraft loads new skin images (the world briefly closes and reopens).',
        }),
        held: (heldToggle = new Toggle('pose_studio_entity_held_items', {
          name: 'Held Items on Entities', icon: 'back_hand', value: entityHeldItems,
          description: 'Shows held items on entity copies in Minecraft using invisible mannequins. Turn off if Minecraft disconnects.',
          onChange: (value) => {
            entityHeldItems = value;
            try {
              localStorage.setItem('pose_studio_entity_held_items', value ? 'on' : 'off');
            } catch (e) {
              // storage unavailable
            }
          },
        })),
        debug: new Action('pose_studio_debug', { name: 'Debug Info', icon: 'bug_report', click: showDebug }),
        updates: new Action('pose_studio_updates', {
          name: 'Check for Updates', icon: 'update', click: () => checkForUpdates(true),
          description: 'Updates this plugin and installs or updates the Pose Studio Minecraft packs.',
        }),
        changelog: new Action('pose_studio_changelog', { name: "What's New", icon: 'new_releases', click: () => showChangelog('Pose Studio changelog', CHANGELOG) }),
      };
      actions = Object.values(a);

      menu = new BarMenu('pose_studio', [
        a.link,
        '_',
        a.add,
        a.entity,
        a.skin,
        a.equipment,
        { name: 'Add Camera', id: 'pose_studio_add_camera', icon: 'videocam', children: [a.grabcam, a.savecam] },
        a.fov,
        '_',
        a.pov,
        { name: 'Camera Aspect Ratio', id: 'pose_studio_aspect', icon: 'aspect_ratio', children: aspectMenuItems },
        a.camera,
        '_',
        a.scan,
        a.capture,
        '_',
        { name: 'More', id: 'pose_studio_more', icon: 'more_horiz', children: [a.anchor, a.lookcam, a.follow, '_', a.held, a.reloadpacks, a.clear, '_', a.updates, a.changelog, a.debug] },
      ], { name: 'Pose Studio' });
      MenuBar.addMenu(menu, 'tools');
      startupTimer = setTimeout(() => {
        startupTimer = null;
        showWhatsNewOnce();
        checkForUpdates(false).catch(() => {});
      }, 4000);
    },

    onunload() {
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
      linkToggle = cameraToggle = povToggle = heldToggle = null;
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
      if (fovProperty) fovProperty.delete();
      fovProperty = null;
    },
  });
})();
