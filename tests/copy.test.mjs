import test from 'node:test';
import assert from 'node:assert/strict';
import {markdownLink,installMarkdownCopy} from '../extension/copy.js';
test('Markdown copies title syntax and URL verbatim without escaping',()=>{
 assert.equal(markdownLink({title:'A [B] *C* &amp;\nD',url:'https://example.com/a(b)?x=%20&y=1'}),'[A [B] *C* &amp; D](https://example.com/a(b)?x=%20&y=1)');
 assert.equal(markdownLink({title:'',url:'https://example.com/'}),'[https://example.com/](https://example.com/)');
 assert.throws(()=>markdownLink({}),/URL/);
});
function fixture(){
 let command,listener,exists=false,creates=0,fail=false;const writes=[],session={},notifications=[];
 const api={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,getContexts:async()=>exists?[{}]:[],sendMessage:async m=>{writes.push(m.text);return fail?{ok:false,error:'denied'}:{ok:true};},onMessage:{addListener:f=>listener=f}},
 offscreen:{createDocument:async()=>{creates++;exists=true;}},commands:{onCommand:{addListener:f=>command=f}},
 tabs:{sendMessage:async(id,message)=>{notifications.push({id,message});return {shown:true};},query:async()=>[{id:1,title:'Title',url:'https://example.com'}]},storage:{session:{set:async v=>Object.assign(session,v)}},action:Object.fromEntries(['setBadgeText','setBadgeBackgroundColor','setTitle','openPopup'].map(k=>[k,async()=>{}]))};
 const boot=()=>installMarkdownCopy(api);boot();
 const request=()=>new Promise(resolve=>listener({type:'copy-markdown'},{id:'test',url:api.runtime.getURL('status.html')},resolve));
 return {api,boot,request,writes,session,notifications,get creates(){return creates;},set fail(v){fail=v;},command:(name='copy-markdown')=>command(name,{title:'Shortcut',url:'https://example.org'})};
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

test('success and failure notify the source tab without exposing its URL',async()=>{
 const f=fixture();await f.request();assert.deepEqual(f.notifications,[{id:1,message:{type:'copy-result',ok:true,message:'Markdown形式でコピーしました'}}]);
 f.fail=true;await f.request();assert.equal(f.notifications[1].message.ok,false);
});
test('missing page receiver shows a short native notification without opening details',async()=>{
 const f=fixture();const notices=[];let opened=0;
 f.api.tabs.sendMessage=async()=>{throw Error('no receiver');};
 f.api.notifications={create:async(id,options)=>notices.push({id,options})};
 f.api.action.openPopup=async()=>{opened++;};
 assert.equal((await f.request()).ok,true);assert.equal(opened,0);
 assert.equal(notices[0].options.message,'Markdown形式でコピーしました');
 assert.equal(notices[0].options.silent,true);
 f.command('copy-url');await new Promise(r=>setImmediate(r));
 assert.equal(notices[1].options.message,'URLをコピーしました');
 f.fail=true;assert.equal((await f.request()).ok,false);
 assert.match(notices[2].options.message,/denied/);assert.equal(opened,0);
});
test('notification failure never changes a successful copy or opens details',async()=>{
 const f=fixture();f.api.tabs.sendMessage=async()=>({shown:false});
 f.api.notifications={create:async()=>{throw Error('disabled');}};
 f.api.action.openPopup=async()=>assert.fail('unexpected details popup');
 assert.equal((await f.request()).ok,true);
});

test('URL command copies only the invocation URL',async()=>{
 const f=fixture();f.command('copy-url');await new Promise(r=>setImmediate(r));assert.deepEqual(f.writes,['https://example.org']);
});

test('an old open page gets a toast receiver without reloading or native notification',async()=>{
 const f=fixture();let injected=false;const deliveries=[];
 f.api.tabs.sendMessage=async(id,message)=>{if(!injected)throw Error('no receiver');deliveries.push({id,message});return {shown:true};};
 f.api.scripting={executeScript:async options=>{assert.deepEqual(options,{target:{tabId:1,frameIds:[0]},files:['copy-toast.js']});injected=true;}};
 f.api.notifications={create:async()=>assert.fail('unexpected native notification')};
 assert.equal((await f.request()).ok,true);
 assert.equal(deliveries[0].message.message,'Markdown形式でコピーしました');
 assert.deepEqual(f.session.copyResult.notification,{channel:'page',shown:true});
});
test('unavailable native notification records its error separately from copy success',async()=>{
 const f=fixture();f.api.tabs.sendMessage=async()=>{throw Error('no receiver');};
 f.api.scripting={executeScript:async()=>{throw Error('restricted page');}};
 f.api.notifications={create:async()=>{throw Error('notifications disabled');}};
 const result=await f.request();assert.equal(result.ok,true);
 assert.deepEqual(result.notification,{channel:'none',error:'notifications disabled'});
});
