// состояние приложения
const S = { user: null, cats: [], services: [], after: null };

// элементы и помощники
const view = document.getElementById('view');
const $ = (s, r = document) => r.querySelector(s);

function esc(v) {
  if (v == null) return '';
  return String(v).replace(/[&<>"']/g, function(c) {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });
}

function money(n) {
  const val = Number(n || 0);
  return val.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽';
}

function fmtDate(s) {
  if (!s) return '';
  return s.slice(0, 10).split('-').reverse().join('.');
}

function fmtDT(s) {
  if (!s) return '';
  return fmtDate(s) + ' ' + s.slice(11, 16);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function kc(id) {
  return 'k' + (((Number(id) - 1) % 4) + 1);
}

const STATUS = {
  accepted: 'Принята',
  diagnostics: 'В диагностике',
  repair: 'В ремонте',
  ready: 'Готова к выдаче',
  issued: 'Выдана',
  cancelled: 'Отменена'
};
const ORDER = ['accepted', 'diagnostics', 'repair', 'ready', 'issued'];
const ROLE = { client: 'Клиент', master: 'Мастер', admin: 'Админ' };
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const DEVICES = ['Смартфон', 'Планшет', 'Ноутбук', 'Компьютер', 'Телевизор', 'Стиральная машина', 'Холодильник', 'Другое'];
// Фотографии для карточек услуг (Unsplash).
// Если у услуги нет отдельной фотографии, используется фото её категории.
const SERVICE_IMAGES = {
    1: 'images/1.png',
    2: 'images/2.png',
    3: 'images/3.png',
    4: 'images/4.jpg',
    5: 'images/5.jpg',
    6: 'images/6.jpg',
    7: 'images/7.jpg',
    8: 'images/8.jpg',
    9: 'images/9.jpg',
    10: 'images/10.png',
    11: 'images/11.png',
    12: 'images/12.png'
};

const CATEGORY_IMAGES = {
  1: SERVICE_IMAGES[1],
  2: SERVICE_IMAGES[5],
  3: SERVICE_IMAGES[10],
  4: SERVICE_IMAGES[12]
};

// запрос к серверу
async function api(path, method = 'GET', body) {
  const headers = {};
  const token = localStorage.getItem('token');
  if (token) {
    headers.Authorization = 'Bearer ' + token;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const options = { method: method, headers: headers };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch('/api' + path, options);
  let data = {};
  try {
    data = await res.json();
  } catch (e) { }

  if (!res.ok) {
    if (res.status === 401 && token) {
      localStorage.removeItem('token');
      S.user = null;
      renderNav();
    }
    throw new Error(data.error || 'Ошибка запроса');
  }
  return data;
}

// всплывающие уведомления
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(function() { t.remove(); }, 3800);
}

// модальное окно
function openModal(html, size = '') {
  const m = $('#modal');
  m.innerHTML = `<div class="dialog ${size}">${html}</div>`;
  m.classList.remove('hidden');
  m.onclick = null;
  m.onmousedown = function(e) {
    if (e.target === m) closeModal();
  };

  const closeBtns = m.querySelectorAll('[data-close]');
  closeBtns.forEach(function(b) {
    b.addEventListener('click', closeModal);
  });
  return m;
}

function closeModal() {
  const m = $('#modal');
  m.classList.add('hidden');
  m.innerHTML = '';
  m.onclick = null;
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeModal();
});

// обёртка для обработчиков с ошибками
function guard(fn) {
  return async function(e) {
    try {
      await fn(e);
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}

function hashQuery() {
  const h = location.hash;
  const i = h.indexOf('?');
  return new URLSearchParams(i >= 0 ? h.slice(i + 1) : '');
}

// верхнее меню
function renderNav() {
  const r = S.user ? S.user.role : '';
  const cur = location.hash.replace(/^#\/?/, '').split('?')[0];
  const items = [['', 'Услуги и цены'], ['new', 'Новая заявка']];

  if (S.user) items.push(['cabinet', 'Мои заявки']);
  items.push(['track', 'Проверить статус']);
  if (r === 'master') items.push(['work', 'Рабочее место']);
  if (r === 'admin') items.push(['board', 'Заявки (канбан)'], ['work', 'Все заявки']);
  if (r === 'master' || r === 'admin') items.push(['stock', 'Склад запчастей']);
  if (r === 'admin') items.push(['stats', 'Статистика'], ['admin', 'Администрирование']);

  let h = '';
  for (let i = 0; i < items.length; i++) {
    const k = items[i][0];
    const t = items[i][1];
    const cls = cur === k ? ' on' : '';
    h += `<a class="nl${cls}" href="#/${k}">${t}</a>`;
  }

  h += '<span class="sp"></span>';

  if (S.user) {
    h += `<span class="who"><b>${esc(S.user.name)}</b><span class="role">${ROLE[S.user.role]}</span></span><button class="btn sm ghost" id="logout">Выйти</button>`;
  } else {
    h += `<a class="btn sm primary" style="text-decoration:none" href="#/login">Войти</a>`;
  }

  $('#nav').innerHTML = h;

  const lo = $('#logout');
  if (lo) {
    lo.onclick = guard(async function() {
      try { await api('/logout', 'POST'); } catch (e) { }
      localStorage.removeItem('token');
      S.user = null;
      location.hash = '#/';
      route();
    });
  }
}

// маршруты
const routes = {
  '': catalog, login: authPage, new: newRequest, cabinet: cabinet, track: track,
  work: work, board: board, stock: stock, stats: stats, admin: admin
};
const access = {
  new: ['client', 'master', 'admin'],
  cabinet: ['client', 'master', 'admin'],
  work: ['master', 'admin'],
  board: ['admin'],
  stock: ['master', 'admin'],
  stats: ['admin'],
  admin: ['admin']
};

async function route() {
  closeModal();
  const key = location.hash.replace(/^#\/?/, '').split('?')[0];
  const fn = routes[key] || catalog;
  const need = access[key];

  if (need && !S.user) {
    toast('Сначала войдите в систему', 'warn');
    S.after = location.hash;
    location.hash = '#/login';
    return;
  }

  if (need) {
    let hasAccess = false;
    for (let i = 0; i < need.length; i++) {
      if (need[i] === S.user.role) {
        hasAccess = true;
        break;
      }
    }
    if (!hasAccess) {
      toast('Недостаточно прав для этого раздела', 'err');
      location.hash = '#/';
      return;
    }
  }

  renderNav();
  view.innerHTML = '';
  view.onclick = null;
  view.onchange = null;
  view.ondragstart = null;
  view.ondragover = null;
  view.ondragleave = null;
  view.ondrop = null;
  view.ondragend = null;
  window.scrollTo(0, 0);
  try {
    await fn();
  } catch (err) {
    view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

// ---------- каталог услуг ----------
let F = { q: '', cat: 0, max: '' };

function priceRange(s) {
  if (s.price_from === s.price_to) return money(s.price_from);
  if (s.price_from === 0) return '0 – ' + money(s.price_to);
  return Number(s.price_from).toLocaleString('ru-RU') + ' – ' + money(s.price_to);
}

async function catalog() {
  S.services = await api('/services');

  view.innerHTML = `
  <h2>Услуги и ориентировочные цены</h2>
  <div class="hero">
    <div><b>Цены заранее</b>Итоговую стоимость мастер называет после диагностики</div>
    <div><b>Заявка за пару минут</b>Опишите проблему и прикрепите фото неисправности</div>
    <div><b>Статус онлайн</b>Следите за ремонтом в личном кабинете или по коду заявки</div>
  </div>
  <section class="filters">
    <input id="fq" type="search" placeholder="Поиск: замена экрана, чистка, Windows…" value="${esc(F.q)}">
    <div class="chips" id="fcats"></div>
    <div class="frow">
      <label>Цена «от» не выше, ₽<input id="fmax" type="number" min="0" step="100" value="${esc(F.max)}" placeholder="любая"></label>
      <button class="btn ghost" id="freset">Сбросить</button>
    </div>
  </section>
  <div id="grid" class="grid"></div>`;

  drawChips();
  drawGrid();

  $('#fq').oninput = function(e) { F.q = e.target.value; drawGrid(); };
  $('#fmax').oninput = function(e) { F.max = e.target.value; drawGrid(); };
  $('#freset').onclick = function() {
    F = { q: '', cat: 0, max: '' };
    catalog();
  };

  $('#grid').addEventListener('click', function(e) {
    const b = e.target.closest('[data-order]');
    if (!b) return;
    const target = '#/new?service=' + b.dataset.order;
    if (!S.user) {
      toast('Войдите, чтобы оставить заявку', 'warn');
      S.after = target;
      location.hash = '#/login';
      return;
    }
    location.hash = target;
  });
}

// кнопки категорий
function drawChips() {
  let h = `<button class="chip${F.cat === 0 ? ' on' : ''}" data-c="0">Все</button>`;

  for (let i = 0; i < S.cats.length; i++) {
    const c = S.cats[i];
    const cls = F.cat === c.id ? ' on' : '';
    h += `<button class="chip ${kc(c.id)}${cls}" data-c="${c.id}">${esc(c.name)}</button>`;
  }

  const box = $('#fcats');
  box.innerHTML = h;

  box.onclick = function(e) {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    F.cat = Number(b.dataset.c);
    drawChips();
    drawGrid();
  };
}

// карточки услуг
function drawGrid() {
  const q = F.q.trim().toLowerCase();
  const max = Number(F.max);

  const list = S.services.filter(function(s) {
    if (F.cat && s.category_id !== F.cat) return false;
    if (q && !s.name.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q)) return false;
    if (max && s.price_from > max) return false;
    return true;
  });

  const g = $('#grid');
  if (!g) return;

  if (list.length === 0) {
    g.innerHTML = '<div class="empty" style="grid-column:1/-1">По вашему запросу ничего не найдено</div>';
    return;
  }

  let html = '';
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const image = SERVICE_IMAGES[s.id] || CATEGORY_IMAGES[s.category_id] || SERVICE_IMAGES[12];
    html += `<article class="card">
      <div class="ico ${kc(s.category_id)}">
        <img class="service-photo" src="${image}" alt="${esc(s.name)}" loading="lazy" onerror="this.style.display='none'">
        <span class="badge ${kc(s.category_id)}">${esc(s.category_name)}</span>
      </div>
      <div class="cbody">
        <h3>${esc(s.name)}</h3>
        <p>${esc(s.description)}</p>
        <div class="meta">Срок ремонта: <b>~${s.days} дн.</b></div>
        <div class="cfoot">
          <div class="price sm">${priceRange(s)}</div>
          <button class="btn sm primary" data-order="${s.id}">Оставить заявку</button>
        </div>
      </div>
    </article>`;
  }
  g.innerHTML = html;
}

// ---------- вход и регистрация ----------
let authMode = 'login';

function authPage() {
  if (S.user) {
    location.hash = '#/';
    return;
  }

  const reg = authMode === 'register';
  let regHtml = '';
  if (reg) {
    regHtml = `<label>Имя<input name="name" autocomplete="name" placeholder="Как к вам обращаться"></label>
      <label>Телефон (необязательно)<input name="phone" type="tel" autocomplete="tel" placeholder="+7 900 000-00-00"></label>`;
  }

  const autocomplete = reg ? 'new-password' : 'current-password';
  const btnText = reg ? 'Создать аккаунт' : 'Войти';
  const tabCls1 = reg ? '' : ' on';
  const tabCls2 = reg ? ' on' : '';

  view.innerHTML = `
  <div class="box authbox">
    <div class="tabs">
      <button class="tab${tabCls1}" data-m="login">Вход</button>
      <button class="tab${tabCls2}" data-m="register">Регистрация</button>
    </div>
    <form class="form" id="af" novalidate>
      ${regHtml}
      <label>Email<input name="email" type="email" autocomplete="email" placeholder="you@example.com"></label>
      <label>Пароль<input name="password" type="password" autocomplete="${autocomplete}" placeholder="Минимум 6 символов"></label>
      <button class="btn primary">${btnText}</button>
    </form>
  </div>`;

  const tabs = view.querySelectorAll('[data-m]');
  tabs.forEach(function(b) {
    b.onclick = function() {
      authMode = b.dataset.m;
      authPage();
    };
  });

  $('#af').onsubmit = guard(async function(ev) {
    ev.preventDefault();
    const f = ev.target.elements;
    const email = f.email.value.trim();

    if (!email || !f.password.value) {
      toast('Заполните email и пароль', 'warn');
      return;
    }

    if (reg && f.name.value.trim().length < 2) {
      toast('Введите имя (минимум 2 символа)', 'warn');
      return;
    }

    if (reg && f.password.value.length < 6) {
      toast('Пароль - минимум 6 символов', 'warn');
      return;
    }

    const body = { email: email, password: f.password.value };
    if (reg) {
      body.name = f.name.value.trim();
      body.phone = f.phone.value.trim();
    }

    const r = await api(reg ? '/register' : '/login', 'POST', body);
    localStorage.setItem('token', r.token);
    S.user = r.user;
    toast('Добро пожаловать, ' + r.user.name + '!');

    if (S.after) {
      location.hash = S.after;
      S.after = null;
    } else if (r.user.role === 'master') {
      location.hash = '#/work';
    } else if (r.user.role === 'admin') {
      location.hash = '#/board';
    } else {
      location.hash = '#/';
    }
  });
}

// ---------- новая заявка ----------
function readPhoto(file) {
  return new Promise(function(resolve, reject) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      reject(new Error('Допустимы фото JPG, PNG или WebP'));
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      reject(new Error('Файл слишком большой (до 15 МБ)'));
      return;
    }

    const fr = new FileReader();
    fr.onerror = function() { reject(new Error('Не удалось прочитать файл')); };
    fr.onload = function() {
      const img = new Image();
      img.onerror = function() { reject(new Error('Не удалось прочитать изображение')); };
      img.onload = function() {
        // уменьшаем фото, чтобы быстро отправлялось
        const k = Math.min(1, 1280 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

async function newRequest() {
  if (S.services.length === 0) {
    S.services = await api('/services');
  }
  const pre = Number(hashQuery().get('service')) || 0;
  let photoData = '';

  let devOpts = '';
  for (let i = 0; i < DEVICES.length; i++) {
    devOpts += `<option>${DEVICES[i]}</option>`;
  }

  let srvOpts = '<option value="0">Не знаю - нужна диагностика</option>';
  for (let i = 0; i < S.cats.length; i++) {
    const c = S.cats[i];
    let group = '';
    for (let j = 0; j < S.services.length; j++) {
      const s = S.services[j];
      if (s.category_id === c.id) {
        const sel = s.id === pre ? 'selected' : '';
        group += `<option value="${s.id}" ${sel}>${esc(s.name)} (${priceRange(s)})</option>`;
      }
    }
    if (group) srvOpts += `<optgroup label="${esc(c.name)}">${group}</optgroup>`;
  }

  view.innerHTML = `
  <h2>Новая заявка на ремонт</h2>
  <form class="box form formbox" id="rf" novalidate>
    <div class="row2">
      <label>Тип устройства<select name="dev">${devOpts}</select></label>
      <label>Модель (необязательно)<input name="model" maxlength="80" placeholder="Например, iPhone 11"></label>
    </div>
    <label>Услуга<select name="service">${srvOpts}</select></label>
    <label>Описание неисправности
      <textarea name="problem" maxlength="1000" placeholder="Что случилось, когда началось, что уже пробовали делать…"></textarea>
      <div class="counter"><span id="cnt">0</span> / 1000</div>
    </label>
    <label>Телефон для связи<input name="phone" type="tel" autocomplete="tel" placeholder="+7 900 000-00-00"></label>
    <div>
      <label>Фото неисправности (необязательно)</label>
      <div class="drop">
        <input type="file" id="photo" accept="image/jpeg,image/png,image/webp">
        <div id="prev" class="muted">JPG, PNG или WebP</div>
      </div>
    </div>
    <div class="acts" style="justify-content:flex-start">
      <button class="btn primary">Отправить заявку</button>
      <a class="btn ghost" style="text-decoration:none" href="#/">Назад к услугам</a>
    </div>
  </form>`;

  const f = $('#rf').elements;
  f.problem.oninput = function() { $('#cnt').textContent = f.problem.value.length; };

  $('#photo').onchange = guard(async function(e) {
    const file = e.target.files[0];
    photoData = '';
    $('#prev').innerHTML = '<span class="muted">JPG, PNG или WebP</span>';
    if (!file) return;
    try {
      photoData = await readPhoto(file);
      $('#prev').innerHTML = `<img src="${photoData}" alt="Фото неисправности">`;
    } catch (err) {
      e.target.value = '';
      throw err;
    }
  });

  $('#rf').onsubmit = guard(async function(ev) {
    ev.preventDefault();
    const problem = f.problem.value.trim();
    const phone = f.phone.value.trim();

    if (problem.length < 10) {
      toast('Опишите неисправность подробнее (минимум 10 символов)', 'warn');
      return;
    }
    if (!/^\+?[0-9()\-\s]{10,20}$/.test(phone) || phone.replace(/\D/g, '').length < 10 || phone.replace(/\D/g, '').length > 15) {
      toast('Укажите корректный телефон для связи', 'warn');
      return;
    }

    const r = await api('/requests', 'POST', {
      deviceType: f.dev.value,
      deviceModel: f.model.value.trim(),
      problem: problem,
      phone: phone,
      serviceId: Number(f.service.value) || null,
      photo: photoData || null
    });

    toast('Заявка №' + r.id + ' принята');
    location.hash = '#/cabinet';
    // даём странице кабинета открыться, затем показываем квитанцию
    setTimeout(guard(function() { return showReceipt(r.id); }), 300);
  });
}

// ---------- квитанция ----------
async function showReceipt(id) {
  const q = await api('/requests/' + id);
  const m = openModal(`
    <div class="receipt">
      <h3>Квитанция о приёме № ${q.id}</h3>
      <div class="sub">Ремонтная мастерская «ТехноФикс» · ${fmtDT(q.created)}</div>
      <table><tbody>
        <tr><td>Клиент</td><td>${esc(q.client_name)}</td></tr>
        <tr><td>Телефон</td><td>${esc(q.phone)}</td></tr>
        <tr><td>Устройство</td><td>${esc(q.device_type)} ${esc(q.device_model)}</td></tr>
        <tr><td>Услуга</td><td>${esc(q.service_name || 'Диагностика')}</td></tr>
        <tr><td>Неисправность</td><td>${esc(q.problem)}</td></tr>
        <tr><td>Ориентировочный срок</td><td>до ${fmtDate(q.due_date)}</td></tr>
      </tbody></table>
      <div class="code">${esc(q.track_code)}</div>
      <div class="note">Код заявки для проверки статуса на сайте, раздел «Проверить статус»</div>
      <div class="sign"><span>Приёмщик: ______________</span><span>Клиент: ______________</span></div>
    </div>
    <div class="acts noprint">
      <button type="button" class="btn ghost" data-close>Закрыть</button>
      <button type="button" class="btn primary" id="doprint">Печать</button>
    </div>`, 'wide');

  $('#doprint', m).onclick = function() { window.print(); };
}

// ---------- общие элементы заявки ----------
function isLate(q) {
  return q.due_date && q.due_date < todayStr() && q.status !== 'issued' && q.status !== 'cancelled';
}

function stBadge(q) {
  let h = `<span class="st ${q.status}">${STATUS[q.status]}</span>`;
  if (isLate(q)) {
    h += ' <span class="st over">срок прошёл</span>';
  }
  return h;
}

function stepsHtml(status) {
  if (status === 'cancelled') {
    return '<div style="margin:6px 0 18px"><span class="st cancelled">Заявка отменена</span></div>';
  }
  const idx = ORDER.indexOf(status);
  let h = '<div class="steps">';
  for (let i = 0; i < ORDER.length; i++) {
    let cls = '';
    if (status === 'issued' || i < idx) cls = 'done';
    else if (i === idx) cls = 'now';
    h += `<div class="s ${cls}">${STATUS[ORDER[i]]}</div>`;
  }
  return h + '</div>';
}

// ---------- личный кабинет ----------
async function cabinet() {
  const list = await api('/requests/my');

  const cur = list.filter(function(b) {
    return b.status !== 'issued' && b.status !== 'cancelled';
  });
  const hist = list.filter(function(b) {
    return b.status === 'issued' || b.status === 'cancelled';
  });

  function rows(arr, canCancel) {
    if (arr.length === 0) {
      return '<div class="empty">Здесь пока пусто</div>';
    }

    let html = '<div class="tw"><table><thead><tr><th>№</th><th>Устройство</th><th>Услуга</th><th>Принята</th><th>Статус</th><th>Сумма</th><th></th></tr></thead><tbody>';

    for (let i = 0; i < arr.length; i++) {
      const b = arr[i];
      let sum = '<span class="muted">уточняется</span>';
      if (b.total > 0) sum = money(b.total);

      let cancelBtn = '';
      if (canCancel && b.status === 'accepted') {
        cancelBtn = `<button class="btn sm danger" data-cancel="${b.id}">Отменить</button>`;
      }

      html += `<tr>
        <td>${b.id}</td>
        <td>${esc(b.device_type)}<br><span class="muted">${esc(b.device_model)}</span></td>
        <td>${esc(b.service_name || 'Диагностика')}</td>
        <td>${fmtDate(b.created)}</td>
        <td>${stBadge(b)}</td>
        <td>${sum}</td>
        <td><button class="btn sm" data-open="${b.id}">Подробнее</button>${cancelBtn}</td>
      </tr>`;
    }

    html += '</tbody></table></div>';
    return html;
  }

  view.innerHTML = `
    <div class="bar"><h2 style="margin:0">Личный кабинет</h2><a class="btn primary" style="text-decoration:none" href="#/new">+ Новая заявка</a></div>
    <p class="muted" style="margin-top:-4px">${esc(S.user.name)} · ${esc(S.user.email)}</p>
    <section class="sec"><h3>Текущие заявки</h3>${rows(cur, true)}</section>
    <section class="sec"><h3>История обращений</h3>${rows(hist, false)}</section>`;

  view.onclick = guard(async function(e) {
    const o = e.target.closest('[data-open]');
    if (o) {
      await showRequest(Number(o.dataset.open), cabinet);
      return;
    }

    const b = e.target.closest('[data-cancel]');
    if (!b) return;

    if (!confirm('Отменить заявку №' + b.dataset.cancel + '?')) return;
    await api(`/requests/${b.dataset.cancel}/cancel`, 'POST');
    toast('Заявка отменена');
    cabinet();
  });
}

// ---------- проверка статуса по коду ----------
async function track() {
  const code0 = (hashQuery().get('code') || '').toUpperCase();

  view.innerHTML = `
  <h2>Проверить статус ремонта</h2>
  <div class="box trackbox">
    <p class="muted" style="margin-top:0">Введите код заявки из квитанции - вход в систему не нужен.</p>
    <form class="trackrow" id="tf" novalidate>
      <input name="code" maxlength="12" placeholder="Например, AB12CD34" value="${esc(code0)}">
      <button class="btn primary">Проверить</button>
    </form>
    <div id="tres" style="margin-top:18px"></div>
  </div>`;

  async function check(code) {
    const box = $('#tres');
    try {
      const r = await api('/track?code=' + encodeURIComponent(code));
      let log = '<ul class="log">';
      for (let i = 0; i < r.history.length; i++) {
        const h = r.history[i];
        log += `<li><b>${STATUS[h.status] || h.status}</b><small>${fmtDT(h.created)}</small></li>`;
      }
      log += '</ul>';

      box.innerHTML = `
        <h3>Заявка № ${r.id}</h3>
        <div class="kv">
          <div><span>Устройство</span><b>${esc(r.device_type)} ${esc(r.device_model)}</b></div>
          <div><span>Услуга</span><b>${esc(r.service_name || 'Диагностика')}</b></div>
          <div><span>Принята</span><b>${fmtDT(r.created)}</b></div>
          <div><span>Ориентировочный срок</span><b>до ${fmtDate(r.due_date)}</b></div>
        </div>
        ${stepsHtml(r.status)}
        ${log}`;
    } catch (err) {
      box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  $('#tf').onsubmit = function(ev) {
    ev.preventDefault();
    const code = ev.target.elements.code.value.trim();
    if (!code) {
      toast('Введите код заявки', 'warn');
      return;
    }
    check(code);
  };

  if (code0) check(code0);
}

// ---------- окно заявки (клиент / мастер / админ) ----------
async function showRequest(id, cb) {
  const q = await api('/requests/' + id);
  const role = S.user.role;
  const staff = role === 'admin' || (role === 'master' && q.master_id === S.user.id);
  const closed = q.status === 'issued' || q.status === 'cancelled';
  const canParts = staff && (q.status === 'diagnostics' || q.status === 'repair');

  let allParts = [];
  let masters = [];
  if (canParts) allParts = await api('/parts');
  if (role === 'admin' && !closed) masters = await api('/admin/masters');

  // использованные запчасти
  let partsHtml = '<div class="muted" style="margin-bottom:12px">Запчасти не использовались</div>';
  if (q.parts.length > 0) {
    partsHtml = '<ul class="plist">';
    for (let i = 0; i < q.parts.length; i++) {
      const p = q.parts[i];
      const del = canParts ? `<button class="btn sm danger" data-delpart="${p.id}">✕</button>` : '';
      partsHtml += `<li><span>${esc(p.name)} × ${p.qty}</span><span>${money(p.qty * p.price)} ${del}</span></li>`;
    }
    partsHtml += '</ul>';
  }

  const client = staff
    ? `<div><span>Клиент</span><b>${esc(q.client_name)}</b></div>
       <div><span>Телефон</span><b>${esc(q.phone)}</b></div>
       <div><span>Email</span><b>${esc(q.client_email)}</b></div>`
    : '';

  const photo = q.photo
    ? `<div class="photo"><a href="${esc(q.photo)}" target="_blank"><img src="${esc(q.photo)}" alt="Фото неисправности"></a></div>`
    : '';

  // панель управления для мастера и админа
  let manage = '';
  if (staff && !closed) {
    let assign = '';
    if (role === 'admin') {
      let opts = '<option value="0">Выберите мастера</option>';
      for (let i = 0; i < masters.length; i++) {
        const sel = masters[i].id === q.master_id ? 'selected' : '';
        opts += `<option value="${masters[i].id}" ${sel}>${esc(masters[i].name)}</option>`;
      }
      assign = `<div class="panel"><h4>Мастер</h4><div class="line"><select id="mm">${opts}</select><button class="btn sm violet" data-assign>Назначить</button></div></div>`;
    }

    const nexts = q.next;
    let btns = '';
    for (let i = 0; i < nexts.length; i++) {
      const s = nexts[i];
      if (s === 'cancelled') {
        btns += `<button class="btn sm danger" data-st="${s}">Отменить заявку</button>`;
      } else {
        btns += `<button class="btn sm primary" data-st="${s}">→ ${STATUS[s]}</button>`;
      }
    }

    const statusPanel = `<div class="panel"><h4>Статус: ${STATUS[q.status]}</h4>
      <textarea id="sc" maxlength="500" placeholder="Комментарий к смене статуса (необязательно)" style="min-height:52px"></textarea>
      <div class="btnrow">${btns}</div></div>`;

    const costPanel = `<div class="panel"><h4>Стоимость работ</h4><div class="line">
      <input id="cost" type="number" min="0" step="100" value="${q.work_cost}"><button class="btn sm" data-cost>Сохранить</button></div></div>`;

    let partsPanel = '';
    if (canParts) {
      let opts = '';
      for (let i = 0; i < allParts.length; i++) {
        const p = allParts[i];
        const dis = p.qty === 0 ? 'disabled' : '';
        opts += `<option value="${p.id}" ${dis}>${esc(p.name)} - ${p.qty} шт., ${money(p.price)}</option>`;
      }
      partsPanel = `<div class="panel"><h4>Списать запчасть</h4><div class="line">
        <select id="pp">${opts}</select><input id="pq" type="number" min="1" max="100" value="1" style="max-width:80px"><button class="btn sm" data-addpart>Добавить</button></div></div>`;
    }

    manage = assign + statusPanel + costPanel + partsPanel;
  }

  let commentPanel = '';
  if (staff && q.status !== 'cancelled') {
    commentPanel = `<div class="panel"><h4>Комментарий мастера</h4>
      <textarea id="cm" maxlength="500" placeholder="Что обнаружено, что сделано…" style="min-height:52px"></textarea>
      <div class="btnrow"><button class="btn sm" data-comment>Добавить комментарий</button></div></div>`;
  }

  let log = '<ul class="log">';
  for (let i = 0; i < q.log.length; i++) {
    const l = q.log[i];
    const who = l.user_name ? `${esc(l.user_name)} (${ROLE[l.user_role] || ''})` : 'Система';
    log += `<li><b>${STATUS[l.status]}</b> - ${esc(l.comment)}<small>${fmtDT(l.created)} · ${who}</small></li>`;
  }
  log += '</ul>';

  let clientActs = '';
  if (!staff && role !== 'admin' && q.status === 'accepted') {
    clientActs = `<button class="btn danger" data-cancelreq>Отменить заявку</button>`;
  }

  const m = openModal(`
    <h3>Заявка № ${q.id} ${stBadge(q)}</h3>
    ${stepsHtml(q.status)}
    <div class="dgrid">
      <div>
        <div class="kv">
          ${client}
          <div><span>Устройство</span><b>${esc(q.device_type)} ${esc(q.device_model)}</b></div>
          <div><span>Услуга</span><b>${esc(q.service_name || 'Диагностика')}</b></div>
          <div><span>Мастер</span><b>${esc(q.master_name || 'не назначен')}</b></div>
          <div><span>Принята</span><b>${fmtDT(q.created)}</b></div>
          <div><span>Ориентировочный срок</span><b class="${isLate(q) ? 'bad' : ''}">до ${fmtDate(q.due_date)}</b></div>
          <div><span>Код заявки</span><b>${esc(q.track_code)}</b></div>
        </div>
        <div class="problem">${esc(q.problem)}</div>
        ${photo}
        <h4 style="margin:0 0 8px">Использованные запчасти</h4>
        ${partsHtml}
        <div class="kv">
          <div><span>Работа мастера</span><b>${money(q.work_cost)}</b></div>
          <div><span>Запчасти</span><b>${money(q.parts_cost)}</b></div>
          <div><span>Итого</span><b style="color:var(--green)">${money(q.total)}</b></div>
        </div>
      </div>
      <div>
        ${manage}
        ${commentPanel}
        <h4 style="margin:0 0 10px">История заявки</h4>
        ${log}
      </div>
    </div>
    <div class="acts">
      ${clientActs}
      <button type="button" class="btn ghost" data-receipt>Квитанция</button>
      <button type="button" class="btn ghost" data-close>Закрыть</button>
    </div>`, 'xl');

  async function reload() {
    await showRequest(id, cb);
    if (cb) cb();
  }

  m.onclick = guard(async function(e) {
    const t = e.target.closest('button');
    if (!t) return;

    if (t.hasAttribute('data-receipt')) {
      await showReceipt(id);
      return;
    }

    if (t.dataset.st) {
      const comment = $('#sc', m) ? $('#sc', m).value : '';
      if (t.dataset.st === 'cancelled' && !confirm('Отменить заявку №' + id + '?')) return;
      await api(`/work/requests/${id}/status`, 'POST', { status: t.dataset.st, comment: comment });
      toast('Статус изменён: ' + STATUS[t.dataset.st]);
      await reload();
      return;
    }

    if (t.hasAttribute('data-assign')) {
      const mid = Number($('#mm', m).value);
      if (!mid) { toast('Выберите мастера', 'warn'); return; }
      await api(`/admin/requests/${id}/assign`, 'PUT', { masterId: mid });
      toast('Мастер назначен');
      await reload();
      return;
    }

    if (t.hasAttribute('data-cost')) {
      const v = Number($('#cost', m).value);
      if (!(v >= 0) || v > 1000000) { toast('Стоимость - от 0 до 1 000 000 ₽', 'warn'); return; }
      await api(`/work/requests/${id}/cost`, 'PUT', { workCost: v });
      toast('Стоимость сохранена');
      await reload();
      return;
    }

    if (t.hasAttribute('data-addpart')) {
      const qty = Number($('#pq', m).value);
      if (!Number.isInteger(qty) || qty < 1 || qty > 100) { toast('Количество - от 1 до 100', 'warn'); return; }
      await api(`/work/requests/${id}/parts`, 'POST', { partId: Number($('#pp', m).value), qty: qty });
      toast('Запчасть списана со склада');
      await reload();
      return;
    }

    if (t.dataset.delpart) {
      await api(`/work/requests/${id}/parts/${t.dataset.delpart}`, 'DELETE');
      toast('Запчасть возвращена на склад');
      await reload();
      return;
    }

    if (t.hasAttribute('data-comment')) {
      const text = $('#cm', m).value.trim();
      if (text.length < 2) { toast('Введите комментарий', 'warn'); return; }
      await api(`/work/requests/${id}/comment`, 'POST', { comment: text });
      toast('Комментарий добавлен');
      await reload();
      return;
    }

    if (t.hasAttribute('data-cancelreq')) {
      if (!confirm('Отменить заявку №' + id + '?')) return;
      await api(`/requests/${id}/cancel`, 'POST');
      toast('Заявка отменена');
      closeModal();
      if (cb) cb();
    }
  });
}

// ---------- рабочее место мастера ----------
let wFilter = 'accepted';

async function work() {
  const all = await api('/work/requests');
  const isAdmin = S.user.role === 'admin';

  const pick = {
    accepted: function(b) { return b.status === 'accepted'; },
    work: function(b) { return b.status === 'diagnostics' || b.status === 'repair'; },
    ready: function(b) { return b.status === 'ready'; },
    all: function() { return true; }
  };

  const cnt = function(k) {
    return all.filter(pick[k]).length;
  };

  const list = all.filter(pick[wFilter]);

  function tab(k, t) {
    const cls = wFilter === k ? ' on' : '';
    return `<button class="tab${cls}" data-f="${k}">${t} (${cnt(k)})</button>`;
  }

  let tableHtml = '';
  if (list.length === 0) {
    tableHtml = '<div class="empty">В этом списке ничего нет</div>';
  } else {
    const masterTh = isAdmin ? '<th>Мастер</th>' : '';
    tableHtml = `<div class="tw"><table><thead><tr><th>№</th><th>Клиент</th><th>Устройство</th><th>Услуга</th><th>Принята</th><th>Статус</th>${masterTh}<th>Сумма</th><th></th></tr></thead><tbody>`;

    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const masterTd = isAdmin ? `<td>${esc(b.master_name || '-')}</td>` : '';
      tableHtml += `<tr>
        <td>${b.id}</td>
        <td>${esc(b.client_name)}<br><span class="muted">${esc(b.phone)}</span></td>
        <td>${esc(b.device_type)}<br><span class="muted">${esc(b.device_model)}</span></td>
        <td>${esc(b.service_name || 'Диагностика')}</td>
        <td>${fmtDate(b.created)}</td>
        <td>${stBadge(b)}</td>
        ${masterTd}
        <td>${b.total > 0 ? money(b.total) : '-'}</td>
        <td><button class="btn sm primary" data-open="${b.id}">Открыть</button></td>
      </tr>`;
    }

    tableHtml += '</tbody></table></div>';
  }

  const title = isAdmin ? 'Все заявки' : 'Мои назначенные заявки';
  view.innerHTML = `
    <h2>${title}</h2>
    <div class="tabs">${tab('accepted', 'Новые')}${tab('work', 'В работе')}${tab('ready', 'Готовы к выдаче')}${tab('all', 'Все')}</div>
    ${tableHtml}`;

  view.onclick = guard(async function(e) {
    const t = e.target.closest('button');
    if (!t) return;

    if (t.dataset.f) {
      wFilter = t.dataset.f;
      work();
      return;
    }

    if (t.dataset.open) {
      await showRequest(Number(t.dataset.open), work);
    }
  });
}

// ---------- канбан-доска (админ) ----------
async function board() {
  const all = await api('/work/requests');
  const masters = await api('/admin/masters');

  let cols = '';
  for (let i = 0; i < ORDER.length; i++) {
    const st = ORDER[i];
    let items = all.filter(function(b) { return b.status === st; });
    const total = items.length;
    if (st === 'issued') items = items.slice(0, 8);

    let cards = '';
    for (let j = 0; j < items.length; j++) {
      const b = items[j];
      const closed = st === 'issued';
      const warn = !closed && (!b.master_id || isLate(b)) ? ' warn' : '';

      let sel = '';
      if (!closed) {
        let opts = '<option value="0">- мастер не назначен -</option>';
        for (let k = 0; k < masters.length; k++) {
          const s = masters[k].id === b.master_id ? 'selected' : '';
          opts += `<option value="${masters[k].id}" ${s}>${esc(masters[k].name)}</option>`;
        }
        sel = `<select data-assign="${b.id}">${opts}</select>`;
      } else {
        sel = `<span class="muted">${esc(b.master_name || '')}</span>`;
      }

      cards += `<div class="kcard${warn}" draggable="true" data-id="${b.id}">
        <b>№ ${b.id} · ${esc(b.device_type)}</b>
        <span>${esc(b.service_name || 'Диагностика')}</span>
        <span class="muted">${esc(b.client_name)} · до ${fmtDate(b.due_date)}</span>
        ${sel}
      </div>`;
    }

    if (!cards) cards = '<div class="muted" style="text-align:center;padding:20px 0">Пусто</div>';
    cols += `<div class="kcol s-${st}" data-col="${st}"><h4>${STATUS[st]} <span>${total}</span></h4><div class="kbody">${cards}</div></div>`;
  }

  view.innerHTML = `
    <h2>Заявки (канбан)</h2>
    <p class="muted" style="margin-top:-8px">Перетаскивайте карточки между колонками, чтобы менять статус. Красная полоска - нет мастера или срок прошёл. Клик по карточке открывает заявку.</p>
    <div class="kanban" id="kb">${cols}</div>`;

  let dragId = null;

  view.ondragstart = function(e) {
    const c = e.target.closest('.kcard');
    if (!c) return;
    dragId = Number(c.dataset.id);
    e.dataTransfer.setData('text/plain', String(dragId));
    e.dataTransfer.effectAllowed = 'move';
    c.classList.add('drag');
  };

  view.ondragend = function() {
    document.querySelectorAll('.kcard.drag').forEach(function(c) { c.classList.remove('drag'); });
    document.querySelectorAll('.kcol.over').forEach(function(c) { c.classList.remove('over'); });
  };

  view.ondragover = function(e) {
    const col = e.target.closest('.kcol');
    if (!col) return;
    e.preventDefault();
    document.querySelectorAll('.kcol.over').forEach(function(c) { if (c !== col) c.classList.remove('over'); });
    col.classList.add('over');
  };

  view.ondrop = guard(async function(e) {
    const col = e.target.closest('.kcol');
    if (!col || !dragId) return;
    e.preventDefault();
    const id = dragId;
    dragId = null;
    const target = col.dataset.col;
    const cur = all.find(function(b) { return b.id === id; });
    if (!cur || cur.status === target) { board(); return; }

    try {
      await api(`/work/requests/${id}/status`, 'POST', { status: target, comment: 'Статус изменён на доске' });
      toast('Заявка №' + id + ': ' + STATUS[target]);
    } finally {
      board();
    }
  });

  view.onchange = guard(async function(e) {
    const s = e.target.closest('[data-assign]');
    if (!s) return;
    const mid = Number(s.value);
    if (!mid) { board(); return; }
    await api(`/admin/requests/${s.dataset.assign}/assign`, 'PUT', { masterId: mid });
    toast('Мастер назначен');
    board();
  });

  view.onclick = guard(async function(e) {
    if (e.target.closest('select')) return;
    const c = e.target.closest('.kcard');
    if (!c) return;
    await showRequest(Number(c.dataset.id), board);
  });
}

// ---------- склад запчастей ----------
async function stock() {
  const list = await api('/parts');
  const isAdmin = S.user.role === 'admin';

  let rowsHtml = '';
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const low = p.qty <= p.min_qty;
    const tag = low ? '<span class="lowtag">Мало</span>' : '<span class="muted">В норме</span>';

    if (isAdmin) {
      rowsHtml += `<tr data-id="${p.id}" class="${low ? 'low' : ''}">
        <td class="wide"><input name="name" maxlength="80" value="${esc(p.name)}"></td>
        <td class="num"><input name="sku" maxlength="30" value="${esc(p.sku)}"></td>
        <td class="num"><input type="number" min="0" name="qty" value="${p.qty}"></td>
        <td class="num"><input type="number" min="0" name="min" value="${p.min_qty}"></td>
        <td class="num"><input type="number" min="1" step="10" name="price" value="${p.price}"></td>
        <td>${tag}</td>
        <td><button class="btn sm primary" data-save="${p.id}">Сохранить</button><button class="btn sm danger" data-del="${p.id}">Удалить</button></td>
      </tr>`;
    } else {
      rowsHtml += `<tr class="${low ? 'low' : ''}">
        <td>${esc(p.name)}</td><td>${esc(p.sku)}</td><td><b>${p.qty}</b></td><td>${p.min_qty}</td><td>${money(p.price)}</td><td>${tag}</td>
      </tr>`;
    }
  }

  const head = isAdmin ? '<th></th>' : '';
  const addBtn = isAdmin ? '<button class="btn sm primary" id="addpart">+ Запчасть</button>' : '';

  view.innerHTML = `
    <div class="bar"><h2 style="margin:0">Склад запчастей</h2>${addBtn}</div>
    <div class="tw"><table><thead><tr><th>Название</th><th>Артикул</th><th>Остаток</th><th>Мин. остаток</th><th>Цена, ₽</th><th>Состояние</th>${head}</tr></thead><tbody>
    ${rowsHtml}</tbody></table></div>
    <p class="muted">Запчасти списываются автоматически, когда мастер добавляет их в заявку, и возвращаются при отмене. Остаток ниже или равный минимальному помечается как «Мало».</p>`;

  if (!isAdmin) return;

  $('#addpart').onclick = function() {
    const m = openModal(`<form id="pf" novalidate><h3>Новая запчасть</h3>
      <div class="form">
        <label>Название<input name="name" maxlength="80"></label>
        <div class="row2"><label>Артикул<input name="sku" maxlength="30"></label><label>Цена, ₽<input type="number" name="price" min="1" value="500"></label></div>
        <div class="row2"><label>Количество<input type="number" name="qty" min="0" value="5"></label><label>Мин. остаток<input type="number" name="min" min="0" value="2"></label></div>
      </div>
      <div class="acts"><button type="button" class="btn ghost" data-close>Отмена</button><button class="btn primary">Добавить</button></div></form>`);

    $('#pf', m).onsubmit = guard(async function(ev) {
      ev.preventDefault();
      const f = ev.target.elements;
      const body = { name: f.name.value, sku: f.sku.value, qty: Number(f.qty.value), minQty: Number(f.min.value), price: Number(f.price.value) };
      if (body.name.trim().length < 2) { toast('Введите название', 'warn'); return; }
      if (body.sku.trim().length < 2) { toast('Введите артикул', 'warn'); return; }
      if (!(body.price > 0)) { toast('Цена должна быть больше 0', 'warn'); return; }
      if (!Number.isInteger(body.qty) || body.qty < 0 || !Number.isInteger(body.minQty) || body.minQty < 0) { toast('Количество - целое число от 0', 'warn'); return; }
      await api('/admin/parts', 'POST', body);
      closeModal();
      toast('Запчасть добавлена');
      stock();
    });
  };

  view.onclick = guard(async function(e) {
    const sv = e.target.closest('[data-save]');
    const dl = e.target.closest('[data-del]');

    if (sv) {
      const tr = sv.closest('tr');
      const body = {
        name: tr.querySelector('[name=name]').value,
        sku: tr.querySelector('[name=sku]').value,
        qty: Number(tr.querySelector('[name=qty]').value),
        minQty: Number(tr.querySelector('[name=min]').value),
        price: Number(tr.querySelector('[name=price]').value)
      };
      if (!Number.isInteger(body.qty) || body.qty < 0 || !Number.isInteger(body.minQty) || body.minQty < 0) {
        toast('Количество - целое неотрицательное число', 'warn');
        return;
      }
      if (!(body.price > 0)) { toast('Цена должна быть больше 0', 'warn'); return; }
      await api('/admin/parts/' + sv.dataset.save, 'PUT', body);
      toast('Данные склада сохранены');
      stock();
    }

    if (dl) {
      if (!confirm('Удалить запчасть со склада?')) return;
      await api('/admin/parts/' + dl.dataset.del, 'DELETE');
      toast('Запчасть удалена');
      stock();
    }
  });
}

// ---------- администрирование ----------
let aTab = 'services';

async function admin() {
  function tab(k, t) {
    const cls = aTab === k ? ' on' : '';
    return `<button class="tab${cls}" data-t="${k}">${t}</button>`;
  }

  view.innerHTML = `<h2>Администрирование</h2>
    <div class="tabs">${tab('services', 'Услуги')}${tab('staff', 'Пользователи и сотрудники')}</div>
    <div id="apane"></div>`;

  view.onclick = guard(function(e) {
    const t = e.target.closest('[data-t]');
    if (t) {
      aTab = t.dataset.t;
      admin();
    }
  });

  if (aTab === 'services') {
    await adminServices();
  } else {
    await adminStaff();
  }
}

async function refs() {
  S.cats = await api('/categories');
}

// услуги
async function adminServices() {
  const list = await api('/admin/services');
  await refs();

  let tableHtml = '';
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const vis = s.active ? '<span class="st ready">в каталоге</span>' : '<span class="st issued">скрыта</span>';
    tableHtml += `<tr><td>${esc(s.name)}</td><td>${esc(s.category_name)}</td><td>${priceRange(s)}</td><td>${s.days} дн.</td><td>${vis}</td>
      <td><button class="btn sm" data-edit="${s.id}">Изменить</button><button class="btn sm danger" data-del="${s.id}">Удалить</button></td></tr>`;
  }

  $('#apane').innerHTML = `
    <div class="bar"><h3 style="margin:0">Услуги (${list.length})</h3>
      <div><button class="btn sm ghost" id="addcat">+ Категория</button> <button class="btn sm primary" id="addsrv">+ Услуга</button></div></div>
    <div class="tw"><table><thead><tr><th>Название</th><th>Категория</th><th>Цена</th><th>Срок</th><th>Каталог</th><th></th></tr></thead><tbody>
    ${tableHtml}</tbody></table></div>`;

  $('#addsrv').onclick = function() { serviceModal(null); };

  $('#addcat').onclick = function() {
    const m = openModal(`<form id="cf" novalidate><h3>Новая категория</h3><label>Название<input name="name" maxlength="40"></label>
      <div class="acts"><button type="button" class="btn ghost" data-close>Отмена</button><button class="btn primary">Добавить</button></div></form>`);

    $('#cf', m).onsubmit = guard(async function(ev) {
      ev.preventDefault();
      await api('/admin/categories', 'POST', { name: ev.target.elements.name.value });
      closeModal();
      toast('Категория добавлена');
      admin();
    });
  };

  $('#apane').onclick = guard(async function(e) {
    const ed = e.target.closest('[data-edit]');
    const dl = e.target.closest('[data-del]');

    if (ed) {
      const item = list.find(function(x) { return x.id === Number(ed.dataset.edit); });
      serviceModal(item);
    }

    if (dl) {
      if (!confirm('Удалить услугу из каталога?')) return;
      await api('/admin/services/' + dl.dataset.del, 'DELETE');
      toast('Услуга удалена');
      admin();
    }
  });
}

// окно услуги
function serviceModal(e) {
  const v = e || { name: '', category_id: S.cats.length ? S.cats[0].id : 1, description: '', price_from: 500, price_to: 1500, days: 2, active: 1 };
  const title = e ? 'Изменить услугу' : 'Новая услуга';

  let optionsHtml = '';
  for (let i = 0; i < S.cats.length; i++) {
    const c = S.cats[i];
    const sel = c.id === v.category_id ? 'selected' : '';
    optionsHtml += `<option value="${c.id}" ${sel}>${esc(c.name)}</option>`;
  }

  const m = openModal(`
    <form id="ef" novalidate>
      <h3>${title}</h3>
      <div class="form">
        <label>Название<input name="name" maxlength="80" value="${esc(v.name)}"></label>
        <label>Категория<select name="cat">${optionsHtml}</select></label>
        <label>Описание<textarea name="desc" maxlength="300">${esc(v.description)}</textarea></label>
        <div class="row3" style="grid-template-columns:1fr 1fr 1fr">
          <label>Цена от, ₽<input type="number" name="pf" min="0" step="100" value="${v.price_from}"></label>
          <label>Цена до, ₽<input type="number" name="pt" min="0" step="100" value="${v.price_to}"></label>
          <label>Срок, дн.<input type="number" name="days" min="1" max="60" value="${v.days}"></label>
        </div>
        <label class="chk" style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Показывать в каталоге</label>
      </div>
      <div class="acts"><button type="button" class="btn ghost" data-close>Отмена</button><button class="btn primary">Сохранить</button></div>
    </form>`, 'wide');

  $('#ef', m).onsubmit = guard(async function(ev) {
    ev.preventDefault();
    const f = ev.target.elements;
    const pf = Number(f.pf.value);
    const pt = Number(f.pt.value);
    const days = Number(f.days.value);

    if (f.name.value.trim().length < 2) { toast('Введите название (минимум 2 символа)', 'warn'); return; }
    if (!(pf >= 0)) { toast('Цена «от» не может быть отрицательной', 'warn'); return; }
    if (!(pt >= pf)) { toast('Цена «до» не может быть меньше цены «от»', 'warn'); return; }
    if (!Number.isInteger(days) || days < 1 || days > 60) { toast('Срок - от 1 до 60 дней', 'warn'); return; }

    const body = {
      name: f.name.value,
      categoryId: Number(f.cat.value),
      description: f.desc.value,
      priceFrom: pf,
      priceTo: pt,
      days: days,
      active: f.active.checked
    };

    let url = '/admin/services';
    let method = 'POST';
    if (e) {
      url = '/admin/services/' + e.id;
      method = 'PUT';
    }

    await api(url, method, body);
    closeModal();
    toast('Сохранено');
    admin();
  });
}

// пользователи
async function adminStaff() {
  const users = await api('/admin/users');

  let rows = '';
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const isMe = u.id === S.user.id;
    const dis = isMe ? 'disabled' : '';

    let selHtml = '';
    const roles = ['client', 'master', 'admin'];
    for (let j = 0; j < roles.length; j++) {
      const r = roles[j];
      const sel = u.role === r ? 'selected' : '';
      selHtml += `<option value="${r}" ${sel}>${ROLE[r]}</option>`;
    }

    let delBtn = '';
    if (!isMe) {
      delBtn = `<button class="btn sm danger" data-du="${u.id}">Удалить</button>`;
    }

    rows += `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.phone || '-')}</td>
        <td><select data-role="${u.id}" ${dis} style="width:140px;padding:5px 8px">
          ${selHtml}</select></td>
        <td>${delBtn}</td></tr>`;
  }

  $('#apane').innerHTML = `
    <div class="two" style="grid-template-columns:2fr 1fr">
      <div class="tw"><table><thead><tr><th>Имя</th><th>Email</th><th>Телефон</th><th>Роль</th><th></th></tr></thead><tbody>
      ${rows}</tbody></table></div>
      <form class="box form" id="uf" novalidate><h3 style="margin:0">Новый пользователь</h3>
        <label>Имя<input name="name"></label>
        <label>Email<input name="email" type="email"></label>
        <label>Пароль<input name="pw" type="password" placeholder="Минимум 6 символов"></label>
        <label>Роль<select name="role"><option value="master">Мастер</option><option value="client">Клиент</option><option value="admin">Администратор</option></select></label>
        <button class="btn violet">Создать</button></form>
    </div>`;

  $('#uf').onsubmit = guard(async function(ev) {
    ev.preventDefault();
    const f = ev.target.elements;

    if (f.name.value.trim().length < 2) {
      toast('Введите имя (минимум 2 символа)', 'warn');
      return;
    }
    if (!f.email.value.includes('@')) {
      toast('Введите корректный email', 'warn');
      return;
    }
    if (f.pw.value.length < 6) {
      toast('Пароль - минимум 6 символов', 'warn');
      return;
    }

    await api('/admin/users', 'POST', { name: f.name.value, email: f.email.value, password: f.pw.value, role: f.role.value });
    toast('Пользователь создан');
    admin();
  });

  $('#apane').addEventListener('change', guard(async function(e) {
    const s = e.target.closest('[data-role]');
    if (!s) return;
    try {
      await api('/admin/users/' + s.dataset.role + '/role', 'PUT', { role: s.value });
      toast('Роль изменена');
    } catch (err) {
      adminStaff();
      throw err;
    }
  }));

  $('#apane').addEventListener('click', guard(async function(e) {
    const b = e.target.closest('[data-du]');
    if (!b) return;
    if (!confirm('Удалить пользователя?')) return;
    await api('/admin/users/' + b.dataset.du, 'DELETE');
    toast('Пользователь удалён');
    admin();
  }));
}

// ---------- статистика ----------
const COLORS = ['#34d399', '#a78bfa', '#fbbf24', '#38bdf8', '#fb7185'];

async function stats() {
  const s = await api('/stats');
  view.innerHTML = `
    <h2>Статистика мастерской</h2>
    <div class="kpis">
      <div class="kpi"><span>Доход (выданные заявки)</span><b>${money(s.revenue)}</b></div>
      <div class="kpi"><span>Всего заявок</span><b>${s.total}</b></div>
      <div class="kpi"><span>Сейчас в работе</span><b>${s.active}</b></div>
      <div class="kpi"><span>Без мастера</span><b>${s.fresh}</b></div>
      <div class="kpi"><span>Запчастей мало</span><b>${s.lowParts}</b></div>
    </div>
    <div class="charts">
      <div class="box chart"><h3>Заявки по месяцам</h3>${barChart(s.months, 'cnt', 'g1', ' заявок')}</div>
      <div class="box chart"><h3>Доход по месяцам</h3>${barChart(s.months, 'sum', 'g2', '')}</div>
      <div class="box chart"><h3>Типы устройств</h3>${donut(s.devices)}</div>
      <div class="box chart"><h3>Загрузка мастеров (заявок в работе)</h3>${hbars(s.masters)}</div>
      <div class="box chart" style="grid-column:1/-1"><h3>Популярные виды неисправностей и услуг</h3>${hbars(s.top)}</div>
    </div>`;
}

// график столбики
function barChart(months, field, gid, unit) {
  if (months.length === 0) return '<div class="empty">Нет данных</div>';

  const W = 520, H = 250, pl = 46, pb = 28, pt = 14;
  let max = 1;
  for (let i = 0; i < months.length; i++) {
    if (months[i][field] > max) max = months[i][field];
  }

  let top;
  if (field === 'cnt') {
    top = Math.max(4, Math.ceil(max / 4) * 4);
  } else {
    const step = Math.pow(10, Math.floor(Math.log10(max)));
    top = Math.ceil(max / step) * step;
  }
  const bw = (W - pl - 10) / months.length;

  let g = '';
  for (let i = 0; i <= 4; i++) {
    const y = pt + (H - pt - pb) * (1 - i / 4);
    const val = top * i / 4;
    const label = field === 'cnt' ? Math.round(val) : Math.round(val / 1000) + 'к';
    g += `<line x1="${pl}" x2="${W - 6}" y1="${y}" y2="${y}" stroke="#24242b"/><text x="${pl - 6}" y="${y + 4}" text-anchor="end">${label}</text>`;
  }

  let bars = '';
  for (let i = 0; i < months.length; i++) {
    const m = months[i];
    const h = (H - pt - pb) * (m[field] / top);
    const x = pl + i * bw + bw * 0.2;
    const y = H - pb - h;
    const hint = field === 'cnt' ? m.cnt + unit : money(m.sum);
    bars += `<rect x="${x}" y="${y}" width="${bw * 0.6}" height="${h}" fill="url(#${gid})"><title>${hint}</title></rect>
      <text x="${x + bw * 0.3}" y="${H - 10}" text-anchor="middle">${MONTHS[Number(m.m.slice(5)) - 1]}</text>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs>${g}${bars}</svg>`;
}

// круговая
function donut(items) {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += items[i].cnt;
  }

  if (total === 0) return '<div class="empty">Нет данных</div>';

  const R = 62, C = 2 * Math.PI * R;
  let off = 0;
  let segs = '';

  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    const len = C * c.cnt / total;
    const color = COLORS[i % COLORS.length];
    segs += `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${color}" stroke-width="30" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 100 100)"><title>${esc(c.name)}: ${c.cnt}</title></circle>`;
    off += len;
  }

  let legend = '';
  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    const color = COLORS[i % COLORS.length];
    const pct = Math.round(c.cnt * 100 / total);
    legend += `<span><i style="background:${color}"></i>${esc(c.name)} - ${c.cnt} (${pct}%)</span>`;
  }

  return `<svg viewBox="0 0 200 200" style="max-width:240px;margin:0 auto">${segs}<text x="100" y="98" text-anchor="middle" style="font-size:26px;font-weight:700;fill:#ececf0">${total}</text><text x="100" y="116" text-anchor="middle">заявок</text></svg><div class="legend">${legend}</div>`;
}

// полоски
function hbars(items) {
  if (items.length === 0) return '<div class="empty">Нет данных</div>';

  let max = 1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].cnt > max) max = items[i].cnt;
  }

  let html = '<div class="hb">';
  for (let i = 0; i < items.length; i++) {
    const t = items[i];
    const w = t.cnt / max * 100;
    html += `<div class="r"><span>${esc(t.name)}</span><div class="tr"><i style="width:${w}%"></i></div><b>${t.cnt}</b></div>`;
  }
  html += '</div>';
  return html;
}

// запуск
window.addEventListener('hashchange', route);

(async function init() {
  try {
    if (localStorage.getItem('token')) {
      try {
        S.user = await api('/me');
      } catch (e) {
        S.user = null;
      }
    }
    await refs();
  } catch (err) {
    toast(err.message, 'err');
  }
  route();
})();
