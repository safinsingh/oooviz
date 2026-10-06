import { randomFromSeed, latency, position, layout } from './simulation.js?v=hazard-pairs-20261006';
import { BypassPipeline } from './bypass.js?v=hazard-pairs-20261006';
import { HazardPipeline } from './hazards.js?v=hazard-pairs-20261006';
import { InstructionTable, registerBadge } from './instruction-table.js?v=hazard-pairs-20261006';

const bypass = location.pathname.endsWith('/out-of-order.html');
const exaggerated = bypass || location.pathname.endsWith('/long-latency.html');
const hazards = exaggerated || location.pathname.endsWith('/stalls.html');
const variable = hazards || location.pathname.endsWith('/variable.html');
const scene = document.querySelector('.scene');
const stream = document.querySelector('#stream');
const speedInput = document.querySelector('#speed');
const seedInput = document.querySelector('#seed');
const pauseButton = document.querySelector('#pause');
const designWidth = variable ? 852 : 952;
scene.classList.toggle('variable', variable);
scene.classList.toggle('bypass', bypass);
document.title = bypass ? 'Out-of-order issue' : exaggerated ? 'Long write latencies' : hazards ? 'Pipeline hazard stalls' : variable ? 'Variable EX pipeline' : 'In-order pipeline';
document.querySelector(`.page-picker a[href="${bypass ? 'out-of-order.html' : exaggerated ? 'long-latency.html' : hazards ? 'stalls.html' : variable ? 'variable.html' : 'index.html'}"]`).setAttribute('aria-current', 'page');
if (variable) scene.setAttribute('aria-label', 'Numbered instructions advance through IF, ID, a shared EX backend, and WB.');
seedInput.value = localStorage.getItem('pipeline-seed') ?? '152';
speedInput.value = localStorage.getItem('pipeline-speed') ?? '1';
let speed = Number(speedInput.value), paused = false, elapsed = 0;
let previousTime = performance.now(), random, nextNumber, scale = 1;
let lastTick = -1, dirty = true, from = new Map(), to = new Map();
let hazardModel, hazardCurrent, retired = 0;
let activeSeed, hazardFrames = [];
let instructionTable;
const retiredNumbers = new Set();
const cycle = 850, hold = 380;
const instructions = new Map();
const nodes = new Map();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

(variable ? ['IF', 'ID', 'EX', 'WB'] : ['IF', 'ID', 'EX', 'MEM', 'WB']).forEach((name, index) => {
  const stage = document.createElement('div');
  stage.className = 'stage';
  stage.style.left = `${(233 + index * 100) / designWidth * 100}%`;
  const label = document.createElement('span');
  label.className = 'stage-label';
  label.textContent = name;
  if (variable && name === 'EX') {
    const backend = document.createElement('span');
    backend.className = 'backend-label';
    backend.textContent = '(Backend)';
    label.append(backend);
  }
  stage.append(label);
  document.querySelector('#stages').append(stage);
});

new ResizeObserver(([entry]) => { scale = entry.contentRect.width / designWidth; dirty = true; }).observe(scene);

function reset() {
  activeSeed = seedInput.value;
  random = randomFromSeed(activeSeed);
  nextNumber = 1;
  elapsed = 0;
  previousTime = performance.now();
  instructions.clear();
  nodes.clear();
  stream.replaceChildren();
  retired = 0;
  retiredNumbers.clear();
  hazardModel = bypass ? new BypassPipeline(activeSeed) : hazards ? new HazardPipeline(activeSeed, exaggerated) : null;
  hazardFrames = hazards ? [hazardModel.snapshot()] : [];
  hazardCurrent = null;
  instructionTable = variable ? new InstructionTable(activeSeed, hazards, exaggerated, variable, bypass) : null;
  lastTick = -1;
  dirty = true;
}

function addNode(instruction) {
  if (nodes.has(instruction.number)) return;
  const node = document.createElement('div');
  node.className = 'instruction';
  node.dataset.number = instruction.number;
  const number = document.createElement('span');
  number.textContent = instruction.number;
  if (String(instruction.number).length > 3) number.style.fontSize = `${3 / String(instruction.number).length}em`;
  node.append(number);
  if (variable && !(exaggerated && instruction.src !== null)) {
    const label = document.createElement('span');
    label.className = 'latency';
    label.textContent = `EX=${instruction.ex}`;
    node.append(label);
  }
  if (hazards) {
    const destination = document.createElement('span');
    destination.className = 'destination';
    destination.append(document.createTextNode(instruction.src !== null ? 'R ' : 'W '),
      registerBadge(instruction.src !== null ? instruction.src : instruction.dest));
    node.append(destination);
  }
  stream.append(node);
  nodes.set(instruction.number, node);
}

function updatePool(frame) {
  const rows = document.querySelector('#pool-rows');
  rows.replaceChildren();
  const queue = frame.instructions.filter(i => i.slot === 3).sort((a, b) => a.number - b.number);
  for (const instruction of queue) {
    const row = document.createElement('li');
    row.dataset.number = instruction.number;
    row.classList.toggle('pool-red', frame.red.includes(instruction.number));
    row.classList.toggle('pool-yellow', frame.yellow.includes(instruction.number));
    row.textContent = instruction.number;
    rows.append(row);
  }
  if (!queue.length) {
    const empty = document.createElement('li');
    empty.className = 'pool-empty';
    empty.textContent = 'Empty';
    rows.append(empty);
  }
}

function fitStageOutlines(current, next) {
  const stages = document.querySelectorAll('.stage');
  stages.forEach((stage, index) => {
    const slot = index + 2;
    const count = Math.max(1,
      current.filter(i => i.slot === slot).length,
      next.filter(i => i.slot === slot).length);
    stage.style.height = `${(86 + (count - 1) * 84) / designWidth * 100}cqw`;
  });
}

function prepare(tick) {
  if (hazards) {
    while (hazardFrames.length <= tick + 1) {
      hazardModel.step();
      hazardFrames.push(hazardModel.snapshot());
    }
    hazardCurrent = hazardFrames[tick];
    const next = hazardFrames[tick + 1];
    from = hazardCurrent.positions;
    to = next.positions;
    if (variable) {
      const bottom = Math.max(550, ...[...from.values(), ...to.values()]
        .filter(p => p.opacity > 0).map(p => p.y + 96));
      scene.style.setProperty('--scene-height', String(bottom));
    }
    const visible = new Set([...from.keys(), ...to.keys()]);
    for (const [number, node] of nodes) {
      if (!visible.has(number)) { node.remove(); nodes.delete(number); }
    }
    [...hazardCurrent.instructions, ...next.instructions].forEach(addNode);
    fitStageOutlines(hazardCurrent.instructions, next.instructions);
    if (bypass) updatePool(hazardCurrent);
    retired = hazardCurrent.retired;
    document.querySelector('#stall-status').textContent = hazardCurrent.status;
    instructionTable.update(hazardCurrent.instructions.find(i => i.slot === 3)?.number ?? null,
      hazardCurrent.red, hazardCurrent.yellow, number => hazardCurrent.completed.has(number), number => {
        const issued = hazardModel.issuedAt.get(number);
        return issued !== undefined && issued <= tick ? issued : null;
      }, number => {
        const finished = hazardModel.completedAt.get(number);
        return finished !== undefined && finished <= tick ? finished : null;
      });
    for (const instruction of hazardCurrent.instructions) {
      const node = nodes.get(instruction.number);
      if (node) node.title = instruction.slot === 4
        ? `Total EX latency: ${instruction.ex}. Remaining: ${instruction.remaining} cycles.`
        : `Total EX latency: ${instruction.ex} cycles.`;
    }
    lastTick = tick;
    dirty = true;
    updateCounters(tick);
    return;
  }
  for (const [number, instruction] of instructions) {
    if (position(instruction, tick, variable) > (variable ? 5 : 6) && !retiredNumbers.has(number)) {
      retiredNumbers.add(number);
      retired++;
    }
    if (position(instruction, tick, variable) > (variable ? 8 : 9)) {
      instructions.delete(number);
      retiredNumbers.delete(number);
      nodes.get(number)?.remove();
      nodes.delete(number);
    }
  }
  while (nextNumber <= tick + 4) {
    const instruction = { number: nextNumber++, ...latency(random, variable) };
    instructions.set(instruction.number, instruction);
    addNode(instruction);
  }
  from = layout(instructions.values(), tick, variable);
  to = layout(instructions.values(), tick + 1, variable);
  fitStageOutlines(
    [...instructions.values()].map(i => ({ slot: position(i, tick, variable) })),
    [...instructions.values()].map(i => ({ slot: position(i, tick + 1, variable) })));
  if (variable) {
    const bottom = Math.max(550, ...[...from.values(), ...to.values()]
      .filter(p => p.opacity > 0).map(p => p.y + 96));
    scene.style.setProperty('--scene-height', String(bottom));
  }
  lastTick = tick;
  dirty = true;
  if (variable) instructionTable.update([...instructions.values()].find(i => position(i, tick, variable) === 3)?.number ?? null,
    [], [], number => {
      const instruction = instructionTable.catalog.get(number);
      return position(instruction, tick, variable) > (variable ? 5 : 6);
    }, number => tick >= number + 2 ? number + 2 : null, number => {
      const finished = number + 2 + instructionTable.catalog.get(number).ex;
      return tick >= finished ? finished : null;
    });
  updateCounters(tick);
}

function updateCounters(tick) {
  document.querySelector('#cycle-count').textContent = tick;
  document.querySelector('#cpi-count').textContent = retired ? (tick / retired).toFixed(2) : '—';
  document.querySelector('#previous').disabled = tick === 0;
}

function snapCycle(direction) {
  const target = Math.max(0, Math.floor(elapsed / cycle) + direction);
  setPaused(true);
  elapsed = target * cycle;
  previousTime = performance.now();
  if (!hazards) {
    // Replay the seed to reconstruct both positions and committed count.
    random = randomFromSeed(activeSeed);
    instructions.clear();
    retiredNumbers.clear();
    retired = 0;
    nodes.clear();
    stream.replaceChildren();
    nextNumber = 1;
    while (nextNumber <= target + 4) {
      const instruction = { number: nextNumber++, ...latency(random, variable) };
      const slot = position(instruction, target, variable);
      if (slot > (variable ? 5 : 6)) {
        retired++;
        retiredNumbers.add(instruction.number);
      }
      if (slot >= -1 && slot <= (variable ? 8 : 9)) {
        instructions.set(instruction.number, instruction);
        addNode(instruction);
      } else retiredNumbers.delete(instruction.number);
    }
  }
  lastTick = -1;
  dirty = true;
  render();
}

function render() {
  const tick = Math.floor(elapsed / cycle);
  if (tick !== lastTick) prepare(tick);
  const progress = Math.max(0, (elapsed % cycle - hold) / (cycle - hold));
  if (!dirty && (paused || progress === 0)) return;
  const eased = reducedMotion.matches ? Math.round(progress) : progress ** 3 * (progress * (progress * 6 - 15) + 10);
  for (const [number, node] of nodes) {
    const a = from.get(number), b = to.get(number);
    if (!a && !b) { node.style.opacity = '0'; continue; }
    const start = a ?? { ...b, x: b.x - 100, opacity: 0 };
    const end = b ?? { ...a, x: a.x + 100, opacity: 0 };
    const moving = start.x !== end.x || start.y !== end.y;
    const lift = moving && !reducedMotion.matches ? Math.sin(progress * Math.PI) * 14 : 0;
    const x = start.x + (end.x - start.x) * eased;
    const y = start.y + (end.y - start.y) * eased - lift;
    node.style.transform = `translate3d(${x * scale}px, ${y * scale}px, 0)`;
    node.style.opacity = String(start.opacity + (end.opacity - start.opacity) * eased);
    node.classList.toggle('conflict', progress > 0.5 ? end.conflict : start.conflict);
    node.classList.toggle('hazard-blocked', Boolean(hazards && hazardCurrent.red.includes(number)));
    node.classList.toggle('hazard-producer', Boolean(hazards && hazardCurrent.yellow.includes(number)));
  }
  dirty = false;
}

function animate(now) {
  const delta = now - previousTime;
  previousTime = now;
  if (!paused && !document.hidden) elapsed += Math.min(delta, 100) * speed;
  render();
  requestAnimationFrame(animate);
}

function updateSpeed() {
  speed = Number(speedInput.value);
  document.querySelector('#speed-value').textContent = `${Number(speed.toFixed(2))}×`;
  localStorage.setItem('pipeline-speed', String(speed));
}
speedInput.addEventListener('input', updateSpeed);
function setPaused(value) {
  paused = value;
  pauseButton.textContent = paused ? 'Resume' : 'Pause';
  pauseButton.setAttribute('aria-pressed', String(paused));
}
pauseButton.addEventListener('click', () => setPaused(!paused));
document.querySelector('#previous').addEventListener('click', () => snapCycle(-1));
document.querySelector('#next').addEventListener('click', () => snapCycle(1));
document.querySelector('#reset').addEventListener('click', reset);
function applySeed() {
  localStorage.setItem('pipeline-seed', seedInput.value);
  reset();
}
document.querySelector('#apply-seed').addEventListener('click', applySeed);
seedInput.addEventListener('keydown', event => { if (event.key === 'Enter') applySeed(); });
document.addEventListener('visibilitychange', () => { previousTime = performance.now(); });
updateSpeed();
reset();
requestAnimationFrame(animate);
