const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('crypto'),WebSocket=require('ws');
const {createSyncServer}=require('../server');
// Exact advertisement in v192 c4172f18; slices/overrides do NOT distinguish the interpretation.
const v192=['state-v1','song-v1','song-v2','slices-v1','beat-overrides-v1','effects-v1','rehearsal-v1'];
const modern=[...v192,'logical-beats-v1','practice-v1','song-boundary-v1'];
const plain={tempo:120,volume:1,Tracks:[{volume:1,currentBar:0,currentBeat:0,barSettings:[{beats:4,subdivision:1,rests:[]}]}],selectedTrackIndex:0,selectedBarIndexInContainer:0};
const affected=()=>({...plain,Tracks:[{...plain.Tracks[0],barSettings:[{beats:4,subdivision:1,beatSlices:{1:3},rests:[3]}]}]});
const snapshot = bars => ({muted:false,solo:false,volume:1,barSettings:bars,mainBeatSound:{sound:'Synth Kick',settings:{}},subdivisionSound:{sound:'Synth HiHat',settings:{}}});
async function fixture(t){const server=createSyncServer({port:0,logger:{log(){},warn(){}}});await new Promise(r=>server.wss.once('listening',r));const sockets=[];t.after(async()=>{for(const s of sockets)s.terminate();await server.close();});async function connect(caps=modern,host=false){const ws=new WebSocket(`ws://127.0.0.1:${server.wss.address().port}`),messages=[];ws.on('message',raw=>messages.push(JSON.parse(raw)));await new Promise(r=>ws.once('open',r));sockets.push(ws);const p={ws,send:m=>ws.send(JSON.stringify(m)),async next(type,predicate=()=>true){const end=Date.now()+2000;while(Date.now()<end){const i=messages.findIndex(m=>m.type===type&&predicate(m));if(i>=0)return messages.splice(i,1)[0];await new Promise(r=>setTimeout(r,5));}throw Error('No '+type+': '+JSON.stringify(messages));}};p.send({type:'join',room,requestedRole:host?'host':'client',...(host?{hostCredential:credential}:{}),capabilities:caps});return p;}const credential=crypto.randomBytes(32).toString('hex'),room='logical_'+crypto.createHash('sha256').update(credential).digest('hex').slice(0,32),host=await connect(modern,true);return {host,room,connect,server};}
test('LOGIC-1 v192 live-state incompatibility rolls host back; modern state excludes v192 late joins',async t=>{
 const f=await fixture(t);assert.ok((await f.host.next('joined')).capabilities.includes('logical-beats-v1'));
 f.host.send({type:'state',payload:plain});const old=await f.connect(v192);await old.next('joined');
 f.host.send({type:'state',payload:affected()});assert.equal((await f.host.next('error')).code,'incompatible-client');assert.deepEqual((await f.host.next('state',m=>m.authoritativeRefresh)).payload.Tracks,plain.Tracks);
 old.ws.terminate();await new Promise(r=>old.ws.once('close',r));f.host.send({type:'state',payload:affected()});f.host.send({type:'state-request'});assert.deepEqual((await f.host.next('state')).payload.Tracks[0].barSettings[0].rests,[3]);
 const late=await f.connect(v192);assert.equal((await late.next('error')).code,'incompatible-client');const capable=await f.connect();await capable.next('joined');assert.deepEqual((await capable.next('state')).payload.Tracks,affected().Tracks);
});
test('LOGIC-1 queued section overrides require logical semantics even when the live Tracks are plain',async t=>{
 const f=await fixture(t);await f.host.next('joined');f.host.send({type:'state',payload:plain});f.host.send({type:'transport-command',playing:true,currentBar:0,currentBeat:0});await f.host.next('transport');
 const old=await f.connect([...v192,'song-boundary-v1']);await old.next('joined');
 const song={version:2,enabled:true,name:'Affected snapshot',sections:[{name:'A',startBar:0,tempo:120,repeats:1,tracks:[snapshot(affected().Tracks[0].barSettings)]}]};
 f.host.send({type:'song-change-command',change:{version:1,song,sectionIndex:0,startBar:0,effectiveAt:Date.now()+500}});assert.equal((await f.host.next('error')).code,'incompatible-client');assert.ok(![...f.server.rooms.values()][0].pendingSongChange);
 old.ws.terminate();await new Promise(r=>old.ws.once('close',r));f.host.send({type:'song-change-command',change:{version:1,song,sectionIndex:0,startBar:0,effectiveAt:Date.now()+500}});await f.host.next('song-change',m=>!m.cancelled);
 const late=await f.connect([...v192,'song-boundary-v1']);assert.equal((await late.next('error')).code,'incompatible-client');
});
for(const field of ['rests','velocities','beatSounds'])test('LOGIC-1 section state with sliced '+field+' rejects a v192 peer',async t=>{
 const f=await fixture(t);await f.host.next('joined');f.host.send({type:'state',payload:plain});const old=await f.connect(v192);await old.next('joined');const bar={beats:4,subdivision:1,rests:[],beatSlices:{1:3},[field]:field==='rests'?[3]:field==='velocities'?{3:.5}:{3:{mainBeatSound:{sound:'Synth Kick',settings:{}}}}};const song={version:2,enabled:true,name:'Section',sections:[{name:'A',startBar:0,tempo:120,repeats:1,tracks:[snapshot([bar])]}]};f.host.send({type:'state',payload:{...plain,song}});assert.equal((await f.host.next('error')).code,'incompatible-client');await f.host.next('state',m=>m.authoritativeRefresh);
});
