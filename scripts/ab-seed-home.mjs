#!/usr/bin/env node
/**
 * ab-record 复现夹具：为「成员打开首页时最近更新卡片的缩略图全部破裂」准备数据。
 *
 * 1. 注册一个家庭成员账号；
 * 2. 建家庭，建 6 条各自带一张真实可解码图片的条目（首页最近更新正好 6 张卡片）；
 * 3. 等后台把缩略图处理完（thumbUrl 可用）；
 * 4. 把账号、家庭与条目写入 $AB_STATE_DIR/fixture.json，供浏览器验证脚本使用。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const API = (process.env.API_BASE_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const V1 = `${API}/api/v1`;
const STATE_DIR = process.env.AB_STATE_DIR ?? path.join(process.env.HOME ?? '.', '.cache/code11-27-b');

const ACCOUNT = { email: 'member@example.com', password: 'Heirloom2026', displayName: '李淑芬' };

const ITEMS = [
  { title: '外公的樟木箱', category: 'furniture', acquiredLabel: '大概 1978 年', place: '上海 · 老西门', hue: 28, band: 'wood' },
  { title: '母亲的缝纫机', category: 'furniture', acquiredLabel: '1983 年春天', place: '苏州 · 平江路', hue: 205, band: 'cloth' },
  { title: '老式红灯收音机', category: 'souvenir', acquiredLabel: '1970 年代', place: '南京 · 夫子庙', hue: 12, band: 'dial' },
  { title: '搪瓷茶缸一对', category: 'souvenir', acquiredLabel: '大概 1965 年', place: '杭州 · 拱宸桥', hue: 148, band: 'enamel' },
  { title: '自行车行驶执照', category: 'receipt', acquiredLabel: '1981 年 6 月', place: '无锡 · 崇安区', hue: 48, band: 'paper' },
  { title: '黑白全家福', category: 'souvenir', acquiredLabel: '大概 1972 年', place: '上海 · 徐汇', hue: 260, band: 'photo' },
];

let token = '';
let pass = 0;
let fail = 0;
const ok = (msg) => {
  console.log(`  \u2713 ${msg}`);
  pass += 1;
};
const bad = (msg) => {
  console.log(`  \u2717 ${msg}`);
  fail += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(method, url, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url.startsWith('http') ? url : `${V1}${url}`, {
    method,
    headers,
    body: payload,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// ---- 真实可解码的 PNG（sharp 能出缩略图），每张颜色不同，缩略图一眼可辨 ----
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function makePng(width, height, paint) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + 1 + x * 3;
      const [r, g, b] = paint(x, y, width, height);
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 老物件照片风格：上半部主体色 + 中间浅色分隔 + 下半部深色桌面，缩略图上一眼可辨。 */
function objectPhoto({ hue, band }) {
  const hsl = (h, s, l) => {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  };
  return (x, y, width, height) => {
    const shelf = Math.floor(height * 0.7);
    const grain = ((x * 5 + y * 3) % 17) - 8;
    if (y > shelf - 4 && y < shelf + 4) return hsl(40, 0.22, 0.82);
    if (y <= shelf) {
      const shade = ((x + y) % 23) - 11;
      const [r, g, b] = hsl(hue, 0.42, 0.55);
      return [Math.min(255, Math.max(0, r + shade)), Math.min(255, Math.max(0, g + shade)), Math.min(255, Math.max(0, b + shade))];
    }
    const [r, g, b] = hsl(hue + 190, 0.28, 0.24);
    return [Math.min(255, Math.max(0, r + grain)), Math.min(255, Math.max(0, g + grain)), Math.min(255, Math.max(0, b + grain))];
  };
}

async function main() {
  console.log('[夹具] 准备「成员打开首页看最近更新缩略图」数据');

  const registered = await request('POST', '/auth/register', ACCOUNT);
  if (registered.status === 201) {
    token = registered.json.accessToken;
    ok(`注册成员账号 ${ACCOUNT.email}`);
  } else {
    const login = await request('POST', '/auth/login', { email: ACCOUNT.email, password: ACCOUNT.password });
    if (login.status !== 200) throw new Error(`注册/登录失败：${registered.status} ${registered.text} / ${login.status} ${login.text}`);
    token = login.json.accessToken;
    ok(`登录成员账号 ${ACCOUNT.email}`);
  }

  const family = await request('POST', '/families', {
    name: '张家老物件',
    description: '外公留下的东西',
    defaultVisibility: 'family',
  });
  if (family.status !== 201) throw new Error(`建家庭失败：${family.status} ${family.text}`);
  const fid = family.json.family.id;
  ok(`建家庭 ${family.json.family.name}（${fid}）`);

  const itemIds = [];
  for (const spec of ITEMS) {
    const item = await request('POST', `/families/${fid}/items`, {
      title: spec.title,
      category: spec.category,
      status: 'published',
      visibility: 'family',
      acquiredLabel: spec.acquiredLabel,
      placeText: spec.place,
      storyHtml: `<p>${spec.title}，家里一直留着，讲起来都是旧日子的故事。</p>`,
    });
    if (item.status !== 201) throw new Error(`建条目「${spec.title}」失败：${item.status} ${item.text}`);
    const itemId = item.json.item.id;
    itemIds.push(itemId);

    const png = makePng(640, 480, objectPhoto(spec));
    const form = new FormData();
    form.append('kind', 'image');
    form.append('caption', `${spec.title} 的照片`);
    form.append('file', new Blob([png], { type: 'image/png' }), `${itemId}.png`);
    const uploaded = await request('POST', `/families/${fid}/items/${itemId}/media`, form);
    if (uploaded.status !== 202) throw new Error(`「${spec.title}」上传图片失败：${uploaded.status} ${uploaded.text}`);
  }
  ok(`建好 ${ITEMS.length} 条带图片的条目`);

  let ready = 0;
  let lastStatuses = [];
  for (let i = 0; i < 60; i += 1) {
    const list = await request('GET', `/families/${fid}/items?sort=updated&limit=6`);
    const rows = list.json?.items ?? [];
    lastStatuses = rows.map((row) => row.media?.[0]?.status ?? 'missing');
    ready = rows.filter((row) => row.media?.some((m) => m.thumbUrl)).length;
    if (ready >= ITEMS.length) break;
    await sleep(500);
  }
  if (ready >= ITEMS.length) ok(`6 张缩略图处理完成`);
  else bad(`缩略图未处理完：${ready}/6 就绪（${lastStatuses.join(',')}）`);

  const fixture = {
    account: ACCOUNT,
    apiBase: API,
    familyId: fid,
    itemIds,
    titles: ITEMS.map((item) => item.title),
    accessTokenTtlMs: Number(process.env.ACCESS_TOKEN_TTL_MS ?? 10000),
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(path.join(STATE_DIR, 'fixture.json'), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  console.log(`[夹具] 已写出 ${path.join(STATE_DIR, 'fixture.json')}`);
  console.log(`[夹具] 首页地址：/f/${fid}`);
  console.log(`[夹具] 断言：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[夹具] 失败：', error);
  process.exit(1);
});
