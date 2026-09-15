import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store, makeContext } from '../store.mjs';
const dir=mkdtempSync(new URL('./data-',import.meta.url).pathname);
test('local journal persists, consent controls context, UI session can reset',()=>{
 const file=resolve(dir,'store.sqlite');let store=new Store(file);
 const journal=store.addJournal('<b>walk</b>','2026-09-14T10:00:00.000Z');store.addMemory('Prefers concise replies');
 assert.equal(makeContext(store),'');assert.match(makeContext(store,{contextIds:[journal.id]}),/walk/);assert.doesNotMatch(makeContext(store,{contextIds:[journal.id]}),/Prefers/);
 assert.match(makeContext(store,{allowContext:true}),/Prefers/);
 const message=store.addMessage('assistant','working','pending');store.close();store=new Store(file);
 assert.equal(store.journal()[0].text,'<b>walk</b>');assert.equal(store.messages()[0].status,'interrupted');
 store.updateMessage(message.id,'done','complete');assert.equal(store.messages()[0].content,'done');store.resetSession();assert.equal(store.messages().length,0);assert.equal(store.journal().length,1);
 store.deleteJournal(journal.id);assert.equal(store.journal().length,0);store.close();
});
