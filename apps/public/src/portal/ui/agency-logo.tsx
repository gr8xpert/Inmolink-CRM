/**
 * An agency's mark on the portal (S15-F10): its logo's public copy (re-encoded WebP under the media CDN, published
 * while it is listed) or, without one, up to two initials of its name. Decorative beside the agency's name (empty
 * `alt`): the name is always written next to it.
 */

/** Up to two initials of the agency's name: its mark when it has published no logo. */
export function initialsOf(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  return words
    .slice(0, 2)
    .map((w) => w.charAt(0).toLocaleUpperCase())
    .join('');
}

const SIZES = {
  /** Result cards: the logo only (no initials — the name follows). */
  sm: { px: 24, box: 'h-6 max-w-16' },
  /** The listing's agency box. */
  md: { px: 40, box: 'h-10 max-w-28' },
  /** The agency's profile. */
  lg: { px: 56, box: 'size-14' },
} as const;

export function AgencyLogo(props: {
  agency: { name: string; logoUrl: string | null };
  size: keyof typeof SIZES;
  className?: string;
}) {
  const { agency } = props;
  const size = SIZES[props.size];
  if (agency.logoUrl) {
    return (
      // biome-ignore lint/performance/noImgElement: a small CDN image already re-encoded to its size (no next/image).
      <img
        src={agency.logoUrl}
        alt=""
        width={size.px}
        height={size.px}
        loading="lazy"
        decoding="async"
        data-agency-logo=""
        className={`${size.box} shrink-0 rounded-md object-contain ${props.className ?? ''}`}
      />
    );
  }
  if (props.size === 'sm') return null;
  return (
    <span
      aria-hidden="true"
      className={`flex ${props.size === 'lg' ? 'size-14 text-xl' : 'size-10 text-base'} shrink-0 items-center justify-center rounded-lg bg-sea-deep font-extrabold tracking-tight text-white ${props.className ?? ''}`}
    >
      {initialsOf(agency.name)}
    </span>
  );
}
