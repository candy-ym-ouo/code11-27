import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { freshMediaSrc, mediaSrc } from '../lib/media';

type MediaLinkProps = {
  url: string;
  children: ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>;

/**
 * 走浏览器原生跳转的媒体链接（打开 / 下载）：
 * 令牌没过期时完全放行，保留中键新窗口等浏览器行为；
 * 已过期则先静默续期，再带着新令牌跳转，避免落到 401 JSON 错误页。
 */
export function MediaLink({ url, children, onClick, ...rest }: MediaLinkProps) {
  const handleClick = async (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const src = await freshMediaSrc(url);
    if (!src) return;
    if (rest.download) {
      const a = document.createElement('a');
      a.href = src;
      a.download = typeof rest.download === 'string' ? rest.download : '';
      a.rel = 'noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else {
      window.open(src, rest.target === '_blank' ? '_blank' : '_self', 'noopener,noreferrer');
    }
  };

  return (
    <a href={mediaSrc(url) ?? url} {...rest} onClick={handleClick}>
      {children}
    </a>
  );
}
