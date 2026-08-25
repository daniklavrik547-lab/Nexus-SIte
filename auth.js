/* ============================================================
   NEXUS AUTH — клиентская часть системы аккаунтов
   ------------------------------------------------------------
   Архитектура:
     Webflow / страница (интерфейс)
       → Frontend JavaScript (этот файл)
         → API (fetch + httpOnly cookie-сессия)
           → Backend (server.js: bcrypt, сессии)
             → Database (SQLite)
   Пароли никогда не хранятся и не проверяются на клиенте.
   Все решения об авторизации принимает сервер.
   ============================================================ */

/* ====== КОНФИГУРАЦИЯ ====== */
var NEXUS_CONFIG = {
  API_URL: 'https://nexus-api-ziy0.onrender.com/api'
};

/* Отладочные логи в консоли браузера (F12). Когда отладка не нужна — false */
var AUTH_DEBUG = true;

function authLog(){ if(AUTH_DEBUG && window.console) console.log.apply(console, ['[AUTH]'].concat([].slice.call(arguments))); }
function authErr(){ if(AUTH_DEBUG && window.console) console.error.apply(console, ['[AUTH ERROR]'].concat([].slice.call(arguments))); }

/* ==================== API-КЛИЕНТ ==================== */
var AuthManager = {
  /* Единая точка запросов. credentials:'include' обязателен:
     сессия живёт в httpOnly cookie и ходит между сайтами
     (GitHub Pages → Render) благодаря SameSite=None. */
  request: function(path, options, _retried){
    options = options || {};
    var fetchOpts = {
      method: options.method || 'GET',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    };
    if(options.body) fetchOpts.body = JSON.stringify(options.body);
    authLog((options.method || 'GET') + ' ' + path);

    return fetch(NEXUS_CONFIG.API_URL + path, fetchOpts).then(function(r){
      authLog('Ответ ' + path + ' → HTTP ' + r.status);
      return r.json().catch(function(){ return null; }).then(function(data){
        if(!r.ok && data && data.error) authErr('Тело ошибки ' + path + ':', JSON.stringify(data));
        return { ok: r.ok, status: r.status, data: data };
      });
    }).catch(function(err){
      /* Статус 0 = сеть / CORS / сервер недоступен (например, холодный старт Render) */
      if(!_retried){
        authErr('Соединение не удалось (' + path + '). Повтор через 1.5с…', err && err.message);
        return new Promise(function(resolve){ setTimeout(resolve, 1500); })
          .then(function(){ return AuthManager.request(path, options, true); });
      }
      authErr('Соединение не удалось (' + path + ').');
      return { ok: false, status: 0, data: null };
    });
  },

  me:       function(){ return this.request('/me'); },
  login:    function(username, password, remember){
    return this.request('/login', { method:'POST', body:{ username:username, password:password, remember:remember } });
  },
  register: function(username, email, password){
    return this.request('/register', { method:'POST', body:{ username:username, email:email, password:password } });
  },
  logout:   function(){ return this.request('/logout', { method:'POST' }); },

  saveSettings: function(settings){
    return this.request('/settings', { method:'PATCH', body:{ settings:settings } }).then(function(res){
      if(res.status === 401){ App.showAuth('Сессия истекла, войдите снова'); return false; }
      if(!res.ok) authErr('Не удалось сохранить настройки, HTTP ' + res.status);
      return res.ok;
    });
  }
};

/* ==================== ТЕМА ЭКРАНА АВТОРИЗАЦИИ ==================== */
/* Определяется автоматически по системной теме браузера
   (prefers-color-scheme). Ручного переключателя нет,
   localStorage не используется, с аккаунтом не связана. */
var AuthTheme = {
  mq: null,
  init: function(){
    var self = this;
    if(!window.matchMedia){ this.apply(); return; }
    this.mq = window.matchMedia('(prefers-color-scheme: dark)');
    var handler = function(){ self.apply(); }; /* реакция на смену темы системы */
    if(this.mq.addEventListener) this.mq.addEventListener('change', handler);
    else if(this.mq.addListener) this.mq.addListener(handler);
    this.apply();
  },
  isDark: function(){ return this.mq ? this.mq.matches : true; },
  apply: function(){
    document.documentElement.setAttribute('data-theme', this.isDark() ? 'dark' : 'light');
  }
};

/* ==================== КОНТРОЛЛЕР ПРИЛОЖЕНИЯ ==================== */
var App = {
  user: null,
  els: {},

  init: function(){
    this.els = {
      authScreen:    document.getElementById('authScreen'),
      authBoot:      document.getElementById('authBoot'),
      loginForm:     document.getElementById('loginForm'),
      registerForm:  document.getElementById('registerForm'),
      loginError:    document.getElementById('loginError'),
      loginSuccess:  document.getElementById('loginSuccess'),
      registerError: document.getElementById('registerError'),
      loginBtn:      document.getElementById('loginBtn'),
      registerBtn:   document.getElementById('registerBtn'),
      loginUsername: document.getElementById('loginUsername'),
      loginPassword: document.getElementById('loginPassword'),
      regUsername:   document.getElementById('regUsername'),
      regEmail:      document.getElementById('regEmail'),
      regPassword:   document.getElementById('regPassword')
    };
    AuthTheme.init();
    this.bindAuthUI();
    this.bindLogout();
    this.boot();
  },

  /* Автоматическая проверка сессии при каждом открытии сайта */
  boot: function(){
    var self = this;
    AuthManager.me().then(function(res){
      self.els.authBoot.classList.add('hidden');
      authLog('Проверка сессии → HTTP ' + res.status);
      if(res.ok && res.data && res.data.user){
        authLog('Сессия валидна, пользователь: ' + res.data.user.username);
        self.enter(res.data.user);
      }else if(res.status === 0){
        self.showAuth('Не удалось связаться с сервером авторизации. Проверьте подключение и попробуйте снова.');
      }else{
        self.showAuth(''); /* сессии нет → форма входа */
      }
    });
  },

  /* --- Вход выполнен: открыть аккаунт --- */
  enter: function(user){
    this.user = user;
    authLog('Вход выполнен: ' + user.username + ' (id ' + user.id + ')');
    document.body.classList.remove('auth-mode');
    this.els.authScreen.classList.add('hidden');
    this.clearMsg(this.els.loginError);
    this.clearMsg(this.els.loginSuccess);
    SettingsManager.init(user);
    var name = (user.settings && user.settings.displayName) || user.username;
    UIManager.toast('✓ Добро пожаловать, ' + name);
  },

  /* --- Показать экран авторизации --- */
  showAuth: function(message){
    this.user = null;
    document.body.classList.add('auth-mode');
    this.els.authScreen.classList.remove('hidden');
    this.els.authBoot.classList.add('hidden');
    AuthTheme.apply(); /* тема входа — по системе, не из аккаунта */
    this.switchPane('login');
    this.clearMsg(this.els.loginSuccess);
    if(message) this.showMsg(this.els.loginError, message);
  },

  /* --- Плавное переключение Вход <-> Регистрация --- */
  switchPane: function(name){
    var isLogin = (name === 'login');
    this.els.loginForm.classList.toggle('hidden', !isLogin);
    this.els.loginForm.classList.toggle('active', isLogin);
    this.els.registerForm.classList.toggle('hidden', isLogin);
    this.els.registerForm.classList.toggle('active', !isLogin);
    this.clearMsg(this.els.loginError);
    this.clearMsg(this.els.loginSuccess);
    this.clearMsg(this.els.registerError);
  },

  showMsg: function(el, text){ el.textContent = text; el.classList.add('visible'); },
  clearMsg: function(el){ el.textContent = ''; el.classList.remove('visible'); },
  setError: function(el, text){
    this.showMsg(el, text);
    el.classList.remove('visible'); void el.offsetWidth; el.classList.add('visible');
  },

  /* Состояние загрузки кнопки + защита от повторного нажатия */
  setLoading: function(btn, loading, busyText){
    if(loading){
      btn.dataset.label = btn.textContent;
      btn.textContent = busyText;
      btn.disabled = true;
    }else{
      btn.textContent = btn.dataset.label || btn.textContent;
      btn.disabled = false;
    }
  },

  bindAuthUI: function(){
    var self = this;

    /* Переключение форм */
    document.getElementById('showRegister').addEventListener('click', function(e){
      e.preventDefault(); self.switchPane('register'); self.els.regUsername.focus();
    });
    document.getElementById('showLogin').addEventListener('click', function(e){
      e.preventDefault(); self.switchPane('login'); self.els.loginUsername.focus();
    });

    this.bindPassToggle('toggleLoginPass', 'loginPassword');
    this.bindPassToggle('toggleRegPass', 'regPassword');

    /* ---------- ВХОД ---------- */
    this.els.loginForm.addEventListener('submit', function(e){
      e.preventDefault();
      var u = self.els.loginUsername.value.trim();
      var p = self.els.loginPassword.value;
      var remember = document.getElementById('rememberMe').checked;

      if(!u || !p){
        self.setError(self.els.loginError, 'Заполните имя пользователя и пароль');
        return;
      }
      self.clearMsg(self.els.loginError);
      self.setLoading(self.els.loginBtn, true, 'Вход...');

      AuthManager.login(u, p, remember).then(function(res){
        self.setLoading(self.els.loginBtn, false);
        if(res.ok && res.data && res.data.user){
          authLog('Сессия создана');
          self.els.loginPassword.value = '';
          self.enter(res.data.user);
        }else if(res.status === 401){
          /* Единое сообщение — не раскрываем, существует ли имя */
          self.setError(self.els.loginError, 'Неверное имя пользователя или пароль');
        }else if(res.status === 429){
          self.setError(self.els.loginError, 'Слишком много попыток. Подождите немного');
        }else if(res.status === 0){
          self.setError(self.els.loginError, 'Нет соединения с сервером. Проверьте интернет и попробуйте снова');
        }else if(res.status >= 500){
          authErr('Ошибка сервера при входе, HTTP ' + res.status, res.data);
          self.setError(self.els.loginError, 'Ошибка сервера (' + res.status + '). Попробуйте позже');
        }else{
          self.setError(self.els.loginError, 'Не удалось выполнить вход. Попробуйте ещё раз');
        }
      });
    });

    /* ---------- РЕГИСТРАЦИЯ ---------- */
    this.els.registerForm.addEventListener('submit', function(e){
      e.preventDefault();
      var u = self.els.regUsername.value.trim();
      var m = self.els.regEmail.value.trim();
      var p = self.els.regPassword.value;

      if(!u || !m || !p){
        self.setError(self.els.registerError, 'Заполните все поля');
        return;
      }
      if(!/^[a-zA-Z0-9_]{3,20}$/.test(u)){
        self.setError(self.els.registerError, 'Имя: 3–20 символов, только латиница, цифры и _');
        return;
      }
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(m)){
        self.setError(self.els.registerError, 'Некорректный email');
        return;
      }
      self.clearMsg(self.els.registerError);
      self.setLoading(self.els.registerBtn, true, 'Регистрация...');

      AuthManager.register(u, m, p).then(function(res){
        self.setLoading(self.els.registerBtn, false);
        if(res.status === 0){
          self.setError(self.els.registerError, 'Нет соединения с сервером. Проверьте интернет и попробуйте снова');
          return;
        }
        if(res.ok && res.data && res.data.user){
          /* Успех: возвращаем на форму входа, автовхода нет */
          self.switchPane('login');
          self.showMsg(self.els.loginSuccess, '✓ Аккаунт создан. Теперь войдите');
          self.els.loginUsername.value = u;
          self.els.loginPassword.focus();
          UIManager.toast('✓ Аккаунт ' + res.data.user.username + ' создан');
          return;
        }
        var map = {
          username_taken:  'Это имя пользователя уже занято',
          email_taken:     'Этот email уже используется',
          invalid_username:'Имя: 3–20 символов, только латиница, цифры и _',
          invalid_email:   'Некорректный email',
          invalid_password:'Некорректный пароль',
          missing_fields:  'Заполните все поля'
        };
        self.setError(self.els.registerError,
          (res.data && map[res.data.error]) || 'Не удалось создать аккаунт. Попробуйте позже');
      });
    });
  },

  bindPassToggle: function(btnId, inputId){
    var btn = document.getElementById(btnId);
    var input = document.getElementById(inputId);
    btn.addEventListener('click', function(){
      var show = (input.type === 'password');
      input.type = show ? 'text' : 'password';
      btn.classList.toggle('active', show);
    });
  },

  /* ---------- ВЫХОД: сессия уничтожается на сервере ---------- */
  bindLogout: function(){
    var btns = document.querySelectorAll('.js-logout');
    for(var i = 0; i < btns.length; i++){
      btns[i].addEventListener('click', function(){
        AuthManager.logout().then(function(res){
          authLog('Выход → HTTP ' + res.status + (res.ok ? ', сессия уничтожена' : ''));
          StorageManager.clear();
          App.showAuth('Вы вышли из аккаунта');
          UIManager.toast('Вы вышли из аккаунта');
        });
      });
    }
  }
};

/* ==================== ЗАПУСК ==================== */
App.init();
