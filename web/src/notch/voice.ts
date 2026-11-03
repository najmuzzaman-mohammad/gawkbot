// Talk to your agents. Two engines behind one interface:
//
//   native   inside the Mac app: SFSpeechRecognizer via the bridge
//            (notch_darwin.m), on-device when the Mac supports it.
//   browser  elsewhere: the Web Speech API (webkitSpeechRecognition), which
//            Safari and Chrome ship.
//
// Neither ever sends anything by itself. The page shows the transcript and
// the human confirms with ↵ (or edits it) before it goes to an agent.

import { isInMacApp, postNative } from "./bridge";

export interface VoiceHandlers {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onEnd: () => void;
}

export interface VoiceSession {
  stop: () => void;
}

interface SpeechResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechResultLike>;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: SpeechEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type SpeechCtor = new () => SpeechRecognitionLike;

function browserEngine(): SpeechCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechCtor;
    webkitSpeechRecognition?: SpeechCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function voiceAvailable(): boolean {
  return isInMacApp() || browserEngine() !== null;
}

// The native engine reports back through window.gawkNotch.voice(...), which
// NotchApp routes here.
let nativeHandlers: VoiceHandlers | null = null;

export function deliverNativeVoice(event: {
  kind: string;
  text?: string;
  message?: string;
}): void {
  const h = nativeHandlers;
  if (!h) return;
  switch (event.kind) {
    case "partial":
      h.onPartial(event.text ?? "");
      break;
    case "final":
      h.onFinal(event.text ?? "");
      break;
    case "error":
      h.onError(event.message ?? "Voice stopped");
      break;
    case "end":
      nativeHandlers = null;
      h.onEnd();
      break;
  }
}

export function startVoice(handlers: VoiceHandlers): VoiceSession | null {
  if (isInMacApp()) {
    nativeHandlers = handlers;
    postNative({ type: "voice", action: "start" });
    return { stop: () => postNative({ type: "voice", action: "stop" }) };
  }
  const Engine = browserEngine();
  if (!Engine) return null;
  const rec = new Engine();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  rec.continuous = true;
  let finalText = "";
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    handlers.onPartial((finalText + interim).trim());
  };
  rec.onerror = (e) =>
    handlers.onError(
      e.error === "not-allowed"
        ? "Microphone permission was denied"
        : "Voice stopped",
    );
  rec.onend = () => {
    handlers.onFinal(finalText.trim());
    handlers.onEnd();
  };
  try {
    rec.start();
  } catch {
    return null;
  }
  return { stop: () => rec.stop() };
}
