export default function Home() {
  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="text-center max-w-md">
        <div className="text-[28px] font-semibold mb-2">Welcome.</div>
        <div className="text-[15px] text-[var(--text-soft)] leading-relaxed">
          Pick a task on the left to brief an agent on it. They&apos;ll work in the background and ping you when they need input.
        </div>
      </div>
    </div>
  );
}
