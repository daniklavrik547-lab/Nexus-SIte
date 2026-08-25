(function(){
'use strict';

/* ==================== 1. STORAGE MANAGER ==================== */
/* Локальный кэш настроек — ключ отдельный для каждого аккаунта.
   Источник истины — сервер (см. AuthManager.saveSettings). */
var StorageManager = {
  prefix: 'nexus.settings.',
  defaults: {
    themeMode: 'dark',     // 'light' | 'dark' | 'custom'
    customTheme: false,    // состояние пользовательской темы
    accent: 'cyan',        // ключ палитры
    avatar: '',            // '' -> случайный при первом запуске
    displayName: ''
  },
  key: function(){
    return this.prefix + (window.App && App.user ? App.user.id : 'guest');
  },
  load: function(){
    try{
      var raw = localStorage.getItem(this.key());
      if(!raw) return Object.assign({}, this.defaults);
      return Object.assign({}, this.defaults, JSON.parse(raw));
    }catch(e){ return Object.assign({}, this.defaults); }
  },
  save: function(data){
    try{ localStorage.setItem(this.key(), JSON.stringify(data)); return true; }
    catch(e){ return false; }
  },
  clear: function(){
    try{ localStorage.removeItem(this.key()); }catch(e){}
  }
};

/* ==================== 2. THEME MANAGER ==================== */
/* Акцент красит всю тему через CSS-переменные и работает
   совместно с любой темой: Dark + Pink, Custom + Purple и т.д. */
var ACCENTS = {
  cyan:   { name:'Циан',       hex:'#00e5ff', rgb:'0,229,255',  grad:['#00e5ff','#7a5cff'] },
  green:  { name:'Зелёный',    hex:'#2ee66b', rgb:'46,230,107', grad:['#2ee66b','#00c2ff'] },
  pink:   { name:'Розовый',    hex:'#ff2e88', rgb:'255,46,136', grad:['#ff2e88','#a855f7'] },
  orange: { name:'Оранжевый',  hex:'#ff9f2e', rgb:'255,159,46', grad:['#ffb02e','#ff2e88'] },
  yellow: { name:'Жёлтый',     hex:'#ffd60a', rgb:'255,214,10', grad:['#ffd60a','#ff7a2e'] },
  purple: { name:'Фиолетовый', hex:'#a855f7', rgb:'168,85,247', grad:['#a855f7','#ff2e88'] },
  blue:   { name:'Синий',      hex:'#3b82f6', rgb:'59,130,246', grad:['#3b82f6','#00e5ff'] }
};

var ThemeManager = {
  root: document.documentElement,
  applyAccent: function(key){
    var a = ACCENTS[key] || ACCENTS.cyan;
    var s = this.root.style;
    s.setProperty('--accent', a.hex);
    s.setProperty('--accent-rgb', a.rgb);
    s.setProperty('--grad-a', a.grad[0]);
    s.setProperty('--grad-b', a.grad[1]);
  },
  applyMode: function(mode){
    if(['light','dark','custom'].indexOf(mode) === -1) mode = 'dark';
    this.root.setAttribute('data-theme', mode);
  }
};

/* ==================== 3. UI MANAGER (toast) ==================== */
var UIManager = {
  toastEl: document.getElementById('toast'),
  timer: null,
  toast: function(msg){
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this.timer);
    var self = this;
    this.timer = setTimeout(function(){ self.toastEl.classList.remove('show'); }, 2400);
  }
};

/* ==================== 4. AVATAR MANAGER ==================== */
var AvatarManager = {
  POOL:  ['🦊','🐉','🐱','💀','⚡','💎','👾','🐺','🦁','🔥','🚀','🛸'],
  QUICK: ['🦊','🐉','🐱','💀','⚡','💎','👾'],
  els: {
    main:   document.getElementById('avatarMain'),
    side:   document.getElementById('avatarSide'),
    picker: document.getElementById('emojiPicker')
  },
  random: function(exclude){
    var pool = this.POOL.filter(function(e){ return e !== exclude; });
    return pool[Math.floor(Math.random() * pool.length)];
  },
  buildPicker: function(onPick){
    var self = this;
    this.QUICK.forEach(function(e){
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'emoji-btn';
      b.textContent = e;
      b.dataset.emoji = e;
      b.setAttribute('aria-label', 'Аватар ' + e);
      b.addEventListener('click', function(){ onPick(e); });
      self.els.picker.appendChild(b);
    });
  },
  render: function(emoji){
    this.els.main.textContent = emoji;
    this.els.side.textContent = emoji;
    var btns = this.els.picker.querySelectorAll('.emoji-btn');
    for(var i = 0; i < btns.length; i++){
      btns[i].classList.toggle('selected', btns[i].dataset.emoji === emoji);
    }
  }
};

/* ==================== 5. SETTINGS MANAGER ==================== */
var SettingsManager = {
  state: null,
  _bound: false,

  /* Инициализация под конкретного пользователя (данные приходят с сервера) */
  init: function(user){
    var server = (user && user.settings) ? user.settings : {};
    this.state = Object.assign({}, StorageManager.defaults, server);

    if(!this.state.displayName) this.state.displayName = user.username;
    if(!this.state.avatar){
      /* Случайный аватар — только при первоначальном отсутствии,
         сразу фиксируем на сервере, чтобы не менялся при обновлениях */
      this.state.avatar = AvatarManager.random('');
      AuthManager.saveSettings(this.state);
    }

    ThemeManager.applyAccent(this.state.accent);
    ThemeManager.applyMode(this.state.themeMode);
    AvatarManager.render(this.state.avatar);

    /* Обработчики вешаются один раз; при повторных входах — только обновление UI */
    if(!this._bound){
      AvatarManager.buildPicker(this.setAvatar.bind(this));
      this.buildSwatches();
      this.bindTheme();
      this.bindProfileInputs();
      this.bindSecurity();
      this.bindSave();
      this.bindNav();
      this._bound = true;
    }
    this.hydrate();
  },

  /* Применяем текущее состояние к интерфейсу (при каждом входе) */
  hydrate: function(){
    document.getElementById('displayName').value = this.state.displayName;
    document.getElementById('sidebarName').textContent = this.state.displayName;
    this.syncSwatches();
    this.syncThemeUI();
  },

  /* --- Аватар --- */
  setAvatar: function(e){
    this.state.avatar = e;
    AvatarManager.render(e);
  },

  /* --- Палитра акцента --- */
  buildSwatches: function(){
    var wrap = document.getElementById('swatches');
    var self = this;
    Object.keys(ACCENTS).forEach(function(key){
      var a = ACCENTS[key];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.dataset.key = key;
      b.style.setProperty('--sw', a.hex);
      b.title = a.name;
      b.setAttribute('aria-label', 'Акцент: ' + a.name);
      b.addEventListener('click', function(){
        self.state.accent = key;
        ThemeManager.applyAccent(key);
        self.syncSwatches();
      });
      wrap.appendChild(b);
    });
    this.syncSwatches();
  },
  syncSwatches: function(){
    var btns = document.querySelectorAll('#swatches .swatch');
    for(var i = 0; i < btns.length; i++){
      btns[i].classList.toggle('selected', btns[i].dataset.key === this.state.accent);
    }
  },

  /* --- Тема: Light / Dark / Custom --- */
  bindTheme: function(){
    this._seg = document.getElementById('themeSwitch');
    this._hint = document.getElementById('themeHint');
    var self = this;
    var btns = this._seg.querySelectorAll('button');

    for(var i = 0; i < btns.length; i++){
      btns[i].addEventListener('click', function(){
        var mode = this.dataset.mode;
        var changed = self.state.themeMode !== mode;
        self.state.themeMode = mode;
        self.state.customTheme = (mode === 'custom');
        ThemeManager.applyMode(mode);
        self.syncThemeUI();
        if(changed){
          UIManager.toast(
            mode === 'custom' ? '🎨 Своя тема включена — интерфейс окрашен акцентом' :
            mode === 'light'  ? '☀ Светлая тема включена' :
                                '🌙 Тёмная тема включена'
          );
        }
      });
    }
    this.syncThemeUI();
  },
  syncThemeUI: function(){
    var btns = this._seg.querySelectorAll('button');
    var custom = this.state.themeMode === 'custom';
    for(var i = 0; i < btns.length; i++){
      var b = btns[i];
      b.classList.toggle('active', b.dataset.mode === this.state.themeMode);
      /* Стандартные темы гаснут, пока активна своя цветовая схема
         (остаются кликабельными — клик возвращает обычную тему) */
      if(b.dataset.mode !== 'custom') b.classList.toggle('locked', custom);
    }
    this._hint.textContent = custom
      ? 'Активна своя цветовая схема на основе акцента — стандартные темы отключены'
      : '«Своя тема» окрашивает весь интерфейс выбранным акцентным цветом';
  },

  /* --- Профиль --- */
  bindProfileInputs: function(){
    var input = document.getElementById('displayName');
    var sideName = document.getElementById('sidebarName');

    var self = this;
    input.addEventListener('input', function(){
      self.state.displayName = this.value.trim() || App.user.username;
      sideName.textContent = self.state.displayName; /* живой превью в sidebar */
    });

    document.getElementById('resetAvatar').addEventListener('click', function(){
      self.setAvatar(AvatarManager.random(self.state.avatar));
      UIManager.toast('🎲 Случайный аватар выбран');
    });
  },

  /* --- Заглушки: пароль и расширение --- */
  bindSecurity: function(){
    document.getElementById('passwordForm').addEventListener('submit', function(e){
      e.preventDefault();
      var cur = document.getElementById('curPass');
      var next = document.getElementById('newPass');
      if(!cur.value || !next.value){
        UIManager.toast('🔒 Заполните оба поля пароля');
        return;
      }
      cur.value = '';
      next.value = '';
      UIManager.toast('🔐 Демо-режим: смена пароля будет доступна позже');
    });

    document.getElementById('downloadExt').addEventListener('click', function(){
      /* Заглушка: отдаёт минимальный placeholder-архив */
      try{
        var bytes = new Uint8Array([0x50,0x4B,0x05,0x06,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);
        var blob = new Blob([bytes], { type: 'application/zip' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'nexus-extension.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
        UIManager.toast('⬇ Загрузка nexus-extension.zip началась');
      }catch(err){
        UIManager.toast('⬇ Загрузка скоро будет доступна');
      }
    });
  },

  /* --- Сохранение всех настроек: локальный кэш + сервер --- */
  bindSave: function(){
    var btn = document.getElementById('saveBtn');
    var original = btn.innerHTML;
    var self = this;
    btn.addEventListener('click', function(){
      var savedLocally = StorageManager.save(self.state);

      /* Синхронизация с аккаунтом на сервере (источник истины) */
      AuthManager.saveSettings(self.state).then(function(synced){
        if(!synced) UIManager.toast('⚠ Сервер недоступен — настройки сохранены локально');
      });

      if(savedLocally){
        btn.classList.add('saved');
        btn.innerHTML = '<span>✓</span> Изменения сохранены';
        UIManager.toast('✓ Изменения сохранены');
        setTimeout(function(){
          btn.innerHTML = original;
          btn.classList.remove('saved');
        }, 1600);
      }else{
        UIManager.toast('⚠ Не удалось сохранить настройки');
      }
    });
  },

  /* --- Пункты меню-заглушки --- */
  bindNav: function(){
    var items = document.querySelectorAll('.menu-item');
    for(var i = 0; i < items.length; i++){
      items[i].addEventListener('click', function(e){
        e.preventDefault();
        if(!this.classList.contains('active')){
          UIManager.toast('🚧 Раздел «' + this.dataset.section + '» скоро появится');
        }
      });
    }
  }
};

/* ==================== ЭКСПОРТ ДЛЯ AUTH.JS ==================== */
/* app.js загружается раньше auth.js; менеджеры нужны в глобальной области */
window.StorageManager = StorageManager;
window.SettingsManager = SettingsManager;
window.ThemeManager = ThemeManager;
window.AvatarManager = AvatarManager;
window.UIManager = UIManager;

})();