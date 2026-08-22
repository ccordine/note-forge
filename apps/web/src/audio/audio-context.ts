let sharedContext: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === "closed") {
    sharedContext = new AudioContext({ latencyHint: "interactive" });
  }
  return sharedContext;
}

export async function ensureAudioReady(): Promise<AudioContext> {
  const context = getAudioContext();
  if (context.state === "suspended") await context.resume();
  return context;
}

export async function closeAudioContext(): Promise<void> {
  if (sharedContext && sharedContext.state !== "closed") await sharedContext.close();
  sharedContext = null;
}
