const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const MAX_STATE_BYTES = 256 * 1024;
const SECURE_ROOM_SUFFIX = /_([a-f0-9]{32})$/i;
function requiresLogicalBeats(state) {
  const tracks = [...(Array.isArray(state?.Tracks) ? state.Tracks : []), ...(Array.isArray(state?.song?.sections) ? state.song.sections : []).flatMap(s => Array.isArray(s?.tracks) ? s.tracks : [])];
  return tracks.some(t => Array.isArray(t?.barSettings) && t.barSettings.some(b => b && Object.keys(b.beatSlices || {}).length > 0
    && (b.rests?.length > 0 || Object.keys(b.velocities || {}).length > 0 || Object.keys(b.beatSounds || {}).length > 0)));
}

function generatePeerId() {
  return crypto.randomBytes(8).toString('hex');
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoundedInteger(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validateJsonShape(value, depth = 0, path = '') {
  if (depth > 12) return false;
  // Only these exact musical bar paths may exceed the generic 64-key cap.
  // Typed validators bound both the index domain and every leaf/container.
  const slotPath = /^(Tracks\[\]|song\.sections\[\]\.tracks\[\])\.barSettings\[\]\.(velocities|beatSounds|beatSlices|beatSliceAnchors)$/.exec(path);
  if (slotPath) return validateBarMaps({ [slotPath[2]]: value });
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 512;
  if (Array.isArray(value)) {
    return value.length <= 256 && value.every(item => validateJsonShape(item, depth + 1, `${path}[]`));
  }
  if (typeof value !== 'object') return false;
  const keys = Object.keys(value);
  return keys.length <= 64
    && keys.every(key => key.length <= 64 && !['outputOffsetMs','audioLatencyOffset','outputLatencyMs','baseLatencyMs','outputCorrectionMs'].includes(key) && validateJsonShape(value[key], depth + 1, path ? `${path}.${key}` : key));
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every(key => allowedKeys.has(key));
}

const PUBLIC_NUMERIC_SOUND_SETTINGS = new Set([
  'volume', 'startFrequency', 'endFrequency', 'attack', 'decay', 'sustain', 'release', 'pitchEnvelopeTime', 'pitchShift',
  'bodyFrequencyStart', 'bodyFrequencyEnd', 'noiseFilterFrequency', 'filterFrequency', 'frequency', 'frequency1', 'frequency2', 'qValue', 'detune',
  'trimStart', 'trimEnd', 'highPassFrequency', 'lowPassFrequency', 'distortion', 'delayMix', 'delayTime', 'delayFeedback', 'reverbMix', 'reverbFeedback', 'probability'
]);
const PUBLIC_BOOLEAN_SOUND_SETTINGS = new Set(['reverse', 'allowOverlap', 'retrigger', 'fxBypass']);

function validateSnapshotSound(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && hasOnlyKeys(value, new Set(['sound', 'settings']))
    && typeof value.sound === 'string' && value.sound.length >= 1 && value.sound.length <= 64
    && !/^Recording:/i.test(value.sound)
    && value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings)
    && Object.entries(value.settings).every(([key, setting]) =>
      (PUBLIC_NUMERIC_SOUND_SETTINGS.has(key) && isFiniteNumber(setting))
      || (PUBLIC_BOOLEAN_SOUND_SETTINGS.has(key) && typeof setting === 'boolean')
      || (key === 'type' && ['sine', 'square', 'sawtooth', 'triangle'].includes(setting)));
}

// Musical slot maps are typed containers, never generic metadata bags.
function validateSlotMap(value, validateEntry) {
  return value === undefined || (value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length <= 512
    && Object.entries(value).every(([key, entry]) => /^(0|[1-9]\d{0,2})$/.test(key)
      && Number(key) <= 511 && validateEntry(entry)));
}

function validateBeatOverrides(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && hasOnlyKeys(value, new Set(['mainBeatSound', 'subdivisionSound']))
    && (value.mainBeatSound === undefined || validateSnapshotSound(value.mainBeatSound))
    && (value.subdivisionSound === undefined || validateSnapshotSound(value.subdivisionSound));
}

function validateBarMaps(bar) {
  return validateSlotMap(bar.velocities, value => isFiniteNumber(value) && value >= 0 && value <= 1)
    && validateSlotMap(bar.beatSounds, validateBeatOverrides)
    && validateSlotMap(bar.beatSlices, value => [2, 3, 4, 6, 8, 16, 32].includes(value))
    && validateSlotMap(bar.beatSliceAnchors, value => isBoundedInteger(value, 0, 511));
}

function validateSnapshotTrack(track) {
  if (!track || typeof track !== 'object' || Array.isArray(track)
    || !hasOnlyKeys(track, new Set([
      'name', 'barSettings', 'muted', 'solo', 'volume', 'pitchShift', 'swing', 'mainBeatSound', 'subdivisionSound'
    ]))
    || (track.name !== undefined && (typeof track.name !== 'string' || track.name.length < 1 || track.name.length > 64))
    || !Array.isArray(track.barSettings) || track.barSettings.length < 1 || track.barSettings.length > 64
    || typeof track.muted !== 'boolean' || typeof track.solo !== 'boolean'
    || !isFiniteNumber(track.volume) || track.volume < 0 || track.volume > 1
    || (track.pitchShift !== undefined && !isBoundedInteger(track.pitchShift, -12, 12))
    || (track.swing !== undefined && (!isFiniteNumber(track.swing) || track.swing < 0 || track.swing > 100))
    || !validateSnapshotSound(track.mainBeatSound) || !validateSnapshotSound(track.subdivisionSound)) return false;
  return track.barSettings.every(bar => bar && typeof bar === 'object' && !Array.isArray(bar)
    && hasOnlyKeys(bar, new Set(['beats', 'subdivision', 'rests', 'velocities', 'beatSounds', 'beatSlices', 'beatSliceAnchors']))
    && validateBarMaps(bar)
    && isBoundedInteger(bar.beats, 1, 64)
    && isFiniteNumber(bar.subdivision) && bar.subdivision >= 0.125 && bar.subdivision <= 16
    && Array.isArray(bar.rests) && bar.rests.length <= 256
    && bar.rests.every(rest => isBoundedInteger(rest, 0, 1023)));
}

function parseCapabilities(value) {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.length > 16) return null;
  const capabilities = new Set();
  for (const capability of value) {
    if (typeof capability !== 'string' || capability.length < 1 || capability.length > 32) return null;
    capabilities.add(capability);
  }
  return capabilities;
}

function validatePractice(value) {
  const keys=['version','enabled','mode','startBpm','targetBpm','bpmStep','stepBars','onMaxAction','warmupBars','rampBars','targetBars','recoveryBars','audibleBars','silentBars'];
  return value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===keys.length && Object.keys(value).every(k=>keys.includes(k))
    && value.version===1 && typeof value.enabled==='boolean' && ['step','ramp'].includes(value.mode) && ['hold','stop','reset'].includes(value.onMaxAction)
    && ['startBpm','targetBpm'].every(k=>isFiniteNumber(value[k])&&value[k]>=20&&value[k]<=300)
    && isBoundedInteger(value.bpmStep,1,100)
    && ['stepBars','rampBars','targetBars','recoveryBars','audibleBars'].every(k=>isBoundedInteger(value[k],1,128))
    && ['warmupBars','silentBars'].every(k=>isBoundedInteger(value[k],0,128));
}
function validateState(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.practice !== undefined && !validatePractice(payload.practice)) return false;
  if (!isBoundedInteger(payload.tempo, 20, 400)) return false;
  if (!isFiniteNumber(payload.volume) || payload.volume < 0 || payload.volume > 1) return false;
  if (payload.countInBars !== undefined && !isBoundedInteger(payload.countInBars, 0, 8)) return false;
  if (!Array.isArray(payload.Tracks) || payload.Tracks.length < 1 || payload.Tracks.length > 32) return false;
  if (!validateJsonShape(payload)) return false;

  if (payload.song !== undefined) {
    const song = payload.song;
    if (!song || typeof song !== 'object' || Array.isArray(song)
      || !hasOnlyKeys(song, new Set(['version', 'enabled', 'name', 'sections']))
      || ![1, 2].includes(song.version)
      || typeof song.enabled !== 'boolean'
      || typeof song.name !== 'string' || song.name.length > 80
      || !Array.isArray(song.sections) || song.sections.length < 1 || song.sections.length > 32) return false;
    let previousStartBar = -1;
    for (const section of song.sections) {
      if (!section || typeof section !== 'object' || Array.isArray(section)
        || typeof section.name !== 'string' || section.name.length < 1 || section.name.length > 48
        || !isBoundedInteger(section.startBar, 0, 63)
        || section.startBar <= previousStartBar
        || !isBoundedInteger(section.tempo, 20, 300)) return false;
      if (song.version === 1) {
        if (!hasOnlyKeys(section, new Set(['name', 'startBar', 'tempo']))) return false;
      } else if (!hasOnlyKeys(section, new Set(['name', 'startBar', 'tempo', 'repeats', 'tracks']))
        || !isBoundedInteger(section.repeats, 1, 16)
        || (section.tracks !== undefined
          && (!Array.isArray(section.tracks) || section.tracks.length < 1 || section.tracks.length > 16
            || !section.tracks.every(validateSnapshotTrack)))) return false;
      previousStartBar = section.startBar;
    }
    if (song.sections[0].startBar !== 0) return false;
  }

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
    // currentBeat indexes expanded playback slots, not unsliced base beats.
    // Match beatTiming.getBeatSlots without allocating its bounded slot array.
    const baseSlots = currentBar.subdivision < 1
      ? Math.max(1, Math.floor(currentBar.beats * currentBar.subdivision))
      : Math.round(currentBar.beats * currentBar.subdivision);
    let slotCount = baseSlots;
    for (const [index, count] of Object.entries(currentBar.beatSlices || {})) {
      if (Number(index) < baseSlots) slotCount += count - 1;
    }
    if (!isBoundedInteger(track.currentBeat, 0, slotCount - 1)) return false;
  }

  if (payload.song && payload.song.sections.some(section => section.startBar >= payload.Tracks[0].barSettings.length)) return false;
  if (!Number.isInteger(payload.selectedTrackIndex) || payload.selectedTrackIndex < -1 || payload.selectedTrackIndex >= payload.Tracks.length) return false;
  const selectedTrack = payload.selectedTrackIndex >= 0 ? payload.Tracks[payload.selectedTrackIndex] : null;
  if (!Number.isInteger(payload.selectedBarIndexInContainer) || payload.selectedBarIndexInContainer < -1) return false;
  if (selectedTrack && payload.selectedBarIndexInContainer >= selectedTrack.barSettings.length) return false;
  return true;
}

function requiredSongCapability(payload) {
  if (!payload?.song?.enabled) return null;
  return payload.song.version === 2 ? 'song-v2' : 'song-v1';
}

function tempoForBar(payload, currentBar) {
  if (!payload?.song?.enabled) return payload.tempo;
  let activeSection = payload.song.sections[0];
  for (const section of payload.song.sections) {
    if (section.startBar > currentBar) break;
    activeSection = section;
  }
  return activeSection.tempo;
}

function countInForTransport(room, currentBar, startsAt) {
  const payload = room.state?.payload;
  const countInBars = payload?.countInBars || 0;
  if (!countInBars) return null;
  const track = payload.Tracks[0];
  const bar = track.barSettings[currentBar % track.barSettings.length];
  const beatIntervalMs = 60000 / tempoForBar(payload, currentBar);
  const totalBeats = countInBars * bar.beats;
  return {
    startsAt,
    totalBeats,
    beatIntervalMs,
    accentEvery: bar.beats
  };
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

function credentialDigest(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 128
    ? crypto.createHash('sha256').update(value).digest('hex') : null;
}

function matchesRoomCredential(room, value) {
  const digest = credentialDigest(value);
  return Boolean(digest && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(room.credentialDigest)));
}

function createSyncServer({
  port = Number(process.env.PORT) || 10000,
  logger = console,
  transportLeadMs = Number.isFinite(Number(process.env.TRANSPORT_LEAD_MS))
    ? Number(process.env.TRANSPORT_LEAD_MS)
    : null,
  minimumTransportLeadMs = 150,
  fallbackTransportLeadMs = 200,
  maximumTransportLeadMs = 500,
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
  // Bounded lifetime tombstones prevent an original room proof reclaiming a
  // deliberately closed/expired room after a credential rotation.
  const closedRooms = new Set();
  let admissionScope = crypto.randomBytes(16).toString('hex');
  const scopedRoom = /^v2_([a-f0-9]{32})_[A-Za-z0-9_]+_([a-f0-9]{32})$/;
  // Only the current admission namespace needs tombstones. Older namespaces
  // remain valid solely for already-retained active/recovering room objects.
  const retireRoom = room => {
    if (!room.scoped || room.scope !== admissionScope) return;
    closedRooms.add(room.id);
    if (closedRooms.size >= maxRooms) {
      admissionScope = crypto.randomBytes(16).toString('hex');
      closedRooms.clear();
    }
  };

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
  const probeLatency = ws => {
    const probeId = crypto.randomBytes(8).toString('hex');
    ws.latencyProbes.set(probeId, Date.now());
    while (ws.latencyProbes.size > 2) ws.latencyProbes.delete(ws.latencyProbes.keys().next().value);
    ws.ping(probeId);
  };
  const transportLeadForRoom = room => {
    if (Number.isFinite(transportLeadMs)) return Math.max(0, transportLeadMs);
    const now = Date.now();
    const reportedRoundTrips = [...room.clients]
      .filter(client => now - client.roundTripMeasuredAt <= 30000)
      .map(client => client.roundTripTime)
      .filter(isFiniteNumber);
    if (!reportedRoundTrips.length) return fallbackTransportLeadMs;
    const slowestRoundTrip = Math.max(...reportedRoundTrips);
    return Math.min(
      maximumTransportLeadMs,
      Math.max(minimumTransportLeadMs, Math.ceil((slowestRoundTrip / 2) + 100))
    );
  };
  const supportsRehearsal = ws => ws?.capabilities?.has('rehearsal-v1');
  const rehearsalState = room => ({
    type: 'rehearsal-room', room: room.id, supported: true,
    hostPeerId: room.host?.peerId || null,
    hostConnected: Boolean(room.host && room.clients.has(room.host)),
    playing: room.transport.playing,
    participants: [...room.clients].map(client => ({
      peerId: client.peerId, name: client.readiness?.name || `Peer ${client.peerId.slice(0, 6)}`,
      role: room.host === client ? 'host' : 'client', connected: true,
      supported: Boolean(supportsRehearsal(client)),
      ready: supportsRehearsal(client) ? (client.readiness?.ready || false) : null,
      audioState: client.readiness?.audioState || 'unknown',
      clockQuality: client.readiness?.clockQuality || 'unknown',
      rtt: client.readiness?.rtt ?? null,
      reportedAt: client.readiness?.reportedAt || null
    })),
    requests: [...(room.controlRequests || [])].filter(id => [...room.clients].some(c => c.peerId === id)),
    cue: room.cue || null
  });
  const broadcastRehearsal = room => {
    const message = rehearsalState(room);
    for (const client of room.clients) if (supportsRehearsal(client)) send(client, message);
  };
  const broadcastPresence = room => {
    broadcast(room, { type: 'presence', room: room.id, clientCount: clientCount(room) });
    broadcastRehearsal(room);
  };

  const sanitizeState = payload => {
    // v192 included this device-only key. Discard it at the legacy envelope
    // seam; reject it at every nested schema boundary and never rebroadcast it.
    if(payload && typeof payload==='object' && !Array.isArray(payload)) {
      const {audioLatencyOffset:_legacyTiming,...shared}=payload;payload=shared;
    }
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

  const cancelSongChange = room => {
    clearTimeout(room.songChangeTimer);room.songChangeTimer=null;
    if(room.pendingSongChange){const commandId=room.pendingSongChange.commandId;room.pendingSongChange=null;room.revision++;broadcast(room,{type:'song-change',room:room.id,revision:room.revision,cancelled:true,...(commandId ? {commandId} : {})});}
  };
  const closeRoom = (room, reason = 'host-disconnected') => {
    cancelSongChange(room);
    clearTimeout(room.recoveryTimer);
    retireRoom(room);
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
    ws.roundTripTime = null;
    ws.latencyProbes = new Map();
    ws.messageWindowStartedAt = Date.now();
    ws.messageCount = 0;
    ws.stateMessageCount = 0;

    ws.on('pong', payload => {
      ws.isAlive = true;
      const probeId = payload.toString();
      const sentAt = ws.latencyProbes.get(probeId);
      if (!isFiniteNumber(sentAt)) return;
      ws.latencyProbes.delete(probeId);
      ws.roundTripTime = Math.max(0, Date.now() - sentAt);
      ws.roundTripMeasuredAt = Date.now();
    });

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

      if (data.type === 'hello') {
        if (typeof data.challenge !== 'string' || !/^[a-f0-9]{32}$/.test(data.challenge)) {
          send(ws, { type: 'error', code: 'invalid-hello', message: 'A valid challenge is required.' });
          return;
        }
        send(ws, { type: 'hello', challenge: data.challenge, roomScope: admissionScope,
          capabilities: ['room-scope-v2'] });
        return;
      }

      if (data.type === 'join') {
        const roomId = typeof data.room === 'string' && data.room.length <= 128 ? data.room : '';
        if (!roomId) {
          send(ws, { type: 'error', code: 'invalid-room', message: 'A room ID is required.' });
          return;
        }
        const capabilities = parseCapabilities(data.capabilities);
        if (!capabilities) {
          send(ws, { type: 'error', code: 'invalid-capabilities', message: 'Client capabilities failed validation.' });
          return;
        }

        if (ws.roomId && ws.roomId !== roomId) {
          send(ws, { type: 'error', code: 'already-joined', message: 'Leave the current room before joining another.' });
          return;
        }

        let room = rooms.get(roomId);
        const scoped = roomId.startsWith('v2_');
        const scopeMatch = scoped ? roomId.match(scopedRoom) : null;
        // This check must precede proof validation and ignores all advertised
        // capabilities: removing a capability cannot downgrade a v2 identity.
        if (scoped && (!scopeMatch || (!room && scopeMatch[1] !== admissionScope))) {
          send(ws, { type: 'error', code: 'room-expired', message: 'This room expired. Ask for a new room link.' });
          return;
        }
        if (closedRooms.has(roomId)) {
          send(ws, { type: 'error', code: 'room-closed', message: 'This room was closed. Create a new room.' });
          return;
        }
        const roomSongCapability = requiredSongCapability(room?.state?.payload);
        if ((requiresLogicalBeats(room?.state?.payload) || requiresLogicalBeats({song:room?.pendingSongChange?.song})) && !capabilities.has('logical-beats-v1')) {
          send(ws,{type:'error',code:'incompatible-client',message:'This room requires logical-beats-v1 for sliced beat overrides.'});return;
        }
        if ((room?.state?.payload?.practice?.enabled && !capabilities.has('practice-v1')) || (room?.pendingSongChange && !capabilities.has('song-boundary-v1'))) {
          send(ws,{type:'error',code:'incompatible-client',message:'Advanced practice/queued transport support is required.'});return;
        }
        if (roomSongCapability && !capabilities.has(roomSongCapability)) {
          send(ws, { type: 'error', code: 'incompatible-client', message: 'This room requires song mode support.' });
          return;
        }
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
            id: roomId, scoped, scope: scopeMatch?.[1] || null,
            clients: new Set(),
            host: ws,
            credentialDigest: credentialDigest(data.hostCredential),
            controlRequests: new Set(),
            participantSessions: new Map(),
            recoverable: capabilities.has('rehearsal-v1'),
            legacySignaling: false,
            revision: 0,
            state: null,
            transport: {
              playing: false, effectiveAt: Date.now(), currentBar: 0, currentBeat: 0, revision: 0, leadTime: 0
            }
          };
          rooms.set(roomId, room);
          createdRoom = true;
        } else if (data.requestedRole === 'host') {
          if (!matchesRoomCredential(room, data.hostCredential)) {
            send(ws, { type: 'error', code: 'invalid-host-credential', message: 'Host credential is invalid.' });
            return;
          }

          const previousHost = room.host;
          if (previousHost !== ws) {
            room.clients.delete(previousHost);
            previousHost.roomId = null;
            previousHost.isHost = false;
            cancelSongChange(room);
            room.host = ws;
            replacedHost = true;
            if (room.recoverable) {
              room.revision += 1;
              if (room.state) room.state = { revision: room.revision, payload: { ...room.state.payload, isPlaying: false } };
              room.transport = { playing: false, effectiveAt: Date.now(), currentBar: room.transport.currentBar,
                currentBeat: room.transport.currentBeat, repeatIteration: 0, revision: room.revision, leadTime: 0 };
              broadcast(room, { type: 'transport', room: room.id, ...room.transport });
            }
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
        ws.capabilities = capabilities;
        let participantCredential;
        if (supportsRehearsal(ws)) {
          const digest = credentialDigest(data.participantCredential);
          const previousId = digest && room.participantSessions.get(digest);
          if (previousId) {
            const previous = [...room.clients].find(c => c !== ws && c.peerId === previousId);
            // A participant session is not a host credential.
            if (!previous || previous !== room.host) {
              if (previous) {
                room.clients.delete(previous);
                previous.roomId = null;
                previous.close(4002, 'Participant reconnected elsewhere');
              }
              ws.peerId = previousId;
            }
          }
          participantCredential = previousId ? data.participantCredential : crypto.randomBytes(32).toString('hex');
          room.participantSessions.set(credentialDigest(participantCredential), ws.peerId);
          while (room.participantSessions.size > (maxClientsPerRoom + 1) * 2) {
            room.participantSessions.delete(room.participantSessions.keys().next().value);
          }
        }
        if (ws.isHost) clearTimeout(room.recoveryTimer);

        send(ws, {
          type: 'joined', room: roomId, peerId: ws.peerId,
          isHost: ws.isHost, clientCount: clientCount(room), createdRoom, replacedHost,
          capabilities: ['rehearsal-v1','practice-v1','song-boundary-v1','logical-beats-v1'],
          ...(participantCredential ? { participantCredential } : {})
        });
        if ((!ws.isHost || replacedHost) && room.state) {
          send(ws, { type: 'state', room: roomId, revision: room.state.revision, payload: room.state.payload });
        }
        if(room.pendingSongChange)send(ws,{type:'song-change',room:roomId,...room.pendingSongChange});
        if (!ws.isHost || replacedHost) {
          send(ws, { type: 'transport', room: roomId, ...room.transport });
        }
        if (replacedHost) send(ws, { type: 'replacement-replay-complete', room: roomId });
        if (!ws.isHost && room.legacySignaling) {
          send(room.host, { type: 'peer-joined', room: roomId, peerId: ws.peerId });
        }
        broadcastPresence(room);
        probeLatency(ws);
        return;
      }

      const room = requireJoinedRoom(ws, data);
      if (!room) return;
      if (data.room !== undefined && data.room !== room.id) {
        send(ws, { type: 'error', code: 'room-mismatch', message: 'Message belongs to another room.' });
        return;
      }
      if (['readiness', 'control-request', 'handoff-control', 'rehearsal-cue'].includes(data.type)) {
        if (raw.length > 1024) {
          send(ws, { type: 'error', code: 'rehearsal-too-large', message: 'Rehearsal message exceeds size limit.' });
          return;
        }
        if (ws.rehearsalWindow !== ws.messageWindowStartedAt) {
          ws.rehearsalWindow = ws.messageWindowStartedAt; ws.rehearsalMessages = 0;
        }
        if (++ws.rehearsalMessages > 40) {
          send(ws, { type: 'error', code: 'rehearsal-rate-limit', message: 'Rehearsal messages are arriving too quickly.' });
          return;
        }
      }

      switch (data.type) {
        case 'rehearsal-cue': {
          if (!requireHost(ws, room)) return;
          if (!supportsRehearsal(ws) || !hasOnlyKeys(data, new Set(['type', 'room', 'text', 'bar']))
            || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 140
            || /[<>\x00-\x1f\x7f]/.test(data.text)
            || !(data.bar === null || isBoundedInteger(data.bar, 0, 4095))) {
            send(ws, { type: 'error', code: 'invalid-cue', message: 'Cue must contain plain text up to 140 characters and an optional bar.' });
            return;
          }
          room.cue = { text: data.text, bar: data.bar, sequence: (room.cue?.sequence || 0) + 1, sentAt: now };
          broadcastRehearsal(room);
          break;
        }
        case 'control-request': {
          if (!room.scoped || !supportsRehearsal(ws) || !supportsRehearsal(room.host) || room.host === ws
            || !hasOnlyKeys(data, new Set(['type', 'room']))) {
            send(ws, { type: 'error', code: 'unsupported-capability', message: 'A capable connected host and client are required.' });
            return;
          }
          room.controlRequests.add(ws.peerId);
          broadcastRehearsal(room);
          break;
        }
        case 'handoff-control': {
          if (!requireHost(ws, room)) return;
          if (room.transport.playing || room.transport.effectiveAt > now) {
            send(ws, { type: 'error', code: 'handoff-playing', message: 'Stop playback before handing off control.' });
            return;
          }
          const target = [...room.clients].find(c => c.peerId === data.peerId && c !== ws && c.readyState === WebSocket.OPEN);
          if (!room.scoped || !supportsRehearsal(ws) || !target || !supportsRehearsal(target) || !room.controlRequests.has(target.peerId)
            || !hasOnlyKeys(data, new Set(['type', 'room', 'peerId']))) {
            send(ws, { type: 'error', code: 'invalid-handoff', message: 'Choose a connected participant who requested control.' });
            return;
          }
          const hostCredential = crypto.randomBytes(32).toString('hex');
          room.credentialDigest = credentialDigest(hostCredential);
          cancelSongChange(room);
          room.host = target;
          room.recoverable = true;
          ws.isHost = false;
          target.isHost = true;
          room.controlRequests.clear();
          room.revision += 1;
          room.transport = { ...room.transport, revision: room.revision };
          send(ws, { type: 'role-changed', room: room.id, isHost: false });
          send(target, { type: 'host-granted', room: room.id, hostCredential });
          broadcast(room, { type: 'transport', room: room.id, ...room.transport });
          broadcastRehearsal(room);
          break;
        }
        case 'readiness': {
          if (!supportsRehearsal(ws)) {
            send(ws, { type: 'error', code: 'unsupported-capability', message: 'Rehearsal support is required.' });
            return;
          }
          if (!hasOnlyKeys(data, new Set(['type', 'room', 'ready', 'name', 'audioState', 'clockQuality', 'rtt']))
            || typeof data.ready !== 'boolean' || typeof data.name !== 'string'
            || data.name.length < 1 || data.name.length > 40 || /[<>\x00-\x1f\x7f]/.test(data.name)
            || !['running', 'suspended', 'interrupted', 'closed', 'unavailable'].includes(data.audioState)
            || !['good', 'fair', 'poor', 'syncing', 'offline'].includes(data.clockQuality)
            || !(data.rtt === null || (isFiniteNumber(data.rtt) && data.rtt >= 0 && data.rtt <= 60000))) {
            send(ws, { type: 'error', code: 'invalid-readiness', message: 'Readiness report failed validation.' });
            return;
          }
          if (ws.lastReadinessAt && now - ws.lastReadinessAt < 100) {
            send(ws, { type: 'error', code: 'rehearsal-rate-limit', message: 'Reports are arriving too quickly.' });
            return;
          }
          ws.lastReadinessAt = now;
          ws.readiness = { ready: data.ready, name: data.name, audioState: data.audioState,
            clockQuality: data.clockQuality, rtt: data.rtt, reportedAt: now };
          broadcastRehearsal(room);
          break;
        }
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
        case 'state-ack':
          // Receipt diagnostics only: never accept an ACK as state or authority.
          // The existing per-socket message/byte limits still apply.
          if (raw.length > 1024 || !hasOnlyKeys(data,new Set(['type','room','revision','checksum']))
            || !Number.isSafeInteger(data.revision) || data.revision < 0 || data.revision > room.revision
            || typeof data.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(data.checksum)) {
            send(ws,{type:'error',code:'invalid-state-ack',message:'State acknowledgement failed validation.'});
          }
          break;
        case 'state-recovery-request':
          if (raw.length > 1024 || !hasOnlyKeys(data,new Set(['type','room','revision','reason']))
            || !Number.isSafeInteger(data.revision) || data.revision < 0 || data.reason !== 'invalid-state-payload') {
            send(ws,{type:'error',code:'invalid-state-recovery-request',message:'State recovery request failed validation.'});
            break;
          }
          // Same canonical, read-only recovery path as a legacy state request.
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
          const songCapability = requiredSongCapability(payload);
          if ((songCapability && [...room.clients].some(client => !client.capabilities?.has(songCapability)))
            || (requiresLogicalBeats(payload) && [...room.clients].some(client=>!client.capabilities?.has('logical-beats-v1')))
            || (payload.practice?.enabled && [...room.clients].some(client=>!client.capabilities?.has('practice-v1')))) {
            send(ws, { type: 'error', code: 'incompatible-client', message: 'Every room member must support the required song/practice/logical-beats-v1 semantics.' });
            if (room.state) {
              send(ws, {
                type: 'state', room: room.id, revision: room.state.revision,
                payload: room.state.payload, authoritativeRefresh: true
              });
            }
            return;
          }
          room.revision += 1;
          // Runtime position/presence refreshes do not invalidate a staged edit.
          const musicalIdentity = state => JSON.stringify(state && {
            tempo:state.tempo,volume:state.volume,countInBars:state.countInBars,
            practice:state.practice,song:state.song,customSounds:state.customSounds,
            Tracks:state.Tracks.map(({currentBar,currentBeat,nextBeatTime,songRepeatIteration,...music})=>music)
          });
          const previous = room.state?.payload;
          const sameMusic = musicalIdentity(previous) === musicalIdentity(payload);
          // Applying the active section resolves its already-declared tempo into
          // the host's root tempo. It is playback progress, not a new musical edit.
          // Non-derived tempo edits and every other musical change still cancel.
          const derivedSectionTempo = room.transport.playing && payload.song?.enabled
            && payload.tempo === tempoForBar(payload, payload.Tracks[0].currentBar)
            && previous && musicalIdentity({...previous, tempo:payload.tempo}) === musicalIdentity(payload);
          if (!sameMusic && !derivedSectionTempo) cancelSongChange(room);
          room.state = { revision: room.revision, payload };
          broadcast(room, { type: 'state', room: room.id, revision: room.revision, payload }, ws);
          break;
        }
        case 'song-change-command': {
          if(!requireHost(ws,room))return;
          if([...room.clients].some(c=>!c.capabilities?.has('song-boundary-v1'))){send(ws,{type:'error',code:'incompatible-client',message:'Every peer must support queued musical boundaries.'});return;}
          const c=data.change;
          if(c===null){cancelSongChange(room);break;}
          const p=room.state?.payload;
          if (requiresLogicalBeats({song:c?.song}) && [...room.clients].some(client=>!client.capabilities?.has('logical-beats-v1'))) {
            send(ws,{type:'error',code:'incompatible-client',message:'Every peer must support logical-beats-v1 for this queued song.'});
            if(room.state)send(ws,{type:'state',room:room.id,revision:room.state.revision,payload:room.state.payload,authoritativeRefresh:true});
            return;
          }
          if(!room.transport.playing || !p || !c || typeof c!=='object' || Array.isArray(c) || !hasOnlyKeys(c,new Set(['version','song','sectionIndex','startBar','effectiveAt','commandId'])) || c.version!==1
            || (c.commandId !== undefined && (typeof c.commandId !== 'string' || !/^[a-f0-9]{32}$/.test(c.commandId)))
            || !isFiniteNumber(c.effectiveAt) || c.effectiveAt<Date.now()+200 || c.effectiveAt>Date.now()+600000
            || !isBoundedInteger(c.startBar,0,p.Tracks[0].barSettings.length-1)
            || (c.sectionIndex!==null && !isBoundedInteger(c.sectionIndex,0,(c.song?.sections?.length||0)-1))
            || (c.sectionIndex!==null && c.song?.sections?.[c.sectionIndex]?.startBar!==c.startBar)
            || !validateState({...p,song:c.song}) || c.song?.version!==2
            || Buffer.byteLength(JSON.stringify({...p,song:c.song}), 'utf8') > MAX_STATE_BYTES
            || [...room.clients].some(client=>!client.capabilities?.has('song-v2'))){send(ws,{type:'error',code:'invalid-song-change',message:'Invalid or incompatible queued song.'});return;}
          cancelSongChange(room);room.revision++;
          const command={...c,revision:room.revision};room.pendingSongChange=command;
          broadcast(room,{type:'song-change',room:room.id,...command});
          const host=room.host;
          room.songChangeTimer=setTimeout(()=>{
            if(room.pendingSongChange!==command || rooms.get(room.id)!==room || room.host!==host || !room.transport.playing)return;
            room.pendingSongChange=null;room.songChangeTimer=null;
            const revision=++room.revision;
            room.state={revision,payload:{...room.state.payload,song:command.song}};
            room.transport={...room.transport,effectiveAt:command.effectiveAt,currentBar:command.startBar,currentBeat:0,repeatIteration:0,revision};
          },Math.max(0,command.effectiveAt-Date.now()));
          room.songChangeTimer.unref?.();break;
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
          cancelSongChange(room);
          const transportLead = transportLeadForRoom(room);
          const startsAt = Date.now() + transportLead;
          const countIn = data.playing ? countInForTransport(room, data.currentBar, startsAt) : null;
          room.transport = {
            playing: data.playing,
            effectiveAt: startsAt + (countIn ? countIn.totalBeats * countIn.beatIntervalMs : 0),
            practiceEpochAt: startsAt + (countIn ? countIn.totalBeats * countIn.beatIntervalMs : 0),
            currentBar: data.currentBar,
            currentBeat: data.currentBeat,
            repeatIteration: 0,
            revision: room.revision,
            leadTime: transportLead,
            ...(countIn ? { countIn } : {})
          };
          broadcast(room, { type: 'transport', room: room.id, ...room.transport });
          broadcastRehearsal(room);
          break;
        }
        case 'playback-sync-pulse': {
          if (!requireHost(ws, room)) return;
          const pulseTime = Number(data.nextBeatWallTime);
          const currentTime = Date.now();
          if (!room.transport.playing
            || (room.transport.countIn && currentTime < room.transport.effectiveAt)
            || !Number.isFinite(pulseTime)
            || pulseTime < currentTime - 5000
            || pulseTime > currentTime + 10000
            || !isBoundedInteger(data.currentBar, 0, 4095)
            || !isBoundedInteger(data.currentBeat, 0, 4095)
            || (data.repeatIteration !== undefined && !isBoundedInteger(data.repeatIteration, 0, 15))) {
            send(ws, { type: 'error', code: 'invalid-sync-pulse', message: 'Playback sync pulse failed validation.' });
            return;
          }
          room.transport = {
            playing: true,
            effectiveAt: pulseTime,
            practiceEpochAt: room.transport.practiceEpochAt,
            currentBar: data.currentBar,
            currentBeat: data.currentBeat,
            repeatIteration: data.repeatIteration || 0,
            revision: room.transport.revision,
            leadTime: room.transport.leadTime || 0
          };
          broadcast(room, {
            type: 'playback-sync-pulse', room: room.id,
            nextBeatWallTime: pulseTime,
            currentBar: data.currentBar,
            currentBeat: data.currentBeat,
            repeatIteration: data.repeatIteration || 0,
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
      room.controlRequests.delete(ws.peerId);
      if(room.host===ws)cancelSongChange(room);
      if (room.host === ws && room.recoverable) {
        room.revision += 1;
        if (room.state) room.state = { revision: room.revision, payload: { ...room.state.payload, isPlaying: false } };
        room.transport = { playing: false, effectiveAt: Date.now(), currentBar: room.transport.currentBar,
          currentBeat: room.transport.currentBeat, repeatIteration: 0, revision: room.revision, leadTime: 0 };
        broadcast(room, { type: 'transport', room: room.id, ...room.transport });
        broadcastPresence(room);
        room.recoveryTimer = setTimeout(() => {
          if (rooms.get(room.id) === room && !room.clients.has(room.host)) closeRoom(room, 'recovery-expired');
        }, 5 * 60 * 1000);
        room.recoveryTimer.unref();
      } else if (room.host === ws) closeRoom(room, 'host-disconnected');
      else broadcastPresence(room);
    });

    ws.on('error', error => logger.warn(`WebSocket error for ${ws.peerId}: ${error.message}`));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) ws.terminate();
      else {
        ws.isAlive = false;
        probeLatency(ws);
      }
    }
  }, 10000);
  heartbeat.unref();

  const close = () => new Promise(resolve => {
    clearInterval(heartbeat);
    for (const room of rooms.values()) clearTimeout(room.recoveryTimer);
    rooms.clear();
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
