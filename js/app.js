// === SwimGrowth App ===

// --- DB Setup ---
const db = new Dexie('SwimGrowthDB');
db.version(1).stores({
  swimmers: '++id, name',
  records: '++id, swimmerId, date, type, stroke, distance, time, createdAt',
  achievements: '++id, swimmerId, badgeId, date'
});

// --- Global State ---
let currentSwimmer = null;
let chartInstance = null;
let recordFilter = 'all';
let editingRecordId = null;
let deferredPrompt = null;

// --- Constants ---
const STROKES = ['自由泳','蛙泳','仰泳','蝶泳','混合泳'];
const DISTANCES = [50,100,200,400,800,1500];
const BADGES = [
  { id:'first_record', emoji:'🏊', name:'初出茅庐', desc:'添加第一条记录' },
  { id:'first_comp', emoji:'🏆', name:'初试锋芒', desc:'添加第一条比赛记录' },
  { id:'first_pb', emoji:'⚡', name:'突破自我', desc:'打破个人最佳成绩' },
  { id:'streak_7', emoji:'🔥', name:'一周坚持', desc:'连续7天有训练记录' },
  { id:'records_50', emoji:'📊', name:'半百记录', desc:'累计添加50条记录' },
  { id:'records_100', emoji:'💯', name:'百次突破', desc:'累计添加100条记录' },
  { id:'multi_stroke', emoji:'🌊', name:'全能选手', desc:'记录过3种以上泳姿' },
  { id:'multi_dist', emoji:'🏁', name:'长短皆宜', desc:'记录过3种以上距离' }
];

// --- Utils ---
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function formatDate(d) {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit' });
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(2).padStart(5, '0');
  return m + ':' + s;
}

function parseTime(str) {
  if (!str) return 0;
  const parts = str.split(':');
  if (parts.length !== 2) return 0;
  const m = parseInt(parts[0], 10) || 0;
  const s = parseFloat(parts[1]) || 0;
  return m * 60 + s;
}

function typeLabel(t) {
  return { competition: '比赛', training: '训练', test: '测试' }[t] || t;
}
function typeIcon(t) {
  return { competition: '🏆', training: '🏊', test: '📋' }[t] || '📝';
}
function typeClass(t) {
  return { competition: 'comp', training: 'train', test: 'test' }[t] || '';
}
function typeBadgeClass(t) {
  return { competition: 'badge-comp', training: 'badge-train', test: 'badge-test' }[t] || '';
}

function todayStr() {
  return new Date().toISOString().slice(0,10);
}

// --- Init ---
async function init() {
  // Register SW
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // PWA install prompt
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    $('#installBanner').classList.add('show');
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      $('#installBanner').classList.remove('show');
      deferredPrompt = null;
    }
  });

  // Load or create swimmer
  const swimmers = await db.swimmers.toArray();
  if (swimmers.length === 0) {
    const id = await db.swimmers.add({ name: '小泳者', birthDate: '', gender: '', club: '' });
    currentSwimmer = { id, name: '小泳者' };
  } else {
    currentSwimmer = swimmers[0];
  }

  // Tab switching
  $$('.tab-item').forEach(tab => {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  });

  // Modal close
  $('#modalClose').addEventListener('click', closeRecordModal);
  $('#swimmerModalClose').addEventListener('click', closeSwimmerModal);
  $('#recordModal').addEventListener('click', e => { if (e.target === $('#recordModal')) closeRecordModal(); });
  $('#swimmerModal').addEventListener('click', e => { if (e.target === $('#swimmerModal')) closeSwimmerModal(); });

  // Forms
  $('#recordForm').addEventListener('submit', saveRecord);
  $('#swimmerForm').addEventListener('submit', saveSwimmer);

  // Initial render
  showTab('home');
}

// --- Tabs ---
function showTab(tab) {
  $$('.page').forEach(p => p.classList.remove('active'));
  $$('.tab-item').forEach(t => t.classList.remove('active'));
  $(`#page-${tab}`).classList.add('active');
  $(`.tab-item[data-tab="${tab}"]`).classList.add('active');

  const titles = { home: ['SwimGrowth','记录每一次进步'], records: ['记录','比赛、训练与测试'], charts: ['成长曲线','可视化你的进步'], settings: ['设置','运动员信息与数据管理'] };
  $('#pageTitle').textContent = titles[tab][0];
  $('#pageSubtitle').textContent = titles[tab][1];

  if (tab === 'home') renderHome();
  if (tab === 'records') renderRecords();
  if (tab === 'charts') renderCharts();
  if (tab === 'settings') renderSettings();
}

// --- Home ---
async function renderHome() {
  const container = $('#homeContent');
  const records = await db.records.where('swimmerId').equals(currentSwimmer.id).sortBy('date');
  const total = records.length;
  const pbCount = countPBs(records);
  const trainDays = new Set(records.filter(r => r.type === 'training').map(r => r.date)).size;

  // Recent records (last 5)
  const recent = records.slice(-5).reverse();

  // Achievements
  const unlocked = await db.achievements.where('swimmerId').equals(currentSwimmer.id).toArray();
  const unlockedIds = new Set(unlocked.map(a => a.badgeId));

  let html = '';

  // Welcome card
  html += `<div class="card">
    <h3>👋 你好，${currentSwimmer.name}</h3>
    <p style="font-size:0.85rem;color:var(--text-secondary);">今天也要加油游泳哦！</p>
  </div>`;

  // Stats
  html += `<div class="stats-grid">
    <div class="stat-card"><div class="value">${total}</div><div class="label">总记录</div></div>
    <div class="stat-card"><div class="value">${pbCount}</div><div class="label">PB 次数</div></div>
    <div class="stat-card"><div class="value">${trainDays}</div><div class="label">训练天数</div></div>
  </div>`;

  // Recent records
  html += `<div class="card">
    <h3><span class="icon">🕐</span>最近记录</h3>`;
  if (recent.length === 0) {
    html += `<div class="empty-state" style="padding:1.5rem 0;"><span class="emoji">📝</span><p>还没有记录，点击右下角添加第一条吧！</p></div>`;
  } else {
    html += recent.map(r => renderRecordItem(r)).join('');
  }
  html += `</div>`;

  // Achievements
  html += `<div class="card">
    <h3><span class="icon">🏅</span>成就</h3>
    <div class="achieve-grid">`;
  BADGES.forEach(b => {
    const isUnlocked = unlockedIds.has(b.id);
    html += `<div class="achieve-item ${isUnlocked ? 'unlocked' : ''}" title="${b.desc}">
      <span class="emoji">${isUnlocked ? b.emoji : '🔒'}</span>
      <span class="name">${b.name}</span>
    </div>`;
  });
  html += `</div></div>`;

  // Quick add
  html += `<button class="btn btn-primary btn-block" onclick="openRecordModal()" style="margin-top:0.5rem;">+ 添加新记录</button>`;

  container.innerHTML = html;
}

function countPBs(records) {
  let count = 0;
  const groups = {};
  records.forEach(r => {
    const key = `${r.stroke}-${r.distance}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });
  Object.values(groups).forEach(list => {
    list.sort((a,b) => new Date(a.date) - new Date(b.date));
    let best = Infinity;
    list.forEach(r => {
      if (r.time < best) { best = r.time; count++; }
    });
  });
  return count;
}

// --- Records ---
async function renderRecords() {
  const container = $('#recordsContent');
  let records = await db.records.where('swimmerId').equals(currentSwimmer.id).sortBy('date');
  records = records.reverse();
  if (recordFilter !== 'all') records = records.filter(r => r.type === recordFilter);

  let html = '';
  html += `<div style="display:flex;gap:0.4rem;margin-bottom:0.8rem;flex-wrap:wrap;">
    <button class="btn btn-sm ${recordFilter==='all'?'btn-primary':'btn-secondary'}" onclick="setFilter('all')">全部</button>
    <button class="btn btn-sm ${recordFilter==='competition'?'btn-primary':'btn-secondary'}" onclick="setFilter('competition')">比赛</button>
    <button class="btn btn-sm ${recordFilter==='training'?'btn-primary':'btn-secondary'}" onclick="setFilter('training')">训练</button>
    <button class="btn btn-sm ${recordFilter==='test'?'btn-primary':'btn-secondary'}" onclick="setFilter('test')">测试</button>
  </div>`;

  if (records.length === 0) {
    html += `<div class="empty-state"><span class="emoji">🏊</span><p>暂无${recordFilter==='all'?'':typeLabel(recordFilter)}记录</p></div>`;
  } else {
    html += `<div class="card" style="padding:0 1.1rem;">`;
    html += records.map(r => renderRecordItem(r, true)).join('');
    html += `</div>`;
  }

  html += `<button class="btn btn-primary btn-block" onclick="openRecordModal()" style="margin-top:1rem;">+ 添加新记录</button>`;
  container.innerHTML = html;
}

function setFilter(f) { recordFilter = f; renderRecords(); }

function renderRecordItem(r, showActions) {
  const meta = [];
  if (r.eventName) meta.push(r.eventName);
  meta.push(formatDate(r.date));
  if (r.rank) meta.push(`第 ${r.rank} 名`);
  if (r.group) meta.push(r.group);

  let actions = '';
  if (showActions) {
    actions = `<div style="display:flex;gap:4px;flex-shrink:0;">
      <button class="btn btn-sm btn-secondary" onclick="editRecord(${r.id})" style="padding:0.3rem 0.5rem;font-size:0.7rem;">编辑</button>
      <button class="btn btn-sm btn-danger" onclick="deleteRecord(${r.id})" style="padding:0.3rem 0.5rem;font-size:0.7rem;">删除</button>
    </div>`;
  }

  return `<div class="record-item">
    <div class="record-icon ${typeClass(r.type)}">${typeIcon(r.type)}</div>
    <div class="record-main">
      <div class="record-title">${r.stroke} ${r.distance}m ${typeLabel(r.type)}</div>
      <div class="record-meta">${meta.join(' · ')} ${r.venue ? '· ' + r.venue : ''}</div>
    </div>
    <div style="text-align:right;flex-shrink:0;">
      <div class="record-time">${formatTime(r.time)}</div>
      <span class="record-badge ${typeBadgeClass(r.type)}">${typeLabel(r.type)}</span>
    </div>
    ${actions}
  </div>`;
}

// --- Charts ---
async function renderCharts() {
  const container = $('#chartsContent');
  const records = await db.records.where('swimmerId').equals(currentSwimmer.id).sortBy('date');

  // Get unique stroke-distance combos
  const combos = [...new Set(records.map(r => `${r.stroke}-${r.distance}`))];
  const comboOptions = combos.map(c => {
    const [s,d] = c.split('-');
    return `<option value="${c}">${s} ${d}m</option>`;
  }).join('');

  let html = '';
  html += `<div class="card">
    <div class="chart-filters">
      <select id="chartCombo" onchange="renderChart()">${comboOptions || '<option>暂无数据</option>'}</select>
      <select id="chartType" onchange="renderChart()">
        <option value="trend">成绩趋势</option>
        <option value="dist">距离分布</option>
      </select>
    </div>
    <div class="chart-container" id="mainChart"></div>
  </div>`;

  // PB milestones
  html += `<div class="card">
    <h3><span class="icon">🎯</span>个人最佳 (PB)</h3>`;
  if (records.length === 0) {
    html += `<div class="empty-state" style="padding:1rem 0;"><p>添加记录后将显示 PB 里程碑</p></div>`;
  } else {
    const pbs = calcPBs(records);
    html += pbs.map(pb => `<div class="record-item" style="padding:0.6rem 0.2rem;">
      <div class="record-main"><div class="record-title">${pb.key}</div></div>
      <div class="record-time">${formatTime(pb.time)}</div>
      <span class="record-badge badge-comp">PB</span>
    </div>`).join('');
  }
  html += `</div>`;

  container.innerHTML = html;
  if (combos.length > 0) renderChart();
}

function calcPBs(records) {
  const groups = {};
  records.forEach(r => {
    const key = `${r.stroke} ${r.distance}m`;
    if (!groups[key] || r.time < groups[key].time) groups[key] = r;
  });
  return Object.entries(groups).map(([key, r]) => ({ key, time: r.time, date: r.date })).sort((a,b) => a.time - b.time);
}

function renderChart() {
  const combo = $('#chartCombo')?.value;
  const type = $('#chartType')?.value;
  if (!combo || combo === '暂无数据') return;

  const [stroke, distance] = combo.split('-');
  db.records.where('swimmerId').equals(currentSwimmer.id).toArray().then(all => {
    const data = all.filter(r => r.stroke === stroke && r.distance === parseInt(distance,10))
      .sort((a,b) => new Date(a.date) - new Date(b.date));
    if (!data.length) return;

    const dom = $('#mainChart');
    if (chartInstance) chartInstance.dispose();
    chartInstance = echarts.init(dom, null, { renderer: 'svg' });

    if (type === 'dist') {
      const distData = {};
      data.forEach(r => { distData[r.type] = (distData[r.type]||0) + 1; });
      chartInstance.setOption({
        animation: false,
        tooltip: { trigger: 'item', appendToBody: true },
        color: ['#0d9488','#06b6d4','#f59e0b'],
        series: [{
          type: 'pie', radius: ['40%','70%'],
          data: Object.entries(distData).map(([k,v]) => ({ name:typeLabel(k), value:v })),
          label: { color: '#1a2e35' }
        }]
      });
    } else {
      const dates = data.map(r => formatDate(r.date));
      const times = data.map(r => r.time);
      const minTime = Math.min(...times);

      chartInstance.setOption({
        animation: false,
        tooltip: {
          trigger: 'axis', appendToBody: true,
          formatter: function(p) {
            return p[0].axisValue + '<br/>成绩: <strong>' + formatTime(p[0].value) + '</strong>';
          }
        },
        grid: { left: 60, right: 20, top: 30, bottom: 40 },
        xAxis: {
          type: 'category', data: dates,
          axisLabel: { color: '#5e8490', fontSize: 10, rotate: 30 },
          axisLine: { lineStyle: { color: '#c8e0dc' } },
          axisTick: { show: false }
        },
        yAxis: {
          type: 'value', name: '成绩(秒)',
          nameTextStyle: { color: '#5e8490', fontSize: 10 },
          axisLabel: { color: '#5e8490', fontSize: 10, formatter: v => formatTime(v) },
          axisLine: { show: false },
          splitLine: { lineStyle: { color: '#c8e0dc', type: 'dashed' } }
        },
        series: [{
          type: 'line', data: times, smooth: true,
          symbol: 'circle', symbolSize: 8,
          lineStyle: { color: '#0d9488', width: 3 },
          itemStyle: { color: '#0d9488', borderColor: '#fff', borderWidth: 2 },
          areaStyle: {
            color: { type: 'linear', x:0, y:0, x2:0, y2:1,
              colorStops: [{ offset:0, color:'#0d948840' }, { offset:1, color:'#0d948805' }]
            }
          },
          markPoint: {
            data: [{ type:'min', name:'PB' }],
            symbol: 'pin', symbolSize: 36,
            label: { fontSize: 9, fontWeight: 700 },
            itemStyle: { color: '#0d9488' }
          },
          markLine: {
            silent: true,
            data: [{
              yAxis: minTime,
              label: { formatter: 'PB ' + formatTime(minTime), position: 'insideEndTop', color: '#0d9488', fontSize: 9 },
              lineStyle: { color: '#0d9488', type: 'dashed' }
            }]
          }
        }]
      });
    }
    window.addEventListener('resize', () => chartInstance && chartInstance.resize());
  });
}

// --- Settings ---
async function renderSettings() {
  const container = $('#settingsContent');
  const swimmer = await db.swimmers.get(currentSwimmer.id);

  let html = '';
  html += `<div class="card">
    <h3><span class="icon">👤</span>运动员信息</h3>
    <div style="font-size:0.9rem;">
      <p><strong>姓名：</strong>${swimmer.name || '-'}</p>
      <p><strong>生日：</strong>${swimmer.birthDate || '-'}</p>
      <p><strong>性别：</strong>${swimmer.gender || '-'}</p>
      <p><strong>俱乐部：</strong>${swimmer.club || '-'}</p>
    </div>
    <button class="btn btn-secondary btn-block" onclick="openSwimmerModal()" style="margin-top:0.8rem;">编辑信息</button>
  </div>`;

  html += `<div class="card">
    <h3><span class="icon">💾</span>数据管理</h3>
    <div class="setting-row">
      <div><div class="setting-label">导出数据</div><div class="setting-desc">将所有记录导出为 JSON 文件</div></div>
      <button class="btn btn-sm btn-secondary" onclick="exportData()">导出</button>
    </div>
    <div class="setting-row">
      <div><div class="setting-label">导入数据</div><div class="setting-desc">从 JSON 文件恢复数据</div></div>
      <button class="btn btn-sm btn-secondary" onclick="$('#importFile').click()">导入</button>
      <input type="file" id="importFile" accept=".json" style="display:none" onchange="importData(this)">
    </div>
    <div class="setting-row">
      <div><div class="setting-label">清除所有数据</div><div class="setting-desc">删除所有记录和成就（不可恢复）</div></div>
      <button class="btn btn-sm btn-danger" onclick="clearAllData()">清除</button>
    </div>
  </div>`;

  html += `<div class="card">
    <h3><span class="icon">📱</span>关于</h3>
    <p style="font-size:0.85rem;color:var(--text-secondary);">SwimGrowth v1.0<br>一个纯手动的游泳成长记录工具。<br>所有数据存储在本地，离线可用。</p>
  </div>`;

  container.innerHTML = html;
}

// --- Record CRUD ---
function openRecordModal() {
  editingRecordId = null;
  $('#modalTitle').textContent = '添加记录';
  $('#recordForm').reset();
  $('#recDate').value = todayStr();
  $('#recordModal').classList.add('show');
}

function closeRecordModal() {
  $('#recordModal').classList.remove('show');
  editingRecordId = null;
}

async function editRecord(id) {
  const r = await db.records.get(id);
  if (!r) return;
  editingRecordId = id;
  $('#modalTitle').textContent = '编辑记录';
  $(`input[name="type"][value="${r.type}"]`).checked = true;
  $('#recDate').value = r.date;
  $('#recEvent').value = r.eventName || '';
  $('#recStroke').value = r.stroke;
  $('#recDistance').value = r.distance;
  $('#recTime').value = formatTime(r.time);
  $('#recRank').value = r.rank || '';
  $('#recGroup').value = r.group || '';
  $('#recVenue').value = r.venue || '';
  $('#recNotes').value = r.notes || '';
  $('#recordModal').classList.add('show');
}

async function saveRecord(e) {
  e.preventDefault();
  const time = parseTime($('#recTime').value);
  if (time <= 0) { toast('请输入有效的成绩'); return; }

  const data = {
    swimmerId: currentSwimmer.id,
    type: $('input[name="type"]:checked').value,
    date: $('#recDate').value,
    eventName: $('#recEvent').value.trim(),
    stroke: $('#recStroke').value,
    distance: parseInt($('#recDistance').value, 10),
    time: time,
    rank: $('#recRank').value ? parseInt($('#recRank').value, 10) : null,
    group: $('#recGroup').value.trim() || null,
    venue: $('#recVenue').value.trim() || null,
    notes: $('#recNotes').value.trim() || null,
    createdAt: new Date().toISOString()
  };

  if (editingRecordId) {
    await db.records.update(editingRecordId, data);
    toast('记录已更新');
  } else {
    await db.records.add(data);
    toast('记录已添加');
  }

  await checkAchievements();
  closeRecordModal();
  showTab('home');
}

async function deleteRecord(id) {
  if (!confirm('确定要删除这条记录吗？')) return;
  await db.records.delete(id);
  toast('记录已删除');
  renderRecords();
}

// --- Swimmer CRUD ---
function openSwimmerModal() {
  db.swimmers.get(currentSwimmer.id).then(s => {
    $('#swimName').value = s.name || '';
    $('#swimBirth').value = s.birthDate || '';
    $('#swimGender').value = s.gender || '';
    $('#swimClub').value = s.club || '';
    $('#swimmerModal').classList.add('show');
  });
}

function closeSwimmerModal() {
  $('#swimmerModal').classList.remove('show');
}

async function saveSwimmer(e) {
  e.preventDefault();
  await db.swimmers.update(currentSwimmer.id, {
    name: $('#swimName').value.trim(),
    birthDate: $('#swimBirth').value,
    gender: $('#swimGender').value,
    club: $('#swimClub').value.trim()
  });
  currentSwimmer.name = $('#swimName').value.trim();
  toast('信息已保存');
  closeSwimmerModal();
  renderSettings();
}

// --- Data Import/Export ---
async function exportData() {
  const swimmers = await db.swimmers.toArray();
  const records = await db.records.toArray();
  const achievements = await db.achievements.toArray();
  const data = { swimmers, records, achievements, version: 1, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `swimgrowth-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('数据已导出');
}

async function importData(input) {
  const file = input.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const data = JSON.parse(text);
    if (!data.swimmers || !data.records) { toast('无效的数据文件'); return; }
    if (!confirm('导入将覆盖现有数据，确定继续？')) return;
    await db.swimmers.clear();
    await db.records.clear();
    await db.achievements.clear();
    await db.swimmers.bulkAdd(data.swimmers);
    await db.records.bulkAdd(data.records);
    if (data.achievements) await db.achievements.bulkAdd(data.achievements);
    const swimmers = await db.swimmers.toArray();
    currentSwimmer = swimmers[0];
    toast('数据导入成功');
    showTab('home');
  } catch (err) {
    toast('导入失败：' + err.message);
  }
  input.value = '';
}

async function clearAllData() {
  if (!confirm('确定要清除所有数据吗？此操作不可恢复！')) return;
  await db.swimmers.clear();
  await db.records.clear();
  await db.achievements.clear();
  const id = await db.swimmers.add({ name: '小泳者', birthDate: '', gender: '', club: '' });
  currentSwimmer = { id, name: '小泳者' };
  toast('所有数据已清除');
  showTab('home');
}

// --- Achievements ---
async function checkAchievements() {
  const records = await db.records.where('swimmerId').equals(currentSwimmer.id).toArray();
  const unlocked = await db.achievements.where('swimmerId').equals(currentSwimmer.id).toArray();
  const has = id => unlocked.some(a => a.badgeId === id);
  const add = async (id) => {
    const badge = BADGES.find(b => b.id === id);
    await db.achievements.add({ swimmerId: currentSwimmer.id, badgeId: id, date: todayStr(), badgeName: badge.name });
    toast('获得成就：' + badge.name + ' ' + badge.emoji);
  };

  if (records.length >= 1 && !has('first_record')) await add('first_record');
  if (records.some(r => r.type === 'competition') && !has('first_comp')) await add('first_comp');
  if (records.length >= 50 && !has('records_50')) await add('records_50');
  if (records.length >= 100 && !has('records_100')) await add('records_100');

  const strokes = new Set(records.map(r => r.stroke));
  if (strokes.size >= 3 && !has('multi_stroke')) await add('multi_stroke');

  const dists = new Set(records.map(r => r.distance));
  if (dists.size >= 3 && !has('multi_dist')) await add('multi_dist');

  // PB check
  const groups = {};
  records.forEach(r => {
    const key = `${r.stroke}-${r.distance}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });
  let hasPB = false;
  Object.values(groups).forEach(list => {
    list.sort((a,b) => new Date(a.date) - new Date(b.date));
    let best = Infinity;
    for (const r of list) {
      if (r.time < best) { best = r.time; hasPB = true; }
    }
  });
  if (hasPB && !has('first_pb')) await add('first_pb');

  // Streak check (simplified: any records on consecutive days)
  const dates = [...new Set(records.map(r => r.date))].sort();
  let maxStreak = 1, cur = 1;
  for (let i = 1; i < dates.length; i++) {
    const d1 = new Date(dates[i-1]), d2 = new Date(dates[i]);
    const diff = (d2 - d1) / (1000*60*60*24);
    if (diff === 1) { cur++; maxStreak = Math.max(maxStreak, cur); }
    else { cur = 1; }
  }
  if (maxStreak >= 7 && !has('streak_7')) await add('streak_7');
}

// --- Boot ---
document.addEventListener('DOMContentLoaded', init);
