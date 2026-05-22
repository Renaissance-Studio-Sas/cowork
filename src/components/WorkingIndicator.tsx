"use client";

// Small spinning ring used wherever a session is in the "working" state.
// Replaces the flat blue dot that was hard to distinguish from completed or
// awaiting_input sessions at a glance.
export function WorkingIndicator({
  size = 12,
  className = "",
  title = "Working",
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={`inline-flex shrink-0 ${className}`}
      style={{ width: size, height: size, color: "var(--accent)" }}
    >
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{
          animation: "wb-spin 0.9s linear infinite",
        }}
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="3"
        />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <style>{`@keyframes wb-spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}
