import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
test('page guard captures only the first trusted interaction without page data',()=>{
 const listeners=new Map(),messages=[];
 const window={addEventListener:(type,fn,options)=>{assert.equal(options.capture,true);listeners.set(type,fn);},removeEventListener:type=>listeners.delete(type)};
 vm.runInNewContext(readFileSync(new URL('../extension/interaction.js',import.meta.url),'utf8'),{window,chrome:{runtime:{sendMessage:async message=>messages.push(JSON.parse(JSON.stringify(message)))}}});
 listeners.get('click')({isTrusted:false});assert.equal(messages.length,0);assert.ok(listeners.has('pointerdown'));
 listeners.get('pointerdown')({isTrusted:true,target:{private:'ignored'}});
 assert.deepEqual(messages,[{type:'page-interaction'}]);assert.equal(listeners.size,0);
});
