const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { createSyncServer, validateState } = require('../server');
const caps = ['melody-v1', 'song-v2', 'song-boundary-v1', 'logical-beats-v1'];
const marker = 'PRIVATE_CAPTURE_SENTINEL';
const sound = () => ({ sound: 'Synth Kick', settings: {} });
const track = () => ({ name: 'Recording: arbitrary public track label', muted: false, solo: false, volume: 1,
  mainBeatSound: sound(), subdivisionSound: sound(), barSettings: [{ beats: 4, subdivision: 1, rests: [] }] });
const score = () => ({ version: 1, bars: [[{ id: 'n1', midi: 60, startTick: 0, durationTicks: 960, velocity: 1 }]] });
const state = () => ({ tempo: 120, volume: 1, Tracks: [{ ...track(), currentBar: 0, currentBeat: 0, melody: score() }], selectedTrackIndex: 0, selectedBarIndexInContainer: 0 });
const song = () => ({ version: 2, enabled: false, name: 'Public', sections: [{ name: 'A', startBar: 0, tempo: 120, repeats: 1, tracks: [{ ...track(), melody: score() }] }] });
async function fixture(t) {
  const logs = [], peers = [], server = createSyncServer({ port: 0, logger: { log: (...a) => logs.push(a), warn: (...a) => logs.push(a) } });
  await new Promise(r => server.wss.once('listening', r));
  t.after(async () => { for (const p of peers) p.ws.terminate(); await server.close(); });
  const credential = crypto.randomBytes(32).toString('hex');
  const roomId = 'privacy_' + crypto.createHash('sha256').update(credential).digest('hex').slice(0, 32);
  async function connect(host = false) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.wss.address().port}`), messages = [], wire = [];
    ws.on('message', raw => { wire.push(raw.toString()); messages.push(JSON.parse(raw)); });
    const p = { ws, messages, wire, send: m => ws.send(JSON.stringify(m)), async next(type) {
      const end = Date.now() + 2000;
      while (Date.now() < end) { const i = messages.findIndex(m => m.type === type); if (i >= 0) return messages.splice(i, 1)[0]; await new Promise(r => setTimeout(r, 3)); }
      throw Error(`Missing ${type}: ${messages.map(m => m.type)}`);
    }, async settle() { this.send({ type: 'time-sync', t0: Date.now() }); await this.next('time-sync-response'); } };
    peers.push(p); await new Promise(r => ws.once('open', r));
    p.send({ type: 'join', room: roomId, requestedRole: host ? 'host' : 'client', ...(host ? { hostCredential: credential } : {}), capabilities: caps });
    await p.next('joined'); return p;
  }
  const host = await connect(true), a = await connect(), b = await connect();
  return { server, room: server.rooms.get(roomId), host, a, b, connect, peers, logs };
}
async function publish(f, p) {
  f.host.send({ type: 'state', payload: p }); f.host.send({ type: 'state-request' });
  assert.deepEqual((await f.host.next('state')).payload, p);
  for (const peer of [f.a, f.b]) assert.deepEqual((await peer.next('state')).payload, p);
}

test('root recursive recording data is rejected, never accepted and forwarded', async t => {
  const f = await fixture(t), baseline = state(); await publish(f, baseline);
  const before = f.room.state, revision = f.room.revision, bad = state();
  bad.Tracks[0].recordings = [{ name: marker }];
  f.host.send({ type: 'state', payload: bad });
  for (const p of f.peers) await p.settle();
  const leaked = f.peers.flatMap(p => p.wire).some(raw => raw.includes(marker));
  assert.equal(leaked, false, 'private sentinel accepted and forwarded over real loopback');
  assert.equal((await f.host.next('error')).code, 'invalid-state');
  assert.equal(f.room.state, before); assert.equal(f.room.revision, revision);
});

const trackMutations = [
  ['recordings', tr => { tr.recordings = [{ name: marker }]; }],
  ['bar capture', tr => { tr.barSettings[0].captureData = { raw: [marker] }; }],
  ['muted object', tr => { tr.muted = { captureData: marker }; }],
  ['rests object', tr => { tr.barSettings[0].rests = [{ raw: marker }]; }],
  ['sound capture settings', tr => { tr.mainBeatSound.settings.captureData = marker; }],
  ['sound object metadata', tr => { tr.subdivisionSound.captureData = [marker]; }],
  ['recording name', tr => { tr.mainBeatSound.sound = 'Recording:' + marker; }],
  ['unprefixed asset', tr => { tr.subdivisionSound.sound = marker; }],
  ['beat sound metadata', tr => { tr.barSettings[0].beatSounds = { 0: { mainBeatSound: { ...sound(), captureData: marker } } }; }],
  ['beat private asset', tr => { tr.barSettings[0].beatSounds = { 0: { subdivisionSound: { sound: marker, settings: {} } } }; }],
  ['velocity object', tr => { tr.barSettings[0].velocities = { 0: { raw: marker } }; }],
  ['slice object', tr => { tr.barSettings[0].beatSlices = { 0: { raw: marker } }; }],
];

test('melody presence types every root and disabled section, including rhythm siblings', async t => {
  const f = await fixture(t), baseline = state(); baseline.song = song();
  baseline.Tracks.push({ ...track(), currentBar: 0, currentBeat: 0 });
  baseline.song.sections[0].tracks.push(track());
  await publish(f, baseline);
  const before = f.room.state, revision = f.room.revision;
  for (const where of ['root', 'root sibling', 'section', 'section sibling']) {
    for (const [name, mutate] of trackMutations) {
      const bad = structuredClone(baseline);
      const tr = where.startsWith('root') ? bad.Tracks[where.endsWith('sibling') ? 1 : 0] : bad.song.sections[0].tracks[where.endsWith('sibling') ? 1 : 0];
      mutate(tr); assert.equal(validateState(bad), false, `${where}: ${name}`);
      f.host.send({ type: 'state', payload: bad });
      assert.equal((await f.host.next('error')).code, 'invalid-state', `${where}: ${name}`);
    }
  }
  for (const p of f.peers) { await p.settle(); assert.equal(p.wire.some(raw => raw.includes(marker)), false); }
  assert.equal(f.room.state, before); assert.equal(f.room.revision, revision);
  const late = await f.connect(); assert.deepEqual((await late.next('state')).payload, baseline);
});

function queue(f, nextSong, delay = 30000) {
  f.host.send({ type: 'song-change-command', change: { version: 1, song: nextSong, sectionIndex: 0, startBar: 0, effectiveAt: Date.now() + delay } });
}
async function start(f, payload) {
  await publish(f, payload);
  f.host.send({ type: 'transport-command', playing: true, currentBar: 0, currentBeat: 0 });
  for (const p of f.peers) await p.next('transport');
}

test('queued snapshots reject recursive metadata and local aliases without replacing a valid queue', async t => {
  const f = await fixture(t), baseline = state();
  baseline.customSounds = { PublicAlias: { baseSound: 'Synth Sine', settings: { frequency: 440 } } };
  await start(f, baseline); queue(f, song());
  for (const p of f.peers) await p.next('song-change');
  const before = { state: f.room.state, revision: f.room.revision, pendingSongChange: f.room.pendingSongChange, songChangeTimer: f.room.songChangeTimer, transport: f.room.transport, host: f.room.host };
  for (const [name, mutate] of trackMutations) {
    const next = song(); mutate(next.sections[0].tracks[0]); queue(f, next);
    assert.equal((await f.host.next('error')).code, 'invalid-song-change', name);
    for (const key of Object.keys(before)) assert.equal(f.room[key], before[key], key);
  }
  const unknown = song(); unknown.sections[0].captureData = { recordings: [marker] }; queue(f, unknown);
  assert.equal((await f.host.next('error')).code, 'invalid-song-change');
  for (const p of f.peers) { await p.settle(); assert.equal(p.wire.some(raw => raw.includes(marker)), false); }
  const late = await f.connect(); assert.deepEqual((await late.next('song-change')).song, song());
  assert.equal(JSON.stringify(f.logs).includes(marker), false);
});

test('queued melody promotion revalidates legacy root metadata and nested shared custom aliases', async t => {
  for (const mutate of [p => { p.extra = { recordings: [marker] }; }, p => {
    p.customSounds = { Alias: { baseSound: 'Nested', settings: {} }, Nested: { baseSound: marker, settings: {} } };
  }]) {
    const f = await fixture(t), rhythm = state(); delete rhythm.Tracks[0].melody; mutate(rhythm);
    await start(f, rhythm); // Deliberate historical rhythm-only compatibility.
    for (const p of f.peers) p.wire.length = 0;
    const before = f.room.state, revision = f.room.revision;
    queue(f, song()); assert.equal((await f.host.next('error')).code, 'invalid-song-change');
    for (const p of f.peers) { await p.settle(); assert.equal(p.wire.some(raw => raw.includes(marker)), false); }
    assert.equal(f.room.state, before); assert.equal(f.room.revision, revision); assert.equal(f.room.pendingSongChange, undefined);
  }
});

test('public synthesis/sample aliases, labels, standard live fields and queued replay survive unchanged', async t => {
  const f = await fixture(t), p = state();
  Object.assign(p, { controlsAttachedToTrack: true, isPlaying: false, isRestMode: false, isAccentMode: false, isSliceMode: false, isRecording: false });
  p.customSounds = { 'My public tone': { baseSound: 'Synth Sine', settings: { frequency: 440, reverse: false } }, Alias: { baseSound: 'My public tone', settings: {} } };
  Object.assign(p.Tracks[0], { nextBeatTime: 1.25, songRepeatIteration: 0, pitchShift: -3, swing: 25 });
  p.Tracks[0].mainBeatSound.sound = 'Alias'; p.Tracks[0].subdivisionSound.sound = 'Click1.mp3';
  p.Tracks[0].barSettings[0].beatSounds = { 0: { mainBeatSound: { sound: 'Alias', settings: {} } } };
  assert.equal(validateState(p), true); await start(f, p);
  const next = song(); next.sections[0].tracks[0].mainBeatSound.sound = 'Alias';
  queue(f, next, 300);
  for (const peer of f.peers) assert.deepEqual((await peer.next('song-change')).song, next);
  const late = await f.connect(); assert.deepEqual((await late.next('song-change')).song, next);
  assert.deepEqual((await late.next('state')).payload, p);
  await new Promise(r => setTimeout(r, 400));
  for (const peer of f.peers) { peer.send({ type: 'state-request' }); assert.deepEqual((await peer.next('state')).payload, { ...p, song: next }); }
});

test('melody rejects unknown envelope fields, invalid flags, alias cycles and container caps without mutation', () => {
  for (const mutate of [
    p => { p.audioLatencyOffset = 0; }, p => { p.selectedTheme = 'dark'; }, p => { p.isRecording = { captureData: marker }; },
    p => { p.customSounds = []; }, p => { p.customSounds = { A: { baseSound: 'B', settings: {} }, B: { baseSound: 'A', settings: {} } }; },
    p => { p.customSounds = { A: { baseSound: 'Synth Kick', settings: { frequency: { raw: marker } } } }; },
    p => { p.customSounds = Object.fromEntries(Array.from({ length: 65 }, (_, i) => ['a' + i, { baseSound: 'Synth Kick', settings: {} }])); },
    p => { p.Tracks[0].nextBeatTime = -1; }, p => { p.Tracks[0].songRepeatIteration = 16; },
  ]) { const p = state(); mutate(p); const before = structuredClone(p); assert.equal(validateState(p), false); assert.deepEqual(p, before); }
});

// Exercise the current frontend's real serializer and validators, not copied state.
async function frontendStates(t) {
  const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
  const root = path.resolve(__dirname, '../../Metronominal_Upgrades');
  const { chromium } = require(path.join(root, 'node_modules/@playwright/test'));
  const web = http.createServer((req, res) => {
    if (req.url === '/') { res.end('<!doctype html><title>offline schema fixture</title>'); return; }
    const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (path.relative(root, file).startsWith('..')) { res.writeHead(403).end(); return; }
    try { res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain'); res.end(fs.readFileSync(file)); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(r => web.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => web.close(r)));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(), origin = `http://127.0.0.1:${web.address().port}`;
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.goto(origin);
  return page.evaluate(async () => {
    const app = (await import('/js/appState.js')).default;
    const baseline = await app.getCurrentStateForPreset(true);
    app.getTracks()[0].melody = { version: 1, bars: [[{ id: 'actual-note', midi: 60, startTick: 0, durationTicks: 960, velocity: 0 }]] };
    const zero = await app.getCurrentStateForPreset(true);
    const sectionTrack = structuredClone(zero.Tracks[0]);
    for (const key of ['currentBar', 'currentBeat', 'nextBeatTime', 'songRepeatIteration']) delete sectionTrack[key];
    delete app.getTracks()[0].melody;
    app.setSong({ version: 2, enabled: false, name: 'Actual public song', sections: [{ name: 'A', startBar: 0, tempo: 120, repeats: 1, tracks: [sectionTrack] }] });
    const section = await app.getCurrentStateForPreset(true);
    return { baseline, zero, section, valid: [baseline, zero, section].map(p => app.validateNetworkState(p)) };
  });
}

for (const location of ['extra', 'isRecording', 'nextBeatTime', 'songRepeatIteration']) {
  test(`pending melody rejects rhythm refresh ${location} before any wire or state mutation`, async t => {
    const actual = await frontendStates(t), f = await fixture(t), baseline = actual.baseline;
    await start(f, baseline); const next = actual.section.song; queue(f, next, 1500);
    for (const p of f.peers) await p.next('song-change');
    const before = Object.fromEntries(['state', 'revision', 'pendingSongChange', 'songChangeTimer', 'transport', 'host'].map(k => [k, f.room[k]]));
    const bad = structuredClone(baseline);
    if (location === 'extra' || location === 'isRecording') bad[location] = { recordings: [marker] };
    else bad.Tracks[0][location] = { recordings: [marker] };
    f.host.send({ type: 'state', payload: bad });
    for (const p of f.peers) await p.settle();
    assert.equal(f.peers.some(p => p.wire.some(raw => raw.includes(marker))), false, 'refresh leaked private sentinel');
    assert.equal((await f.host.next('error')).code, 'invalid-state');
    for (const key of Object.keys(before)) assert.equal(f.room[key], before[key], key);
    const late = await f.connect(); assert.deepEqual((await late.next('state')).payload, baseline);
    assert.deepEqual((await late.next('song-change')).song, next);
    await new Promise(r => setTimeout(r, Math.max(0, before.pendingSongChange.effectiveAt - Date.now()) + 30));
    assert.equal(validateState(f.room.state.payload), true);
    for (const p of f.peers) {
      p.send({ type: 'state-request' }); assert.deepEqual((await p.next('state')).payload, { ...baseline, song: next });
      p.send({ type: 'state-recovery-request', revision: 0, reason: 'invalid-state-payload' });
      assert.deepEqual((await p.next('state')).payload, { ...baseline, song: next });
      assert.equal(p.wire.some(raw => raw.includes(marker)), false);
    }
    assert.equal(JSON.stringify(f.logs).includes(marker), false);
  });
}

test('timer fails closed if queued melody becomes unsafe after admission', async t => {
  const f = await fixture(t), baseline = state(); delete baseline.Tracks[0].melody;
  await start(f, baseline); queue(f, song(), 350);
  for (const p of f.peers) await p.next('song-change');
  const before = { state: f.room.state, transport: f.room.transport };
  const pending = f.room.pendingSongChange;
  // Deliberate in-process fault injection at the timer's trust boundary only.
  pending.song.sections[0].tracks[0].melody.bars[0][0].captureData = marker;
  await new Promise(r => setTimeout(r, Math.max(0, pending.effectiveAt - Date.now()) + 30));
  assert.equal(f.room.state, before.state, 'unsafe candidate must never become canonical');
  assert.equal(f.room.transport, before.transport);
  assert.equal(f.room.pendingSongChange, null); assert.equal(f.room.songChangeTimer, null);
  for (const p of f.peers) {
    assert.equal((await p.next('song-change')).cancelled, true);
    p.send({ type: 'state-request' }); assert.deepEqual((await p.next('state')).payload, baseline);
    assert.equal(p.wire.some(raw => raw.includes(marker)), false);
  }
  const late = await f.connect(); assert.deepEqual((await late.next('state')).payload, baseline);
  assert.equal(late.messages.some(m => m.type === 'song-change'), false);
  assert.equal(JSON.stringify(f.logs).includes(marker), false);
});

test('actual frontend zero-velocity scores publish, refresh, queue and replay unchanged', async t => {
  const actual = await frontendStates(t);
  assert.deepEqual(actual.valid, [true, true, true]);
  assert.equal(validateState(actual.zero), true, 'frontend accepts inclusive zero velocity');
  assert.equal(validateState(actual.section), true);
  const f = await fixture(t); await publish(f, actual.zero);
  await start(f, actual.baseline); queue(f, actual.section.song, 500);
  for (const p of f.peers) await p.next('song-change');
  const timer = f.room.songChangeTimer, pending = f.room.pendingSongChange;
  const refresh = structuredClone(actual.baseline); refresh.Tracks[0].nextBeatTime += 1;
  await publish(f, refresh);
  assert.equal(f.room.songChangeTimer, timer); assert.equal(f.room.pendingSongChange, pending);
  await new Promise(r => setTimeout(r, Math.max(0, pending.effectiveAt - Date.now()) + 30));
  const late = await f.connect(); assert.deepEqual((await late.next('state')).payload, { ...refresh, song: actual.section.song });
});

const mutations = [
  ['root metadata', p => { p.extra = { recordings: [{ name: marker }] }; }],
  ['custom metadata', p => { p.customSounds = { captureData: { raw: marker } }; }],
  ['runtime object', p => { p.Tracks[0].nextBeatTime = { captureData: marker }; }],
  ['runtime array', p => { p.Tracks[0].songRepeatIteration = [marker]; }],
  ['root private list', p => { p.recordings = [marker]; }],
  ['root serialized audio', p => { p.serializedRecordings = { [marker]: 'audio' }; }],
  ['unknown asset', p => { p.Tracks[0].mainBeatSound.sound = marker; }],
  ['unprefixed local alias', p => { p.customSounds = { PublicAlias: { baseSound: marker, settings: {} } }; p.Tracks[0].mainBeatSound.sound = 'PublicAlias'; }],
  ['nested private alias', p => { p.customSounds = { PublicAlias: { baseSound: 'Nested', settings: {} }, Nested: { baseSound: 'Recording:' + marker, settings: {} } }; p.Tracks[0].mainBeatSound.sound = 'PublicAlias'; }],
  ['unused private alias', p => { p.customSounds = { Unused: { baseSound: marker, settings: {} } }; }],
];

test('complete melody envelope rejects private bags and unverified assets on every wire', async t => {
  const f = await fixture(t), baseline = state(); await publish(f, baseline);
  const before = f.room.state, revision = f.room.revision;
  const evidence = [];
  for (const [name, mutate] of mutations) {
    const bad = state(); mutate(bad); const offset = f.host.messages.length;
    f.host.send({ type: 'state', payload: bad });
    for (const peer of f.peers) await peer.settle();
    evidence.push({ name, rejected: f.host.messages.slice(offset).some(m => m.type === 'error' && m.code === 'invalid-state') });
  }
  assert.deepEqual(evidence.filter(e => !e.rejected), [], 'every private/ambiguous payload must be rejected, not sanitized');
  for (const p of f.peers) assert.equal(p.wire.some(raw => raw.includes(marker)), false);
  assert.equal(f.room.state, before); assert.equal(f.room.revision, revision);
  assert.equal(JSON.stringify(f.logs).includes(marker), false);
});
