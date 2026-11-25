(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const clone = value => structuredClone(value);
  const uuid = () => crypto.randomUUID();
  const textBlock = (value = '') => ({ id: uuid(), type: 'text', value });
  const originNames = { iphone: 'iPhone', pc: 'PC', unknown: '以前のメモ' };
  const dateFormat = new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric' });
  const fullDateFormat = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const imageURLs = new Map();
  const keyName = 'linkflow.desktop.key';
  let key = '', snapshot = null, characterID = null, origin = 'all', query = '', selectedID = null;
  let draft = null, saveTimer, searchTimer, toastTimer, navigationBusy = false, modalBusy = false;
  let mediaJob = null, polling = false, imageObserver, dialogCleanup = null, appGeneration = 0;
  // Favorites/labels (docs/projects/labels-favorites.md). labelFilter: null | { name } | { none: true }.
  let favoritesOnly = false, labelFilter = null, metaBusy = false, aiUndoBusy = false;
  let opMarker, aiPending = [];
  const announcedOps = new Set();
  const opMarkerName = 'linkflow.desktop.lastOperation.';
  const isFavorite = note => note?.favorite === true;
  const noteLabels = note => Array.isArray(note?.labels) ? note.labels : [];
  // Same normalization as the store, so the UI can tell "already there" / "merges" before asking.
  const normalizeLabel = value => String(value).normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const timeFormat = new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const element = (tag, className = '', text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function button(label, className, action, id) {
    const node = element('button', 'button ' + (className || ''), label);
    node.type = 'button';
    if (id) node.id = id;
    if (action) node.addEventListener('click', action);
    return node;
  }
  function avatar(character, className = '') {
    const node = element('span', 'avatar-wrap ' + className);
    if (character?.avatarImageId) {
      node.classList.add('photo-avatar');
      node.dataset.avatarMask = character.avatarMask;
      node.append(makeImage(character.avatarImageId, 'avatar avatar-photo', ''));
      return node;
    }
    // This is the bundled, fixed SVG generator; user text is always textContent.
    node.innerHTML = window.MemoAvatar.markup(character || { color: '#8D5524', shape: 'circle', eyes: 'capsule' });
    return node;
  }
  function field(label, input, help) {
    const container = element('label', 'field');
    container.append(element('span', 'field-label', label), input);
    if (help) container.append(element('span', 'field-help', help));
    return container;
  }
  function input(value, id, type = 'text') {
    const node = element('input', 'text-input');
    node.type = type; node.value = value; if (id) node.id = id;
    return node;
  }
  function select(options, value, id) {
    const node = element('select', 'select-input');
    if (id) node.id = id;
    for (const [key, label] of options) {
      const option = element('option', '', label); option.value = key; node.append(option);
    }
    node.value = value;
    return node;
  }
  function message(text = '', kind = 'error', actions = []) {
    const banner = $('message-banner');
    banner.className = 'message-banner ' + kind;
    banner.replaceChildren(element('span', '', text), ...actions);
    banner.hidden = !text;
  }
  function toast(text) {
    clearTimeout(toastTimer); $('toast').textContent = text; $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
  }
  function errorText(error) { return error?.message || '処理できませんでした。もう一度お試しください。'; }
  class APIError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }
  async function request(path, { method = 'GET', body, raw = false, contentType } = {}) {
    if (!key) throw new APIError('PCアプリの起動リンクから開き直してください。接続キーが見つかりません。', 401);
    const headers = { 'X-LinkFlow-Key': key };
    if (body !== undefined) headers['Content-Type'] = contentType || 'application/json';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(path, {
        method, headers, credentials: 'omit', cache: 'no-store', signal: controller.signal,
        body: body === undefined ? undefined : contentType ? body : JSON.stringify(body)
      });
      if (!response.ok) {
        let reason = '接続できませんでした (' + response.status + ')。';
        try { const data = await response.json(); if (typeof data.error === 'string') reason = data.error; } catch (_) { /* Keep HTTP status. */ }
        throw new APIError(reason, response.status);
      }
      if (raw) return await response.blob();
      if (response.status === 204) return null;
      return await response.json();
    } catch (error) {
      if (error instanceof APIError) throw error;
      throw new APIError(error.name === 'AbortError' ? '応答を確認できませんでした。下書きはこの画面に残っています。' : 'PCアプリに接続できません。起動したままか確認してください。', 0);
    } finally { clearTimeout(timeout); }
  }
  function currentCharacter(id = characterID) { return snapshot?.state.characters.find(item => item.id === id); }
  function noteBody(note) { return (note.blocks || []).filter(block => block.type === 'text').map(block => block.value).join('\n'); }
  function noteTitle(note) { return note.title.trim() || noteBody(note).trim().split('\n')[0]?.slice(0, 64) || '無題のメモ'; }
  function dateLabel(value, full = false) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? (full ? fullDateFormat : dateFormat).format(date) : '';
  }
  function applySnapshot(next) {
    snapshot = next; appGeneration++;
    document.body.dataset.theme = next.state.theme === 'dark' ? 'dark' : 'light';
    $('app-status').textContent = next.syncEnabled ? 'Wi-Fi 接続受付中' : 'このPCに保存';
    $('connection-dot').classList.toggle('online', !!next.syncEnabled);
    // A renamed or deleted label cannot match anything any more; drop the stale filter.
    if (labelFilter?.name && !(next.labels || []).some(item => item.name === labelFilter.name)) labelFilter = null;
    renderSidebar(); renderList();
    noticeOperations(next.operations || []);
  }
  async function reloadState() {
    const next = await request('/api/state');
    applySnapshot(next);
    return next;
  }
  async function imageURL(id) {
    if (!imageURLs.has(id)) {
      const pending = request('/api/images/' + encodeURIComponent(id), { raw: true }).then(blob => URL.createObjectURL(blob));
      imageURLs.set(id, pending);
      pending.catch(() => { if (imageURLs.get(id) === pending) imageURLs.delete(id); });
    }
    return imageURLs.get(id);
  }
  async function loadImage(image) {
    try {
      const url = await imageURL(image.dataset.imageId);
      if (image.isConnected) { image.src = url; image.classList.add('loaded'); }
    } catch (_) {
      if (image.isConnected) { image.alt = '画像を読み込めません。接続を確認してください。'; image.classList.add('unavailable'); }
    }
  }
  function clearImages(container) {
    container.querySelectorAll('img[data-image-id]').forEach(image => imageObserver?.unobserve(image));
    container.replaceChildren();
  }
  function makeImage(id, className, alt = 'メモの画像') {
    const image = element('img', className); image.alt = alt; image.dataset.imageId = id;
    image.decoding = 'async'; image.loading = 'lazy';
    if (imageObserver) imageObserver.observe(image); else void loadImage(image);
    return image;
  }
  async function showImage(id) {
    try {
      const url = await imageURL(id);
      $('full-image').src = url;
      $('image-dialog').showModal();
    } catch (error) { message(errorText(error)); }
  }
  function filteredNotes() {
    const term = query.trim().toLocaleLowerCase();
    return snapshot.state.notes.filter(note => (!characterID || note.characterId === characterID) &&
      (origin === 'all' || (note.origin || 'unknown') === origin) &&
      (!favoritesOnly || isFavorite(note)) &&
      (!labelFilter || (labelFilter.none ? !noteLabels(note).length : noteLabels(note).includes(labelFilter.name))) &&
      (!term || [note.title, noteBody(note), currentCharacter(note.characterId)?.name || ''].some(value => value.toLocaleLowerCase().includes(term))))
      // Favorites first in every list, then the existing newest-first order.
      .sort((a, b) => Number(isFavorite(b)) - Number(isFavorite(a)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
  }
  function labelChip(name, className = '') {
    const chip = element('span', 'label-chip ' + className, name); chip.title = name;
    return chip;
  }
  function favoriteButton(note, className, id, label) {
    const on = isFavorite(note), node = element('button', 'favorite-toggle ' + className);
    node.type = 'button'; node.id = id;
    node.setAttribute('aria-pressed', String(on)); node.setAttribute('aria-label', label);
    node.title = on ? 'お気に入りから外す' : 'お気に入りにする';
    const star = element('span', 'favorite-star', on ? '★' : '☆'); star.setAttribute('aria-hidden', 'true');
    node.append(star);
    node.addEventListener('click', event => { event.stopPropagation(); void toggleFavorite(note.id, id); });
    return node;
  }
  function renderLabelRail() {
    const list = $('label-list'); list.replaceChildren();
    const labels = snapshot.labels || [], unlabeled = snapshot.state.notes.filter(note => !noteLabels(note).length).length;
    const item = (text, count, filter, active) => {
      const node = button('', 'label-filter' + (active ? ' selected' : ''), () => void navigate(() => chooseLabelFilter(active ? null : filter)));
      node.setAttribute('aria-pressed', String(active)); node.title = text;
      node.append(element('span', 'label-filter-name', text), element('span', 'character-count', String(count)));
      return node;
    };
    if (!labels.length) list.append(element('p', 'label-empty', 'まだありません'));
    for (const label of labels) {
      const node = item(label.name, label.count, { name: label.name }, labelFilter?.name === label.name);
      node.dataset.labelFilter = label.name; node.setAttribute('aria-label', label.name + '、' + label.count + '件');
      list.append(node);
    }
    const none = item('ラベルなし', unlabeled, { none: true }, !!labelFilter?.none);
    none.classList.add('label-filter-none'); none.dataset.labelFilter = ''; none.id = 'filter-unlabeled';
    none.setAttribute('aria-label', 'ラベルなし、' + unlabeled + '件'); list.append(none);
  }
  function chooseLabelFilter(filter) {
    labelFilter = filter; draft = null; selectedID = null;
    $('workspace').classList.remove('mobile-reader', 'editing');
    renderSidebar(); renderList(); renderDetail();
  }
  // Every meta write: one request, then reload the whole state (counts, order and the operation log change).
  async function refreshAfterMeta(focusID) {
    await reloadState();
    if (!draft) renderDetail();
    if (focusID) $(focusID)?.focus();
  }
  // A readable summary for the operation log, e.g. 「ラベル「仕事」を追加: 会議メモ」.
  function metaSummary(change) {
    const title = snapshot?.state.notes.find(item => item.id === change.id)?.title || '無題';
    const action = change.favorite === true ? 'お気に入りに追加' : change.favorite === false ? 'お気に入りから外す'
      : change.add?.length ? `ラベル「${change.add.join('」「')}」を追加` : `ラベル「${(change.remove ?? []).join('」「')}」を外す`;
    return `${action}: ${title}`.slice(0, 200);
  }
  async function changeMeta(changes, focusID) {
    if (metaBusy) return null;
    metaBusy = true;
    try {
      const result = await request('/api/meta', { method: 'POST', body: { changes, ...(changes.length === 1 ? { summary: metaSummary(changes[0]) } : {}) } });
      await refreshAfterMeta(focusID); return result;
    } finally { metaBusy = false; }
  }
  async function toggleFavorite(id, focusID) {
    const note = snapshot?.state.notes.find(item => item.id === id);
    if (!note || metaBusy) return;
    try { await changeMeta([{ id, favorite: !isFavorite(note) }], focusID); }
    catch (error) { message(errorText(error)); }
  }
  function renderSidebar() {
    const nav = $('character-list'); clearImages(nav);
    const all = button('', 'character-button all-characters' + (!characterID ? ' selected' : ''), () => void navigate(() => chooseCharacter(null)), 'all-notes');
    const symbol = element('span', 'all-symbol', '▦'); symbol.setAttribute('aria-hidden', 'true');
    all.append(symbol, element('span', 'character-label', 'すべてのメモ'), element('span', 'character-count', String(snapshot.state.notes.length)));
    all.setAttribute('aria-label', 'すべてのメモ'); all.title = 'すべてのメモ'; all.setAttribute('aria-pressed', String(!characterID)); nav.append(all);
    const visible = snapshot.state.characters.slice(0, snapshot.state.visibleCharacterCount ?? 12);
    visible.forEach(character => {
      const count = snapshot.state.notes.filter(note => note.characterId === character.id).length;
      const item = button('', 'character-button' + (character.id === characterID ? ' selected' : ''), () => void navigate(() => chooseCharacter(character.id)));
      item.dataset.characterId = character.id; item.title = character.name;
      item.setAttribute('aria-label', character.name + '、' + count + '件');
      item.setAttribute('aria-pressed', String(character.id === characterID));
      item.style.setProperty('--character-color', character.color);
      item.append(avatar(character), element('span', 'character-label', character.name), element('span', 'character-count', String(count)));
      nav.append(item);
    });
    renderLabelRail();
  }
  function chooseCharacter(id) {
    draft = null; selectedID = null; characterID = id;
    $('workspace').classList.remove('mobile-reader', 'editing');
    renderSidebar(); renderList(); renderDetail();
  }
  function renderList() {
    if (!snapshot) return;
    const character = currentCharacter();
    $('collection-title').textContent = character?.name || 'すべてのメモ';
    const slot = $('collection-avatar'); clearImages(slot); slot.hidden = !character;
    if (character) slot.append(avatar(character));
    $('workspace').style.setProperty('--selected-color', character?.color || '#967E64');
    $('origin-filters').querySelectorAll('button').forEach(item => {
      item.classList.toggle('active', item.dataset.origin === origin);
      item.setAttribute('aria-pressed', String(item.dataset.origin === origin));
    });
    const favoriteFilter = $('favorite-filter');
    favoriteFilter.setAttribute('aria-pressed', String(favoritesOnly)); favoriteFilter.classList.toggle('active', favoritesOnly);
    favoriteFilter.querySelector('.favorite-filter-star').textContent = favoritesOnly ? '★' : '☆';
    const active = $('active-filter'); active.replaceChildren(); active.hidden = !labelFilter;
    if (labelFilter) {
      active.append(element('span', 'active-filter-label', labelFilter.none ? 'ラベルなし' : 'ラベル: ' + labelFilter.name),
        button('解除', 'subtle', () => void navigate(() => chooseLabelFilter(null)), 'clear-label-filter'));
      active.lastChild.setAttribute('aria-label', 'ラベルの絞り込みを解除');
    }
    const notes = filteredNotes(), list = $('notes-list');
    $('note-count').textContent = notes.length + '件のメモ';
    clearImages(list);
    if (!notes.length) {
      const narrowed = query || origin !== 'all' || favoritesOnly || labelFilter;
      const empty = element('div', 'empty-state list-empty');
      empty.append(element('span', 'empty-symbol', query ? '⌕' : narrowed ? '☆' : '＋'), element('h2', '', query ? 'まだ、見つかりません' : narrowed ? 'メモが見つかりません' : 'ここから、ひとこと。'),
        element('p', '', narrowed ? '検索・お気に入り・ラベル・作成した端末の条件を変えてみてください。' : '思いついたことを、この子に残してみませんか。'));
      list.append(empty); return;
    }
    notes.forEach(note => {
      const row = element('div', 'note-row' + (isFavorite(note) ? ' favorite' : ''));
      const card = button('', 'note-card' + (note.id === selectedID ? ' selected' : ''), () => void navigate(() => openNote(note.id)));
      card.dataset.noteId = note.id; card.id = 'memo-row-' + note.id;
      card.setAttribute('aria-pressed', String(note.id === selectedID));
      const copy = element('span', 'note-copy'), head = element('span', 'note-card-header');
      const stamp = element('time', 'note-date', dateLabel(note.updatedAt)); stamp.dateTime = note.updatedAt;
      head.append(stamp, element('span', 'note-origin', originNames[note.origin] || originNames.unknown));
      copy.append(head, element('span', 'note-title', noteTitle(note)), element('span', 'note-excerpt', noteBody(note).trim() || '画像のメモ'));
      const labels = noteLabels(note);
      if (labels.length) {
        const tags = element('span', 'note-labels');
        labels.slice(0, 3).forEach(name => tags.append(labelChip(name)));
        if (labels.length > 3) { const more = labelChip('+' + (labels.length - 3), 'more'); more.title = labels.slice(3).join('、'); tags.append(more); }
        copy.append(tags);
      }
      card.append(copy);
      const image = note.blocks?.find(block => block.type === 'image');
      if (image) card.append(makeImage(image.value, 'note-thumb', ''));
      // The star is a sibling of the row button (no nested buttons); it sits over the card's header.
      row.append(card, favoriteButton(note, 'row-favorite', 'favorite-' + note.id, 'お気に入り: ' + noteTitle(note)));
      list.append(row);
    });
  }
  function openNote(id) {
    selectedID = id; draft = null; message();
    $('workspace').classList.add('mobile-reader'); $('workspace').classList.remove('editing');
    renderList(); renderDetail();
  }
  function readerToolbar() {
    const toolbar = element('div', 'reader-toolbar'), left = element('div', 'toolbar-group');
    left.append(button('← 一覧', 'subtle back-to-list', () => void navigate(() => {
      draft = null; $('workspace').classList.remove('mobile-reader', 'editing'); renderDetail();
    })));
    toolbar.append(left); return { toolbar, left };
  }
  function renderDetail() {
    const detail = $('detail'); clearImages(detail);
    if (draft) { renderEditor(); return; }
    const note = snapshot?.state.notes.find(item => item.id === selectedID);
    if (!note) {
      selectedID = null;
      const character = currentCharacter();
      detail.append(character ? characterPanel(character) : characterRing()); return;
    }
    const { toolbar, left } = readerToolbar();
    const character = currentCharacter(note.characterId);
    left.append(avatar(character, 'tiny-avatar'), element('span', 'reader-kicker', character?.name || 'メモ'));
    const actions = element('div', 'toolbar-group');
    actions.append(favoriteButton(note, 'reader-favorite', 'reader-favorite', 'お気に入り'),
      button('削除', 'subtle danger', () => void navigate(() => confirmDelete(note)), 'delete-note'),
      button('編集する', 'primary', () => beginEdit(note), 'edit-note')); toolbar.append(actions);
    const article = element('article', 'reader-content enter');
    // Title first, then date: the same order as the iPhone reading page.
    article.append(element('h1', 'reader-title', noteTitle(note)), element('p', 'reader-meta', dateLabel(note.updatedAt, true) + ' 更新 · ' + (originNames[note.origin] || originNames.unknown) + ' で作成'), readerLabels(note));
    for (const block of note.blocks || []) {
      if (block.type === 'text') article.append(element('p', 'reader-block', block.value));
      else if (block.type === 'image') {
        const imageButton = button('', 'reader-image', () => void showImage(block.value)); imageButton.setAttribute('aria-label', '画像を拡大');
        imageButton.append(makeImage(block.value, '')); article.append(imageButton);
      }
    }
    detail.append(toolbar, article);
  }
  // Label chips with remove buttons and a keyboard combobox (suggestions from existing labels).
  function readerLabels(note) {
    const section = element('div', 'reader-labels'); section.setAttribute('role', 'group'); section.setAttribute('aria-label', 'ラベル');
    const list = element('ul', 'reader-label-list');
    noteLabels(note).forEach((name, index) => {
      const item = element('li', 'label-chip editable'), remove = element('button', 'label-remove', '×');
      remove.type = 'button'; remove.id = 'label-remove-' + index; remove.setAttribute('aria-label', 'ラベル「' + name + '」を外す'); remove.title = '外す';
      remove.addEventListener('click', () => void removeLabel(note.id, name, index));
      item.append(element('span', 'label-name', name), remove); list.append(item);
    });
    const entry = element('li', 'label-entry'), combo = element('div', 'label-combo');
    const field = element('input', 'label-input'), options = element('ul', 'label-options'), error = element('p', 'label-error');
    Object.assign(field, { id: 'label-input', type: 'text', placeholder: '+ ラベル', autocomplete: 'off', spellcheck: false, maxLength: 80 });
    field.setAttribute('role', 'combobox'); field.setAttribute('aria-label', 'ラベルを追加'); field.setAttribute('aria-autocomplete', 'list');
    field.setAttribute('aria-expanded', 'false'); field.setAttribute('aria-controls', 'label-options');
    options.id = 'label-options'; options.setAttribute('role', 'listbox'); options.setAttribute('aria-label', '既存のラベル'); options.hidden = true;
    error.id = 'label-error'; error.setAttribute('role', 'alert'); error.hidden = true;
    field.setAttribute('aria-describedby', 'label-error');
    const own = new Set(noteLabels(note));
    let matches = [], active = -1;
    const close = () => { options.hidden = true; field.setAttribute('aria-expanded', 'false'); field.removeAttribute('aria-activedescendant'); active = -1; };
    const paint = () => {
      [...options.children].forEach((node, index) => node.setAttribute('aria-selected', String(index === active)));
      if (active >= 0) { field.setAttribute('aria-activedescendant', 'label-option-' + active); options.children[active].scrollIntoView({ block: 'nearest' }); }
      else field.removeAttribute('aria-activedescendant');
    };
    const suggest = () => {
      const term = normalizeLabel(field.value).toLocaleLowerCase();
      matches = (snapshot.labels || []).map(item => item.name).filter(name => !own.has(name) && (!term || name.toLocaleLowerCase().includes(term))).slice(0, 8);
      options.replaceChildren(); active = -1;
      matches.forEach((name, index) => {
        const option = element('li', 'label-option', name); option.id = 'label-option-' + index; option.setAttribute('role', 'option');
        // mousedown keeps focus in the field; the choice is added at once.
        option.addEventListener('mousedown', event => { event.preventDefault(); void addLabel(note, name, field, error); });
        options.append(option);
      });
      options.hidden = !matches.length; field.setAttribute('aria-expanded', String(!!matches.length)); paint();
    };
    field.addEventListener('input', () => { error.hidden = true; suggest(); });
    field.addEventListener('blur', close);
    field.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); if (options.hidden) suggest(); if (!matches.length) return;
        active = event.key === 'ArrowDown' ? (active + 1) % matches.length : (active <= 0 ? matches.length : active) - 1; paint();
      } else if (event.key === 'Enter') {
        event.preventDefault(); void addLabel(note, active >= 0 ? matches[active] : field.value, field, error);
      } else if (event.key === 'Escape') {
        if (!options.hidden) { event.preventDefault(); close(); } else if (field.value) { event.preventDefault(); field.value = ''; error.hidden = true; }
      }
    });
    combo.append(field, options); entry.append(combo); list.append(entry);
    section.append(list, error);
    return section;
  }
  async function addLabel(note, value, field, error) {
    const name = normalizeLabel(value);
    if (!name || metaBusy) return;
    const fail = text => { error.textContent = text; error.hidden = false; field.focus(); };
    if (noteLabels(note).includes(name)) { fail('「' + name + '」はすでに付いています。'); return; }
    try { await changeMeta([{ id: note.id, add: [name] }], 'label-input'); }
    catch (err) { if (field.isConnected) fail(errorText(err)); else message(errorText(err)); }
  }
  async function removeLabel(id, name, index) {
    try {
      await changeMeta([{ id, remove: [name] }]);
      // Keep keyboard focus nearby: the chip that took this place, the previous one, or the input.
      ($('label-remove-' + index) || $('label-remove-' + (index - 1)) || $('label-input'))?.focus();
    } catch (error) { message(errorText(error)); }
  }
  // The iPhone home: every visible character on a ring. Choosing one opens its collection.
  function characterRing() {
    const home = element('section', 'home enter'), ring = element('div', 'home-ring');
    const visible = snapshot.state.characters.slice(0, snapshot.state.visibleCharacterCount ?? 12);
    visible.forEach((character, index) => {
      const item = button('', 'ring-item', () => void navigate(() => chooseCharacter(character.id)));
      item.style.setProperty('--angle', (index / visible.length * 360 - 90) + 'deg');
      item.setAttribute('aria-label', character.name + 'のメモ'); item.title = character.name;
      item.append(avatar(character)); ring.append(item);
    });
    const write = button('', 'ring-center', () => void navigate(newNote), 'home-new-note');
    write.setAttribute('aria-label', '新しいメモ');
    write.append(element('span', 'choice-symbol', '✎'), element('span', 'choice-label', '書く'));
    ring.append(write);
    home.append(ring, element('p', 'home-prompt', 'どの子に残す？'));
    return home;
  }
  // The iPhone choice page: the character's own color, its name, and a white 書く circle.
  function characterPanel(character) {
    const panel = element('section', 'character-panel enter');
    panel.style.setProperty('--panel-color', character.color);
    panel.dataset.ink = isLightColor(character.color) ? 'dark' : 'light';
    const write = button('', 'choice-button', () => void navigate(newNote), 'panel-new-note');
    write.setAttribute('aria-label', character.name + 'に新しいメモを書く');
    write.append(element('span', 'choice-symbol', '✎'), element('span', 'choice-label', '書く'));
    // No avatar here: its body would vanish into the same color, as it does on the iPhone.
    panel.append(element('h2', 'panel-title', character.name), write);
    return panel;
  }
  function isLightColor(hex) {
    const value = parseInt(String(hex).replace('#', ''), 16) || 0;
    const linear = channel => { const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const luminance = 0.2126 * linear(value >> 16 & 255) + 0.7152 * linear(value >> 8 & 255) + 0.0722 * linear(value & 255);
    return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05);
  }
  function prepareBlocks(blocks) {
    // Native text boundaries contribute newlines to body/search/hash. Opening an
    // editor must preserve every existing block even when only the title changes.
    return (blocks || []).map(source => ({ id: source.id || uuid(), type: source.type, value: source.value }));
  }
  function editableBlocks(blocks) {
    const result = [];
    for (const block of blocks) {
      // Empty input affordances stay out of the saved note until actually used.
      if (block.type === 'image' && result.at(-1)?.type !== 'text') result.push(textBlock());
      result.push(block);
    }
    if (result.at(-1)?.type !== 'text') result.push(textBlock());
    return result;
  }
  function beginEdit(note) {
    if (navigationBusy || draft) return;
    selectedID = note.id;
    draft = { note: clone(note), baseRevision: snapshot.revisions[note.id] ?? null, version: 0, dirty: false, saving: null, error: null, conflict: false, cursor: null };
    draft.note.blocks = prepareBlocks(draft.note.blocks);
    $('workspace').classList.add('editing', 'mobile-reader');
    message(); renderDetail();
  }
  function newNote() {
    if (!snapshot) return;
    const now = new Date().toISOString();
    const note = { id: uuid(), characterId: characterID || snapshot.state.characters[0].id, title: '', blocks: [textBlock()], createdAt: now, updatedAt: now, origin: 'pc' };
    selectedID = note.id;
    draft = { note, baseRevision: null, version: 0, dirty: false, saving: null, error: null, conflict: false, cursor: null };
    $('workspace').classList.add('editing', 'mobile-reader'); message(); renderList(); renderDetail();
    requestAnimationFrame(() => $('editor-title')?.focus());
  }
  function markDirty() {
    if (!draft) return;
    draft.version++; draft.dirty = true; draft.error = null;
    setSaveStatus(); clearTimeout(saveTimer);
    if (!draft.conflict) saveTimer = setTimeout(() => { void flushDraft(); }, 650);
  }
  function setSaveStatus() {
    const status = $('save-status');
    if (!status || !draft) return;
    const state = mediaJob ? 'saving' : draft.conflict || draft.error ? 'error' : draft.saving ? 'saving' : draft.dirty ? 'pending' : 'saved';
    status.dataset.state = state;
    status.textContent = mediaJob ? '画像を追加しています…' : draft.conflict ? '別の更新と重なっています' : draft.error ? '未保存・下書きを保持中' : draft.saving ? '保存中…' : draft.dirty ? '変更を保存します…' : draft.baseRevision ? 'このPCに保存しました' : 'まだ書きはじめる前です';
  }
  function setEditorLocked(locked) {
    $('detail').querySelectorAll('input, textarea, select, button').forEach(node => { node.disabled = locked; });
    $('editor-blocks')?.classList.toggle('busy', locked);
  }
  function noteSaved(note, revision) {
    const index = snapshot.state.notes.findIndex(item => item.id === note.id);
    if (index < 0) snapshot.state.notes.push(note); else snapshot.state.notes[index] = note;
    snapshot.revisions[note.id] = revision;
    appGeneration++; renderSidebar(); renderList();
  }
  async function flushDraft() {
    clearTimeout(saveTimer);
    if (mediaJob) await mediaJob;
    const editing = draft;
    if (!editing || !editing.dirty) return true;
    if (editing.conflict) { showDraftError(editing); return false; }
    if (editing.saving) return editing.saving;
    const job = (async () => {
      while (editing.dirty && draft === editing) {
        const version = editing.version, candidate = clone(editing.note);
        candidate.updatedAt = new Date().toISOString();
        try {
          const saved = await request('/api/notes', { method: 'POST', body: { note: candidate, baseRevision: editing.baseRevision } });
          editing.baseRevision = saved.revision; editing.error = null;
          noteSaved(saved.note, saved.revision);
          // Inputs still reference their block objects. Preserve those objects while
          // acknowledging this version; replacing them would detach later typing.
          editing.note.updatedAt = saved.note.updatedAt;
          if (editing.version === version) editing.dirty = false;
        } catch (error) {
          editing.error = error; editing.conflict = error.status === 409;
          if (draft === editing) showDraftError(editing);
          return false;
        }
      }
      if (draft === editing) message();
      return true;
    })();
    editing.saving = job; setSaveStatus();
    try { return await job; }
    finally { editing.saving = null; if (draft === editing) setSaveStatus(); }
  }
  function showDraftError(editing) {
    const actions = [button('別のメモとして保存', 'subtle', () => void saveAsCopy(), 'save-conflict-copy')];
    if (!editing.conflict) actions.unshift(button('保存を再試行', 'subtle', () => void flushDraft(), 'retry-save'));
    message(editing.conflict ? '別の端末や画面で、このメモが更新されました。入力内容はここに保持しています。別のメモとして保存できます。' : errorText(editing.error) + ' 入力内容はこの画面に保持しています。', 'warning', actions);
    setSaveStatus();
  }
  async function saveAsCopy() {
    if (!draft || navigationBusy || mediaJob || draft.saving) return;
    const editing = draft;
    editing.note.id = uuid(); editing.note.createdAt = new Date().toISOString(); editing.note.origin = 'pc';
    editing.note.title = (editing.note.title || '無題のメモ') + '（コピー）';
    editing.baseRevision = null; editing.conflict = false; editing.error = null; editing.dirty = true; editing.version++;
    selectedID = editing.note.id; message(); renderEditor();
    if (await flushDraft()) toast('入力内容を別のメモとして保存しました。');
  }
  async function navigate(action) {
    if (navigationBusy || modalBusy || $('dialog').open) return false;
    clearTimeout(searchTimer);
    navigationBusy = true; setEditorLocked(true);
    try {
      if (!await flushDraft()) return false;
      await action(); return true;
    } catch (error) { message(errorText(error)); return false; }
    finally { navigationBusy = false; $('search').value = query; setEditorLocked(!!mediaJob); }
  }
  function resizeText(textarea) {
    textarea.style.height = 'auto'; textarea.style.height = Math.max(88, textarea.scrollHeight) + 'px';
  }
  function captureCursor(textarea, blockID) {
    if (draft) draft.cursor = { blockID, start: textarea.selectionStart, end: textarea.selectionEnd };
  }
  function renderEditor() {
    if (!draft) return;
    const editing = draft, detail = $('detail'); clearImages(detail);
    const { toolbar, left } = readerToolbar();
    left.append(element('span', 'reader-kicker', editing.baseRevision ? 'メモを編集' : '新しいメモ'));
    const actions = element('div', 'toolbar-group');
    actions.append(button('読む', 'subtle', () => void navigate(() => {
      draft = null; $('workspace').classList.remove('editing'); renderDetail();
    }), 'finish-editing'), button('保存', 'primary', () => {
      if (!draft.baseRevision && !draft.dirty) { draft.dirty = true; draft.version++; }
      void navigate(() => { draft = null; $('workspace').classList.remove('editing'); renderDetail(); });
    }, 'save-note'));
    toolbar.append(actions);
    const editor = element('section', 'editor'); editor.id = 'editor';
    const destination = select(snapshot.state.characters.map(item => [item.id, item.name]), editing.note.characterId, 'editor-character');
    destination.setAttribute('aria-label', 'メモの保存先'); destination.classList.add('editor-destination');
    destination.addEventListener('change', () => { editing.note.characterId = destination.value; markDirty(); });
    const header = element('div', 'editor-header'); header.append(destination, element('span', 'note-origin', (originNames[editing.note.origin] || originNames.unknown) + ' で作成'));
    const title = input(editing.note.title, 'editor-title'); title.className = 'editor-title'; title.placeholder = 'タイトル'; title.setAttribute('aria-label', 'メモのタイトル');
    title.addEventListener('input', () => { editing.note.title = title.value; markDirty(); });
    const tools = element('div', 'editor-tools');
    const files = input('', 'image-files', 'file'); files.multiple = true; files.accept = 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/heic,image/heif'; files.hidden = true;
    files.addEventListener('change', () => {
      const selected = [...files.files]; files.value = '';
      if (selected.length) void insertMedia(selected.map(file => ({ type: 'file', value: file })));
    });
    tools.append(button('＋ 画像を追加', 'subtle', () => files.click(), 'add-images'), button('音声で入力', 'subtle', () => openShortcuts(true), 'dictation-help'),
      element('span', 'field-help', '貼り付け・ドラッグ可。画像は長辺2048px以内のPNGで保存します。GIF等のアニメーションは静止画になります。'), files);
    const blocks = element('div', 'editor-blocks'); blocks.id = 'editor-blocks';
    blocks.addEventListener('dragover', event => {
      if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); blocks.classList.add('drag-over'); }
    });
    blocks.addEventListener('dragleave', event => { if (!blocks.contains(event.relatedTarget)) blocks.classList.remove('drag-over'); });
    blocks.addEventListener('drop', event => {
      blocks.classList.remove('drag-over');
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      if (event.target instanceof HTMLTextAreaElement) captureCursor(event.target, event.target.dataset.blockId);
      void insertMedia([...event.dataTransfer.files].map(file => ({ type: 'file', value: file })));
    });
    const renderedBlocks = editableBlocks(editing.note.blocks);
    editing.renderedBlocks = renderedBlocks;
    for (const [index, block] of renderedBlocks.entries()) {
      if (block.type === 'text') {
        const container = element('div', 'text-block'), text = element('textarea', 'body-input');
        text.value = block.value; text.dataset.blockId = block.id; text.placeholder = index === 0 ? 'ここに、思いのまま。' : 'つづきを書く…';
        text.setAttribute('aria-label', '本文 ' + (index + 1)); text.rows = 2; text.spellcheck = true;
        text.addEventListener('input', () => {
          if (!editing.note.blocks.some(item => item.id === block.id)) {
            const next = renderedBlocks.slice(index + 1).find(item => editing.note.blocks.some(saved => saved.id === item.id));
            const position = next ? editing.note.blocks.findIndex(item => item.id === next.id) : editing.note.blocks.length;
            editing.note.blocks.splice(position, 0, block);
          }
          block.value = text.value; captureCursor(text, block.id); resizeText(text); markDirty();
        });
        ['click', 'keyup', 'select', 'focus', 'blur'].forEach(name => text.addEventListener(name, () => captureCursor(text, block.id)));
        text.addEventListener('paste', event => handlePaste(event, text, block.id));
        container.append(text); blocks.append(container);
        requestAnimationFrame(() => { if (text.isConnected) resizeText(text); });
      } else if (block.type === 'image') {
        const container = element('figure', 'image-block'), imageButton = button('', 'reader-image', () => void showImage(block.value));
        imageButton.setAttribute('aria-label', '画像を拡大'); imageButton.append(makeImage(block.value, ''));
        const actions = element('div', 'image-actions');
        actions.append(button('画像を外す', 'subtle danger', () => {
          editing.note.blocks = prepareBlocks(editing.note.blocks.filter(item => item.id !== block.id)); markDirty(); renderEditor();
        })); container.append(imageButton, actions); blocks.append(container);
      }
    }
    const footer = element('footer', 'editor-footer'), status = element('span', 'save-indicator'); status.id = 'save-status'; status.setAttribute('role', 'status');
    footer.append(status, element('span', 'field-help', '変更は自動で保存されます'));
    editor.append(header, title, tools, blocks, footer); detail.append(toolbar, editor); setSaveStatus();
    setEditorLocked(navigationBusy || !!mediaJob);
  }
  function richPasteParts(html, files) {
    // Parse only for ordered text/attachments. Never mount user HTML in the page.
    const document = new DOMParser().parseFromString(html, 'text/html');
    const result = []; let text = '', imageIndex = 0;
    const flush = () => { if (text) { result.push({ type: 'text', value: text }); text = ''; } };
    const walk = node => {
      if (node.nodeType === Node.TEXT_NODE) { text += node.textContent; return; }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'NOSCRIPT', 'TEMPLATE'].includes(node.nodeName)) return;
      if (node.nodeName === 'IMG') {
        flush(); const source = node.getAttribute('src') || '';
        if (files[imageIndex]) result.push({ type: 'file', value: files[imageIndex++] });
        else if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,/i.test(source)) result.push({ type: 'data', value: source });
        else result.push({ type: 'text', value: '[画像はファイルから追加してください' + (node.getAttribute('alt') ? ': ' + node.getAttribute('alt') : '') + ']' });
        return;
      }
      if (node.nodeName === 'BR') { text += '\n'; return; }
      for (const child of node.childNodes) walk(child);
      if (['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'TR'].includes(node.nodeName) && text && !text.endsWith('\n')) text += '\n';
    };
    walk(document.body); flush();
    while (imageIndex < files.length) result.push({ type: 'file', value: files[imageIndex++] });
    return result;
  }
  function handlePaste(event, text, blockID) {
    const clipboard = event.clipboardData;
    const files = [...(clipboard?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
    const html = clipboard?.getData('text/html') || '';
    if (!files.length && !/<img\b/i.test(html)) return;
    event.preventDefault(); captureCursor(text, blockID);
    const plain = clipboard.getData('text/plain');
    const parts = html ? richPasteParts(html, files) : [...(plain ? [{ type: 'text', value: plain }] : []), ...files.map(file => ({ type: 'file', value: file }))];
    void insertMedia(parts);
  }
  function checkImageDimensions(width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error('画像の大きさを読み取れません。');
    if (width > 32768 || height > 32768 || width * height > 100_000_000) {
      throw new Error('画像が大きすぎます。1億画素以下、各辺32,768px以下に縮小して追加してください。');
    }
  }
  async function imageSourceInfo(blob) {
    const bytes = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
    const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
    const view = new DataView(bytes.buffer), u16 = position => view.getUint16(position), u24LE = position => bytes[position] + (bytes[position + 1] << 8) + (bytes[position + 2] << 16);
    if (bytes.length >= 24 && bytes[0] === 137 && ascii(1, 4) === 'PNG' && ascii(12, 16) === 'IHDR') {
      checkImageDimensions(view.getUint32(16), view.getUint32(20)); return { mime: 'image/png' };
    }
    if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) {
      checkImageDimensions(view.getUint16(6, true), view.getUint16(8, true)); return { mime: 'image/gif' };
    }
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
      let position = 2;
      while (position + 3 < bytes.length) {
        if (bytes[position++] !== 255) break;
        while (bytes[position] === 255) position++;
        const marker = bytes[position++];
        if (marker === 218 || marker === 217) break;
        if (marker === 216 || marker === 1 || marker >= 208 && marker <= 215) continue;
        if (position + 2 > bytes.length) break;
        const size = u16(position); if (size < 2 || position + size > bytes.length) break;
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && size >= 8) {
          checkImageDimensions(u16(position + 5), u16(position + 3)); break;
        }
        position += size;
      }
      return { mime: 'image/jpeg' };
    }
    if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
      const format = ascii(12, 16);
      if (format === 'VP8X') checkImageDimensions(u24LE(24) + 1, u24LE(27) + 1);
      else if (format === 'VP8L' && bytes[20] === 47) checkImageDimensions(1 + bytes[21] + ((bytes[22] & 63) << 8), 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10));
      else if (format === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) checkImageDimensions(view.getUint16(26, true) & 16383, view.getUint16(28, true) & 16383);
      return { mime: 'image/webp' };
    }
    if (bytes.length >= 16 && ascii(4, 8) === 'ftyp') {
      const brands = ascii(8, Math.min(bytes.length, 128));
      if (/avif|avis/.test(brands)) return { mime: 'image/avif' };
      if (/heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1/.test(brands)) return { mime: 'image/heif', heic: true };
    }
    throw new Error('PNG・JPEG・GIF・WebP・AVIF、またはブラウザが読めるHEIC画像を選んでください。');
  }
  async function prepareImageForUpload(blob) {
    if (!(blob instanceof Blob) || !blob.size || blob.size > 50 * 1024 * 1024) throw new Error('画像は1枚50MiB以下で追加してください。');
    const info = await imageSourceInfo(blob);
    const source = URL.createObjectURL(new Blob([blob], { type: info.mime }));
    const image = new Image(), canvas = document.createElement('canvas');
    const decodeError = () => new Error(info.heic ? 'このブラウザではHEIC／HEIFを読み込めません。写真をJPEGまたはPNGで書き出して追加してください。' : '画像をデコードできませんでした。壊れていないPNG・JPEG等の画像で追加し直してください。');
    let timer;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('画像の読み込みに時間がかかっています。画像を小さくして追加し直してください。')), 20000);
        image.onerror = () => reject(decodeError());
        image.onload = () => {
          try { checkImageDimensions(image.naturalWidth, image.naturalHeight); resolve(); }
          catch (error) { reject(error); }
        };
        image.src = source;
      });
      clearTimeout(timer);
      if (typeof image.decode === 'function') {
        await Promise.race([
          image.decode().catch(() => { throw decodeError(); }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(decodeError()), 20000); })
        ]);
      }
      clearTimeout(timer);
      checkImageDimensions(image.naturalWidth, image.naturalHeight);
      const ratio = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
      const context = canvas.getContext('2d'); if (!context) throw new Error('画像を変換できません。このブラウザで画像処理を利用できるか確認してください。');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const png = await new Promise((resolve, reject) => canvas.toBlob(result => result?.size ? resolve(result) : reject(new Error('画像をPNGに変換できませんでした。')), 'image/png'));
      if (png.type !== 'image/png' || png.size > 50 * 1024 * 1024) throw new Error('変換した画像を保存できません。画像を小さくして追加し直してください。');
      return png;
    } finally {
      clearTimeout(timer); image.onload = null; image.onerror = null; image.src = '';
      URL.revokeObjectURL(source); canvas.width = 0; canvas.height = 0;
    }
  }
  // Pinch/wheel to zoom, drag to position, choose circle or rounded square; only the framed square is kept.
  function showAvatarCropper(container, png, initialMask, onDone, onCancel) {
    const side = 280, maxZoom = 6, url = URL.createObjectURL(png);
    const image = element('img', 'crop-image'); image.alt = ''; image.draggable = false;
    let zoom = 1, offset = { x: 0, y: 0 }, mask = initialMask, natural = { w: 1, h: 1 }, finished = false;
    const stage = element('div', 'crop-stage'), frame = element('div', 'crop-frame');
    stage.tabIndex = 0; stage.setAttribute('role', 'application'); stage.setAttribute('aria-label', '画像の表示範囲。矢印キーで移動、＋と−で拡大縮小');
    stage.style.setProperty('--crop-side', side + 'px'); stage.append(image, frame);
    const fill = () => Math.max(side / natural.w, side / natural.h) * zoom;
    const clamp = () => {
      const w = natural.w * fill(), h = natural.h * fill(), mx = Math.max(0, (w - side) / 2), my = Math.max(0, (h - side) / 2);
      offset = { x: Math.min(mx, Math.max(-mx, offset.x)), y: Math.min(my, Math.max(-my, offset.y)) };
    };
    const layout = () => {
      clamp(); const w = natural.w * fill(), h = natural.h * fill();
      Object.assign(image.style, { width: w + 'px', height: h + 'px', left: `calc(50% - ${w / 2 - offset.x}px)`, top: `calc(50% - ${h / 2 - offset.y}px)` });
      frame.dataset.mask = mask; slider.value = String(zoom); reset.disabled = zoom === 1 && !offset.x && !offset.y;
      circle.setAttribute('aria-pressed', String(mask === 'circle')); rounded.setAttribute('aria-pressed', String(mask === 'roundedSquare'));
    };
    const setZoom = value => { zoom = Math.min(maxZoom, Math.max(1, value)); layout(); };
    let drag = null;
    stage.addEventListener('pointerdown', event => { drag = { x: event.clientX - offset.x, y: event.clientY - offset.y }; stage.setPointerCapture(event.pointerId); });
    stage.addEventListener('pointermove', event => { if (!drag) return; offset = { x: event.clientX - drag.x, y: event.clientY - drag.y }; layout(); });
    stage.addEventListener('pointerup', () => { drag = null; });
    stage.addEventListener('pointercancel', () => { drag = null; });
    // Trackpad pinch arrives as ctrl+wheel; a plain wheel zooms too.
    stage.addEventListener('wheel', event => { event.preventDefault(); setZoom(zoom * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002))); }, { passive: false });
    stage.addEventListener('keydown', event => {
      const step = event.shiftKey ? 30 : 8, moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[event.key]) { offset = { x: offset.x + moves[event.key][0], y: offset.y + moves[event.key][1] }; layout(); event.preventDefault(); }
      else if (event.key === '+' || event.key === '=') { setZoom(zoom * 1.15); event.preventDefault(); }
      else if (event.key === '-') { setZoom(zoom / 1.15); event.preventDefault(); }
    });
    const slider = element('input', 'crop-zoom'); Object.assign(slider, { type: 'range', min: '1', max: String(maxZoom), step: '0.01', id: 'crop-zoom' });
    slider.setAttribute('aria-label', '拡大'); slider.addEventListener('input', () => setZoom(Number(slider.value)));
    const circle = button('円', 'filter-chip', () => { mask = 'circle'; layout(); }, 'crop-mask-circle');
    const rounded = button('角丸', 'filter-chip', () => { mask = 'roundedSquare'; layout(); }, 'crop-mask-rounded');
    const masks = element('div', 'origin-filters crop-masks'); masks.setAttribute('role', 'group'); masks.setAttribute('aria-label', '画像の枠'); masks.append(circle, rounded);
    const reset = button('元に戻す', 'subtle', () => { zoom = 1; offset = { x: 0, y: 0 }; layout(); }, 'crop-reset');
    // The dialog's own Cancel/Save would compete with the cropper's; hide them until it closes.
    const dialogActions = $('dialog-actions'); dialogActions.hidden = true;
    const finish = () => { finished = true; dialogActions.hidden = false; URL.revokeObjectURL(url); };
    const cancel = button('キャンセル', 'subtle', () => { finish(); onCancel(); }, 'crop-cancel');
    const done = button('決定', 'primary', async () => {
      const scale = fill(), w = natural.w * scale, h = natural.h * scale;
      const sx = ((w - side) / 2 - offset.x) / scale, sy = ((h - side) / 2 - offset.y) / scale, size = side / scale;
      const out = Math.round(Math.min(1024, Math.max(256, size)));
      const canvas = document.createElement('canvas'); canvas.width = out; canvas.height = out;
      canvas.getContext('2d').drawImage(image, sx, sy, size, size, 0, 0, out, out);
      const blob = await new Promise((resolve, reject) => canvas.toBlob(result => result?.size ? resolve(result) : reject(new Error('画像をPNGに変換できませんでした。')), 'image/png'));
      canvas.width = 0; canvas.height = 0; finish(); await onDone({ blob, mask });
    }, 'crop-done');
    const zoomRow = element('div', 'crop-zoom-row'); zoomRow.append(element('span', 'crop-zoom-icon', '−'), slider, element('span', 'crop-zoom-icon', '＋'));
    const actions = element('div', 'crop-actions'); actions.append(cancel, reset, done);
    const panel = element('section', 'crop-panel');
    panel.append(element('h3', 'crop-title', '位置と大きさ'), stage, masks, zoomRow, element('p', 'field-help', 'ドラッグで位置、ピンチ・スクロール・スライダーで拡大縮小できます。'), actions);
    clearImages(container); container.append(panel);
    image.onload = () => { if (finished) return; natural = { w: image.naturalWidth, h: image.naturalHeight }; layout(); stage.focus(); };
    image.src = url; layout();
  }
  async function insertMedia(parts) {
    if (!draft || mediaJob || navigationBusy) return;
    clearTimeout(saveTimer);
    const editing = draft, available = editing.renderedBlocks || editableBlocks(editing.note.blocks);
    const last = available.at(-1);
    const remembered = editing.cursor && available.find(item => item.id === editing.cursor.blockID && item.type === 'text');
    const cursor = remembered ? { blockID: remembered.id, start: Math.min(editing.cursor.start, remembered.value.length), end: Math.min(editing.cursor.end, remembered.value.length) } : { blockID: last.id, start: last.value.length, end: last.value.length };
    const job = (async () => {
      try {
        const inserted = [];
        for (const part of parts) {
          if (part.type === 'text') { inserted.push(textBlock(part.value)); continue; }
          let blob = part.value;
          if (part.type === 'data') {
            const [header, encoded] = part.value.split(',');
            if (encoded.length > Math.ceil(50 * 1024 * 1024 / 3) * 4) throw new Error('画像は1枚50MiB以下で追加してください。');
            const bytes = Uint8Array.from(atob(encoded.replace(/\s/g, '')), char => char.charCodeAt(0));
            blob = new Blob([bytes], { type: header.slice(5, header.indexOf(';')) });
          }
          const prepared = await prepareImageForUpload(blob);
          const result = await request('/api/images', { method: 'POST', body: prepared, contentType: 'image/png' });
          inserted.push({ id: uuid(), type: 'image', value: result.id });
        }
        if (draft !== editing) return;
        let index = editing.note.blocks.findIndex(item => item.id === cursor.blockID && item.type === 'text');
        const original = available.find(item => item.id === cursor.blockID && item.type === 'text');
        if (!original) throw new Error('挿入位置が変わりました。画像を追加し直してください。');
        const existing = index >= 0;
        if (!existing) {
          const next = available.slice(available.indexOf(original) + 1).find(item => editing.note.blocks.some(saved => saved.id === item.id));
          index = next ? editing.note.blocks.findIndex(item => item.id === next.id) : editing.note.blocks.length;
        }
        const before = { ...original, value: original.value.slice(0, cursor.start) }, after = textBlock(original.value.slice(cursor.end));
        editing.note.blocks.splice(index, existing ? 1 : 0, before, ...inserted, after);
        editing.note.blocks = prepareBlocks(editing.note.blocks);
        editing.cursor = { blockID: after.id, start: 0, end: 0 };
        markDirty(); renderEditor(); message();
      } catch (error) { message(errorText(error) + ' 元の本文はそのままです。'); }
    })();
    mediaJob = job; setEditorLocked(true); setSaveStatus();
    try { await job; }
    finally { mediaJob = null; setEditorLocked(navigationBusy); setSaveStatus(); if (draft?.dirty && !draft.conflict) void flushDraft(); }
  }
  function showDialog(title, build) {
    if ($('dialog').open) return;
    $('dialog-title').textContent = title; clearImages($('dialog-body')); $('dialog-actions').replaceChildren(); $('dialog-actions').hidden = false; $('dialog-message').textContent = '';
    dialogCleanup = null; build($('dialog-body'), $('dialog-actions')); $('dialog').showModal();
  }
  function closeDialog() {
    if (modalBusy) return;
    $('dialog').close(); dialogCleanup?.(); dialogCleanup = null;
    // Drop the closed dialog's controls: a settings dialog re-opens only after reloading state.
    clearImages($('dialog-body')); $('dialog-actions').replaceChildren();
  }
  function dialogMessage(text, error = false) {
    $('dialog-message').textContent = text; $('dialog-message').classList.toggle('error', error);
  }
  async function modalAction(action) {
    if (modalBusy) return false;
    modalBusy = true;
    const controls = [...$('dialog').querySelectorAll('button, input, select')];
    const disabled = controls.map(node => node.disabled); controls.forEach(node => { node.disabled = true; });
    try { await action(); return true; }
    catch (error) { dialogMessage(errorText(error), true); return false; }
    finally { modalBusy = false; controls.forEach((node, index) => { if (node.isConnected) node.disabled = disabled[index]; }); }
  }
  function confirmDelete(note) {
    const revision = snapshot.revisions[note.id];
    showDialog('このメモを削除しますか？', (body, actions) => {
      body.append(element('p', 'confirm-title', noteTitle(note)), element('p', 'field-help', '次に同期すると、接続したiPhoneにも削除を反映します。'));
      actions.append(button('残しておく', 'subtle', closeDialog), button('削除する', 'danger', async () => {
        if (await modalAction(async () => {
          await request('/api/notes/' + encodeURIComponent(note.id), { method: 'DELETE', body: { baseRevision: revision } });
          selectedID = null; draft = null; await reloadState(); renderDetail();
        })) { closeDialog(); toast('メモを削除しました。'); }
      }, 'confirm-delete'));
    });
  }
  async function openSettings() {
    await reloadState();
    const baseRevision = snapshot.revision, settings = clone(snapshot.state);
    showDialog('見た目と設定', (body, actions) => {
      const general = element('div', 'settings-general');
      const count = select(Array.from({ length: 12 }, (_, index) => [String(index + 1), (index + 1) + '体']), String(settings.visibleCharacterCount ?? 12), 'visible-character-count');
      count.addEventListener('change', () => { settings.visibleCharacterCount = Number(count.value); });
      const theme = select([['light', 'ライト'], ['dark', 'ダーク']], settings.theme || 'light', 'theme-setting');
      theme.addEventListener('change', () => { settings.theme = theme.value; document.body.dataset.theme = theme.value; });
      general.append(field('ホームに表示する子', count, '数を減らしても、メモと見た目は残ります。'), field('このPCの表示', theme)); body.append(general);
      const layout = element('div', 'settings-layout'), navigation = element('div', 'settings-navigation'), content = element('div', 'settings-content');
      let selected = settings.characters.find(item => item.id === characterID) || settings.characters[0];
      const renderNavigation = () => {
        clearImages(navigation);
        settings.characters.forEach(character => {
          const item = button('', 'avatar-choice' + (character.id === selected.id ? ' selected' : ''), () => { selected = character; renderNavigation(); renderCharacter(); });
          item.setAttribute('aria-label', character.name); item.setAttribute('aria-pressed', String(character.id === selected.id));
          item.append(avatar(character)); navigation.append(item);
        });
      };
      const renderCharacter = () => {
        clearImages(content);
        const preview = element('div', 'character-preview');
        const updatePreview = () => { clearImages(preview); preview.append(avatar(selected)); renderNavigation(); };
        updatePreview();
        const name = input(selected.name, 'character-name'); name.maxLength = 120;
        name.addEventListener('input', () => { selected.name = name.value; });
        const photoControls = element('section', 'avatar-image-controls');
        const photoFile = input('', 'avatar-image-file', 'file');
        photoFile.accept = 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/heic,image/heif'; photoFile.hidden = true;
        const choosePhoto = button(selected.avatarImageId ? '画像を差し替える' : '好きな画像を選ぶ', 'subtle', () => photoFile.click(), 'choose-avatar-image');
        photoFile.addEventListener('change', async () => {
          const file = photoFile.files[0]; photoFile.value = ''; if (!file) return;
          const target = selected;
          let png = null;
          await modalAction(async () => { dialogMessage('画像を確認しています…'); png = await prepareImageForUpload(file); dialogMessage(''); });
          if (!png) return;
          // As on the iPhone: frame shape, zoom and position are chosen before anything is stored.
          showAvatarCropper(content, png, target.avatarMask || 'circle', async ({ blob, mask }) => {
            await modalAction(async () => {
              const result = await request('/api/images', { method: 'POST', body: blob, contentType: 'image/png' });
              target.avatarImageId = result.id; target.avatarMask = mask;
              renderCharacter(); dialogMessage('画像を設定しました。「変更を保存」で反映します。');
            });
          }, () => renderCharacter());
        });
        const photoActions = element('div', 'toolbar-group'); photoActions.append(choosePhoto, photoFile);
        photoControls.append(photoActions, element('p', 'field-help', '選んだ画像は、枠の形・大きさ・位置を調整してから設定します。GIF等は静止画になります。'));
        if (selected.avatarImageId) {
          photoControls.append(button('元のキャラクターに戻す', 'subtle', () => {
            delete selected.avatarImageId; delete selected.avatarMask; renderCharacter(); dialogMessage('「変更を保存」で元のキャラクターに戻ります。');
          }, 'clear-avatar-image'), element('p', 'field-help', '元のかたち・目・色はそのまま残っています。画像に目は重ねません。'));
        }
        const shape = select(Object.entries(window.MemoAvatar.shapeNames), selected.shape, 'character-shape');
        if (!shape.value) { const option = element('option', '', '現在の形'); option.value = selected.shape; shape.append(option); shape.value = selected.shape; }
        const eyes = select(Object.entries(window.MemoAvatar.eyeNames), selected.eyes, 'character-eyes');
        shape.addEventListener('change', () => { selected.shape = shape.value; updatePreview(); });
        eyes.addEventListener('change', () => { selected.eyes = eyes.value; updatePreview(); });
        const color = input(selected.color, 'character-color', 'color'), hex = input(selected.color, 'character-hex'); hex.maxLength = 7;
        color.setAttribute('aria-label', 'キャラクターの色'); hex.setAttribute('aria-label', 'カラーコード');
        const rgb = element('div', 'rgb-fields'), rgbInputs = [];
        const syncColor = value => {
          if (!/^#[a-f\d]{6}$/i.test(value)) return;
          selected.color = value.toUpperCase(); color.value = selected.color; hex.value = selected.color;
          rgbInputs.forEach((node, index) => { node.value = String(parseInt(value.slice(index * 2 + 1, index * 2 + 3), 16)); });
          updatePreview();
        };
        ['R', 'G', 'B'].forEach((label, index) => {
          const node = input(String(parseInt(selected.color.slice(index * 2 + 1, index * 2 + 3), 16)), 'character-rgb-' + label.toLowerCase(), 'number'); node.min = '0'; node.max = '255'; node.step = '1';
          node.addEventListener('input', () => {
            if (rgbInputs.every(item => item.value !== '' && Number.isInteger(Number(item.value)) && Number(item.value) >= 0 && Number(item.value) <= 255)) syncColor('#' + rgbInputs.map(item => Number(item.value).toString(16).padStart(2, '0')).join(''));
          }); rgbInputs.push(node); rgb.append(field(label, node));
        });
        color.addEventListener('input', () => syncColor(color.value)); hex.addEventListener('change', () => {
          if (/^#[a-f\d]{6}$/i.test(hex.value)) syncColor(hex.value); else { hex.value = selected.color; dialogMessage('色は # と6桁の英数字で入力してください。', true); }
        });
        const colors = element('div', 'color-controls'); colors.append(color, hex);
        const palette = element('div', 'palette');
        window.MemoAvatar.palette.forEach((value, index) => {
          const swatch = button('', 'color-swatch', () => syncColor(value)); swatch.style.setProperty('--swatch-color', value); swatch.setAttribute('aria-label', window.MemoAvatar.paletteNames[index]); palette.append(swatch);
        });
        const selectors = element('div', 'settings-general'); selectors.append(field('かたち', shape), field('目', eyes));
        content.append(preview, field('名前', name), photoControls);
        if (!selected.avatarImageId) content.append(selectors);
        content.append(field(selected.avatarImageId ? '背景の色' : '色', colors), palette, rgb);
      };
      renderNavigation(); renderCharacter(); layout.append(navigation, content); body.append(layout);
      dialogCleanup = () => { document.body.dataset.theme = snapshot.state.theme; };
      actions.append(button('キャンセル', 'subtle', closeDialog), button('変更を保存', 'primary', async () => {
        if (settings.characters.some(item => !item.name.trim())) { dialogMessage('キャラクターの名前を入力してください。', true); return; }
        if (await modalAction(async () => {
          const result = await request('/api/settings', { method: 'PATCH', body: { characters: settings.characters, theme: settings.theme, visibleCharacterCount: settings.visibleCharacterCount, baseRevision } });
          applySnapshot(result); if (!draft) renderDetail();
        })) { closeDialog(); toast('見た目を保存しました。'); }
      }, 'save-settings'));
    });
  }
  async function copyText(text, target = toast) {
    try { await navigator.clipboard.writeText(text); target('コピーしました。'); }
    catch (_) { target('コピーできませんでした。文字列を選択してコピーしてください。'); }
  }
  async function openPairing() {
    await reloadState();
    showDialog('iPhone とつなぐ', (body, actions) => {
      body.append(element('p', 'dialog-intro', '同じWi-Fiで、いつものメモを。'), element('p', 'field-help', 'PCとiPhoneを同じWi-Fiにつなぎ、iPhoneの「設定」からPCとの同期を開いてください。同期はiPhoneで開始します。'));
      const pairing = element('section', 'pairing-content'), devices = element('section', 'paired-devices');
      const renderDevices = () => {
        devices.replaceChildren(element('h3', '', '接続した端末'));
        if (!snapshot.pairedDevices?.length) devices.append(element('p', 'field-help', 'まだ接続した端末はありません。'));
        for (const device of snapshot.pairedDevices || []) {
          const row = element('div', 'device-row'), details = element('div', 'device-details');
          details.append(element('strong', '', device.name), element('span', 'field-help', device.lastSync ? '最終同期 ' + dateLabel(device.lastSync, true) : 'まだ同期していません'));
          const revoke = button('接続を解除', 'subtle danger', async () => {
            if (!window.confirm(device.name + ' の接続を解除しますか？ メモは削除されません。再接続には新しいコードが必要です。')) return;
            await modalAction(async () => { await request('/api/devices/' + encodeURIComponent(device.id), { method: 'DELETE' }); await reloadState(); renderDevices(); dialogMessage('接続を解除しました。'); });
          }); row.append(details, revoke); devices.append(row);
        }
      };
      renderDevices(); body.append(pairing, devices);
      actions.append(button('閉じる', 'subtle', closeDialog), button('Wi-Fi受付を停止', 'subtle danger', async () => {
        await modalAction(async () => { await request('/api/sync/stop', { method: 'POST', body: {} }); await reloadState(); pairing.replaceChildren(); dialogMessage('Wi-Fi受付を停止しました。PCのメモは引き続き使えます。'); });
      }, 'stop-sync'), button('接続コードを作る', 'primary', async () => {
        await modalAction(async () => {
          const result = await request('/api/pairing', { method: 'POST', body: {} });
          await reloadState(); pairing.replaceChildren();
          const image = element('img', 'pairing-qr'); image.alt = 'iPhoneで読み取る接続用QRコード';
          const url = URL.createObjectURL(new Blob([result.qr], { type: 'image/svg+xml' })); image.src = url;
          const previousCleanup = dialogCleanup; dialogCleanup = () => { previousCleanup?.(); URL.revokeObjectURL(url); };
          const code = element('textarea', 'pairing-code'); code.readOnly = true; code.value = result.code; code.setAttribute('aria-label', '接続コード'); code.rows = 3;
          pairing.append(image, element('p', 'field-help', 'iPhoneでQRを読み取るか、接続コードを貼り付けてください。使えるのは1回、' + dateLabel(result.expiresAt, true) + 'までです。'),
            code, button('接続コードをコピー', 'subtle', () => void copyText(result.code, dialogMessage), 'copy-pairing-code'));
          dialogMessage('接続を受け付けています。');
        });
      }, 'create-pairing'));
    });
  }
  function download(data, filename, type) {
    const url = URL.createObjectURL(new Blob([data], { type })), link = element('a');
    link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function openTools() {
    await reloadState();
    showDialog('バックアップ・AI', (body, actions) => {
      const backup = element('section', 'tools-section');
      backup.append(element('h3', '', 'メモを持ち出す'), element('p', 'field-help', '文章・添付画像・キャラクター画像と設定をJSONにまとめます。取り込みはメモの追加だけで、今のキャラクター設定は置き換えません。PCにはJSONから設定を含めて全体復元する機能はありません。端末間では「iPhone とつなぐ」を使ってください。'));
      const buttons = element('div', 'toolbar-group');
      buttons.append(button('JSONを書き出す', 'primary', () => void modalAction(async () => {
        dialogMessage('バックアップを作成しています…');
        const data = await request('/api/export');
        download(JSON.stringify(data), 'memopale-' + new Date().toISOString().slice(0, 10) + '.json', 'application/json'); dialogMessage('バックアップを書き出しました。');
      }), 'export-backup'));
      const file = input('', 'import-file', 'file'); file.accept = '.json,application/json'; file.hidden = true;
      file.addEventListener('change', async () => {
        const selected = file.files[0]; file.value = ''; if (!selected) return;
        if (selected.size > 128 * 1024 * 1024) { dialogMessage('JSONは128MiB以下のファイルを選んでください。', true); return; }
        if (!window.confirm('「' + selected.name + '」からメモを追加しますか？ 現在のメモは残ります。')) return;
        await modalAction(async () => {
          dialogMessage('内容を確認して取り込んでいます…');
          let data; try { data = JSON.parse(await selected.text()); } catch (_) { throw new Error('JSONを読み込めませんでした。'); }
          await request('/api/import', { method: 'POST', body: data }); await reloadState(); if (!draft) renderDetail(); dialogMessage('メモを追加しました。');
        });
      });
      buttons.append(button('JSONから追加', 'subtle', () => file.click(), 'import-backup'), file); backup.append(buttons);
      const ai = element('section', 'tools-section');
      ai.append(element('h3', '', 'AIに読ませる'), element('p', 'field-help', 'このフォルダには、メモの文章・画像・目次を自動で書き出しています。使っているAIツールでフォルダを開き、INDEX.mdを入口にしてください。アプリからAIサービスへの送信は行いません。'),
        element('p', 'code-box', snapshot.aiPath), button('フォルダの場所をコピー', 'subtle', () => void copyText(snapshot.aiPath, dialogMessage), 'copy-ai-path'),
        element('p', 'field-help', 'AI用ファイルは閲覧用です。編集してもメモには反映されません。メモの変更はこのアプリから行ってください。'));
      body.append(backup, ai); actions.append(button('閉じる', 'primary', closeDialog));
    });
  }
  function operationSource(op) { return op.source === 'ai' ? 'AI' : 'PC'; }
  function skippedText(skipped) {
    return skipped?.length ? ' ' + skipped.length + '件は後から変更されていたため、そのままにしました。' : '';
  }
  async function openLabels() {
    await reloadState();
    showDialog('ラベルを整理', (body, actions) => {
      body.classList.add('labels-dialog');
      let open = null; // { name, mode: 'rename' | 'delete' }
      const run = (action, after) => modalAction(async () => {
        dialogMessage('');
        const result = await action();
        await reloadState(); if (!draft) renderDetail();
        render(after?.focus); if (after?.message) dialogMessage(after.message(result));
      });
      const render = focusID => {
        body.replaceChildren();
        const labels = snapshot.labels || [], names = new Set(labels.map(item => item.name));
        // Add (or describe) a label.
        const create = element('section', 'tools-section label-create');
        const name = input('', 'new-label-name'), description = input('', 'new-label-description');
        name.maxLength = 80; description.maxLength = 500; name.placeholder = '例: 買い物'; description.placeholder = '例: 買うもの・欲しいもののメモ';
        const add = button('追加', 'primary', () => {
          const label = normalizeLabel(name.value);
          if (!label) { dialogMessage('ラベル名を入力してください。', true); name.focus(); return; }
          const existed = names.has(label);
          void run(() => request('/api/labels', { method: 'POST', body: { action: 'define', name: label, description: description.value } }),
            { focus: 'new-label-name', message: () => existed ? '「' + label + '」はすでにあるため、説明を更新しました。' : '「' + label + '」を追加しました。' });
        }, 'add-label');
        [name, description].forEach(node => node.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); add.click(); } }));
        const grid = element('div', 'label-create-grid'); grid.append(field('名前', name), field('説明（任意）', description), add);
        create.append(element('h3', '', '新しいラベル'), grid, element('p', 'field-help', '説明は、AIが同じ基準で整理するための手がかりになります。ラベルはこのPCとAIで付け、iPhoneでは表示と絞り込みができます。'));
        // Existing labels.
        const catalog = element('section', 'tools-section');
        catalog.append(element('h3', '', 'ラベル一覧（' + labels.length + '）'));
        if (!labels.length) catalog.append(element('p', 'field-help', 'まだラベルはありません。'));
        const rows = element('ul', 'label-rows');
        labels.forEach((label, index) => {
          const row = element('li', 'label-row'); row.dataset.labelRow = label.name;
          const head = element('div', 'label-row-head');
          head.append(labelChip(label.name, 'large'), element('span', 'field-help', label.count + '件のメモ'));
          const tools = element('div', 'label-row-actions');
          tools.append(button('絞り込む', 'subtle', () => { closeDialog(); void navigate(() => chooseLabelFilter({ name: label.name })); }, 'label-filter-' + index),
            button('名前を変更', 'subtle', () => { open = { name: label.name, mode: 'rename' }; render('rename-input'); }, 'label-rename-' + index),
            button('削除', 'subtle danger', () => { open = { name: label.name, mode: 'delete' }; render('confirm-delete-label'); }, 'label-delete-' + index));
          head.append(tools);
          const describe = element('div', 'label-describe'), text = input(label.description, 'label-description-' + index);
          text.maxLength = 500; text.placeholder = '説明なし'; text.setAttribute('aria-label', '「' + label.name + '」の説明');
          const save = button('説明を保存', 'subtle', () => void run(() => request('/api/labels', { method: 'POST', body: { action: 'define', name: label.name, description: text.value } }),
            { focus: 'label-description-' + index, message: () => '「' + label.name + '」の説明を保存しました。' }), 'label-save-description-' + index);
          save.disabled = true;
          text.addEventListener('input', () => { save.disabled = text.value.trim() === label.description; });
          text.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && !save.disabled) { event.preventDefault(); save.click(); } });
          describe.append(text, save); row.append(head, describe);
          if (open?.name === label.name && open.mode === 'rename') {
            const panel = element('div', 'label-panel'), target = input(label.name, 'rename-input'), hint = element('p', 'field-help label-hint');
            target.maxLength = 80; target.setAttribute('aria-label', '新しい名前'); hint.id = 'rename-hint'; target.setAttribute('aria-describedby', 'rename-hint');
            const confirm = button('名前を変更', 'primary', null, 'confirm-rename');
            const update = () => {
              const next = normalizeLabel(target.value), merge = next !== label.name && names.has(next);
              const other = labels.find(item => item.name === next);
              hint.textContent = !next ? '新しい名前を入力してください。' : next === label.name ? '今と同じ名前です。'
                : merge ? '「' + next + '」はすでにあります。統合され、「' + label.name + '」の' + label.count + '件は「' + next + '」になります（「' + next + '」は今' + other.count + '件）。'
                : label.count + '件のメモのラベルが「' + next + '」に変わります。';
              hint.classList.toggle('merge', merge);
              confirm.textContent = merge ? '統合する' : '名前を変更'; confirm.disabled = !next || next === label.name;
            };
            target.addEventListener('input', update);
            const submit = () => {
              const next = normalizeLabel(target.value); if (!next || next === label.name) return;
              const merge = names.has(next);
              open = null;
              void run(() => request('/api/labels', { method: 'POST', body: { action: 'rename', from: label.name, to: next } }),
                { focus: 'new-label-name', message: () => merge ? '「' + label.name + '」を「' + next + '」に統合しました。' : '「' + label.name + '」を「' + next + '」に変更しました。' });
            };
            confirm.addEventListener('click', submit);
            target.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submit(); } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); open = null; render('label-rename-' + index); } });
            const buttons = element('div', 'toolbar-group'); buttons.append(button('やめる', 'subtle', () => { open = null; render('label-rename-' + index); }, 'cancel-rename'), confirm);
            panel.append(field('新しい名前', target), hint, buttons); row.append(panel); update();
          } else if (open?.name === label.name && open.mode === 'delete') {
            const panel = element('div', 'label-panel danger-panel');
            panel.append(element('p', 'label-confirm', '「' + label.name + '」を削除しますか？ ' + (label.count ? label.count + '件のメモからこのラベルが外れます。' : '付いているメモはありません。') + '下の「最近の操作」から取り消せます。'));
            const buttons = element('div', 'toolbar-group');
            buttons.append(button('やめる', 'subtle', () => { open = null; render('label-delete-' + index); }, 'cancel-delete-label'),
              button('削除する', 'danger', () => { open = null; void run(() => request('/api/labels', { method: 'POST', body: { action: 'delete', name: label.name } }),
                { focus: 'new-label-name', message: result => '「' + label.name + '」を削除しました（' + result.changedNotes + '件のメモから外しました）。' }); }, 'confirm-delete-label'));
            panel.append(buttons); row.append(panel);
          }
          rows.append(row);
        });
        catalog.append(rows);
        // Recent operations with undo.
        const history = element('section', 'tools-section');
        history.append(element('h3', '', '最近の操作'));
        const ops = snapshot.operations || [];
        if (!ops.length) history.append(element('p', 'field-help', 'まだ操作はありません。'));
        const list = element('ul', 'operation-list');
        ops.forEach(op => {
          const item = element('li', 'operation-row'), copy = element('div', 'operation-copy'), meta = element('span', 'field-help');
          const source = element('span', 'source-badge ' + op.source, operationSource(op));
          meta.append(source, document.createTextNode(' ' + timeFormat.format(new Date(op.createdAt)) + ' · ' + op.noteCount + '件のメモ'));
          copy.append(element('span', 'operation-summary', op.summary), meta); item.append(copy);
          if (op.undoneBy) item.append(element('span', 'operation-state', '取り消し済み'));
          else if (op.undoOf) item.append(element('span', 'operation-state', '取り消しの操作'));
          else item.append(button('取り消す', 'subtle', () => void run(() => request('/api/operations/' + encodeURIComponent(op.id) + '/undo', { method: 'POST', body: {} }),
            { focus: 'new-label-name', message: result => '「' + op.summary + '」を取り消しました（' + result.changedNotes + '件）。' + skippedText(result.skipped) }), 'undo-op-' + op.id));
          list.append(item);
        });
        history.append(list);
        body.append(create, catalog, history);
        if (focusID) $(focusID)?.focus();
      };
      actions.append(button('閉じる', 'primary', closeDialog, 'close-labels'));
      dialogCleanup = () => { body.classList.remove('labels-dialog'); };
      render();
    });
  }
  // ---- AI change notice. New 'ai' operations seen by polling get a non-blocking toast with undo. ----
  function readOpMarker() {
    try { return JSON.parse(localStorage.getItem(opMarkerName + snapshot.libraryId) || 'null'); } catch (_) { return null; }
  }
  function writeOpMarker(op) {
    opMarker = { id: op?.id ?? null, createdAt: op?.createdAt ?? '' };
    try { localStorage.setItem(opMarkerName + snapshot.libraryId, JSON.stringify(opMarker)); } catch (_) { /* The in-memory marker still works. */ }
  }
  function noticeOperations(ops) {
    if (opMarker === undefined) {
      const stored = readOpMarker();
      // First time in this browser: everything that exists now is old news. Later loads announce
      // AI operations made while no window was open (they have not been shown anywhere yet).
      if (!stored || typeof stored !== 'object' || typeof stored.createdAt !== 'string') { writeOpMarker(ops[0]); return; }
      opMarker = stored;
    }
    const seen = opMarker.id ? ops.findIndex(op => op.id === opMarker.id) : -1;
    const fresh = seen >= 0 ? ops.slice(0, seen) : ops.filter(op => op.createdAt > opMarker.createdAt);
    if (!fresh.length) return;
    writeOpMarker(fresh[0]);
    const ai = fresh.filter(op => op.source === 'ai' && !op.undoneBy && !announcedOps.has(op.id));
    if (!ai.length) return;
    ai.forEach(op => announcedOps.add(op.id));
    aiPending = [...ai, ...aiPending].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    renderAINotice();
  }
  function hideAINotice() {
    aiPending = []; $('ai-notice').hidden = true; $('ai-notice').replaceChildren();
    document.body.style.removeProperty('--notice-space'); document.body.classList.remove('has-ai-notice');
  }
  function renderAINotice(error = '') {
    const notice = $('ai-notice');
    if (!aiPending.length) { hideAINotice(); return; }
    const latest = aiPending[0], total = aiPending.reduce((sum, op) => sum + op.noteCount, 0);
    const text = aiPending.length === 1 ? 'AIが' + latest.noteCount + '件のメモを整理しました: ' + latest.summary
      : 'AIが' + aiPending.length + '回の操作で延べ' + total + '件のメモを整理しました。最新: ' + latest.summary;
    const copy = element('p', 'ai-notice-text', text);
    const actions = element('div', 'ai-notice-actions');
    if (aiPending.some(op => !op.undoOf)) {
      const undo = button(aiPending.length === 1 ? '取り消す' : 'すべて取り消す', 'primary', () => void undoAIOperations(), 'ai-notice-undo');
      undo.disabled = aiUndoBusy; actions.append(undo);
    }
    const close = button('×', 'subtle icon-button', hideAINotice, 'ai-notice-close'); close.setAttribute('aria-label', 'お知らせを閉じる');
    actions.append(close);
    notice.replaceChildren(element('span', 'ai-notice-badge', 'AI'), copy, actions);
    if (error) { const problem = element('p', 'ai-notice-error', error); notice.append(problem); }
    notice.hidden = false; document.body.classList.add('has-ai-notice');
    document.body.style.setProperty('--notice-space', notice.offsetHeight + 'px');
  }
  // Undo every operation the notice covers, newest first, so earlier ones see the state they produced.
  async function undoAIOperations() {
    if (aiUndoBusy) return;
    aiUndoBusy = true; renderAINotice();
    let changed = 0, skipped = 0, failure = null;
    const remaining = [];
    for (const op of aiPending) {
      if (op.undoOf) continue;
      try {
        const result = await request('/api/operations/' + encodeURIComponent(op.id) + '/undo', { method: 'POST', body: {} });
        changed += result.changedNotes; skipped += result.skipped?.length || 0;
      } catch (error) {
        if (error.status === 409) continue; // Already undone elsewhere (dialog, another window, the AI).
        failure = error; remaining.push(op);
      }
    }
    aiUndoBusy = false;
    try { await reloadState(); if (!draft) renderDetail(); } catch (_) { /* The poll will retry. */ }
    if (failure) { aiPending = remaining; renderAINotice(errorText(failure)); return; }
    hideAINotice();
    toast('AIの整理を取り消しました（' + changed + '件）。' + (skipped ? skipped + '件は後から変更されていたため、そのままにしました。' : ''));
  }
  function openShortcuts(dictationOnly = false) {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform), mod = mac ? '⌘' : 'Ctrl';
    showDialog(dictationOnly ? '音声で入力する' : 'キーボードで、軽やかに。', (body, actions) => {
      if (!dictationOnly) {
        const shortcuts = element('dl', 'shortcut-list');
        [[mod + (mac ? ' + Option + N' : ' + Alt + N'), '新しいメモ'], [mod + ' + S', '今の変更を保存'], [mod + ' + K', 'メモを検索'], ['Esc', '画像やダイアログを閉じる']].forEach(([keys, label]) => {
          const row = element('div', 'shortcut-row'); row.append(element('dt', '', label), element('dd', '', keys)); shortcuts.append(row);
        }); body.append(shortcuts);
      }
      body.append(element('h3', '', 'パソコンの音声入力を使う'), element('p', '', mac ? '本文にカーソルを置き、Macに設定した音声入力キー（通常はマイクキー、またはFn／地球儀キーを2回）を押してください。' : '本文にカーソルを置き、Windows キー + H を押してください。'),
        element('p', 'field-help', 'アプリは録音・音声送信を行いません。音声入力の処理や通信は、お使いのOSの設定に従います。'));
      actions.append(button('わかりました', 'primary', closeDialog));
    });
  }
  function bind() {
    $('new-note').addEventListener('click', () => void navigate(newNote));
    $('brand-home').addEventListener('click', event => { event.preventDefault(); void navigate(() => chooseCharacter(null)); });
    $('open-settings').addEventListener('click', () => void navigate(openSettings));
    $('open-tools').addEventListener('click', () => void navigate(openTools));
    $('open-pairing').addEventListener('click', () => void navigate(openPairing));
    $('open-shortcuts').addEventListener('click', () => void navigate(() => openShortcuts()));
    $('open-labels').addEventListener('click', () => void navigate(openLabels));
    $('favorite-filter').addEventListener('click', () => void navigate(() => { favoritesOnly = !favoritesOnly; draft = null; selectedID = null; renderList(); renderDetail(); }));
    $('origin-filters').addEventListener('click', event => {
      const target = event.target.closest('button[data-origin]'); if (!target) return;
      void navigate(() => { origin = target.dataset.origin; draft = null; selectedID = null; renderList(); renderDetail(); });
    });
    $('search').addEventListener('input', () => {
      clearTimeout(searchTimer); const next = $('search').value;
      searchTimer = setTimeout(async () => {
        const success = await navigate(() => { query = next; draft = null; selectedID = null; renderList(); renderDetail(); });
        if (!success) $('search').value = query;
      }, 250);
    });
    $('dialog-close').addEventListener('click', closeDialog);
    $('dialog').addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    $('image-close').addEventListener('click', () => $('image-dialog').close());
    document.addEventListener('keydown', event => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.isComposing || $('dialog').open || $('image-dialog').open) return;
      if (event.key.toLowerCase() === 's') { event.preventDefault(); void flushDraft(); }
      else if (event.key.toLowerCase() === 'k') { event.preventDefault(); void navigate(() => { $('search').focus(); $('search').select(); }); }
      else if (event.altKey && event.code === 'KeyN') { event.preventDefault(); void navigate(newNote); }
    });
    window.addEventListener('beforeunload', event => {
      if (draft?.dirty || draft?.saving || mediaJob || modalBusy) { event.preventDefault(); event.returnValue = ''; }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden && draft?.dirty) void flushDraft(); });
    window.addEventListener('pagehide', () => { for (const url of imageURLs.values()) url.then(URL.revokeObjectURL, () => {}); imageURLs.clear(); });
    window.addEventListener('resize', () => { $('detail').querySelectorAll('textarea.body-input').forEach(resizeText); });
  }
  async function poll() {
    if (polling || document.hidden || draft || navigationBusy || modalBusy || $('dialog').open || mediaJob || !snapshot || metaBusy || aiUndoBusy) return;
    // Do not re-render the reader under someone typing a label.
    const labelField = $('label-input');
    if (labelField?.value) return;
    polling = true; const generation = appGeneration;
    try {
      const next = await request('/api/state');
      if (generation !== appGeneration || draft || navigationBusy || $('dialog').open || mediaJob || metaBusy) return;
      const changed = next.revision !== snapshot.revision;
      if (changed) {
        // Re-rendering replaces the focused control; put focus back on its successor (same id).
        const focusID = document.activeElement?.id;
        applySnapshot(next); renderDetail();
        if (focusID && !document.activeElement?.id) $(focusID)?.focus({ preventScroll: true });
      }
      else {
        snapshot = next;
        $('app-status').textContent = next.syncEnabled ? 'Wi-Fi 接続受付中' : 'このPCに保存';
        $('connection-dot').classList.toggle('online', !!next.syncEnabled);
      }
    } catch (_) { $('app-status').textContent = '接続を確認してください'; $('connection-dot').classList.remove('online'); }
    finally { polling = false; }
  }
  async function start() {
    const params = new URLSearchParams(location.hash.slice(1));
    try {
      key = params.get('k') || sessionStorage.getItem(keyName) || '';
      if (key) sessionStorage.setItem(keyName, key);
    } catch (_) { /* The initial fragment still permits this page to authenticate. */ }
    if (params.has('k')) history.replaceState(null, '', location.pathname + location.search);
    imageObserver = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { imageObserver.unobserve(entry.target); void loadImage(entry.target); }
    }, { rootMargin: '240px' });
    bind();
    try { await reloadState(); renderDetail(); }
    catch (error) {
      $('app-status').textContent = '開けませんでした';
      $('workspace').classList.add('mobile-reader');
      message(errorText(error), 'error', [button('再接続', 'subtle', async () => {
        try { await reloadState(); message(); renderDetail(); } catch (retryError) { message(errorText(retryError)); }
      })]);
    }
    setInterval(() => { void poll(); }, 4000);
  }
  void start();
})();
