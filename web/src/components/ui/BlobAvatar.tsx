import { useId } from "react";

import { BLOB_GRID, smoothBlob } from "../../lib/blobAvatarSmooth";

// The bot mark as a clean vector (lib/blobAvatarSmooth.ts): the same
// per-bot silhouette and colour as the pixel blob, without the grid. The eyes
// are holes, so it composites on any surface. `glossy` adds a soft top
// highlight and contact shadow for the glass surfaces (the notch, the phone).

interface BlobAvatarProps {
  slug: string;
  size: number;
  /** 1 wide open, 0 narrowed. */
  openness?: number;
  glossy?: boolean;
  className?: string;
  /** Accessible name. Omit for a decorative mark. */
  label?: string;
}

export function BlobAvatar({
  slug,
  size,
  openness = 1,
  glossy = false,
  className,
  label,
}: BlobAvatarProps) {
  const blob = smoothBlob(slug, openness);
  const gid = `blob-gloss-${useId().replace(/:/g, "")}`;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${BLOB_GRID} ${BLOB_GRID}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-slug={slug}
    >
      {glossy ? (
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0.38" />
            <stop offset="0.45" stopColor="#fff" stopOpacity="0.06" />
            <stop offset="1" stopColor="#000" stopOpacity="0.18" />
          </linearGradient>
        </defs>
      ) : null}
      <path d={blob.d} fill={blob.color} fillRule="evenodd" />
      {glossy ? (
        <path d={blob.d} fill={`url(#${gid})`} fillRule="evenodd" />
      ) : null}
    </svg>
  );
}
