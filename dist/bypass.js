import { HazardPipeline } from './hazards.js?v=pipeline-pages-20261006';

export class BypassPipeline extends HazardPipeline {
  constructor(seed) {
    super(seed, true);
    this.decodeCapacity = 4;
  }

  add(slot) {
    const writeLatency = this.random() < 0.75 ? 2 : 12;
    const reads = this.registerRandom() < 0.55;
    const register = Math.floor(this.registerRandom() * 4);
    this.instructions.push({ number: this.nextNumber++, kind: 'ALU',
      ex: reads ? 1 : writeLatency, dest: reads ? null : register,
      src: reads ? register : null, slot, remaining: 0 });
  }

  selection(issueOffset) {
    return this.instructions.filter(i => i.slot === 3).sort((a, b) => a.number - b.number)
      .find(i => !this.constraints(i, issueOffset).status);
  }

  diagnosis(issueOffset = 1) {
    const queue = this.instructions.filter(i => i.slot === 3).sort((a, b) => a.number - b.number);
    const selected = this.selection(issueOffset);
    // These are the same constraints used for the upcoming issue decision.
    const blocked = queue.filter(i => !selected || i.number < selected.number)
      .map(i => this.constraints(i, issueOffset)).filter(b => b.status);
    const red = new Set(blocked.flatMap(b => b.red));
    const yellow = new Set(blocked.flatMap(b => b.yellow));
    const statuses = blocked.map(b => b.status);
    if (statuses.length) statuses[0] = `${selected ? `Issue #${selected.number} bypasses #${queue[0].number}` : 'Issue stall'}: ${statuses[0]}`;
    for (const reader of this.instructions.filter(i => i.warWriter !== undefined && i.slot <= 5)) {
      red.add(reader.number);
      yellow.add(reader.warWriter);
      statuses.push(`WAR x${reader.src}: #${reader.warWriter} wrote at cycle ${reader.warCycle} before #${reader.number} read`);
    }
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
