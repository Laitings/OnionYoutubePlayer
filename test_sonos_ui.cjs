const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/static/app.js', 'utf8');
const section = source.slice(source.indexOf('// One transport/group operation'), source.indexOf('function closeCast()'));
function setup(post) {
  const timers = [], calls = [], notices = [];
  const context = vm.createContext({
    Promise, Date, Math, console,
    cast: {ip:'speaker', ips:[{ip:'speaker',name:'Room'}],id:'', playing:false, busy:false},
    S: {cur:{id:'song',title:'Song',artists:'Artist'},restored:false},
    audio: {paused:false,ended:false,error:null,_id:'song',currentTime:12,play:async()=>{},pause(){}},
    castBtn: {setAttribute(){}}, castPanel: {querySelectorAll:()=>[]},
    muted:false, both:()=>{}, scrubbing:false, dur:()=>200,
    toast:m=>notices.push(m),
    post:async(url,body)=>{calls.push({url,body}); return post(url,body);},
    api:async()=>({id:'song',state:'PLAYING',pos:12,dur:200}),
    setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout:()=>{},
    clearInterval:()=>{},setInterval:()=>1,
  });
  vm.runInContext(section,context);
  return {context,calls,notices,async sync(){vm.runInContext('castSync()',context);timers.pop()();await vm.runInContext('castWork',context);}};
}
(async()=>{
  const failure=setup(async()=>{throw Error('timeout');});
  await failure.sync();
  assert.equal(failure.context.cast.ip,'speaker','a failed command must retain selection');
  assert.equal(failure.calls.length,1,'no replay, pause or ungroup after failure');
  assert.equal(failure.context.cast.id,'','do not claim the command succeeded');
  await vm.runInContext('castPoll()',failure.context);
  assert.equal(failure.context.cast.id,'song','a lost success response is reconciled by polling');

  let release;
  const pending=setup(()=>new Promise(r=>release=r));
  vm.runInContext('castSync()',pending.context);
  // Use sync to flush the latest timer; the first timer is superseded in a real browser.
  const inFlight=pending.sync();
  await new Promise(r=>setImmediate(r));
  vm.runInContext('castStop(true, false)',pending.context);
  release(); await inFlight;
  assert.equal(pending.context.cast.ip,'');
  assert.equal(pending.context.cast.id,'','late success must not restore a released session');

  let unlock;
  const ordered=setup(async()=>{});
  ordered.context.block=new Promise(r=>unlock=r);
  vm.runInContext('castEnqueue(()=>block)',ordered.context);
  const queued=ordered.sync();
  await new Promise(r=>setImmediate(r));
  assert.equal(ordered.calls.length,0,'play must wait for the previous group operation');
  unlock();await queued;
  assert.equal(ordered.calls.length,1);
  assert.equal(ordered.context.cast.id,'song');

  const ended=setup(async()=>{});
  ended.context.audio.ended=true;
  await ended.sync();
  assert.equal(ended.calls.length,0,'silent browser ending must not pause Sonos');
  console.log('Sonos UI reliability tests passed (5 scenarios).');
})().catch(e=>{console.error(e);process.exitCode=1;});
