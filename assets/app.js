/* ============================================================
   电子族谱 —— 家族宗谱
   数据保存在浏览器本地（localStorage），可导出 JSON 备份
   ============================================================ */
(function () {
  'use strict';

  /* -------------------- 常量 -------------------- */
  const STORAGE_KEY = 'siren-family-tree-v5';
  const CARD_W = 142;
  const CARD_H = 84;
  const SPOUSE_GAP = 12;
  const SIB_GAP = 32;
  const LEVEL_GAP = 98;
  const ROOT_GAP = 100;

  const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
    '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
    '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];

  const state = {
    familyTitle: '陈氏宗谱',
    members: [],
    logs: [],
    trash: [],
    authed: false,
    view: 'tree',
    query: '',
    genderFilter: 'all',
    genFilter: 'all',
    sortBy: 'gen',
    selectedId: null,
    editing: false,
    pendingPhoto: null,
    modalMode: 'birth',
    zoom: { scale: 1, x: 0, y: 0 },
    layout: null,
    lastLayoutWidth: 0
  };

  let gens = new Map();
  let toastTimer = null;
  let suppressClick = false;

  /* -------------------- 工具函数 -------------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function uid() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function toast(msg, type) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show' + (type === 'error' ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2400);
  }
  function memberById(id) {
    if (!id) return null;
    return state.members.find(m => m.id === id) || null;
  }
  function genLabel(p) {
    const lv = gens.get(p.id);
    return CN_NUM[(lv == null ? 0 : lv) + 1] + '世';
  }
  function birthYear(p) {
    const n = parseInt(String(p.birth || '').match(/\d{3,4}/) || '', 10);
    return isNaN(n) ? 9999 : n;
  }
  function lifeSpan(p) {
    const b = (p.birth || '').trim();
    const d = (p.death || '').trim();
    if (b && d) return b + ' — ' + d;
    if (b) return b + ' —';
    if (d) return '卒 ' + d;
    return '生卒未详';
  }
  function calcAge(p) {
    const b = parseInt(String(p.birth || '').match(/\d{3,4}/) || '', 10);
    const d = parseInt(String(p.death || '').match(/\d{3,4}/) || '', 10);
    if (!isNaN(b) && !isNaN(d) && d >= b) return (d - b) + ' 岁';
    return '';
  }

  /* -------------------- 录入校验 -------------------- */
  function parseDate(value) {
    const s = String(value || '').trim();
    const m = s.match(/(\d{3,4})(?:\s*[-/.年]\s*(\d{1,2}))?(?:\s*[-/.月]\s*(\d{1,2}))?/);
    if (!m) return null;
    const y = parseInt(m[1], 10);
    if (!y || y < 1 || y > 2200) return null;
    return {
      y: y,
      m: m[2] ? Math.min(12, parseInt(m[2], 10)) : 0,
      d: m[3] ? Math.min(31, parseInt(m[3], 10)) : 0
    };
  }
  function dateCmp(a, b) {
    return (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
  }
  function dateIssue(birth, death) {
    const b = parseDate(birth);
    const d = parseDate(death);
    const now = new Date().getFullYear();
    if (b && b.y > now) return '出生时间不能晚于今年（' + now + '）';
    if (d && d.y > now) return '死亡时间不能晚于今年（' + now + '）';
    if (b && d && dateCmp(b, d) > 0) return '出生时间不能晚于死亡时间';
    return '';
  }
  function childKindText(k) {
    if (k === 'adopted') return '收养';
    if (k === 'inherited') return '过继';
    return '亲生';
  }
  function spouseStatusText(s) {
    if (s === 'divorced') return '离异';
    if (s === 'widowed') return '丧偶';
    if (s === 'remarried') return '再婚';
    return '在婚';
  }
  function findDuplicateMember(name, birth, excludeId, fatherId) {
    const n = String(name || '').trim();
    if (!n) return null;
    const b = parseDate(birth);
    return state.members.find(x => {
      if (x.id === excludeId) return false;
      if (String(x.name || '').trim() !== n) return false;
      const xb = parseDate(x.birth);
      if (b && xb) return b.y === xb.y;
      if (!birth && !x.birth) return !!fatherId && x.fatherId === fatherId;
      return false;
    }) || null;
  }
  function parentBirthIssue(parent, childBirth) {
    const pb = parseDate(parent.birth);
    const cb = parseDate(childBirth);
    if (!pb || !cb) return null;
    if (dateCmp(pb, cb) >= 0) {
      return { level: 'error', msg: parent.name + '的出生时间必须早于子女' };
    }
    if (cb.y - pb.y < 12) {
      return { level: 'warn', msg: parent.name + '与子女出生仅相差 ' + (cb.y - pb.y) + ' 年，确认无误？' };
    }
    return null;
  }
  function parentDeathIssue(parent, childBirth) {
    const pd = parseDate(parent.death);
    const cb = parseDate(childBirth);
    if (pd && cb && dateCmp(cb, pd) > 0) {
      return { level: 'warn', msg: parent.name + '去世后子女才出生，确认是否遗腹子？' };
    }
    return null;
  }
  function wouldCreateCycle(personId, parentId) {
    if (!personId || !parentId) return false;
    if (personId === parentId) return true;
    const stack = [parentId];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const p = memberById(id);
      if (!p) continue;
      if (p.fatherId === personId || p.motherId === personId) return true;
      if (p.fatherId) stack.push(p.fatherId);
      if (p.motherId) stack.push(p.motherId);
    }
    return false;
  }
  function relationLine(p) {
    const parts = [genLabel(p)];
    const f = memberById(p.fatherId);
    const mo = memberById(p.motherId);
    const sps = (p.spouseIds || []).map(memberById).filter(Boolean);
    if (f) parts.push('父 ' + f.name);
    if (mo) parts.push('母 ' + mo.name);
    if (sps.length) parts.push('配 ' + sps.map(s => s.name).join('、'));
    if (!f && !mo && !sps.length) parts.push(p.entryType === 'return' ? '归宗立户' : '始迁祖');
    return parts.join(' · ');
  }
  function childrenOf(id) {
    return state.members.filter(m => m.fatherId === id || m.motherId === id);
  }
  function avatarHtml(p, extra) {
    const initial = (p.name || '?').slice(0, 1);
    const inner = p.photo
      ? '<img src="' + p.photo + '" alt="' + esc(p.name) + '">'
      : '<span>' + esc(initial) + '</span>';
    return '<div class="avatar ' + p.gender + (extra ? ' ' + extra : '') + '">' + inner + '</div>';
  }

  /* -------------------- 初始数据 -------------------- */
  function seedData() {
    const base = Date.now() - 1000 * 60 * 60 * 24 * 90;
    const mk = (i, obj) => Object.assign({
      id: 'p' + i,
      name: '',
      gender: 'male',
      fatherId: null,
      motherId: null,
      spouseIds: [],
      birth: '',
      death: '',
      deathCause: '',
      bio: '',
      photo: '',
      entryType: 'birth',
      entryNote: '',
      createdAt: base + i * 60000
    }, obj);

    return {
      familyName: '陈氏宗谱',
      members: [
        mk(1, {
          name: '陈立德', gender: 'male', spouseIds: ['p2'], birth: '1928', death: '2005',
          deathCause: '肺源性心脏病', entryType: 'root',
          bio: '陈立德，字守拙，1928年生于本邑南乡陈家坳。少年随父习木工，农忙下田，农闲走村串户为人修房打柜，乡里皆称其手艺「稳当」。\n\n1950年与林淑贞成婚，育有三子一女。1980年代起主持族中祭祖与冬至分胙诸事。晚年凭记忆整理旧谱残页，手抄两册，存于长房。\n\n2005年冬病逝于家中，享年七十七岁。'
        }),
        mk(2, {
          name: '林淑贞', gender: 'female', spouseIds: ['p1'], birth: '1932', death: '2010',
          deathCause: '脑卒中', entryType: 'birth',
          bio: '林淑贞，1932年生于邻村林家坞。1950年嫁入陈家，一生勤俭持家，擅做米糕与酱菜，逢年过节总要给各房送上一份。\n\n晚年随长子居住，2010年安详离世。'
        }),
        mk(3, {
          name: '陈国栋', gender: 'male', fatherId: 'p1', motherId: 'p2', spouseIds: ['p4'],
          birth: '1955', entryType: 'birth',
          bio: '陈国栋，1955年生。1974年入伍，1978年复员回乡，任村小学民办教师十余年，后转正执教至2015年退休。\n\n喜好书法，常年为族人书写春联。2019年起接续父亲手抄旧谱，逐一核对各房生卒年月。'
        }),
        mk(4, {
          name: '王秀英', gender: 'female', spouseIds: ['p3'], birth: '1957', entryType: 'birth',
          bio: '王秀英，1957年生于本乡王家湾。1980年与陈国栋成婚，曾在乡供销社工作。'
        }),
        mk(5, {
          name: '陈国强', gender: 'male', fatherId: 'p1', motherId: 'p2', spouseIds: ['p6'],
          birth: '1958', entryType: 'birth',
          bio: '陈国强，1958年生。早年学泥瓦手艺，1988年组建乡建筑队，承建本村及邻村的民居与校舍。'
        }),
        mk(6, {
          name: '李秀兰', gender: 'female', spouseIds: ['p5'], birth: '1960', entryType: 'birth',
          bio: '李秀兰，1960年生，邻镇李家坳人。1982年嫁入陈家，操持家务，兼做些针线活补贴家用。'
        }),
        mk(7, {
          name: '陈玉琴', gender: 'female', fatherId: 'p1', motherId: 'p2', spouseIds: ['p8'],
          birth: '1961', entryType: 'birth',
          bio: '陈玉琴，1961年生，家中长女。1984年嫁与本乡张建国，育有一女。\n\n1998年起在镇上经营布匹铺，善裁衣。每逢族中红白事，必到场帮衬。'
        }),
        mk(8, {
          name: '张建国', gender: 'male', spouseIds: ['p7'], birth: '1959', entryType: 'birth',
          bio: '张建国，1959年生，本乡张家坳人。1984年与陈玉琴成婚，先后做过木器生意与运输。'
        }),
        mk(9, {
          name: '陈国安', gender: 'male', fatherId: 'p1', motherId: 'p2',
          birth: '1963', entryType: 'return',
          entryNote: '幼年因家贫出继邻县周姓人家，随养父姓周。2008年清明携妻儿回籍认亲，于祠堂补录名讳，复归陈姓。',
          bio: '陈国安，1963年生，幼年因家贫出继邻县周姓人家，随养父姓周，名周国安。\n\n成年后经族人辗转寻访，2008年清明节携妻儿回籍认亲，于祠堂补录名讳，复归陈姓，入谱归宗。\n\n现居县城，经营一家五金铺。'
        }),
        mk(10, {
          name: '陈志远', gender: 'male', fatherId: 'p3', motherId: 'p4', spouseIds: ['p11'],
          birth: '1982', entryType: 'birth',
          bio: '陈志远，1982年生。1999年考入省城建筑学校，后从事古建修缮，参与过数座祠堂与廊桥的修复工程。\n\n2019年主持重修本族祠堂的梁架与门楼。喜欢摄影，记录族中老人讲述的旧事，已整理口述资料二十余篇。'
        }),
        mk(11, {
          name: '周雯', gender: 'female', spouseIds: ['p10'], birth: '1984', entryType: 'birth',
          bio: '周雯，1984年生于省城。2008年与陈志远结婚，从事小学美术教学。'
        }),
        mk(12, {
          name: '陈志敏', gender: 'female', fatherId: 'p3', motherId: 'p4',
          birth: '1985', entryType: 'birth',
          bio: '陈志敏，1985年生。2007年毕业于省师范学院，现在市里一所中学教语文。'
        }),
        mk(13, {
          name: '陈志刚', gender: 'male', fatherId: 'p5', motherId: 'p6',
          birth: '1986', entryType: 'birth',
          bio: '陈志刚，1986年生。随父学建筑，2012年起接手乡建筑队的事务。'
        }),
        mk(14, {
          name: '张一诺', gender: 'female', fatherId: 'p8', motherId: 'p7',
          birth: '1990', entryType: 'birth',
          bio: '张一诺，1990年生，陈玉琴之女。2013年毕业于省城美术学院，现从事平面设计。'
        }),
        mk(15, {
          name: '陈嘉禾', gender: 'male', fatherId: 'p10', motherId: 'p11',
          birth: '2010', entryType: 'birth',
          bio: '陈嘉禾，2010年生。现在读中学，喜好航模与绘画。'
        }),
        mk(16, {
          name: '陈嘉宁', gender: 'female', fatherId: 'p10', motherId: 'p11',
          birth: '2014', entryType: 'birth',
          bio: '陈嘉宁，2014年生。性好动，喜舞蹈。'
        })
      ]
    };
  }

  /* -------------------- 读写存储 -------------------- */
  function snapshot() {
    return {
      familyName: state.familyTitle,
      members: state.members,
      logs: state.logs,
      trash: state.trash
    };
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot()));
    } catch (err) {
      toast('本地保存失败：空间不足，请压缩照片或先导出备份', 'error');
    }
    scheduleSync();
  }

  function normalizeMember(raw) {
    const m = raw && typeof raw === 'object' ? raw : {};
    const id = m.id || uid();
    let spouseIds = [];
    if (Array.isArray(m.spouseIds)) spouseIds = m.spouseIds.filter(x => typeof x === 'string' && x);
    else if (typeof m.spouseId === 'string' && m.spouseId) spouseIds = [m.spouseId];
    spouseIds = Array.from(new Set(spouseIds.filter(x => x && x !== id)));
    return {
      id: id,
      name: String(m.name || '未具名'),
      gender: m.gender === 'female' ? 'female' : 'male',
      fatherId: m.fatherId || null,
      motherId: m.motherId || null,
      spouseIds: spouseIds,
      birth: String(m.birth || ''),
      death: String(m.death || ''),
      deathCause: String(m.deathCause || ''),
      bio: String(m.bio || ''),
      photo: String(m.photo || ''),
      entryType: m.entryType || 'birth',
      entryNote: String(m.entryNote || ''),
      childKind: (m.childKind === 'adopted' || m.childKind === 'inherited') ? m.childKind : 'birth',
      spouseStatus: (m.spouseStatus && typeof m.spouseStatus === 'object') ? m.spouseStatus : {},
      singleParent: !!m.singleParent,
      lost: !!m.lost,
      createdAt: Number(m.createdAt) || Date.now()
    };
  }

  function applyPayload(data) {
    state.familyTitle = normalizeFamilyTitle(data.familyName);
    state.members = Array.isArray(data.members) ? data.members.map(normalizeMember) : [];
    state.logs = Array.isArray(data.logs)
      ? data.logs.filter(l => l && l.text).map(l => ({
        id: l.id || uid(),
        time: Number(l.time) || Date.now(),
        text: String(l.text)
      }))
      : [];
    state.trash = Array.isArray(data.trash)
      ? data.trash.filter(t => t && t.member).map(t => ({
        member: normalizeMember(t.member),
        deletedAt: Number(t.deletedAt) || Date.now(),
        links: Array.isArray(t.links) ? t.links : []
      }))
      : [];
    // 清理失效的关联，并保证配偶关系双向
    const ids = new Set(state.members.map(m => m.id));
    state.members.forEach(m => {
      if (m.fatherId && !ids.has(m.fatherId)) m.fatherId = null;
      if (m.motherId && !ids.has(m.motherId)) m.motherId = null;
      m.spouseIds = m.spouseIds.filter(id => ids.has(id) && id !== m.id);
      m.spouseStatus = Object.assign({}, m.spouseStatus || {});
      Object.keys(m.spouseStatus).forEach(k => {
        if (m.spouseIds.indexOf(k) === -1) delete m.spouseStatus[k];
      });
    });
    state.members.forEach(m => {
      m.spouseIds.forEach(id => {
        const s = memberById(id);
        if (s && s.spouseIds.indexOf(m.id) === -1) s.spouseIds.push(m.id);
      });
    });
  }

  function load() {
    let data = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) data = JSON.parse(raw);
    } catch (err) {
      data = null;
    }
    if (!data || !Array.isArray(data.members)) {
      data = seedData();
    }
    applyPayload(data);
    save();
  }

  /* -------------------- 后端登录与同步 -------------------- */
  const TOKEN_KEY = 'siren-auth-token';
  let authToken = '';
  let syncTimer = null;
  let syncing = false;
  let syncPending = false;

  async function api(path, options) {
    const opts = Object.assign({ method: 'GET' }, options || {});
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (authToken) opts.headers.Authorization = 'Bearer ' + authToken;
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    const res = await fetch(path, opts);
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }
    if (!res.ok) {
      const error = new Error((data && data.error) || ('请求失败（' + res.status + '）'));
      error.status = res.status;
      throw error;
    }
    return data;
  }

  function showLogin(message) {
    state.authed = false;
    document.body.classList.remove('authed');
    document.body.classList.add('locked');
    const screen = $('#loginScreen');
    screen.hidden = false;
    $('#loginError').textContent = message || '';
    const input = $('#loginForm [name="username"]');
    if (input) setTimeout(() => input.focus(), 120);
  }

  function hideLogin() {
    $('#loginScreen').hidden = true;
    document.body.classList.remove('locked');
    document.body.classList.add('authed');
  }

  function forceLogout(message) {
    authToken = '';
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    state.authed = false;
    closeDrawer();
    showLogin(message || '请先登录');
  }

  async function startSession() {
    try {
      const res = await api('/api/data');
      state.authed = true;
      if (res && res.data) {
        applyPayload(res.data);
        state.selectedId = null;
        state.lastLayoutWidth = 0;
        closeDrawer();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot()));
      } else {
        // 首次使用：把浏览器中已有的族谱写入数据库
        await api('/api/data', { method: 'PUT', body: { data: snapshot() } });
      }
      hideLogin();
      refresh();
      requestAnimationFrame(() => fitTree(0.62));
    } catch (err) {
      if (err.status === 401) {
        forceLogout('登录已过期，请重新登录');
      } else {
        showLogin('无法连接后端服务，请先启动 server.py');
      }
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const username = String(fd.get('username') || '').trim();
    const password = String(fd.get('password') || '');
    const errorEl = $('#loginError');
    const btn = $('#loginSubmit');
    errorEl.textContent = '';
    if (!username || !password) {
      errorEl.textContent = '请输入账号和密码';
      return;
    }
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const res = await api('/api/login', { method: 'POST', body: { username: username, password: password } });
      authToken = res.token;
      sessionStorage.setItem(TOKEN_KEY, authToken);
      await startSession();
      form.reset();
    } catch (err) {
      errorEl.textContent = err.message || '登录失败';
    } finally {
      btn.disabled = false;
      btn.textContent = '登 录';
    }
  }

  async function logout() {
    try {
      await api('/api/logout', { method: 'POST' });
    } catch (err) {
      /* 忽略退出请求失败 */
    }
    forceLogout('已退出登录');
  }

  function scheduleSync() {
    if (!state.authed) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(pushData, 500);
  }

  async function pushData() {
    if (!state.authed) return;
    if (syncing) {
      syncPending = true;
      return;
    }
    syncing = true;
    try {
      await api('/api/data', { method: 'PUT', body: { data: snapshot() } });
    } catch (err) {
      if (err.status === 401) forceLogout('登录已过期，请重新登录');
      else toast('保存到服务器失败：' + err.message, 'error');
    } finally {
      syncing = false;
      if (syncPending) {
        syncPending = false;
        pushData();
      }
    }
  }

  /* -------------------- 操作日志 -------------------- */
  function addLog(text) {
    state.logs.unshift({
      id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      time: Date.now(),
      text: String(text)
    });
    if (state.logs.length > 400) state.logs = state.logs.slice(0, 400);
  }

  function formatTime(ts) {
    const d = new Date(Number(ts) || Date.now());
    const pad = n => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* -------------------- 世代计算 -------------------- */
  function computeGens() {
    gens = new Map(state.members.map(m => [m.id, 0]));
    for (let round = 0; round < 8; round++) {
      let changed = false;
      state.members.forEach(m => {
        const f = memberById(m.fatherId);
        const mo = memberById(m.motherId);
        let lv = 0;
        if (f) lv = Math.max(lv, (gens.get(f.id) || 0) + 1);
        if (mo) lv = Math.max(lv, (gens.get(mo.id) || 0) + 1);
        if (!f && !mo && m.spouseIds.length) {
          m.spouseIds.forEach(sid => {
            const s = memberById(sid);
            if (s) lv = Math.max(lv, gens.get(s.id) || 0);
          });
        }
        if (lv !== gens.get(m.id)) {
          gens.set(m.id, lv);
          changed = true;
        }
      });
      if (!changed) break;
    }
  }

  /* -------------------- 布局计算 -------------------- */
  function decidePrimary(a, b) {
    const aHas = !!(a.fatherId || a.motherId);
    const bHas = !!(b.fatherId || b.motherId);
    if (aHas !== bHas) return aHas ? a : b;
    if (a.gender !== b.gender) return a.gender === 'male' ? a : b;
    return String(a.createdAt) <= String(b.createdAt) ? a : b;
  }

  function buildLayout() {
    const map = new Map(state.members.map(m => [m.id, m]));
    const attached = new Set();
    const primaryOf = new Map();
    const seenPairs = new Set();

    state.members.forEach(m => {
      (m.spouseIds || []).forEach(sid => {
        const s = map.get(sid);
        if (!s || s.id === m.id) return;
        const key = [m.id, s.id].sort().join('|');
        if (seenPairs.has(key)) return;
        seenPairs.add(key);
        const p = decidePrimary(m, s);
        const other = p === m ? s : m;
        attached.add(other.id);
        primaryOf.set(other.id, p.id);
        primaryOf.set(p.id, p.id);
      });
    });

    const units = new Map();
    state.members.forEach(m => {
      if (attached.has(m.id)) return;
      units.set(m.id, {
        id: m.id,
        primary: m,
        persons: [m],
        children: []
      });
    });

    const spousesByPrimary = new Map();
    state.members.forEach(m => {
      if (!attached.has(m.id)) return;
      const pid = primaryOf.get(m.id);
      if (!units.has(pid)) return;
      if (!spousesByPrimary.has(pid)) spousesByPrimary.set(pid, []);
      spousesByPrimary.get(pid).push(m);
    });

    units.forEach(u => {
      const list = (spousesByPrimary.get(u.id) || []).slice();
      const order = u.primary.spouseIds || [];
      list.sort((a, b) => {
        const ia = order.indexOf(a.id);
        const ib = order.indexOf(b.id);
        if (ia !== ib) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
        return a.createdAt - b.createdAt;
      });
      // 元配在右、继室在左，左右交替，保证婚配线相邻
      const right = list.filter((_, i) => i % 2 === 0);
      const left = list.filter((_, i) => i % 2 === 1).reverse();
      u.persons = left.concat([u.primary], right);
    });

    const unitIdOf = id => {
      if (attached.has(id)) return primaryOf.get(id) || null;
      return units.has(id) ? id : null;
    };

    state.members.forEach(c => {
      const cUnitId = unitIdOf(c.id);
      if (!cUnitId) return;
      const father = memberById(c.fatherId);
      const mother = memberById(c.motherId);
      const parent = father || mother;
      if (!parent) return;
      const pUnitId = unitIdOf(parent.id);
      if (!pUnitId || pUnitId === cUnitId) return;
      const pu = units.get(pUnitId);
      if (!pu) return;
      if (pu.children.some(x => x.unitId === cUnitId)) return;
      pu.children.push({ unitId: cUnitId, childId: c.id });
    });

    const childUnitIds = new Set();
    units.forEach(u => u.children.forEach(ch => childUnitIds.add(ch.unitId)));

    units.forEach(u => {
      u.children.sort((x, y) => {
        const a = memberById(x.childId);
        const b = memberById(y.childId);
        return birthYear(a) - birthYear(b) || String(a.name).localeCompare(String(b.name), 'zh');
      });
    });

    const roots = Array.from(units.keys())
      .filter(id => !childUnitIds.has(id))
      .sort((a, b) => birthYear(units.get(a).primary) - birthYear(units.get(b).primary));

    // 若存在循环导致没有根，兜底加入全部
    const rootList = roots.length ? roots : Array.from(units.keys());

    const unitWidth = u => u.persons.length * CARD_W + (u.persons.length - 1) * SPOUSE_GAP;
    const widths = new Map();

    function measure(uid, stack) {
      if (widths.has(uid)) return widths.get(uid);
      const u = units.get(uid);
      if (!u) return 0;
      if (stack.has(uid)) return unitWidth(u);
      stack.add(uid);
      let total = 0;
      u.children.forEach((ch, i) => {
        total += measure(ch.unitId, stack) + (i ? SIB_GAP : 0);
      });
      stack.delete(uid);
      const w = Math.max(unitWidth(u), total);
      widths.set(uid, w);
      return w;
    }

    rootList.forEach(id => measure(id, new Set()));

    const nodes = new Map();
    const cards = [];
    const placed = new Set();
    let maxDepth = 0;
    const topPad = 30;

    function place(uid, left, depth) {
      if (placed.has(uid)) return;
      placed.add(uid);
      const u = units.get(uid);
      const w = widths.get(uid) || unitWidth(u);
      const ownW = unitWidth(u);
      let childTotal = 0;
      u.children.forEach((ch, i) => {
        childTotal += (widths.get(ch.unitId) || 0) + (i ? SIB_GAP : 0);
      });
      let cursor = left + (w - childTotal) / 2;
      u.children.forEach(ch => {
        place(ch.unitId, cursor, depth + 1);
        cursor += (widths.get(ch.unitId) || 0) + SIB_GAP;
      });
      const x = left + (w - ownW) / 2;
      const y = topPad + depth * (CARD_H + LEVEL_GAP);
      nodes.set(uid, { x, y, w: ownW, unit: u, depth });
      u.persons.forEach((p, i) => {
        cards.push({
          person: p,
          x: x + i * (CARD_W + SPOUSE_GAP),
          y,
          unitId: uid
        });
      });
      maxDepth = Math.max(maxDepth, depth);
    }

    let cursorX = 40;
    rootList.forEach(id => {
      place(id, cursorX, 0);
      cursorX += (widths.get(id) || 0) + ROOT_GAP;
    });

    const width = Math.max(cursorX - ROOT_GAP + 40, 400);
    const height = topPad + maxDepth * (CARD_H + LEVEL_GAP) + CARD_H + 60;

    // 婚配连线（按实际配偶关系，不按相邻顺序）
    const marriages = [];
    units.forEach(u => {
      for (let i = 0; i < u.persons.length; i++) {
        for (let j = i + 1; j < u.persons.length; j++) {
          const pa = u.persons[i];
          const pb = u.persons[j];
          if (pa.spouseIds.indexOf(pb.id) === -1) continue;
          const a = cards.find(c => c.person.id === pa.id);
          const b = cards.find(c => c.person.id === pb.id);
          if (!a || !b) continue;
          const left = a.x <= b.x ? a : b;
          const right = a.x <= b.x ? b : a;
          marriages.push({
            x1: left.x + CARD_W,
            x2: right.x,
            y: left.y + CARD_H / 2
          });
        }
      }
    });

    // 亲子连线
    const links = [];
    units.forEach(u => {
      const node = nodes.get(u.id);
      if (!node) return;
      const primaryCard = cards.find(c => c.person.id === u.primary.id);
      if (!primaryCard) return;
      u.children.forEach(ch => {
        const childCard = cards.find(c => c.person.id === ch.childId);
        if (!childCard) return;
        if (childCard.y <= primaryCard.y) return;
        links.push({
          x: primaryCard.x + CARD_W / 2,
          y1: primaryCard.y + CARD_H,
          busY: primaryCard.y + CARD_H + LEVEL_GAP / 2,
          cx: childCard.x + CARD_W / 2,
          y2: childCard.y
        });
      });
    });

    return { width, height, cards, nodes, marriages, links, rootCount: rootList.length };
  }

  /* -------------------- 渲染：关系图 -------------------- */
  function renderTree() {
    const layout = buildLayout();
    state.layout = layout;

    const canvas = $('#treeCanvas');
    const svg = $('#treeLinks');
    const nodes = $('#treeNodes');

    canvas.style.width = layout.width + 'px';
    canvas.style.height = layout.height + 'px';
    svg.setAttribute('width', layout.width);
    svg.setAttribute('height', layout.height);

    if (!state.members.length) {
      svg.innerHTML = '';
      nodes.innerHTML = '<div class="tree-empty"><strong>谱系尚空</strong><span>点击右上角「添丁」录入第一位族人</span></div>';
      return;
    }

    let marks = '';
    layout.marriages.forEach(l => {
      const mid = (l.x1 + l.x2) / 2;
      const midY = l.y;
      marks += '<line x1="' + l.x1 + '" y1="' + l.y + '" x2="' + l.x2 + '" y2="' + l.y +
        '" stroke="#c9b8a4" stroke-width="1.6"/>';
      marks += '<circle cx="' + mid + '" cy="' + midY + '" r="2.6" fill="#bda894"/>';
    });
    layout.links.forEach(l => {
      marks += '<path d="M' + l.x + ' ' + l.y1 + ' V' + l.busY + ' H' + l.cx + ' V' + l.y2 +
        '" fill="none" stroke="#cab9a5" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
    });
    svg.innerHTML = marks;

    const q = state.query.toLowerCase();
    nodes.innerHTML = layout.cards.map(c => {
      const p = c.person;
      const isReturn = p.entryType === 'return';
      const cardTags = [];
      if (isReturn) cardTags.push('归宗');
      if (p.lost) cardTags.push('失考');
      if (p.childKind === 'adopted') cardTags.push('收养');
      if (p.childKind === 'inherited') cardTags.push('过继');
      if (p.singleParent) cardTags.push('单亲');
      const hit = q && matchMember(p, q);
      const cls = ['p-card', p.gender];
      if (cardTags.length) cls.push('has-tag');
      if (p.id === state.selectedId) cls.push('selected');
      if (hit) cls.push('hit');
      return '<div class="' + cls.join(' ') + '" data-id="' + p.id + '"' +
        ' style="left:' + c.x + 'px;top:' + c.y + 'px;width:' + CARD_W + 'px;height:' + CARD_H + 'px"' +
        ' title="' + esc(p.name + ' · ' + lifeSpan(p)) + '">' +
        '<span class="p-name">' + esc(p.name) + '</span>' +
        '<span class="p-sub"><i class="gdot"></i>' + (p.gender === 'male' ? '男' : '女') + ' · ' + genLabel(p) + '</span>' +
        '<span class="p-date">' + esc(lifeSpan(p)) + '</span>' +
        (cardTags.length ? '<span class="p-tags">' +
          cardTags.map(t => '<i class="' + (t === '归宗' ? '' : 'kind') + '">' + t + '</i>').join('') +
          '</span>' : '') +
        '</div>';
    }).join('');

    if (layout.width !== state.lastLayoutWidth) {
      state.lastLayoutWidth = layout.width;
      requestAnimationFrame(() => fitTree(0.62));
    } else {
      applyZoom();
    }
  }

  function applyZoom() {
    const z = state.zoom;
    $('#treeCanvas').style.transform =
      'translate(' + z.x + 'px,' + z.y + 'px) scale(' + z.scale + ')';
    $('#zoomLabel').textContent = Math.round(z.scale * 100) + '%';
  }

  function fitTree(minScale) {
    const vp = $('#treeViewport');
    const layout = state.layout;
    if (!layout || !vp.clientWidth || !vp.clientHeight) return;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    const fit = Math.min(
      (vw - 80) / layout.width,
      (vh - 80) / layout.height
    );
    const scale = Math.min(1.15, Math.max(minScale == null ? 0.28 : minScale, fit));
    state.zoom = {
      scale: scale,
      x: (vw - layout.width * scale) / 2,
      y: Math.max(16, (vh - layout.height * scale) / 2)
    };
    applyZoom();
  }

  /* -------------------- 渲染：名录 / 统计 -------------------- */
  function matchMember(p, q) {
    return (p.name || '').toLowerCase().indexOf(q) > -1 ||
      (p.birth || '').indexOf(q) > -1 ||
      (p.bio || '').toLowerCase().indexOf(q) > -1;
  }

  function filteredMembers() {
    const q = state.query.toLowerCase();
    let list = state.members.slice();
    if (state.genderFilter !== 'all') {
      list = list.filter(m => m.gender === state.genderFilter);
    }
    if (state.genFilter !== 'all') {
      list = list.filter(m => String(gens.get(m.id)) === String(state.genFilter));
    }
    if (q) list = list.filter(m => matchMember(m, q));

    list.sort((a, b) => {
      if (state.sortBy === 'name') return String(a.name).localeCompare(String(b.name), 'zh');
      if (state.sortBy === 'birth') return birthYear(a) - birthYear(b);
      return (gens.get(a.id) - gens.get(b.id)) || (birthYear(a) - birthYear(b)) ||
        String(a.name).localeCompare(String(b.name), 'zh');
    });
    return list;
  }

  function renderList() {
    const grid = $('#memberGrid');
    const list = filteredMembers();
    if (!list.length) {
      grid.innerHTML = '<div class="list-empty">没有符合条件的族人</div>';
      return;
    }
    grid.innerHTML = list.map(m => {
      const f = memberById(m.fatherId);
      const mo = memberById(m.motherId);
      const sps = (m.spouseIds || []).map(memberById).filter(Boolean);
      const rel = [
        f ? '父 ' + f.name : '',
        mo ? '母 ' + mo.name : ''
      ].filter(Boolean).join(' · ') || (sps.length ? '配偶 ' + sps.map(s => s.name).join('、') : '始迁祖');
      return '<article class="member-card" data-id="' + m.id + '">' +
        avatarHtml(m) +
        '<div class="mc-main">' +
        '<div class="mc-top"><h3>' + esc(m.name) + '</h3>' +
        '<span class="chip ' + m.gender + '">' + (m.gender === 'male' ? '男' : '女') + '</span>' +
        (m.entryType === 'return' ? '<span class="chip return">归宗</span>' : '') +
        (m.lost ? '<span class="chip lost">失考</span>' : '') +
        (m.childKind === 'adopted' ? '<span class="chip kind">收养</span>' : '') +
        (m.childKind === 'inherited' ? '<span class="chip kind">过继</span>' : '') +
        (m.singleParent ? '<span class="chip kind">单亲</span>' : '') +
        '</div>' +
        '<p class="mc-meta">' + genLabel(m) + ' · ' + esc(lifeSpan(m)) + '</p>' +
        '<p class="mc-rel">' + esc(rel) + ' · 子女 ' + childrenOf(m.id).length + ' 人</p>' +
        '</div></article>';
    }).join('');
  }

  function renderStats() {
    const total = state.members.length;
    const male = state.members.filter(m => m.gender === 'male').length;
    const female = total - male;
    const generations = gens.size ? Math.max.apply(null, Array.from(gens.values())) + 1 : 0;
    const returned = state.members.filter(m => m.entryType === 'return').length;
    const alive = state.members.filter(m => !m.death).length;
    $('#stats').innerHTML =
      '<div class="stat"><b>' + total + '</b>在册族人</div>' +
      '<div class="stat"><b>' + male + '</b>男丁</div>' +
      '<div class="stat"><b>' + female + '</b>女眷</div>' +
      '<div class="stat"><b>' + generations + '</b>传世</div>' +
      '<div class="stat"><b>' + alive + '</b>在世</div>' +
      '<div class="stat hl"><b>' + returned + '</b>归宗</div>' +
      '<div class="stats-actions">' +
      '<button type="button" class="stats-btn" id="btnLog">操作日志</button>' +
      '<button type="button" class="stats-btn" id="btnBin">回收站' +
      (state.trash.length ? ' <b>' + state.trash.length + '</b>' : '') + '</button>' +
      '<button type="button" class="stats-btn" id="btnLogout">退出</button>' +
      '</div>';
  }

  function renderGenOptions() {
    const sel = $('#genFilter');
    const current = state.genFilter;
    const levels = Array.from(new Set(Array.from(gens.values()))).sort((a, b) => a - b);
    sel.innerHTML = '<option value="all">全部世代</option>' + levels.map(lv =>
      '<option value="' + lv + '">' + (CN_NUM[lv + 1] || (lv + 1)) + '世</option>'
    ).join('');
    sel.value = levels.some(lv => String(lv) === String(current)) ? current : 'all';
    if (sel.value === 'all') state.genFilter = 'all';
  }

  /* 兼容旧数据：旧版本只保存姓氏，新版本保存完整谱名 */
  function normalizeFamilyTitle(raw) {
    const s = String(raw || '').trim();
    if (!s) return '陈氏宗谱';
    if (s.length <= 3 && !/[谱宗族志氏堂]/.test(s)) return s + '氏宗谱';
    return s;
  }

  function renderTitle() {
    const name = state.familyTitle || '家族宗谱';
    $('#familyTitle').textContent = name;
    document.title = name + ' · 佳兴族谱';
  }

  /* -------------------- 人物档案抽屉 -------------------- */
  function openDrawer(id) {
    state.selectedId = id;
    state.editing = false;
    state.pendingPhoto = null;
    renderDrawer();
    $('#drawer').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $$('.p-card').forEach(el => el.classList.toggle('selected', el.dataset.id === id));
  }

  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    state.selectedId = null;
    state.editing = false;
    $$('.p-card.selected').forEach(el => el.classList.remove('selected'));
  }

  function factsHtml(m) {
    const f = memberById(m.fatherId);
    const mo = memberById(m.motherId);
    const sps = (m.spouseIds || []).map(memberById).filter(Boolean);
    const kids = childrenOf(m.id);
    const age = calcAge(m);
    const link = p => '<button type="button" class="name-link" data-open="' + p.id + '">' + esc(p.name) + '</button>';
    const spouseLink = p => {
      const st = m.spouseStatus && m.spouseStatus[p.id];
      const suffix = st && st !== 'married' ? '（' + spouseStatusText(st) + '）' : '';
      return link(p) + (suffix ? '<em class="fact-suffix">' + suffix + '</em>' : '');
    };
    const fact = (label, html, dim) =>
      '<div class="fact"><span>' + label + '</span><strong class="' + (dim ? 'dim' : '') + '">' + html + '</strong></div>';
    const personFlags = [];
    if (m.lost) personFlags.push('失考');
    if (m.singleParent) personFlags.push('单亲');

    return '<div class="facts">' +
      fact('出生时间', esc(m.birth || '未详'), !m.birth) +
      fact('逝世时间', esc(m.death || '在世 / 未详'), !m.death) +
      fact('享年', esc(age || '—'), !age) +
      fact('死亡病因', esc(m.deathCause || (m.death ? '未载' : '—')), !m.deathCause) +
      fact('父亲', f ? link(f) : '—', !f) +
      fact('母亲', mo ? link(mo) : '—', !mo) +
      fact('配偶', sps.length ? sps.map(spouseLink).join('、') : '—', !sps.length) +
      fact('子女', kids.length ? kids.map(link).join('、') : '—', !kids.length) +
      fact('与父母关系', childKindText(m.childKind), m.childKind === 'birth') +
      (personFlags.length ? fact('人物状态', personFlags.join('、')) : '') +
      '</div>';
  }

  function entryTypeText(t) {
    if (t === 'return') return '归宗入谱';
    if (t === 'root') return '始迁祖';
    return '添丁入谱';
  }

  function renderDrawer() {
    const m = memberById(state.selectedId);
    if (!m) {
      closeDrawer();
      return;
    }
    const drawer = $('#drawer');
    if (state.editing) {
      drawer.innerHTML = editTemplate(m);
      bindEditEvents(m);
    } else {
      drawer.innerHTML = viewTemplate(m);
      bindViewEvents(m);
    }
  }

  function viewTemplate(m) {
    const kids = childrenOf(m.id);
    const tags = [
      '<span class="chip ' + m.gender + '">' + (m.gender === 'male' ? '男' : '女') + '</span>',
      '<span class="chip ' + m.gender + '">' + genLabel(m) + '</span>'
    ];
    if (m.entryType === 'return') tags.push('<span class="chip return">归宗</span>');
    if (m.lost) tags.push('<span class="chip lost">失考</span>');
    if (m.childKind === 'adopted') tags.push('<span class="chip kind">收养</span>');
    if (m.childKind === 'inherited') tags.push('<span class="chip kind">过继</span>');
    if (m.singleParent) tags.push('<span class="chip kind">单亲</span>');

    return '<div class="drawer-head">' +
      '<button class="icon-btn" id="drawerClose" aria-label="关闭">×</button>' +
      '<div class="profile">' +
      (m.photo
        ? '<div class="profile-photo" data-photo-view="1" role="button" tabindex="0" title="点击查看大图">' + avatarHtml(m) + '</div>'
        : avatarHtml(m)) +
      '<div class="profile-main"><h2>' + esc(m.name) + '</h2>' +
      '<p class="profile-sub">' + esc(relationLine(m)) + '</p>' +
      '<div class="profile-tags">' + tags.join('') + '</div>' +
      '</div></div></div>' +
      '<div class="drawer-body">' +
      '<h3 class="section-title">人物档案</h3>' + factsHtml(m) +
      '<h3 class="section-title">人物经历</h3>' +
      (m.bio
        ? '<div class="bio-block">' + esc(m.bio) + '</div>'
        : '<div class="bio-block empty">暂无记述，点击「编辑档案」补充出生卒葬、生平经历、照片等资料。</div>') +
      (m.entryNote
        ? '<h3 class="section-title">入谱说明</h3><div class="bio-block">' + esc(m.entryNote) + '</div>'
        : '') +
      '<h3 class="section-title">谱系</h3>' +
      '<div class="facts">' +
      '<div class="fact"><span>入谱方式</span><strong>' + entryTypeText(m.entryType) + '</strong></div>' +
      '<div class="fact"><span>子女</span><strong class="' + (kids.length ? '' : 'dim') + '">' +
      (kids.length ? esc(kids.map(k => k.name).join('、')) : '无记载') + '</strong></div>' +
      '</div></div>' +
      '<div class="drawer-foot">' +
      '<button class="btn primary" id="btnEdit">编辑档案</button>' +
      '<button class="btn secondary" id="btnAddKin">添加亲属</button>' +
      '<button class="btn secondary" id="btnAddChild">为其添丁</button>' +
      '<button class="btn danger" id="btnDelete" title="移入回收站">删除</button>' +
      '</div>';
  }

  function bindViewEvents(m) {
    $('#drawerClose').addEventListener('click', closeDrawer);
    const photoBox = $('[data-photo-view]');
    if (photoBox) {
      const open = () => openPhotoViewer(m.photo, m.name);
      photoBox.addEventListener('click', open);
      photoBox.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    }
    $('#btnEdit').addEventListener('click', () => {
      state.editing = true;
      state.pendingPhoto = null;
      renderDrawer();
    });
    $('#btnAddKin').addEventListener('click', () => openKinModal(m.id));
    $('#btnAddChild').addEventListener('click', () => {
      const prefill = { fatherId: '', motherId: '' };
      const sps = (m.spouseIds || []).map(memberById).filter(Boolean);
      const femaleSpouses = sps.filter(s => s.gender === 'female');
      const maleSpouses = sps.filter(s => s.gender === 'male');
      if (m.gender === 'male') {
        prefill.fatherId = m.id;
        // 有多位配偶时不预选生母，避免认错
        if (femaleSpouses.length === 1) prefill.motherId = femaleSpouses[0].id;
      } else {
        prefill.motherId = m.id;
        if (maleSpouses.length === 1) prefill.fatherId = maleSpouses[0].id;
      }
      openMemberModal('birth', prefill);
    });
    $('#btnDelete').addEventListener('click', () => moveToTrash(m));
  }

  function parentOptions(gender, selectedId, selfId) {
    return state.members
      .filter(x => x.gender === gender && x.id !== selfId)
      .sort((a, b) => (gens.get(a.id) - gens.get(b.id)) || (birthYear(a) - birthYear(b)))
      .map(x => '<option value="' + x.id + '"' + (x.id === selectedId ? ' selected' : '') + '>' +
        esc(x.name) + '（' + genLabel(x) + '）</option>')
      .join('');
  }

  function spouseStatusOptions(cur) {
    return [['married', '在婚'], ['divorced', '离异'], ['widowed', '丧偶'], ['remarried', '再婚']]
      .map(o => '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '') + '>' + o[1] + '</option>')
      .join('');
  }

  function editTemplate(m) {
    const photo = state.pendingPhoto !== null ? state.pendingPhoto : m.photo;
    const preview = Object.assign({}, m, { photo: photo });
    const spouses = state.members.filter(x => x.id !== m.id);
    return '<div class="drawer-head">' +
      '<button class="icon-btn" id="drawerClose" aria-label="关闭">×</button>' +
      '<div class="profile" style="align-items:flex-start">' +
      '<div class="profile-main"><h2 style="font-size:19px">编辑档案</h2>' +
      '<p class="profile-sub">' + esc(m.name) + ' · ' + genLabel(m) + '</p></div></div></div>' +
      '<div class="drawer-body">' +
      '<div class="edit-photo">' +
      '<div id="photoPreview">' + avatarHtml(preview) + '</div>' +
      '<div class="photo-actions">' +
      '<button type="button" class="btn ghost" id="btnPickPhoto">上传照片</button>' +
      (photo ? '<button type="button" class="btn ghost" id="btnRemovePhoto">移除照片</button>' : '') +
      '</div></div>' +
      '<input type="file" id="photoInput" accept="image/*" hidden>' +
      '<form id="editForm">' +
      '<div class="form-grid">' +
      '<label class="field"><span>姓名</span><input name="name" value="' + esc(m.name) + '" maxlength="24"></label>' +
      '<label class="field"><span>性别</span><select name="gender">' +
      '<option value="male"' + (m.gender === 'male' ? ' selected' : '') + '>男</option>' +
      '<option value="female"' + (m.gender === 'female' ? ' selected' : '') + '>女</option>' +
      '</select></label>' +
      '<label class="field"><span>出生时间</span><input name="birth" value="' + esc(m.birth) + '" placeholder="如 1928 或 1928-03-12"></label>' +
      '<label class="field"><span>死亡时间</span><input name="death" value="' + esc(m.death) + '" placeholder="健在可留空"></label>' +
      '<label class="field"><span>死亡病因</span><input name="deathCause" value="' + esc(m.deathCause) + '" placeholder="如 肺心病"></label>' +
      '<div class="field block"><span>配偶</span>' +
      '<div class="spouse-editor" id="spouseEditor"></div></div>' +
      '<label class="field"><span>父亲</span><select name="fatherId"><option value="">（无）</option>' +
      parentOptions('male', m.fatherId, m.id) + '</select></label>' +
      '<label class="field"><span>母亲</span><select name="motherId"><option value="">（无）</option>' +
      parentOptions('female', m.motherId, m.id) + '</select></label>' +
      '<label class="field"><span>入谱方式</span><select name="entryType">' +
      '<option value="birth"' + (m.entryType === 'birth' ? ' selected' : '') + '>添丁入谱</option>' +
      '<option value="return"' + (m.entryType === 'return' ? ' selected' : '') + '>归宗入谱</option>' +
      '<option value="root"' + (m.entryType === 'root' ? ' selected' : '') + '>始迁祖</option>' +
      '</select></label>' +
      '<label class="field"><span>与父母关系</span><select name="childKind">' +
      '<option value="birth"' + (m.childKind === 'birth' ? ' selected' : '') + '>亲生</option>' +
      '<option value="adopted"' + (m.childKind === 'adopted' ? ' selected' : '') + '>收养</option>' +
      '<option value="inherited"' + (m.childKind === 'inherited' ? ' selected' : '') + '>过继</option>' +
      '</select></label>' +
      '<div class="field"><span>人物状态</span><div class="status-row">' +
      '<label><input type="checkbox" name="lost"' + (m.lost ? ' checked' : '') + '><i>失考</i></label>' +
      '<label><input type="checkbox" name="singleParent"' + (m.singleParent ? ' checked' : '') + '><i>单亲</i></label>' +
      '</div></div>' +
      '<label class="field block"><span>入谱说明 <em>归宗缘由、补录情况等</em></span>' +
      '<textarea name="entryNote" rows="2" placeholder="如：幼年出继外姓，2008年清明携眷归宗">' + esc(m.entryNote) + '</textarea></label>' +
      '<label class="field block"><span>人物经历 <em>长文自由编辑，仅档案内可见</em></span>' +
      '<textarea name="bio" rows="9" placeholder="生卒、居所、职业、事迹、口述回忆……">' + esc(m.bio) + '</textarea></label>' +
      '</div>' +
      '<div class="drawer-actions">' +
      '<button type="submit" class="btn primary">保存档案</button>' +
      '<button type="button" class="btn ghost" id="btnCancelEdit">取消</button>' +
      '</div></form></div>';
  }

  function bindEditEvents(m) {
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#btnCancelEdit').addEventListener('click', () => {
      state.editing = false;
      state.pendingPhoto = null;
      renderDrawer();
    });
    $('#btnPickPhoto').addEventListener('click', () => $('#photoInput').click());

    let editSpouses = m.spouseIds.filter(id => memberById(id));
    const editStatus = Object.assign({}, m.spouseStatus || {});
    function renderSpouseEditor() {
      const box = $('#spouseEditor');
      if (!box) return;
      box.innerHTML = editSpouses.length ? editSpouses.map(id => {
        const p = memberById(id);
        if (!p) return '';
        return '<div class="spouse-line"><span class="sp-name">' + esc(p.name) +
          ' <em>' + (p.gender === 'male' ? '男' : '女') + '·' + genLabel(p) + '</em></span>' +
          '<select data-spouse-status="' + id + '">' + spouseStatusOptions(editStatus[id] || 'married') + '</select>' +
          '<button type="button" class="mini-del" data-remove-spouse="' + id + '">移除</button></div>';
      }).join('') : '<span class="picker-empty">暂无配偶，可通过档案下方「添加亲属 → 配偶」新增</span>';
    }
    $('#spouseEditor').addEventListener('change', e => {
      const sel = e.target.closest('select[data-spouse-status]');
      if (sel) editStatus[sel.dataset.spouseStatus] = sel.value;
    });
    $('#spouseEditor').addEventListener('click', e => {
      const btn = e.target.closest('[data-remove-spouse]');
      if (!btn) return;
      editSpouses = editSpouses.filter(id => id !== btn.dataset.removeSpouse);
      renderSpouseEditor();
    });
    renderSpouseEditor();
    $('#photoInput').addEventListener('change', e => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      openCropper(file, dataUrl => {
        state.pendingPhoto = dataUrl;
        $('#photoPreview').innerHTML = avatarHtml({ name: m.name, gender: m.gender, photo: dataUrl });
        const removeBtn = $('#btnRemovePhoto');
        if (!removeBtn) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'btn ghost';
          b.id = 'btnRemovePhoto';
          b.textContent = '移除照片';
          $('.photo-actions').appendChild(b);
          bindRemovePhoto();
        }
      });
    });
    function bindRemovePhoto() {
      const btn = $('#btnRemovePhoto');
      if (!btn) return;
      btn.onclick = () => {
        state.pendingPhoto = '';
        $('#photoPreview').innerHTML = avatarHtml({ name: m.name, gender: m.gender, photo: '' });
        btn.remove();
      };
    }
    bindRemovePhoto();

    $('#editForm').addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const name = String(fd.get('name') || '').trim();
      if (!name) {
        toast('请填写姓名', 'error');
        return;
      }
      const before = {
        name: m.name, gender: m.gender, birth: m.birth, death: m.death,
        deathCause: m.deathCause, bio: m.bio, entryType: m.entryType,
        entryNote: m.entryNote, fatherId: m.fatherId, motherId: m.motherId,
        spouseKey: m.spouseIds.slice().sort().join('|'), photo: m.photo,
        childKind: m.childKind, lost: m.lost, singleParent: m.singleParent
      };
      // ---- 录入校验：日期、父母关系、配偶 ----
      const nextName = name;
      const nextBirth = String(fd.get('birth') || '').trim();
      const nextDeath = String(fd.get('death') || '').trim();
      const nextFatherId = String(fd.get('fatherId') || '') || null;
      const nextMotherId = String(fd.get('motherId') || '') || null;
      const issue = dateIssue(nextBirth, nextDeath);
      if (issue) {
        toast(issue, 'error');
        return;
      }
      const dup = findDuplicateMember(nextName, nextBirth, m.id, null);
      if (dup) {
        toast('谱中已有同名同生年成员「' + dup.name + '」，请勿重复创建', 'error');
        return;
      }      if (nextFatherId === nextMotherId && nextFatherId) {
        toast('父亲和母亲不能是同一个人', 'error');
        return;
      }
      if (nextFatherId) {
        if (wouldCreateCycle(m.id, nextFatherId)) {
          toast('不能把「' + memberById(nextFatherId).name + '」设为父亲：他属于该人物的后代', 'error');
          return;
        }
        const f = memberById(nextFatherId);
        if (f && f.gender !== 'male') {
          toast('父亲必须是男性', 'error');
          return;
        }
        const pi = f && parentBirthIssue(f, nextBirth);
        if (pi) {
          if (pi.level === 'error') { toast(pi.msg, 'error'); return; }
          if (!confirm(pi.msg)) return;
        }
        const pd = f && parentDeathIssue(f, nextBirth);
        if (pd && !confirm(pd.msg)) return;
      }
      if (nextMotherId) {
        if (wouldCreateCycle(m.id, nextMotherId)) {
          toast('不能把「' + memberById(nextMotherId).name + '」设为母亲：她属于该人物的后代', 'error');
          return;
        }
        const mo2 = memberById(nextMotherId);
        if (mo2 && mo2.gender !== 'female') {
          toast('母亲必须是女性', 'error');
          return;
        }
        const pi2 = mo2 && parentBirthIssue(mo2, nextBirth);
        if (pi2) {
          if (pi2.level === 'error') { toast(pi2.msg, 'error'); return; }
          if (!confirm(pi2.msg)) return;
        }
        const pd2 = mo2 && parentDeathIssue(mo2, nextBirth);
        if (pd2 && !confirm(pd2.msg)) return;
      }
      const checkedSpouses = editSpouses.slice();
      // 保留已有配偶的先后顺序，新勾选的追加在后
      const nextSpouses = m.spouseIds.filter(id => checkedSpouses.indexOf(id) > -1)
        .concat(checkedSpouses.filter(id => m.spouseIds.indexOf(id) === -1));
      // 解除未再勾选的旧配偶关联
      m.spouseIds.forEach(id => {
        if (nextSpouses.indexOf(id) > -1) return;
        const oldSp = memberById(id);
        if (oldSp) {
          oldSp.spouseIds = oldSp.spouseIds.filter(x => x !== m.id);
          if (oldSp.spouseStatus) delete oldSp.spouseStatus[m.id];
        }
      });
      // 建立新配偶的双向关联
      nextSpouses.forEach(id => {
        const ns = memberById(id);
        if (ns && ns.spouseIds.indexOf(m.id) === -1) ns.spouseIds.push(m.id);
      });
      m.spouseIds = Array.from(new Set(nextSpouses));
      m.name = name;
      m.gender = String(fd.get('gender') || 'male') === 'female' ? 'female' : 'male';
      m.birth = nextBirth;
      m.death = nextDeath;
      m.deathCause = String(fd.get('deathCause') || '').trim();
      m.bio = String(fd.get('bio') || '');
      m.entryType = String(fd.get('entryType') || 'birth');
      m.entryNote = String(fd.get('entryNote') || '').trim();
      m.fatherId = nextFatherId;
      m.motherId = nextMotherId;
      m.childKind = String(fd.get('childKind') || 'birth');
      m.lost = !!fd.get('lost');
      m.singleParent = !!fd.get('singleParent');
      const nextSpouseStatus = {};
      checkedSpouses.forEach(id => {
        nextSpouseStatus[id] = editStatus[id] || 'married';
      });
      m.spouseStatus = nextSpouseStatus;
      // 婚姻状态在双方档案中保持一致
      m.spouseIds.forEach(id => {
        const sp = memberById(id);
        if (!sp) return;
        sp.spouseStatus = Object.assign({}, sp.spouseStatus || {});
        sp.spouseStatus[m.id] = nextSpouseStatus[id] || 'married';
      });
      if (state.pendingPhoto !== null) m.photo = state.pendingPhoto;
      state.pendingPhoto = null;
      state.editing = false;
      const changed = [];
      if (before.name !== m.name) changed.push('姓名');
      if (before.gender !== m.gender) changed.push('性别');
      if (before.birth !== m.birth) changed.push('出生时间');
      if (before.death !== m.death) changed.push('死亡时间');
      if (before.deathCause !== m.deathCause) changed.push('死亡病因');
      if (before.bio !== m.bio) changed.push('人物经历');
      if (before.entryType !== m.entryType || before.entryNote !== m.entryNote) changed.push('入谱方式');
      if (before.childKind !== m.childKind) changed.push('与父母关系');
      if (before.lost !== m.lost || before.singleParent !== m.singleParent) changed.push('人物状态');
      if (before.fatherId !== m.fatherId) changed.push('父亲');
      if (before.motherId !== m.motherId) changed.push('母亲');
      if (before.spouseKey !== m.spouseIds.slice().sort().join('|')) changed.push('配偶');
      if (before.photo !== m.photo) changed.push('照片');
      addLog('修改档案：' + m.name + (changed.length ? '（' + changed.join('、') + '）' : ''));
      commit('档案已保存');
    });
  }

  function openPhotoViewer(src, name) {
    if (!src) return;
    let el = $('#photoViewer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'photoViewer';
      el.className = 'photo-viewer';
      el.innerHTML = '<button type="button" class="pv-close" aria-label="关闭">×</button>' +
        '<figure><img alt=""><figcaption></figcaption></figure>';
      document.body.appendChild(el);
      el.addEventListener('click', e => {
        if (e.target === el || e.target.closest('.pv-close')) el.classList.remove('open');
      });
    }
    el.querySelector('img').src = src;
    el.querySelector('img').alt = name || '照片';
    el.querySelector('figcaption').textContent = name || '';
    el.classList.add('open');
  }

  /* 头像裁剪：拖动定位、滑块缩放，输出 512×512 方形底图，页面中按圆形显示 */
  function openCropper(file, onDone) {
    const modal = $('#cropModal');
    const stage = $('#cropStage');
    const cvs = $('#cropCanvas');
    const zoomEl = $('#cropZoom');
    const ctx = cvs.getContext('2d');
    const SIZE = 320;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let zoom = 1;
        let dx = 0;
        let dy = 0;
        let dragging = false;
        let startX = 0;
        let startY = 0;
        const base = Math.max(SIZE / img.width, SIZE / img.height);
        function clampOffset() {
          const scale = base * zoom;
          const maxX = Math.max(0, (img.width * scale - SIZE) / 2);
          const maxY = Math.max(0, (img.height * scale - SIZE) / 2);
          dx = Math.max(-maxX, Math.min(maxX, dx));
          dy = Math.max(-maxY, Math.min(maxY, dy));
        }
        function draw() {
          clampOffset();
          const scale = base * zoom;
          const w = img.width * scale;
          const h = img.height * scale;
          ctx.clearRect(0, 0, SIZE, SIZE);
          ctx.drawImage(img, SIZE / 2 + dx - w / 2, SIZE / 2 + dy - h / 2, w, h);
        }
        zoom = 1;
        dx = 0;
        dy = 0;
        zoomEl.value = '1';
        draw();
        modal.hidden = false;

        zoomEl.oninput = () => {
          zoom = parseFloat(zoomEl.value) || 1;
          draw();
        };
        stage.onpointerdown = ev => {
          dragging = true;
          startX = ev.clientX - dx;
          startY = ev.clientY - dy;
          try { stage.setPointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
        };
        stage.onpointermove = ev => {
          if (!dragging) return;
          dx = ev.clientX - startX;
          dy = ev.clientY - startY;
          draw();
        };
        stage.onpointerup = ev => {
          dragging = false;
          try { stage.releasePointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
        };
        stage.onpointercancel = () => { dragging = false; };

        $('#cropCancel').onclick = () => { modal.hidden = true; };
        $('#cropOk').onclick = () => {
          const scale = base * zoom;
          const w = img.width * scale;
          const h = img.height * scale;
          const left = SIZE / 2 + dx - w / 2;
          const top = SIZE / 2 + dy - h / 2;
          const out = document.createElement('canvas');
          out.width = 512;
          out.height = 512;
          const octx = out.getContext('2d');
          const k = 512 / SIZE;
          octx.fillStyle = '#ffffff';
          octx.fillRect(0, 0, 512, 512);
          octx.drawImage(img, left * k, top * k, w * k, h * k);
          modal.hidden = true;
          onDone(out.toDataURL('image/jpeg', 0.9));
        };
      };
      img.onerror = () => toast('照片读取失败，请换一张图片', 'error');
      img.src = String(reader.result);
    };
    reader.onerror = () => toast('照片读取失败', 'error');
    reader.readAsDataURL(file);
  }

  /* -------------------- 添丁 / 归宗 -------------------- */
  function openMemberModal(mode, prefill) {
    state.modalMode = mode;
    const modal = $('#memberModal');
    const form = $('#memberForm');
    form.reset();

    const fSel = $('#fatherSelect');
    const mSel = $('#motherSelect');
    fSel.innerHTML = '<option value="">（无）</option>' + parentOptions('male', prefill && prefill.fatherId);
    mSel.innerHTML = '<option value="">（无）</option>' + parentOptions('female', prefill && prefill.motherId);

    updateEntryUI();
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => {
      const input = form.querySelector('[name="name"]');
      if (input) input.focus();
    }, 80);
  }

  function updateEntryUI() {
    const isReturn = state.modalMode === 'return';
    $('#modalTitle').textContent = isReturn ? '归宗入谱' : '添丁入谱';
    $('#modalSubmit').textContent = isReturn ? '归宗入谱' : '确认添丁';
    $('#formHint').textContent = isReturn
      ? '归宗用于外迁、出继、失散后重新认祖归宗者。选择其父母即可自动归入相应房支与世代。'
      : '选择父母后，新成员会自动排入相应世代；不选父母则作为一支始祖（第一世）。';
    $('#returnNoteWrap').hidden = !isReturn;
    $$('#entryTabs button').forEach(b => b.classList.toggle('active', b.dataset.entry === state.modalMode));
  }

  function closeModal() {
    const modal = $('#memberModal');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  /* -------------------- 添加亲属（配偶 / 父辈） -------------------- */
  let kinContext = null;

  function kinAvailable(p, role) {
    if (role === 'spouse') return true;
    if (role === 'father') return !p.fatherId;
    if (role === 'mother') return !p.motherId;
    return false;
  }

  function openKinModal(id, role) {
    const p = memberById(id);
    if (!p) return;
    let target = role || 'spouse';
    if (!kinAvailable(p, target)) {
      target = ['father', 'mother', 'spouse'].find(r => kinAvailable(p, r));
    }
    if (!target) return;
    kinContext = { personId: id, role: target };
    const form = $('#kinForm');
    form.reset();
    const modal = $('#kinModal');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    setKinRole(target);
    setTimeout(() => form.querySelector('[name="name"]').focus(), 80);
  }

  function setKinRole(role) {
    const p = memberById(kinContext && kinContext.personId);
    if (!p) return;
    kinContext.role = role;
    $$('#kinRoles button').forEach(b => {
      b.disabled = !kinAvailable(p, b.dataset.role);
      b.classList.toggle('active', b.dataset.role === role);
    });
    const form = $('#kinForm');
    const genderField = $('#kinGenderField');
    const g = role === 'father' ? 'male' : (role === 'mother' ? 'female' : (p.gender === 'male' ? 'female' : 'male'));
    const radio = form.querySelector('input[name="gender"][value="' + g + '"]');
    if (radio) radio.checked = true;
    genderField.hidden = role !== 'spouse';
    if (role === 'spouse') {
      $('#kinTitle').textContent = '为 ' + p.name + ' 添加配偶';
      $('#kinHint').textContent = p.spouseIds.length
        ? '「' + p.name + '」已有配偶，此处继续添加会作为前妻 / 继室，与元配左右并排显示；添丁时可在「母亲」中指定生母。'
        : '配偶将作为新成员入谱，与「' + p.name + '」并列显示并连以婚配线；照片、生平可稍后在档案中补充。';
    } else {
      $('#kinTitle').textContent = '为 ' + p.name + ' 添加' + (role === 'father' ? '父亲' : '母亲');
      $('#kinHint').textContent = '新添的' + (role === 'father' ? '父亲' : '母亲') +
        '会排在「' + p.name + '」之上，成为上一世；若' + (role === 'father' ? '母亲' : '父亲') +
        '已在谱中且双方均无配偶，将自动结为夫妻。';
    }
  }

  function closeKinModal() {
    const modal = $('#kinModal');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    kinContext = null;
  }

  function submitKin(e) {
    e.preventDefault();
    if (!kinContext) return;
    const p = memberById(kinContext.personId);
    if (!p) {
      closeKinModal();
      return;
    }
    const role = kinContext.role;
    const fd = new FormData(e.target);
    const name = String(fd.get('name') || '').trim();
    if (!name) {
      toast('请填写姓名', 'error');
      return;
    }
    const gender = role === 'father' ? 'male'
      : role === 'mother' ? 'female'
        : (String(fd.get('gender') || '') === 'female' ? 'female' : 'male');
    const wasRoot = !p.fatherId && !p.motherId;
    const birth = String(fd.get('birth') || '').trim();
    const death = String(fd.get('death') || '').trim();

    const issue = dateIssue(birth, death);
    if (issue) {
      toast(issue, 'error');
      return;
    }
    const dup = findDuplicateMember(name, birth, null, role === 'spouse' ? null : p.id);
    if (dup) {
      toast('谱中已有同名同生年成员「' + dup.name + '」，请勿重复添加；直接关联已有成员即可', 'error');
      return;
    }
    if (role !== 'spouse' && birth && p.birth) {
      const pb = parseDate(birth);
      const cb = parseDate(p.birth);
      if (pb && cb) {
        if (dateCmp(pb, cb) >= 0) {
          toast('父母的出生时间必须早于「' + p.name + '」', 'error');
          return;
        }
        if (cb.y - pb.y < 12 && !confirm('父母与子女出生仅相差 ' + (cb.y - pb.y) + ' 年，确认无误？')) return;
      }
    }
    if (role !== 'spouse' && death && p.birth) {
      const pd = parseDate(death);
      const cb2 = parseDate(p.birth);
      if (pd && cb2 && dateCmp(cb2, pd) > 0 && !confirm('父母的去世时间早于「' + p.name + '」出生，确认是否遗腹子？')) return;
    }

    const person = normalizeMember({
      id: uid(),
      name: name,
      gender: gender,
      birth: birth,
      death: death,
      bio: String(fd.get('bio') || ''),
      entryType: (role !== 'spouse' && wasRoot) ? 'root' : 'birth',
      createdAt: Date.now()
    });

    if (role === 'spouse') {
      person.spouseIds = [p.id];
      if (p.spouseIds.indexOf(person.id) === -1) p.spouseIds.push(person.id);
    } else {
      if (wasRoot && p.entryType === 'root') p.entryType = 'birth';
      if (role === 'father') {
        p.fatherId = person.id;
        const mother = memberById(p.motherId);
        if (mother && !mother.spouseIds.length && !person.spouseIds.length) {
          mother.spouseIds.push(person.id);
          person.spouseIds.push(mother.id);
        }
      } else {
        p.motherId = person.id;
        const father = memberById(p.fatherId);
        if (father && !father.spouseIds.length && !person.spouseIds.length) {
          father.spouseIds.push(person.id);
          person.spouseIds.push(father.id);
        }
      }
    }

    state.members.push(person);
    closeKinModal();
    state.editing = false;
    addLog(role === 'spouse'
      ? '为 ' + p.name + ' 添加配偶 ' + name
      : '为 ' + p.name + ' 添加' + (role === 'father' ? '父亲' : '母亲') + ' ' + name);
    commit(role === 'spouse'
      ? '已为 ' + p.name + ' 添加配偶 ' + name
      : '已为 ' + p.name + ' 添加' + (role === 'father' ? '父亲' : '母亲') + ' ' + name);
  }

  /* -------------------- 增删改后的刷新 -------------------- */
  function commit(msg) {
    save();
    refresh();
    if (msg) toast(msg);
  }

  function refresh() {
    computeGens();
    renderTitle();
    renderStats();
    renderGenOptions();
    renderTree();
    renderList();
    if (state.selectedId && !state.editing) renderDrawer();
  }

  /* -------------------- 导出 / 导入 -------------------- */
  /* -------------------- 回收站 -------------------- */
  function moveToTrash(m) {
    if (!confirm('确定将「' + m.name + '」移入回收站吗？可随时在回收站还原。')) return;
    const links = [];
    state.members.forEach(x => {
      if (x.fatherId === m.id) {
        x.fatherId = null;
        links.push({ childId: x.id, field: 'fatherId' });
      }
      if (x.motherId === m.id) {
        x.motherId = null;
        links.push({ childId: x.id, field: 'motherId' });
      }
      x.spouseIds = x.spouseIds.filter(id => id !== m.id);
    });
    state.trash.unshift({
      member: JSON.parse(JSON.stringify(m)),
      deletedAt: Date.now(),
      links: links
    });
    state.members = state.members.filter(x => x.id !== m.id);
    state.selectedId = null;
    closeDrawer();
    addLog('移入回收站：' + m.name);
    commit('「' + m.name + '」已移入回收站');
  }

  function restoreFromTrash(index) {
    const item = state.trash[index];
    if (!item) return;
    const mem = normalizeMember(item.member);
    if (memberById(mem.id)) mem.id = uid();
    if (mem.fatherId && !memberById(mem.fatherId)) mem.fatherId = null;
    if (mem.motherId && !memberById(mem.motherId)) mem.motherId = null;
    mem.spouseIds = mem.spouseIds.filter(id => id !== mem.id && memberById(id));
    state.members.push(mem);
    mem.spouseIds.forEach(id => {
      const s = memberById(id);
      if (s && s.spouseIds.indexOf(mem.id) === -1) s.spouseIds.push(mem.id);
    });
    (item.links || []).forEach(l => {
      const child = memberById(l.childId);
      if (child && !child[l.field]) child[l.field] = mem.id;
    });
    state.trash.splice(index, 1);
    addLog('从回收站还原：' + mem.name);
    commit('已还原「' + mem.name + '」');
    renderBinList();
  }

  function purgeTrash(index) {
    const item = state.trash[index];
    if (!item) return;
    if (!confirm('彻底删除「' + item.member.name + '」后无法恢复，确定吗？')) return;
    state.trash.splice(index, 1);
    addLog('彻底删除：' + item.member.name);
    commit('已彻底删除「' + item.member.name + '」');
    renderBinList();
  }

  function clearTrash() {
    if (!state.trash.length) return;
    if (!confirm('确定清空回收站？清空后无法恢复。')) return;
    const count = state.trash.length;
    state.trash = [];
    addLog('清空回收站（' + count + ' 人）');
    commit('回收站已清空');
    renderBinList();
  }

  function renderBinList() {
    const list = $('#binList');
    if (!state.trash.length) {
      list.innerHTML = '<div class="r-empty">回收站是空的</div>';
      return;
    }
    list.innerHTML = state.trash.map((t, i) => {
      const m = t.member;
      return '<div class="record-item">' +
        '<div class="r-main">' +
        '<div class="r-title">' + esc(m.name) + ' <span class="chip ' + m.gender + '">' +
        (m.gender === 'male' ? '男' : '女') + '</span></div>' +
        '<div class="r-time">' + formatTime(t.deletedAt) + ' 移入</div>' +
        '</div>' +
        '<div class="r-actions">' +
        '<button type="button" class="mini-btn" data-restore="' + i + '">还原</button>' +
        '<button type="button" class="mini-btn red" data-purge="' + i + '">彻底删除</button>' +
        '</div></div>';
    }).join('');
  }

  function openBinModal() {
    renderBinList();
    const modal = $('#binModal');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeBinModal() {
    const modal = $('#binModal');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  function renderLogList() {
    const list = $('#logList');
    if (!state.logs.length) {
      list.innerHTML = '<div class="r-empty">暂无操作记录</div>';
      return;
    }
    list.innerHTML = state.logs.map(l =>
      '<div class="record-item"><div class="r-main">' +
      '<div class="r-title">' + esc(l.text) + '</div>' +
      '<div class="r-time">' + formatTime(l.time) + '</div>' +
      '</div></div>').join('');
  }

  function openLogModal() {
    renderLogList();
    const modal = $('#logModal');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeLogModal() {
    const modal = $('#logModal');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  function clearLogs() {
    if (!state.logs.length) return;
    if (!confirm('确定清空全部操作日志？')) return;
    state.logs = [];
    save();
    renderLogList();
    toast('操作日志已清空');
  }

  /* -------------------- 导出族谱图（PNG / PDF） -------------------- */
  const SERIF_STACK = '"Noto Serif SC", "Songti SC", "SimSun", serif';
  const SANS_STACK = '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif';

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fitText(ctx, text, maxWidth) {
    const value = String(text == null ? '' : text);
    if (ctx.measureText(value).width <= maxWidth) return value;
    let t = value;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
    return t + '…';
  }

  function drawExportCard(ctx, p, x, y) {
    roundRectPath(ctx, x, y, CARD_W, CARD_H, 10);
    ctx.fillStyle = '#fffdf8';
    ctx.fill();
    ctx.strokeStyle = '#ded1bd';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    roundRectPath(ctx, x, y, CARD_W, CARD_H, 10);
    ctx.clip();
    ctx.fillStyle = p.gender === 'male' ? '#3f6b8c' : '#b06a83';
    ctx.fillRect(x, y, 4, CARD_H);
    ctx.restore();

    const isReturn = p.entryType === 'return';
    const accent = p.gender === 'male' ? '#3f6b8c' : '#b06a83';

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#2b2622';
    ctx.font = '600 17px ' + SERIF_STACK;
    ctx.fillText(fitText(ctx, p.name, CARD_W - 30 - (isReturn ? 34 : 0)), x + 16, y + 27);

    ctx.beginPath();
    ctx.arc(x + 19.5, y + 51, 3, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.font = '11px ' + SANS_STACK;
    ctx.fillStyle = '#8a7d6d';
    ctx.fillText((p.gender === 'male' ? '男' : '女') + ' · ' + genLabel(p), x + 28, y + 51);

    ctx.fillStyle = '#9d9080';
    ctx.font = '11px ' + SANS_STACK;
    ctx.fillText(fitText(ctx, lifeSpan(p), CARD_W - 30), x + 16, y + 69);

    if (isReturn) {
      const tw = 32;
      const th = 16;
      const tx = x + CARD_W - tw - 7;
      const ty = y + 7;
      roundRectPath(ctx, tx, ty, tw, th, 4);
      ctx.fillStyle = 'rgba(156,59,46,0.08)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(156,59,46,0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#9c3b2e';
      ctx.font = '9px ' + SANS_STACK;
      ctx.textAlign = 'center';
      ctx.fillText('归宗', tx + tw / 2, ty + th / 2 + 0.5);
      ctx.textAlign = 'left';
    }
  }

  function buildExportCanvas() {
    computeGens();
    const layout = buildLayout();
    const PAD = 46;
    const HEADER = 104;
    const FOOTER = 68;
    const W = layout.width + PAD * 2;
    const H = HEADER + layout.height + FOOTER;

    let scale = 2;
    const maxSide = 9000;
    scale = Math.min(scale, maxSide / W, maxSide / H);
    const maxPixels = 42000000;
    if (W * H * scale * scale > maxPixels) {
      scale = Math.sqrt(maxPixels / (W * H));
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(W * scale));
    canvas.height = Math.max(1, Math.round(H * scale));
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.textBaseline = 'middle';

    // 纸张底色
    ctx.fillStyle = '#fbf7ef';
    ctx.fillRect(0, 0, W, H);

    // 标题区
    ctx.fillStyle = '#9c3b2e';
    roundRectPath(ctx, PAD, 26, 34, 34, 8);
    ctx.fill();
    ctx.fillStyle = '#fbf6ec';
    ctx.font = '22px ' + SERIF_STACK;
    ctx.textAlign = 'center';
    ctx.fillText('谱', PAD + 17, 44);

    ctx.textAlign = 'left';
    ctx.fillStyle = '#2b2622';
    ctx.font = '600 27px ' + SERIF_STACK;
    ctx.fillText(state.familyTitle || '家族宗谱', PAD + 46, 40);

    const male = state.members.filter(m => m.gender === 'male').length;
    const female = state.members.length - male;
    const gensCount = gens.size ? Math.max.apply(null, Array.from(gens.values())) + 1 : 0;
    ctx.fillStyle = '#8a7d6d';
    ctx.font = '12.5px ' + SANS_STACK;
    ctx.fillText('在册 ' + state.members.length + ' 人 · 男 ' + male + ' · 女 ' + female +
      ' · 传世 ' + gensCount + ' 世', PAD + 46, 68);

    const now = new Date();
    ctx.textAlign = 'right';
    ctx.fillStyle = '#a2958a';
    ctx.font = '12px ' + SANS_STACK;
    ctx.fillText('导出日期 ' + now.getFullYear() + '年' + (now.getMonth() + 1) + '月' +
      now.getDate() + '日', W - PAD, 42);

    ctx.strokeStyle = '#e5d9c8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, HEADER - 18);
    ctx.lineTo(W - PAD, HEADER - 18);
    ctx.stroke();

    // 谱系内容
    ctx.save();
    ctx.translate(PAD, HEADER);

    ctx.strokeStyle = '#cab9a5';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    layout.links.forEach(l => {
      ctx.beginPath();
      ctx.moveTo(l.x, l.y1);
      ctx.lineTo(l.x, l.busY);
      ctx.lineTo(l.cx, l.busY);
      ctx.lineTo(l.cx, l.y2);
      ctx.stroke();
    });
    layout.marriages.forEach(l => {
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y);
      ctx.lineTo(l.x2, l.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc((l.x1 + l.x2) / 2, l.y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = '#bda894';
      ctx.fill();
    });
    layout.cards.forEach(c => drawExportCard(ctx, c.person, c.x, c.y));
    ctx.restore();

    // 页脚图例
    const fy = HEADER + layout.height + 30;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let lx = PAD;
    ctx.font = '11.5px ' + SANS_STACK;
    ctx.fillStyle = '#8a7d6d';

    ctx.beginPath();
    ctx.arc(lx + 4, fy, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#3f6b8c';
    ctx.fill();
    ctx.fillStyle = '#8a7d6d';
    ctx.fillText('男性', lx + 13, fy);
    lx += 58;

    ctx.beginPath();
    ctx.arc(lx + 4, fy, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#b06a83';
    ctx.fill();
    ctx.fillStyle = '#8a7d6d';
    ctx.fillText('女性', lx + 13, fy);
    lx += 58;

    ctx.strokeStyle = '#c9b8a4';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(lx, fy);
    ctx.lineTo(lx + 16, fy);
    ctx.stroke();
    ctx.fillStyle = '#8a7d6d';
    ctx.fillText('婚配', lx + 23, fy);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#b4a898';
    ctx.fillText('佳兴族谱', W - PAD, fy);

    return { canvas: canvas, scale: scale };
  }

  function fileBaseName() {
    const d = new Date();
    const pad = n => (n < 10 ? '0' + n : '' + n);
    return (state.familyTitle || '家族宗谱') + '-' +
      d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function dataUrlToBytes(url) {
    const base64 = String(url).split(',')[1] || '';
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function gedMonth(m) {
    return ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][m - 1] || '';
  }

  function gedDateText(value) {
    const d = parseDate(value);
    if (!d) return '';
    if (d.m && d.d) return String(d.d).padStart(2, '0') + ' ' + gedMonth(d.m) + ' ' + d.y;
    if (d.m) return gedMonth(d.m) + ' ' + d.y;
    return String(d.y);
  }

  function gedNote(lines, level, text) {
    const t = String(text || '').replace(/\r/g, '').trim();
    if (!t) return;
    const parts = t.split('\n');
    lines.push(level + ' NOTE ' + parts[0]);
    for (let i = 1; i < parts.length; i++) {
      const line = parts[i];
      lines.push((level + 1) + ' CONT' + (line ? ' ' + line : ''));
    }
  }

  function exportGedcom() {
    if (!state.members.length) {
      toast('谱中暂无成员，无法导出', 'error');
      return;
    }
    const indiId = new Map();
    state.members.forEach((m, i) => indiId.set(m.id, '@I' + (i + 1) + '@'));

    const fams = [];
    const famIndex = new Map();
    function ensureFam(a, b) {
      const key = [a, b].filter(Boolean).sort().join('|');
      if (famIndex.has(key)) return famIndex.get(key);
      const fam = { id: '@F' + (fams.length + 1) + '@', husb: null, wife: null, children: [] };
      [memberById(a), memberById(b)].filter(Boolean).forEach(p => {
        if (p.gender === 'male') {
          if (!fam.husb) fam.husb = p.id;
          else if (!fam.wife) fam.wife = p.id;
        } else if (!fam.wife) {
          fam.wife = p.id;
        } else if (!fam.husb) {
          fam.husb = p.id;
        }
      });
      fams.push(fam);
      famIndex.set(key, fam);
      return fam;
    }

    const famc = new Map();
    state.members.forEach(m => {
      if (!m.fatherId && !m.motherId) return;
      const fam = ensureFam(m.fatherId, m.motherId);
      if (fam.children.indexOf(m.id) === -1) fam.children.push(m.id);
      if (!famc.has(m.id)) famc.set(m.id, fam);
    });
    state.members.forEach(m => {
      (m.spouseIds || []).forEach(sid => {
        if (m.id < sid) ensureFam(m.id, sid);
      });
    });

    const famsOf = new Map();
    fams.forEach(f => {
      [f.husb, f.wife].filter(Boolean).forEach(pid => {
        if (!famsOf.has(pid)) famsOf.set(pid, []);
        famsOf.get(pid).push(f);
      });
    });

    const lines = [];
    lines.push('0 HEAD');
    lines.push('1 SOUR JIAXING_ZUPU');
    lines.push('2 NAME 佳兴族谱');
    lines.push('2 VERS 1.0');
    lines.push('1 GEDC');
    lines.push('2 VERS 5.5.1');
    lines.push('2 FORM LINEAGE-LINKED');
    lines.push('1 CHAR UTF-8');
    const now = new Date();
    lines.push('1 DATE ' + now.getDate() + ' ' + gedMonth(now.getMonth() + 1) + ' ' + now.getFullYear());
    lines.push('1 SUBM @SUB1@');
    lines.push('0 @SUB1@ SUBM');
    lines.push('1 NAME ' + (state.familyTitle || ''));

    state.members.forEach(m => {
      lines.push('0 ' + indiId.get(m.id) + ' INDI');
      lines.push('1 NAME ' + m.name);
      lines.push('1 SEX ' + (m.gender === 'male' ? 'M' : 'F'));
      if (m.birth) {
        lines.push('1 BIRT');
        const bd = gedDateText(m.birth);
        if (bd) lines.push('2 DATE ' + bd);
      }
      if (m.death) {
        lines.push('1 DEAT');
        const dd = gedDateText(m.death);
        if (dd) lines.push('2 DATE ' + dd);
        if (m.deathCause) lines.push('2 CAUS ' + m.deathCause);
      }
      const fam = famc.get(m.id);
      if (fam) {
        lines.push('1 FAMC ' + fam.id);
        if (m.childKind === 'adopted') {
          lines.push('2 PEDI adopted');
          lines.push('2 NOTE 收养');
        } else if (m.childKind === 'inherited') {
          lines.push('2 PEDI adopted');
          lines.push('2 NOTE 过继');
        }
      }
      (famsOf.get(m.id) || []).forEach(f => lines.push('1 FAMS ' + f.id));
      if (m.bio) gedNote(lines, 1, m.bio);
      if (m.entryNote) gedNote(lines, 1, '入谱说明：' + m.entryNote);
      if (m.lost) lines.push('1 NOTE 失考');
      if (m.singleParent) lines.push('1 NOTE 单亲');
    });

    fams.forEach(f => {
      lines.push('0 ' + f.id + ' FAM');
      if (f.husb) lines.push('1 HUSB ' + indiId.get(f.husb));
      if (f.wife) lines.push('1 WIFE ' + indiId.get(f.wife));
      f.children.forEach(cid => lines.push('1 CHIL ' + indiId.get(cid)));
      let status = '';
      if (f.husb && f.wife) {
        const a = memberById(f.husb);
        const b = memberById(f.wife);
        status = (a.spouseStatus && a.spouseStatus[b.id]) || (b.spouseStatus && b.spouseStatus[a.id]) || '';
      }
      if (status === 'divorced') lines.push('1 DIV');
      else if (status === 'widowed') lines.push('1 NOTE 丧偶');
      else if (status === 'remarried') lines.push('1 NOTE 再婚');
    });
    lines.push('0 TRLR');

    downloadBlob(new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/plain;charset=utf-8' }), fileBaseName() + '.ged');
    addLog('导出 GEDCOM');
    save();
    toast('GEDCOM 文件已导出');
  }

  function doExport(kind) {
    if (kind === 'gedcom') {
      exportGedcom();
      return;
    }
    if (kind === 'json') {
      exportData();
      return;
    }
    if (!state.members.length) {
      toast('谱中暂无成员，无法导出', 'error');
      return;
    }
    toast('正在生成族谱图，请稍候…');
    setTimeout(() => {
      try {
        const result = buildExportCanvas();
        const canvas = result.canvas;
        const base = fileBaseName();
        if (kind === 'png') {
          canvas.toBlob(blob => {
            if (!blob) {
              toast('图片生成失败', 'error');
              return;
            }
            downloadBlob(blob, base + '.png');
            addLog('导出族谱图片（PNG）');
            save();
            toast('族谱图片已导出（PNG）');
          }, 'image/png');
        } else {
          const jpeg = canvas.toDataURL('image/jpeg', 0.92);
          const bytes = dataUrlToBytes(jpeg);
          const pdf = window.buildPdfBytes(
            bytes,
            canvas.width,
            canvas.height,
            canvas.width / result.scale,
            canvas.height / result.scale
          );
          downloadBlob(new Blob([pdf], { type: 'application/pdf' }), base + '.pdf');
          addLog('导出族谱 PDF');
          save();
          toast('族谱 PDF 已导出');
        }
      } catch (err) {
        toast('导出失败：' + (err && err.message ? err.message : '未知错误'), 'error');
      }
    }, 80);
  }

  function closeExportMenu() {
    $('#exportMenu').classList.remove('open');
    $('#btnExport').setAttribute('aria-expanded', 'false');
  }

  function exportData() {
    const payload = {
      familyName: state.familyTitle,
      exportedAt: new Date().toISOString(),
      members: state.members,
      logs: state.logs,
      trash: state.trash
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const pad = n => (n < 10 ? '0' + n : '' + n);
    a.href = url;
    a.download = (state.familyTitle || '家族宗谱') + '-' +
      d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    addLog('备份数据（JSON）');
    save();
    toast('已导出备份文件');
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data || !Array.isArray(data.members)) throw new Error('bad format');
        if (!confirm('导入将覆盖当前谱中全部数据，确定继续吗？')) return;
        state.familyTitle = normalizeFamilyTitle(data.familyName || state.familyTitle);
        state.members = data.members.map(normalizeMember);
        const ids = new Set(state.members.map(m => m.id));
        state.members.forEach(m => {
          if (m.fatherId && !ids.has(m.fatherId)) m.fatherId = null;
          if (m.motherId && !ids.has(m.motherId)) m.motherId = null;
          m.spouseIds = m.spouseIds.filter(id => ids.has(id) && id !== m.id);
        });
        state.members.forEach(m => {
          m.spouseIds.forEach(id => {
            const s = memberById(id);
            if (s && s.spouseIds.indexOf(m.id) === -1) s.spouseIds.push(m.id);
          });
        });
        closeDrawer();
        state.lastLayoutWidth = 0;
        state.logs = Array.isArray(data.logs)
          ? data.logs.filter(l => l && l.text).map(l => ({
            id: l.id || uid(),
            time: Number(l.time) || Date.now(),
            text: String(l.text)
          }))
          : [];
        state.trash = Array.isArray(data.trash)
          ? data.trash.filter(t => t && t.member).map(t => ({
            member: normalizeMember(t.member),
            deletedAt: Number(t.deletedAt) || Date.now(),
            links: Array.isArray(t.links) ? t.links : []
          }))
          : [];
        addLog('导入族谱数据（' + state.members.length + ' 人）');
        commit('族谱数据已导入');
      } catch (err) {
        toast('导入失败：文件格式不正确', 'error');
      }
    };
    reader.onerror = () => toast('文件读取失败', 'error');
    reader.readAsText(file);
  }

  /* -------------------- 事件绑定 -------------------- */
  function bindEvents() {
    // 视图切换
    $$('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const v = tab.dataset.view;
        if (v === state.view) return;
        state.view = v;
        $$('.tab').forEach(t => t.classList.toggle('active', t === tab));
        $('#treeView').classList.toggle('active', v === 'tree');
        $('#listView').classList.toggle('active', v === 'list');
        if (v === 'tree') requestAnimationFrame(() => fitTree(0.62));
      });
    });

    // 搜索
    $('#searchInput').addEventListener('input', e => {
      state.query = e.target.value.trim();
      renderTree();
      renderList();
    });
    $('#searchInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && state.query) {
        const listTab = $('.tab[data-view="list"]');
        if (listTab) listTab.click();
      }
    });

    // 名录筛选
    $('#genderFilter').addEventListener('click', e => {
      const btn = e.target.closest('.filter-chip');
      if (!btn) return;
      state.genderFilter = btn.dataset.gender;
      $$('.filter-chip').forEach(b => b.classList.toggle('active', b === btn));
      renderList();
    });
    $('#genFilter').addEventListener('change', e => {
      state.genFilter = e.target.value;
      renderList();
    });
    $('#sortBy').addEventListener('change', e => {
      state.sortBy = e.target.value;
      renderList();
    });

    // 打开档案
    $('#treeNodes').addEventListener('click', e => {
      if (suppressClick) return;
      const card = e.target.closest('.p-card');
      if (!card) return;
      openDrawer(card.dataset.id);
    });
    $('#memberGrid').addEventListener('click', e => {
      const card = e.target.closest('.member-card');
      if (!card) return;
      openDrawer(card.dataset.id);
    });

    // 档案中点击亲属姓名，直接跳转其档案
    $('#drawer').addEventListener('click', e => {
      const link = e.target.closest('.name-link');
      if (link) openDrawer(link.dataset.open);
    });

    // 添丁 / 归宗
    $('#btnBirth').addEventListener('click', () => openMemberModal('birth'));
    $('#btnReturn').addEventListener('click', () => openMemberModal('return'));
    $('#entryTabs').addEventListener('click', e => {
      const btn = e.target.closest('button[data-entry]');
      if (!btn) return;
      state.modalMode = btn.dataset.entry;
      updateEntryUI();
    });
    $('#memberForm').addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const name = String(fd.get('name') || '').trim();
      if (!name) {
        toast('请填写姓名', 'error');
        return;
      }
      const fatherId = String(fd.get('fatherId') || '') || null;
      const motherId = String(fd.get('motherId') || '') || null;
      const birth = String(fd.get('birth') || '').trim();
      const mode = state.modalMode;

      const issue = dateIssue(birth, '');
      if (issue) {
        toast(issue, 'error');
        return;
      }
      if (fatherId === motherId && fatherId) {
        toast('父亲和母亲不能是同一个人', 'error');
        return;
      }
      const dup = findDuplicateMember(name, birth, null, fatherId);
      if (dup) {
        toast('谱中已有同名同生年成员「' + dup.name + '」（' + genLabel(dup) + '），请勿重复添加；如需补充请直接编辑其档案', 'error');
        return;
      }
      const fObj = memberById(fatherId);
      const mObj = memberById(motherId);
      const pIssue = (fObj && parentBirthIssue(fObj, birth)) || (mObj && parentBirthIssue(mObj, birth));
      if (pIssue) {
        if (pIssue.level === 'error') { toast(pIssue.msg, 'error'); return; }
        if (!confirm(pIssue.msg)) return;
      }
      const member = normalizeMember({
        id: uid(),
        name: name,
        gender: String(fd.get('gender') || 'male'),
        fatherId: fatherId,
        motherId: motherId,
        birth: birth,
        bio: String(fd.get('bio') || ''),
        entryNote: String(fd.get('returnNote') || '').trim(),
        childKind: String(fd.get('childKind') || 'birth'),
        entryType: mode === 'return' ? 'return' : ((fatherId || motherId) ? 'birth' : 'root'),
        createdAt: Date.now()
      });
      state.members.push(member);
      closeModal();
      state.editing = false;
      addLog(mode === 'return' ? '归宗入谱：' + name : '添丁入谱：' + name);
      commit(mode === 'return' ? '「' + name + '」已归宗入谱' : '「' + name + '」已添丁入谱');
      openDrawer(member.id);
    });

    // 回收站 / 操作日志
    $('#stats').addEventListener('click', e => {
      if (e.target.closest('#btnBin')) openBinModal();
      else if (e.target.closest('#btnLog')) openLogModal();
      else if (e.target.closest('#btnLogout')) logout();
    });
    $('#loginForm').addEventListener('submit', handleLogin);
    $$('#binModal [data-close]').forEach(el => el.addEventListener('click', closeBinModal));
    $$('#logModal [data-close]').forEach(el => el.addEventListener('click', closeLogModal));
    $('#btnClearBin').addEventListener('click', clearTrash);
    $('#btnClearLog').addEventListener('click', clearLogs);
    $('#binList').addEventListener('click', e => {
      const restoreBtn = e.target.closest('[data-restore]');
      if (restoreBtn) {
        restoreFromTrash(Number(restoreBtn.dataset.restore));
        return;
      }
      const purgeBtn = e.target.closest('[data-purge]');
      if (purgeBtn) purgeTrash(Number(purgeBtn.dataset.purge));
    });

    // 弹窗关闭
    $$('#memberModal [data-close]').forEach(el => el.addEventListener('click', closeModal));
    $$('#kinModal [data-close]').forEach(el => el.addEventListener('click', closeKinModal));
    $('#kinForm').addEventListener('submit', submitKin);
    $('#kinRoles').addEventListener('click', e => {
      const btn = e.target.closest('button[data-role]');
      if (!btn || btn.disabled || !kinContext) return;
      setKinRole(btn.dataset.role);
    });

    // 导出菜单
    $('#btnExport').addEventListener('click', e => {
      e.stopPropagation();
      const menu = $('#exportMenu');
      const open = !menu.classList.contains('open');
      menu.classList.toggle('open', open);
      $('#btnExport').setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    $('#exportMenu').addEventListener('click', e => {
      const btn = e.target.closest('button[data-export]');
      if (!btn) return;
      closeExportMenu();
      doExport(btn.dataset.export);
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.menu-wrap')) closeExportMenu();
    });
    $('#btnImport').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', e => {
      const file = e.target.files && e.target.files[0];
      if (file) importData(file);
      e.target.value = '';
    });

    // 家族姓氏
    function renameFamily() {
      const v = prompt('请输入完整谱名（如：陈氏宗谱、颍川陈氏族谱）', state.familyTitle);
      if (v === null) return;
      state.familyTitle = normalizeFamilyTitle(v);
      addLog('修改谱名：' + state.familyTitle);
      save();
      renderTitle();
      renderStats();
      toast('谱名已更新');
    }
    $('#familyTitle').addEventListener('click', renameFamily);
    $('#btnRenameFamily').addEventListener('click', renameFamily);

    // 缩放
    $('.tree-tools').addEventListener('click', e => {
      const btn = e.target.closest('button[data-zoom]');
      if (!btn) return;
      const action = btn.dataset.zoom;
      if (action === 'fit') {
        fitTree(0.28);
        return;
      }
      const vp = $('#treeViewport');
      const cx = vp.clientWidth / 2;
      const cy = vp.clientHeight / 2;
      const z = state.zoom;
      const factor = action === 'in' ? 1.18 : 1 / 1.18;
      const ns = Math.min(2.4, Math.max(0.25, z.scale * factor));
      z.x = cx - (cx - z.x) * (ns / z.scale);
      z.y = cy - (cy - z.y) * (ns / z.scale);
      z.scale = ns;
      applyZoom();
    });

    // 滚轮缩放
    const vp = $('#treeViewport');
    vp.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const z = state.zoom;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const ns = Math.min(2.4, Math.max(0.25, z.scale * factor));
      z.x = px - (px - z.x) * (ns / z.scale);
      z.y = py - (py - z.y) * (ns / z.scale);
      z.scale = ns;
      applyZoom();
    }, { passive: false });

    // 拖动平移
    let drag = null;
    vp.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      if (e.target.closest('.tree-tools')) return;
      drag = { px: e.clientX, py: e.clientY, x: state.zoom.x, y: state.zoom.y, moved: false };
    });
    window.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.px;
      const dy = e.clientY - drag.py;
      if (!drag.moved && Math.sqrt(dx * dx + dy * dy) > 4) {
        drag.moved = true;
        vp.classList.add('dragging');
      }
      if (drag.moved) {
        state.zoom.x = drag.x + dx;
        state.zoom.y = drag.y + dy;
        applyZoom();
      }
    });
    window.addEventListener('pointerup', () => {
      if (drag && drag.moved) {
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 60);
      }
      drag = null;
      vp.classList.remove('dragging');
    });

    // 键盘
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if ($('#cropModal') && !$('#cropModal').hidden) {
          $('#cropModal').hidden = true;
          return;
        }
        if ($('#photoViewer') && $('#photoViewer').classList.contains('open')) {
          $('#photoViewer').classList.remove('open');
          return;
        }
        closeExportMenu();
        if ($('#binModal').classList.contains('open')) closeBinModal();
        else if ($('#logModal').classList.contains('open')) closeLogModal();
        else if ($('#kinModal').classList.contains('open')) closeKinModal();
        else if ($('#memberModal').classList.contains('open')) closeModal();
        else if ($('#drawer').classList.contains('open')) closeDrawer();
      }
    });

    // 窗口变化
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.view === 'tree') fitTree(0.45);
      }, 180);
    });
  }

  /* -------------------- 启动 -------------------- */
  function init() {
    load();
    computeGens();
    bindEvents();
    refresh();
    requestAnimationFrame(() => fitTree(0.62));
    authToken = sessionStorage.getItem(TOKEN_KEY) || '';
    // 清理旧版本留下的长期令牌，确保每次新开页面都需要登录
    localStorage.removeItem(TOKEN_KEY);
    if (authToken) startSession();
    else showLogin();  }

  init();
})();
