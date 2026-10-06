// One new instruction per cycle. Long stages are independently pipelined.
export function randomFromSeed(seed) {
  let state = 2166136261;
  for (const char of String(seed)) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function latency(random, variable) {
  if (!variable) return { ex: 1, mem: 1 };
  return random() < 0.5
    ? { ex: 1 + Math.floor(random() * 4), mem: 1 }
    : { ex: 1, mem: random() < 0.5 ? 1 : 5 };
}

export function position(instruction, tick, variable = false) {
  const age = tick - (instruction.number - 2);
  if (age < 4) return age;
  if (variable) {
    const backendCycles = Math.max(instruction.ex, instruction.mem);
    if (age < 4 + backendCycles) return 4;
    return 5 + age - (4 + backendCycles);
  }
  if (age < 4 + instruction.ex) return 4;
  if (age < 4 + instruction.ex + instruction.mem) return 5;
  return 6 + age - (4 + instruction.ex + instruction.mem);
}

export function layout(instructions, tick, variable = false) {
  const groups = new Map();
  const result = new Map();
  for (const instruction of instructions) {
    const slot = position(instruction, tick, variable);
    if (slot < -1 || slot > (variable ? 8 : 9)) continue;
    if (!groups.has(slot)) groups.set(slot, []);
    groups.get(slot).push(instruction);
  }
  for (const [slot, group] of groups) {
    group.sort((a, b) => a.number - b.number);
    group.forEach((instruction, rank) => result.set(instruction.number, {
      x: 40 + slot * 100, y: 94 + rank * 84,
      opacity: slot < 0 || slot > (variable ? 7 : 8) ? 0 : 1,
      conflict: slot === (variable ? 5 : 6) && group.length > 1
    }));
  }
  return result;
}
