import test from 'node:test';import assert from 'node:assert/strict';
import {validateConfig,urlKey,matchGroup,chooseSurvivor} from '../extension/policy.js';
import {sign,verify,envelope} from '../extension/auth.js';
const c=validateConfig({version:1,groups:[{id:'a',name:'A',color:'blue',urls:['https://example.com/a/*']}]});
test('strict validation rejects typos and unsafe shapes',()=>{
 for(const x of [{version:2},{version:1,dedup:{enabld:true}},{version:1,dedup:{enabled:'false'}},{version:1,groups:[{id:'a',name:'A',color:'black',urls:['*']}]}]) assert.throws(()=>validateConfig(x));
});
test('URL distinctions and explicit normalization',()=>{
 assert.notEqual(urlKey('https://example.com/a?x=1#b',c),urlKey('https://example.com/a?x=2#b',c));
 assert.notEqual(urlKey('https://example.com/a#b',c),urlKey('https://example.com/a#c',c));
 assert.equal(urlKey('http://example.com/a/',c),urlKey('https://example.com/a',c));
 assert.equal(urlKey('chrome://newtab/',c),null);
 const x=validateConfig({version:1,dedup:{prefer_https:false,ignore_trailing_slash:false,exclude:['https://example.com/private*']}});
 assert.notEqual(urlKey('http://example.com/a',x),urlKey('https://example.com/a',x));assert.equal(urlKey('https://example.com/private',x),null);
});
test('group matching is ordered, anchored, literal except star',()=>{
 assert.equal(matchGroup('https://example.com/a/1',c).id,'a');assert.equal(matchGroup('https://exampleXcom/a/1',c),undefined);assert.equal(matchGroup('https://other.test/?https://example.com/a/1',c),undefined);
});
test('survivors are older, normal-window, same privacy boundary and stable',()=>{
 const source={id:3,url:'https://example.com/a',windowId:1};
 const tabs=[{...source,id:1,status:'complete',windowType:'normal'},{...source,id:2,status:'complete',windowType:'normal',pinned:true}];
 assert.equal(chooseSurvivor(source,tabs,c,id=>id).id,2);
 assert.equal(chooseSurvivor(source,tabs.map(t=>({...t,incognito:true})),c,id=>id),null);
 assert.equal(chooseSurvivor(source,tabs.map(t=>({...t,pendingUrl:t.url})),c,id=>id),null);
 assert.equal(chooseSurvivor(source,tabs,c,id=>id===3?0:1),null);
});
test('authenticated envelope rejects changed content or signatures',async()=>{
 const good=await envelope({hello:'日本語'},'test-key');assert.deepEqual(await verify(good,'test-key'),{hello:'日本語'});
 await assert.rejects(verify({...good,body:good.body+' '},'test-key'));await assert.rejects(verify(good,'other-key'));
 assert.equal((await sign(good.body,'test-key')).length,64);
});
test('HTTPS survivor preference applies after pin preference',()=>{
 const source={id:3,url:'https://example.com/a',windowId:1};
 const tabs=[{...source,id:1,url:'http://example.com/a',status:'complete',windowType:'normal'},{...source,id:2,status:'complete',windowType:'normal'}];
 assert.equal(chooseSurvivor(source,tabs,c,id=>id).id,2);
 tabs[0].pinned=true;assert.equal(chooseSurvivor(source,tabs,c,id=>id).id,1);
});
