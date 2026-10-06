/* eslint-disable @next/next/no-img-element -- group icons are arbitrary
   https links, which next/image would need every host allow-listed for. */

/** A group's icon, or its initials on a dark tile when it has none. */
export default function GroupIcon({ name, iconUrl, size }: { name: string; iconUrl: string; size: number }) {
  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        className="shrink-0 rounded-xl object-cover bg-slate-800"
        style={{ width: size, height: size }}
      />
    );
  }
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "G";
  return (
    <span
      aria-hidden
      className="shrink-0 rounded-xl bg-cyan-500/15 border border-cyan-400/30 text-cyan-100 font-semibold flex items-center justify-center"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {initials}
    </span>
  );
}
