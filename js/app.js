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
let syncKey = localStorage.getItem('swimgrowth_sync_key') || '';

// --- Supabase ---
const SUPABASE_URL = 'https://tpnjuovywhpzfkjacjkh.supabase.co';
const SUPABASE_KEY = 'sb_publishable_12I7Pc_UxjDm21_igAYrgQ_Ee0SXUKl';
let supabaseClient = null;

// --- Constants ---
const STROKES = ['自由泳','蛙泳','仰泳','蝶泳','混合泳'];
const DISTANCES = [15,25,50,100,200,400,800,1500];
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

  // Radio button click handling
  $$('.radio-option').forEach(opt => {
    opt.addEventListener('click', () => {
      $$('.radio-option').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      opt.querySelector('input[type="radio"]').checked = true;
    });
  });

  // Forms
  $('#recordForm').addEventListener('submit', saveRecord);
  $('#swimmerForm').addEventListener('submit', saveSwimmer);

  // Init Supabase client
  if (window.supabase && window.supabase.createClient) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  }

  // Auto sync on startup
  await autoSync();

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
  const records = await db.records.where('swimmerId').equals(currentSwimmer.id).sortBy('date');
  window._chartRecords = records;

  // Get unique stroke-distance combos
  const combos = [...new Set(records.map(r => `${r.stroke}-${r.distance}`))];
  const comboOptions = combos.map(c => {
    const [s,d] = c.split('-');
    return `<option value="${c}">${s} ${d}m</option>`;
  }).join('');

  // Fill filters
  const filterHtml = `
    <select id="chartCombo" onchange="updateChartInfo();renderChart()">${comboOptions || '<option>暂无数据</option>'}</select>
    <select id="chartType" onchange="updateChartInfo();renderChart()">
      <option value="trend">成绩趋势</option>
      <option value="dist">类型分布</option>
      <option value="stroke">泳姿统计</option>
    </select>
  `;
  $('#chartFilters').innerHTML = filterHtml;

  // Update title/subtitle
  updateChartInfo();

  // PB list
  const pbList = $('#pbList');
  if (records.length === 0) {
    pbList.innerHTML = `<div style="color:var(--text-secondary);font-size:0.85rem;padding:0.5rem 0;">添加记录后将显示 PB 里程碑</div>`;
  } else {
    const pbs = calcPBs(records);
    pbList.innerHTML = pbs.map(pb => `
      <div class="pb-item">
        <span class="pb-name">${pb.key}</span>
        <div style="display:flex;align-items:center;">
          <span class="pb-time">${pb.time.toFixed(2)}<span style="font-size:0.75rem;color:var(--text-secondary);margin-left:2px;">秒</span></span>
          <span class="pb-badge">PB</span>
        </div>
      </div>
    `).join('');
  }

  if (combos.length > 0) renderChart();
}

function updateChartInfo() {
  const type = $('#chartType')?.value || 'trend';
  const combo = $('#chartCombo')?.value || '';
  const titles = { trend: '成绩趋势', dist: '记录类型分布', stroke: '泳姿统计' };
  const title = titles[type] || '图表';
  let subtitle = '选择泳姿和距离查看成长曲线';
  if (combo && combo !== '暂无数据') {
    const [s,d] = combo.split('-');
    const count = (window._chartRecords || []).filter(r => r.stroke === s && r.distance === parseInt(d,10)).length;
    subtitle = `${s} ${d}m — 共 ${count} 条记录`;
  }
  $('#chartTitle').textContent = title;
  $('#chartSubtitle').textContent = subtitle;
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

    const dom = $('#mainChart');
    if (chartInstance) chartInstance.dispose();
    chartInstance = echarts.init(dom, null, { renderer: 'svg' });

    if (type === 'dist') {
      if (!all.length) return;
      const distData = {};
      all.forEach(r => { distData[r.type] = (distData[r.type]||0) + 1; });
      const total = all.length;
      const pieData = Object.entries(distData).map(([k,v]) => ({
        name: typeLabel(k), value: v, pct: ((v/total)*100).toFixed(1)
      }));
      const colorMap = { '比赛': '#388989', '训练': '#56a8b8', '测试': '#e2a454' };

      chartInstance.setOption({
        animation: false,
        tooltip: {
          trigger: 'item', appendToBody: true,
          backgroundColor: 'rgba(30,41,51,0.92)',
          borderColor: 'transparent',
          textStyle: { color: '#fff', fontSize: 13 },
          formatter: function(p) {
            return `<div style="font-weight:700;margin-bottom:4px;">${p.name}</div>` +
                   `<div>共 <span style="font-size:15px;font-weight:700;color:#5ba3a1;">${p.value}</span> 条</div>` +
                   `<div>占比 <span style="font-size:15px;font-weight:700;color:#e2a454;">${p.data.pct}%</span></div>`;
          }
        },
        legend: {
          bottom: 0, left: 'center',
          icon: 'circle', itemWidth: 10, itemHeight: 10,
          itemGap: 20,
          textStyle: { color: '#7a9199', fontSize: 12 }
        },
        color: pieData.map(d => colorMap[d.name] || '#3d8b8a'),
        series: [{
          type: 'pie',
          radius: ['48%','72%'],
          center: ['50%','45%'],
          data: pieData,
          itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 3 },
          label: { show: false },
          labelLine: { show: false },
          emphasis: {
            itemStyle: { shadowBlur: 12, shadowOffsetX: 0, shadowColor: 'rgba(0,0,0,0.15)' }
          }
        }]
      });
    } else if (type === 'stroke') {
      if (!all.length) return;
      const strokeData = {};
      all.forEach(r => { strokeData[r.stroke] = (strokeData[r.stroke]||0) + 1; });
      const total = all.length;
      const pieData = Object.entries(strokeData).map(([k,v]) => ({
        name: k, value: v, pct: ((v/total)*100).toFixed(1)
      }));

      chartInstance.setOption({
        animation: false,
        tooltip: {
          trigger: 'item', appendToBody: true,
          backgroundColor: 'rgba(30,41,51,0.92)',
          borderColor: 'transparent',
          textStyle: { color: '#fff', fontSize: 13 },
          formatter: function(p) {
            return `<div style="font-weight:700;margin-bottom:4px;">${p.name}</div>` +
                   `<div>共 <span style="font-size:15px;font-weight:700;color:#5ba3a1;">${p.value}</span> 条</div>` +
                   `<div>占比 <span style="font-size:15px;font-weight:700;color:#e2a454;">${p.data.pct}%</span></div>`;
          }
        },
        legend: {
          bottom: 0, left: 'center',
          icon: 'circle', itemWidth: 10, itemHeight: 10,
          itemGap: 20,
          textStyle: { color: '#7a9199', fontSize: 12 }
        },
        color: ['#388989','#56a8b8','#5ba3a1','#e2a454','#c9984a'],
        series: [{
          type: 'pie',
          radius: ['48%','72%'],
          center: ['50%','45%'],
          data: pieData,
          itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 3 },
          label: { show: false },
          labelLine: { show: false },
          emphasis: {
            itemStyle: { shadowBlur: 12, shadowOffsetX: 0, shadowColor: 'rgba(0,0,0,0.15)' }
          }
        }]
      });
    } else {
      if (!data.length) return;
      // 简化日期格式：只显示月/日
      const dates = data.map(r => {
        const d = new Date(r.date);
        return `${d.getMonth()+1}/${d.getDate()}`;
      });
      const times = data.map(r => r.time);
      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);
      // Y轴范围：稍微扩展一点，让图表不贴边
      const yMin = Math.floor(minTime * 0.95);
      const yMax = Math.ceil(maxTime * 1.05);

      chartInstance.setOption({
        animation: false,
        tooltip: {
          trigger: 'axis', appendToBody: true,
          backgroundColor: 'rgba(30,41,51,0.92)',
          borderColor: 'transparent',
          textStyle: { color: '#fff', fontSize: 13 },
          formatter: function(p) {
            const idx = p[0].dataIndex;
            const fullDate = data[idx].date;
            const t = p[0].value;
            return `<div style="font-weight:700;margin-bottom:4px;">${fullDate}</div>` +
                   `<div>成绩：<span style="font-size:16px;font-weight:700;color:#5ba3a1;">${t.toFixed(2)}</span> <span style="font-size:12px;">秒</span></div>`;
          }
        },
        grid: { left: 56, right: 20, top: 40, bottom: 30 },
        xAxis: {
          type: 'category', data: dates,
          axisLabel: { color: '#7a9199', fontSize: 12, rotate: 0, interval: 'auto' },
          axisLine: { lineStyle: { color: '#dce5e3' } },
          axisTick: { show: false }
        },
        yAxis: {
          type: 'value',
          name: '秒',
          nameTextStyle: { color: '#7a9199', fontSize: 12, fontWeight: 600, padding: [0,0,0,-30] },
          min: yMin,
          max: yMax,
          axisLabel: {
            color: '#7a9199', fontSize: 12, fontWeight: 500,
            formatter: v => v.toFixed(1)
          },
          axisLine: { show: false },
          splitLine: { lineStyle: { color: '#eaf0ef', type: 'solid' } }
        },
        series: [{
          type: 'line', data: times, smooth: 0.35,
          symbol: 'circle', symbolSize: 10,
          lineStyle: { color: '#3d8b8a', width: 3.5 },
          itemStyle: { color: '#3d8b8a', borderColor: '#fff', borderWidth: 2.5 },
          areaStyle: {
            color: { type: 'linear', x:0, y:0, x2:0, y2:1,
              colorStops: [
                { offset:0, color:'rgba(61,139,138,0.18)' },
                { offset:0.6, color:'rgba(61,139,138,0.05)' },
                { offset:1, color:'rgba(61,139,138,0)' }
              ]
            }
          },
          markPoint: {
            data: [{ type:'min', name:'PB', symbol:'circle', symbolSize:22 }],
            label: {
              show: true, position: 'top', distance: 8,
              formatter: '{b}', fontSize: 12, fontWeight: 700, color: '#c45c5c'
            },
            itemStyle: { color: '#c45c5c', borderColor:'#fff', borderWidth:3 }
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
    <h3><span class="icon">🏅</span>成就说明</h3>
    <div style="font-size:0.82rem;color:var(--text-secondary);line-height:1.7;">
      <div style="display:flex;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border);"><span>🏊 初出茅庐</span><span>添加第 1 条记录</span></div>
      <div style="display:flex;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border);"><span>🏆 初试锋芒</span><span>添加第 1 条比赛记录</span></div>
      <div style="display:flex;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border);"><span>⚡ 突破自我</span><span>打破个人最佳成绩（PB）</span></div>
      <div style="display:flex;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border);"><span>🔥 一周坚持</span><span>连续 7 天有训练记录</span></div>
      <div style="display:flex;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border);"><span>📊 半百记录</span><span>累计 50 条记录</span></div>
      <div style="display:flex;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border);"><span>💯 百次突破</span><span>累计 100 条记录</span></div>
      <div style="display:flex;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border);"><span>🌊 全能选手</span><span>记录过 3 种以上泳姿</span></div>
      <div style="display:flex;justify-content:space-between;padding:0.35rem 0;"><span>🏁 长短皆宜</span><span>记录过 3 种以上距离</span></div>
    </div>
  </div>`;

  html += `<div class="card">
    <h3><span class="icon">💾</span>数据管理</h3>
    <div class="setting-row">
      <div><div class="setting-label">导出 Excel</div><div class="setting-desc">将所有记录导出为 Excel 表格</div></div>
      <button class="btn btn-sm btn-secondary" onclick="exportExcel()">导出</button>
    </div>
    <div class="setting-row">
      <div><div class="setting-label">导入 Excel</div><div class="setting-desc">从 Excel 表格恢复数据</div></div>
      <button class="btn btn-sm btn-secondary" onclick="$('#importFile').click()">导入</button>
      <input type="file" id="importFile" accept=".xlsx,.xls" style="display:none" onchange="importExcel(this)">
    </div>
    <div class="setting-row">
      <div><div class="setting-label">清除所有数据</div><div class="setting-desc">删除所有记录和成就（不可恢复）</div></div>
      <button class="btn btn-sm btn-danger" onclick="clearAllData()">清除</button>
    </div>
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
  await syncToCloud();
  closeRecordModal();
  showTab('home');
}

async function deleteRecord(id) {
  if (!confirm('确定要删除这条记录吗？')) return;
  await db.records.delete(id);
  await syncToCloud();
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

// --- Data Import/Export (Excel) ---
async function exportExcel() {
  const records = await db.records.where('swimmerId').equals(currentSwimmer.id).sortBy('date');
  const swimmer = await db.swimmers.get(currentSwimmer.id);

  // Build worksheet data
  const wsData = [
    ['SwimGrowth 游泳成长记录'],
    ['运动员：' + (swimmer?.name || ''), '俱乐部：' + (swimmer?.club || ''), '导出日期：' + todayStr()],
    [],
    ['日期', '类型', '赛事/训练名称', '泳姿', '距离(m)', '成绩(秒)', '名次', '组别', '场地', '备注']
  ];

  records.forEach(r => {
    wsData.push([
      r.date,
      typeLabel(r.type),
      r.eventName || '',
      r.stroke,
      r.distance,
      r.time,
      r.rank || '',
      r.group || '',
      r.venue || '',
      r.notes || ''
    ]);
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Set column widths
  ws['!cols'] = [
    { wch: 12 }, { wch: 8 }, { wch: 22 }, { wch: 8 },
    { wch: 10 }, { wch: 10 }, { wch: 6 }, { wch: 8 }, { wch: 18 }, { wch: 24 }
  ];

  XLSX.utils.book_append_sheet(wb, ws, '游泳记录');
  XLSX.writeFile(wb, `SwimGrowth-${swimmer?.name || '记录'}-${todayStr()}.xlsx`);
  toast('Excel 已导出');
}

async function importExcel(input) {
  const file = input.files[0];
  if (!file) return;

  try {
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Skip header rows (first 4 rows are title/info/empty/header)
    const dataRows = rows.slice(4);
    if (dataRows.length === 0) { toast('Excel 中没有找到数据'); return; }

    if (!confirm(`检测到 ${dataRows.length} 条记录，导入将覆盖现有数据，确定继续？`)) return;

    const typeMap = { '比赛': 'competition', '训练': 'training', '测试': 'test' };
    const newRecords = [];

    dataRows.forEach((row, idx) => {
      if (!row[0]) return; // skip empty rows
      const timeVal = parseFloat(row[5]);
      if (!timeVal || timeVal <= 0) return;

      newRecords.push({
        swimmerId: currentSwimmer.id,
        type: typeMap[row[1]] || 'training',
        date: row[0] || todayStr(),
        eventName: row[2] || '',
        stroke: row[3] || '自由泳',
        distance: parseInt(row[4], 10) || 50,
        time: timeVal,
        rank: row[6] ? parseInt(row[6], 10) : null,
        group: row[7] || null,
        venue: row[8] || null,
        notes: row[9] || null,
        createdAt: new Date().toISOString()
      });
    });

    await db.records.clear();
    await db.achievements.clear();
    if (newRecords.length > 0) {
      await db.records.bulkAdd(newRecords);
    }
    await checkAchievements();
    toast(`成功导入 ${newRecords.length} 条记录`);
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

// --- Cloud Sync ---
function generateSyncKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = '';
  for (let i = 0; i < 8; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

async function autoSync() {
  if (!supabaseClient) return;
  if (!syncKey) {
    syncKey = generateSyncKey();
    localStorage.setItem('swimgrowth_sync_key', syncKey);
  }
  await syncFromCloud();
}

async function syncToCloud() {
  if (!supabaseClient || !syncKey) return;
  try {
    const swimmers = await db.swimmers.toArray();
    const records = await db.records.toArray();
    const achievements = await db.achievements.toArray();

    // Push swimmers
    for (const s of swimmers) {
      const { error } = await supabaseClient
        .from('swimmers')
        .upsert({ user_id: syncKey, name: s.name, birth_date: s.birthDate, gender: s.gender, club: s.club }, { onConflict: 'user_id' });
    }

    // Push records (delete all then insert)
    await supabaseClient.from('records').delete().eq('user_id', syncKey);
    if (records.length > 0) {
      const recs = records.map(r => ({
        user_id: syncKey,
        swimmer_id: r.swimmerId,
        type: r.type,
        date: r.date,
        event_name: r.eventName,
        stroke: r.stroke,
        distance: r.distance,
        time: r.time,
        rank: r.rank,
        group: r.group,
        venue: r.venue,
        notes: r.notes
      }));
      await supabaseClient.from('records').insert(recs);
    }

    // Push achievements
    await supabaseClient.from('achievements').delete().eq('user_id', syncKey);
    if (achievements.length > 0) {
      const achs = achievements.map(a => ({
        user_id: syncKey,
        badge_id: a.badgeId,
        badge_name: a.badgeName,
        date: a.date
      }));
      await supabaseClient.from('achievements').insert(achs);
    }
  } catch (err) {
    console.error('Sync to cloud failed:', err);
  }
}

async function syncFromCloud() {
  if (!supabaseClient || !syncKey) return;
  try {
    // Pull swimmers
    const { data: swimmersData, error: swimmersErr } = await supabaseClient
      .from('swimmers').select('*').eq('user_id', syncKey);
    if (swimmersErr) throw swimmersErr;

    // Pull records
    const { data: recordsData, error: recordsErr } = await supabaseClient
      .from('records').select('*').eq('user_id', syncKey);
    if (recordsErr) throw recordsErr;

    // Pull achievements
    const { data: achievementsData, error: achievementsErr } = await supabaseClient
      .from('achievements').select('*').eq('user_id', syncKey);
    if (achievementsErr) throw achievementsErr;

    // If cloud has data, merge to local
    if (swimmersData && swimmersData.length > 0) {
      await db.swimmers.clear();
      for (const s of swimmersData) {
        await db.swimmers.add({
          name: s.name || '小泳者',
          birthDate: s.birth_date || '',
          gender: s.gender || '',
          club: s.club || ''
        });
      }
    }

    if (recordsData && recordsData.length > 0) {
      await db.records.clear();
      const recs = recordsData.map(r => ({
        swimmerId: r.swimmer_id || 1,
        type: r.type,
        date: r.date,
        eventName: r.event_name,
        stroke: r.stroke,
        distance: r.distance,
        time: r.time,
        rank: r.rank,
        group: r.group,
        venue: r.venue,
        notes: r.notes,
        createdAt: new Date().toISOString()
      }));
      await db.records.bulkAdd(recs);
    }

    if (achievementsData && achievementsData.length > 0) {
      await db.achievements.clear();
      const achs = achievementsData.map(a => ({
        swimmerId: 1,
        badgeId: a.badge_id,
        badgeName: a.badge_name,
        date: a.date
      }));
      await db.achievements.bulkAdd(achs);
    }

    // Refresh currentSwimmer
    const swimmers = await db.swimmers.toArray();
    if (swimmers.length > 0) {
      currentSwimmer = swimmers[0];
    }
  } catch (err) {
    console.error('Sync from cloud failed:', err);
  }
}

async function manualSync() {
  if (!supabaseClient) { toast('云同步不可用'); return; }
  toast('正在同步...');
  await syncToCloud();
  await syncFromCloud();
  toast('同步完成');
  showTab('home');
}

async function changeSyncKey() {
  const newKey = prompt('请输入同步密钥（留空自动生成）：', syncKey);
  if (newKey === null) return;
  const key = newKey.trim() || generateSyncKey();
  syncKey = key;
  localStorage.setItem('swimgrowth_sync_key', syncKey);
  toast('密钥已更新，正在同步...');
  await syncFromCloud();
  toast('同步完成');
  renderSettings();
  showTab('home');
}

// --- Boot ---
document.addEventListener('DOMContentLoaded', init);
