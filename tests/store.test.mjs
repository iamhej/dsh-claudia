import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
