import test from 'node:test';
import assert from 'node:assert/strict';
import { HazardPipeline } from '../dist/hazards.js';
import { BypassPipeline } from '../dist/bypass.js';
import { latency, position, layout, randomFromSeed } from '../dist/simulation.js';

const write = (number, slot, ex, dest, remaining = ex) => ({ number, slot, ex, dest, src: null, remaining });
const read = (number, slot, src) => ({ number, slot, ex: 1, dest: null, src, remaining: 1 });
function fixture(instructions, { bypass = false, interlocks = true } = {}) {
  const model = bypass ? new BypassPipeline('test') : new HazardPipeline('test', true, interlocks);
  model.instructions = structuredClone(instructions);
  model.add = () => {};
  return model;
}

test('1: uniform EX is one cycle; every stage and completion stays in order without stalls', () => {
  const random = randomFromSeed('152');
  const program = Array.from({ length: 30 }, (_, n) => ({ number: n + 1, ...latency(random, false) }));
  for (const i of program) {
    assert.equal(i.ex, 1);
    assert.equal(position(i, i.number + 2), 4);
    assert.equal(position(i, i.number + 3), 5);
    assert.equal(position(i, i.number + 4), 6);
  }
  for (let cycle = 0; cycle < 40; cycle++) {
    const slots = program.map(i => position(i, cycle)).filter(slot => slot >= 2 && slot <= 6);
    assert.equal(new Set(slots).size, slots.length);
    assert.ok([...layout(program, cycle).values()].every(p => !p.conflict));
  }
});

test('2: unchecked issue exposes both reversed WAW completion and WB collisions', () => {
  const waw = fixture([write(1, 4, 4, 0), write(2, 3, 1, 0)], { interlocks: false });
  waw.step();
  assert.equal(waw.issuedAt.get(2), 1);
  assert.match(waw.snapshot().status, /Unchecked:.*WAW x0/);
  for (let n = 0; n < 3; n++) waw.step();
  assert.ok(waw.completedAt.get(2) < waw.completedAt.get(1));
  const collision = fixture([write(1, 4, 2, 0), write(2, 3, 1, 1)], { interlocks: false });
  collision.step(); collision.step();
  assert.equal(collision.instructions.filter(i => i.slot === 5).length, 2);
  assert.match(collision.snapshot().status, /WB structural hazard/);
  assert.ok([...collision.snapshot().positions.values()].every(p => p.conflict));
});

test('3: WAW stalls freeze the frontend, drain EX, and release on the earliest safe cycle', () => {
  const model = fixture([write(1, 4, 4, 0), write(2, 3, 1, 0), write(3, 2, 2, 1), write(4, 1, 1, 2)]);
  assert.match(model.snapshot().status, /WAW/);
  model.step();
  assert.deepEqual(model.instructions.map(i => i.slot), [4, 3, 2, 1]);
  assert.equal(model.instructions[0].remaining, 3);
  model.step();
  assert.match(model.snapshot().status, /WAW.*WB structural/);
  model.step();
  assert.equal(model.snapshot().status, '');
  model.step();
  assert.equal(model.issuedAt.get(2), 4);
  assert.equal(model.completedAt.get(1), 4);
  model.step();
  assert.equal(model.completedAt.get(2), 5);
});

test('3: structural reservation delays different destinations exactly one cycle', () => {
  const model = fixture([write(1, 4, 3, 0), write(2, 3, 2, 1)]);
  assert.match(model.snapshot().status, /WB structural/);
  model.step();
  assert.equal(model.instructions[1].slot, 3);
  assert.equal(model.snapshot().status, '');
  model.step();
  assert.equal(model.issuedAt.get(2), 2);
  model.step(); model.step();
  assert.deepEqual([...model.completedAt], [[1, 3], [2, 4]]);
});

test('3: a later same-register writer need not wait if its WB is strictly later', () => {
  const model = fixture([write(1, 4, 3, 0), write(2, 3, 3, 0)]);
  assert.equal(model.snapshot().status, '');
  model.step();
  assert.equal(model.issuedAt.get(2), 1);
});

test('4: RAW blocks independent younger instructions; WB is visible to same-boundary reads', () => {
  const model = fixture([write(1, 4, 4, 0), read(2, 3, 0), read(3, 2, 1), write(4, 1, 2, 2)]);
  assert.match(model.snapshot().status, /RAW.*Head-of-line blocking/);
  assert.deepEqual(model.snapshot().holInstructions, [3, 4]);
  for (let n = 0; n < 3; n++) model.step();
  assert.equal(model.instructions[2].slot, 2);
  assert.equal(model.snapshot().status, '');
  model.step();
  assert.equal(model.issuedAt.get(2), model.completedAt.get(1));
  assert.equal(model.instructions[2].slot, 3);
});

test('4: HOL highlighting excludes a younger instruction with its own WB conflict', () => {
  const model = fixture([write(1, 4, 4, 0), read(2, 3, 0), write(3, 2, 3, 1)]);
  assert.deepEqual(model.snapshot().holInstructions, []);
});

test('5: oldest-ready issue bypasses RAW; checks unissued older RAW and WAW producers', () => {
  const model = fixture([write(1, 4, 8, 0), read(2, 3, 0), write(3, 3, 2, 1)], { bypass: true });
  assert.equal(model.selection(1).number, 3);
  model.step();
  assert.equal(model.issuedAt.get(3), 1);
  assert.equal(model.issuedAt.has(2), false);
  const pending = fixture([write(1, 3, 2, 0), read(2, 3, 0), write(3, 3, 2, 0)], { bypass: true });
  assert.match(pending.constraints(pending.instructions[1], 1).status, /RAW/);
  assert.match(pending.constraints(pending.instructions[2], 1).status, /WAW/);
});

test('5: WAR is recorded at the actual write boundary, including a same-cycle read', () => {
  // The reader was delayed by the reservation for #3; #4 already bypassed it.
  const model = fixture([read(2, 3, 0), write(3, 4, 2, 1), write(4, 4, 1, 0)], { bypass: true });
  assert.doesNotMatch(model.snapshot().status, /WAR/);
  model.step();
  assert.equal(model.issuedAt.has(2), false); // #3 reserves the reader's next WB.
  assert.match(model.snapshot().status, /WAR x0: #4 wrote at cycle 1/);
  model.step();
  assert.equal(model.issuedAt.get(2), 2);
  assert.match(model.snapshot().status, /WAR/);
  const sameCycle = fixture([read(1, 3, 0), write(2, 4, 1, 0)], { bypass: true });
  sameCycle.step();
  assert.equal(sameCycle.issuedAt.get(1), 1);
  assert.match(sameCycle.snapshot().status, /WAR/);
});

test('5: no WAR when the older reader already captured its operand', () => {
  const model = fixture([read(1, 4, 0), write(2, 4, 1, 0)], { bypass: true });
  model.step();
  assert.doesNotMatch(model.snapshot().status, /WAR/);
});

test('5: decode buffer applies backpressure and reopens as soon as issue frees a slot', () => {
  const model = fixture([write(1, 4, 6, 0), ...[2,3,4,5].map(n => read(n, 3, 0)), read(6, 2, 0), read(7, 1, 0), read(8, 0, 0)], { bypass: true });
  model.step();
  assert.deepEqual(model.instructions.slice(1).map(i => i.slot), [3,3,3,3,2,1,0]);
  for (let n = 0; n < 5; n++) model.step();
  assert.deepEqual(model.instructions.slice(1).map(i => i.slot), [4,3,3,3,3,2,1]);
});

test('all variable pages: seeded runs preserve timing, safe hazards, and snapshot/step agreement', () => {
  const observed = new Set();
  for (const seed of ['152', ...Array.from({length: 30}, (_, n) => `verify-${n}`)]) {
    for (const mode of ['unchecked', 'stalls', 'reads', 'bypass']) {
      const model = mode === 'bypass' ? new BypassPipeline(seed) : new HazardPipeline(seed, mode === 'reads', mode !== 'unchecked');
      let previousIssue = 0;
      const catalog = new Map(), lastWrite = new Map();
      for (let cycle = 0; cycle < 350; cycle++) {
        model.instructions.forEach(i => catalog.set(i.number, {...i}));
        const state = model.snapshot();
        const id = model.instructions.find(i => i.slot === 3);
        const selected = mode === 'bypass' ? model.selection(1) : id && (mode === 'unchecked' || !state.status) ? id : null;
        for (const kind of ['WAW', 'RAW', 'Head-of-line', 'WAR', 'WB structural']) if (state.status.includes(kind)) observed.add(`${mode}:${kind}`);
        const frozen = state.instructions.filter(i => i.slot < 4).map(i => [i.number, i.slot]);
        model.step();
        const issued = model.instructions.filter(i => i.issuedAt === model.cycle);
        assert.deepEqual(issued.map(i => i.number), selected ? [selected.number] : [], `${mode} ${seed} cycle ${cycle}`);
        if (mode !== 'bypass' && mode !== 'unchecked' && state.status) {
          assert.deepEqual(model.instructions.filter(i => i.slot < 4).map(i => [i.number, i.slot]), frozen);
        }
        for (const i of issued) {
          if (mode !== 'bypass') assert.ok(i.number > previousIssue);
          previousIssue = i.number;
          if (i.src !== null) for (const producer of catalog.values()) {
            if (producer.number < i.number && producer.dest === i.src) assert.ok(model.completedAt.get(producer.number) <= model.cycle);
          }
        }
        const wb = model.instructions.filter(i => i.slot === 5);
        if (mode !== 'unchecked') assert.ok(wb.length <= 1);
        for (const i of wb) {
          assert.equal(model.completedAt.get(i.number) - model.issuedAt.get(i.number), i.ex);
          if (i.dest !== null) {
            if (mode !== 'unchecked') assert.ok(i.number > (lastWrite.get(i.dest) ?? 0));
            lastWrite.set(i.dest, i.number);
          }
        }
        if (mode === 'bypass') assert.ok(model.instructions.filter(i => i.slot === 3).length <= 4);
      }
    }
  }
  for (const event of ['unchecked:WAW', 'unchecked:WB structural', 'stalls:WAW', 'stalls:WB structural', 'reads:RAW', 'reads:Head-of-line', 'bypass:WAR']) assert.ok(observed.has(event), event);
});
