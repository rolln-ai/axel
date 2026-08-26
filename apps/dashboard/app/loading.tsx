import { Logo } from "./_brand/Logo";

export default function RootLoading() {
  return (
    <div
      className="grid min-h-svh place-items-center bg-background"
      role="status"
      aria-label="Loading Axel"
    >
      <div className="flex flex-col items-center gap-4">
        <div className="flex items-center gap-2">
          <Logo size={28} />
          <span className="text-lg font-semibold tracking-tight">Axel</span>
        </div>
        <div className="h-1 w-32 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <span className="block h-full w-1/3 animate-pulse bg-primary" />
        </div>
      </div>
    </div>
  );
}
