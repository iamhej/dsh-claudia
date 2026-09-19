import { readFileSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const phases = ['pending', 'loading', 'active', 'failed', null, 'unloading'];
function readJSON(path) {
  if (statSync(path).size > 256 * 1024) throw Error('metadata too large');
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Read only the profile's formal bundle roster, not its dependency tree or config.
// Cordis Loader states mirror the installed rc.2 inventory gateway. Missing
// observations remain unknown; a bundle can contain differently named modules.
export function createPluginInventory({ home, profile = 'web', hostAnchor = process.argv[1], getEntries = () => null }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw Error('Invalid profile');
  const dir = resolve(home, 'profiles', profile);
  let resolveBundle, anchor;
  try {
    anchor = realpathSync(hostAnchor);
    resolveBundle = createRequire(anchor)('@deepseek-ai/dsh-app-boot').resolveBundleDir;
  } catch {}
  function metadata(name) {
    // Match host boot: installation anchor FIRST, then profile. Official resolver
    // also handles bundles that do not export package.json. Never execute a bundle.
    try {
      const path = resolveBundle ? join(resolveBundle('dsh', name, anchor, dir), 'package.json')
        : join(dir, 'node_modules', name, 'package.json');
      return readJSON(path);
    } catch { return null; }
  }
  return () => {
    const result = { available: false, profile, packages: [], runtimeAvailable: false, message: '' };
    try {
      const roster = readJSON(join(dir, 'package.json'))?.dsh?.profile?.bundles;
      if (!Array.isArray(roster) || roster.length > 200 || roster.some(n => typeof n !== 'string' || n.length > 214 || !packageName.test(n))) throw Error('invalid bundle roster');
      let entries = [];
      try {
        const value = getEntries();
        if (value != null) {
          for (const entry of value) {
            if (entries.length >= 2000) throw Error('inventory too large');
            if (!entry.options?.group) entries.push({ name: entry.options?.name, enabled: !entry.disabled, phase: entry.fiber ? phases[entry.fiber.state] ?? null : null });
          }
          result.runtimeAvailable = true;
        }
      } catch { entries = []; }
      result.packages = [...new Set(roster)].map(name => {
        const pkg = metadata(name);
        const installed = pkg?.name === name && typeof pkg?.dsh?.bundle?.patch === 'string';
        const matches = entries.filter(entry => entry.name === name);
        // Multiple instances cannot be flattened into one definitive runtime state.
        const row = matches.length === 1 ? matches[0] : null;
        return { name, version: installed && typeof pkg.version === 'string' && /^[0-9][0-9A-Za-z.+-]{0,79}$/.test(pkg.version) ? pkg.version : null,
          installed, enabled: row?.enabled ?? null, phase: row?.phase ?? null };
      });
      result.available = true;
      result.message = '只读当前 profile 的 Bundle 清单与包元数据；运行阶段仅标注同名宿主条目。未检查任何邮箱或账号配置。';
    } catch { result.message = '暂时无法读取当前 profile 的插件清单；未读取账号配置。'; }
    return result;
  };
}
