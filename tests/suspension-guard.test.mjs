import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const guard=readFileSync(new URL('../extension/suspension-guard.js',import.meta.url),'utf8');
const watcher=readFileSync(new URL('../extension/media-watch.js',import.meta.url),'utf8');
class Event{constructor(type,options={}){this.type=type;Object.defineProperties(this,Object.getOwnPropertyDescriptors(options));}}
function surface(){
  const listeners=new Map();const window={addEventListener:(type,fn)=>{listeners.set(type,[...(listeners.get(type)||[]),fn]);},dispatchEvent:e=>{for(const f of listeners.get(e.type)||[])f(e);}};
  window.top=window;return {window,listeners};
}
test('input protection is sticky, ignores synthetic events, and sends no input data',async()=>{
  const {window}=surface(),messages=[],store=new Map();let receive;
  const chrome={runtime:{id:'extension',sendMessage:async m=>{messages.push(m);return {token:'identity'};},onMessage:{addListener:f=>receive=f}}};
  vm.runInNewContext(guard,{window,chrome,sessionStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},Event});
  const probe=()=>{let reply;receive({type:'suspension-probe'},{id:'extension'},r=>reply=r);return reply;};
  window.dispatchEvent(new Event('__tab_tamer_media_state',{detail:{active:false,known:true}}));
  window.dispatchEvent(new Event('input',{isTrusted:false}));assert.equal(probe().dirty,false);
  window.dispatchEvent(new Event('input',{isTrusted:true,get value(){throw Error('must not read values');}}));assert.equal(probe().dirty,true);
  window.dispatchEvent(new Event('submit',{isTrusted:true}));assert.equal(probe().dirty,true);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)),[{type:'suspension-hello'}]);
  assert.deepEqual(Object.keys(probe()).sort(),['dirty','identityAvailable','media','mediaKnown','token','version']);
});
test('media flags follow new streams, stopped tracks and live peer connections without changing return values',async()=>{
  const {window}=surface();const states=[];window.addEventListener('__tab_tamer_media_state',e=>states.push(e.detail.active));
  const track={readyState:'live',addEventListener:()=>{}};const stream={getTracks:()=>[track]};
  const navigator={mediaDevices:{getUserMedia:async()=>stream,getDisplayMedia:async()=>{throw Error('cancelled');}}};
  class PC{constructor(){this.connectionState='new';}addEventListener(){}close(){this.connectionState='closed';}}
  window.RTCPeerConnection=PC;
  vm.runInNewContext(watcher,{window,navigator,CustomEvent:Event,Proxy,Reflect});
  window.dispatchEvent(new Event('__tab_tamer_media_probe'));assert.equal(states.at(-1),false);
  assert.equal(await navigator.mediaDevices.getUserMedia({audio:true}),stream);assert.equal(states.at(-1),true);
  track.readyState='ended';window.dispatchEvent(new Event('__tab_tamer_media_probe'));assert.equal(states.at(-1),false);
  const pc=new window.RTCPeerConnection();assert.ok(pc instanceof PC);assert.equal(states.at(-1),true);
  pc.close();assert.equal(states.at(-1),false);await assert.rejects(navigator.mediaDevices.getDisplayMedia(),/cancelled/);
});
