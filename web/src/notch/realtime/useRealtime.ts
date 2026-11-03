import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { captureScreen } from "../api";
import { play } from "../sounds";
import {
  browserHost,
  getRealtimeStatus,
  RealtimeClient,
  type RealtimePhase,
} from "./client";
import { runOfficeTool } from "./tools";

export interface RealtimeTalk {
  /** Whether holding the talk key talks to the office out loud. */
  available: boolean;
  phase: RealtimePhase;
  /** The last thing the voice heard and said. */
  heard: string | null;
  said: string | null;
  error: string | null;
  /** Press and release the talk key. */
  hold: () => void;
  release: () => void;
  /** Ends the session (Esc, the notch closing). */
  end: () => void;
}

/**
 * The talk key as a conversation: when the office has an OpenAI key and
 * this page has WebRTC, holding the key opens a Realtime session, and the
 * office answers out loud. Otherwise `available` is false and the notch
 * keeps its dictation into the reply box.
 */
export function useRealtime(
  enabled: boolean,
  screenCapture = false,
): RealtimeTalk {
  const status = useQuery({
    queryKey: ["realtime-status"],
    queryFn: getRealtimeStatus,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
  const host = useRef(browserHost());
  const available =
    enabled && status.data?.configured === true && host.current !== null;
  const [phase, setPhase] = useState<RealtimePhase>("idle");
  const [heard, setHeard] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const client = useRef<RealtimeClient | null>(null);
  // Whether the office may take a picture of the screen (the Mac app, with
  // Screen Recording granted); read at key-up, so it follows the state.
  const captureRef = useRef(screenCapture);
  captureRef.current = screenCapture;

  const ensure = useCallback(() => {
    if (client.current || !host.current) return client.current;
    client.current = new RealtimeClient(
      host.current,
      {
        onPhase: (p) => {
          setPhase(p);
          if (p === "listening") play("listen_start");
          if (p === "thinking") play("listen_stop");
        },
        onHeard: (t) => setHeard(t),
        onSaid: (t) => setSaid(t),
        onError: (m) => setError(m),
        snapshot: () =>
          captureRef.current
            ? captureScreen()
                .then((r) => r.data_url || null)
                .catch(() => null)
            : Promise.resolve(null),
      },
      runOfficeTool,
    );
    return client.current;
  }, []);

  const hold = useCallback(() => {
    setError(null);
    void ensure()?.hold();
  }, [ensure]);
  const release = useCallback(() => client.current?.release(), []);
  const end = useCallback(() => {
    client.current?.close();
    setHeard(null);
    setSaid(null);
  }, []);

  useEffect(() => () => client.current?.close(), []);

  return { available, phase, heard, said, error, hold, release, end };
}
