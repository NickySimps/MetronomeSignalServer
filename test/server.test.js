const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const crypto = require('crypto');
const { createSyncServer } = require('../server');

const silentLogger = { log() {}, warn() {}, error() {} };

function validState(overrides = {}) {
  return {
    tempo: 173,
    volume: 0.75,
    Tracks: [{
      barSettings: [{ beats: 4, subdivision: 1, rests: [] }],
      muted: false,
      solo: false,
      volume: 1,
      currentBar: 0,
      currentBeat: 0,
      mainBeatSound: { sound: 'Synth Kick', settings: {} },
      subdivisionSound: { sound: 'Synth HiHat', settings: {} },
      nextBeatTime: 0
    }],
    selectedTrackIndex: 0,
    selectedBarIndexInContainer: 0,
    controlsAttachedToTrack: true,
    isPlaying: false,
    isRestMode: false,
    isRecording: false,
    customSounds: {},
    ...overrides
  };
}

function roomIdentity(label) {
  const credential = crypto.createHash('sha256').update(`host:${label}`).digest('hex');
  const proof = crypto.createHash('sha256').update(credential).digest('hex').slice(0, 32);
  return { room: `${label}_${proof}`, credential };
}

function hostJoin(label, capabilities = ['song-v1']) {
  const identity = roomIdentity(label);
  return { type: 'join', room: identity.room, requestedRole: 'host', hostCredential: identity.credential, capabilities };
}

async function startServer(overrides = {}) {
  const server = createSyncServer({ port: 0, logger: silentLogger, transportLeadMs: 500, ...overrides });
  await new Promise(resolve => server.wss.once('listening', resolve));
  const { port } = server.wss.address();
  return { ...server, url: `ws://127.0.0.1:${port}` };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function inbox(ws) {
  const queued = [];
  const waiters = [];
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    const waiterIndex = waiters.findIndex(waiter => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    } else {
      queued.push(message);
    }
  });
  return {
    next(predicate = () => true, timeoutMs = 2000) {
      const index = queued.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timeout: null };
        waiter.timeout = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          reject(new Error('Timed out waiting for WebSocket message'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    }
  };
}

function send(ws, message) {
  ws.send(JSON.stringify(message));
}

async function closeSocket(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise(resolve => {
    ws.once('close', resolve);
    ws.close();
  });
}

test('server assigns one authoritative host and broadcasts client counts', async t => {
  const server = await startServer();
  t.after(() => server.close());
  const host = await connect(server.url);
  const hostInbox = inbox(host);
  const client = await connect(server.url);
  const clientInbox = inbox(client);
  t.after(() => Promise.all([closeSocket(host), closeSocket(client)]));

  send(host, hostJoin('alpha'));
  const hostJoined = await hostInbox.next(message => message.type === 'joined');
  assert.equal(hostJoined.isHost, true);
  assert.equal(hostJoined.clientCount, 0);

  send(client, { type: 'join', room: roomIdentity('alpha').room, requestedRole: 'host' });
  const rejectedTakeover = await clientInbox.next(message => message.type === 'error');
  assert.equal(rejectedTakeover.code, 'invalid-host-credential');
  send(client, { type: 'join', room: roomIdentity('alpha').room, requestedRole: 'client' });
  const clientJoined = await clientInbox.next(message => message.type === 'joined');
  assert.equal(clientJoined.isHost, false);
  assert.equal(clientJoined.clientCount, 1);

  const presence = await hostInbox.next(message => message.type === 'presence' && message.clientCount === 1);
  assert.equal(presence.clientCount, 1);
});

test('only the host can publish state and late joiners receive the latest theme-free snapshot', async t => {
  const server = await startServer();
  t.after(() => server.close());
  const host = await connect(server.url);
  const hostInbox = inbox(host);
  const client = await connect(server.url);
  const clientInbox = inbox(client);
  t.after(() => Promise.all([closeSocket(host), closeSocket(client)]));

  send(host, hostJoin('state-room'));
  await hostInbox.next(message => message.type === 'joined');
  send(client, { type: 'join', room: roomIdentity('state-room').room, requestedRole: 'client' });
  await clientInbox.next(message => message.type === 'joined');

  send(client, { type: 'state', payload: { tempo: 90 } });
  const rejected = await clientInbox.next(message => message.type === 'error');
  assert.equal(rejected.code, 'host-only');

  send(host, { type: 'state', payload: validState({ selectedTheme: 'dark' }) });
  const state = await clientInbox.next(message => message.type === 'state');
  assert.equal(state.payload.tempo, 173);
  assert.equal('selectedTheme' in state.payload, false);
  assert.equal(state.revision, 1);

  send(client, { type: 'state-request' });
  const restored = await clientInbox.next(message => message.type === 'state' && message.revision === 1);
  assert.equal(restored.payload.tempo, 173);
  assert.equal('selectedTheme' in restored.payload, false);

  const lateClient = await connect(server.url);
  const lateInbox = inbox(lateClient);
  t.after(() => closeSocket(lateClient));
  send(lateClient, { type: 'join', room: roomIdentity('state-room').room, requestedRole: 'client' });
  await lateInbox.next(message => message.type === 'joined');
  const replay = await lateInbox.next(message => message.type === 'state');
  assert.equal(replay.payload.tempo, 173);
  assert.equal(replay.revision, 1);
});

test('server schedules one authoritative Play or Stop timestamp for every peer', async t => {
  const server = await startServer();
  t.after(() => server.close());
  const host = await connect(server.url);
  const hostInbox = inbox(host);
  const client = await connect(server.url);
  const clientInbox = inbox(client);
  t.after(() => Promise.all([closeSocket(host), closeSocket(client)]));

  send(host, hostJoin('transport-room'));
  await hostInbox.next(message => message.type === 'joined');
  send(client, { type: 'join', room: roomIdentity('transport-room').room, requestedRole: 'client' });
  await clientInbox.next(message => message.type === 'joined');

  const before = Date.now();
  send(host, { type: 'transport-command', playing: true, currentBar: 2, currentBeat: 3 });
  const [hostPlay, clientPlay] = await Promise.all([
    hostInbox.next(message => message.type === 'transport' && message.playing === true),
    clientInbox.next(message => message.type === 'transport' && message.playing === true)
  ]);
  assert.deepEqual(clientPlay, hostPlay);
  assert.equal(hostPlay.playing, true);
  assert.equal(hostPlay.currentBar, 2);
  assert.equal(hostPlay.currentBeat, 3);
  assert.ok(hostPlay.effectiveAt >= before + 500);

  send(host, { type: 'transport-command', playing: false, currentBar: 2, currentBeat: 3 });
  const [hostStop, clientStop] = await Promise.all([
    hostInbox.next(message => message.type === 'transport' && message.playing === false && message.revision > hostPlay.revision),
    clientInbox.next(message => message.type === 'transport' && message.playing === false && message.revision > hostPlay.revision)
  ]);
  assert.deepEqual(clientStop, hostStop);
  assert.ok(hostStop.revision > hostPlay.revision);
});

test('server derives a synchronized count-in from authoritative room state', async t => {
  const server = await startServer();
  t.after(() => server.close());
  const host = await connect(server.url);
  const hostInbox = inbox(host);
  const client = await connect(server.url);
  const clientInbox = inbox(client);
  t.after(() => Promise.all([closeSocket(host), closeSocket(client)]));

  send(host, hostJoin('count-in-room'));
  await hostInbox.next(message => message.type === 'joined');
  send(client, { type: 'join', room: roomIdentity('count-in-room').room, requestedRole: 'client', capabilities: ['song-v1'] });
  await clientInbox.next(message => message.type === 'joined');
  send(host, {
    type: 'state',
    payload: validState({
      tempo: 120,
      countInBars: 2,
      song: {
        version: 1,
        enabled: true,
        name: 'Count-in tempo map',
        sections: [{ name: 'Intro', startBar: 0, tempo: 300 }]
      },
      Tracks: [{
        ...validState().Tracks[0],
        barSettings: [{ beats: 3, subdivision: 1, rests: [] }]
      }]
    })
  });
  await clientInbox.next(message => message.type === 'state');

  const before = Date.now();
  send(host, { type: 'transport-command', playing: true, currentBar: 0, currentBeat: 0, countInBars: 8 });
  const [hostPlay, clientPlay] = await Promise.all([
    hostInbox.next(message => message.type === 'transport' && message.playing),
    clientInbox.next(message => message.type === 'transport' && message.playing)
  ]);
  assert.deepEqual(clientPlay, hostPlay);
  assert.ok(hostPlay.countIn.startsAt >= before + 500);
  assert.equal(hostPlay.countIn.totalBeats, 6);
  assert.equal(hostPlay.countIn.beatIntervalMs, 200);
  assert.equal(hostPlay.countIn.accentEvery, 3);
  assert.equal(hostPlay.effectiveAt - hostPlay.countIn.startsAt, 1200);

  send(host, {
    type: 'playback-sync-pulse',
    nextBeatWallTime: hostPlay.countIn.startsAt,
    currentBar: 0,
    currentBeat: 0
  });
  assert.equal((await hostInbox.next(message => message.type === 'error')).code, 'invalid-sync-pulse');

  const lateClient = await connect(server.url);
  const lateInbox = inbox(lateClient);
  t.after(() => closeSocket(lateClient));
  send(lateClient, { type: 'join', room: roomIdentity('count-in-room').room, requestedRole: 'client', capabilities: ['song-v1'] });
  await lateInbox.next(message => message.type === 'joined');
  const replayedPlay = await lateInbox.next(message => message.type === 'transport' && message.playing);
  assert.deepEqual(replayedPlay.countIn, hostPlay.countIn);
  assert.equal(replayedPlay.effectiveAt, hostPlay.effectiveAt);

  const room = server.rooms.get(roomIdentity('count-in-room').room);
  room.transport.effectiveAt = Date.now() - 1;
  send(host, {
    type: 'playback-sync-pulse',
    nextBeatWallTime: Date.now() + 100,
    currentBar: 0,
    currentBeat: 0
  });
  await clientInbox.next(message => message.type === 'playback-sync-pulse');
  assert.equal(room.transport.countIn, undefined);

  send(host, { type: 'transport-command', playing: false, currentBar: 0, currentBeat: 0 });
  const stop = await hostInbox.next(message => message.type === 'transport' && !message.playing);
  assert.equal(stop.countIn, undefined);
});

test('adaptive transport lead minimizes Play delay while covering the slowest peer', async t => {
  const server = await startServer({
    transportLeadMs: null,
    minimumTransportLeadMs: 150,
    fallbackTransportLeadMs: 200,
    maximumTransportLeadMs: 500
  });
  t.after(() => server.close());
  const host = await connect(server.url);
  const hostInbox = inbox(host);
  const client = await connect(server.url);
  const clientInbox = inbox(client);
  t.after(() => Promise.all([closeSocket(host), closeSocket(client)]));

  send(host, hostJoin('adaptive-lead'));
  await hostInbox.next(message => message.type === 'joined');
  send(client, { type: 'join', room: roomIdentity('adaptive-lead').room, requestedRole: 'client' });
  await clientInbox.next(message => message.type === 'joined');
  const room = server.rooms.get(roomIdentity('adaptive-lead').room);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(Number.isFinite(room.host.roundTripTime));
  assert.ok(Number.isFinite([...room.clients].find(peer => peer !== room.host).roundTripTime));
  room.host.roundTripTime = 40;
  room.host.roundTripMeasuredAt = Date.now();
  const clientPeer = [...room.clients].find(peer => peer !== room.host);
  clientPeer.roundTripTime = 300;
  clientPeer.roundTripMeasuredAt = Date.now();

  const before = Date.now();
  send(host, { type: 'transport-command', playing: true, currentBar: 0, currentBeat: 0 });
  const play = await hostInbox.next(message => message.type === 'transport' && message.playing);
  const lead = play.effectiveAt - before;
  assert.ok(lead >= 200, `expected at least 200ms lead, received ${lead}ms`);
  assert.ok(lead < 300, `expected adaptive lead below 300ms, received ${lead}ms`);

  room.host.roundTripMeasuredAt = Date.now() - 30001;
  clientPeer.roundTripMeasuredAt = Date.now() - 30001;
  send(host, { type: 'transport-command', playing: false, currentBar: 0, currentBeat: 0 });
  const fallback = await hostInbox.next(message => message.type === 'transport' && !message.playing);
  assert.equal(fallback.leadTime, 200);
});

test('host disconnect closes the room instead of silently promoting a client', async t => {
  const server = await startServer();
  t.after(() => server.close());
  const host = await connect(server.url);
  const hostInbox = inbox(host);
  const client = await connect(server.url);
  const clientInbox = inbox(client);
  t.after(() => Promise.all([closeSocket(host), closeSocket(client)]));

  send(host, hostJoin('close-room'));
  await hostInbox.next(message => message.type === 'joined');
  send(client, { type: 'join', room: roomIdentity('close-room').room, requestedRole: 'client' });
  await clientInbox.next(message => message.type === 'joined');

  host.close();
  const closed = await clientInbox.next(message => message.type === 'room-closed');
  assert.equal(closed.reason, 'host-disconnected');
});

test('credential-free legacy clients cannot create authoritative rooms', async t => {
  const server = await startServer();
  t.after(() => server.close());
  const host = await connect(server.url);
  const client = await connect(server.url);
  const hostInbox = inbox(host);
  const clientInbox = inbox(client);
  t.after(() => Promise.all([closeSocket(host), closeSocket(client)]));

  send(host, { type: 'join', room: 'legacy-room' });
  assert.equal((await hostInbox.next(message => message.type === 'error')).code, 'room-not-found');
  send(client, { type: 'join', room: 'legacy-room', requestedRole: 'host' });
  assert.equal((await clientInbox.next(message => message.type === 'error')).code, 'invalid-host-credential');
});
test('credential-bound rooms reject host takeover and accept the matching host secret', async t => {
  const server = await startServer();
  t.after(() => server.close());
  const credential = 'a'.repeat(64);
  const proof = crypto.createHash('sha256').update(credential).digest('hex').slice(0, 32);
  const room = `secure_room_${proof}`;
  const attacker = await connect(server.url);
  const attackerInbox = inbox(attacker);
  t.after(() => closeSocket(attacker));

  send(attacker, { type: 'join', room, requestedRole: 'host', hostCredential: 'b'.repeat(64) });
  const rejected = await attackerInbox.next(message => message.type === 'error');
  assert.equal(rejected.code, 'invalid-host-credential');

  const host = await connect(server.url);
  const hostInbox = inbox(host);
  t.after(() => closeSocket(host));
  send(host, { type: 'join', room, requestedRole: 'host', hostCredential: credential });
  const joined = await hostInbox.next(message => message.type === 'joined');
  assert.equal(joined.isHost, true);
});

test('a credential-bearing replacement atomically resumes an existing host room', async t => {
  const server = await startServer();
  t.after(() => server.close());
  const original = await connect(server.url);
  const replacement = await connect(server.url);
  const client = await connect(server.url);
  const originalInbox = inbox(original);
  const replacementInbox = inbox(replacement);
  const clientInbox = inbox(client);
  t.after(() => Promise.all([closeSocket(original), closeSocket(replacement), closeSocket(client)]));

  send(original, hostJoin('replacement-room'));
  await originalInbox.next(message => message.type === 'joined');
  send(original, { type: 'state', payload: validState() });
  send(original, { type: 'transport-command', playing: true, currentBar: 0, currentBeat: 0 });
  await originalInbox.next(message => message.type === 'transport' && message.playing);

  send(replacement, hostJoin('replacement-room'));
  const replaced = await originalInbox.next(message => message.type === 'host-replaced');
  assert.equal(replaced.room, roomIdentity('replacement-room').room);
  const joined = await replacementInbox.next(message => message.type === 'joined');
  assert.equal(joined.isHost, true);
  assert.equal(joined.replacedHost, true);
  assert.equal((await replacementInbox.next(message => message.type === 'state')).payload.tempo, 173);
  assert.equal((await replacementInbox.next(message => message.type === 'transport')).playing, true);
  await replacementInbox.next(message => message.type === 'replacement-replay-complete');

  send(client, { type: 'join', room: roomIdentity('replacement-room').room, requestedRole: 'client' });
  await clientInbox.next(message => message.type === 'joined');
  const replay = await clientInbox.next(message => message.type === 'state');
  assert.equal(replay.payload.tempo, 173);
});

test('a rejected cross-room host request cannot evict the target room host', async t => {
  const server = await startServer();
  t.after(() => server.close());
  const hostA = await connect(server.url);
  const hostB = await connect(server.url);
  const clientB = await connect(server.url);
  const inboxA = inbox(hostA);
  const inboxB = inbox(hostB);
  const clientInbox = inbox(clientB);
  t.after(() => Promise.all([closeSocket(hostA), closeSocket(hostB), closeSocket(clientB)]));

  send(hostA, hostJoin('room-a'));
  await inboxA.next(message => message.type === 'joined');
  send(hostB, hostJoin('room-b'));
  await inboxB.next(message => message.type === 'joined');

  send(hostA, hostJoin('room-b'));
  assert.equal((await inboxA.next(message => message.type === 'error')).code, 'already-joined');
  send(hostB, { type: 'state', payload: validState({ tempo: 199 }) });
  send(clientB, { type: 'join', room: roomIdentity('room-b').room, requestedRole: 'client' });
  await clientInbox.next(message => message.type === 'joined');
  assert.equal((await clientInbox.next(message => message.type === 'state')).payload.tempo, 199);
});

test('song mode requires an explicitly compatible browser for every room member', async t => {
  const server = await startServer();
  t.after(() => server.close());
  const host = await connect(server.url);
  const hostInbox = inbox(host);
  const legacy = await connect(server.url);
  const legacyInbox = inbox(legacy);
  const room = roomIdentity('song-capability-room').room;
  t.after(() => Promise.all([closeSocket(host), closeSocket(legacy)]));

  send(host, hostJoin('song-capability-room'));
  await hostInbox.next(message => message.type === 'joined');
  await hostInbox.next(message => message.type === 'presence' && message.clientCount === 0);
  const stoppedState = validState({
    song: {
      version: 1,
      enabled: false,
      name: 'Capability-safe song',
      sections: [{ name: 'Intro', startBar: 0, tempo: 173 }]
    }
  });
  send(host, { type: 'state', payload: stoppedState });
  send(host, { type: 'state-request' });
  await hostInbox.next(message => message.type === 'state' && message.payload?.song?.enabled === false);
  send(legacy, { type: 'join', room, requestedRole: 'client' });
  await legacyInbox.next(message => message.type === 'joined');
  await hostInbox.next(message => message.type === 'presence' && message.clientCount === 1);

  const songState = validState({
    song: {
      version: 1,
      enabled: true,
      name: 'Capability-safe song',
      sections: [{ name: 'Intro', startBar: 0, tempo: 173 }]
    }
  });
  send(host, { type: 'state', payload: songState });
  assert.equal((await hostInbox.next(message => message.type === 'error')).code, 'incompatible-client');
  const rollback = await hostInbox.next(message => message.type === 'state');
  assert.equal(rollback.payload.song.enabled, false);
  assert.equal(rollback.authoritativeRefresh, true);

  await closeSocket(legacy);
  await hostInbox.next(message => message.type === 'presence' && message.clientCount === 0);
  assert.equal(server.rooms.get(room).clients.size, 1);
  assert.equal([...server.rooms.get(room).clients][0].capabilities?.has('song-v1'), true);
  send(host, { type: 'state', payload: songState });
  send(host, { type: 'state-request' });
  const stored = await hostInbox.next(message => message.type === 'state' && message.payload?.song?.name === 'Capability-safe song');
  assert.equal(stored.type, 'state');

  const lateLegacy = await connect(server.url);
  const lateLegacyInbox = inbox(lateLegacy);
  t.after(() => closeSocket(lateLegacy));
  send(lateLegacy, { type: 'join', room, requestedRole: 'client' });
  assert.equal((await lateLegacyInbox.next(message => message.type === 'error')).code, 'incompatible-client');

  const modern = await connect(server.url);
  const modernInbox = inbox(modern);
  t.after(() => closeSocket(modern));
  send(modern, { type: 'join', room, requestedRole: 'client', capabilities: ['song-v1'] });
  await modernInbox.next(message => message.type === 'joined');
  const replay = await modernInbox.next(message => message.type === 'state');
  assert.equal(replay.payload.song.name, 'Capability-safe song');
});

test('song v2 accepts bounded section repeats and track snapshots and rejects legacy peers', async t => {
  const server = await startServer();
  t.after(() => server.close());
  const host = await connect(server.url);
  const hostInbox = inbox(host);
  const legacy = await connect(server.url);
  const legacyInbox = inbox(legacy);
  t.after(() => Promise.all([closeSocket(host), closeSocket(legacy)]));

  send(host, hostJoin('song-v2-room', ['song-v1', 'song-v2']));
  await hostInbox.next(message => message.type === 'joined');
  const snapshotTrack = {
    name: 'Section Guitar',
    barSettings: [{ beats: 7, subdivision: 2, rests: [3] }],
    muted: false,
    solo: false,
    volume: 0.8,
    mainBeatSound: { sound: 'Synth Kick', settings: {} },
    subdivisionSound: { sound: 'Synth HiHat', settings: {} }
  };
  const song = {
    version: 2,
    enabled: true,
    name: 'Snapshot Song',
    sections: [{ name: 'Verse', startBar: 0, tempo: 140, repeats: 2, tracks: [snapshotTrack] }]
  };
  send(host, { type: 'state', payload: validState({ song }) });
  send(host, { type: 'state-request' });
  const accepted = await hostInbox.next(message => message.type === 'state' || message.type === 'error');
  assert.equal(accepted.type, 'state', JSON.stringify(accepted));
  assert.equal(accepted.payload.song.sections[0].repeats, 2);
  assert.equal(accepted.payload.song.sections[0].tracks[0].name, 'Section Guitar');

  send(legacy, {
    type: 'join', room: roomIdentity('song-v2-room').room, requestedRole: 'client', capabilities: ['song-v1']
  });
  assert.equal((await legacyInbox.next(message => message.type === 'error')).code, 'incompatible-client');

  send(host, {
    type: 'state',
    payload: validState({ song: { ...song, sections: [{ ...song.sections[0], repeats: 17 }] } })
  });
  assert.equal((await hostInbox.next(message => message.type === 'error')).code, 'invalid-state');

  send(host, {
    type: 'state',
    payload: validState({
      song: { ...song, sections: [{ ...song.sections[0], tracks: [{ ...snapshotTrack, recordings: ['private'] }] }] }
    })
  });
  assert.equal((await hostInbox.next(message => message.type === 'error')).code, 'invalid-state');
});

test('malformed state and transport messages are rejected before storage', async t => {
  const server = await startServer();
  t.after(() => server.close());
  const host = await connect(server.url);
  const hostInbox = inbox(host);
  t.after(() => closeSocket(host));
  send(host, hostJoin('validation-room'));
  await hostInbox.next(message => message.type === 'joined');

  send(host, { type: 'state', payload: validState({ tempo: 0 }) });
  assert.equal((await hostInbox.next(message => message.type === 'error')).code, 'invalid-state');
  send(host, { type: 'state', payload: validState({ tempo: 120.5 }) });
  assert.equal((await hostInbox.next(message => message.type === 'error')).code, 'invalid-state');
  send(host, { type: 'state', payload: validState({ countInBars: 9 }) });
  assert.equal((await hostInbox.next(message => message.type === 'error')).code, 'invalid-state');
  send(host, {
    type: 'state',
    payload: validState({
      song: {
        version: 1,
        enabled: true,
        name: 'Unsafe arrangement',
        sections: [{ name: 'Intro', startBar: 0, tempo: 500 }]
      }
    })
  });
  assert.equal((await hostInbox.next(message => message.type === 'error')).code, 'invalid-state');
  send(host, {
    type: 'state',
    payload: validState({
      song: {
        version: 1,
        enabled: true,
        name: 'Fractional tempo',
        sections: [{ name: 'Intro', startBar: 0, tempo: 120.5 }]
      }
    })
  });
  assert.equal((await hostInbox.next(message => message.type === 'error')).code, 'invalid-state');
  send(host, { type: 'transport-command', playing: true, currentBar: -1, currentBeat: 0 });
  assert.equal((await hostInbox.next(message => message.type === 'error')).code, 'invalid-transport');
});
