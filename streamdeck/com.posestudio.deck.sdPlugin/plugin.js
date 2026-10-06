// Pose Studio for Stream Deck — the plugin half.
// Stream Deck runs this page and talks to it over a websocket (which keys exist, which was pressed).
// Pose Studio (the Blockbench plugin) answers on 127.0.0.1:19132 once "Stream Deck Link" is on:
// GET /state says what's open and switched on, GET /run?id=… does something.
const POSE_STUDIO = 'http://127.0.0.1:19132';
const PREFIX = 'com.posestudio.deck.';
const TOGGLES = {
  sync: { id: 'pose_studio_camera', name: 'Sync', art: ['sync', 'sync'] },
  pov: { id: 'pose_studio_pov', name: 'POV', art: ['eye', 'eye'] },
  link: { id: 'pose_studio_link', name: 'Minecraft', art: ['bars_off', 'bars'] },
};

// The sprite (see art.js) for an action of the Pose Studio menu.
const ACTION_ART = [
  [/player_view/, 'face'],
  [/cam_anim_stop/, 'barrier'],
  [/cam_anim/, 'film'],
  [/light/, 'lamp_on'],
  [/struct_undo/, 'sync'],
  [/struct/, 'structure'],
  [/capture_entities|entity_shot$/, 'face'],
  [/capture/, 'capture'],
  [/compare/, 'compare'],
  [/drop/, 'drop'],
  [/entity_shot_options|fov|aspect/, 'lever'],
  [/grabcam|savecam|add_camera|lookcam|follow_viewport/, 'camera'],
  [/pov_grid|grid/, 'grid'],
  [/pov/, 'eye'],
  [/link$/, 'bars'],
  [/camera$/, 'sync'],
  [/variant|entit/, 'creeper'],
  [/outfit|equipment|skin/, 'armour'],
  [/animation/, 'film'],
  [/ride/, 'saddle'],
  [/scan/, 'grass'],
  [/time|clock/, 'clock'],
  [/clear|unlink/, 'barrier'],
  [/anchor/, 'target'],
  [/reload|update|realign|refresh|install/, 'sync'],
  [/folder|world|location|scene/, 'chest'],
  [/add$/, 'plus'],
];
function actionArt(id) {
  const found = ACTION_ART.find(([pattern]) => pattern.test(String(id || '')));
  return found ? found[1] : 'command';
}

// The time of day a Time & Weather key sets, as one of the sprites.
function timeArt(s) {
  if (!s.time) return '';
  if (s.time !== 'custom') return s.time === 'midnight' ? 'night' : s.time;
  const t = (((Number(s.ticks) || 0) % 24000) + 24000) % 24000;
  if (t >= 22500 || t < 500) return 'sunrise';
  if (t < 4500) return 'day';
  if (t < 7500) return 'noon';
  if (t < 11500) return 'day';
  if (t < 13000) return 'sunset';
  return 'night';
}
const TIMES = { sunrise: 23000, day: 1000, noon: 6000, sunset: 12000, night: 13000, midnight: 18000 };

let deck = null; // the websocket to Stream Deck
const keys = new Map(); // context -> { action, settings, shown: { title, state } }
let state = null; // Pose Studio's last answer to /state, or null while it can't be reached

function send(event, context, payload) {
  if (deck && deck.readyState === 1) deck.send(JSON.stringify(Object.assign({ event, context }, payload ? { payload } : {})));
}

async function ask(path) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), 1500);
  try {
    const response = await fetch(POSE_STUDIO + path, { signal: control.signal, cache: 'no-store' });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// What a key should show for the state Pose Studio is in.
function look(key) {
  const kind = key.action.slice(PREFIX.length);
  const s = key.settings || {};
  if (kind === 'camera') {
    const mode = s.mode || 'next';
    if (mode === 'number') {
      const n = Math.max(1, Number(s.number) || 1);
      const name = state && state.cameras[n - 1];
      const active = !!(state && name && state.camera === name);
      return { title: name || `cam ${n}`, state: active ? 1 : 0, art: ['camera', active ? 'grass' : 'stone'] };
    }
    return { title: (state && state.camera) || '', state: 0, art: [mode === 'prev' ? 'prev' : 'next', 'stone'] };
  }
  if (kind === 'toggle') {
    const which = TOGGLES[s.which] ? s.which : 'sync';
    const on = !!(state && state[which]);
    return { title: TOGGLES[which].name, state: on ? 1 : 0, art: [TOGGLES[which].art[on ? 1 : 0], on ? 'grass' : 'stone'] };
  }
  if (kind === 'env') {
    const parts = [];
    if (s.time) parts.push(s.time === 'custom' ? `${Number(s.ticks) || 0}` : s.time);
    if (s.weather) parts.push(s.weather);
    // the weather's sprite if it sets one (rain, thunder), on a button the colour of the time of day
    const time = timeArt(s);
    const wet = s.weather === 'rain' || s.weather === 'thunder';
    const sprite = wet ? s.weather : time || (s.weather === 'clear' ? 'day' : 'sun_cloud');
    const button = time === 'night' ? 'night' : time === 'sunrise' || time === 'sunset' ? 'dusk' : wet ? 'storm' : 'sky';
    return { title: parts.join('\n'), state: 0, art: [sprite, button] };
  }
  if (kind === 'run') return { title: s.label || '', state: 0, art: [actionArt(s.id), 'stone'] };
  if (kind === 'entities') return { title: '', state: 0, art: ['face', 'stone'] };
  if (kind === 'focus') return s.window === 'minecraft' ? { title: 'Minecraft', state: 0, art: ['grass', 'grass'] } : { title: 'Blockbench', state: 0, art: ['bench', 'stone'] };
  return { title: '', state: 0, art: ['capture', 'stone'] };
}

function refresh(key, context) {
  const next = look(key);
  if (!key.shown || key.shown.title !== next.title) send('setTitle', context, { title: next.title, target: 0 });
  if (!key.shown || key.shown.state !== next.state) send('setState', context, { state: next.state });
  if (!key.shown || key.shown.art.join() !== next.art.join()) send('setImage', context, { image: keyImage(next.art[0], next.art[1]), target: 0 });
  key.shown = next;
}

function refreshAll() {
  for (const [context, key] of keys) refresh(key, context);
}

async function poll() {
  try {
    const answer = await ask('/state');
    state = answer && answer.app === 'pose-studio' ? answer : null;
  } catch (e) {
    state = null;
  }
  refreshAll();
}

// The requests a key press makes.
function requests(key) {
  const kind = key.action.slice(PREFIX.length);
  const s = key.settings || {};
  if (kind === 'capture') return ['/run?id=pose_studio_capture'];
  if (kind === 'entities') return ['/run?id=pose_studio_capture_entities'];
  if (kind === 'camera') {
    const mode = s.mode || 'next';
    return [`/run?id=camera&value=${mode === 'number' ? Math.max(1, Number(s.number) || 1) : mode}`];
  }
  if (kind === 'toggle') return [`/run?id=${TOGGLES[TOGGLES[s.which] ? s.which : 'sync'].id}`];
  if (kind === 'env') {
    const list = [];
    if (s.time) list.push(`/run?id=time&value=${s.time === 'custom' ? Number(s.ticks) || 0 : TIMES[s.time]}`);
    if (s.weather) list.push(`/run?id=weather&value=${encodeURIComponent(s.weather)}`);
    return list;
  }
  if (kind === 'focus') return [`/run?id=focus&value=${s.window === 'minecraft' ? 'minecraft' : 'blockbench'}`];
  if (kind === 'run') return s.id ? [`/run?id=${encodeURIComponent(s.id)}`] : [];
  return [];
}

async function press(context) {
  const key = keys.get(context);
  if (!key) return;
  const list = requests(key);
  if (!list.length) return send('showAlert', context);
  try {
    let last = null;
    for (const path of list) {
      last = await ask(path);
      if (!last || !last.ok) throw new Error((last && last.message) || 'refused');
    }
    if (last && last.state) state = Object.assign({ app: 'pose-studio' }, last.state);
    key.shown = null; // Stream Deck may have flipped the key itself: show it again
    refreshAll();
    send('showOk', context);
  } catch (e) {
    key.shown = null;
    refresh(key, context);
    send('showAlert', context);
    send('logMessage', undefined, { message: `Pose Studio: ${e.message || e}` });
  }
}

function handle(message) {
  const { event, context, action, payload } = message;
  if (event === 'willAppear') {
    keys.set(context, { action, settings: (payload && payload.settings) || {}, shown: null });
    refresh(keys.get(context), context);
  } else if (event === 'willDisappear') {
    keys.delete(context);
  } else if (event === 'didReceiveSettings') {
    const key = keys.get(context);
    if (key) {
      key.settings = (payload && payload.settings) || {};
      refresh(key, context);
    }
  } else if (event === 'keyUp') {
    press(context);
  }
}

// Stream Deck calls this when it loads the page.
// eslint-disable-next-line no-unused-vars
function connectElgatoStreamDeckSocket(port, uuid, registerEvent) {
  deck = new WebSocket(`ws://127.0.0.1:${port}`);
  deck.onopen = () => {
    deck.send(JSON.stringify({ event: registerEvent, uuid }));
    poll();
    setInterval(poll, 1000);
  };
  deck.onmessage = (e) => handle(JSON.parse(e.data));
}
