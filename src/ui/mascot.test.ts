import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildMascots, buildRobots, MASCOT_POSES, ROBOT_POSES, type MascotAnimation } from './mascot';

/** Every animated property in the data, found by its `a: 1` flag. */
function animatedProperties(value: unknown, found: { k: { t: number }[] }[] = []): { k: { t: number }[] }[] {
  if (Array.isArray(value)) {
    value.forEach((item) => animatedProperties(item, found));
  } else if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (record.a === 1 && Array.isArray(record.k)) {
      found.push(record as { k: { t: number }[] });
    }
    Object.values(record).forEach((item) => animatedProperties(item, found));
  }
  return found;
}

function assertPlayable(animations: Record<string, MascotAnimation>, poses: readonly string[]): void {
  assert.deepEqual(Object.keys(animations).sort(), [...poses].sort());
  for (const pose of poses) {
    const data = animations[pose];
    assert.equal(data.nm, pose);
    assert.ok(data.layers.length > 0, pose);
    assert.ok(data.still >= data.ip && data.still < data.op, `${pose} still frame is inside the animation`);
    for (const property of animatedProperties(data)) {
      const times = property.k.map((frame) => frame.t);
      assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]), `${pose} keyframes rise`);
      assert.ok(times.every((time) => time >= data.ip && time < data.op), `${pose} keyframes stay inside the animation`);
    }
  }
}

test('every tile pose has an animation the player can loop or hold', () => {
  const mascots = buildMascots();
  assertPlayable(mascots, MASCOT_POSES);
  assert.equal(mascots.done.loop, false);
  assert.equal(mascots.editing.loop, true);
});

test('the robot acts out every tile pose, and naps on a single still frame while idle', () => {
  const robots = buildRobots();
  assertPlayable(robots, ROBOT_POSES);
  assert.equal(robots.idle.loop, false);
  assert.equal(robots.idle.op, 1);
  assert.equal(robots.running.loop, true);
});

test('the data embeds safely in an inline script', () => {
  const json = JSON.stringify([buildMascots(), buildRobots()]);
  assert.doesNotMatch(json, /<\/|<!--|\$\{/);
});
