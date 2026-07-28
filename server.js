const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const MAX_STATE_BYTES = 256 * 1024;
const SECURE_ROOM_SUFFIX = /_([a-f0-9]{32})$/i;

function generatePeerId() {
  return crypto.randomBytes(8).toString('hex');
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoundedInteger(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validateJsonShape(value, depth = 0) {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 512;
  if (Array.isArray(value)) {
    return value.length <= 256 && value.every(item => validateJsonShape(item, depth + 1));
  }
  if (typeof value !== 'object') return false;
  const keys = Object.keys(value);
  return keys.length <= 64
    && keys.every(key => key.length <= 64 && validateJsonShape(value[key], depth + 1));
}

function validateState(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (!isFiniteNumber(payload.tempo) || payload.tempo < 20 || payload.tempo > 400) return false;
  if (!isFiniteNumber(payload.volume) || payload.volume < 0 || payload.volume > 1) return false;
  if (!Array.isArray(payload.Tracks) || payload.Tracks.length < 1 || payload.Tracks.length > 32) return false;
  if (!validateJsonShape(payload)) return false;

  for (const track of payload.Tracks) {
    if (!track || typeof track !== 'object' || !Array.isArray(track.barSettings)) return false;
    if (track.barSettings.length < 1 || track.barSettings.length > 64) return false;
    if (!isFiniteNumber(track.volume) || track.volume < 0 || track.volume > 1) return false;
    if (!isBoundedInteger(track.currentBar, 0, track.barSettings.length - 1)) return false;

    for (const bar of track.barSettings) {
      if (!bar || !isBoundedInteger(bar.beats, 1, 64)) return false;
      if (!isFiniteNumber(bar.subdivision) || bar.subdivision < 0.125 || bar.subdivision > 16) return false;
      if (!Array.isArray(bar.rests) || bar.rests.length > 256) return false;
    }

    const currentBar = track.barSettings[track.currentBar];
    const maxBeat = Math.ceil(currentBar.beats * currentBar.subdivision) - 1;
    if (!isBoundedInteger(track.currentBeat, 0, Math.max(0, maxBeat))) return false;
  }

  if (!Number.isInteger(payload.selectedTrackIndex) || payload.selectedTrackIndex < -1 || payload.selectedTrackIndex >= payload.Tracks.length) return false;
  const selectedTrack = payload.selectedTrackIndex >= 0 ? payload.Tracks[payload.selectedTrackIndex] : null;
  if (!Number.isInteger(payload.selectedBarIndexInContainer) || payload.selectedBarIndexInContainer < -1) return false;
  if (selectedTrack && payload.selectedBarIndexInContainer >= selectedTrack.barSettings.length) return false;
  return true;
}

function hasValidHostCredential(roomId, credential) {
  const match = roomId.match(SECURE_ROOM_SUFFIX);
  if (!match) return false;
  if (typeof credential !== 'string' || credential.length < 32 || credential.length > 128) return false;
  const digest = crypto.createHash('sha256').update(credential).digest('hex').slice(0, 32);
  const expected = Buffer.from(match[1].toLowerCase(), 'hex');
  const actual = Buffer.from(digest, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function createSyncServer({
  port = Number(process.env.PORT) || 10000,
  logger = console,
  transportLeadMs = 750,
  maxConnections = 1000,
  maxRooms = 500,
  maxClientsPerRoom = 32
} = {}) {
  const httpServer = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ service: 'metronominal-sync', status: 'ok' }));
  });
  const wss = new WebSocket.Server({ server: httpServer, maxPayload: 512 * 1024 });
  const rooms = new Map();

  httpServer.listen(port);

  const send = (ws, message) => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  };

  const broadcast = (room, message, exclude = null) => {
    for (const client of room.clients) {
      if (client !== exclude) send(client, message);
    }
  };

  const sendToPeer = (room, peerId, message) => {
    for (const client of room.clients) {
      if (client.peerId === peerId) return send(client, message);
    }
    return false;
  };

  const clientCount = room => Math.max(0, room.clients.size - 1);
  const broadcastPresence = room => broadcast(room, {
    type: 'presence', room: room.id, clientCount: clientCount(room)
  });

  const sanitizeState = payload => {
    if (!validateState(payload)) return null;
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_STATE_BYTES) return null;
    const state = { ...payload };
    delete state.selectedTheme;
    delete state.recordings;
    delete state.serializedRecordings;
    return state;
  };

  const requireJoinedRoom = (ws, data) => {
    const roomId = ws.roomId || data.room;
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || !room.clients.has(ws)) {
      send(ws, { type: 'error', code: 'not-joined', message: 'Join a room first.' });
      return null;
    }
    return room;
  };

  const requireHost = (ws, room) => {
    if (room.host === ws) return true;
    send(ws, { type: 'error', code: 'host-only', message: 'Only the room host can do that.' });
    return false;
  };

  const closeRoom = (room, reason = 'host-disconnected') => {
    broadcast(room, { type: 'room-closed', room: room.id, reason }, room.host);
    for (const client of room.clients) {
      client.roomId = null;
      client.isHost = false;
    }
    rooms.delete(room.id);
  };

  wss.on('listening', () => {
    logger.log(`Metronominal synchronization server listening on port ${httpServer.address().port}`);
  });

  wss.on('connection', ws => {
    if (wss.clients.size > maxConnections) {
      ws.close(1013, 'Server connection limit reached');
      return;
    }

    ws.peerId = generatePeerId();
    ws.roomId = null;
    ws.isHost = false;
    ws.isAlive = true;
    ws.messageWindowStartedAt = Date.now();
    ws.messageCount = 0;
    ws.stateMessageCount = 0;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', raw => {
      const now = Date.now();
      if (now - ws.messageWindowStartedAt >= 10000) {
        ws.messageWindowStartedAt = now;
        ws.messageCount = 0;
        ws.stateMessageCount = 0;
      }
      ws.messageCount += 1;
      if (ws.messageCount > 300) {
        ws.close(1008, 'Message rate limit exceeded');
        return;
      }

      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: 'error', code: 'invalid-json', message: 'Messages must be valid JSON.' });
        return;
      }

      if (!data || typeof data.type !== 'string' || data.type.length > 64) {
        send(ws, { type: 'error', code: 'invalid-message', message: 'A valid message type is required.' });
        return;
      }

      if (data.type === 'ping' || data.type === 'time-sync') {
        if (isFiniteNumber(data.t0) && Math.abs(Date.now() - data.t0) <= 60000) {
          send(ws, {
            type: data.type === 'ping' ? 'pong' : 'time-sync-response',
            t0: data.t0,
            serverTime: Date.now()
          });
        }
        return;
      }

      if (data.type === 'join') {
        const roomId = String(data.room || '').trim().slice(0, 128);
        if (!roomId) {
          send(ws, { type: 'error', code: 'invalid-room', message: 'A room ID is required.' });
          return;
        }

        if (ws.roomId && ws.roomId !== roomId) {
          send(ws, { type: 'error', code: 'already-joined', message: 'Leave the current room before joining another.' });
          return;
        }

        let room = rooms.get(roomId);
        let createdRoom = false;
        let replacedHost = false;
        if (!room) {
          if (data.requestedRole !== 'host') {
            send(ws, { type: 'error', code: 'room-not-found', message: 'The host is not connected.' });
            return;
          }

          if (!hasValidHostCredential(roomId, data.hostCredential)) {
            send(ws, { type: 'error', code: 'invalid-host-credential', message: 'Host credential is invalid.' });
            return;
          }
          if (rooms.size >= maxRooms) {
            send(ws, { type: 'error', code: 'room-limit', message: 'Server room limit reached.' });
            return;
          }

          room = {
            id: roomId,
            clients: new Set(),
            host: ws,
            legacySignaling: false,
            revision: 0,
            state: null,
            transport: { playing: false, effectiveAt: Date.now(), currentBar: 0, currentBeat: 0, revision: 0 }
          };
          rooms.set(roomId, room);
          createdRoom = true;
        } else if (data.requestedRole === 'host') {
          if (!hasValidHostCredential(roomId, data.hostCredential)) {
            send(ws, { type: 'error', code: 'invalid-host-credential', message: 'Host credential is invalid.' });
            return;
          }

          const previousHost = room.host;
          if (previousHost !== ws) {
            room.clients.delete(previousHost);
            previousHost.roomId = null;
            previousHost.isHost = false;
            room.host = ws;
            replacedHost = true;
            send(previousHost, { type: 'host-replaced', room: roomId });
            setTimeout(() => previousHost.close(4002, 'Host reconnected elsewhere'), 100);
          }
        }

        if (!room.clients.has(ws) && room.clients.size >= maxClientsPerRoom + 1) {
          send(ws, { type: 'error', code: 'room-full', message: 'This room is full.' });
          return;
        }

        room.clients.add(ws);
        ws.roomId = roomId;
        ws.isHost = room.host === ws;

        send(ws, {
          type: 'joined', room: roomId, peerId: ws.peerId,
          isHost: ws.isHost, clientCount: clientCount(room), createdRoom, replacedHost
        });
        if ((!ws.isHost || replacedHost) && room.state) {
          send(ws, { type: 'state', room: roomId, revision: room.state.revision, payload: room.state.payload });
        }
        if (!ws.isHost || replacedHost) {
          send(ws, { type: 'transport', room: roomId, ...room.transport });
        }
        if (replacedHost) send(ws, { type: 'replacement-replay-complete', room: roomId });
        if (!ws.isHost && room.legacySignaling) {
          send(room.host, { type: 'peer-joined', room: roomId, peerId: ws.peerId });
        }
        broadcastPresence(room);
        return;
      }

      const room = requireJoinedRoom(ws, data);
      if (!room) return;

      switch (data.type) {
        case 'offer':
        case 'answer':
        case 'candidate': {
          if (!room.legacySignaling || !data.peerId) {
            send(ws, { type: 'error', code: 'unsupported-signaling', message: 'WebRTC signaling is disabled for this room.' });
            return;
          }
          sendToPeer(room, data.peerId, {
            type: data.type, room: room.id, peerId: ws.peerId, [data.type]: data[data.type]
          });
          break;
        }
        case 'state-request':
          if (room.state) {
            send(ws, {
              type: 'state', room: room.id, revision: room.state.revision,
              payload: room.state.payload, authoritativeRefresh: true
            });
          }
          break;
        case 'state': {
          if (!requireHost(ws, room)) return;
          ws.stateMessageCount += 1;
          if (ws.stateMessageCount > 120) {
            send(ws, { type: 'error', code: 'state-rate-limit', message: 'State updates are arriving too quickly.' });
            return;
          }
          const payload = sanitizeState(data.payload);
          if (!payload) {
            send(ws, { type: 'error', code: 'invalid-state', message: 'State payload failed validation.' });
            return;
          }
          room.revision += 1;
          room.state = { revision: room.revision, payload };
          broadcast(room, { type: 'state', room: room.id, revision: room.revision, payload }, ws);
          break;
        }
        case 'transport-command': {
          if (!requireHost(ws, room)) return;
          if (typeof data.playing !== 'boolean'
            || !isBoundedInteger(data.currentBar, 0, 4095)
            || !isBoundedInteger(data.currentBeat, 0, 4095)) {
            send(ws, { type: 'error', code: 'invalid-transport', message: 'Transport command failed validation.' });
            return;
          }
          room.revision += 1;
          room.transport = {
            playing: data.playing,
            effectiveAt: Date.now() + transportLeadMs,
            currentBar: data.currentBar,
            currentBeat: data.currentBeat,
            revision: room.revision
          };
          broadcast(room, { type: 'transport', room: room.id, ...room.transport });
          break;
        }
        case 'playback-sync-pulse': {
          if (!requireHost(ws, room)) return;
          const pulseTime = Number(data.nextBeatWallTime);
          const currentTime = Date.now();
          if (!room.transport.playing
            || !Number.isFinite(pulseTime)
            || pulseTime < currentTime - 5000
            || pulseTime > currentTime + 10000
            || !isBoundedInteger(data.currentBar, 0, 4095)
            || !isBoundedInteger(data.currentBeat, 0, 4095)) {
            send(ws, { type: 'error', code: 'invalid-sync-pulse', message: 'Playback sync pulse failed validation.' });
            return;
          }
          room.transport = {
            playing: true,
            effectiveAt: pulseTime,
            currentBar: data.currentBar,
            currentBeat: data.currentBeat,
            revision: room.transport.revision
          };
          broadcast(room, {
            type: 'playback-sync-pulse', room: room.id,
            nextBeatWallTime: pulseTime,
            currentBar: data.currentBar,
            currentBeat: data.currentBeat,
            revision: room.transport.revision
          }, ws);
          break;
        }
        case 'playback-sync-request':
          send(ws, { type: 'transport', room: room.id, ...room.transport });
          break;
        case 'close-room':
          if (!requireHost(ws, room)) return;
          closeRoom(room, 'host-disconnected');
          break;
        default:
          send(ws, { type: 'error', code: 'unknown-type', message: 'Unknown message type.' });
      }
    });

    ws.on('close', () => {
      const room = ws.roomId ? rooms.get(ws.roomId) : null;
      if (!room) return;
      room.clients.delete(ws);
      if (room.host === ws) closeRoom(room, 'host-disconnected');
      else broadcastPresence(room);
    });

    ws.on('error', error => logger.warn(`WebSocket error for ${ws.peerId}: ${error.message}`));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) ws.terminate();
      else {
        ws.isAlive = false;
        ws.ping();
      }
    }
  }, 30000);
  heartbeat.unref();

  const close = () => new Promise(resolve => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    wss.close(() => httpServer.close(resolve));
  });

  return { wss, rooms, close };
}

if (require.main === module) {
  const server = createSyncServer();
  const shutdown = signal => {
    console.log(`${signal} received, closing server...`);
    server.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { createSyncServer, hasValidHostCredential, validateState };
