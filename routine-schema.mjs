const fail = message => Object.assign(new Error(message), { status: 400 });
const object = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail('Routine 包含无效对象或未知字段');
};
export function validateSchedule(value) {
  object(value, ['type', 'time', 'days', 'hours']);
  if (value.type === 'interval') {
    if (Object.keys(value).some(k => !['type', 'hours'].includes(k)) || !Number.isInteger(value.hours) || value.hours < 1 || value.hours > 168) throw fail('间隔必须为 1—168 整数小时');
    return { type: 'interval', hours: value.hours };
  }
  if (!['daily', 'weekly'].includes(value.type) || typeof value.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time) || 'hours' in value) throw fail('请选择每日或每周的有效 HH:MM 时间');
  if (value.type === 'daily') {
    if ('days' in value) throw fail('每日任务不接受星期参数');
    return { type: 'daily', time: value.time };
  }
  if (!Array.isArray(value.days) || !value.days.length || value.days.length > 7 || value.days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || new Set(value.days).size !== value.days.length) throw fail('每周至少选择一天，星期不能重复');
  return { type: 'weekly', time: value.time, days: [...value.days].sort((a, b) => a - b) };
}
export function validateRoutine(value) {
  object(value, ['name', 'prompt', 'schedule', 'allowNetwork', 'delivery', 'enabled']);
  for (const [key, max] of [['name', 100], ['prompt', 6000]]) {
    if (typeof value[key] !== 'string' || !value[key].trim() || !value[key].isWellFormed() || value[key].length > max || /\u0000/.test(value[key])) throw fail(`${key === 'name' ? '名称' : '提示词'}必须为 1—${max} 字符`);
  }
  if (typeof value.allowNetwork !== 'boolean' || typeof value.enabled !== 'boolean') throw fail('任务开关必须是布尔值');
  if (!['today', 'both'].includes(value.delivery)) throw fail('投递位置必须为 Today 或同时显示到对话');
  return { name: value.name, prompt: value.prompt, schedule: validateSchedule(value.schedule), allowNetwork: value.allowNetwork, delivery: value.delivery, enabled: value.enabled };
}
export const DEFAULT_ROUTINE = Object.freeze({
  name: '每日资讯',
  prompt: '看看过去 24 小时我聊了什么、记了什么，猜猜我可能对什么话题感兴趣。猜不出来就用兜底话题「AI 产品与增长」。\n只把话题关键词发给搜索，不发我的原始记录。搜索近一周的信息，挑 1—3 条值得看的，附链接。\n优先有实质新进展的消息（新产品、新版本、重要动向）；同一件事只留一条；跳过软文和空泛榜单。\n没有值得看的就不推送，说明原因即可。',
  schedule: { type: 'daily', time: '11:00' }, allowNetwork: true, delivery: 'today', enabled: false,
});

// 日历任务按本机时区构造，一天最多一个窗口。DST 不存在的时刻顺延，重复时刻取第一次。
// 间隔任务按 enabledAt 的真实经过时间锚定，不冒充日历任务。
export function routineOccurrence(job, now = new Date(), direction = 'previous') {
  const schedule = validateSchedule(job.schedule), date = new Date(now), anchor = new Date(job.enabledAt);
  if (!Number.isFinite(date.getTime())) throw fail('调度日期无效');
  if (!job.enabled || !job.enabledAt || !Number.isFinite(anchor.getTime())) return null;
  const next = direction === 'next';
  if (schedule.type === 'interval') {
    const step = schedule.hours * 3600000, n = Math.floor((date - anchor) / step) + (next ? 1 : 0);
    return n >= 1 ? new Date(anchor.getTime() + n * step).toISOString() : next ? new Date(anchor.getTime() + step).toISOString() : null;
  }
  const [hour, minute] = schedule.time.split(':').map(Number);
  for (let offset = 0; offset <= 8; offset++) {
    const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate() + (next ? offset : -offset), hour, minute, 0, 0);
    if (schedule.type === 'weekly' && !schedule.days.includes(candidate.getDay())) continue;
    if (candidate <= anchor) continue;
    if (next ? candidate > date : candidate <= date) return candidate.toISOString();
  }
  return null;
}
