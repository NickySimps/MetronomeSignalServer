const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const WebSocket = require('ws');
const {createSyncServer} = require('../server');
const caps=['rehearsal-v1'];
async function boot(t, options={}) {
  const server=createSyncServer({port:0,logger:{log(){},warn(){}},...options});
  await new Promise(r=>server.wss.once('listening',r));t.after(()=>server.close());return server;
}
async function peer(server) {
  const ws=new WebSocket(`ws://127.0.0.1:${server.wss.address().port}`),queue=[];
  ws.on('message',b=>queue.push(JSON.parse(b)));await new Promise(r=>ws.once('open',r));
  const send=m=>ws.send(JSON.stringify(m));
  const next=async type=>{for(let i=0;i<100;i++){const n=queue.findIndex(m=>m.type===type);if(n>=0)return queue.splice(n,1)[0];await new Promise(r=>setTimeout(r,5));}throw Error(`Missing ${type}; types=${queue.map(m=>m.type+':'+(m.code||'')).join(',')}`);};
  return {ws,send,next};
}
async function scope(p) {const challenge=crypto.randomBytes(16).toString('hex');p.send({type:'hello',challenge});const h=await p.next('hello');assert.equal(h.challenge,challenge);assert.match(h.roomScope,/^[a-f0-9]{32}$/);return h.roomScope;}
function identity(scope) {const credential=crypto.randomBytes(32).toString('hex');return {room:`${scope?'v2_'+scope+'_':''}test_${crypto.createHash('sha256').update(credential).digest('hex').slice(0,32)}`,credential};}
async function join(p,id,role='host',credential=id.credential,capabilities=caps){p.send({type:'join',room:id.room,requestedRole:role,hostCredential:credential,capabilities});return p.next('joined');}
test('closed history does not consume active admission capacity',async t=>{
  const s=await boot(t,{maxRooms:2});
  for(let i=0;i<7;i++) {const p=await peer(s),id=identity();await join(p,id);p.send({type:'close-room'});await new Promise(r=>setTimeout(r,15));p.ws.close();}
  assert.equal(s.rooms.size,0);
});
test('scoped handoff credentials both expire across restart before legacy proof fallback',async t=>{
  const s=await boot(t),h=await peer(s),id=identity(await scope(h));await join(h,id);
  const c=await peer(s),cj=await join(c,id,'client');c.send({type:'control-request'});
  await new Promise(r=>setTimeout(r,20));h.send({type:'handoff-control',peerId:cj.peerId});
  const grant=await c.next('host-granted');await s.close();
  const restarted=await boot(t);
  for(const credential of [id.credential,grant.hostCredential])for(const capabilities of [caps,[]]) {
    const p=await peer(restarted);p.send({type:'join',room:id.room,requestedRole:'host',hostCredential:credential,capabilities});
    assert.equal((await p.next('error')).code,'room-expired');assert.equal(restarted.rooms.size,0);
  }
});
test('scope rollover bounds closed history while retaining active and recovering identities',async t=>{
  const s=await boot(t,{maxRooms:2}),h=await peer(s),initial=await scope(h),active=identity(initial);
  await join(h,active);const c=await peer(s);await join(c,active,'client');
  const retired=[];
  for(let i=0;i<9;i++){
    const p=await peer(s),id=identity(await scope(p));retired.push(id);await join(p,id);
    p.send({type:'close-room'});
    await new Promise(r=>setTimeout(r,10));
    assert.equal(s.rooms.size,1);p.ws.close();
  }
  assert.notEqual(await scope(c),initial);
  h.send({type:'rehearsal-cue',text:'Still authoritative',bar:null});
  // Discard earlier roster packets until the post-rollover cue arrives.
  let roster;do{roster=await c.next('rehearsal-room');}while(!roster.cue);
  assert.equal(roster.cue.text,'Still authoritative');
  h.ws.close();await new Promise(r=>setTimeout(r,20));
  const recovered=await peer(s);assert.equal((await join(recovered,active)).replacedHost,true);
  for(const id of retired){
    const p=await peer(s);p.send({type:'join',room:id.room,requestedRole:'host',hostCredential:id.credential,capabilities:[]});
    assert.ok(['room-expired','room-closed'].includes((await p.next('error')).code));
  }
  recovered.send({type:'close-room'});await c.next('room-closed');
  const stale=await peer(s);stale.send({type:'join',room:active.room,requestedRole:'host',hostCredential:active.credential});
  assert.equal((await stale.next('error')).code,'room-expired');
  const current=identity(await scope(stale));await join(stale,current);
  await s.close();const restarted=await boot(t);
  for(const id of [active,current]){
    const p=await peer(restarted);p.send({type:'join',room:id.room,requestedRole:'host',hostCredential:id.credential});
    assert.equal((await p.next('error')).code,'room-expired');
  }
});
test('legacy server-first synchronization remains available but cannot rotate authority',async t=>{
  const s=await boot(t),h=await peer(s),id=identity();const hj=await join(h,id,'host',id.credential,[]);
  const c=await peer(s),cj=await join(c,id,'client');
  h.send({type:'transport-command',playing:true,currentBar:0,currentBeat:0});
  let transport;do{transport=await c.next('transport');}while(!transport.playing);
  assert.equal(transport.playing,true);
  c.send({type:'control-request'});assert.equal((await c.next('error')).code,'unsupported-capability');
  h.send({type:'transport-command',playing:false,currentBar:0,currentBeat:0});
  await new Promise(r=>setTimeout(r,250));
  h.send({type:'handoff-control',peerId:cj.peerId});assert.equal((await h.next('error')).code,'invalid-handoff');
  assert.equal(s.rooms.get(id.room).host.peerId,hj.peerId);
});
test('malformed reserved v2 identities cannot downgrade into legacy proof admission',async t=>{
  const s=await boot(t);
  for(const capabilities of [[],caps])for(const prefix of ['v2_bad_', 'v2_'+ 'a'.repeat(32)+'_']){
    const id=identity(),p=await peer(s);p.send({type:'join',room:prefix+id.room,requestedRole:'host',hostCredential:id.credential,capabilities});
    assert.equal((await p.next('error')).code,'room-expired');
  }
  assert.equal(s.rooms.size,0);
});
