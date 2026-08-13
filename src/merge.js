// ============================================================
// 咕嘟小厨 Merge — Three.js 合并料理放置游戏模板
// 玩法: 点击食材→放入棋盘→相同食材自动合并(2合1→4合1)→高阶食材
//       →厨房自动烹饪→顾客结算金币→升级5维度
// 测试接口: window.__game_state + ?test=1&speed=4 | 三端触控
// ============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BgmPlayer } from './bgm.js';

const params = new URLSearchParams(location.search);
const TEST = params.get('test') === '1';
const SPEED = TEST ? (parseFloat(params.get('speed')) || 4) : 1;

// ---- 食材链（合并升级）----
const INGREDIENTS = [
  { level: 1, name: '土豆',      price: 2,  value: 2,   model: 'potato' },
  { level: 2, name: '洋葱',      price: 5,  value: 5,   model: 'onion' },
  { level: 3, name: '蘑菇',      price: 12, value: 12,  model: 'mushroom' },
  { level: 4, name: '胡萝卜',    price: 28, value: 28,  model: 'carrot' },
  { level: 5, name: '牛肉',      price: 60, value: 60,  model: 'beef' },
  { level: 6, name: '黄金蔬菜',  price: 140, value: 140, model: 'golden' },
  { level: 7, name: '星耀食材',  price: 320, value: 320, model: 'star' },
  { level: 8, name: '传说盛宴',  price: 750, value: 750, model: 'feast' },
];

// 模型映射（food-kit）
const MODEL_FILES = {
  potato: 'apple.glb', onion: 'onion.glb', mushroom: 'mushroom.glb',
  carrot: 'carrot.glb', beef: 'tomato.glb', golden: 'cake.glb',
  star: 'mushroom-half.glb', feast: 'plate-rectangle.glb',
};

// 升级维度
const UPGRADES = [
  { key: 'kitchen', name: '厨房产能', desc: '烹饪更快', max: 8, costBase: 40, mult: 1.6 },
  { key: 'merge',   name: '合并效率', desc: '自动合并更快', max: 8, costBase: 60, mult: 1.7 },
  { key: 'customer', name: '顾客倍率', desc: '售价×', max: 8, costBase: 120, mult: 1.8 },
  { key: 'spawn',   name: '食材刷新', desc: '食材更多', max: 8, costBase: 80, mult: 1.7 },
  { key: 'offline', name: '离线收益', desc: '离线%', max: 8, costBase: 200, mult: 2.0 },
];

// 棋盘 5x4
const GRID_COLS = 5, GRID_ROWS = 4;
const CELL = 1.4;

export default function initMergeGame() {
  // ---- 渲染器 ----
  const canvas = document.querySelector('canvas') || document.createElement('canvas');
  document.body.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xa5d8f0);
  scene.fog = new THREE.Fog(0xa5d8f0, 25, 50);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 11, 12);
  camera.lookAt(0, 0, 0);

  const loader = new GLTFLoader();
  const models = {};
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  scene.add(new THREE.HemisphereLight(0xfff8ec, 0x9ccb7e, 1.2));
  const sun = new THREE.DirectionalLight(0xfff2d0, 1.5);
  sun.position.set(8, 14, 6);
  sun.castShadow = true;
  scene.add(sun);

  function loadModel(path) {
    return loader.loadAsync(path).then(g => {
      const m = g.scene;
      m.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      return m;
    }).catch(() => null);
  }
  async function ensure(name, path) {
    if (!(name in models)) models[name] = await loadModel(path);
    return models[name];
  }

  // ---- 游戏状态 ----
  const game = {
    money: 20, fame: 0, dishesServed: 0,
    lv: { kitchen: 1, merge: 1, customer: 1, spawn: 1, offline: 1 },
    board: [],          // { x, y, ing, mesh }
    pendingIngredients: [],  // 待放棋盘（左侧抽屉）
    kitchenQueue: [],   // 烹饪队列
    lastTime: 0, autoTimer: 0, spawnTimer: 0, mergeTimer: 0, clickables: [],
  };

  // ---- 测试接口 ----
  if (TEST) {
    window.__game_state = {
      get hp() { return game.money; },
      get score() { return game.fame; },
      get wave() { return 1 + Math.floor(game.dishesServed / 10); },
      get weapons() { return INGREDIENTS.slice(0, Math.max(1, game.dishesServed / 5 + 1)).map(i => i.name); },
      get enemies() { return game.board.length + game.pendingIngredients.length; },
      get screen() { return 'game'; },
    };
  }

  // ---- 场景 ----
  const floor = new THREE.Mesh(new THREE.BoxGeometry(9, 0.2, 7.5),
    new THREE.MeshStandardMaterial({ color: 0xd9b380, roughness: 0.9 }));
  floor.position.set(0, -0.1, 0); floor.receiveShadow = true;
  scene.add(floor);
  // 棋盘格
  const cellMat = new THREE.MeshStandardMaterial({ color: 0xf5e6c8 });
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const cell = new THREE.Mesh(new THREE.BoxGeometry(CELL - 0.15, 0.05, CELL - 0.15), cellMat);
      cell.position.set((c - (GRID_COLS - 1) / 2) * CELL, 0.06, (r - (GRID_ROWS - 1) / 2) * CELL);
      scene.add(cell);
    }
  }
  // 厨房（右侧）
  const stove = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.4, 1.8),
    new THREE.MeshStandardMaterial({ color: 0xe8794f }));
  stove.position.set(5.2, 0.2, -2);
  scene.add(stove);

  // ---- 交互 ----
  let touchStart = null;
  renderer.domElement.addEventListener('pointerdown', e => {
    touchStart = { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  renderer.domElement.addEventListener('pointerup', e => {
    if (touchStart && Date.now() - touchStart.t < 400) onPointer(e.clientX, e.clientY);
    touchStart = null;
  });

  function onPointer(x, y) {
    pointer.x = (x / renderer.domElement.clientWidth) * 2 - 1;
    pointer.y = -(y / renderer.domElement.clientHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    // 先点升级按钮
    const upHits = raycaster.intersectObjects(game.clickables, true);
    if (upHits.length) {
      const u = findBtn(upHits[0].object);
      if (u) { buyUpgrade(u); return; }
    }
    // 点棋盘上的食材
    const boardHits = raycaster.intersectObjects(game.board.map(b => b.mesh), true);
    if (boardHits.length) {
      const b = findBoard(boardHits[0].object);
      if (b) { sellIngredient(b); return; }
    }
    // 点待放食材（抽屉）
    const pendHits = raycaster.intersectObjects(game.pendingIngredients.map(p => p.mesh), true);
    if (pendHits.length) {
      const p = findPending(pendHits[0].object);
      if (p) { placeIngredient(p); return; }
    }
  }
  function findBtn(o) { let x = o; while (x) { if (x.userData.upgrade) return x.userData.upgrade; x = x.parent; } return null; }
  function findBoard(o) { let x = o; while (x) { if (x.userData.board) return x.userData.board; x = x.parent; } return null; }
  function findPending(o) { let x = o; while (x) { if (x.userData.pending) return x.userData.pending; x = x.parent; } return null; }

  // ---- 核心玩法 ----
  function spawnIngredient() {
    const lv = Math.min(1 + Math.floor(game.fame / 15), 4);
    const ing = INGREDIENTS[lv - 1];
    const m = placeModel(ing.model, -4.5, 0.6, 2.8, 0.8, Math.random() * 3);
    if (!m) return;
    m.userData.pending = true;
    game.pendingIngredients.push({ ing, mesh: m });
  }

  function placeIngredient(p) {
    // 找空格子
    const slot = findEmptySlot();
    if (!slot) { flash('棋盘满了！卖掉一些'); return; }
    const m = placeModel(p.ing.model, slot.x, 0.75, slot.z, 0.8, Math.random() * 3);
    if (!m) return;
    m.userData.board = { x: slot.c, y: slot.r, ing: p.ing, mesh: m };
    game.board.push(m.userData.board);
    scene.remove(p.mesh);
    game.pendingIngredients = game.pendingIngredients.filter(x => x !== p);
    checkMerge(slot.c, slot.r);
  }

  function findEmptySlot() {
    const occupied = new Set(game.board.map(b => b.x + ',' + b.y));
    for (let r = 0; r < GRID_ROWS; r++)
      for (let c = 0; c < GRID_COLS; c++)
        if (!occupied.has(c + ',' + r)) return { c, r, x: (c - (GRID_COLS - 1) / 2) * CELL, z: (r - (GRID_ROWS - 1) / 2) * CELL };
    return null;
  }

  function checkMerge(c, r) {
    // 找相邻同等级食材（上下左右）
    const here = game.board.find(b => b.x === c && b.y === r);
    if (!here || here.ing.level >= INGREDIENTS.length) return;
    const neighbors = [
      game.board.find(b => b.x === c - 1 && b.y === r),
      game.board.find(b => b.x === c + 1 && b.y === r),
      game.board.find(b => b.x === c && b.y === r - 1),
      game.board.find(b => b.x === c && b.y === r + 1),
    ].filter(b => b && b.ing.level === here.ing.level);
    if (neighbors.length >= 1 && (game.lv.merge >= 3 || neighbors.length >= 1)) {
      // 合并：吃掉一个邻居，自己升级
      const victim = neighbors[0];
      const next = INGREDIENTS[here.ing.level];  // 下一级
      scene.remove(victim.mesh);
      game.board = game.board.filter(b => b !== victim);
      here.ing = next;
      const nm = placeModel(next.model, here.mesh.position.x, 0.75, here.mesh.position.z, 0.9, Math.random() * 3);
      if (nm) {
        nm.userData.board = here;
        scene.remove(here.mesh);
        here.mesh = nm;
      }
      flash(`合并！${next.name}`);
      sfx(880, 0.15, 'triangle');
      // 触发后续合并
      setTimeout(() => checkMerge(c, r), 300 / SPEED);
    }
  }

  function sellIngredient(b) {
    const mult = 1 + (game.lv.customer - 1) * 0.25;
    const gold = Math.floor(b.ing.value * mult);
    game.money += gold;
    game.fame += 1;
    game.dishesServed += 1;
    scoreFloat(b.mesh.position.x, 2, `+${gold}`);
    scene.remove(b.mesh);
    game.board = game.board.filter(x => x !== b);
    // 入厨房队列（自动烹饪动画简化）
    game.kitchenQueue.push(b.ing.name);
    sfx(660, 0.12, 'sine');
  }

  // ---- 升级 ----
  function upgradeCost(key) {
    const def = UPGRADES.find(u => u.key === key);
    return Math.floor(def.costBase * Math.pow(def.mult, (game.lv[key] || 1) - 1));
  }
  function buyUpgrade(u) {
    const lv = game.lv[u.key] || 1;
    if (lv >= u.max) { flash(`${u.name}已满级`); return; }
    const cost = upgradeCost(u.key);
    if (game.money < cost) { flash('金币不足！'); sfx(200, 0.15); return; }
    game.money -= cost;
    game.lv[u.key] = lv + 1;
    sfx(1000, 0.2, 'triangle');
    flash(`${u.name}升级！${u.desc}`);
    buildButtons();
  }

  // ---- 3D 助手 ----
  function placeModel(name, x, y, z, scale, rotY) {
    const file = MODEL_FILES[name] || name;
    const tpl = models[file];
    if (!tpl) return null;
    const m = tpl.clone();
    m.position.set(x, y, z);
    m.scale.setScalar(scale);
    m.rotation.y = rotY;
    m.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
    scene.add(m);
    return m;
  }
  function makeTextBtn(label, color) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 56;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.font = 'bold 22px Arial'; ctx.textAlign = 'center';
    ctx.fillText(label, 128, 34);
    const tex = new THREE.CanvasTexture(c);
    return new THREE.Mesh(new THREE.PlaneGeometry(2, 0.45),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }));
  }
  function buildButtons() {
    game.clickables.forEach(x => scene.remove(x));
    game.clickables = [];
    const labels = [
      { key: 'kitchen', label: `厨房💰${upgradeCost('kitchen')}`, x: 5.5, z: 2.6 },
      { key: 'merge', label: `合并💰${upgradeCost('merge')}`, x: 6.8, z: 2.6 },
      { key: 'customer', label: `顾客💰${upgradeCost('customer')}`, x: 5.5, z: 3.6 },
      { key: 'spawn', label: `刷新💰${upgradeCost('spawn')}`, x: 6.8, z: 3.6 },
      { key: 'offline', label: `离线💰${upgradeCost('offline')}`, x: 6.15, z: 4.5 },
    ];
    for (const u of labels) {
      const g = new THREE.Group();
      const bg = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.5, 0.3),
        new THREE.MeshStandardMaterial({ color: 0xe8794f }));
      const t = makeTextBtn(u.label);
      t.position.z = 0.2;
      g.add(bg); g.add(t);
      g.position.set(u.x, 0.9, u.z);
      g.userData.upgrade = u.key;
      game.clickables.push(g);
      scene.add(g);
    }
  }

  // ---- UI 助手 ----
  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;top:10px;left:10px;font:bold 15px Arial;color:#5a4a3a;background:#fff8ec;padding:8px 12px;border-radius:10px;z-index:99';
  document.body.appendChild(hud);
  function updateHUD() {
    hud.innerHTML = `💰 ${game.money} &nbsp;⭐ ${game.fame} &nbsp;🍽 ${game.dishesServed}<br>厨房${game.lv.kitchen} · 合并${game.lv.merge} · 顾客${game.lv.customer} · 刷新${game.lv.spawn} · 离线${game.lv.offline}`;
  }
  function flash(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;top:15%;left:50%;transform:translateX(-50%);font:bold 20px Arial;color:#e8794f;background:#fff8ec;padding:6px 14px;border-radius:10px;z-index:99;transition:opacity .8s;pointer-events:none';
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 800); }, 1300 / SPEED);
  }
  function scoreFloat(x, y, s) {
    const el = document.createElement('div');
    el.textContent = s;
    el.style.cssText = `position:fixed;left:${((x + 4.5) / 9) * 100}%;top:${50 - y * 5}%;font:bold 16px Arial;color:#e8794f;z-index:99;transition:all .7s;pointer-events:none`;
    document.body.appendChild(el);
    setTimeout(() => { el.style.transform = 'translateY(-25px)'; el.style.opacity = '0'; setTimeout(() => el.remove(), 800); }, 100);
  }
  let bgm;
  function sfx(freq, dur, type) {
    try {
      if (!bgm) return;
      const o = bgm.ctx.createOscillator(), g = bgm.ctx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0.1, bgm.ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, bgm.ctx.currentTime + dur);
      o.connect(g).connect(bgm.ctx.destination);
      o.start(); o.stop(bgm.ctx.currentTime + dur);
    } catch (e) {}
  }
  renderer.domElement.addEventListener('pointerdown', () => {
    if (!bgm) { bgm = new BgmPlayer(); bgm.ensure(); bgm.play(); }
  });

  // ---- 主循环 ----
  function animate(time) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, (time - game.lastTime) / 1000) * SPEED;
    game.lastTime = time;
    // 食材生成
    game.spawnTimer += dt;
    const spawnInt = (3.5 - game.lv.spawn * 0.3) * 1000 / SPEED / 1000;
    if (game.spawnTimer > spawnInt && game.pendingIngredients.length < 8 && game.pendingIngredients.length < 6) {
      game.spawnTimer = 0;
      spawnIngredient();
    }
    // 自动合并（merge 等级加速）
    game.mergeTimer += dt;
    if (game.mergeTimer > (4 - game.lv.merge * 0.3) && game.lv.merge >= 2) {
      game.mergeTimer = 0;
      const candidates = game.board.filter(b => b.ing.level < INGREDIENTS.length);
      if (candidates.length > 1) checkMerge(candidates[0].x, candidates[0].y);
    }
    // 自动经营（放置：每 15s 自动收益）
    game.autoTimer += dt;
    if (game.autoTimer > 15000 / SPEED) {
      game.autoTimer = 0;
      const auto = Math.floor(game.fame * 1.5 + (game.lv.offline - 1) * 8);
      game.money += auto;
      scoreFloat(0, 2.2, `离线经营 +${auto}`);
    }
    updateHUD();
    renderer.render(scene, camera);
  }

  // ---- 启动 ----
  async function start() {
    const base = (import.meta.env && import.meta.env.BASE_URL) || './';
    const A = `${base}assets/3d/`;
    const used = new Set(Object.values(MODEL_FILES));
    for (const f of used) await ensure(f, `${A}food/${f}`);
    buildButtons();
    // 初始食材
    for (let i = 0; i < 8; i++) spawnIngredient();
    flash('点击食材放到棋盘，相同食材自动合并！');
    if (TEST) {
      // 测试模式自动玩
      setInterval(() => {
        const p = game.pendingIngredients[0];
        if (p) placeIngredient(p);
        else if (game.board.length) sellIngredient(game.board[0]);
      }, 2000 / SPEED);
    }
    requestAnimationFrame(animate);
  }
  start();

  function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', onResize);
  onResize();
}
