import { useSyncExternalStore } from 'react';
import { api, getAccessToken, refreshAccessToken, subscribeAccessToken } from '../api/client';
import type { Media } from '../api/types';

/**
 * 把服务端返回的媒体地址转成 <img>/<audio> 能直接用的地址。
 * 令牌以查询参数附上（服务端只对 GET 媒体路径放行），这样音频能走原生 Range 流式播放。
 *
 * 注意：access token 只有 15 分钟有效期，渲染时拼出来的地址可能很快过期；
 * 需要在令牌过期后自动恢复的媒体元素，请用 useMediaSrc / MediaImage 而不是直接调本函数。
 */
export function mediaSrc(url: string | null | undefined, token?: string | null): string | undefined {
  if (!url) return undefined;
  const t = token === undefined ? getAccessToken() : token;
  if (!t) return url;
  return `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(t)}`;
}

/**
 * 响应式的媒体地址：始终带上当前 access token，刷新/登出后自动重算。
 * 解决「页面初次加载时 token 尚未从 refresh cookie 恢复，<img> 先以无凭证地址发出请求」的竞态。
 */
export function useMediaSrc(url: string | null | undefined): string | undefined {
  const token = useSyncExternalStore(subscribeAccessToken, getAccessToken);
  return mediaSrc(url, token);
}

/** /families/.../media/... 是受保护地址，必须带 access token；/public/ 下的媒体匿名可读。 */
export function isProtectedMediaUrl(url: string | null | undefined): boolean {
  return Boolean(url && /\/api\/v\d+\/families\/[^/]+\/media\//.test(url));
}

/**
 * <img>/<audio> 加载失败时调用：很可能是 query 里的 access token 已过期，
 * 静默续期一次让元素用新地址重试；续期失败（refresh cookie 也失效）则交给登录守卫。
 * 同一元素的每次失败只重试一次，避免坏链接反复打 /auth/refresh。
 */
export async function recoverMediaAuth(): Promise<boolean> {
  return refreshAccessToken();
}

export interface WaveformData {
  peaks: number[];
  sampleRate: number;
  durationMs: number | null;
}

export async function fetchWaveform(media: Media): Promise<WaveformData | null> {
  if (!media.waveformUrl) return null;
  try {
    return await api.absolute<WaveformData>(media.waveformUrl);
  } catch {
    return null;
  }
}

export function isPlayableInBrowser(mimeType: string): boolean {
  return /audio\/(mpeg|mp4|wav|webm|ogg)/.test(mimeType);
}
