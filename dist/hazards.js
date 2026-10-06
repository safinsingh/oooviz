import { randomFromSeed, latency } from './simulation.js';

export class HazardPipeline {
  constructor(seed) {
    this.random = randomFromSeed(seed);
    this.destinationRandom = randomFromSeed(`${seed}:dest`);
    this.cycle = 0;
    this.retired = 0;
    this.nextNumber = 1;
    this.instructions = [];
    this.status = '';
    this.add(1);
    this.add(0);
  }

  add(slot) {
    const timing = latency(this.random, true);
    this.instructions.push({ number: this.nextNumber++, ...timing,
      dest: Math.floor(this.destinationRandom() * 4), slot, remaining: 0, revealed: false });
  }

  step() {
    this.cycle++;
    this.status = '';
    // WB is a single write port; retiring always follows program order.
    this.instructions = this.instructions.filter(i => i.slot < 8);
    for (const i of this.instructions) {
      if (i.slot >= 5) {
        if (i.slot === 5) this.retired++;
        i.slot++;
      }
    }
    const backend = this.instructions.filter(i => i.slot === 4).sort((a,b) => a.number-b.number);
    for (const i of backend) {
      i.remaining = Math.max(0, i.remaining - 1);
      if (i.kind === 'MEM') i.revealed = true;
    }
    const memoryWait = backend.find(i => i.kind === 'MEM' && i.remaining > 0);
    if (memoryWait) this.status = `Backend stall: MEM #${memoryWait.number}`;
    // Younger results cannot pass an older incomplete instruction, even if ready.
    const ready = backend.filter(i => i.remaining === 0);
    if (backend[0]?.remaining === 0) backend[0].slot = 5;
    const blockedReady = ready.filter(i => i.slot === 4);
    if (blockedReady.length) {
      const waw = blockedReady.find(i => backend.some(older => older.number < i.number && older.dest === i.dest));
      this.status = waw ? `Backend stall: WAW r${waw.dest}` : 'Backend stall: WB structural hazard';
    }

    const id = this.instructions.find(i => i.slot === 3);
    const occupied = this.instructions.filter(i => i.slot === 4);
    let stall = Boolean(memoryWait || blockedReady.length);
    if (id && !stall && id.kind === 'ALU') {
      const duration = id.ex;
      // Decode knows ALU completion times. Memory is predicted as one cycle
      // until the backend reports its delay; no memory latency stall at decode.
      const conflicts = occupied.filter(i => duration <= (i.kind === 'MEM' && !i.revealed ? 1 : i.remaining));
      if (conflicts.length) {
        stall = true;
        const waw = conflicts.find(i => i.dest === id.dest);
        const structural = conflicts.some(i => duration === i.remaining);
        this.status = waw ? `Decode stall: WAW r${id.dest}` : structural ? 'Decode stall: WB structural hazard' : 'Decode stall: ALU completion order';
      }
    }
    if (!stall) {
      if (id) {
        id.slot = 4;
        id.remaining = Math.max(id.ex, id.mem);
      }
      // Frontend advances together only when decode can accept another instruction.
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
      cycle: this.cycle, retired: this.retired, status: this.status };
  }
}
