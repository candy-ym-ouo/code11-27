/**
 * ab-record 浏览器验证：成员打开首页时，「最近有更新」卡片缩略图必须真的解码出来，
 * 并且 access token 过期后能自动恢复（本地录制把 token TTL 调成 10s，便于观察）。
 *
 * 观测口径：
 * 1. 成员用 UI 登录；
 * 2. 打开首页，6 张卡片的 <img> 全部 naturalWidth > 0（不是占位图标、也不是破图）；
 * 3. 等 access token 过期后，清掉浏览器缓存并让媒体标签用旧令牌重新请求，
 *    期望出现 401 → 静默续期 → 用新令牌重试成功；
 * 4. 整页重新打开首页，缩略图仍然全部正常；
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TTL_MS = 10_000;

async function waitThumbs(page, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const cards = page.locator('.grid-cards .item-card');
  // 懒加载：先把最后一张卡片滚进视野触发加载，再回到卡片网格
  const count = await cards.count();
  if (count > 0) {
    await cards.nth(count - 1).scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);
    await page.locator('.grid-cards').scrollIntoViewIfNeeded().catch(() => {});
  }
  let state = { loaded: 0, broken: 0, missing: 0 };
  while (Date.now() < deadline) {
    state = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.grid-cards .item-card')];
      let loaded = 0;
      let broken = 0;
      let missing = 0;
      for (const card of cards) {
        const img = card.querySelector('.item-card__thumb img');
        if (!img) {
          missing += 1;
          continue;
        }
        if (img.complete && img.naturalWidth > 0) loaded += 1;
        else if (img.complete) broken += 1;
      }
      return { loaded, broken, missing, total: cards.length };
    });
    if (state.loaded >= expected) return state;
    await page.waitForTimeout(400);
  }
  return state;
}

function summarizeThumbs(rows) {
  const byStatus = new Map();
  for (const row of rows) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
  const byMedia = new Map();
  for (const row of rows) {
    const list = byMedia.get(row.mediaId) ?? [];
    list.push(row);
    byMedia.set(row.mediaId, list);
  }
  let everyMediaEndedOk = byMedia.size > 0;
  for (const list of byMedia.values()) {
    const sorted = [...list].sort((a, b) => a.at - b.at);
    if (sorted[sorted.length - 1].status !== 200) everyMediaEndedOk = false;
  }
  const statusText = [...byStatus.entries()].sort((a, b) => a[0] - b[0]).map(([code, n]) => `${code}×${n}`).join(' / ');
  const other = rows.filter((row) => row.status !== 200 && row.status !== 401);
  return {
    text: `${byMedia.size} 个缩略图端点，响应 ${statusText || '无'}；每个端点最终都返回 200：${everyMediaEndedOk ? '是' : '否'}`,
    ok: byMedia.size > 0 && everyMediaEndedOk && other.length === 0,
  };
}

export default async function verify({ page, webUrl, variant }) {
  const fixture = JSON.parse(await fs.readFile(path.join(variant.stateDir, 'fixture.json'), 'utf8'));
  const expected = fixture.itemIds.length;
  const ttlMs = Number(fixture.accessTokenTtlMs) > 0 ? Number(fixture.accessTokenTtlMs) : DEFAULT_TTL_MS;
  const checks = [];
  const thumbs = [];
  let phase = '登录';

  page.on('response', (response) => {
    const url = response.url();
    const match = url.match(/\/api\/v1\/families\/[^/]+\/media\/([^/?]+)\/thumb/);
    if (!match) return;
    thumbs.push({ mediaId: match[1], status: response.status(), phase, credentialed: /[?&]t=/.test(url), at: Date.now() });
  });

  // 1. 成员登录
  await page.locator('input[type="email"]').fill(fixture.account.email);
  await page.locator('input[type="password"]').fill(fixture.account.password);
  await page.getByRole('button', { name: /登录/ }).first().click();
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 20000 });
  const loginAt = Date.now();

  // 2. 打开首页，等最近更新卡片的缩略图
  phase = '首次打开首页';
  await page.goto(new URL(`/f/${fixture.familyId}`, webUrl).href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByText('最近有更新').first().waitFor({ timeout: 20000 });
  await page.locator('.grid-cards .item-card').first().waitFor({ timeout: 20000 });
  const cardCount = await page.locator('.grid-cards .item-card').count();
  checks.push({ kind: '最近更新卡片数量', value: `${cardCount} 张（预期 ${expected}）`, ok: cardCount >= expected });

  const first = await waitThumbs(page, expected, 20000);
  checks.push({
    kind: '首次打开：缩略图渲染',
    value: `加载成功 ${first.loaded}/${expected}，破图 ${first.broken}，无图片元素 ${first.missing}`,
    ok: first.loaded >= expected,
  });
  await page.waitForTimeout(1200);

  // 3. 等 access token 过期（录制环境 TTL=10s）
  const waitMs = Math.max(0, ttlMs + 2500 - (Date.now() - loginAt));
  if (waitMs > 0) await page.waitForTimeout(waitMs);

  // 4. 令牌已过期：清缓存后让媒体标签带着旧令牌重新请求，验证 401 能自动恢复
  phase = '令牌过期后重新请求缩略图';
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.clearBrowserCache');
  await page.evaluate(() => {
    for (const img of document.querySelectorAll('.grid-cards img')) img.src = img.src;
  });
  const expired = await waitThumbs(page, expected, 20000);
  checks.push({
    kind: '令牌过期后：自动恢复',
    value: `重新加载成功 ${expired.loaded}/${expected}，破图 ${expired.broken}，无图片元素 ${expired.missing}`,
    ok: expired.loaded >= expected,
  });
  await page.waitForTimeout(1000);

  // 5. 成员再次打开首页（整页打开）
  phase = '再次打开首页';
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByText('最近有更新').first().waitFor({ timeout: 20000 });
  await page.locator('.grid-cards .item-card').first().waitFor({ timeout: 20000 });
  const reopened = await waitThumbs(page, expected, 20000);
  checks.push({
    kind: '重新打开首页：缩略图渲染',
    value: `加载成功 ${reopened.loaded}/${expected}，破图 ${reopened.broken}，无图片元素 ${reopened.missing}`,
    ok: reopened.loaded >= expected,
  });

  const summary = summarizeThumbs(thumbs);
  const expiredPhase = thumbs.filter((row) => row.phase === '令牌过期后重新请求缩略图');
  const recovered = expiredPhase.some((row) => row.status === 401) && expiredPhase.some((row) => row.status === 200);
  checks.push({ kind: '缩略图请求观测', value: summary.text, ok: summary.ok });
  checks.push({
    kind: '过期令牌的 401 被续期重试覆盖',
    value: recovered
      ? `过期后先 401（${expiredPhase.filter((r) => r.status === 401).length} 次）再 200（${expiredPhase.filter((r) => r.status === 200).length} 次）`
      : `未观察到 401→200 的重试过程（401 ${expiredPhase.filter((r) => r.status === 401).length} 次 / 200 ${expiredPhase.filter((r) => r.status === 200).length} 次）`,
    ok: recovered,
  });

  await page.locator('.grid-cards').scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(600);
  const bodyText = await page.locator('body').innerText();
  return {
    ok: checks.every((check) => check.ok),
    checks,
    bodyText: `${bodyText.slice(0, 300)}\n${checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.kind}：${c.value}`).join('\n')}`,
  };
}
