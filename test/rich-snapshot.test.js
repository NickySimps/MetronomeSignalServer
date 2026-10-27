const test = require('node:test');
const assert = require('node:assert/strict');
const { validateState, createSyncServer } = require('../server');
const WebSocket = require('ws');
const crypto = require('crypto');

async function roomFixture(t) {
  const server = createSyncServer({ port: 0, logger: { log() {}, warn() {} } });
  await new Promise(resolve => server.wss.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.wss.address().port}`), messages = [];
  ws.on('message', data => messages.push(JSON.parse(data)));
  t.after(async () => { ws.terminate(); await server.close(); });
  await new Promise(resolve => ws.once('open', resolve));
  const send = message => ws.send(JSON.stringify(message));
  async function next(type) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(message => message.type === type);
      if (index >= 0) return messages.splice(index, 1)[0];
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw Error(`No ${type}; received ${JSON.stringify(messages.map(m => m.type))}`);
  }
  const credential = crypto.randomBytes(32).toString('hex');
  const proof = crypto.createHash('sha256').update(credential).digest('hex').slice(0, 32);
  send({ type: 'join', room: `rich_${proof}`, requestedRole: 'host', hostCredential: credential, capabilities: ['song-v2', 'song-boundary-v1', 'logical-beats-v1'] });
  await next('joined');
  return { send, next, messages };
}


const sound = () => ({ sound: 'Synth Kick', settings: { volume: 1, frequency: 440, allowOverlap: true, retrigger: true, reverse: false, highPassFrequency: 20, lowPassFrequency: 20000, probability: 100 } });
function richState() {
  const snapshot = {
    name: 'Normalized track', muted: false, solo: false, volume: 0.8, pitchShift: -3, swing: 25,
    mainBeatSound: sound(), subdivisionSound: sound(),
    barSettings: [{ beats: 4, subdivision: 2, rests: [3], velocities: { 0: 0.5, 7: 1 }, beatSounds: { 1: { mainBeatSound: sound(), subdivisionSound: sound() } }, beatSlices: { 2: 4 }, beatSliceAnchors: { 2: 0 } }]
  };
  return { tempo: 120, volume: 1, Tracks: [{ ...structuredClone(snapshot), currentBar: 0, currentBeat: 0 }], selectedTrackIndex: 0, selectedBarIndexInContainer: 0, song: { version: 2, enabled: true, name: 'Rich song', sections: [{ name: 'Verse', startBar: 0, tempo: 120, repeats: 1, tracks: [snapshot] }] } };
}
const snapshot = state => state.song.sections[0].tracks[0];
test('rich snapshots round-trip intact and oversized state or queued song cannot replace authority', async t => {
  const room = await roomFixture(t), state = richState();
  room.send({ type: 'state', payload: state }); room.send({ type: 'state-request' });
  assert.deepEqual((await room.next('state')).payload, state);
  const oversized = richState(), bar = snapshot(oversized).barSettings[0];
  bar.velocities = Object.fromEntries(Array.from({ length: 512 }, (_, i) => [i, 0.123456789]));
  snapshot(oversized).barSettings = Array.from({ length: 40 }, () => structuredClone(bar));
  assert.equal(validateState(oversized), true, 'typed structure is valid independently of bytes');
  const bytes = Buffer.byteLength(JSON.stringify(oversized));
  assert.ok(bytes > 256 * 1024 && bytes < 500 * 1024, `payload bytes=${bytes}`);
  room.send({ type: 'state', payload: oversized });
  assert.equal((await room.next('error')).code, 'invalid-state');
  room.send({ type: 'transport-command', playing: true, currentBar: 0, currentBeat: 0 }); await room.next('transport');
  room.send({ type: 'song-change-command', change: { version: 1, song: oversized.song, sectionIndex: 0, startBar: 0, effectiveAt: Date.now() + 1000 } });
  assert.equal((await room.next('error')).code, 'invalid-song-change');
  room.send({ type: 'state-request' }); assert.deepEqual((await room.next('state')).payload, state);
  assert.equal(room.messages.filter(message => message.type === 'song-change' && !message.cancelled).length, 0);
});

test('legacy metadata-only songs remain valid and generic depth/container caps remain enforced', () => {
  const state = richState();
  delete state.song.sections[0].tracks;
  assert.equal(validateState(state), true);
  state.song = { version: 1, enabled: true, name: 'Legacy', sections: [{ name: 'Verse', startBar: 0, tempo: 120 }] };
  assert.equal(validateState(state), true);
  for (const value of [Array(257).fill(0), Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`key${i}`, 0]))]) {
    assert.equal(validateState({ ...state, metadata: value }), false);
  }
  let nested = {};
  for (let i = 0; i < 14; i++) nested = { nested };
  assert.equal(validateState({ ...state, metadata: nested }), false);
  for (const [target, count] of [['bars', 65], ['tracks', 17], ['sections', 33]]) {
    const rich = richState(), track = structuredClone(snapshot(rich));
    if (target === 'bars') snapshot(rich).barSettings = Array.from({ length: count }, () => structuredClone(track.barSettings[0]));
    if (target === 'tracks') rich.song.sections[0].tracks = Array.from({ length: count }, () => structuredClone(track));
    if (target === 'sections') rich.song.sections = Array.from({ length: count }, (_, i) => ({ name: `Section ${i}`, startBar: i, tempo: 120, repeats: 1 }));
    assert.equal(validateState(rich), false, target);
  }
});

test('sliced playback accepts exactly the expanded bounded slot domain', () => {
  const state = richState(), track = state.Tracks[0];
  track.barSettings[0].beatSlices = { 0: 4, 2: 3 };
  track.currentBeat = 12; // Eight base slots, plus three and two extra slices.
  assert.equal(validateState(state), true);
  for (const invalid of [13, -1, 12.5, 32768, Infinity]) {
    track.currentBeat = invalid;
    assert.equal(validateState(state), false, `currentBeat=${invalid}`);
  }
  track.barSettings[0] = { beats: 5, subdivision: 0.5, rests: [], beatSlices: { 0: 2 } };
  track.currentBeat = 2; // floor(5 * .5), with one extra slice.
  assert.equal(validateState(state), true);
  track.currentBeat = 3;
  assert.equal(validateState(state), false);
});
test('typed musical maps reject malformed indices, leaves and out-of-range settings', () => {
  for (const map of ['velocities', 'beatSounds', 'beatSlices', 'beatSliceAnchors']) {
    for (const key of ['-1', '512', '1.5', '01', '1e2', 'private', '__proto__']) {
      const state = richState(), bar = snapshot(state).barSettings[0];
      bar[map] = Object.fromEntries([[key, { velocities: 1, beatSounds: {}, beatSlices: 2, beatSliceAnchors: 0 }[map]]]);
      assert.equal(validateState(state), false, `${map}.${key}`);
    }
    for (const value of [[], null, 'private']) {
      const state = richState(); snapshot(state).barSettings[0][map] = value;
      assert.equal(validateState(state), false, `${map} container`);
    }
  }
  for (const [key, values] of Object.entries({ velocities: [-0.1, 1.1, '0.5', {}, Infinity], beatSlices: [1, 5, 64, '4', {}], beatSliceAnchors: [-1, 512, 0.5, '0', {}], beatSounds: [null, [], { unknown: 'private' }, { mainBeatSound: { sound: 'Synth Kick', settings: { volume: {} } } }] })) {
    for (const value of values) { const state = richState(); snapshot(state).barSettings[0][key] = { 0: value }; assert.equal(validateState(state), false, `${key} leaf`); }
  }
  for (const [key, value] of [['pitchShift', -13], ['pitchShift', 13], ['pitchShift', 0.5], ['swing', -1], ['swing', 101], ['swing', '25']]) {
    const state = richState(); snapshot(state)[key] = value; assert.equal(validateState(state), false, key);
  }
});

test('rich snapshot containers reject unknown, device-local, credential and private data', () => {
  for (const key of ['hostCredential', 'recordings', 'serializedRecordings', 'audioLatencyOffset', 'outputOffsetMs', 'unknown', '__proto__']) {
    for (const target of ['track', 'bar', 'overrides', 'sound', 'settings']) {
      const state = richState(), track = snapshot(state), bar = track.barSettings[0], override = bar.beatSounds[1];
      const container = { track, bar, overrides: override, sound: override.mainBeatSound, settings: override.mainBeatSound.settings }[target];
      Object.defineProperty(container, key, { value: 'PRIVATE_SENTINEL', enumerable: true });
      assert.equal(validateState(state), false, `${target}.${key}`);
    }
  }
  const state = richState();
  snapshot(state).barSettings[0].beatSounds[1].mainBeatSound.sound = 'Recording:private';
  assert.equal(validateState(state), false);
});

test('supports all 512 typed musical slots in snapshots and live committed tracks', () => {
  const state = richState();
  for (const track of [snapshot(state), state.Tracks[0]]) {
    const bar = track.barSettings[0];
    for (const [key, entry] of [['velocities', 0.5], ['beatSounds', { mainBeatSound: sound() }], ['beatSlices', 32], ['beatSliceAnchors', 511]]) {
      bar[key] = Object.fromEntries(Array.from({ length: 512 }, (_, i) => [i, structuredClone(entry)]));
    }
  }
  assert.equal(validateState(state), true);
});

test('accepts normalized rich song snapshots without dropping musical fields', () => {
  const state = richState(), before = structuredClone(state);
  assert.equal(validateState(state), true);
  assert.deepEqual(state, before);
  const track = snapshot(state);
  track.pitchShift = 0; track.swing = 0;
  for (const key of ['velocities', 'beatSounds', 'beatSlices', 'beatSliceAnchors']) track.barSettings[0][key] = {};
  assert.equal(validateState(state), true, 'normalizer emits empty optional maps');
});
