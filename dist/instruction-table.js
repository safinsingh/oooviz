import { HazardPipeline } from './hazards.js';
import { randomFromSeed, latency } from './simulation.js';

export function registerBadge(register) {
  const badge = document.createElement('span');
  badge.className = 'register';
  badge.dataset.register = register;
  badge.textContent = `x${register}`;
  return badge;
}

export class InstructionTable {
  constructor(seed, hazards, exaggerated, variable) {
    this.rows = document.querySelector('#instruction-rows');
    this.viewport = document.querySelector('.instruction-log');
    this.catalog = new Map();
    this.generator = hazards ? new HazardPipeline(seed, exaggerated) : null;
    this.random = randomFromSeed(seed);
    this.registerRandom = randomFromSeed(`${seed}:table`);
    this.nextNumber = 1;
    this.variable = variable;
    this.lastCurrent = null;
  }

  ensure(number) {
    if (this.generator) {
      while (this.generator.nextNumber <= number) this.generator.add(-1);
      for (const instruction of this.generator.instructions) this.catalog.set(instruction.number, instruction);
      this.generator.instructions = [];
    } else {
      while (this.nextNumber <= number) {
        const instruction = { number: this.nextNumber++, ...latency(this.random, this.variable),
          dest: Math.floor(this.registerRandom() * 4), src: null };
        this.catalog.set(instruction.number, instruction);
      }
    }
  }

  update(current, red = [], yellow = [], completed = () => false) {
    const cursor = current ?? 1;
    this.ensure(cursor + 24);
    this.rows.replaceChildren();
    for (let number = Math.max(1, cursor - 8); number <= cursor + 24; number++) {
      const instruction = this.catalog.get(number);
      const row = document.createElement('tr');
      row.dataset.number = number;
      if (this.variable) row.title = `EX latency: ${instruction.ex} cycles`;
      row.classList.toggle('row-blocked', red.includes(number));
      row.classList.toggle('row-producer', yellow.includes(number));
      row.classList.toggle('row-completed', completed(number));
      const index = document.createElement('td');
      const arrow = document.createElement('span');
      arrow.className = 'current-arrow';
      arrow.textContent = number === current ? '→' : '';
      if (number === current) {
        row.setAttribute('aria-current', 'true');
        arrow.setAttribute('aria-label', 'Current instruction in ID');
      }
      index.append(arrow, document.createTextNode(String(number)));
      const writes = document.createElement('td');
      const reads = document.createElement('td');
      if (instruction.dest !== null) writes.append(registerBadge(instruction.dest));
      if (instruction.src !== null) reads.append(registerBadge(instruction.src));
      row.append(index, writes, reads);
      if (this.variable) {
        const cycles = document.createElement('td');
        cycles.className = 'ex-cycles';
        cycles.textContent = instruction.ex;
        row.append(cycles);
      }
      this.rows.append(row);
    }
    if (current !== this.lastCurrent) this.viewport.scrollTop = 0;
    this.lastCurrent = current;
  }
}
