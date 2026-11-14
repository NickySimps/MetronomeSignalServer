const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const WebSocket = require('ws');
const { createSyncServer, validateState } = require('../server');

const modern = ['song-v2', 'song-boundary-v1', 'logical-beats-v1', 'practice-v1', 'rehearsal-v1', 'melody-v1'];
const legacy = modern.filter(c => c !== 'melody-v1');
const note = (id = 'n-1') => ({ id, midi: 60, startTick: 0, durationTicks: 960, velocity: 0.8 });
const melody = () => ({ version: 1, bars: [[note()]], sampleRootMidi: 60 });
const snapshot = () => ({ name: 'Public track', muted: false, solo: false, volume: 1,
  mainBeatSound: { sound: 'Synth Kick', settings: {} }, subdivisionSound: { sound: 'Synth HiHat', settings: {} },
  barSettings: [{ beats: 4, subdivision: 1, rests: [] }] });
const state = () => ({ tempo: 120, volume: 1, Tracks: [{ ...snapshot(), currentBar: 0, currentBeat: 0 }], selectedTrackIndex: 0, selectedBarIndexInContainer: 0 });
const song = (enabled = true) => ({ version: 2, enabled, name: 'Public song', sections: [{ name: 'A', startBar: 0, tempo: 120, repeats: 1, tracks: [{ ...snapshot(), melody: melody() }] }] });
function withMelody(where = 'root', value = melody()) {
  const p = state();
  if (where === 'root') p.Tracks[0].melody = value;
  else { p.song = song(false); p.song.sections[0].tracks[0].melody = value; }
  return p;
}

async function fixture(t, hostCaps = modern) {
  const server = createSyncServer({ port: 0, logger: { log() {}, warn() {} } });
  await new Promise(resolve => server.wss.once('listening', resolve));
  const sockets = [];
  t.after(async () => { for (const ws of sockets) ws.terminate(); await server.close(); });
  const credential = crypto.randomBytes(32).toString('hex');
  const roomId = 'melody_' + crypto.createHash('sha256').update(credential).digest('hex').slice(0, 32);
  async function connect(caps = modern, isHost = false, autoJoin = true) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.wss.address().port}`), messages = [];
    sockets.push(ws);
    ws.on('message', raw => messages.push(JSON.parse(raw)));
    await new Promise(resolve => ws.once('open', resolve));
    const peer = { ws, messages, send: m => ws.send(JSON.stringify(m)),
      join: (capabilities = caps, host = isHost) => ws.send(JSON.stringify({ type: 'join', room: roomId, requestedRole: host ? 'host' : 'client', ...(host ? { hostCredential: credential } : {}), capabilities })),
      async next(type, predicate = () => true) {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          const index = messages.findIndex(m => m.type === type && predicate(m));
          if (index >= 0) return messages.splice(index, 1)[0];
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw Error(`No ${type}; received ${JSON.stringify(messages.map(m => m.type))}`);
      }
    };
    if (autoJoin) peer.join();
    return peer;
  }
  const host = await connect(hostCaps, true);
  const joined = await host.next('joined');
  const room = server.rooms.get(roomId);
  return { server, host, joined, room, connect };
}
async function publish(peer, payload) {
  peer.send({ type: 'state', payload });
  peer.send({ type: 'state-request' });
  return peer.next('state');
}
async function settle(peer) {
  const t0 = Date.now(); peer.send({ type: 'time-sync', t0 });
  await peer.next('time-sync-response', m => m.t0 === t0);
}

for (const where of ['root', 'section']) test(`strict melody validation at ${where}`, () => {
  assert.equal(validateState(withMelody(where)), true, 'valid notes accepted unchanged');
  assert.equal(validateState(withMelody(where, { version: 1, bars: [[]] })), true, 'empty melody is valid');
  const invalid = [null, [], {}, { ...melody(), version: 2 }, { ...melody(), enabled: false },
    { ...melody(), bars: [] }, { ...melody(), bars: [[], []] }, { ...melody(), bars: [null] },
    ...[-1, 128, 60.5, '60'].map(sampleRootMidi => ({ ...melody(), sampleRootMidi })),
    ...['', 'x'.repeat(65), 'é', 'name with space', 'n\n', 'n\r', 'n\u0000'].map(id => ({ version: 1, bars: [[note(id)]] })),
    ...Object.entries({ midi: [-1, 128, 60.5, '60'], startTick: [-1, 3840, 0.5, '0'], durationTicks: [0, -1, 3841, 0.5, '1'], velocity: [-1, 1.1, '1', Infinity] })
      .flatMap(([key, values]) => values.map(value => ({ version: 1, bars: [[{ ...note(), [key]: value }]] }))),
    { version: 1, bars: [[{ ...note(), startTick: 3000 }]] },
    { version: 1, bars: [[note(), note()]] },
    { version: 1, bars: [Array.from({ length: 129 }, (_, i) => note(`n${i}`))] },
    ...['recordings', 'serializedRecordings', 'sample', 'captureData', 'name', 'unknown', '__proto__'].map(key => ({ version: 1, bars: [[Object.fromEntries([...Object.entries(note()), [key, 'PRIVATE_SENTINEL']])]] }))];
  for (const value of invalid) assert.equal(validateState(withMelody(where, value)), false, JSON.stringify(value));
  const p = withMelody(where), track = where === 'root' ? p.Tracks[0] : p.song.sections[0].tracks[0];
  track.barSettings = Array.from({ length: 17 }, () => ({ beats: 4, subdivision: 1, rests: [] }));
  track.melody.bars = track.barSettings.map((_, bar) => Array.from({ length: 128 }, (_, n) => note(`b${bar}n${n}`)));
  assert.equal(validateState(p), false, '2048 notes/track cap');
  track.melody.bars[16] = [];
  assert.equal(validateState(p), true, 'exactly 2048 notes accepted');
  track.melody.bars[1][0].id = track.melody.bars[0][0].id;
  assert.equal(validateState(p), false, 'IDs unique across track bars');
});

for (const where of ['root', 'section']) test('melody requires the shared beat-meter limit and rejects negative zero', () => {
  const mutations = [
    ['33-beat bar', track => { track.barSettings[0].beats = 33; }],
    ['negative-zero sample root', track => { track.melody.sampleRootMidi = -0; }],
    ['negative-zero MIDI', track => { track.melody.bars[0][0].midi = -0; }],
    ['negative-zero onset', track => { track.melody.bars[0][0].startTick = -0; }],
    ['negative-zero velocity', track => { track.melody.bars[0][0].velocity = -0; }],
  ];
  const accepted = [];
  for (const [label, mutate] of mutations) {
    const payload = withMelody(where);
    const track = where === 'root' ? payload.Tracks[0] : payload.song.sections[0].tracks[0];
    mutate(track);
    if (validateState(payload)) accepted.push(label);
  }
  assert.deepEqual(accepted, [], `${where}: rejected cases accepted`);
});

for (const where of ['root', 'section']) test(`melody presence at ${where} requires every member including host`, async t => {
  const f = await fixture(t);
  const baseline = state(); await publish(f.host, baseline);
  const old = await f.connect(legacy); await old.next('joined'); await old.next('state');
  const before = f.room.state, revision = f.room.revision;
  const payload = withMelody(where, { version: 1, bars: [[]] });
  f.host.send({ type: 'state', payload });
  assert.equal((await f.host.next('error')).code, 'incompatible-client');
  assert.deepEqual((await f.host.next('state', m => m.authoritativeRefresh)).payload, baseline);
  assert.equal(f.room.state, before); assert.equal(f.room.revision, revision);
  await settle(old); assert.equal(old.messages.some(m => m.type === 'state'), false);
  old.ws.terminate(); await new Promise(resolve => old.ws.once('close', resolve));
  await settle(f.host);
  assert.deepEqual((await publish(f.host, payload)).payload, payload);
  assert.ok(f.joined.capabilities.includes('melody-v1'));
  const capable = await f.connect(); await capable.next('joined');
  assert.deepEqual((await capable.next('state')).payload, payload);
});

test('a host without melody-v1 cannot publish notes even alone', async t => {
  const f = await fixture(t, legacy);
  await publish(f.host, state());
  const before = f.room.state, revision = f.room.revision;
  f.host.send({ type: 'state', payload: withMelody() });
  assert.equal((await f.host.next('error')).code, 'incompatible-client');
  assert.equal(f.room.state, before); assert.equal(f.room.revision, revision);
});

for (const where of ['root', 'section']) test(`late join, rejoin and host replacement cannot downgrade ${where} melody`, async t => {
  const f = await fixture(t);
  const peer = await f.connect(); await peer.next('joined');
  await publish(f.host, withMelody(where)); await peer.next('state');
  const before = f.room.state, revision = f.room.revision, host = f.room.host;
  const clients = [...f.room.clients];
  peer.join(legacy);
  assert.equal((await peer.next('error')).code, 'incompatible-client');
  const late = await f.connect(legacy); assert.equal((await late.next('error')).code, 'incompatible-client');
  const replacement = await f.connect(legacy, true); assert.equal((await replacement.next('error')).code, 'incompatible-client');
  await settle(f.host); await settle(peer);
  assert.equal(f.room.state, before); assert.equal(f.room.revision, revision); assert.equal(f.room.host, host);
  assert.deepEqual([...f.room.clients], clients);
  assert.equal(peer.messages.some(m => ['state', 'song-change', 'joined', 'host-replaced'].includes(m.type)), false);
  assert.equal(f.host.messages.some(m => m.type === 'host-replaced'), false);
  assert.equal([...f.room.clients].find(c => c !== host).capabilities.has('melody-v1'), true);
  replacement.join(modern, true); await replacement.next('joined');
  assert.deepEqual((await replacement.next('state')).payload.Tracks, before.payload.Tracks);
  assert.notEqual(f.room.host, host);
});

async function start(f) {
  await publish(f.host, state());
  f.host.send({ type: 'transport-command', playing: true, currentBar: 0, currentBeat: 0 });
  await f.host.next('transport');
}
function queue(peer, nextSong, delay = 30000) {
  peer.send({ type: 'song-change-command', change: { version: 1, song: nextSong, sectionIndex: 0, startBar: 0, effectiveAt: Date.now() + delay } });
}
for (const incapable of ['host', 'client']) test(`queued melody requires capable ${incapable} and preserves previous queue on rejection`, async t => {
  const f = await fixture(t, incapable === 'host' ? legacy : modern);
  await start(f);
  if (incapable === 'client') { const old = await f.connect(legacy); await old.next('joined'); }
  const rhythm = song(); delete rhythm.sections[0].tracks[0].melody;
  queue(f.host, rhythm); await f.host.next('song-change', m => !m.cancelled);
  const before = { revision: f.room.revision, state: f.room.state, pending: f.room.pendingSongChange, timer: f.room.songChangeTimer, host: f.room.host, transport: f.room.transport };
  queue(f.host, song(false));
  assert.equal((await f.host.next('error')).code, 'incompatible-client');
  assert.equal(f.room.revision, before.revision); assert.equal(f.room.state, before.state);
  assert.equal(f.room.pendingSongChange, before.pending); assert.equal(f.room.songChangeTimer, before.timer);
  assert.equal(f.room.host, before.host); assert.equal(f.room.transport, before.transport);
  await settle(f.host); assert.equal(f.host.messages.some(m => m.type === 'song-change'), false);
});

test('pending-only disabled melody fences late joins, rejoin and replacement before membership/authority/timer mutation', async t => {
  const f = await fixture(t); await start(f);
  const peer = await f.connect(); await peer.next('joined'); await peer.next('state');
  queue(f.host, song(false)); await f.host.next('song-change'); await peer.next('song-change');
  const before = { revision: f.room.revision, state: f.room.state, pending: f.room.pendingSongChange, timer: f.room.songChangeTimer, host: f.room.host, clients: [...f.room.clients] };
  const late = await f.connect(legacy, false, false), replacement = await f.connect(legacy, true, false);
  for (const [p, host] of [[peer, false], [late, false], [replacement, true]]) {
    p.join(legacy, host);
    assert.equal((await p.next('error')).code, 'incompatible-client');
    await settle(p);
    assert.equal(p.messages.some(m => ['joined', 'song-change', 'state'].includes(m.type)), false);
  }
  assert.equal(f.room.revision, before.revision); assert.equal(f.room.state, before.state);
  assert.equal(f.room.pendingSongChange, before.pending); assert.equal(f.room.songChangeTimer, before.timer);
  assert.equal(f.room.host, before.host); assert.deepEqual([...f.room.clients], before.clients);
  const capable = await f.connect(); await capable.next('joined');
  assert.deepEqual((await capable.next('song-change')).song, song(false));
  assert.deepEqual((await capable.next('state')).payload, state());
});

test('queued melody applies intact for capable peers and stays host-only', async t => {
  const f = await fixture(t); await start(f);
  const peer = await f.connect(); await peer.next('joined'); await peer.next('state');
  queue(peer, song()); assert.equal((await peer.next('error')).code, 'host-only');
  queue(f.host, song(), 350); await f.host.next('song-change');
  assert.deepEqual((await peer.next('song-change')).song, song());
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(f.room.pendingSongChange, null);
  assert.deepEqual(f.room.state.payload.song, song());
  peer.send({ type: 'state-request' }); assert.deepEqual((await peer.next('state')).payload.song, song());
});

function largeTrack(runtime = false) {
  const track = { ...snapshot(), ...(runtime ? { currentBar: 0, currentBeat: 0 } : {}) };
  track.barSettings = Array.from({ length: 8 }, () => ({ beats: 4, subdivision: 1, rests: [] }));
  track.melody = { version: 1, bars: track.barSettings.map((_, b) => Array.from({ length: 128 }, (_, n) => note(`b${b}n${n}-` + 'x'.repeat(24)))) };
  return track;
}

test('real sockets reject malformed/private/oversize scores without touching state, queue, timer, peers or authority', async t => {
  const f = await fixture(t); await start(f);
  const peer = await f.connect(); await peer.next('joined'); await peer.next('state');
  const rhythm = song(); delete rhythm.sections[0].tracks[0].melody;
  queue(f.host, rhythm); await f.host.next('song-change'); await peer.next('song-change');
  const baseline = { revision: f.room.revision, state: f.room.state, pending: f.room.pendingSongChange, timer: f.room.songChangeTimer, host: f.room.host, transport: f.room.transport, clients: [...f.room.clients] };
  const assertUnchanged = () => {
    for (const key of ['revision', 'state', 'host', 'transport']) assert.equal(f.room[key], baseline[key], key);
    assert.equal(f.room.pendingSongChange, baseline.pending); assert.equal(f.room.songChangeTimer, baseline.timer);
    assert.deepEqual([...f.room.clients], baseline.clients);
  };
  const invalidRoot = withMelody('root', { version: 1, bars: [[{ ...note(), sampleName: 'PRIVATE_SENTINEL' }]] });
  const invalidSection = withMelody('section');
  invalidSection.song.sections.push({ ...structuredClone(invalidSection.song.sections[0]), name: 'B', startBar: 1 });
  invalidSection.Tracks[0].barSettings.push({ beats: 4, subdivision: 1, rests: [] });
  invalidSection.song.sections[1].tracks[0].melody.bars[0][0].durationTicks = 0;
  const huge = state(); huge.Tracks = Array.from({ length: 3 }, () => largeTrack(true));
  assert.equal(validateState(huge), true);
  const hugeSong = song(); hugeSong.sections[0].tracks = Array.from({ length: 3 }, () => largeTrack());
  for (const payload of [huge, { ...state(), song: hugeSong }]) {
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    assert.ok(bytes > 256 * 1024 && bytes < 500 * 1024, `oversize fixture ${bytes}`);
  }
  for (const payload of [invalidRoot, invalidSection, huge]) {
    f.host.send({ type: 'state', payload }); assert.equal((await f.host.next('error')).code, 'invalid-state'); assertUnchanged();
  }
  const privateSong = song(); privateSong.sections[0].tracks[0].mainBeatSound.sound = 'Recording:PRIVATE_SENTINEL';
  const badSong = song(); badSong.sections[0].tracks[0].melody.bars[0][0].midi = 128;
  for (const nextSong of [privateSong, badSong, hugeSong]) {
    queue(f.host, nextSong); assert.equal((await f.host.next('error')).code, 'invalid-song-change'); assertUnchanged();
  }
  await settle(peer); await settle(f.host);
  assert.equal(peer.messages.some(m => ['state', 'song-change'].includes(m.type)), false);
  assert.equal(f.host.messages.some(m => m.type === 'song-change'), false);
  for (const p of [peer, f.host]) assert.equal(JSON.stringify(p.messages).includes('PRIVATE_SENTINEL'), false);
  peer.send({ type: 'state-request' }); assert.deepEqual((await peer.next('state')).payload, state());
});

test('legacy rhythm rooms need no melody capability and can still publish and replay', async t => {
  const f = await fixture(t, []);
  assert.deepEqual((await publish(f.host, state())).payload, state());
  const old = await f.connect([]); await old.next('joined');
  assert.deepEqual((await old.next('state')).payload, state());
  const before = f.room.state;
  old.send({ type: 'state', payload: withMelody() });
  assert.equal((await old.next('error')).code, 'host-only');
  assert.equal(f.room.state, before);
});
