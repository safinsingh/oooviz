import { randomFromSeed, latency, position, layout } from './simulation.js';

const variable = location.pathname.endsWith('/variable.html');
const scene = document.querySelector('.scene');
const stream = document.querySelector('#stream');
const speedInput = document.querySelector('#speed');
const seedInput = document.querySelector('#seed');
const pauseButton = document.querySelector('#pause');
const pagePicker = document.querySelector('#page');
scene.classList.toggle('variable', variable);
document.title = variable ? 'Variable EX / MEM pipeline' : 'In-order pipeline';
pagePicker.value = variable ? 'variable.html' : 'index.html';
seedInput.value = localStorage.getItem('pipeline-seed') ?? '152';
speedInput.value = localStorage.getItem('pipeline-speed') ?? '1';
let speed = Number(speedInput.value), paused = false, elapsed = 0;
let previousTime = performance.now(), random, nextNumber, scale = 1;
let lastTick = -1, dirty = true, from = new Map(), to = new Map();
const cycle = 850, hold = 380;
const instructions = new Map();
const nodes = new Map();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

['IF', 'ID', 'EX', 'MEM', 'WB'].forEach((name, index) => {
  const stage = document.createElement('div');
  stage.className = 'stage';
  stage.style.left = `${(233 + index * 100) / 952 * 100}%`;
  const label = document.createElement('span');
  label.className = 'stage-label';
  label.textContent = name;
  stage.append(label);
  document.querySelector('#stages').append(stage);
});

new ResizeObserver(([entry]) => { scale = entry.contentRect.width / 952; dirty = true; }).observe(scene);

function reset() {
  random = randomFromSeed(seedInput.value);
  nextNumber = 1;
  elapsed = 0;
  previousTime = performance.now();
  instructions.clear();
  nodes.clear();
  stream.replaceChildren();
  lastTick = -1;
  dirty = true;
}

function prepare(tick) {
  for (const [number, instruction] of instructions) {
    if (position(instruction, tick) > 9) {
      instructions.delete(number);
      nodes.get(number)?.remove();
      nodes.delete(number);
    }
  }
  while (nextNumber <= tick + 4) {
    const instruction = { number: nextNumber++, ...latency(random, variable) };
    instructions.set(instruction.number, instruction);
    const node = document.createElement('div');
    node.className = 'instruction';
    const number = document.createElement('span');
    number.textContent = instruction.number;
    if (String(instruction.number).length > 3) number.style.fontSize = `${3 / String(instruction.number).length}em`;
    node.append(number);
    if (instruction.ex > 1 || instruction.mem > 1) {
      const label = document.createElement('span');
      label.className = 'latency';
      label.textContent = instruction.ex > 1 ? `EX=${instruction.ex}` : `MEM=${instruction.mem}`;
      node.append(label);
    }
    stream.append(node);
    nodes.set(instruction.number, node);
  }
  from = layout(instructions.values(), tick);
  to = layout(instructions.values(), tick + 1);
  lastTick = tick;
  dirty = true;
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
    const start = a ?? b, end = b ?? a;
    const moving = start.x !== end.x || start.y !== end.y;
    const lift = moving && !reducedMotion.matches ? Math.sin(progress * Math.PI) * 14 : 0;
    const x = start.x + (end.x - start.x) * eased;
    const y = start.y + (end.y - start.y) * eased - lift;
    node.style.transform = `translate3d(${x * scale}px, ${y * scale}px, 0)`;
    node.style.opacity = String(start.opacity + (end.opacity - start.opacity) * eased);
    node.classList.toggle('conflict', progress > 0.5 ? end.conflict : start.conflict);
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
pauseButton.addEventListener('click', () => {
  paused = !paused;
  pauseButton.textContent = paused ? 'Resume' : 'Pause';
  pauseButton.setAttribute('aria-pressed', String(paused));
});
document.querySelector('#reset').addEventListener('click', reset);
function applySeed() {
  localStorage.setItem('pipeline-seed', seedInput.value);
  reset();
}
document.querySelector('#apply-seed').addEventListener('click', applySeed);
seedInput.addEventListener('keydown', event => { if (event.key === 'Enter') applySeed(); });
pagePicker.addEventListener('change', () => { location.href = pagePicker.value; });
document.addEventListener('visibilitychange', () => { previousTime = performance.now(); });
updateSpeed();
reset();
requestAnimationFrame(animate);
