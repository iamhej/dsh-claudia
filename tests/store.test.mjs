import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, makeContext } from '../store.mjs';
// SQLite 打开数据库时要在同目录创建 journal 边文件，因此临时目录放系统 tmp 而不是项目内：
// 既不受工作目录的写入限制影响（否则必然 disk I/O error），也不再往仓库里堆 data-* 残留。
test('local journal persists, consent controls context, UI session can reset',t=>{
 const dir=mkdtempSync(join(tmpdir(),'claudia-store-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=resolve(dir,'store.sqlite');let store=new Store(file);
 const journal=store.addJournal('<b>walk</b>','2026-09-14T10:00:00.000Z');store.addMemory('Prefers concise replies');
 assert.equal(makeContext(store),'');assert.match(makeContext(store,{contextIds:[journal.id]}),/walk/);assert.doesNotMatch(makeContext(store,{contextIds:[journal.id]}),/Prefers/);
 assert.match(makeContext(store,{allowContext:true}),/Prefers/);
 const message=store.addMessage('assistant','working','pending');store.close();store=new Store(file);
 assert.equal(store.journal()[0].text,'<b>walk</b>');assert.equal(store.messages()[0].status,'interrupted');
 store.updateMessage(message.id,'done','complete');assert.equal(store.messages()[0].content,'done');store.resetSession();assert.equal(store.messages().length,0);assert.equal(store.journal().length,1);
 store.deleteJournal(journal.id);assert.equal(store.journal().length,0);store.close();
});
// 一次保存可能同时改多个开关；逐个写会各加锁并重写整个 settings.md。
test('多个开关一次写入 settings.md，非法键整批拒绝且不落盘',t=>{
 const dir=mkdtempSync(join(tmpdir(),'claudia-store-bools-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new Store(resolve(dir,'store.sqlite')),writes=[];
 const original=store.records.write.bind(store.records);
 store.records.write=(name,text,revision)=>{writes.push(name);return original(name,text,revision);};
 store.setBooleans({allowContext:true,reflectionEnabled:true,profileEnabled:true});
 assert.deepEqual(writes,['settings.md']);
 for(const key of ['allowContext','reflectionEnabled','profileEnabled'])assert.equal(store.get(key),true);
 assert.equal(store.get('activityEnabled'),false);
 store.setBooleans({activityEnabled:true});
 const text=readFileSync(join(dir,'settings.md'),'utf8');
 for(const key of ['allowContext','reflectionEnabled','profileEnabled','activityEnabled'])assert.equal(store.get(key),true);
 for(const key of ['allowContext','reflectionEnabled','profileEnabled','activityEnabled'])assert.match(text,new RegExp(`^${key}: true$`,'m'));
 for(const bad of [{allowContext:true,endpoint:true},{allowContext:'true'},{unknownKey:true}])assert.throws(()=>store.setBooleans(bad),error=>error.status===400);
 assert.deepEqual(store.get('profileEnabled'),true);
 store.setBooleans({});store.close();
});
