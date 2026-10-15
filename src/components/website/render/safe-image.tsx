"use client";

import * as React from "react";

type SafeImageProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string;
  fallbackSrc?: string;
};

/** Keeps a failed site image from leaving an empty or broken-image area. */
export function SafeImage({ src, fallbackSrc, alt = "", className, srcSet, ...props }: SafeImageProps) {
  const [failed, setFailed] = React.useState(false);
  const [fallbackFailed, setFallbackFailed] = React.useState(false);
  const fallback = failed && fallbackSrc && !fallbackFailed ? fallbackSrc : null;
  if (failed && !fallback) {
    return <span className={["iq-photo-fallback", className].filter(Boolean).join(" ")} role={alt ? "img" : undefined} aria-label={alt || undefined} aria-hidden={alt ? undefined : true} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...props}
      src={fallback ?? src}
      srcSet={fallback ? undefined : srcSet}
      alt={alt}
      className={className}
      onError={() => (fallback ? setFallbackFailed(true) : setFailed(true))}
    />
  );
}
