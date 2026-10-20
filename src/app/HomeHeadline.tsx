// The homepage's headline and intro. As NeoLinguaMeet it leads with the
// name's own line, "LinguaMeet by Neo" (owner, 2026-10-20); as
// NeoConference it reads as it always has. src/lib/brand.ts switches it.

import { BRAND, type Brand } from "@/lib/brand";

export default function HomeHeadline({ brand = BRAND }: { brand?: Brand }) {
  if (brand.tagline) {
    // "LinguaMeet by Neo" → "LinguaMeet" and "by Neo".
    const [lead, ...rest] = brand.tagline.split(" ");
    return (
      <>
        <h1 className="mt-6 text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.05]">
          <span className="text-white/90">{lead}</span>
          <br />
          <span className="neo-gradient-text neo-text-glow">{rest.join(" ")}.</span>
        </h1>

        <p className="mt-6 max-w-xl text-lg text-cyan-100/70 leading-relaxed">
          One meeting, every language. {brand.name} translates your meetings live. Everyone picks
          their own language and hears each speaker in it, spoken aloud as they talk, with the
          original voice quietly underneath. On the web and in the Android app.
        </p>
      </>
    );
  }
  return (
    <>
      <h1 className="mt-6 text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.05]">
        <span className="text-white/90">One meeting.</span>
        <br />
        <span className="neo-gradient-text neo-text-glow">Every language.</span>
      </h1>

      <p className="mt-6 max-w-xl text-lg text-cyan-100/70 leading-relaxed">
        {brand.name} translates your meetings live. Everyone picks their own language and
        hears each speaker in it, spoken aloud as they talk, with the original voice quietly
        underneath. On the web and in the Android app.
      </p>
    </>
  );
}
