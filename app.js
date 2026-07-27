/* ポーカー道 — スマホ復習版
   633問（＝今井が実戦で間違えた全スポット）をランダムに解く。
   間違えたら質問を書ける。質問と成績は GitHub の sync.json に書き戻し、
   コーチ（Claude）がターミナルからそれを読む。
   ------------------------------------------------------------------
   同期の仕組みは 100books と同じ：localStorage の gh_token + Contents API。
*/
const OWNER = 'artista03', REPO = 'pokerdo', BRANCH = 'main', SYNC_PATH = 'sync.json';
const LS = 'pokerdo_m', LSTOK = 'gh_token';

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let DATA = null, SPOTS = [], ANSWERS = {}, BYKEY = {};
let st = null;            // 端末の状態
let cur = null;           // 今の問題
let fileSha = null, pushTimer = null;

/* ================= 状態 ================= */
function load() {
  try { st = JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { st = {}; }
  st.prog = st.prog || {};        // key -> {n, w, streak}
  st.results = st.results || [];  // {key, correct, at}
  st.questions = st.questions || [];
  return st;
}
const save = () => localStorage.setItem(LS, JSON.stringify(st));

/* ================= 起動 ================= */
(async function init() {
  load();
  try {
    const res = await fetch('data.json?v=' + Date.now(), { cache: 'no-store' });
    DATA = await res.json();
  } catch (e) {
    document.body.innerHTML = '<p style="padding:24px">データが読めない。ネットワークを確認してくれ。</p>';
    return;
  }
  SPOTS = DATA.spots; ANSWERS = DATA.answers || {};
  SPOTS.forEach(s => BYKEY[s.k] = s);
  wire();
  if (getTok()) pull().catch(() => bar('同期できなかった。トークンを確認してくれ。', true));
  paintHeader(); paintQaBadge(); nextSpot();
})();

/* ================= GitHub同期 ================= */
const getTok = () => localStorage.getItem(LSTOK);
const hdrs = () => ({
  Authorization: `Bearer ${getTok()}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28'
});
const b64enc = s => btoa(encodeURIComponent(s).replace(/%([0-9A-F]{2})/g, (_, p) => String.fromCharCode('0x' + p)));
const b64dec = s => decodeURIComponent(Array.from(atob(s.replace(/\n/g, '')))
  .map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));

function bar(msg, err) {
  const b = $('#syncbar');
  b.textContent = msg; b.className = err ? 'err' : '';
  clearTimeout(b._t); b._t = setTimeout(() => b.classList.add('hidden'), 2600);
}

async function pull() {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${SYNC_PATH}?ref=${BRANCH}&t=${Date.now()}`;
  const r = await fetch(url, { headers: hdrs(), cache: 'no-store' });
  if (r.status === 404) { fileSha = null; return; }   // 初回：まだ無い
  if (!r.ok) throw new Error(r.status);
  const j = await r.json(); fileSha = j.sha;
  const remote = JSON.parse(b64dec(j.content));
  // 質問はidで、成績はkey+atで突き合わせる（端末をまたいでも消えない）
  const qi = new Set(st.questions.map(q => q.id));
  (remote.questions || []).forEach(q => { if (q.id && !qi.has(q.id)) { st.questions.push(q); qi.add(q.id); } });
  const ri = new Set(st.results.map(x => x.key + x.at));
  (remote.results || []).forEach(x => { if (!ri.has(x.key + x.at)) { st.results.push(x); ri.add(x.key + x.at); } });
  rebuildProg();
  save(); paintHeader(); paintQaBadge();
  bar('同期した（質問 ' + st.questions.length + ' 件）');
}

/* 成績ログから進捗を作り直す（複数端末をまたぐと prog がズレるため） */
function rebuildProg() {
  const p = {};
  st.results.sort((a, b) => a.at - b.at).forEach(x => {
    const o = p[x.key] || (p[x.key] = { n: 0, w: 0, streak: 0 });
    o.n++; if (x.correct) o.streak++; else { o.w++; o.streak = 0; }
  });
  st.prog = p;
}

async function push(retry) {
  if (!getTok()) return;
  st.results = st.results.slice(-3000);
  const body = JSON.stringify({
    updatedAt: new Date().toISOString(),
    questions: st.questions, results: st.results
  }, null, 1);
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${SYNC_PATH}`, {
    method: 'PUT',
    headers: { ...hdrs(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `sync ${new Date().toISOString()} (q${st.questions.length}/r${st.results.length})`,
      content: b64enc(body), sha: fileSha || undefined, branch: BRANCH
    })
  });
  if (r.status === 409 || r.status === 422) {
    if (retry) throw new Error('conflict');
    await pull(); return push(true);        // 相手を取り込んでからやり直す
  }
  if (!r.ok) throw new Error(r.status);
  fileSha = (await r.json()).content.sha;
  bar('GitHubに保存した');
}
function schedulePush() {
  if (!getTok()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => push().catch(() => bar('保存に失敗した', true)), 2000);
}

/* ================= 出題 ================= */
/* 「克服」＝2連続正解。間違えたまま克服していない問題を優先的に混ぜる。 */
function pools() {
  const todo = [], fresh = [], rest = [];
  SPOTS.forEach(s => {
    const p = st.prog[s.k];
    if (!p) fresh.push(s);
    else if (p.w > 0 && p.streak < 2) todo.push(s);
    else rest.push(s);
  });
  return { todo, fresh, rest };
}
const pick = a => a[Math.floor(Math.random() * a.length)];

function nextSpot() {
  const { todo, fresh, rest } = pools();
  let s;
  if (todo.length && (Math.random() < 0.6 || !fresh.length)) s = pick(todo);
  else if (fresh.length) s = pick(fresh);
  else s = pick(todo.length ? todo : rest);
  if (cur && s.k === cur.k && SPOTS.length > 1) return nextSpot();
  cur = s;
  render(s, todo.length, fresh.length);
  show('quiz'); window.scrollTo(0, 0);
}

/* ================= 描画 ================= */
const SUIT = { s: ['♠', 0], c: ['♣', 0], h: ['♥', 1], d: ['♦', 1] };
function cardHtml(c) {
  const [sym, red] = SUIT[c[1]] || ['?', 0];
  return `<div class="pc${red ? ' red' : ''}"><span class="r">${esc(c[0])}</span><span class="s">${sym}</span></div>`;
}
function boardHtml(b) {
  let h = (b || []).map(cardHtml).join('');
  for (let i = (b || []).length; i < 5; i++) h += '<div class="pc gap"></div>';
  return h;
}
/* 履歴を「プリフロップ / フロップ / …」のストリート単位で行分けし、
   ヒーローの席のアクションだけ色を付ける。 */
function histHtml(hi, pos) {
  const segs = String(hi || '').split('｜').map(x => x.trim()).filter(Boolean);
  const SEATS = ['UTG+2', 'UTG+1', 'UTG', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
  return segs.map((seg, i) => {
    const words = seg.split(/\s+/);
    let head = '';
    if (i > 0 && !SEATS.includes(words[0])) head = words.shift();   // 「フロップ」等
    let out = '', me = false;
    words.forEach(w => {
      if (SEATS.includes(w)) { me = (w === pos); out += `<span class="${me ? 'me' : ''}">${esc(w)}</span> `; }
      else out += `<span class="${me ? 'me' : ''}">${esc(w)}</span> `;
    });
    return `<span class="st">${esc(head || 'プリフロップ')}</span>${out}`;
  }).join('');
}
/* 現在のストリートで受けているベット額。1本だけ受けている時のみ返す。 */
function facingBet(hi) {
  const seg = String(hi || '').split('｜').pop();
  const m = seg.match(/\b[RB]([\d.]+)\b/g) || [];
  if (m.length !== 1) return null;
  const v = parseFloat(m[0].replace(/[RB]/, ''));
  return isFinite(v) ? v : null;
}
/* 実際に自分が追加で払う額。
   🚨 プリフロップのブラインドは既に出している分を差し引く。
   これを忘れると BB の必要勝率が 14.8% ではなく 24.9% と出て、
   ちょうど10ポイント厳しく見える（＝降りる方向に誤らせる）。 */
function callAmount(s) {
  const bet = facingBet(s.hi);
  if (!bet) return null;
  const posted = s.s === 'プリフロップ'
    ? (s.p === 'BB' ? 1 : s.p === 'SB' ? 0.5 : 0) : 0;
  const c = bet - posted;
  return c > 0 ? c : null;
}
/* 正解＝GTOが「最善」と付けた手。EV最大では取り違える場面がある
   （例: Q♦8♥ BB プリフロップ は C が EV+0.001 で最大だが頻度2%の「不正確」、
     F が頻度97.9%の「最善」）。ラベルを優先し、無い時だけEV最大に落とす。 */
const bestOf = o => o.find(x => x.v === '最善') || o.reduce((a, b) => (b.e > a.e ? b : a), o[0]);

function render(s, nTodo, nFresh) {
  $('#mDate').textContent = s.d || '';
  $('#mPos').textContent = s.p || '?';
  $('#mType').textContent = s.t || 'プリフロップ';
  $('#mStreet').textContent = s.s || '';
  $('#mDepth').textContent = `${s.pl || 9}人 ${Math.round(parseFloat(s.dp || 100))}bb`;

  $('#hand').innerHTML = (s.h || []).map(cardHtml).join('');
  if (s.b && s.b.length) { $('#boardBlock').classList.remove('hidden'); $('#board').innerHTML = boardHtml(s.b); }
  else $('#boardBlock').classList.add('hidden');

  const pot = parseFloat(s.pot || 0);
  $('#nPot').textContent = pot ? pot.toFixed(1) : '—';
  $('#nEq').textContent = (s.eq || s.eq === 0) && s.s !== 'プリフロップ' ? (s.eq * 100).toFixed(1) + '%' : '—';
  const call = callAmount(s);
  $('#nReq').textContent = (call && pot) ? (call / (pot + call) * 100).toFixed(1) + '%' : '—';

  const en = $('#eqNote');
  if (s.en) { en.textContent = s.en; en.classList.remove('hidden'); } else en.classList.add('hidden');
  $('#hist').innerHTML = histHtml(s.hi, s.p);

  const LBL = { F: 'フォールド', C: 'コール', X: 'チェック', RAI: 'オールイン' };
  $('#opts').innerHTML = (s.o || []).map(o => {
    const head = o.c.replace(/[\d.]+$/, '');
    const amt = (o.c.match(/[\d.]+$/) || [''])[0];
    const name = LBL[o.c] || LBL[head] || (head === 'R' || head === 'B' ? 'ベット/レイズ' : o.c);
    return `<button class="opt" data-c="${esc(o.c)}">
      <span class="oc">${esc(head)}</span>
      <span>${esc(name)}${amt ? ` <span class="dim">${amt}bb</span>` : ''}</span>
    </button>`;
  }).join('');
  $('#opts').querySelectorAll('.opt').forEach(b => b.onclick = () => answer(b.dataset.c));

  $('#pmark').textContent = `復習待ち ${nTodo}問 ・ 未着手 ${nFresh}問 ・ 全${SPOTS.length}問`;
}

/* ================= 採点 ================= */
function answer(code) {
  const s = cur, best = bestOf(s.o), ok = code === best.c;
  const at = Date.now();
  st.results.push({ key: s.k, correct: ok, at });
  const p = st.prog[s.k] || (st.prog[s.k] = { n: 0, w: 0, streak: 0 });
  p.n++; if (ok) p.streak++; else { p.w++; p.streak = 0; }
  save(); paintHeader(); schedulePush();

  const mine = s.o.find(o => o.c === code) || {};
  const v = $('#verdict');
  v.className = 'verdict ' + (ok ? 'ok' : 'ng');
  v.innerHTML = ok
    ? `正解<span class="vs">${esc(best.c)} が最善。EV ${(+best.e).toFixed(2)}bb</span>`
    : `ミス<span class="vs">あなたは <b>${esc(code)}</b>、GTOは <b>${esc(best.c)}</b>。
       この選択のEVロス ${(+(mine.l || 0)).toFixed(2)}bb</span>`;

  $('#gto').innerHTML = s.o.map(o => {
    const cl = (o.c === best.c ? ' best' : '') + (o.c === code ? ' mine' : '');
    const l = +(o.l || 0);
    return `<div class="gr${cl}">
      <span class="gc">${esc(o.c)}</span>
      <span class="gf">${(o.f * 100).toFixed(1)}%</span>
      <span class="gf">EV ${(+o.e).toFixed(2)}</span>
      <span class="gl${l > 0 ? ' bad' : ''}">${l > 0 ? '−' + l.toFixed(2) + 'bb' : '—'}</span>
    </div>`;
  }).join('');

  $('#expl').innerHTML = md(s.x || '（解説は準備中）');
  setupQbox(s, ok, code, best.c);
  show('result'); window.scrollTo(0, 0);
}

/* ================= 質問 ================= */
let qCtx = null;
function setupQbox(s, ok, pick_, best) {
  const box = $('#qbox'), prev = $('#prevqa');
  const mine = st.questions.filter(q => q.key === s.k);

  // このスポットに対する過去の質問と回答（あれば常に見せる）
  prev.innerHTML = mine.map(q => {
    const a = ANSWERS[q.id];
    return `<div class="qacard ${a ? 'answered' : 'waiting'}">
      <div class="qaw">${new Date(q.at).toLocaleDateString('ja-JP')} ${a ? '· コーチの回答' : '· 回答待ち'}</div>
      <div class="qaq">Q: ${esc(q.q)}</div>
      ${a ? `<div class="qaa">${md(a.a)}</div>` : ''}
    </div>`;
  }).join('');
  prev.classList.toggle('hidden', !mine.length);

  if (ok) { box.classList.add('hidden'); qCtx = null; $('#next').textContent = '次の問題へ'; return; }

  $('#qold').innerHTML = mine.length
    ? `<div class="qold">前にもここで訊いている：${esc(mine[mine.length - 1].q)}</div>` : '';
  $('#qtext').value = '';
  box.classList.remove('hidden');
  $('#next').textContent = '質問なしで次へ';
  qCtx = {
    key: s.k, pick: pick_, best, hand: (s.h || []).join(''), board: (s.b || []).join(''),
    pos: s.p, street: s.s, potType: s.t || '', date: s.d, eq: s.eq
  };
}

/* ================= 表示切替 ================= */
const VIEWS = ['quiz', 'result', 'qa', 'setv'];
function show(id) {
  VIEWS.forEach(v => $('#' + v).classList.toggle('hidden', v !== id));
  if (id === 'setv') paintStats();
  if (id === 'qa') paintQa();
}
function paintHeader() {
  const today = new Date().toDateString();
  const t = st.results.filter(x => new Date(x.at).toDateString() === today);
  const tc = t.filter(x => x.correct).length;
  $('#hToday').textContent = t.length ? `今日 ${tc}/${t.length}` : '今日 —';
  const all = st.results, ac = all.filter(x => x.correct).length;
  $('#hAcc').textContent = all.length ? `累計 ${Math.round(ac / all.length * 100)}%` : '累計 —';
}
function paintQaBadge() {
  const n = st.questions.filter(q => !ANSWERS[q.id]).length;
  const b = $('#qaBadge');
  b.textContent = n; b.classList.toggle('hidden', !n);
}
function paintQa() {
  const body = $('#qabody');
  if (!st.questions.length) { body.innerHTML = '<p class="dim">まだ質問は無い。間違えた時に書けば、ここに溜まる。</p>'; return; }
  body.innerHTML = st.questions.slice().sort((a, b) => b.at - a.at).map(q => {
    const a = ANSWERS[q.id], s = BYKEY[q.key] || {};
    return `<div class="qacard ${a ? 'answered' : 'waiting'}">
      <div class="qaw">${new Date(q.at).toLocaleDateString('ja-JP')} ·
        ${esc((s.h || []).join(' '))} ${esc(s.p || '')} ${esc(s.t || '')} ${esc(s.s || '')}
        ${s.b && s.b.length ? '· 板 ' + esc(s.b.join(' ')) : ''}
        · ${a ? 'コーチの回答' : '回答待ち'}</div>
      <div class="qaq">Q: ${esc(q.q)}</div>
      ${a ? `<div class="qaa">${md(a.a)}</div>` : ''}
    </div>`;
  }).join('');
}
function paintStats() {
  const all = st.results, ac = all.filter(x => x.correct).length;
  const { todo, fresh } = pools();
  const byStreet = {};
  all.forEach(x => {
    const s = BYKEY[x.key]; if (!s) return;
    const o = byStreet[s.s] || (byStreet[s.s] = [0, 0]);
    o[1]++; if (x.correct) o[0]++;
  });
  const rows = [
    ['解いた数', all.length],
    ['正答率', all.length ? Math.round(ac / all.length * 100) + '%' : '—'],
    ['復習待ち（未克服）', todo.length + '問'],
    ['未着手', fresh.length + '問'],
    ['質問', st.questions.length + '件（未回答 ' + st.questions.filter(q => !ANSWERS[q.id]).length + '）']
  ].concat(Object.entries(byStreet).map(([k, v]) => [k, `${v[0]}/${v[1]} = ${Math.round(v[0] / v[1] * 100)}%`]));
  $('#statBody').innerHTML = rows.map(([a, b]) => `<div class="sr"><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join('');
  $('#tokState').textContent = getTok() ? 'トークンは保存済み。自動で同期する。' : '未設定。この端末だけに保存される。';
}

/* ================= 最小マークダウン ================= */
function md(t) {
  const blocks = [];
  let s = esc(t).replace(/```([\s\S]*?)```/g, (m, c) => {
    blocks.push(c.replace(/^\n/, '')); return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^---+$/gm, '<hr>')
    .replace(/\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<pre>${blocks[+i]}</pre>`);
}

/* ================= 配線 ================= */
function wire() {
  $('#next').onclick = nextSpot;
  $('#qsave').onclick = () => {
    const q = $('#qtext').value.trim();
    if (!q) { nextSpot(); return; }
    st.questions.push({
      id: 'q' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      at: Date.now(), q, ...qCtx
    });
    save(); paintQaBadge();
    if (getTok()) push().then(() => bar('質問をGitHubに送った')).catch(() => bar('送信失敗。あとで再同期する。', true));
    $('#qsave').textContent = '残した';
    setTimeout(() => { $('#qsave').textContent = 'この質問を残して次へ'; nextSpot(); }, 600);
  };
  $('#btnQa').onclick = () => show('qa');
  $('#qaBack').onclick = () => show('quiz');
  $('#btnSet').onclick = () => show('setv');
  $('#setBack').onclick = () => show('quiz');
  $('#tokSave').onclick = () => {
    const v = $('#tok').value.trim();
    if (!v) return;
    localStorage.setItem(LSTOK, v); $('#tok').value = '';
    pull().then(() => push()).then(paintStats)
      .catch(() => bar('トークンが通らない。scopeを確認してくれ。', true));
  };
  $('#syncNow').onclick = () => pull().then(() => push()).then(paintStats)
    .catch(() => bar('同期に失敗した', true));
  $('#reset').onclick = () => {
    if (!confirm('この端末の成績と質問を消す。GitHubに同期済みのぶんは次回の同期で戻ってくる。いいか？')) return;
    localStorage.removeItem(LS); load(); paintHeader(); paintQaBadge(); paintStats(); nextSpot();
  };
}
