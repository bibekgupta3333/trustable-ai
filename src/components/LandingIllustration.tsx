/**
 * LandingIllustration: decorative hero art for the public landing page.
 *
 * A stylised phone showing a social post with a small neutral AI label badge, plus a magnifier
 * "checking" the post. Purely decorative (aria-hidden, not focusable), no external assets, no
 * red/green. Colours come from CSS classes (`landing-illustration__*` in global.css) and
 * `currentColor`, so it follows the theme. The SVG scales to its container's width.
 */
export default function LandingIllustration() {
  return (
    <svg
      className="landing-illustration"
      viewBox="0 0 240 200"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Soft backdrop */}
      <circle className="landing-illustration__backdrop" cx="120" cy="104" r="88" />

      {/* Phone body */}
      <rect className="landing-illustration__phone" x="66" y="14" width="108" height="176" rx="16" />
      <rect className="landing-illustration__screen" x="74" y="28" width="92" height="150" rx="8" />
      <rect className="landing-illustration__notch" x="106" y="19" width="28" height="4" rx="2" />

      {/* Post header: avatar + name lines */}
      <circle className="landing-illustration__avatar" cx="88" cy="44" r="7" />
      <rect className="landing-illustration__line landing-illustration__line--strong" x="100" y="39" width="40" height="5" rx="2.5" />
      <rect className="landing-illustration__line" x="100" y="47" width="26" height="4" rx="2" />

      {/* Post image */}
      <rect className="landing-illustration__media" x="80" y="58" width="80" height="44" rx="5" />
      <path className="landing-illustration__media-shape" d="M84 98 L104 78 L118 90 L130 80 L156 98 Z" />
      <circle className="landing-illustration__media-shape" cx="142" cy="68" r="5" />

      {/* Post text lines */}
      <rect className="landing-illustration__line" x="80" y="108" width="78" height="4" rx="2" />
      <rect className="landing-illustration__line" x="80" y="116" width="64" height="4" rx="2" />
      <rect className="landing-illustration__line" x="80" y="124" width="70" height="4" rx="2" />

      {/* Neutral AI label badge */}
      <rect className="landing-illustration__badge" x="80" y="136" width="62" height="16" rx="8" />
      <circle className="landing-illustration__badge-dot" cx="90" cy="144" r="3" />
      <rect className="landing-illustration__badge-text" x="97" y="142" width="38" height="4" rx="2" />

      {/* Action row */}
      <rect className="landing-illustration__line" x="80" y="162" width="16" height="4" rx="2" />
      <rect className="landing-illustration__line" x="104" y="162" width="16" height="4" rx="2" />
      <rect className="landing-illustration__line" x="128" y="162" width="16" height="4" rx="2" />

      {/* Magnifier over the label */}
      <g className="landing-illustration__magnifier">
        <circle className="landing-illustration__lens" cx="176" cy="128" r="24" />
        <circle className="landing-illustration__lens-ring" cx="176" cy="128" r="24" />
        <path className="landing-illustration__handle" d="M193 145 L214 166" />
        <path className="landing-illustration__glint" d="M164 116 A15 15 0 0 1 178 111" />
      </g>
    </svg>
  );
}
