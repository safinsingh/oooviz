import { HazardPipeline } from './hazards.js?v=page5-20261006';

export class BypassPipeline extends HazardPipeline {
  constructor(seed) {
    super(seed, true);
    this.decodeCapacity = 4;
  }

  constraints(instruction, issueOffset) {
    const older = this.instructions.filter(i => i.number < instruction.number && i.slot < 5);
    const backend = this.instructions.filter(i => i.slot === 4);
    const raw = instruction.src === null ? [] : older.filter(i => i.dest === instruction.src
      && (i.slot < 4 || i.remaining > issueOffset));
    const waw = instruction.dest === null ? [] : older.filter(i => i.dest === instruction.dest
      && (i.slot < 4 || instruction.ex <= i.remaining - issueOffset));
    const structural = backend.filter(i => instruction.ex === i.remaining - issueOffset);
    if (raw.length) return { status: `RAW x${instruction.src}`, red: [instruction.number, ...raw.map(i => i.number)], yellow: [] };
    if (waw.length) return { status: `WAW x${instruction.dest}`, red: [instruction.number], yellow: waw.map(i => i.number) };
    if (structural.length) return { status: 'WB structural hazard', red: [instruction.number], yellow: structural.map(i => i.number) };
    return { status: '', red: [], yellow: [] };
  }

  selection(issueOffset) {
    return this.instructions.filter(i => i.slot === 3).sort((a, b) => a.number - b.number)
      .find(i => !this.constraints(i, issueOffset).status);
  }

  diagnosis(issueOffset = 1) {
    const queue = this.instructions.filter(i => i.slot === 3).sort((a, b) => a.number - b.number);
    const selected = this.selection(issueOffset);
    const oldest = queue[0];
    const blocked = oldest ? this.constraints(oldest, issueOffset) : { status: '', red: [], yellow: [] };
    const red = new Set(blocked.red), yellow = new Set(blocked.yellow);
    const statuses = blocked.status ? [`Decode stall: ${blocked.status}`] : [];
    if (selected && oldest && selected !== oldest) statuses.push(`Bypass: instruction ${selected.number}`);
    // WAR is informational: a younger writer can issue before an older read.
    const writers = this.instructions.filter(i => i.dest !== null && i.slot >= 4 && i.slot <= 7);
    if (selected && selected.dest !== null) writers.push(selected);
    const warRegisters = new Set();
    for (const writer of writers) {
      const readers = this.instructions.filter(i => i.number < writer.number && i.slot <= 3 && i.src === writer.dest);
      if (!readers.length) continue;
      yellow.add(writer.number);
      red.delete(writer.number);
      for (const reader of readers) red.add(reader.number);
      warRegisters.add(writer.dest);
    }
    if (warRegisters.size) statuses.push(`WAR ${[...warRegisters].map(r => `x${r}`).join(', ')}`);
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
