import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getAccessToken, refreshAccessToken } from '../api/client';
import type { Media } from '../api/types';

/**
 * 把服务端返回的媒体地址转成 <img>/<audio> 能直接用的地址。
 * 令牌以查询参数附上（服务端只对 GET 媒体路径放行），这样音频能走原生 Range 流式播放。
 */
export function mediaSrc(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const token = getAccessToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
}

/** 客户端判断 access token 是否已过期（JWT 的 exp）。无 token / 非 JWT 时返回 false。 */
export function isAccessTokenExpired(): boolean {
  const token = getAccessToken();
  if (!token) return false;
  try {
    const payload = JSON.parse(atob(token.split('.')[1] ?? '')) as { exp?: unknown };
    return typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now();
  } catch {
    return false;
  }
}

/**
 * 给「打开 / 下载」这类原生跳转链接兜底：
 * 令牌已过期时先静默续期，返回带上新令牌的地址；令牌没过期则原样返回，
 * 调用方据此放行浏览器的默认跳转（中键新窗口等仍可用）。
 */
export async function freshMediaSrc(url: string | null | undefined): Promise<string | undefined> {
  if (!url) return undefined;
  if (isAccessTokenExpired()) {
    await refreshAccessToken();
  }
  return mediaSrc(url);
}

/**
 * 探测媒体地址是否因凭证问题返回 401。
 * 标签请求（<img>/<audio>）拿不到状态码，只能在 onError 后用 fetch 补一次：
 * Range 只取 1 字节，缩略图体积小，命中浏览器缓存时更不会产生实际下载。
 */
export async function probeMediaAuth(src: string): Promise<number | null> {
  try {
    const res = await fetch(src, {
      method: 'GET',
      headers: {
        Accept: 'image/*,audio/*,application/json,*/*',
        Range: 'bytes=0-0',
      },
      credentials: 'same-origin',
      signal: AbortSignal.timeout?.(10_000),
    });
    if (res.body) {
      try {
        await res.body.cancel();
      } catch {
        /* 忽略：连接已关闭不影响状态码判断 */
      }
    }
    return res.status;
  } catch {
    return null;
  }
}

/**
 * 媒体标签（<img>/<audio>）专用的登录态地址：
 * - 初始用当前 access token 拼地址；
 * - 标签加载失败时探测一次，若为 401 则静默续期并用新令牌重拼地址，
 *   浏览器拿到新 src 会自动重新请求，从而在令牌过期后自动恢复；
 * - 只续期重试一次；资源不存在 / 处理失败等非凭证错误立即标记 failed，
 *   不会反复刷新令牌，也不会死循环。
 */
export function useAuthedMediaSrc(url: string | null | undefined): {
  src: string | undefined;
  failed: boolean;
  recovering: boolean;
  onError: () => void;
} {
  const [src, setSrc] = useState(() => mediaSrc(url));
  const [failed, setFailed] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const recoveredRef = useRef(false);

  useEffect(() => {
    recoveredRef.current = false;
    setFailed(false);
    setRecovering(false);
    setSrc(mediaSrc(url));
  }, [url]);

  const onError = useCallback(() => {
    const current = mediaSrc(url);
    if (!current) {
      setFailed(true);
      return;
    }
    // 续期换过地址后仍然失败：资源本身有问题，不再重试
    if (recoveredRef.current) {
      setRecovering(false);
      setFailed(true);
      return;
    }
    recoveredRef.current = true;
    setRecovering(true);
    void (async () => {
      const status = await probeMediaAuth(current);
      if (status === 401) {
        const ok = await refreshAccessToken();
        if (ok) {
          // 新令牌会写回 client；重新拼地址触发标签重新加载
          setSrc(mediaSrc(url));
          // 新地址加载成功时由 onLoad 收尾；若再次失败 onError 会标记 failed
          return;
        }
      }
      setRecovering(false);
      setFailed(true);
    })();
  }, [url]);

  return { src, failed, recovering, onError };
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
