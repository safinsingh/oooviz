import { randomFromSeed, latency } from './simulation.js?v=pipeline-pages-20261006';

export function hazardBetween(kind, instruction, others, register = null) {
  const name = register === null ? kind : `${kind} x${register}`;
  return `${name} between #${instruction.number} and ${others.map(i => `#${i.number}`).join(', ')}`;
}

export class HazardPipeline {
  constructor(seed, exaggerated = false, interlocks = true) {
    this.random = randomFromSeed(seed);
    this.registerRandom = randomFromSeed(`${seed}:dest`);
    this.exaggerated = exaggerated;
    this.interlocks = interlocks;
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

  constraints(instruction, issueOffset = 1) {
    const older = this.instructions.filter(i => i.number < instruction.number && i.slot < 5);
    const backend = this.instructions.filter(i => i.slot === 4);
    // WB happens before operand reads at a boundary. A producer with one
    // cycle left can therefore feed an instruction issuing at the next boundary.
    const raw = instruction.src === null ? [] : older.filter(i => i.dest === instruction.src
      && (i.slot < 4 || i.remaining > issueOffset));
    const waw = instruction.dest === null ? [] : older.filter(i => i.dest === instruction.dest
      && (i.slot < 4 || instruction.ex <= i.remaining - issueOffset));
    // Every instruction uses the single completion/WB slot, including reads.
    const structural = backend.filter(i => instruction.ex === i.remaining - issueOffset);
    const statuses = [], red = new Set(), yellow = new Set();
    for (const [kind, blockers, register] of [
      ['RAW', raw, instruction.src], ['WAW', waw, instruction.dest],
      ['WB structural hazard', structural, null]
    ]) {
      if (!blockers.length) continue;
      statuses.push(hazardBetween(kind, instruction, blockers, register));
      red.add(instruction.number);
      blockers.forEach(i => (kind === 'RAW' ? red : yellow).add(i.number));
    }
    return { status: statuses.join(' · '), red: [...red], yellow: [...yellow],
      raw, waw, structural };
  }

  uncheckedDiagnosis() {
    const active = this.instructions.filter(i => i.slot === 4 || i.slot === 5);
    const statuses = [], red = new Set(), yellow = new Set();
    const wb = active.filter(i => i.slot === 5);
    if (wb.length > 1) {
      statuses.push(hazardBetween('WB structural hazard', wb[0], wb.slice(1)));
      wb.forEach(i => red.add(i.number));
    }
    for (const younger of active) {
      const finish = i => i.slot === 5 ? this.cycle : this.cycle + i.remaining;
      const older = active.filter(i => i.number < younger.number && i.dest === younger.dest
        && finish(i) >= finish(younger));
      if (!older.length) continue;
      statuses.push(hazardBetween('WAW', younger, older, younger.dest));
      red.add(younger.number);
      older.forEach(i => yellow.add(i.number));
    }
    return { status: statuses.length ? `Unchecked: ${statuses.join(' · ')}` : '',
      red: [...red], yellow: [...yellow], wawInstructions: [], holInstructions: [] };
  }

  diagnosis(issueOffset = 1) {
    if (!this.interlocks) return this.uncheckedDiagnosis();
    const id = this.instructions.find(i => i.slot === 3);
    const result = { status: '', red: [], yellow: [], wawInstructions: [], holInstructions: [] };
    if (!id) return result;
    const blockers = this.constraints(id, issueOffset);
    if (!blockers.status) return result;
    result.status = `Decode stall: ${blockers.status}`;
    result.red = blockers.red;
    result.yellow = blockers.yellow;
    result.wawInstructions = blockers.waw.length ? [id.number, ...blockers.waw.map(i => i.number)] : [];
    if (blockers.raw.length) {
      // Mark only instructions that could actually issue now if ID allowed bypass.
      result.holInstructions = this.instructions.filter(i => i.slot < 3 && i.number > id.number
        && !this.constraints(i, issueOffset).status).map(i => i.number);
      result.yellow = [...new Set([...result.yellow, ...result.holInstructions])];
      if (result.holInstructions.length) result.status += ` · Head-of-line blocking: ${result.holInstructions.map(n => `#${n}`).join(', ')} behind #${id.number}`;
    }
    return result;
  }

  advanceBackend() {
    // Interlocked pages reserve the single WB slot when issuing. The unchecked
    // page deliberately permits multiple completions to expose collisions.
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
      // Record actual WAR corruption before this boundary's operand reads.
      // Keep the writer identity on the reader even after the writer leaves view.
      if (i.dest !== null) for (const reader of this.instructions) {
        if (reader.number < i.number && reader.slot <= 3 && reader.src === i.dest) {
          reader.warWriter = i.number;
          reader.warCycle = this.cycle;
        }
      }
    }
  }

  issueInstruction(instruction) {
    instruction.slot = 4;
    instruction.remaining = instruction.ex;
    instruction.issuedAt = this.cycle;
    this.issuedAt.set(instruction.number, this.cycle);
  }

  step() {
    this.cycle++;
    this.advanceBackend();
    const stall = this.interlocks && Boolean(this.diagnosis(0).status);
    const id = this.instructions.find(i => i.slot === 3);
    if (!stall) {
      if (id) this.issueInstruction(id);
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
        opacity: slot > 7 ? 0 : 1, conflict: slot === 5 && group.length > 1
      }));
    }
    return { positions, instructions: this.instructions.map(i => ({...i})),
      cycle: this.cycle, retired: this.retired, completed: new Set(this.completed), ...this.diagnosis() };
  }
}
