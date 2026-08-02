document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();

  // --- STATE ---
  let todos = JSON.parse(localStorage.getItem('swipe-todos')) || {};
  let appSettings = JSON.parse(localStorage.getItem('swipe-settings')) || {
    title: 'Daily',
    accentHue: 210,
    accentColor: null, // stores the exact color string from palette
    darkMode: false,
    pomoDuration: 25,
    routines: [],
    categories: [],
    uiSounds: true
  };

  // Migration/Initialization for new fields
  if (!appSettings.routines) appSettings.routines = [];
  if (!appSettings.categories) appSettings.categories = [];
  if (appSettings.pomoDuration === undefined) appSettings.pomoDuration = 25;
  if (appSettings.uiSounds === undefined) appSettings.uiSounds = true;
  appSettings.routines.forEach(r => { if (!r.skipDates) r.skipDates = []; });

  // Migrate individual todo items: give every item a stable id + timestamps + sync placeholder.
  // A stable per-item id (independent of array position) is required groundwork for any future
  // two-way Notion sync, since Notion pages need to be matched back to a specific todo reliably.
  const generateId = () => Math.random().toString(36).substr(2, 9);
  Object.keys(todos).forEach(dateStr => {
    (todos[dateStr] || []).forEach(t => {
      if (!t.id) t.id = generateId();
      if (!t.updatedAt) t.updatedAt = Date.now();
      if (t.notionPageId === undefined) t.notionPageId = null;
      if (!t.subtasks) t.subtasks = [];
      if (t.pomoEndAt === undefined) t.pomoEndAt = null;
    });
  });

  let linkMode = { sourceDate: null, sourceIndex: null };
  let selectedCategoryHue = -1; // module-level so btn-add-category-action can read it
  let activeTimers = {};
  let currentFilter = { categoryId: null, routineOnly: false };
  let lastDeleted = null; // { date, index, item } for undo
  let undoTimeoutId = null;

  const todayDate = dayjs().startOf('day');
  const dateCards = [];
  for (let i = -30; i <= 30; i++) dateCards.push(todayDate.add(i, 'day'));

  // DOM Elements
  const swiperWrapper = document.getElementById('swiper-wrapper');
  const btnToday = document.getElementById('btn-today');
  const titleInput = document.getElementById('app-title');
  const modalOverlay = document.getElementById('modal-overlay');
  const drawerOverlay = document.getElementById('drawer-overlay');
  const drawerMenu = document.getElementById('drawer-menu');
  const datePicker = document.getElementById('native-date-picker');

  // New Modals Elements
  const routineListContainer = document.getElementById('routine-list-container');
  const pomoSlider = document.getElementById('pomo-duration-slider');
  const pomoDisplay = document.getElementById('pomo-duration-display');
  const catSwatches = document.getElementById('category-swatches');

  // Audio Assets (only the ones actually used)
  const sounds = {
    click: new Audio('https://assets.mixkit.co/active_storage/sfx/2571/2571-preview.mp3'), // Soft tap
    milestone: new Audio('https://assets.mixkit.co/active_storage/sfx/1435/1435-preview.mp3') // Success chime
  };
  Object.values(sounds).forEach(s => s.volume = 0.3);

  // --- THEME & SETTINGS ---
  const applyThemeMode = () => {
    const icon = document.getElementById('dark-mode-icon');
    if (appSettings.darkMode) {
      document.documentElement.setAttribute('data-theme', 'dark');
      if (icon) icon.setAttribute('data-lucide', 'sun');
    } else {
      document.documentElement.removeAttribute('data-theme');
      if (icon) icon.setAttribute('data-lucide', 'moon');
    }
    lucide.createIcons();
  };

  const applyColor = () => {
    const color = appSettings.accentColor || `hsl(${appSettings.accentHue}, 100%, ${appSettings.darkMode ? 55 : 50}%)`;
    document.documentElement.style.setProperty('--accent-color', color);
    document.documentElement.style.setProperty('--accent-hover', color);
    // 미뤄진(deferred) 항목 글자색 = 현재 테마색의 보색(hue+180). 파스텔이면 채도·명도를 그대로 유지해서 파스텔로 남는다.
    const m = color.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/);
    const complementary = m ? `hsl(${(parseFloat(m[1]) + 180) % 360}, ${m[2]}%, ${m[3]}%)` : '#e74c3c';
    document.documentElement.style.setProperty('--deferred-color', complementary);
  };

  const saveSettings = () => { localStorage.setItem('swipe-settings', JSON.stringify(appSettings)); };
  const applySettings = () => {
    titleInput.value = appSettings.title;
    applyThemeMode();
    applyColor();
    pomoSlider.value = appSettings.pomoDuration;
    pomoDisplay.innerText = appSettings.pomoDuration;
  };

  const saveTodos = () => { localStorage.setItem('swipe-todos', JSON.stringify(todos)); };

  // --- ROUTINE ENGINE ---
  const spawnRoutines = (dateStr) => {
    const d = dayjs(dateStr);
    const dayOfWeek = d.day(); // 0 is Sunday, 1-5 is weekday, 6 is Saturday
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

    appSettings.routines.forEach(rot => {
      if (rot.skipDates && rot.skipDates.includes(dateStr)) return; // skipped for this date

      let match = false;
      if (rot.days) {
        if (rot.days.includes(dayOfWeek)) match = true; // fixed: was referencing an undefined variable
      } else {
        if (rot.freq === 'daily') match = true;
        else if (rot.freq === 'weekday' && !isWeekend) match = true;
        else if (rot.freq === 'weekend' && isWeekend) match = true;
      }

      if (match) {
        const existing = todos[dateStr].find(t => t.routineId === rot.id);
        if (!existing) {
          todos[dateStr].push({
            id: generateId(), text: rot.text, completed: false, routineId: rot.id,
            linkColor: null, categoryId: null, subtasks: [], pomoTime: 0, pomoActive: false, pomoEndAt: null,
            updatedAt: Date.now(), notionPageId: null
          });
        }
      }
    });
  };

  // --- ROLLOVER: 어제 이전 날짜에 완료 안 된(루틴 제외) 항목을 오늘로 자동으로 옮기고 '미뤄짐' 표시 ---
  const rolloverIncompleteTodos = () => {
    const todayStr = todayDate.format('YYYY-MM-DD');
    let changed = false;
    Object.keys(todos).forEach(dateStr => {
      if (dateStr >= todayStr) return; // 오늘/미래는 그대로 둠
      const dayList = todos[dateStr] || [];
      for (let i = dayList.length - 1; i >= 0; i--) {
        const t = dayList[i];
        if (t.completed || t.routineId) continue; // 완료했거나 루틴 생성 항목이면 안 옮김
        dayList.splice(i, 1);
        t.deferred = true;
        t.updatedAt = Date.now();
        if (!todos[todayStr]) todos[todayStr] = [];
        todos[todayStr].push(t);
        changed = true;
        autoPushItem(t, todayStr); // 노션에도 날짜/Deferred 변경 반영
      }
    });
    if (changed) saveTodos();
    return changed;
  };

  // --- CARDS RENDER ---
  const createCardElement = (dayjsDate) => {
    const dateStr = dayjsDate.format('YYYY-MM-DD');
    const displayDate = dayjsDate.format('MM월 DD일');
    const dayOfWeek = dayjsDate.format('dddd');

    const diffDays = dayjsDate.startOf('day').diff(todayDate.startOf('day'), 'day');
    let relativeText = '과거';
    if (diffDays === -2) relativeText = '그저께';
    else if (diffDays === -1) relativeText = '어제';
    else if (diffDays === 0) relativeText = 'TODAY';
    else if (diffDays === 1) relativeText = '내일';
    else if (diffDays === 2) relativeText = '모레';
    else if (diffDays >= 3) relativeText = '예정';

    if (!todos[dateStr]) todos[dateStr] = [];
    spawnRoutines(dateStr);

    const slide = document.createElement('div');
    slide.className = 'swiper-slide';
    slide.id = `slide-${dateStr}`;

    slide.innerHTML = `
      <div class="todo-card" data-date="${dateStr}" id="card-capture-${dateStr}">
        <div class="card-header">
          <div class="card-header-main">
            <div class="card-date-wrap" style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
              <span class="card-date" style="margin-bottom:0;">${relativeText}</span>
              <span class="card-weekday" style="font-size:13px; font-weight:400; color:var(--text-muted);">${dayOfWeek}</span>
            </div>
            <div class="card-day" style="color:var(--text-main); opacity:0.85;">${displayDate}</div>
          </div>
          <button class="card-filter-btn" data-date="${dateStr}"><i data-lucide="list-filter"></i></button>
          <!-- Floating Filter Popup -->
          <div class="filter-popup" id="filter-popup-${dateStr}">
            <div class="filter-option" data-type="all">전체보기</div>
            <div class="filter-option" data-type="routine"><i data-lucide="repeat" style="width:12px;"></i> 루틴만</div>
            <div class="menu-separator" style="margin:4px 0;"></div>
            <div id="filter-categories-${dateStr}"></div>
          </div>
        </div>
        <div class="progress-container"><div class="progress-bar" id="progress-${dateStr}"></div></div>
        <ul class="todo-list" id="list-${dateStr}"></ul>
        <form class="add-todo-form" data-date="${dateStr}">
          <input type="text" class="add-todo-input" placeholder="새로운 할 일..." autocomplete="off">
          <button type="submit" class="btn-add"><i data-lucide="plus" style="width:14px;height:14px;"></i></button>
        </form>
      </div>
    `;
    return slide;
  };

  // --- TODOS RENDER ---
  const renderTodos = (dateStr) => {
    const listEl = document.getElementById(`list-${dateStr}`);
    if (!listEl) return;
    listEl.dataset.date = dateStr; // needed for Sortable cross-card drag
    const dayTodos = todos[dateStr] || [];

    listEl.innerHTML = '';
    let completedCount = 0;

    const filteredTodos = dayTodos.map((t, i) => ({ ...t, originalIndex: i }));

    filteredTodos.forEach((todo) => {
      const isRoutine = !!todo.routineId;
      const isLinked = !!todo.linkColor;

      let isMatch = true;
      if (currentFilter.routineOnly && !isRoutine) isMatch = false;
      if (currentFilter.categoryId && todo.categoryId !== currentFilter.categoryId) isMatch = false;

      if (todo.completed) completedCount++;

      const li = document.createElement('li');
      li.className = `todo-item ${todo.completed ? 'completed' : ''} ${isLinked ? 'is-linked' : ''} ${!isMatch ? 'is-filtered-out' : ''} ${todo.deferred ? 'deferred' : ''}`;
      li.dataset.index = todo.originalIndex;
      // Sink completed items to the bottom visually without touching the underlying array order,
      // so drag-to-reorder indices (which map 1:1 to array positions) stay correct.
      li.style.order = todo.completed ? '1' : '0';

      if (todo.linkColor) {
        const alpha = appSettings.darkMode ? 0.3 : 0.4;
        li.style.setProperty('--link-color', todo.linkColor.includes('rgba') ? todo.linkColor : `rgba(${todo.linkColor}, ${alpha})`);
      }

      // Category Indicator
      let catLine = '';
      let catIconHTML = '';
      if (todo.categoryId) {
        const cat = appSettings.categories.find(c => c.id === todo.categoryId);
        if (cat) {
          catLine = `<div style="position:absolute;left:-4px;top:20%;bottom:20%;width:3px;border-radius:2px;background:${cat.color}"></div>`;
          if (!todo.completed) {
            catIconHTML = `<div style="position:absolute;top:9px;left:7px;width:4px;height:7px;border:solid ${cat.color};border-width:0 2px 2px 0;transform:rotate(45deg);pointer-events:none;"></div>`;
          }
        }
      }

      // Pomodoro SVG — only show when ACTIVE (pomoActive===true)
      let pomoHTML = '';
      if (todo.pomoActive) {
        let total = appSettings.pomoDuration * 60;
        let offset = 43.98 - (todo.pomoTime / total) * 43.98;
        pomoHTML = `
           <button class="pomodoro-badge" data-date="${dateStr}" data-index="${todo.originalIndex}">
              <svg class="pomo-svg" viewBox="0 0 20 20">
                <circle class="pomo-ring-progress" cx="10" cy="10" r="7" stroke-dashoffset="${offset}"></circle>
              </svg>
           </button>`;
      }

      // Subtasks HTML (now actually inserted into the card, plus an add-subtask button)
      let subHTML = '';
      if (todo.subtasks && todo.subtasks.length > 0) {
        subHTML = todo.subtasks.map((st, si) => `
          <div class="subtask-item ${st.completed ? 'completed' : ''}" data-subtask-index="${si}">
            <input type="checkbox" class="subtask-checkbox" data-date="${dateStr}" data-parent="${todo.originalIndex}" data-index="${si}" ${st.completed ? 'checked' : ''}>
            <span class="subtask-text" contenteditable="true" data-date="${dateStr}" data-parent="${todo.originalIndex}" data-index="${si}">${escapeHtml(st.text)}</span>
            <button class="subtask-action-btn btn-subtask-edit" data-date="${dateStr}" data-parent="${todo.originalIndex}" data-index="${si}"><i data-lucide="pencil" style="width:10px;"></i></button>
            <button class="subtask-action-btn btn-subtask-delete" data-date="${dateStr}" data-parent="${todo.originalIndex}" data-index="${si}"><i data-lucide="trash-2" style="width:10px;"></i></button>
          </div>
        `).join('');
      }
      const subtaskContainerHTML = `
        <div class="subtask-container">
          ${subHTML}
          <button class="btn-add-subtask" data-date="${dateStr}" data-index="${todo.originalIndex}"><i data-lucide="plus" style="width:11px;"></i> 소항목 추가</button>
        </div>
      `;

      li.innerHTML = `
        ${catLine}
        <div class="todo-row">
          <div style="position:relative;display:flex;align-items:center;flex-shrink:0;">
             <input type="checkbox" class="todo-checkbox ${isRoutine ? 'is-routine' : ''}" data-date="${dateStr}" data-index="${todo.originalIndex}" ${todo.completed ? 'checked' : ''}>
             ${catIconHTML}
          </div>
          <div class="todo-content" data-date="${dateStr}" data-index="${todo.originalIndex}">
             <span class="todo-text" data-date="${dateStr}" data-index="${todo.originalIndex}">${escapeHtml(todo.text)}</span>
             ${pomoHTML}
          </div>
          <div class="item-actions">
            <button class="action-btn btn-timer" data-date="${dateStr}" data-index="${todo.originalIndex}" title="뽀모도로"><i data-lucide="timer" style="width:13px;"></i></button>
            <button class="action-btn btn-link" data-date="${dateStr}" data-index="${todo.originalIndex}" title="하이라이트"><i data-lucide="highlighter" style="width:13px;"></i></button>
            <button class="action-btn btn-category" data-date="${dateStr}" data-index="${todo.originalIndex}" title="카테고리"><i data-lucide="tag" style="width:13px;"></i></button>
            <button class="action-btn btn-delete" data-date="${dateStr}" data-index="${todo.originalIndex}" title="삭제"><i data-lucide="trash-2" style="width:13px;"></i></button>
          </div>
        </div>
        ${subtaskContainerHTML}
      `;
      listEl.appendChild(li);
    });

    const progressBar = document.getElementById(`progress-${dateStr}`);
    const percent = dayTodos.length === 0 ? 0 : (completedCount / dayTodos.length) * 100;
    if (progressBar) progressBar.style.width = `${percent}%`;

    if (progressBar && percent === 100 && dayTodos.length > 0 && !progressBar.dataset.celebrated) {
      progressBar.dataset.celebrated = "true";
      triggerConfetti();
      if (appSettings.uiSounds) sounds.milestone.play();
    } else if (progressBar && percent < 100) {
      delete progressBar.dataset.celebrated;
    }

    lucide.createIcons();
    updateFilterPopupUI(dateStr);

    // Drag to reorder within the card (Sortable.js)
    if (window.Sortable) {
      Sortable.create(listEl, {
        animation: 150,
        ghostClass: 'sortable-ghost',
        handle: '.todo-row',
        group: 'todos',
        onEnd: function (evt) {
          const fromDate = evt.from.dataset.date;
          const toDate = evt.to ? evt.to.dataset.date : fromDate;
          if (!fromDate) return;
          const movedItem = todos[fromDate].splice(evt.oldDraggableIndex, 1)[0];
          if (!todos[toDate]) todos[toDate] = [];
          todos[toDate].splice(evt.newDraggableIndex, 0, movedItem);
          saveTodos();
          if (fromDate !== toDate) {
            renderTodos(fromDate);
            movedItem.updatedAt = Date.now();
            autoPushItem(movedItem, toDate);
          }
          renderTodos(toDate);
        }
      });
    }
  };

  const triggerConfetti = () => {
    confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 }, colors: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF'] });
  };

  const updateFilterPopupUI = (dateStr) => {
    const container = document.getElementById(`filter-categories-${dateStr}`);
    if (!container) return;
    container.innerHTML = appSettings.categories.map(c => `
      <div class="filter-option" data-category="${c.id}">
        <div class="filter-color-dot" style="background:${c.color}"></div> ${c.name}
      </div>
    `).join('');
  };

  let swiper = null; // 아래에서 생성됨; renderAllTodos가 매번 update()를 불러줘야 코버플로우 3D 카드가 새 내용으로 다시 그려짐(사파리에서 리페인트 안 되는 버그 방지)
  const renderAllTodos = () => { dateCards.forEach(date => renderTodos(date.format('YYYY-MM-DD'))); if (swiper) swiper.update(); };

  // --- UNDO DELETE ---
  const showUndoToast = (text) => {
    const toast = document.getElementById('undo-toast');
    const label = document.getElementById('undo-toast-text');
    label.textContent = text;
    toast.classList.remove('hidden');
    clearTimeout(undoTimeoutId);
    undoTimeoutId = setTimeout(() => { toast.classList.add('hidden'); lastDeleted = null; }, 5000);
  };

  document.getElementById('btn-undo-action').addEventListener('click', () => {
    if (!lastDeleted) return;
    const { date, index, item } = lastDeleted;
    if (!todos[date]) todos[date] = [];
    todos[date].splice(index, 0, item);
    saveTodos(); renderTodos(date);
    document.getElementById('undo-toast').classList.add('hidden');
    lastDeleted = null;
    clearTimeout(undoTimeoutId);
    autoPushItem(item, date); // 노션에 다시 살아있는 상태로 복원
  });

  // --- ACTIONS ---
  document.body.addEventListener('click', (e) => {
    // Hamburger actions
    if (e.target.closest('#btn-hamburger')) { drawerOverlay.classList.remove('hidden'); drawerMenu.classList.add('open'); return; }
    if (e.target.closest('#btn-close-drawer') || e.target === drawerOverlay) { closeDrawer(); return; }
    if (e.target.closest('#menu-dark-mode')) { appSettings.darkMode = !appSettings.darkMode; saveSettings(); applySettings(); renderAllTodos(); return; }
    if (e.target.closest('#menu-theme')) { openModal('modal-theme'); populateThemeModal(); return; }
    if (e.target.closest('#menu-insights')) { openModal('modal-insights'); renderInsights(); return; }
    if (e.target.closest('#btn-emoticons')) { openModal('modal-emoticons'); initEmoticonSwiper(); return; }
    if (e.target.closest('#menu-routines')) { openModal('modal-routine-manager'); renderRoutines(); return; }
    if (e.target.closest('#menu-categories')) { openModal('modal-categories'); renderCategoriesModal(); return; }
    if (e.target.closest('#menu-pomo-settings')) { openModal('modal-pomo-settings'); return; }
    if (e.target.closest('#menu-export')) { exportCard(); return; }
    if (e.target.closest('#menu-backup')) { openModal('modal-backup'); return; }

    // Card Filter
    if (e.target.closest('.card-filter-btn')) {
      const date = e.target.closest('.card-filter-btn').dataset.date;
      document.getElementById(`filter-popup-${date}`).classList.toggle('show');
      return;
    }
    if (e.target.closest('.filter-option')) {
      const opt = e.target.closest('.filter-option');
      const date = opt.closest('.filter-popup').id.replace('filter-popup-', '');
      if (opt.dataset.type === 'all') { currentFilter = { categoryId: null, routineOnly: false }; }
      else if (opt.dataset.type === 'routine') { currentFilter = { categoryId: null, routineOnly: true }; }
      else if (opt.dataset.category) { currentFilter = { categoryId: opt.dataset.category, routineOnly: false }; }
      opt.closest('.filter-popup').classList.remove('show');
      renderTodos(date);
      return;
    }

    // Todo delete — with undo, and routine skip-once support
    const btnDel = e.target.closest('.btn-delete');
    if (btnDel) {
      const d = btnDel.dataset.date, i = parseInt(btnDel.dataset.index);
      const item = todos[d][i];
      if (item.routineId) {
        const rot = appSettings.routines.find(r => r.id === item.routineId);
        if (rot) { if (!rot.skipDates) rot.skipDates = []; rot.skipDates.push(d); saveSettings(); }
      }
      todos[d].splice(i, 1);
      lastDeleted = { date: d, index: i, item };
      saveTodos(); renderTodos(d);
      showUndoToast('할 일을 삭제했어요');
      if (item.notionPageId) autoDeleteItem(item.notionPageId);
      return;
    }

    // Click on todo text → inline edit
    const todoTextEl = e.target.closest('.todo-text');
    if (todoTextEl && !todoTextEl.isContentEditable) {
      const d = todoTextEl.dataset.date, i = parseInt(todoTextEl.dataset.index);
      if (d !== undefined && !isNaN(i)) {
        todoTextEl.contentEditable = true;
        todoTextEl.focus();
        const range = document.createRange(); range.selectNodeContents(todoTextEl); range.collapse(false);
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
        todoTextEl.onblur = () => {
          todoTextEl.contentEditable = false;
          if (todos[d] && todos[d][i] !== undefined) {
            todos[d][i].text = todoTextEl.innerText.trim();
            todos[d][i].updatedAt = Date.now();
            saveTodos();
            autoPushItem(todos[d][i], d);
          }
        };
        todoTextEl.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); todoTextEl.blur(); } };
        return;
      }
    }

    const btnLink = e.target.closest('.btn-link');
    if (btnLink) {
      linkMode = { sourceDate: btnLink.dataset.date, sourceIndex: parseInt(btnLink.dataset.index) };
      openModal('modal-highlight-category');
      populateHighlightModal();
      return;
    }

    if (e.target.closest('.btn-category')) {
      const btnCat = e.target.closest('.btn-category');
      linkMode = { sourceDate: btnCat.dataset.date, sourceIndex: parseInt(btnCat.dataset.index) };
      const currentTodo = todos[linkMode.sourceDate][linkMode.sourceIndex];
      const listEl = document.getElementById('category-assign-list');
      listEl.innerHTML = `
         <div class="category-assign-item" data-cid="" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;cursor:pointer;background:${!currentTodo.categoryId ? 'rgba(150,150,150,0.12)' : 'none'};">
           <div style="width:12px;height:12px;border-radius:50%;border:2px solid var(--border-color);"></div>
           <span style="font-size:13px;font-weight:500;">카테고리 없음</span>
         </div>
         ${appSettings.categories.map(c => `
           <div class="category-assign-item" data-cid="${c.id}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;cursor:pointer;background:${currentTodo.categoryId === c.id ? 'rgba(150,150,150,0.12)' : 'none'};">
             <div style="width:12px;height:12px;border-radius:50%;background:${c.color};"></div>
             <span style="font-size:13px;font-weight:500;">${c.name}</span>
             ${currentTodo.categoryId === c.id ? '<i data-lucide="check" style="width:14px;margin-left:auto;"></i>' : ''}
           </div>
         `).join('')}
       `;
      openModal('modal-assign-category');
      lucide.createIcons();
      listEl.querySelectorAll('.category-assign-item').forEach(item => {
        item.onclick = () => {
          const todo = todos[linkMode.sourceDate][linkMode.sourceIndex];
          todo.categoryId = item.dataset.cid || null;
          todo.updatedAt = Date.now();
          saveTodos(); renderTodos(linkMode.sourceDate); closeModal();
          autoPushItem(todo, linkMode.sourceDate);
        };
      });
      return;
    }

    const btnTimer = e.target.closest('.btn-timer') || e.target.closest('.pomodoro-badge');
    if (btnTimer) { startPomo(btnTimer.dataset.date, btnTimer.dataset.index); return; }

    // Subtask expand on content click
    if (e.target.closest('.todo-content') && !e.target.closest('.btn-timer') && !e.target.closest('.pomodoro-badge')) {
      const row = e.target.closest('.todo-item');
      if (row) row.classList.toggle('expanded');
    }
    if (e.target.closest('.btn-add-subtask')) {
      const b = e.target.closest('.btn-add-subtask');
      todos[b.dataset.date][b.dataset.index].subtasks.push({ text: '새 소항목', completed: false });
      todos[b.dataset.date][b.dataset.index].updatedAt = Date.now();
      saveTodos(); renderTodos(b.dataset.date);
      autoPushItem(todos[b.dataset.date][b.dataset.index], b.dataset.date);
      const row = document.querySelector(`#list-${b.dataset.date} .todo-item[data-index="${b.dataset.index}"]`);
      if (row) row.classList.add('expanded');
      setTimeout(() => {
        const newIdx = todos[b.dataset.date][b.dataset.index].subtasks.length - 1;
        const newEl = document.querySelector(`.subtask-text[data-date="${b.dataset.date}"][data-parent="${b.dataset.index}"][data-index="${newIdx}"]`);
        if (newEl) { newEl.focus(); const range = document.createRange(); range.selectNodeContents(newEl); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); }
      }, 50);
      return;
    }
    if (e.target.closest('.btn-subtask-edit')) {
      const btn = e.target.closest('.btn-subtask-edit');
      const el = document.querySelector(`.subtask-text[data-date="${btn.dataset.date}"][data-parent="${btn.dataset.parent}"][data-index="${btn.dataset.index}"]`);
      if (el) { el.focus(); const range = document.createRange(); range.selectNodeContents(el); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); }
      return;
    }
    if (e.target.closest('.btn-subtask-delete')) {
      const btn = e.target.closest('.btn-subtask-delete');
      todos[btn.dataset.date][btn.dataset.parent].subtasks.splice(parseInt(btn.dataset.index), 1);
      todos[btn.dataset.date][btn.dataset.parent].updatedAt = Date.now();
      saveTodos(); renderTodos(btn.dataset.date);
      autoPushItem(todos[btn.dataset.date][btn.dataset.parent], btn.dataset.date);
      return;
    }

    if (e.target.closest('.btn-day-toggle')) {
      e.target.closest('.btn-day-toggle').classList.toggle('active');
    }

    if (e.target.closest('.btn-delete-small')) {
      const btn = e.target.closest('.btn-delete-small');
      if (btn.dataset.type === 'routine') {
        appSettings.routines = appSettings.routines.filter(r => r.id !== btn.dataset.id);
        renderRoutines(); saveSettings();
      } else if (btn.dataset.type === 'category') {
        const deletedId = btn.dataset.id;
        const affected = [];
        Object.keys(todos).forEach(date => {
          todos[date].forEach(todo => {
            if (todo.categoryId === deletedId) { todo.categoryId = null; todo.updatedAt = Date.now(); affected.push({ date, todo }); }
          });
        });
        saveTodos();
        appSettings.categories = appSettings.categories.filter(c => c.id !== deletedId);
        renderCategoriesModal(); saveSettings();
        renderAllTodos();
        affected.forEach(({ date, todo }) => autoPushItem(todo, date));
      }
    }

    // Modal Specific
    if (e.target === modalOverlay) closeModal();
    if (e.target.closest('.close-modal')) closeModal();
  });

  const closeDrawer = () => { drawerOverlay.classList.add('hidden'); drawerMenu.classList.remove('open'); };
  const openModal = id => { document.querySelectorAll('.modal-content').forEach(m => m.classList.add('hidden')); document.getElementById(id).classList.remove('hidden'); modalOverlay.classList.remove('hidden'); closeDrawer(); };
  const closeModal = () => modalOverlay.classList.add('hidden');

  // --- APP TITLE (fix: was never saved before) ---
  titleInput.addEventListener('blur', () => {
    const val = titleInput.value.trim() || 'Daily';
    titleInput.value = val;
    appSettings.title = val;
    saveSettings();
  });
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') titleInput.blur(); });

  // Input Handlers
  document.body.addEventListener('submit', (e) => {
    if (e.target.classList.contains('add-todo-form')) {
      e.preventDefault();
      const d = e.target.dataset.date, input = e.target.querySelector('.add-todo-input'), text = input.value.trim();
      if (text) {
        const newTodo = {
          id: generateId(), text, completed: false, linkColor: null, categoryId: null,
          subtasks: [], pomoTime: 0, pomoActive: false, pomoEndAt: null,
          updatedAt: Date.now(), notionPageId: null
        };
        todos[d].push(newTodo);
        saveTodos(); renderTodos(d); input.value = '';
        if (appSettings.uiSounds) sounds.click.play();
        autoPushItem(newTodo, d);
      }
    }
  });

  document.body.addEventListener('change', (e) => {
    if (e.target.classList.contains('todo-checkbox')) {
      const cb = e.target, d = cb.dataset.date, i = parseInt(cb.dataset.index);
      todos[d][i].completed = cb.checked;
      todos[d][i].updatedAt = Date.now();
      saveTodos(); renderTodos(d);
      autoPushItem(todos[d][i], d);
    }
    if (e.target.classList.contains('subtask-checkbox')) {
      const cb = e.target, d = cb.dataset.date, p = cb.dataset.parent, i = cb.dataset.index;
      todos[d][p].subtasks[i].completed = cb.checked;
      todos[d][p].updatedAt = Date.now();
      saveTodos(); renderTodos(d);
      autoPushItem(todos[d][p], d);
    }
  });

  // Subtask text edits (contenteditable) → save on blur
  document.body.addEventListener('focusout', (e) => {
    if (e.target.classList.contains('subtask-text')) {
      const el = e.target, d = el.dataset.date, p = el.dataset.parent, i = el.dataset.index;
      if (todos[d] && todos[d][p] && todos[d][p].subtasks[i]) {
        todos[d][p].subtasks[i].text = el.innerText.trim();
        todos[d][p].updatedAt = Date.now();
        saveTodos();
        autoPushItem(todos[d][p], d);
      }
    }
  });

  // Highlighter Modal Logic — instant apply on swatch click
  const populateHighlightModal = () => {
    catSwatches.innerHTML = '';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'swatch none-swatch';
    clearBtn.title = '지우기';
    clearBtn.innerHTML = '<i data-lucide="slash" style="width:14px;height:14px;"></i>';
    clearBtn.onclick = () => {
      const todo = todos[linkMode.sourceDate][linkMode.sourceIndex];
      todo.linkColor = null; todo.updatedAt = Date.now();
      saveTodos(); renderTodos(linkMode.sourceDate); closeModal();
    };
    catSwatches.appendChild(clearBtn);

    const colors = [
      '255, 235, 59', '255, 87, 87', '0, 200, 120', '255, 152, 0', '0, 190, 255',
      '167, 255, 235', '224, 191, 255', '255, 218, 185', '186, 225, 255', '255, 255, 186',
      '255, 200, 220', '200, 230, 255', '210, 255, 210', '255, 235, 200'
    ];
    const currentTodo = todos[linkMode.sourceDate][linkMode.sourceIndex];
    colors.forEach(rgb => {
      const btn = document.createElement('button');
      btn.className = 'swatch link-swatch';
      btn.style.background = `rgb(${rgb})`;
      btn.dataset.rgb = rgb;
      if (currentTodo.linkColor === rgb) btn.style.boxShadow = '0 0 0 2.5px var(--text-main)';
      btn.onclick = () => {
        const todo = todos[linkMode.sourceDate][linkMode.sourceIndex];
        todo.linkColor = rgb; todo.updatedAt = Date.now();
        saveTodos(); renderTodos(linkMode.sourceDate); closeModal();
      };
      catSwatches.appendChild(btn);
    });
    lucide.createIcons();
  };

  const renderCategoriesModal = () => {
    const listContainer = document.getElementById('category-list-container');
    listContainer.innerHTML = appSettings.categories.map(c => `
      <div class="routine-row">
        <span><div style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${c.color};margin-right:8px;"></div>${c.name}</span>
        <button class="btn-delete-small" data-type="category" data-id="${c.id}"><i data-lucide="trash-2" style="width:14px;"></i></button>
      </div>
    `).join('');

    const swatchContainer = document.getElementById('new-category-color');
    swatchContainer.innerHTML = '';
    selectedCategoryHue = -1;
    const hues = [
      { h: 210, s: 100, l: 55 }, { h: 340, s: 90, l: 58 }, { h: 150, s: 80, l: 48 }, { h: 40, s: 100, l: 55 }, { h: 280, s: 80, l: 60 },
      { h: 195, s: 60, l: 75 }, { h: 350, s: 60, l: 78 }, { h: 160, s: 50, l: 73 }, { h: 50, s: 70, l: 78 }, { h: 260, s: 55, l: 78 },
      { h: 30, s: 55, l: 80 }, { h: 100, s: 40, l: 78 }, { h: 230, s: 45, l: 80 }, { h: 310, s: 40, l: 80 }
    ];
    hues.forEach(({ h, s, l }) => {
      const btn = document.createElement('button'); btn.className = 'swatch';
      btn.style.background = `hsl(${h}, ${s}%, ${l}%)`;
      btn.onclick = () => {
        swatchContainer.querySelectorAll('.swatch').forEach(sb => { sb.classList.remove('active'); sb.style.boxShadow = 'none'; });
        btn.classList.add('active');
        selectedCategoryHue = { h, s, l };
        btn.style.boxShadow = '0 0 0 2.5px var(--text-main)';
      };
      swatchContainer.appendChild(btn);
    });
    lucide.createIcons();
  };

  document.getElementById('btn-add-category-action').onclick = () => {
    const text = document.getElementById('new-category-name').value.trim();
    if (text && selectedCategoryHue !== -1) {
      const { h, s, l } = selectedCategoryHue;
      appSettings.categories.push({ id: generateId(), name: text, color: `hsl(${h}, ${s}%, ${l}%)` });
      document.getElementById('new-category-name').value = '';
      selectedCategoryHue = -1;
      renderCategoriesModal(); saveSettings();
    } else if (text && selectedCategoryHue === -1) {
      alert('색상을 선택해주세요!');
    }
  };

  // --- POMODORO (fixed: persists across reload via a real end-timestamp) ---
  const tickPomo = (dateStr, idx) => {
    const todo = todos[dateStr][idx];
    if (!todo || !todo.pomoActive) return;
    const remaining = Math.max(0, Math.round((todo.pomoEndAt - Date.now()) / 1000));
    todo.pomoTime = remaining;
    if (remaining > 0) {
      const ring = document.querySelector(`.pomodoro-badge[data-date="${dateStr}"][data-index="${idx}"] .pomo-ring-progress`);
      if (ring) {
        let offset = 43.98 - (remaining / (appSettings.pomoDuration * 60)) * 43.98;
        ring.style.strokeDashoffset = offset;
      }
    } else {
      todo.pomoActive = false; todo.pomoEndAt = null;
      clearInterval(activeTimers[`${dateStr}-${idx}`]);
      if (appSettings.uiSounds) sounds.milestone.play();
      alert(`집중 완료: ${todo.text}`);
      saveTodos(); renderTodos(dateStr);
    }
  };

  const startPomo = (dateStr, idx) => {
    const todo = todos[dateStr][idx];
    if (todo.pomoActive) {
      todo.pomoActive = false; todo.pomoEndAt = null;
      clearInterval(activeTimers[`${dateStr}-${idx}`]);
    } else {
      todo.pomoActive = true;
      const remaining = todo.pomoTime > 0 ? todo.pomoTime : appSettings.pomoDuration * 60;
      todo.pomoTime = remaining;
      todo.pomoEndAt = Date.now() + remaining * 1000;
      activeTimers[`${dateStr}-${idx}`] = setInterval(() => tickPomo(dateStr, idx), 1000);
    }
    todo.updatedAt = Date.now();
    saveTodos(); renderTodos(dateStr);
  };

  // On load, resume any timers that were still running when the page was last closed,
  // instead of leaving them frozen with a stale ring until manually toggled.
  const restoreActiveTimers = () => {
    Object.keys(todos).forEach(dateStr => {
      (todos[dateStr] || []).forEach((todo, idx) => {
        if (todo.pomoActive && todo.pomoEndAt) {
          const remaining = Math.round((todo.pomoEndAt - Date.now()) / 1000);
          if (remaining <= 0) {
            todo.pomoActive = false; todo.pomoEndAt = null; todo.pomoTime = 0;
          } else {
            todo.pomoTime = remaining;
            activeTimers[`${dateStr}-${idx}`] = setInterval(() => tickPomo(dateStr, idx), 1000);
          }
        }
      });
    });
    saveTodos();
  };

  pomoSlider.oninput = () => { pomoDisplay.innerText = pomoSlider.value; appSettings.pomoDuration = parseInt(pomoSlider.value); saveSettings(); };

  // --- ROUTINES ---
  const renderRoutines = () => {
    routineListContainer.innerHTML = appSettings.routines.map(r => {
      let daysDisplay = r.days ? r.days.map(d => (['일', '월', '화', '수', '목', '금', '토'][d])).join(',') : r.freq;
      return `
      <div class="routine-row">
        <span>[${daysDisplay}] ${r.text}</span>
        <button class="btn-delete-small" data-type="routine" data-id="${r.id}"><i data-lucide="trash-2" style="width:14px;"></i></button>
      </div>`;
    }).join('');
    lucide.createIcons();
  };

  document.getElementById('btn-add-routine-action').onclick = () => {
    const text = document.getElementById('new-routine-input').value.trim();
    const activeDays = Array.from(document.querySelectorAll('.btn-day-toggle.active')).map(btn => parseInt(btn.dataset.day));
    if (text && activeDays.length > 0) {
      appSettings.routines.push({ id: generateId(), text, days: activeDays, skipDates: [] });
      document.getElementById('new-routine-input').value = ''; saveSettings(); renderRoutines();
    } else if (text && activeDays.length === 0) {
      alert('요일을 하나 이상 선택해주세요!');
    }
  };

  document.body.addEventListener('click', (e2) => {
    const preset = e2.target.closest('.btn-routine-preset');
    if (!preset) return;
    const all = document.querySelectorAll('.btn-day-toggle');
    const val = preset.dataset.preset;
    if (val === 'daily') all.forEach(b => b.classList.add('active'));
    else if (val === 'weekday') all.forEach(b => { b.classList.remove('active'); if ([1, 2, 3, 4, 5].includes(parseInt(b.dataset.day))) b.classList.add('active'); });
    else if (val === 'weekend') all.forEach(b => { b.classList.remove('active'); if ([0, 6].includes(parseInt(b.dataset.day))) b.classList.add('active'); });
  });

  // --- INSIGHTS ---
  const renderInsights = () => {
    const stats = document.getElementById('insight-stats');
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = todayDate.subtract(i, 'day').format('YYYY-MM-DD');
      const dayTodos = todos[d] || [];
      const compl = dayTodos.filter(t => t.completed).length;
      const total = dayTodos.length;
      const pct = total === 0 ? 0 : Math.round((compl / total) * 100);
      last7Days.push({ label: todayDate.subtract(i, 'day').format('DD일'), pct });
    }

    stats.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-end; height:150px; padding-top:20px; border-bottom:1px solid var(--border-color); margin-bottom:12px;">
          ${last7Days.map(d => `
            <div style="display:flex; flex-direction:column; align-items:center; width: 12%;">
               <div style="font-size:10px; color:var(--text-muted); margin-bottom:4px; font-weight: 600;">${d.pct}%</div>
               <div style="width:100%; height:${d.pct}px; background-color:var(--accent-color); border-radius:4px 4px 0 0; opacity: ${d.pct === 0 ? 0.1 : 1}; transition: height 0.5s;"></div>
            </div>
          `).join('')}
        </div>
        <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--text-muted);">
          ${last7Days.map(d => `<div style="width: 12%; text-align:center; font-weight:600;">${d.label}</div>`).join('')}
        </div>
      `;
  };

  // Theme Swatches — store exact color string, instant apply
  const populateThemeModal = () => {
    const container = document.getElementById('theme-swatches');
    container.innerHTML = '';
    const palette = [
      { h: 210, s: 100, l: 55 }, { h: 340, s: 90, l: 55 }, { h: 150, s: 80, l: 44 }, { h: 40, s: 100, l: 52 }, { h: 280, s: 80, l: 58 },
      { h: 10, s: 90, l: 55 }, { h: 180, s: 70, l: 44 }, { h: 120, s: 60, l: 44 }, { h: 250, s: 80, l: 60 }, { h: 300, s: 70, l: 55 },
      { h: 200, s: 55, l: 72 }, { h: 350, s: 55, l: 78 }, { h: 160, s: 45, l: 70 }, { h: 45, s: 65, l: 78 }, { h: 260, s: 50, l: 76 },
      { h: 20, s: 60, l: 78 }, { h: 80, s: 45, l: 72 }, { h: 320, s: 40, l: 76 }, { h: 190, s: 50, l: 72 }, { h: 100, s: 45, l: 72 },
      { h: 0, s: 0, l: 55 }
    ];
    palette.forEach(({ h, s, l }) => {
      const colorStr = `hsl(${h}, ${s}%, ${l}%)`;
      const b = document.createElement('button'); b.className = 'swatch';
      b.style.background = colorStr;
      const isActive = (appSettings.accentColor === colorStr);
      if (isActive) { b.style.boxShadow = '0 0 0 2.5px var(--text-main)'; b.classList.add('active'); }
      b.onclick = () => {
        appSettings.accentColor = colorStr;
        appSettings.accentHue = h;
        saveSettings(); applySettings();
        closeModal();
      };
      container.appendChild(b);
    });
  };

  // --- SEARCH ---
  const searchBar = document.getElementById('search-bar');
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');

  document.getElementById('btn-search').addEventListener('click', () => {
    searchBar.classList.remove('hidden');
    searchInput.focus();
  });
  document.getElementById('btn-search-close').addEventListener('click', () => {
    searchBar.classList.add('hidden');
    searchResults.classList.add('hidden');
    searchInput.value = '';
  });

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) { searchResults.classList.add('hidden'); searchResults.innerHTML = ''; return; }
    const matches = [];
    Object.keys(todos).sort().forEach(dateStr => {
      (todos[dateStr] || []).forEach(t => {
        if (t.text.toLowerCase().includes(q)) matches.push({ dateStr, text: t.text, completed: t.completed });
      });
    });
    if (matches.length === 0) {
      searchResults.innerHTML = `<div style="padding:16px; text-align:center; color:var(--text-muted); font-size:12px;">검색 결과가 없어요</div>`;
    } else {
      searchResults.innerHTML = matches.slice(0, 30).map(m => `
        <div class="search-result-item" data-date="${m.dateStr}">
          <span class="search-result-date">${dayjs(m.dateStr).format('MM/DD')}</span>
          <span style="${m.completed ? 'text-decoration:line-through;color:var(--text-muted);' : ''}">${escapeHtml(m.text)}</span>
        </div>
      `).join('');
    }
    searchResults.classList.remove('hidden');
  });

  searchResults.addEventListener('click', (e) => {
    const item = e.target.closest('.search-result-item');
    if (!item) return;
    const diff = dayjs(item.dataset.date).diff(todayDate, 'day');
    if (diff >= -30 && diff <= 30) swiper.slideTo(diff + 30, 400);
    searchBar.classList.add('hidden'); searchResults.classList.add('hidden'); searchInput.value = '';
  });

  // --- BACKUP / RESTORE ---
  document.getElementById('btn-backup-export').addEventListener('click', () => {
    const payload = { version: 1, exportedAt: new Date().toISOString(), todos, appSettings };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `daily-backup-${dayjs().format('YYYYMMDD-HHmm')}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  const backupFileInput = document.getElementById('backup-file-input');
  document.getElementById('btn-backup-import').addEventListener('click', () => backupFileInput.click());
  backupFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.todos || !data.appSettings) throw new Error('invalid file');
        if (!confirm('현재 데이터를 불러온 백업으로 덮어씌울까요? 되돌릴 수 없어요.')) return;
        todos = data.todos;
        appSettings = data.appSettings;
        if (!appSettings.routines) appSettings.routines = [];
        if (!appSettings.categories) appSettings.categories = [];
        appSettings.routines.forEach(r => { if (!r.skipDates) r.skipDates = []; });
        Object.keys(todos).forEach(dateStr => {
          (todos[dateStr] || []).forEach(t => {
            if (!t.id) t.id = generateId();
            if (!t.subtasks) t.subtasks = [];
            if (t.notionPageId === undefined) t.notionPageId = null;
          });
        });
        saveTodos(); saveSettings();
        applySettings(); renderAllTodos();
        closeModal();
        alert('백업을 불러왔어요!');
      } catch (err) {
        alert('올바른 백업 파일이 아니에요.');
      }
      backupFileInput.value = '';
    };
    reader.readAsText(file);
  });

  // --- NOTION SYNC ---
  const serializeSubtasks = (subtasks) => (subtasks || []).map(st => `${st.completed ? '☑' : '☐'} ${st.text}`).join('\n');
  const parseSubtasks = (text) => (text || '').split('\n').map(line => line.trim()).filter(Boolean).map(line => ({
    completed: line.startsWith('☑'),
    text: line.replace(/^[☑☐]\s*/, '')
  }));
  const categoryNameById = (id) => { const c = appSettings.categories.find(c => c.id === id); return c ? c.name : ''; };
  const categoryIdByName = (name) => { const c = appSettings.categories.find(c => c.name === name); return c ? c.id : null; };

  const flattenTodos = () => {
    const flat = [];
    Object.keys(todos).forEach(dateStr => {
      (todos[dateStr] || []).forEach((t, idx) => flat.push({ dateStr, idx, todo: t }));
    });
    return flat;
  };

  const toItemPayload = (todo, dateStr) => ({
    appId: todo.id,
    notionPageId: todo.notionPageId || null,
    name: todo.text,
    date: dateStr,
    completed: todo.completed,
    category: categoryNameById(todo.categoryId),
    routine: !!todo.routineId,
    subtasks: serializeSubtasks(todo.subtasks),
    updatedAt: new Date(todo.updatedAt || Date.now()).toISOString()
  });

  let syncActivityCount = 0;
  const setSyncIcon = (active) => {
    syncActivityCount = Math.max(0, syncActivityCount + (active ? 1 : -1));
    const icon = document.querySelector('#menu-notion-sync i');
    if (icon) icon.style.animation = syncActivityCount > 0 ? 'spin 1s linear infinite' : '';
  };

  // 항목 하나가 바뀔 때마다 조용히 노션으로 보내요 (버튼 없이 자동). 실패해도 알림창은 안 띄우고
  // 다음 변경이나 주기적 동기화 때 다시 시도돼요 — 매 타이핑마다 에러 팝업이 뜨면 방해되니까요.
  const autoPushItem = async (todo, dateStr) => {
    setSyncIcon(true);
    try {
      const r = await fetch('/api/notion?app=todo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [toItemPayload(todo, dateStr)] })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '업로드 실패');
      const result = (data.results || [])[0];
      if (result && result.notionPageId) {
        todo.notionPageId = result.notionPageId;
        saveTodos();
      }
    } catch (err) {
      console.warn('노션 자동 동기화 실패(조용히 재시도됨):', err.message);
    } finally {
      setSyncIcon(false);
    }
  };

  // 항목이 삭제되면 노션 쪽 페이지도 자동으로 보관 처리(삭제)돼요
  const autoDeleteItem = async (notionPageId) => {
    setSyncIcon(true);
    try {
      await fetch('/api/notion?app=todo', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: notionPageId })
      });
    } catch (err) {
      console.warn('노션 자동 삭제 실패(조용히 재시도됨):', err.message);
    } finally {
      setSyncIcon(false);
    }
  };

  // 사용자가 지금 뭔가 입력 중이면(할 일 텍스트, 소항목, 제목 등) 그 사이에 원격 데이터로
  // 화면을 다시 그리면 입력 중이던 내용이 날아갈 수 있어서, 그럴 땐 이번 주기는 건너뛰어요.
  const isEditingSomething = () => {
    const ae = document.activeElement;
    return !!ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
  };

  // 노션에서 생기거나 바뀐 내용을 앱으로 가져와요. silent=true면 알림창 없이 조용히 처리돼요
  // (백그라운드 자동 동기화용), false면 결과를 alert로 알려줘요 (수동 버튼용).
  const pullFromNotion = async (silent) => {
    const pullRes = await fetch('/api/notion?app=todo');
    const pullData = await pullRes.json();
    if (!pullRes.ok) throw new Error(pullData.error || '다운로드 실패');

    const localById = {};
    flattenTodos().forEach(({ dateStr, idx, todo }) => { localById[todo.id] = { dateStr, idx, todo }; });
    let changed = false;

    (pullData.items || []).forEach(row => {
      if (!row.appId) return; // App ID 없는 행(노션에서 수동으로 추가한 행)은 건너뜀
      const existing = localById[row.appId];
      const remoteTime = row.lastUpdated ? new Date(row.lastUpdated).getTime() : 0;

      if (existing) {
        const localTime = existing.todo.updatedAt || 0;
        if (remoteTime > localTime) {
          existing.todo.text = row.name;
          existing.todo.completed = row.completed;
          existing.todo.categoryId = categoryIdByName(row.category) || existing.todo.categoryId;
          existing.todo.subtasks = parseSubtasks(row.subtasks);
          existing.todo.notionPageId = row.notionPageId;
          existing.todo.updatedAt = remoteTime;
          changed = true;
        }
      } else if (row.date) {
        if (!todos[row.date]) todos[row.date] = [];
        todos[row.date].push({
          id: row.appId, text: row.name, completed: row.completed,
          categoryId: categoryIdByName(row.category), routineId: null,
          linkColor: null, subtasks: parseSubtasks(row.subtasks),
          pomoTime: 0, pomoActive: false, pomoEndAt: null,
          updatedAt: remoteTime || Date.now(), notionPageId: row.notionPageId
        });
        changed = true;
      }
    });

    if (changed) saveTodos();
    return changed;
  };

  // 수동 "전체 동기화" 버튼 — 로컬에 있는 걸 전부 올리고, 노션 쪽 최신 내용을 받아와요
  const syncWithNotion = async () => {
    setSyncIcon(true);
    try {
      const flat = flattenTodos();
      if (flat.length > 0) {
        const pushItems = flat.map(({ dateStr, todo }) => toItemPayload(todo, dateStr));
        const pushRes = await fetch('/api/notion?app=todo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: pushItems })
        });
        const pushData = await pushRes.json();
        if (!pushRes.ok) throw new Error(pushData.error || '업로드 실패');
        const idToPageId = {};
        (pushData.results || []).forEach(r => { idToPageId[r.appId] = r.notionPageId; });
        flat.forEach(({ dateStr, idx }) => {
          const t = todos[dateStr][idx];
          if (idToPageId[t.id]) t.notionPageId = idToPageId[t.id];
        });
        saveTodos();
      }
      const pullChanged = await pullFromNotion(false);
      const rolloverChanged = rolloverIncompleteTodos();
      if (pullChanged || rolloverChanged || flat.length > 0) renderAllTodos();
      alert('노션과 동기화됐어요!');
    } catch (err) {
      alert(`동기화 실패: ${err.message}`);
    } finally {
      setSyncIcon(false);
    }
  };

  document.getElementById('menu-notion-sync').addEventListener('click', syncWithNotion);

  // 버튼 없이도 자동으로 동기화되도록: 30초마다 노션 쪽 변경사항을 조용히 가져와요.
  // (앱에서 뭔가 바뀔 때는 각 동작이 바로바로 autoPushItem/autoDeleteItem을 호출해서 올려요.)
  // 실제로 뭔가 바뀌었을 때만, 그리고 스와이프 중이 아닐 때만 다시 그려서 불필요한 렌더링을 줄여요.
  setInterval(() => {
    if (isEditingSomething() || isSwiping) return; // 입력/스와이프 중이면 이번 주기는 건너뜀
    pullFromNotion(true)
      .then((pullChanged) => {
        const rolloverChanged = rolloverIncompleteTodos();
        if (pullChanged || rolloverChanged) renderAllTodos();
      })
      .catch(err => console.warn('백그라운드 노션 동기화 실패:', err.message));
  }, 30000);

  // --- EMOTICON PICKER ---
  const EMOTICON_CATEGORIES = [
    {
      name: '(*^▽^*)', label: '기쁨',
      items: ['(◕ω◕)', '(●\'◡\'●)', '(＾▽＾)', '(◠‿◠)', 'ε^∀^3', '(*^▽^*)', '(≧◡≦)', 'ヽ(^o^)丿',
        '(ﾉ>ω<)ﾉ', '(◍•ᴗ•◍)', '(^_^)v', '(≧∇≦)/', '(^ω^)', '(☆ω☆)', '(*˘▽˘*)', '(ﾉ≧ω≦)ﾉ',
        '(*≧ω≦*)', 'ヾ(・ω・*)', '(o^▽^o)', '(^•ω•^)', '(>ω<)', '(ﾉ◕ᗨ◕)ﾉ', 'ヾ(^∀^)ﾉ',
        '(*^ω^*)', '(*ﾟ∀ﾟ*)', '(｀∀´)Ψ', '(⊃｡•́‿•̀｡)⊃', '(ﾉ>▽<)ﾉ', '(*≧▽≦*)', '(ᵔᴥᵔ)']
    },
    {
      name: '(♡˙︶˙♡)', label: '사랑',
      items: ['(♡˙︶˙♡)', '(◕‿◕)♡', '(づ｡◕‿‿◕｡)づ', '(˘ε˘ʃƪ)', '(♡>ω<♡)', '(｡♥‿♥｡)',
        '(´∀｀)♡', '(*ˆ³ˆ)/♡', 'ε=ε=♡', '(●♡∀♡ʃ)', '(ˆ ω ˆ)♡', '(♡ ^▽^ ♡)',
        '(*´∀｀)ﾉﾞ♡', '(≧◡≦)♡', '(♡°▽°♡)', '(♡ω♡)', '(◕▿◕)♡', '(♡ >ᴗ•)', '(´ε｀♡)',
        '(づ ◡ ‿ ◡)づ', '(/^▽^)/♡', '(ノ´ヮ´)ノ♡', '♡(˘▽˘>ԅ( ˘⌣˘)', '(☆▽☆)', '♡(◡‿◡✿)']
    },
    {
      name: '(=^･ω･^=)', label: '동물',
      items: ['(=^･ω･^=)', '(ฅ^•ﻌ•^ฅ)', '(^=◕ᴥ◕=^)', 'ʕ•ᴥ•ʔ', '(=^▽^=)', '(￣(ｴ)￣)',
        '(*ΦωΦ*)', '（=\'\'=）', '(ᵔᴥᵔ)', '=^..^=', '( ̳•ᴥ• ̳)', 'ʕっ•ᴥ•ʔっ',
        '(=^ ^=)', '(ΦωΦ)', '(=^o.o^=)', '꒰( ◍•ᴗ•◍ )꒱', '(✿◠‿◠)', '(ᵕ̣̣̣̣̣̣﹏ᵕ̣̣̣̣̣̣)', '(＾• ω •＾)',
        '(^• ω •^)', '(๑˃ᴗ˂)ﻌ', '(◕ᴥ◕ʋ)', '(ฅ•ω•ฅ)', '(=｀ω´=)', '(▼・ᴥ・▼)']
    },
    {
      name: '☆彡', label: '꾸미기',
      items: ['☆彡', '★彡', '✦', '✧', '∽', '≈', '∞', '☽', '☾', '✿', '❀', '❁', '✾', '✽', '❃', '❋', '❊',
        '✤', '✢', '✣', '✥', '❈', '✩', '✪', '✫', '✬', '✭', '☀', '⛅', '❄', '⛄', '☂', '☔', '☁',
        '彡★', '٩(◕‿◕)۶', '*✲゚*', '~♪', '♩♪♫♬', '•ੈ✩‧₊˚', '⋆｡°✩', '˘͈ᵕ˘͈', '°˖✧◝(⁰▿⁰)◜✧˖°']
    },
    {
      name: '(╯°□°）╯', label: '감정',
      items: ['(；゜゜)', '(；Д；)', '(T_T)', '(；ω；)', '(○□○)', '(╥_╥)', 'ヽ(´□｀。)ノ',
        '(╯°□°）╯', '(¬_¬)', '(꒪ꇴ꒪)', '「(°ヘ°)', '(눈_눈)', '(⊙_⊙)', '(⊙ω⊙)',
        '(*ﾟДﾟ)', '(´Д｀)', 'ヽ(ˋωˊ)ﾉ', '(°ロ°)☝', 'w(°ﾟ□ﾟ°)w', '(o_O)',
        '(ﾟoﾟ;;', '(；・∀・)', '(・∀・)', '(≖_≖)', '╮(╯_╰)╭', '•_•)', '( •_•)>⌐■-■']
    },
    {
      name: '( ´ᵕ`)', label: '귀여움',
      items: ['( ´ᵕ`)', '(。◕‿◕。)', '( ´◡` )', '( ᵕ ᵕ̣̣ )', '(˵ ͡° ͜ʖ ͡°˵)', 'ʕ•ᴗ•ʔ', '(◍ ´꒳` ◍)',
        '(´∩｀。)', '( ˘ᵕ˘ )', '(o˘◡˘o)', '( ˘͈ ᵕ ˘͈ )', '(◠◡◠✿)', '( •ᴗ• )', '꒰ᵔ ༝ ᵔ꒱',
        '(´ᗒᗨᗕ`)', '( ´ ▽ ` )', '(◡‿◡✿)', '( ´ ∀ `)', '(˘▽˘)', '(◦ᵕ ˘ᵕ◦)',
        '(˃̣̣̥ω˂̣̣̥)', 'ʕ·ᴥ·`ʔ', '(＾▽＾)/', '(●´□`)♡', '(๑´ᵕ`๑)']
    }
  ];

  let emoticonSwiper = null;

  const initEmoticonSwiper = () => {
    const wrapper = document.getElementById('emoticon-swiper-wrapper');
    wrapper.innerHTML = '';

    EMOTICON_CATEGORIES.forEach((cat) => {
      const slide = document.createElement('div');
      slide.className = 'swiper-slide';
      slide.style.cssText = 'display:flex;flex-direction:column;height:100%;padding:16px;box-sizing:border-box;';

      const catTitle = document.createElement('div');
      catTitle.style.cssText = 'font-size:14px;font-weight:700;color:var(--accent-color);text-align:center;margin-bottom:12px;';
      catTitle.textContent = cat.label;

      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:6px;overflow-y:auto;flex:1;';

      cat.items.forEach(em => {
        const btn = document.createElement('button');
        btn.style.cssText = 'background:rgba(150,150,150,0.06);border:1px solid var(--border-color);border-radius:12px;padding:8px 4px;font-size:11px;cursor:pointer;color:var(--text-main);transition:background 0.15s,transform 0.1s;word-break:keep-all;line-height:1.4;';
        btn.textContent = em;
        btn.title = em;
        btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(150,150,150,0.15)'; btn.style.transform = 'scale(1.05)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(150,150,150,0.06)'; btn.style.transform = 'scale(1)'; });
        btn.addEventListener('click', (ev) => { ev.stopPropagation(); copyEmoticon(em); });
        grid.appendChild(btn);
      });

      slide.appendChild(catTitle);
      slide.appendChild(grid);
      wrapper.appendChild(slide);
    });

    if (emoticonSwiper && !emoticonSwiper.destroyed) emoticonSwiper.destroy(true, true);

    emoticonSwiper = new Swiper('.emoticon-swiper', {
      slidesPerView: 1,
      grabCursor: true,
      on: { slideChange: updateEmoticonPagination, init: updateEmoticonPagination }
    });

    const prevBtn = document.getElementById('emoticon-prev');
    const nextBtn = document.getElementById('emoticon-next');
    if (prevBtn) prevBtn.onclick = () => emoticonSwiper.slidePrev();
    if (nextBtn) nextBtn.onclick = () => emoticonSwiper.slideNext();
  };

  const updateEmoticonPagination = () => {
    if (!emoticonSwiper) return;
    const total = EMOTICON_CATEGORIES.length;
    const active = emoticonSwiper.activeIndex;
    const pag = document.querySelector('.emoticon-pagination');
    if (!pag) return;
    pag.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const dot = document.createElement('div');
      dot.style.cssText = `width:${i === active ? '20px' : '7px'};height:7px;border-radius:4px;background:${i === active ? 'var(--accent-color)' : 'var(--border-color)'};transition:all 0.2s;cursor:pointer;`;
      dot.onclick = () => emoticonSwiper.slideTo(i);
      pag.appendChild(dot);
    }
  };

  const copyEmoticon = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      const toast = document.getElementById('emoticon-copy-toast');
      if (!toast) return;
      toast.textContent = `✓ 복사됨  ${text}`;
      toast.style.display = 'block';
      setTimeout(() => { toast.style.display = 'none'; }, 1500);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      const toast = document.getElementById('emoticon-copy-toast');
      if (toast) { toast.textContent = `✓ 복사됨  ${text}`; toast.style.display = 'block'; setTimeout(() => { toast.style.display = 'none'; }, 1500); }
    });
  };

  // --- SHARE / EXPORT CARD ---
  const exportCard = () => {
    const activeSlide = document.querySelector('.swiper-slide-active .todo-card');
    if (!activeSlide || !window.html2canvas) return;
    html2canvas(activeSlide, { backgroundColor: null, scale: 2 }).then(canvas => {
      const link = document.createElement('a');
      link.download = `daily-${activeSlide.dataset.date}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    });
  };

  function escapeHtml(unsafe) { return unsafe?.replace(/&/g, "&amp;")?.replace(/</g, "&lt;")?.replace(/>/g, "&gt;")?.replace(/"/g, "&quot;")?.replace(/'/g, "&#039;") || ""; }

  applySettings();
  rolloverIncompleteTodos(); // 우선 로컬에 있는 데이터 기준으로 즉시 한 번 처리
  dateCards.forEach(date => swiperWrapper.appendChild(createCardElement(date)));

  // 혹시라도 새로고침되더라도 보고 있던 날짜로 돌아오도록, 마지막 위치를 기억해둠
  let isSwiping = false;
  const savedSlide = parseInt(sessionStorage.getItem('swipe-last-slide') || '30', 10);
  const startSlide = (savedSlide >= 0 && savedSlide <= 60) ? savedSlide : 30;

  swiper = new Swiper('.todo-swiper', {
    effect: 'coverflow', centeredSlides: true, slidesPerView: 'auto', initialSlide: startSlide,
    coverflowEffect: { rotate: 0, stretch: -30, depth: 150, modifier: 1, slideShadows: false },
    on: {
      slideChange: function () {
        btnToday.classList.toggle('hidden', this.activeIndex === 30);
        sessionStorage.setItem('swipe-last-slide', this.activeIndex);
      },
      touchStart: () => { isSwiping = true; },
      touchEnd: () => { isSwiping = false; },
      transitionEnd: () => { isSwiping = false; }
    }
  });
  btnToday.onclick = () => swiper.slideTo(30, 400);

  if (datePicker) {
    datePicker.addEventListener('change', (e) => {
      if (!e.target.value) return;
      const selected = dayjs(e.target.value);
      const diff = selected.diff(todayDate, 'day');
      if (diff >= -30 && diff <= 30) {
        swiper.slideTo(diff + 30, 400);
      } else {
        alert('±30일 이내의 날짜만 스와이프 가능합니다.');
      }
    });
  }
  renderAllTodos();
  restoreActiveTimers();

  // 이 기기에 아직 안 내려와 있던, 노션에만 있던 항목까지 받아온 다음
  // 미룸 처리를 한 번 더 재확인해요 (그래야 다른 기기/세션에서 만든 미완료 항목도 놓치지 않아요).
  pullFromNotion(true)
    .then((pullChanged) => {
      const rolloverChanged = rolloverIncompleteTodos();
      if (pullChanged || rolloverChanged) renderAllTodos();
    })
    .catch(err => console.warn('초기 pull 실패:', err.message));
});
