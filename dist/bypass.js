import { HazardPipeline, hazardBetween } from './hazards.js?v=hazard-pairs-20261006';

export class BypassPipeline extends HazardPipeline {
  constructor(seed) {
    super(seed, true);
    this.decodeCapacity = 4;
  }

  add(slot) {
    super.add(slot);
    const instruction = this.instructions[this.instructions.length - 1];
    if (instruction.dest !== null) instruction.ex = instruction.ex <= 6 ? 2 : 12;
  }

  constraints(instruction, issueOffset) {
    const older = this.instructions.filter(i => i.number < instruction.number && i.slot < 5);
    const backend = this.instructions.filter(i => i.slot === 4);
    const raw = instruction.src === null ? [] : older.filter(i => i.dest === instruction.src
      && (i.slot < 4 || i.remaining > issueOffset));
    const waw = instruction.dest === null ? [] : older.filter(i => i.dest === instruction.dest
      && (i.slot < 4 || instruction.ex <= i.remaining - issueOffset));
    const structural = backend.filter(i => instruction.ex === i.remaining - issueOffset);
    if (raw.length) return { status: hazardBetween('RAW', instruction, raw, instruction.src), red: [instruction.number, ...raw.map(i => i.number)], yellow: [] };
    if (waw.length) return { status: hazardBetween('WAW', instruction, waw, instruction.dest), red: [instruction.number], yellow: waw.map(i => i.number) };
    if (structural.length) return { status: hazardBetween('WB structural hazard', instruction, structural), red: [instruction.number], yellow: structural.map(i => i.number) };
    return { status: '', red: [], yellow: [] };
  }

  selection(issueOffset) {
    return this.instructions.filter(i => i.slot === 3).sort((a, b) => a.number - b.number)
      .find(i => !this.constraints(i, issueOffset).status);
  }

  projectedTiming() {
    const projected = Object.create(BypassPipeline.prototype);
    projected.random = this.random.clone();
    projected.registerRandom = this.registerRandom.clone();
    projected.exaggerated = this.exaggerated;
    projected.decodeCapacity = this.decodeCapacity;
    projected.cycle = this.cycle;
    projected.retired = this.retired;
    projected.nextNumber = this.nextNumber;
    projected.instructions = this.instructions.map(i => ({ ...i }));
    projected.issuedAt = new Map(this.issuedAt);
    projected.completedAt = new Map(this.completedAt);
    projected.completed = new Set(this.completed);
    const waitingReads = this.instructions.filter(i => i.src !== null && i.slot <= 3);
    // Run the same scheduler and seeded instruction stream without touching live state.
    // WAR never participates in selection, so prediction cannot introduce a stall.
    for (let cycle = 0; cycle < 256 && waitingReads.some(i => !projected.issuedAt.has(i.number)); cycle++) {
      projected.step();
    }
    return projected;
  }

  diagnosis(issueOffset = 1) {
    const queue = this.instructions.filter(i => i.slot === 3).sort((a, b) => a.number - b.number);
    const selected = this.selection(issueOffset);
    const oldest = queue[0];
    const blocked = oldest ? this.constraints(oldest, issueOffset) : { status: '', red: [], yellow: [] };
    const red = new Set(blocked.red), yellow = new Set(blocked.yellow);
    const statuses = blocked.status ? [`Decode stall: ${blocked.status}`] : [];
    // WAR requires WB no later than the older reader’s decode/issue cycle.
    const writers = this.instructions.filter(i => i.dest !== null && i.slot >= 4 && i.slot <= 7);
    if (selected && selected.dest !== null) writers.push(selected);
    const timing = writers.length ? this.projectedTiming() : null;
    const warHazards = [];
    for (const writer of writers) {
      const writeCycle = timing?.completedAt.get(writer.number);
      const readers = this.instructions.filter(i => i.number < writer.number && i.slot <= 3 && i.src === writer.dest
        && writeCycle !== undefined && timing.issuedAt.has(i.number)
        && writeCycle <= timing.issuedAt.get(i.number));
      if (!readers.length) continue;
      yellow.add(writer.number);
      red.delete(writer.number);
      for (const reader of readers) red.add(reader.number);
      warHazards.push(hazardBetween('WAR', writer, readers, writer.dest));
    }
    statuses.push(...warHazards);
    return { status: statuses.join(' · '), red: [...red], yellow: [...yellow],
      wawInstructions: [], holInstructions: [] };
  }

  step() {
    this.cycle++;
    this.advanceBackend();
    const selected = this.selection(0);
    if (selected) this.issueInstruction(selected);
    // Decode buffers four instructions; issue selects the oldest ready one.
    // Fetch continues until the buffer fills, so younger instructions can bypass.
    for (let slot = 2; slot >= 0; slot--) {
      const instruction = this.instructions.find(i => i.slot === slot);
      const room = slot === 2
        ? this.instructions.filter(i => i.slot === 3).length < this.decodeCapacity
        : !this.instructions.some(i => i.slot === slot + 1);
      if (instruction && room) instruction.slot++;
    }
    if (!this.instructions.some(i => i.slot === 0)) this.add(0);
  }
}
