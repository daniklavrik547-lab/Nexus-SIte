/* ============================================================
   NEXUS AUTH — клиентская часть системы аккаунтов
   ------------------------------------------------------------
   Архитектура:
     Webflow / страница (интерфейс)
       → Frontend JavaScript (этот файл)
         → API (fetch + httpOnly cookie-сессия)
           → Backend (server/server.js: bcrypt, сессии)
             → Database (SQLite)
   Пароли никогда не хранятся и не проверяются на клиенте.
   Все решения об авторизации принимает сервер.
   ============================================================ */

/* ====== КОНФИГУРАЦИЯ: укажите адрес вашего backend ====== */
/* Локально:        'http://localhost:3000/api'
   После деплоя на Render: 'https://ваш-сервис.onrender.com/api' */
var NEXUS_CONFIG = {
  API_URL: 'http://localhost:3000/api'
};

/* ==================== API-КЛИЕНТ ==================== */
var AuthManager = {
  /* Единая точка запросов к API. Сессия живёт в httpOnly cookie,
     поэтому credentials: 'include' обязателен. */
  request: function(path, options){
    options = options || {};
    var fetchOpts = {
      method: options.method || 'GET',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    };
    if(options.body) fetchOpts.body = JSON.stringify(options.body);
    return fetch(NEXUS_CONFIG.API_URL + path, fetchOpts).then(function(r){
      return r.json().catch(function(){ return null; }).then(function(data){
        return { ok: r.ok, status: r.status, data: data };
      });
    }).catch(function(){
      return { ok: false, status: 0, data: null }; /* 0 = сеть/сервер недоступны */
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
    var self = this;
    return this.request('/settings', { method:'PATCH', body:{ settings:settings } }).then(function(res){
      if(res.status === 401){ App.showAuth('Сессия истекла, войдите снова'); return false; }
      return res.ok;
    });
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
    this.bindAuthUI();
    this.bindLogout();
    this.boot();
  },

  /* Автоматическая проверка сессии при каждом открытии сайта */
  boot: function(){
    var self = this;
    AuthManager.me().then(function(res){
      self.els.authBoot.classList.add('hidden');
      if(res.ok && res.data && res.data.user){
        self.enter(res.data.user);            /* сессия активна -> аккаунт */
      }else if(res.status === 0){
        self.showAuth('Сервер авторизации недоступен. Запустите backend (см. DEPLOY.md) и обновите страницу.');
      }else{
        self.showAuth('');                    /* сессии нет -> форма входа */
      }
    });
  },

  /* --- Вход выполнен: открыть аккаунт --- */
  enter: function(user){
    this.user = user;
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
    el.classList.remove('visible'); void el.offsetWidth; el.classList.add('visible'); /* перезапуск shake */
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
          self.els.loginPassword.value = '';
          self.enter(res.data.user);
        }else if(res.status === 401){
          /* Единое сообщение — не раскрываем, существует ли имя */
          self.setError(self.els.loginError, 'Неверное имя пользователя или пароль');
        }else if(res.status === 429){
          self.setError(self.els.loginError, 'Слишком много попыток. Подождите немного');
        }else if(res.status === 0){
          self.setError(self.els.loginError, 'Сервер авторизации недоступен');
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
          self.setError(self.els.registerError, 'Сервер авторизации недоступен');
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
        AuthManager.logout().then(function(){
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
