// 验证：401 并发时续期只发生一次（single-flight），且重试带新令牌；媒体地址过期判断正确。
import { build } from '/workspace/node_modules/.pnpm/esbuild@0.21.5/node_modules/esbuild/lib/main.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = '/workspace';
const dir = mkdtempSync(join(tmpdir(), 'media-fix-'));

// 单一入口把 client 与 media 打在同一个模块图里，保证二者共享同一份令牌状态
const entry = join(dir, 'entry.ts');
writeFileSync(
  entry,
  `export * from '${join(ROOT, 'apps/web/src/api/client.ts').replaceAll('\\\\', '/')}';
export * as media from '${join(ROOT, 'apps/web/src/lib/media.ts').replaceAll('\\\\', '/')}';
`,
);
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  outfile: join(dir, 'bundle.js'),
});

const bundle = await import(pathToFileURL(join(dir, 'bundle.js')).href);
const { api, setRefreshHandler, setAccessToken, refreshAccessToken, getAccessToken, media } = bundle;

// ---- 场景 1：多个并发 401 只触发一次续期 ----
let refreshCalls = 0;
let logins = 0;
setRefreshHandler(async () => {
  refreshCalls += 1;
  // 模拟网络抖动：多个 api() 同时等在这
  await new Promise((r) => setTimeout(r, 30));
  setAccessToken('new-token');
  return true;
});

setAccessToken('expired-token');

globalThis.fetch = async (url, init = {}) => {
  if (String(url).endsWith('/auth/refresh')) {
    logins += 1;
    return jsonRes(200, {});
  }
  const auth = init.headers?.Authorization;
  if (auth === 'Bearer expired-token') return jsonRes(401, { error: { code: 'TOKEN_EXPIRED' } });
  if (auth === 'Bearer new-token') return jsonRes(200, { ok: true });
  return jsonRes(500, {});
};

function jsonRes(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(payload),
  };
}

const results = await Promise.all([
  api('/families/f1/items'),
  api('/families/f1/items'),
  api('/families/f1/items'),
  api('/families/f1/items'),
  api('/families/f1/items'),
  api('/families/f1/items'),
]);

assert.equal(refreshCalls, 1, `6 个并发 401 应只续期 1 次，实际 ${refreshCalls} 次`);
assert.deepEqual(results, Array(6).fill({ ok: true }));
assert.equal(getAccessToken(), 'new-token');
console.log('✓ 场景 1：并发 401 合并为一次续期，全部用新令牌重试成功');

// ---- 场景 2：续期失败不再重试，直接抛 401 ----
setRefreshHandler(async () => {
  refreshCalls += 1;
  return false;
});
setAccessToken('expired-token');
await assert.rejects(
  () => api('/families/f1/items'),
  (e) => e.status === 401,
);
console.log('✓ 场景 2：续期失败时请求以 401 失败（交给登录守卫）');

// ---- 场景 3：lib/media 的地址拼接与过期判断 ----
setAccessToken('abc');
assert.equal(media.mediaSrc('/api/v1/families/f/media/m/thumb'), '/api/v1/families/f/media/m/thumb?t=abc');
assert.equal(
  media.mediaSrc('/api/v1/x?y=1'),
  '/api/v1/x?y=1&t=abc',
  '已有查询参数时用 & 拼接',
);
assert.equal(media.mediaSrc(null), undefined);

function jwtWithExp(exp) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(exp ? { sub: 'u1', exp } : { sub: 'u1' })}.sig`;
}

setAccessToken(jwtWithExp(Math.floor(Date.now() / 1000) + 600));
assert.equal(media.isAccessTokenExpired(), false, '未过期应返回 false');

setAccessToken(jwtWithExp(Math.floor(Date.now() / 1000) - 10));
assert.equal(media.isAccessTokenExpired(), true, '已过期应返回 true');

let refreshed = 0;
setRefreshHandler(async () => {
  refreshed += 1;
  setAccessToken(jwtWithExp(Math.floor(Date.now() / 1000) + 600));
  return true;
});
const fresh = await media.freshMediaSrc('/api/v1/families/f/media/m/thumb');
assert.equal(refreshed, 1);
assert.match(fresh, /t=ey/, '续期后的地址应带新令牌');

// 未过期时不续期
const fresh2 = await media.freshMediaSrc('/api/v1/families/f/media/m/thumb');
assert.equal(refreshed, 1, '令牌新鲜时不应触发续期');
console.log('✓ 场景 3：媒体地址令牌拼接、过期判断与续期换新令牌正确');

// 并发调用 freshMediaSrc 也只续期一次
setAccessToken(jwtWithExp(Math.floor(Date.now() / 1000) - 1));
const before = refreshed;
await Promise.all([media.freshMediaSrc('/a'), media.freshMediaSrc('/a'), media.freshMediaSrc('/a')]);
assert.equal(refreshed - before, 1, '多个过期链接同时打开只续期一次');
console.log('✓ 场景 4：多个媒体链接同时打开时续期仍合并');

console.log('\n全部通过');
