export default function Logo({ size = 32, color = '#7c3aed' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" xmlns="http://www.w3.org/2000/svg" width={size} height={size}>
      <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
      <path d="M7.5 7.5h8" strokeWidth="1" />
      <path d="M13.5 5.5l2.5 2-2.5 2" strokeWidth="1" />
      <path d="M7.5 12h8" strokeWidth="1" />
      <path d="M7.5 16.5h8" strokeWidth="1" />
    </svg>
  );
}
