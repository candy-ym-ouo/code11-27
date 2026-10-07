import { useRef, useState, useSyncExternalStore, type ImgHTMLAttributes } from 'react';
import { getAccessToken, subscribeAccessToken } from '../api/client';
import { isProtectedMediaUrl, recoverMediaAuth, useMediaSrc } from '../lib/media';

type MediaImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  /** 服务端返回的原始媒体地址（不含令牌），组件负责附加凭证。 */
  url: string | null | undefined;
};

/**
 * 受保护媒体的 <img>：
 * 1. 地址始终拼上当前 access token（query 参数，服务端仅对 GET /media/ 放行）；
 * 2. 页面刚刷新、token 还没从 refresh cookie 恢复时，不渲染 <img>、不发无凭证请求；
 * 3. 令牌过期导致 401 时静默续期并用新地址自动重试一次（一屏图片共享同一次刷新）。
 *
 * 公开分享页的媒体走 /public/ 路径、本就不要凭证，未登录也照常渲染。
 */
export function MediaImage({ url, alt = '', onError, ...rest }: MediaImageProps) {
  const token = useSyncExternalStore(subscribeAccessToken, getAccessToken);
  const src = useMediaSrc(url);
  const [recovering, setRecovering] = useState(false);
  const triedFor = useRef<string | null>(null);

  // 受保护媒体：已登录但内存里的 token 还没恢复（页面刚加载）时不发请求，避免无凭证 401
  if (!url || !src || (isProtectedMediaUrl(url) && token === null)) return null;

  const handleError: React.ReactEventHandler<HTMLImageElement> = (event) => {
    onError?.(event);
    if (triedFor.current === url || recovering) return;
    triedFor.current = url;
    setRecovering(true);
    // 成功后 useMediaSrc 会因 token 变化给出新地址，<img> 自动重新请求；
    // 失败（refresh cookie 也过期）则保持裂图，由登录守卫把用户带去登录页。
    void recoverMediaAuth().finally(() => setRecovering(false));
  };

  return <img src={src} alt={alt} onError={handleError} {...rest} />;
}
