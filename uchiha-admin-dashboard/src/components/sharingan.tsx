interface SharinganProps {
  className?: string;
  spinning?: boolean;
}

/** Mangekyō-style crest used as the console mark. */
export function Sharingan({ className, spinning = false }: SharinganProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      role="img"
      aria-label="Sharingan crest"
      className={className}
    >
      <circle cx="50" cy="50" r="48" fill="oklch(0.42 0.19 25)" />
      <circle
        cx="50"
        cy="50"
        r="46"
        fill="none"
        stroke="oklch(0.12 0.01 20)"
        strokeWidth="3"
      />
      <g className={spinning ? "spin-slow" : undefined} style={{ transformOrigin: "50% 50%" }}>
        {[0, 120, 240].map((deg) => (
          <path
            key={deg}
            d="M50 50 L50 8 C 30 14, 26 34, 40 44 Z"
            fill="oklch(0.12 0.01 20)"
            transform={`rotate(${deg} 50 50)`}
          />
        ))}
      </g>
      <circle cx="50" cy="50" r="9" fill="oklch(0.12 0.01 20)" />
    </svg>
  );
}