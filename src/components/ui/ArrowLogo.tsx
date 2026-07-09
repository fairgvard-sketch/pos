/** Логотип Arrow POS — стрелка в скруглённом квадрате (в духе значка Square). */
export default function ArrowLogo({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" className="fill-current" />
      <path
        d="M11 16h10m0 0-4-4m4 4-4 4"
        fill="none"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
