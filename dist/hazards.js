import { randomFromSeed, latency } from './simulation.js';

export class HazardPipeline {
  constructor(seed, exaggerated = false) {
    this.random = randomFromSeed(seed);
    this.registerRandom = randomFromSeed(`${seed}:dest`);
    this.exaggerated = exaggerated;
    this.cycle = 0;
    this.retired = 0;
    this.nextNumber = 1;
    this.instructions = [];
    this.issuedAt = new Map();
    this.completed = new Set();
    this.completedAt = new Map();
    this.add(1);
    this.add(0);
  }

  add(slot) {
    const timing = latency(this.random, true);
    const readChoice = this.registerRandom() < 0.65;
    const reads = this.exaggerated && readChoice;
    const register = Math.floor(this.registerRandom() * 4);
    this.instructions.push({ number: this.nextNumber++, kind: 'ALU',
      ex: reads ? 1 : timing.ex * (this.exaggerated ? 3 : 1),
      dest: reads ? null : register, src: reads ? register : null,
      slot, remaining: 0 });
  }

  diagnosis(issueOffset = 1) {
    const id = this.instructions.find(i => i.slot === 3);
    const backend = this.instructions.filter(i => i.slot === 4);
    // ID issues at the next boundary. Existing EX instructions receive that
    // cycle of service first, so compare against their remaining time then.
    const result = { status: '', red: [], yellow: [], wawInstructions: [], holInstructions: [] };
    if (!id) return result;
    const waw = id.dest === null ? [] : backend.filter(i =>
      i.dest === id.dest && id.ex <= i.remaining - issueOffset);
    const structural = backend.filter(i => id.ex === i.remaining - issueOffset);
    const writers = backend.filter(i => i.dest !== null && i.remaining > issueOffset);
    const raw = this.exaggerated && id.src !== null
      ? writers.filter(i => i.dest === id.src) : [];
    if (raw.length) {
      result.status = `Decode stall: RAW x${id.src}`;
      result.red = [id.number, ...raw.map(i => i.number)];
      // Independent short instructions cannot bypass the blocked instruction in ID.
      const pendingRegisters = new Set(writers.map(i => i.dest));
      result.holInstructions = this.instructions.filter(i => i.slot < 3 && i.number > id.number && i.ex === 1
        && (i.src === null || !pendingRegisters.has(i.src))
        && (i.dest === null || (!pendingRegisters.has(i.dest) && i.dest !== id.src))).map(i => i.number);
      result.yellow = [...result.holInstructions];
      if (result.holInstructions.length) result.status += ' · Head-of-line blocking';
    } else if (waw.length) {
      result.status = `Decode stall: WAW x${id.dest}`;
      result.red = [id.number];
      result.yellow = waw.map(i => i.number);
      result.wawInstructions = [...result.red, ...result.yellow];
    } else if (structural.length) {
      result.status = 'Decode stall: WB structural hazard';
      result.red = [id.number];
      result.yellow = structural.map(i => i.number);
    }
    return result;
  }

  step() {
    this.cycle++;
    // WB is a single port; independent instructions may complete out of order.
    this.instructions = this.instructions.filter(i => i.slot < 8);
    for (const i of this.instructions) {
      if (i.slot >= 5) {
        if (i.slot === 5) {
          this.retired++;
          this.completed.add(i.number);
        }
        i.slot++;
      }
    }
    const backend = this.instructions.filter(i => i.slot === 4).sort((a,b) => a.number-b.number);
    for (const i of backend) i.remaining = Math.max(0, i.remaining - 1);
    for (const i of backend) if (i.remaining === 0) {
      i.slot = 5;
      i.completedAt = this.cycle;
      this.completedAt.set(i.number, this.cycle);
    }
    const stall = Boolean(this.diagnosis(0).status);
    const id = this.instructions.find(i => i.slot === 3);
    if (!stall) {
      if (id) {
        id.slot = 4;
        id.remaining = id.ex;
        id.issuedAt = this.cycle;
        this.issuedAt.set(id.number, this.cycle);
      }
      for (const i of this.instructions) if (i !== id && i.slot < 3) i.slot++;
      if (!this.instructions.some(i => i.slot === 0)) this.add(0);
    }
  }

  snapshot() {
    const groups = new Map();
    for (const i of this.instructions) {
      if (!groups.has(i.slot)) groups.set(i.slot, []);
      groups.get(i.slot).push(i);
    }
    const positions = new Map();
    for (const [slot, group] of groups) {
      group.sort((a,b) => a.number-b.number);
      group.forEach((i, rank) => positions.set(i.number, {
        x: 40 + slot*100, y: 94 + rank*84,
        opacity: slot > 7 ? 0 : 1, conflict: false
      }));
    }
    return { positions, instructions: this.instructions.map(i => ({...i})),
      cycle: this.cycle, retired: this.retired, completed: new Set(this.completed), ...this.diagnosis() };
  }
}
