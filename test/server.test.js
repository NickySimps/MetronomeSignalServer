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

function hostJoin(label) {
  const identity = roomIdentity(label);
  return { type: 'join', room: identity.room, requestedRole: 'host', hostCredential: identity.credential };
}

async function startServer() {
  const server = createSyncServer({ port: 0, logger: silentLogger, transportLeadMs: 500 });
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
  send(host, { type: 'transport-command', playing: true, currentBar: -1, currentBeat: 0 });
  assert.equal((await hostInbox.next(message => message.type === 'error')).code, 'invalid-transport');
});
