import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IDLE_CLOSE_MS,
  RealtimeClient,
  type RealtimeHost,
  type RealtimePhase,
} from "./client";

// The client against a stand-in browser: a peer that answers at once, a
// microphone of one track, an audio element, and a fetch that returns an
// SDP answer. The broker's mint is mocked. Every server event is a line
// the test writes onto the data channel.

vi.mock("../../api/client", () => ({
  get: vi.fn(),
  post: vi.fn(() =>
    Promise.resolve({
      ephemeral_key: "ek_test",
      model: "gpt-realtime-2.1",
      sdp_url: "https://api.example/v1/realtime/calls",
    }),
  ),
}));

class FakeChannel {
  readyState: RTCDataChannelState = "connecting";
  sent: Record<string, unknown>[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = "closed";
  }
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
  serverSays(event: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

class FakePeer {
  channel = new FakeChannel();
  ontrack: ((e: { streams: MediaStream[] }) => void) | null = null;
  tracks: MediaStreamTrack[] = [];
  closed = false;
  addTrack(t: MediaStreamTrack) {
    this.tracks.push(t);
  }
  createDataChannel() {
    return this.channel as unknown as RTCDataChannel;
  }
  createOffer() {
    return Promise.resolve({
      type: "offer",
      sdp: "v=0 offer",
    } as RTCSessionDescriptionInit);
  }
  setLocalDescription() {
    return Promise.resolve();
  }
  setRemoteDescription() {
    this.channel.open();
    return Promise.resolve();
  }
  close() {
    this.closed = true;
  }
}

function fakeTrack(): MediaStreamTrack & {
  enabled: boolean;
  stopped: boolean;
} {
  const t = {
    enabled: true,
    stopped: false,
    kind: "audio",
    stop() {
      t.stopped = true;
    },
  };
  return t as unknown as MediaStreamTrack & {
    enabled: boolean;
    stopped: boolean;
  };
}

function fakeHost() {
  const peer = new FakePeer();
  const track = fakeTrack();
  const mic = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const audio = {
    autoplay: true,
    srcObject: null,
    pause: vi.fn(),
  } as unknown as HTMLAudioElement;
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const host: RealtimeHost = {
    peer: () => peer as unknown as RTCPeerConnection,
    microphone: () => Promise.resolve(mic),
    audio: () => audio,
    fetch: ((url: string, init: RequestInit) => {
      fetchCalls.push({ url, init });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve("v=0 answer"),
      } as Response);
    }) as typeof fetch,
  };
  return { host, peer, track, audio, fetchCalls };
}

function setup() {
  const f = fakeHost();
  const phases: RealtimePhase[] = [];
  const heard: string[] = [];
  const said: string[] = [];
  const errors: string[] = [];
  const tools = vi.fn((name: string) => Promise.resolve({ ran: name }));
  const client = new RealtimeClient(
    f.host,
    {
      onPhase: (p) => phases.push(p),
      onHeard: (t) => heard.push(t),
      onSaid: (t) => said.push(t),
      onError: (m) => errors.push(m),
    },
    tools,
  );
  return { ...f, client, phases, heard, said, errors, tools };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("talking to the office out loud", () => {
  it("opens on the first hold with the minted key, listens, and commits on release", async () => {
    const s = setup();
    await s.client.hold();
    expect(s.fetchCalls[0].url).toBe("https://api.example/v1/realtime/calls");
    expect(
      (s.fetchCalls[0].init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer ek_test");
    expect(s.fetchCalls[0].init.body).toBe("v=0 offer");
    expect(s.phases).toEqual(["connecting", "listening"]);
    expect(s.track.enabled).toBe(true);
    s.client.release();
    await flush();
    expect(s.track.enabled).toBe(false);
    expect(s.peer.channel.sent.map((e) => e.type)).toEqual([
      "input_audio_buffer.commit",
      "response.create",
    ]);
    expect(s.client.current).toBe("thinking");
  });

  it("shows what was heard and said, and goes quiet when the answer ends", async () => {
    const s = setup();
    await s.client.hold();
    s.client.release();
    await flush();
    s.peer.channel.serverSays({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: " who needs me? ",
    });
    s.peer.channel.serverSays({ type: "response.output_audio.delta" });
    expect(s.client.current).toBe("speaking");
    s.peer.channel.serverSays({
      type: "response.output_audio_transcript.done",
      transcript: "Ops does.",
    });
    s.peer.channel.serverSays({
      type: "response.done",
      response: { output: [] },
    });
    s.peer.channel.serverSays({ type: "output_audio_buffer.stopped" });
    expect(s.heard).toEqual(["who needs me?"]);
    expect(s.said).toEqual(["Ops does."]);
    expect(s.client.current).toBe("idle");
    expect(s.peer.closed).toBe(false); // the session stays up for the next hold
  });

  it("runs a tool call once and hands the result back for a reply", async () => {
    const s = setup();
    await s.client.hold();
    s.client.release();
    await flush();
    s.peer.channel.serverSays({
      type: "response.function_call_arguments.done",
      name: "get_office_state",
      call_id: "c1",
      arguments: "{}",
    });
    s.peer.channel.serverSays({
      type: "response.done",
      response: {
        output: [
          {
            type: "function_call",
            name: "get_office_state",
            call_id: "c1",
            arguments: "{}",
          },
        ],
      },
    });
    await flush();
    expect(s.tools).toHaveBeenCalledTimes(1);
    const types = s.peer.channel.sent.map((e) => e.type);
    expect(types.slice(-2)).toEqual([
      "conversation.item.create",
      "response.create",
    ]);
    const item = s.peer.channel.sent.at(-2)?.item as {
      type: string;
      call_id: string;
      output: string;
    };
    expect(item).toMatchObject({ type: "function_call_output", call_id: "c1" });
    expect(JSON.parse(item.output)).toEqual({ ran: "get_office_state" });
  });

  it("barges in over an answer, and closes itself after a quiet while", async () => {
    const s = setup();
    await s.client.hold();
    s.client.release();
    await flush();
    s.peer.channel.serverSays({ type: "response.output_audio.delta" });
    await s.client.hold();
    expect(s.peer.channel.sent.map((e) => e.type)).toContain("response.cancel");
    expect(s.client.current).toBe("listening");
    s.client.release();
    await flush();
    s.peer.channel.serverSays({
      type: "response.done",
      response: { output: [] },
    });
    expect(s.client.current).toBe("idle");
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS + 10);
    expect(s.peer.closed).toBe(true);
    expect(s.track.stopped).toBe(true);
  });

  it("sends the picture of the screen with the words when one can be taken", async () => {
    const f = fakeHost();
    const client = new RealtimeClient(
      f.host,
      {
        onPhase: () => {},
        snapshot: () => Promise.resolve("data:image/png;base64,AAAA"),
      },
      () => Promise.resolve({}),
    );
    await client.hold();
    client.release();
    await flush();
    const types = f.peer.channel.sent.map((e) => e.type);
    expect(types).toEqual([
      "input_audio_buffer.commit",
      "conversation.item.create",
      "response.create",
    ]);
    const item = f.peer.channel.sent[1].item as {
      role: string;
      content: Array<{ type: string; image_url: string }>;
    };
    expect(item.role).toBe("user");
    expect(item.content[0]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,AAAA",
    });
    // A picture that cannot be taken costs nothing: the answer still comes.
    const g = fakeHost();
    const bare = new RealtimeClient(
      g.host,
      { onPhase: () => {}, snapshot: () => Promise.reject(new Error("no")) },
      () => Promise.resolve({}),
    );
    await bare.hold();
    bare.release();
    await flush();
    expect(g.peer.channel.sent.map((e) => e.type)).toEqual([
      "input_audio_buffer.commit",
      "response.create",
    ]);
  });

  it("reports a failed connection and ends up idle", async () => {
    const f = fakeHost();
    f.host.fetch = (() =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve(""),
      } as Response)) as typeof fetch;
    const errors: string[] = [];
    const client = new RealtimeClient(
      f.host,
      { onPhase: () => {}, onError: (m) => errors.push(m) },
      () => Promise.resolve({}),
    );
    await client.hold();
    expect(errors[0]).toMatch(/401/);
    expect(client.current).toBe("idle");
  });
});
