import { HazardPipeline, hazardBetween } from './hazards.js?v=clean-war-20261006';

export class BypassPipeline extends HazardPipeline {
  constructor(seed) {
    super(seed, true);
    this.decodeCapacity = 4;
    this.issueBlocks = [];
  }

  add(slot) {
    const writeLatency = this.random() < 0.75 ? 2 : 12;
    const reads = this.registerRandom() < 0.55;
    const register = Math.floor(this.registerRandom() * 4);
    this.instructions.push({ number: this.nextNumber++, kind: 'ALU',
      ex: reads ? 1 : writeLatency, dest: reads ? null : register,
      src: reads ? register : null, slot, remaining: 0 });
  }

  constraints(instruction, issueOffset) {
    const older = this.instructions.filter(i => i.number < instruction.number && i.slot < 5);
    const backend = this.instructions.filter(i => i.slot === 4);
    const raw = instruction.src === null ? [] : older.filter(i => i.dest === instruction.src
      && (i.slot < 4 || i.remaining > issueOffset));
    const waw = instruction.dest === null ? [] : older.filter(i => i.dest === instruction.dest
      && (i.slot < 4 || instruction.ex <= i.remaining - issueOffset));
    const structural = backend.filter(i => instruction.ex === i.remaining - issueOffset);
    const statuses = [], red = new Set(), yellow = new Set();
    if (raw.length) {
      statuses.push(hazardBetween('RAW', instruction, raw, instruction.src));
      red.add(instruction.number);
      raw.forEach(i => red.add(i.number));
    }
    if (waw.length) {
      statuses.push(hazardBetween('WAW', instruction, waw, instruction.dest));
      red.add(instruction.number);
      waw.forEach(i => yellow.add(i.number));
    }
    if (structural.length) {
      statuses.push(hazardBetween('WB structural hazard', instruction, structural));
      red.add(instruction.number);
      structural.forEach(i => yellow.add(i.number));
    }
    return { status: statuses.join(' · '), red: [...red], yellow: [...yellow] };
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
    projected.issueBlocks = [];
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
    // Explain the issue decisions at this cycle boundary, including bypassed candidates.
    const stalled = (this.issueBlocks ?? []).filter(b => queue.some(i => i.number === b.number));
    const reasons = stalled.length ? stalled : blocked.status ? [blocked] : [];
    const red = new Set(reasons.flatMap(b => b.red));
    const yellow = new Set(reasons.flatMap(b => b.yellow));
    const statuses = [...new Set(reasons.flatMap(b => b.status.split(' · ')))];
    if (statuses.length) statuses[0] = `Decode stall: ${statuses[0]}`;
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
    this.issueBlocks = this.instructions.filter(i => i.slot === 3 && (!selected || i.number < selected.number))
      .map(i => ({ number: i.number, ...this.constraints(i, 0) })).filter(b => b.status);
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
