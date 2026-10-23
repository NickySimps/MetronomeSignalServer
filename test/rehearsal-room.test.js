const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const WebSocket = require('ws');
const { createSyncServer } = require('../server');
const cap = ['rehearsal-v1'];
async function fixture(t) {
  const server = createSyncServer({ port: 0, logger: { log() {}, warn() {} } });
  await new Promise(r => server.wss.once('listening', r));
  t.after(() => server.close());
  const credential = crypto.randomBytes(32).toString('hex');
  // Negotiate a public admission namespace; the proof is not a credential.
  const probe = new WebSocket(`ws://127.0.0.1:${server.wss.address().port}`);
  await new Promise(r => probe.once('open', r));
  const hello = new Promise(r => probe.once('message', b => r(JSON.parse(b))));
  probe.send(JSON.stringify({type:'hello',challenge:crypto.randomBytes(16).toString('hex')}));
  const roomScope = (await hello).roomScope; probe.close();
  const room = `v2_${roomScope}_rehearsal_${crypto.createHash('sha256').update(credential).digest('hex').slice(0,32)}`;
  async function connect(role = 'client', capabilities = cap, extra = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.wss.address().port}`);
    const queue = []; ws.on('message', b => queue.push(JSON.parse(b)));
    await new Promise(r => ws.once('open', r));
    const send = m => ws.send(JSON.stringify(m));
    const next = async (type, predicate = () => true) => {
      for (let n=0;n<150;n++) {
        const i=queue.findIndex(m=>m.type===type && predicate(m));
        if(i>=0) return queue.splice(i,1)[0];
        await new Promise(r=>setTimeout(r,10));
      }
      throw Error(`Missing ${type}: ${JSON.stringify(queue)}`);
    };
    send({ type:'join', room, requestedRole:role, capabilities, ...(role==='host'?{hostCredential:credential}:{}), ...extra });
    return { ws, send, next, queue };
  }
  return {server,room,credential,connect};
}
test('capability roster is explicit, legacy readiness is unknown, reports are self-only and bounded', async t => {
  const f=await fixture(t), h=await f.connect('host');
  const joined=await h.next('joined'); assert.ok(joined.capabilities.includes('rehearsal-v1'));
  const c=await f.connect(); const cj=await c.next('joined');
  const old=await f.connect('client',[]); const oj=await old.next('joined');
  const roster=await h.next('rehearsal-room', m=>m.participants.length===3);
  assert.equal(roster.participants.find(p=>p.peerId===oj.peerId).ready,null);
  c.send({type:'readiness',ready:true,name:'Player',audioState:'suspended',clockQuality:'good',rtt:12});
  const report=await h.next('rehearsal-room',m=>m.participants.some(p=>p.peerId===cj.peerId&&p.ready===true));
  assert.equal(report.participants.find(p=>p.peerId===cj.peerId).audioState,'suspended');
  c.send({type:'readiness',ready:true,name:'x'.repeat(41),audioState:'running',clockQuality:'good',rtt:12});
  assert.equal((await c.next('error')).code,'invalid-readiness');
  c.send({type:'readiness',peerId:joined.peerId,ready:true,name:'Player',audioState:'running',clockQuality:'good',rtt:12});
  assert.equal((await c.next('error')).code,'invalid-readiness');
  assert.equal(JSON.stringify(report).includes('credential'),false);
});
test('handoff requires explicit request, capable target and stopped transport; rotates credentials atomically', async t => {
  const f=await fixture(t), h=await f.connect('host'); const hj=await h.next('joined');
  const c=await f.connect(); const cj=await c.next('joined');
  c.send({type:'control-request'});
  await h.next('rehearsal-room',m=>m.requests.includes(cj.peerId));
  c.send({type:'handoff-control',peerId:cj.peerId});
  assert.equal((await c.next('error')).code,'host-only');
  h.send({type:'transport-command',playing:true,currentBar:0,currentBeat:0}); await h.next('transport');
  h.send({type:'handoff-control',peerId:cj.peerId});
  assert.equal((await h.next('error')).code,'handoff-playing');
  h.send({type:'transport-command',playing:false,currentBar:0,currentBeat:0}); const stop=await h.next('transport',m=>!m.playing);
  h.send({type:'handoff-control',peerId:cj.peerId});
  assert.equal((await h.next('error')).code,'handoff-playing');
  await new Promise(r=>setTimeout(r,Math.max(0,stop.effectiveAt-Date.now())+10));
  h.send({type:'handoff-control',peerId:cj.peerId});
  const grant=await c.next('host-granted'); assert.ok(grant.hostCredential.length>=32);
  const changed=await h.next('role-changed'); assert.equal(changed.isHost,false);
  h.send({type:'transport-command',playing:true,currentBar:0,currentBeat:0});
  assert.equal((await h.next('error')).code,'host-only');
  const stale=await f.connect('host'); assert.equal((await stale.next('error')).code,'invalid-host-credential');
  const resumed=await f.connect('host',cap,{hostCredential:grant.hostCredential});
  assert.equal((await resumed.next('joined')).isHost,true);
  assert.notEqual(hj.peerId,cj.peerId);
});
test('capable host loss retains stopped snapshot without promotion; reconnect identity survives and explicit close forbids recreation', async t => {
  const f=await fixture(t), h=await f.connect('host'); await h.next('joined');
  const c=await f.connect(); const cj=await c.next('joined'); assert.ok(cj.participantCredential);
  h.send({type:'transport-command',playing:true,currentBar:2,currentBeat:1}); await c.next('transport',m=>m.playing);
  h.send({type:'state',payload:{tempo:120,volume:1,Tracks:[{barSettings:[{beats:4,subdivision:1,rests:[]}],volume:1,currentBar:0,currentBeat:0}],selectedTrackIndex:0,selectedBarIndexInContainer:0,isPlaying:true}});
  await c.next('state');
  h.ws.close();
  const stopped=await c.next('transport',m=>!m.playing&&m.currentBar===2);
  assert.equal(f.server.rooms.get(f.room).state.payload.isPlaying,false);
  assert.ok(stopped.revision>0);
  const paused=await c.next('rehearsal-room',m=>!m.hostConnected);
  assert.equal(paused.participants.some(p=>p.role==='host'),false);
  const restored=await f.connect('host'); assert.equal((await restored.next('joined')).replacedHost,true);
  assert.equal((await restored.next('transport')).playing,false);
  c.ws.close(); await new Promise(r=>setTimeout(r,30));
  const resumed=await f.connect('client',cap,{participantCredential:cj.participantCredential});
  assert.equal((await resumed.next('joined')).peerId,cj.peerId);
  restored.send({type:'close-room'}); await resumed.next('room-closed');
  const closed=await f.connect('host'); assert.equal((await closed.next('error')).code,'room-closed');
});
test('cues are bounded host-authorized room-scoped sequenced and cached for late join', async t => {
  const f=await fixture(t), h=await f.connect('host'); await h.next('joined');
  const c=await f.connect(); await c.next('joined');
  c.send({type:'rehearsal-cue',text:'Attack',bar:0}); assert.equal((await c.next('error')).code,'host-only');
  h.send({type:'rehearsal-cue',text:'x'.repeat(141),bar:null}); assert.equal((await h.next('error')).code,'invalid-cue');
  h.send({type:'rehearsal-cue',text:'Watch the cutoff',bar:0});
  const cue=(await c.next('rehearsal-room',m=>m.cue)).cue;
  assert.equal(cue.text,'Watch the cutoff'); assert.equal(cue.bar,0); assert.equal(cue.sequence,1);
  const late=await f.connect(); await late.next('joined'); assert.deepEqual((await late.next('rehearsal-room',m=>m.cue)).cue,cue);
  h.send({type:'rehearsal-cue',room:'other',text:'Wrong room',bar:null});
  assert.equal((await h.next('error')).code,'room-mismatch');
});
test('mixed capability, disconnect and duplicate-approval races cannot confer authority', async t => {
  const f=await fixture(t), h=await f.connect('host');await h.next('joined');
  const old=await f.connect('client',[]);const oj=await old.next('joined');
  old.send({type:'control-request'});assert.equal((await old.next('error')).code,'unsupported-capability');
  h.send({type:'handoff-control',peerId:oj.peerId});assert.equal((await h.next('error')).code,'invalid-handoff');
  const c=await f.connect();const cj=await c.next('joined');c.send({type:'control-request'});
  await h.next('rehearsal-room',m=>m.requests.includes(cj.peerId));
  await new Promise(r=>{c.ws.once('close',r);c.ws.close();});
  await h.next('rehearsal-room',m=>!m.participants.some(p=>p.peerId===cj.peerId));
  h.send({type:'handoff-control',peerId:cj.peerId});assert.equal((await h.next('error')).code,'invalid-handoff');
  const d=await f.connect();const dj=await d.next('joined');d.send({type:'control-request'});
  await h.next('rehearsal-room',m=>m.requests.includes(dj.peerId));
  h.send({type:'handoff-control',peerId:dj.peerId});h.send({type:'handoff-control',peerId:oj.peerId});
  await d.next('host-granted');assert.equal((await h.next('error')).code,'host-only');
  h.ws.close();await new Promise(r=>setTimeout(r,30));
  d.send({type:'rehearsal-cue',text:'Still host',bar:null});
  await d.next('rehearsal-room',m=>m.hostConnected&&m.cue?.text==='Still host');
});
test('capable live host replacement recovers stopped rather than replaying active transport', async t => {
  const f=await fixture(t),h=await f.connect('host');await h.next('joined');
  h.send({type:'transport-command',playing:true,currentBar:3,currentBeat:1});const playing=await h.next('transport');
  const replacement=await f.connect('host');assert.equal((await replacement.next('joined')).replacedHost,true);
  const stopped=await replacement.next('transport');assert.equal(stopped.playing,false);assert.ok(stopped.revision>playing.revision);
  assert.equal((await h.next('host-replaced')).room,f.room);
});
test('rehearsal payload size and rates are bounded, private extras are rejected', async t => {
  const f=await fixture(t),h=await f.connect('host');await h.next('joined');
  h.send({type:'readiness',payload:'x'.repeat(2000)});assert.equal((await h.next('error')).code,'rehearsal-too-large');
  h.send({type:'rehearsal-cue',text:'Secret',bar:null,hostCredential:'secret'});assert.equal((await h.next('error')).code,'invalid-cue');
  for(let i=0;i<41;i++) h.send({type:'control-request'});
  assert.equal((await h.next('error',m=>m.code==='rehearsal-rate-limit')).code,'rehearsal-rate-limit');
});
