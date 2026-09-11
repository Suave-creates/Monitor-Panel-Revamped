export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startNddShiftLogScheduler } = await import("@/lib/server/ndd-shift-log");
  startNddShiftLogScheduler();
}
