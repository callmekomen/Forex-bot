/** Ambient layered backdrop: grid, coloured halos, a slow CRT scanline. */
export function Background() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-ink" />
      <div className="grid-bg absolute inset-0 opacity-[0.5] [mask-image:radial-gradient(120%_90%_at_50%_0%,#000_20%,transparent_85%)]" />
      <div className="halo absolute inset-0" />
      <div className="absolute inset-x-0 top-0 h-[520px] animate-scan bg-gradient-to-b from-transparent via-jade/[0.045] to-transparent" />
      <div
        className="absolute inset-0 opacity-[0.16] mix-blend-soft-light"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(255,255,255,0.06) 0px, rgba(255,255,255,0.06) 1px, transparent 1px, transparent 3px)",
        }}
      />
      <div className="absolute inset-x-0 bottom-0 h-64 bg-gradient-to-t from-ink via-ink/70 to-transparent" />
    </div>
  );
}
