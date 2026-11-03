/** A composed body: pieces are [x, y, r] circles or [x, y, rx, ry, angle] ellipses, in fractions of the radius, centre 0 0, y down. */
export type BodyPiece = [number, number, number] | [number, number, number, number, number];
export type BodyName = 'circle' | 'squircle' | 'egg' | 'pebble' | 'bear' | 'lemon' | 'ghost' | 'cloud' | 'drop' | 'stack' | 'seacow' | 'flower';
export type Shade = 'flat' | 'gradient';

export interface MascotOptions {
  /** 'hero' (default) keeps every behaviour on. 'avatar' turns off cursor follow, idle wander, lean, breathe, the tap reaction and the shader: calm in a list, blinking stays. Explicit options override the preset. */
  preset?: Preset;
  /** Poke on pointerdown. Default true ('avatar' preset: false). */
  tap?: boolean;
  /** Built-in body name, or an array of pieces for a custom composed body. Default 'circle'. */
  body?: BodyName | BodyPiece[] | { c: BodyPiece[]; sphereR?: number; main?: number; head?: number; k?: number; d?: number };
  /** Body colour as hex, or two hex colours for a top-to-bottom gradient. Eye colour is chosen automatically for contrast. Default '#0a0a0a'. */
  color?: string | [string, string];
  /** 'gradient' adds the light/shadow shader that follows the gaze. Default 'flat'. */
  shade?: Shade;
  /** Mouth stroke width in viewBox units, about 1px each at a 240px render. Default 6. */
  mouthStroke?: number;
  /** Gaze limits in degrees. Defaults 20 and 15. */
  maxYaw?: number; maxPitch?: number;
  /** Automatic behaviour, all on by default. */
  follow?: boolean; idle?: boolean; autoBlink?: boolean; lean?: boolean; breathe?: boolean;
  /** Bear only: occasional ear wiggle. Default false. */
  twitch?: boolean;
  /** Scale composed bodies to a common visual extent. Default true. */
  fit?: boolean;
}

export type ScenarioId = 'turn' | 'nod' | 'quick' | 'blink' | 'poke' | 'idle' | 'think' | 'surprise' | 'twitch';
export type Status = 'idle' | 'thinking' | 'speaking' | 'success' | 'error';
export type Preset = 'hero' | 'avatar';

export interface LiveValues {
  eyeScale?: number; squash?: number; blink?: number;
  /** Mouth curve override, -1 frown .. 1 smile; null returns to the default smile. */
  mouth?: number | null;
  mouthSide?: number; mouthLen?: number; mouthTilt?: number;
}

export interface ActFrame { [key: string]: unknown }
export interface ActDef { dur: number; run: (t: number, A: ActFrame, ctx: { R: number; comp: unknown; self: Mascot }) => void }

export default class Mascot {
  constructor(svg: SVGSVGElement, opts?: MascotOptions);
  /** Live options; assign and call render() (or let the loop pick them up). */
  o: Required<MascotOptions>;
  svg: SVGSVGElement;
  yaw: number; pitch: number;
  /** Suppresses cursor follow and idle wander while true. */
  manual: boolean;
  render(): void;
  /** Smoothly aim at yaw / pitch in degrees, clamped to maxYaw / maxPitch. */
  look(yaw: number, pitch: number): void;
  /** Aim without smoothing. */
  snap(yaw: number, pitch: number): void;
  set(v: LiveValues): void;
  setNow(v: LiveValues): void;
  blink(times?: number): void;
  poke(): void;
  /** Run one of the current body's acts: 'custom1', 'custom2', ... by position (works on every body), or its own key as an alias. Returns the duration in ms, 0 if there is no such act. */
  play(name: string): number;
  /** The current body's acts in order, with the position id you pass to play(). */
  acts(): { id: string; key: string; label: string; hint: string; dur: number }[];
  /** Run any scenario by id, shared ('turn', 'nod', 'quick', 'blink', 'poke', 'idle', 'think', 'surprise', 'twitch') or body-specific ('custom1', ...). Resolves when it ends; `.dur` is the length in ms. Cursor follow and idle pause for the run. */
  run(id: ScenarioId | string): Promise<void> & { dur: number };
  /** Every scenario this body can run: the shared ones plus its own acts. */
  scenarios(): { id: string; label: string; hint: string; dur: number }[];
  /** Persistent state. 'thinking' and 'speaking' loop until the status changes; 'success' plays surprise then holds a smile; 'error' frowns with a short head shake. */
  setStatus(s: Status): this;
  readonly status: Status;
  act(def: ActDef): number;
  think(): number;
  surprise(): number;
  twitch(i?: number): void;
  stopAct(): void;
  /** Start the animation loop: smoothing, idle wander, blinking, cursor follow. */
  start(): void;
  stop(): void;
  /** Standalone SVG string with the body outline baked to a plain path (no filters). */
  toSVG(opts?: { size?: number; id?: string }): string;

  static BODIES: string[];
  static SHAPES: string[];
  static COMPOSED: Record<string, { acts?: Record<string, ActDef> }>;
  static ACTS: Record<string, Record<string, ActDef>>;
  static SHADES: Shade[];
  static PRESETS: Record<Preset, Partial<MascotOptions>>;
  static STATUSES: Status[];
  /** A stable body and colour for an id (agent id, user id): same id, same look. */
  static identity(id: string | number, opts?: { bodies?: BodyName[]; colors?: string[] }): { body: BodyName; color: string };
  /** A baked, filter-free SVG string for a look, cached per distinct look. For lists. */
  static staticSVG(opts?: MascotOptions, out?: { size?: number; id?: string; yaw?: number; pitch?: number }): string;
  /** Shared scenarios with label, hint and length in ms. */
  static SCENARIOS: Record<ScenarioId, { label: string; hint: string; dur: number }>;
  /** Size tokens in px: xs 16, sm 24, md 32, lg 48, xl 64, 2xl 96, 3xl 128, hero 240. */
  static SIZES: Record<'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | 'hero', number>;
  static EYES: string[];
  static COLORS: Record<'black' | 'blue' | 'olive' | 'cyan' | 'orchid' | 'lime', string>;
  static COLORS_DARK: Record<'black' | 'blue' | 'olive' | 'cyan' | 'orchid' | 'lime', string>;
}
