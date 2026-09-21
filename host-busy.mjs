// 判断“宿主里还有没有别人在用会话”，供一键重启、邮件开关等需要独占宿主的入口复用。
// 拆成独立模块是因为判定规则必须能被单测覆盖：历史上它把本插件自己借用的 live agent
// 当成“别人的会话”，导致 hostBusy 恒为真、重启入口永久 409，而日志里看不出是谁在占。
const agentId = agent => String(agent?.session?.id ?? '');

export function collectOwned(runtimes) {
  const owned = new Set(), ownedIds = new Set();
  for (const runtime of runtimes ?? []) {
    if (!runtime) continue;
    for (const handle of runtime.handles?.values() ?? []) if (handle?.agent) owned.add(handle.agent);
    // 借用/恢复出来的 agent 未必与 ctx.agents.list() 返回的引用同址，
    // 所以再按“会话 ID 是否记在本插件名下”兜一层。
    try {
      const known = runtime.store?.get?.(runtime.sessionKey, []);
      if (Array.isArray(known)) for (const id of known) ownedIds.add(String(id));
    } catch {}
  }
  return { owned, ownedIds };
}

export function filterOtherAgents({ agents = [], owned, ownedIds }) {
  return (agents ?? []).filter(agent => {
    if (owned?.has(agent)) return false;
    const id = agentId(agent);
    return !(id && ownedIds?.has(id));
  });
}

export function createHostBusy({ ctx, logger, getRuntimes, now = () => Date.now(), logEveryMs = 600000 }) {
  let loggedAt = 0;
  return runtime => {
    let runtimes = [];
    try { runtimes = getRuntimes(runtime) ?? []; } catch {}
    const { owned, ownedIds } = collectOwned(runtimes);
    const others = filterOtherAgents({ agents: ctx.agents.list(), owned, ownedIds });
    if (others.length) {
      const at = now();
      if (at - loggedAt > logEveryMs) {
        loggedAt = at;
        logger?.info?.('host.otherAgents', {
          others: others.length,
          owned: owned.size,
          knownIds: ownedIds.size,
          ids: others.slice(0, 3).map(agentId)
        });
      }
    }
    return others.length > 0;
  };
}
