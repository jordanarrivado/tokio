/**
 * Animated activity icons for the repository map. Each card's tile plays one while an agent works in that
 * repository, and the icon follows what the agent is doing. The map plays them with lottie-web's light SVG
 * player, which needs no eval and so runs under the webview's CSP. The data is drawn here rather than
 * shipped as files: every shape is one color, and the map's CSS paints it with the card's theme color.
 */

export const MASCOT_POSES = ['reading', 'editing', 'running', 'searching', 'messaging', 'blocked', 'done'] as const;
export type MascotPose = typeof MASCOT_POSES[number];

export interface MascotAnimation {
  v: string;
  fr: number;
  ip: number;
  op: number;
  w: number;
  h: number;
  nm: string;
  ddd: 0;
  assets: [];
  layers: object[];
  /** A frame that reads well as a still, shown when the user prefers reduced motion. */
  still: number;
  /** False for a pose that plays once and holds its last frame. */
  loop: boolean;
}

const SIZE = 48;
const FRAMES = 60;

type Vec = number[];
type Keyframes = [number, Vec | number][];

const EASE_IN = { x: [0.4], y: [1] };
const EASE_OUT = { x: [0.6], y: [0] };

const still = (k: unknown) => ({ a: 0, k });

/** An animated property. Keyframe times must rise; a number value is a one-dimensional property. */
function keys(frames: Keyframes, hold = false) {
  return {
    a: 1,
    k: frames.map(([t, value], index) => {
      const s = typeof value === 'number' ? [value] : value;
      if (index === frames.length - 1) return { t, s };
      return hold ? { t, s, h: 1 } : { t, s, i: EASE_IN, o: EASE_OUT };
    })
  };
}

function path(points: Vec[], closed = false) {
  const zero = points.map(() => [0, 0]);
  return { ty: 'sh', ks: still({ i: zero, o: zero, v: points, c: closed }) };
}

const ellipse = (center: Vec, size: Vec) => ({ ty: 'el', p: still(center), s: still(size) });
const rect = (center: Vec, size: Vec, radius: number) => ({ ty: 'rc', p: still(center), s: still(size), r: still(radius) });
const stroke = (width = 3) => ({ ty: 'st', c: still([1, 1, 1, 1]), o: still(100), w: still(width), lc: 2, lj: 2, ml: 4 });
const fill = () => ({ ty: 'fl', c: still([1, 1, 1, 1]), o: still(100), r: 1 });
/** Draws a stroke from its start up to `end` percent. */
const trim = (end: ReturnType<typeof keys>) => ({ ty: 'tm', s: still(0), e: end, o: still(0), m: 1 });

interface Transform {
  p?: object;
  a?: object;
  s?: object;
  r?: object;
  o?: object;
}

function group(items: object[], transform: Transform = {}) {
  return {
    ty: 'gr',
    it: [
      ...items,
      {
        ty: 'tr',
        p: transform.p ?? still([0, 0]),
        a: transform.a ?? still([0, 0]),
        s: transform.s ?? still([100, 100]),
        r: transform.r ?? still(0),
        o: transform.o ?? still(100),
        sk: still(0),
        sa: still(0)
      }
    ]
  };
}

function animation(nm: string, shapes: object[], options: { still: number; loop?: boolean; frames?: number }): MascotAnimation {
  const op = options.frames ?? FRAMES;
  return {
    v: '5.7.4',
    fr: 30,
    ip: 0,
    op,
    w: SIZE,
    h: SIZE,
    nm,
    ddd: 0,
    assets: [],
    layers: [{
      ddd: 0,
      ind: 1,
      ty: 4,
      nm,
      sr: 1,
      ks: { o: still(100), r: still(0), p: still([0, 0, 0]), a: still([0, 0, 0]), s: still([100, 100, 100]) },
      ao: 0,
      shapes,
      ip: 0,
      op,
      st: 0,
      bm: 0
    }],
    still: options.still,
    loop: options.loop ?? true
  };
}

/** An open book whose lines are read one after another. */
function reading(): MascotAnimation {
  const lines = [[[29, 21], [38, 19.5]], [[29, 26], [38, 24.5]], [[29, 31], [35, 30]]].map((points, index) => group(
    [path(points), stroke(2.5), trim(keys([[0, 0], [8 + index * 12, 0], [20 + index * 12, 100], [50, 100], [58, 0]]))]
  ));
  const margin = [[[10, 20], [19, 21.5]], [[10, 25], [19, 26.5]], [[10, 30], [17, 31]]].map((points) => group(
    [path(points), stroke(2.5)],
    { o: still(40) }
  ));
  return animation('reading', [
    ...lines,
    ...margin,
    group([path([[6, 12], [22, 15], [22, 38], [6, 35]], true), stroke(3)]),
    group([path([[42, 12], [26, 15], [26, 38], [42, 35]], true), stroke(3)])
  ], { still: 45 });
}

/** A pencil writing a line, which then clears for the next pass. */
function editing(): MascotAnimation {
  const line = group(
    [path([[8, 40], [16, 36], [24, 40], [32, 36], [40, 40]]), stroke(2.5), trim(keys([[0, 0], [40, 100], [52, 100], [58, 0]]))]
  );
  const pencil = group(
    [
      group([rect([0, 0], [7, 22], 1.5), stroke(2.5)]),
      group([path([[-3.5, 11], [3.5, 11], [0, 17]], true), fill()]),
      group([path([[-3.5, -6], [3.5, -6]]), stroke(2.5)])
    ],
    {
      a: still([0, 17]),
      p: keys([[0, [8, 39]], [10, [16, 35]], [20, [24, 39]], [30, [32, 35]], [40, [40, 39]], [50, [40, 39]], [59, [8, 39]]]),
      r: keys([[0, 32], [20, 38], [40, 32], [59, 32]])
    }
  );
  // Mid-stroke: by the end of the line the pencil leans past the tile's edge.
  return animation('editing', [pencil, line], { still: 30 });
}

/** A terminal with a blinking cursor. */
function running(): MascotAnimation {
  return animation('running', [
    group([path([[13, 19], [19, 24], [13, 29]]), stroke(3)], { p: keys([[0, [0, 0]], [8, [2, 0]], [16, [0, 0]], [59, [0, 0]]]) }),
    group([rect([28, 29], [9, 3], 1), fill()], { o: keys([[0, 100], [15, 0], [30, 100], [45, 0], [59, 0]], true) }),
    group([rect([24, 24], [38, 30], 5), stroke(3)])
  ], { still: 5 });
}

/** A magnifier sweeping in a small circle. */
function searching(): MascotAnimation {
  return animation('searching', [
    group(
      [group([ellipse([20, 20], [18, 18]), stroke(3)]), group([path([[26.5, 26.5], [37, 37]]), stroke(3.5)])],
      {
        p: keys([[0, [24, 24]], [15, [29, 21]], [30, [29, 28]], [45, [22, 28]], [59, [24, 24]]]),
        r: keys([[0, 0], [15, -8], [30, 0], [45, 8], [59, 0]]),
        a: still([24, 24])
      }
    )
  ], { still: 0 });
}

/** A chat bubble with typing dots. */
function messaging(): MascotAnimation {
  const dots = [16, 24, 32].map((x, index) => {
    const start = 2 + index * 8;
    return group(
      [ellipse([x, 21], [4.5, 4.5]), fill()],
      { p: keys([[0, [0, 0]], [start, [0, 0]], [start + 8, [0, -4]], [start + 16, [0, 0]], [59, [0, 0]]]) }
    );
  });
  return animation('messaging', [
    ...dots,
    group([rect([24, 21], [36, 24], 8), stroke(3)]),
    group([path([[15, 33], [12, 41], [22, 33]]), stroke(3)])
  ], { still: 0 });
}

/** A warning sign that shakes, then rests. */
function blocked(): MascotAnimation {
  return animation('blocked', [
    group(
      [
        group([path([[24, 18], [24, 28]]), stroke(3.5)]),
        group([ellipse([24, 34], [3.5, 3.5]), fill()]),
        group([path([[24, 7], [43, 40], [5, 40]], true), stroke(3)])
      ],
      {
        a: still([24, 40]),
        p: still([24, 40]),
        r: keys([[0, 0], [4, -9], [8, 9], [12, -6], [16, 6], [20, 0], [59, 0]])
      }
    )
  ], { still: 30 });
}

/** A circle and a check that draw in once. */
function done(): MascotAnimation {
  return animation('done', [
    group([path([[16, 24.5], [22, 30.5], [33, 18.5]]), stroke(3.5), trim(keys([[0, 0], [12, 0], [26, 100], [29, 100]]))]),
    group([ellipse([24, 24], [34, 34]), stroke(3), trim(keys([[0, 0], [18, 100], [29, 100]]))])
  ], { still: 29, loop: false, frames: 30 });
}

export function buildMascots(): Record<MascotPose, MascotAnimation> {
  return { reading: reading(), editing: editing(), running: running(), searching: searching(), messaging: messaging(), blocked: blocked(), done: done() };
}

/**
 * The robot that sits on each card beside the repository name. It acts out the same poses as the tile icon,
 * and naps while the repository is idle.
 */
export const ROBOT_POSES = [...MASCOT_POSES, 'idle'] as const;
export type RobotPose = typeof ROBOT_POSES[number];

type Eyes = 'open' | 'happy' | 'crossed' | 'closed';

interface RobotParts {
  eyes?: Eyes;
  /** Where the eyes look: the point the eyes' center moves to. */
  look?: object;
  blink?: boolean;
  /** Arm angles in degrees; 0 hangs straight down, and positive swings the arm outward. */
  left?: ReturnType<typeof keys> | number;
  right?: ReturnType<typeof keys> | number;
  /** The whole robot's position and tilt, around its feet. */
  bob?: object;
  tilt?: object;
  /** The antenna light's opacity. */
  antenna?: object;
  extras?: object[];
}

const BOB = keys([[0, [24, 44]], [15, [24, 43]], [30, [24, 44]], [45, [24, 43]], [59, [24, 44]]]);
const BLINK = keys([[0, [100, 100]], [40, [100, 100]], [43, [100, 10]], [46, [100, 100]], [59, [100, 100]]]);

function eyeShapes(eyes: Eyes): object[] {
  return [17.5, 26.5].map((x) => {
    switch (eyes) {
      case 'happy': return group([path([[x - 2.5, 19], [x, 16], [x + 2.5, 19]]), stroke(2.5)]);
      case 'crossed': return group([path([[x - 2, 15.5], [x + 2, 19.5]]), path([[x + 2, 15.5], [x - 2, 19.5]]), stroke(2.5)]);
      case 'closed': return group([path([[x - 2.5, 18], [x + 2.5, 18]]), stroke(2.5)]);
      default: return group([ellipse([x, 17.5], [4.5, 4.5]), fill()]);
    }
  });
}

/** An arm hanging from its shoulder, swung by `angle`; the left arm swings the other way. */
function arm(shoulder: Vec, side: 1 | -1, angle: ReturnType<typeof keys> | number) {
  // A positive rotation turns clockwise, which swings a hanging arm to the left.
  const rotation = typeof angle === 'number' ? still(-angle * side) : {
    a: 1,
    k: angle.k.map((frame) => ({ ...frame, s: [(frame.s as number[])[0] * -side] }))
  };
  return group([path([[0, 0], [0, 8]]), stroke(3)], { p: still(shoulder), r: rotation });
}

function robot(nm: RobotPose, parts: RobotParts, options: { still: number; loop?: boolean; frames?: number }): MascotAnimation {
  const eyes = group(eyeShapes(parts.eyes ?? 'open'), {
    a: still([22, 17.5]),
    p: parts.look ?? still([22, 17.5]),
    s: parts.blink === false ? still([100, 100]) : BLINK
  });
  const body = group(
    [
      ...(parts.extras ?? []),
      eyes,
      group([ellipse([22, 4.5], [4.5, 4.5]), fill()], { o: parts.antenna ?? still(100) }),
      group([path([[22, 7], [22, 10]]), stroke(2.5)]),
      group([rect([22, 17.5], [24, 15], 5), stroke(3)]),
      group([path([[22, 25], [22, 28]]), stroke(2.5)]),
      arm([13.5, 31], -1, parts.left ?? 20),
      arm([30.5, 31], 1, parts.right ?? 20),
      group([rect([22, 35], [17, 13], 3.5), stroke(3)]),
      group([path([[22, 32], [22, 38]]), stroke(2)], { o: still(45) })
    ],
    { a: still([22, 44]), p: parts.bob ?? BOB, r: parts.tilt ?? still(0) }
  );
  return animation(nm, [body], options);
}

/** Alternating arm swings between two angles, `period` frames per swing. */
function swing(from: number, to: number, period: number, offset = 0): ReturnType<typeof keys> {
  const at = (index: number) => (index + offset) % 2 === 0 ? from : to;
  const frames: Keyframes = [];
  for (let index = 0; index * period < FRAMES - 1; index++) frames.push([index * period, at(index)]);
  // End where it started, so the loop has no jump.
  frames.push([FRAMES - 1, at(0)]);
  return keys(frames);
}

export function buildRobots(): Record<RobotPose, MascotAnimation> {
  const lookSide = keys([[0, [20, 17.5]], [12, [20, 17.5]], [22, [24, 17.5]], [34, [24, 17.5]], [44, [20, 17.5]], [59, [20, 17.5]]]);
  const lookAround = keys([[0, [22, 16.5]], [15, [24.5, 17.5]], [30, [22, 19]], [45, [19.5, 17.5]], [59, [22, 16.5]]]);
  const pulse = keys([[0, 100], [15, 35], [30, 100], [45, 35], [59, 100]]);
  const flash = keys([[0, 100], [5, 20], [10, 100], [15, 20], [20, 100], [25, 20], [30, 100], [35, 20], [40, 100], [45, 20], [50, 100], [59, 20]]);
  const wave = keys([[0, 160], [10, 130], [20, 160], [30, 130], [40, 160], [59, 160]]);
  const waves = [0, 1].map((index) => group(
    [path([[30 + index * 4, 1], [32.5 + index * 4, 4.5], [30 + index * 4, 8]]), stroke(2)],
    { o: keys([[0, 0], [8 + index * 8, 0], [16 + index * 8, 100], [40, 100], [50, 0], [59, 0]]) }
  ));
  const sleep = group([path([[33, 3], [38, 3], [33, 8], [38, 8]]), stroke(2)], { o: still(70) });

  return {
    reading: robot('reading', { look: lookSide, antenna: pulse }, { still: 22 }),
    searching: robot('searching', { look: lookAround, tilt: keys([[0, 0], [15, 6], [30, 0], [45, -6], [59, 0]]), antenna: pulse }, { still: 15 }),
    editing: robot('editing', { look: still([22, 19]), right: swing(50, 75, 6), antenna: pulse }, { still: 10 }),
    running: robot('running', { left: swing(20, 60, 7), right: swing(20, 60, 7, 1), antenna: flash }, { still: 7 }),
    messaging: robot('messaging', { right: wave, extras: waves }, { still: 30 }),
    blocked: robot('blocked', {
      eyes: 'crossed',
      blink: false,
      left: 35,
      right: 35,
      bob: still([24, 44]),
      tilt: keys([[0, 0], [4, -10], [8, 10], [12, -7], [16, 7], [20, 0], [59, 0]])
    }, { still: 30 }),
    done: robot('done', { eyes: 'happy', blink: false, right: keys([[0, 20], [12, 150], [20, 125], [28, 150], [36, 125], [44, 150], [59, 150]]) }, { still: 44 }),
    idle: robot('idle', { eyes: 'closed', blink: false, bob: still([24, 44]), extras: [sleep] }, { still: 0, loop: false, frames: 1 })
  };
}
