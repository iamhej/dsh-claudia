import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOwned, filterOtherAgents, createHostBusy } from '../host-busy.mjs';

const agent = id => ({ session: { id }, ctx: {} });
const runtime = ({ handles = [], ids = [], key = 'harnessSessions' } = {}) => ({
  handles: new Map(handles.map(h => [h.id ?? String(h.agent?.session?.id ?? Math.random()), h])),
  sessionKey: key,
  store: { get: (k, fallback) => (k === key ? ids : fallback) }
});

test('自有会话：借用的 live agent 与已记录的会话 ID 都不算“别人在用”', () => {
  const borrowed = agent('session-borrowed');
  const main = runtime({ handles: [{ agent: borrowed, borrowed: true }], ids: ['session-main'] });
  const news = runtime({ handles: [{ agent: agent('session-news') }], ids: ['session-news-old'], key: 'claudiaNewsSessionsV1' });
  const reader = runtime({ ids: ['session-reader'], key: 'READER' });
  const analysis = runtime({ ids: ['session-analysis'], key: 'ANALYSIS' });

  const { owned, ownedIds } = collectOwned([main, news, reader, analysis]);
  assert.equal(owned.size, 2);
  assert.ok(ownedIds.has('session-main') && ownedIds.has('session-reader') && ownedIds.has('session-analysis'));

  const others = filterOtherAgents({
    agents: [borrowed, agent('session-main'), agent('session-news-old'), agent('session-analysis'), agent('session-stranger')],
    owned, ownedIds
  });
  assert.deepEqual(others.map(a => a.session.id), ['session-stranger']);
});

test('服务字段取错（news.handles / emailReview.handles 不存在）时也不会把自有会话漏掉', () => {
  // 之前直接读 news?.handles / emailReview?.handles 得到 undefined，资讯与邮件会话被当成别人。
  const { owned, ownedIds } = collectOwned([undefined, { handles: undefined, store: undefined }, null]);
  assert.equal(owned.size, 0);
  assert.equal(ownedIds.size, 0);
  assert.deepEqual(filterOtherAgents({ agents: [agent('a')], owned, ownedIds }).map(a => a.session.id), ['a']);
});

test('确有别的会话时返回 true，并按低频记录一次占用方', () => {
  const logged = [];
  let clock = 1_000_000;
  const ctx = { agents: { list: () => [agent('session-stranger'), agent('session-main')] } };
  const main = runtime({ ids: ['session-main'] });
  const probe = createHostBusy({ ctx, logger: { info: (n, d) => logged.push([n, d]) }, getRuntimes: r => [r, undefined], now: () => clock });
  assert.equal(probe(main), true);
  clock += 1000;
  assert.equal(probe(main), true);
  assert.equal(logged.length, 1, '10 分钟内只记一次，避免刷日志');
  assert.equal(logged[0][0], 'host.otherAgents');
  assert.deepEqual(logged[0][1].ids, ['session-stranger']);
  clock += 600_001;
  probe(main);
  assert.equal(logged.length, 2);
});

test('没有别的会话时返回 false 且不记日志', () => {
  const logged = [];
  const ctx = { agents: { list: () => [] } };
  const probe = createHostBusy({ ctx, logger: { info: (n, d) => logged.push([n, d]) }, getRuntimes: r => [r], now: () => 0 });
  assert.equal(probe(runtime({ ids: ['x'] })), false);
  assert.equal(logged.length, 0);
});
