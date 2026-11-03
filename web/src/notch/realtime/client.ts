import { get, post } from "../../api/client";

/**
 * Talking to the office out loud, over OpenAI's Realtime API. The broker
 * mints a short-lived key with the whole session set (instructions,
 * tools, hold-to-talk, voice); this client does the WebRTC handshake,
 * holds the microphone open only while the talk key is down, plays the
 * answer, and runs each tool call the voice makes against the office.
 *
 * It never sees the real API key, never sends audio by itself, and closes
 * on its own after a quiet while. Outside a browser with WebRTC, or with
 * no key configured, `realtimeAvailable` says so and the notch keeps its
 * dictation.
 */

export type RealtimePhase =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking";

export interface RealtimeSession {
  ephemeral_key: string;
  model: string;
  sdp_url: string;
  expires_at?: number;
}

export interface RealtimeStatus {
  configured: boolean;
  model?: string;
  voice?: string;
}

/** A tool call the voice made; the result goes back as a string. */
export type ToolRunner = (name: string, args: unknown) => Promise<unknown>;

export interface RealtimeEvents {
  onPhase: (phase: RealtimePhase) => void;
  /**
   * One picture of what is in front, taken when the key comes up and
   * sent with the words, so "what is this PR waiting on?" has the page
   * to look at. Absent, or resolving to null, nothing is attached.
   */
  snapshot?: () => Promise<string | null>;
  /** What the voice heard, once it is sure. */
  onHeard?: (text: string) => void;
  /** What the voice said, once it has finished saying it. */
  onSaid?: (text: string) => void;
  onError?: (message: string) => void;
}

/** How long a quiet session stays open before it closes itself. */
export const IDLE_CLOSE_MS = 90_000;
/** How long the answer waits for the screenshot before going without it. */
export const SNAPSHOT_WAIT_MS = 1_500;

export function getRealtimeStatus() {
  return get<RealtimeStatus>("/realtime/status");
}

function mintSession() {
  return post<RealtimeSession>("/realtime/session", {});
}

/** The browser pieces the client needs; tests hand in fakes. */
export interface RealtimeHost {
  peer: () => RTCPeerConnection;
  microphone: () => Promise<MediaStream>;
  audio: () => HTMLAudioElement;
  fetch: typeof fetch;
}

export function browserHost(): RealtimeHost | null {
  if (
    typeof RTCPeerConnection === "undefined" ||
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia
  )
    return null;
  return {
    peer: () => new RTCPeerConnection(),
    microphone: () => navigator.mediaDevices.getUserMedia({ audio: true }),
    audio: () => {
      const el = document.createElement("audio");
      el.autoplay = true;
      return el;
    },
    fetch: (input, init) => fetch(input, init),
  };
}

interface ServerEvent {
  type: string;
  transcript?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  error?: { message?: string };
  response?: {
    output?: Array<{
      type?: string;
      name?: string;
      call_id?: string;
      arguments?: string;
    }>;
  };
}

export class RealtimeClient {
  private phase: RealtimePhase = "idle";
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private holding = false;
  private opening: Promise<void> | null = null;
  private ran = new Set<string>();

  constructor(
    private readonly host: RealtimeHost,
    private readonly events: RealtimeEvents,
    private readonly runTool: ToolRunner,
  ) {}

  get current(): RealtimePhase {
    return this.phase;
  }

  /** The talk key went down: open the session if need be and listen. */
  async hold(): Promise<void> {
    this.holding = true;
    this.touch();
    if (!this.peer) {
      this.opening ??= this.open();
      try {
        await this.opening;
      } catch (err) {
        this.opening = null;
        this.fail(err instanceof Error ? err.message : "Voice could not start");
        return;
      }
      this.opening = null;
    }
    if (!this.holding) return; // let go while connecting
    if (this.phase === "speaking") {
      // Barge in: the person has something to say over the answer.
      this.send({ type: "response.cancel" });
      this.send({ type: "output_audio_buffer.clear" });
    }
    this.setMic(true);
    this.setPhase("listening");
  }

  /** The talk key came up: send what was heard and wait for the answer. */
  release(): void {
    if (!this.holding) return;
    this.holding = false;
    if (!this.channel || this.phase !== "listening") return;
    this.setMic(false);
    this.send({ type: "input_audio_buffer.commit" });
    this.setPhase("thinking");
    this.touch();
    void this.answerWithSnapshot();
  }

  /** Attaches the picture when there is one within the wait, then asks for the answer. */
  private async answerWithSnapshot(): Promise<void> {
    const take = this.events.snapshot;
    if (take) {
      const picture = await Promise.race([
        take().catch(() => null),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), SNAPSHOT_WAIT_MS),
        ),
      ]);
      if (picture && this.channel) {
        this.send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_image", image_url: picture }],
          },
        });
      }
    }
    this.send({ type: "response.create" });
  }

  /** Ends the session now (Esc, the notch closing, quitting). */
  close(): void {
    this.holding = false;
    this.clearIdle();
    this.setMic(false);
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.mic = null;
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
      this.audio = null;
    }
    this.setPhase("idle");
  }

  private async open(): Promise<void> {
    this.setPhase("connecting");
    const session = await mintSession();
    const mic = await this.host.microphone();
    this.mic = mic;
    this.setMic(false);
    const peer = this.host.peer();
    this.peer = peer;
    const audio = this.host.audio();
    this.audio = audio;
    peer.ontrack = (e) => {
      audio.srcObject = e.streams[0] ?? null;
    };
    for (const track of mic.getTracks()) peer.addTrack(track, mic);
    const channel = peer.createDataChannel("oai-events");
    this.channel = channel;
    channel.onmessage = (e) => this.onServerEvent(String(e.data));
    channel.onclose = () => {
      if (this.peer === peer) this.close();
    };
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const res = await this.host.fetch(session.sdp_url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.ephemeral_key}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp ?? "",
    });
    if (!res.ok) throw new Error(`Voice could not connect (${res.status})`);
    const answer = await res.text();
    await peer.setRemoteDescription({ type: "answer", sdp: answer });
    await new Promise<void>((resolve, reject) => {
      if (channel.readyState === "open") return resolve();
      channel.onopen = () => resolve();
      channel.onerror = () => reject(new Error("Voice channel failed"));
    });
  }

  private onServerEvent(raw: string): void {
    let ev: ServerEvent;
    try {
      ev = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }
    this.touch();
    switch (ev.type) {
      case "conversation.item.input_audio_transcription.completed":
        if (ev.transcript) this.events.onHeard?.(ev.transcript.trim());
        break;
      case "response.output_audio.delta":
      case "output_audio_buffer.started":
        if (this.phase === "thinking") this.setPhase("speaking");
        break;
      case "response.output_audio_transcript.done":
        if (ev.transcript) this.events.onSaid?.(ev.transcript.trim());
        break;
      case "response.function_call_arguments.done":
        if (ev.name && ev.call_id)
          void this.runCall(ev.name, ev.call_id, ev.arguments ?? "{}");
        break;
      case "response.done":
        for (const out of ev.response?.output ?? []) {
          if (out.type === "function_call" && out.name && out.call_id)
            void this.runCall(out.name, out.call_id, out.arguments ?? "{}");
        }
        if (this.phase === "thinking" && !this.pendingCalls)
          this.setPhase(this.holding ? "listening" : "idleOpen");
        break;
      case "output_audio_buffer.stopped":
        if (this.phase === "speaking")
          this.setPhase(this.holding ? "listening" : "idleOpen");
        break;
      case "error":
        this.fail(ev.error?.message ?? "Voice error");
        break;
      default:
        break;
    }
  }

  private pendingCalls = 0;

  private async runCall(
    name: string,
    callId: string,
    args: string,
  ): Promise<void> {
    if (this.ran.has(callId)) return;
    this.ran.add(callId);
    this.pendingCalls++;
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(args);
    } catch {
      parsed = {};
    }
    let output: unknown;
    try {
      output = await this.runTool(name, parsed);
    } catch (err) {
      output = { error: err instanceof Error ? err.message : "failed" };
    }
    this.pendingCalls--;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output ?? {}),
      },
    });
    this.send({ type: "response.create" });
    this.setPhase("thinking");
  }

  private setMic(on: boolean): void {
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = on;
  }

  private send(event: Record<string, unknown>): void {
    if (this.channel?.readyState === "open")
      this.channel.send(JSON.stringify(event));
  }

  private setPhase(phase: RealtimePhase | "idleOpen"): void {
    // "idleOpen": the session stays up, quiet, until the idle timer closes it.
    const next: RealtimePhase = phase === "idleOpen" ? "idle" : phase;
    if (this.phase === next) return;
    this.phase = next;
    this.events.onPhase(next);
  }

  private touch(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      if (
        !this.holding &&
        this.phase !== "speaking" &&
        this.phase !== "thinking"
      )
        this.close();
      else this.touch();
    }, IDLE_CLOSE_MS);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private fail(message: string): void {
    this.events.onError?.(message);
    this.close();
  }
}
