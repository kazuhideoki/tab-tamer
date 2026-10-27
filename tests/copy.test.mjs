import test from 'node:test';
import assert from 'node:assert/strict';
import {markdownLink,installMarkdownCopy} from '../extension/copy.js';
test('Markdown protects title syntax and URL delimiters without double encoding',()=>{
 assert.equal(markdownLink({title:'A [B] *C* &amp;\nD',url:'https://example.com/a(b)?x=%20&y=1'}),'[A \\[B\\] \\*C\\* \\&amp; D](https://example.com/a%28b%29?x=%20&amp;y=1)');
 assert.equal(markdownLink({title:'',url:'https://example.com/'}),'[https://example.com/](https://example.com/)');
 assert.throws(()=>markdownLink({}),/URL/);
});
function fixture(){
 let command,listener,exists=false,creates=0,fail=false;const writes=[],session={};
 const api={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,getContexts:async()=>exists?[{}]:[],sendMessage:async m=>{writes.push(m.text);return fail?{ok:false,error:'denied'}:{ok:true};},onMessage:{addListener:f=>listener=f}},
 offscreen:{createDocument:async()=>{creates++;exists=true;}},commands:{onCommand:{addListener:f=>command=f}},
 tabs:{query:async()=>[{title:'Title',url:'https://example.com'}]},storage:{session:{set:async v=>Object.assign(session,v)}},action:Object.fromEntries(['setBadgeText','setBadgeBackgroundColor','setTitle'].map(k=>[k,async()=>{}]))};
 const boot=()=>installMarkdownCopy(api);boot();
 const request=()=>new Promise(resolve=>listener({type:'copy-markdown'},{id:'test',url:api.runtime.getURL('status.html')},resolve));
 return {api,boot,request,writes,session,get creates(){return creates;},set fail(v){fail=v;},command:()=>command('copy-markdown',{title:'Shortcut',url:'https://example.org'})};
}
test('concurrent popup requests share one document and restart discovers existing document',async()=>{
 const f=fixture();await Promise.all([f.request(),f.request()]);assert.equal(f.creates,1);assert.equal(f.writes.length,2);
 f.boot();assert.equal((await f.request()).ok,true);assert.equal(f.creates,1);
});
test('failure is reported and a later attempt recovers',async()=>{
 const f=fixture();f.fail=true;assert.equal((await f.request()).error,'denied');assert.equal(f.session.copyResult.ok,false);
 f.fail=false;assert.equal((await f.request()).ok,true);
});
test('command uses the invocation tab',async()=>{
 const f=fixture();f.command();await new Promise(r=>setImmediate(r));assert.deepEqual(f.writes,['[Shortcut](https://example.org)']);
});
test('page messages cannot invoke clipboard writes',async()=>{
 let listener;const f=fixture();
 f.api.runtime.onMessage.addListener=fn=>listener=fn;f.boot();
 assert.equal(listener({type:'copy-markdown'},{id:'test',url:'https://example.com'},()=>assert.fail('unexpected reply')),undefined);
 await new Promise(r=>setImmediate(r));assert.equal(f.writes.length,0);
});
