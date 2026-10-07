import { useEffect, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import { useAuthedMediaSrc } from '../lib/media';

/**
 * 需要登录态的 <img>：
 * - src 自动附上 access token（服务端媒体 GET 支持 ?t= 凭证通道）；
 * - 令牌过期导致 401 时静默续期并用新令牌重新加载，缩略图不会长期裂图；
 * - 重试仍失败（文件缺失等）时渲染 fallback，不显示浏览器的破图图标。
 */
export function AuthImage({
  src,
  fallback = null,
  alt = '',
  ...rest
}: {
  src: string | null | undefined;
  /** 图片彻底加载失败时展示的内容（如图标占位） */
  fallback?: ReactNode;
  alt?: string;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError' | 'onLoad'>) {
  const { src: authedSrc, failed, onError } = useAuthedMediaSrc(src);
  const [loaded, setLoaded] = useState(false);

  // 换地址（续期后重拼、或父组件换图）后要重新等待加载成功，
  // 否则上一张已加载的状态会让失败的新图直接显示成破图。
  useEffect(() => {
    setLoaded(false);
  }, [authedSrc]);

  if (!authedSrc || failed) return <>{fallback}</>;

  return (
    <>
      {/* 未确认加载成功（含首次加载与续期重试）时隐藏图片本身，占位由 fallback 承担 */}
      {!loaded ? fallback : null}
      <img
        {...rest}
        src={authedSrc}
        alt={alt}
        onError={onError}
        onLoad={() => setLoaded(true)}
        style={loaded ? rest.style : { ...rest.style, display: 'none' }}
      />
    </>
  );
}
