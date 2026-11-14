// ── 数据查询页逻辑 ──────────────────────────────────────
// sql.js(UMD 全局 initSqlJs) 与 Chart.js(UMD 全局 Chart) 由 db.html 的
// <script> 标签提供；本文件为浏览器 ESM 模块，无 import。
// 「筛选查询」只是把表单翻译成 SQL 字符串，与「SQL 控制台」共用同一个真引擎。
// db.html 与 index.html 同级，相对路径在任意子路径前缀下都安全，无需 window.BASE。

const BASE = './';
const $ = id => document.getElementById(id);

let SQL = null;
let db = null;
let trendChart = null;

const escSql = s => String(s == null ? '' : s).replaceAll("'", "''");
const escHtml = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fmtDate(d) {
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : String(d);
}

function runQuery(sql) {
  const t0 = performance.now();
  const res = db.exec(sql);
  return { res, ms: Math.round(performance.now() - t0) };
}

function renderTable(tableEl, columns, rows) {
  tableEl.querySelector('thead').innerHTML = '<tr>' + columns.map(c => `<th>${escHtml(c)}</th>`).join('') + '</tr>';
  tableEl.querySelector('tbody').innerHTML = rows.map(r => '<tr>' + r.map(v => {
    if (v === null || v === undefined) return '<td><span class="null">NULL</span></td>';
    let s = String(v);
    if (s.length > 90) s = s.slice(0, 90) + '…';
    return `<td>${escHtml(s)}</td>`;
  }).join('') + '</tr>').join('');
}

function applyResult(countEl, msEl, result, tableEl) {
  if (!result.res.length) {
    if (countEl) countEl.textContent = '0 行';
    if (msEl) msEl.textContent = '';
    tableEl.querySelector('thead').innerHTML = '';
    tableEl.querySelector('tbody').innerHTML = '';
    return;
  }
  const r = result.res[0];
  const extra = result.res.length > 1 ? `（共 ${result.res.length} 个结果集，显示第 1 个）` : '';
  if (countEl) countEl.textContent = `${r.values.length} 行${extra}`;
  if (msEl) msEl.textContent = result.ms > 0 ? ` · ${result.ms}ms` : '';
  renderTable(tableEl, r.columns, r.values);
}

function showErr(msg) {
  const el = $('sql-error');
  el.textContent = msg;
  el.style.display = 'block';
}
function hideErr() { $('sql-error').style.display = 'none'; }

// ── 筛选表单 → SQL ─────────────────────────────────────

function collectFilters() {
  const f = {};
  f.from = $('f-date-from').value.trim();
  f.to = $('f-date-to').value.trim();
  f.cat = $('f-cat').value;
  f.dir = $('f-dir').value;
  f.impact = $('f-impact').value;
  f.kw = $('f-kw').value.trim();
  f.limit = Math.min(Math.max(parseInt($('f-limit').value, 10) || 50, 1), 500);
  return f;
}

function whereClause(f) {
  const conds = [];
  if (f.from) conds.push(`date >= '${escSql(f.from)}'`);
  if (f.to) conds.push(`date <= '${escSql(f.to)}'`);
  if (f.cat) conds.push(`cat = '${escSql(f.cat)}'`);
  if (f.dir) conds.push(`dir = '${escSql(f.dir)}'`);
  if (f.impact) conds.push(`impact = '${escSql(f.impact)}'`);
  if (f.kw) conds.push(`(title LIKE '%${escSql(f.kw)}%' OR summary LIKE '%${escSql(f.kw)}%')`);
  return conds.length ? ' WHERE ' + conds.join(' AND ') : '';
}

function buildFilterSQL() {
  const f = collectFilters();
  return `SELECT date, cat, dir, impact, title, source, score FROM news${whereClause(f)} ORDER BY date DESC, id LIMIT ${f.limit}`;
}

function buildTrendSQL() {
  const f = collectFilters();
  return `SELECT date, COUNT(*) AS c FROM news${whereClause(f)} GROUP BY date ORDER BY date ASC`;
}

function renderTrendChart(sql) {
  const wrap = $('form-chart');
  if (typeof Chart === 'undefined') { wrap.style.display = 'none'; return; }
  try {
    const r = db.exec(sql);
    const rows = r.length ? r[0].values : [];
    if (!rows.length) { if (trendChart) { trendChart.destroy(); trendChart = null; } wrap.style.display = 'none'; return; }
    if (trendChart) trendChart.destroy();
    trendChart = new Chart($('form-chart-canvas'), {
      type: 'line',
      data: {
        labels: rows.map(x => fmtDate(x[0])),
        datasets: [{
          label: '新闻条数', data: rows.map(x => x[1]),
          borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,.12)',
          fill: true, tension: .25, pointRadius: 3,
        }],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
        responsive: true, maintainAspectRatio: false,
      },
    });
    wrap.style.display = '';
  } catch {
    if (trendChart) { trendChart.destroy(); trendChart = null; }
    wrap.style.display = 'none';
  }
}

function runFormQuery() {
  if (!db) return;
  const sql = buildFilterSQL();
  $('form-eq-sql').textContent = sql;
  try {
    applyResult($('form-result-count'), null, runQuery(sql), $('form-table'));
  } catch (err) {
    $('form-result-count').textContent = '查询出错：' + err.message;
  }
  renderTrendChart(buildTrendSQL());
}

// ── SQL 控制台 ─────────────────────────────────────────

function runSqlConsole(explain) {
  if (!db) return;
  hideErr();
  const sql = $('sql-input').value.trim();
  if (!sql) { showErr('请输入 SQL 再运行。'); return; }
  const q = explain ? 'EXPLAIN QUERY PLAN ' + sql : sql;
  try {
    const result = runQuery(q);
    if (explain) {
      $('plan-wrap').classList.remove('hidden');
      applyResult($('plan-count'), $('sql-ms'), result, $('plan-table'));
    } else {
      applyResult($('sql-result-count'), $('sql-ms'), result, $('sql-table'));
    }
  } catch (e) {
    showErr(e.message);
  }
}

function showSchema() {
  if (!db) return;
  try {
    const result = runQuery("SELECT name AS 表名, sql AS 建表语句 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    $('schema-wrap').classList.remove('hidden');
    applyResult($('schema-count'), null, result, $('schema-table'));
  } catch (e) {
    showErr(e.message);
  }
}

function renderMeta() {
  try {
    const r = db.exec('SELECT key, value FROM meta');
    const m = Object.fromEntries(r[0].values);
    const gen = m.generatedAt ? new Date(m.generatedAt).toLocaleString() : '?';
    $('meta-info').textContent = `${m.days || '?'} 天 · ${m.newsCount || '?'} 条新闻 · ${m.companiesCount || '?'} 家公司 · 版本 v${m.version || '?'} · 构建于 ${gen}`;
  } catch { $('meta-info').textContent = 'meta 读取失败'; }
}

// ── 初始化 ─────────────────────────────────────────────

async function init() {
  try {
    SQL = await initSqlJs({ locateFile: f => BASE + 'assets/' + f });
    const res = await fetch(BASE + 'history/db.sqlite', { cache: 'no-store' });
    if (!res.ok) throw new Error(`db.sqlite 加载失败 HTTP ${res.status}`);
    db = new SQL.Database(new Uint8Array(await res.arrayBuffer()));
    renderMeta();
  } catch (e) {
    $('meta-info').textContent = '数据库加载失败：' + e.message;
    return;
  }

  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + btn.dataset.tab));
    });
  });

  $('filter-form').addEventListener('submit', e => { e.preventDefault(); runFormQuery(); });
  $('f-reset').addEventListener('click', () => { $('filter-form').reset(); $('f-limit').value = '50'; });

  $('sql-run').addEventListener('click', () => runSqlConsole(false));
  $('sql-explain').addEventListener('click', () => runSqlConsole(true));
  $('schema-btn').addEventListener('click', showSchema);
  $('sql-clear').addEventListener('click', () => { $('sql-input').value = ''; hideErr(); });
  $('sql-input').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSqlConsole(false); }
  });

  document.querySelectorAll('.chip-example').forEach(chip => {
    chip.addEventListener('click', () => {
      $('sql-input').value = chip.dataset.sql;
      runSqlConsole(false);
    });
  });

  runFormQuery();
}

init();
