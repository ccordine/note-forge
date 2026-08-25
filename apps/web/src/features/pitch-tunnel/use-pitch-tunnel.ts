import { useAudioInput, type AudioInputController } from "@/audio/use-audio-input";
import { useRealtimeSession } from "@/realtime/use-realtime-session";
import type { RealtimePresentationPolicy } from "@/realtime/realtime-session-store";
import {
  createPitchTunnel,
  pitchTunnelMetrics,
  reducePitchTunnel,
  type PitchTunnelMetrics,
  type PitchTunnelState,
} from "./pitch-tunnel-engine";

type PitchTunnelAction = Parameters<typeof reducePitchTunnel>[1];

function authorityChanged(
  previous: Readonly<PitchTunnelState>,
  next: Readonly<PitchTunnelState>,
): boolean {
  if (!previous.lastAuthority || !next.lastAuthority) return false;
  return previous.lastAuthority.captureEpoch !== next.lastAuthority.captureEpoch
    || previous.lastAuthority.continuityEpoch !== next.lastAuthority.continuityEpoch
    || previous.lastAuthority.graphGeneration !== next.lastAuthority.graphGeneration;
}

export const PITCH_TUNNEL_PRESENTATION_POLICY = Object.freeze({
  shouldPublishImmediately: (
    previous: Readonly<PitchTunnelState>,
    next: Readonly<PitchTunnelState>,
    action: Readonly<PitchTunnelAction>,
  ) => (
    previous.currentObservationKind !== next.currentObservationKind
    || previous.status !== next.status
    || previous.achievementReached !== next.achievementReached
    || previous.checkpoint?.index !== next.checkpoint?.index
    || authorityChanged(previous, next)
    || (action.type === "observation" && action.observation.discontinuity)
  ),
}) satisfies RealtimePresentationPolicy<PitchTunnelState, PitchTunnelAction>;

export interface PitchTunnelSession {
  readonly input: AudioInputController;
  readonly state: PitchTunnelState;
  readonly metrics: Readonly<PitchTunnelMetrics>;
  readonly anchorCurrentPitch: () => void;
  readonly finish: () => void;
  readonly reset: () => void;
}

/**
 * Bridges the app-owned observation stream into one bounded React projection.
 * Every detector observation is reduced synchronously before presentation.
 */
export function usePitchTunnel(): PitchTunnelSession {
  const realtime = useRealtimeSession(
    reducePitchTunnel,
    createPitchTunnel,
    30,
    PITCH_TUNNEL_PRESENTATION_POLICY,
  );
  const state = realtime.state;
  const checkpoint = state.checkpoint;
  const input = useAudioInput({
    diagnostics: {
      flow: "pitch-tunnel",
      phase: state.status,
      targetMidi: checkpoint?.targetMidiFloat ?? null,
      toleranceCents: state.options.laneHalfWidthCents,
      stableMs: (checkpoint?.heldSeconds ?? 0) * 1_000,
      requiredHoldMs: state.options.requiredInLaneSeconds * 1_000,
      resetReason: null,
    },
    onFrame: (observation) => realtime.observe({ type: "observation", observation }),
  });

  return {
    input,
    state,
    metrics: pitchTunnelMetrics(state),
    anchorCurrentPitch: () => realtime.dispatch({ type: "start" }),
    finish: () => realtime.dispatch({ type: "finish" }),
    reset: () => realtime.dispatch({ type: "reset" }),
  };
}
