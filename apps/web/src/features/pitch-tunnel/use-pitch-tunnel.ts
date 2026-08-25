import { useLayoutEffect } from "react";
import { useAudioInput, type AudioInputController } from "@/audio/use-audio-input";
import { useRealtimeSession } from "@/realtime/use-realtime-session";
import type { RealtimePresentationPolicy } from "@/realtime/realtime-session-store";
import { sameObservationStream } from "@/realtime/observation-continuity";
import { useUserPreferences } from "@/state/UserPreferencesContext";
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
  return !sameObservationStream(previous.lastAuthority, next.lastAuthority);
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
    || action.type === "reconfigure-tolerance"
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
  const { toleranceCents } = useUserPreferences();
  const realtime = useRealtimeSession(
    reducePitchTunnel,
    () => createPitchTunnel({ laneHalfWidthCents: toleranceCents }),
    30,
    PITCH_TUNNEL_PRESENTATION_POLICY,
  );
  const input = useAudioInput({
    onFrame: (observation) => realtime.observe({ type: "observation", observation }),
  });
  const state = realtime.state;

  useLayoutEffect(() => {
    realtime.dispatch({ type: "reconfigure-tolerance", toleranceCents });
  }, [realtime.dispatch, toleranceCents]);

  return {
    input,
    state,
    metrics: pitchTunnelMetrics(state),
    anchorCurrentPitch: () => realtime.dispatch({ type: "start" }),
    finish: () => realtime.dispatch({ type: "finish" }),
    reset: () => realtime.dispatch({ type: "reset" }),
  };
}
