const $ = id => document.getElementById(id);
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = String(text); if (className) element.className = className; return element; };
let viewerKey;
const viewer = await request('/v1/runtime');
if(typeof viewer.data?.viewer_key!=='string')throw new Error('Viewer identity is required');
viewerKey=viewer.data.viewer_key;
const STORAGE = 'alfa.live.v2.' + viewerKey;
let persisted = {};
try { persisted = JSON.parse(localStorage.getItem(STORAGE) || '{}'); } catch { /* Browsing remains available without storage. */ }
let company = '', role = ['cfo', 'ceo', 'treasury'].includes(persisted.role) ? persisted.role : 'cfo';
let favorites = Boolean(persisted.favorites), epoch = 0, companyOffset = 0, companyListEpoch = 0, polling = false, generationEnabled = false;
let cursor = null, runtime = null, jobs = [], firstFeed = true, requestedCompany = '', feedTotal = null, feedRunning = null, feedRunningCount = null, journalPage = 0, activityRead = false, activityAction = null, connectionFailed = false;
const cards = new Map(), elements = new Map(), detailsLoading = new Set(), draftRequests = new Map();
const clientErrors = [];
const expanded = new Set(Array.isArray(persisted.expanded) ? persisted.expanded : []);
const date = value => Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Дата не указана';
const count = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? new Intl.NumberFormat('ru-RU').format(Number(value)) : '—';
const unbox = value => value?.data ?? value;
function safeUrl(value) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } }
function notice(message, error = false) { $('notice').textContent = message; $('notice').dataset.error = String(error); $('notice').hidden = !message; }
function friendlyError(error) {
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'Сервис не ответил вовремя. Сохранённые данные остаются доступны; запрос можно повторить.';
  if (error.status === 403) return 'Нет доступа к выбранной компании или операции.';
  if (error.status === 404) return 'Запись не найдена. Проверьте компанию или обновите ленту.';
  if (error.code === 'MODEL_OUTCOME_UNKNOWN') return 'Результат запроса уточняется. Повторная отправка не выполняется.';
  if (error.status === 409) return 'Данные изменились. Обновите карточку перед повторной отправкой.';
  if (error.status === 422 || error.status === 400) return 'Проверьте введённые данные.';
  if (error.status === 429) return 'Достигнут лимит обработки. Сбор продолжится, новые ответы будут подготовлены позже.';
  if (error.status >= 500) return 'Один из сервисов временно недоступен. Повторная проверка выполнится автоматически.';
  return 'Не удалось связаться с сервисом. Проверьте локальный запуск и повторите действие.';
}
async function request(path, body) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', signal: controller.signal, headers: { Accept: 'application/json', ...(viewerKey ? {'X-Viewer-Key':viewerKey} : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if(response.status === 401) window.location.assign("/auth/login");
    let value; try { value = await response.json(); } catch { const error = new Error('Invalid response'); error.status = response.status || 502; throw error; }
    if(value.error?.code==='SESSION_CHANGED'){ $('feed').replaceChildren(); $('journal-events').replaceChildren(); window.location.reload(); throw new Error('Session changed'); }
    if (!response.ok) { const error = new Error(value.error?.message || 'API error'); error.status = response.status; error.code = value.error?.code; throw error; }
    return value;
  } finally { clearTimeout(timer); }
}
const query = values => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)])).toString();
const scopeQuery = extra => query({ company_id: company, audience_role: role, ...extra });
function readerAnchor() {
  for (const [id, element] of elements) { const position = element.getBoundingClientRect(); if (position.bottom > 0 && position.top < window.innerHeight) return { id, offset: position.top }; }
  return null;
}
function save() {
  const value = { company, role, favorites, scroll: window.scrollY, anchor: readerAnchor(), pages: Math.max(1, Math.ceil(cards.size / 20)), expanded: [...expanded].slice(-100), drafts: { ...persisted.drafts } };
  for (const [id, record] of draftRequests) if (record.text) value.drafts[id] = { ...record };
  for (const [id, element] of elements) { const text = element.querySelector('textarea')?.value; if (text) value.drafts[id] = { ...draftRequests.get(id), text }; else if (!draftRequests.has(id)) delete value.drafts[id]; }
  persisted.drafts = value.drafts;
  try { localStorage.setItem(STORAGE, JSON.stringify(value)); } catch { /* Storage may be unavailable; no server mutation is needed. */ }
}
function preserveReader(action) {
  const anchor = readerAnchor(), before = window.scrollY;
  action();
  if (anchor && elements.has(anchor.id)) window.scrollBy({ top: elements.get(anchor.id).getBoundingClientRect().top - anchor.offset, behavior: 'instant' });
  else window.scrollTo({ top: before, behavior: 'instant' });
}
function restoreReader() {
  if (persisted.company !== company || persisted.role !== role || Boolean(persisted.favorites) !== favorites) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (persisted.anchor && elements.has(persisted.anchor.id)) window.scrollBy({ top: elements.get(persisted.anchor.id).getBoundingClientRect().top - persisted.anchor.offset, behavior: 'instant' });
    else window.scrollTo({ top: Number(persisted.scroll) || 0, behavior: 'instant' });
  }));
}
function sourceLink(source, text) { const url = safeUrl(source.url); if (!url) return null; const link = node('a', text); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link; }
function sourceId(cardId, index) { return 'source-' + encodeURIComponent(cardId) + '-' + index; }
function references(parent, indexes, analysis, cardId) {
  const ids = [...new Set((indexes || []).flatMap(index => analysis.claims?.[index]?.source_ids || []))];
  const row = node('div', undefined, 'refs');
  for (const id of ids) { const index = (analysis.sources || []).findIndex(source => source.id === id); if (index < 0) continue; const link = node('a', 'Источник ' + (index + 1)); link.href = '#' + sourceId(cardId, index); row.append(link); }
  if (row.childNodes.length) parent.append(row);
}
function textList(parent, title, values) {
  if (!Array.isArray(values) || !values.length) return;
  parent.append(node('h4', title)); const list = node('ul'); values.forEach(value => list.append(node('li', value))); parent.append(list);
}
function analysisBody(analysis, cardId) {
  const body = node('div', undefined, 'card-body');
  for (const [field, label] of [['risks', 'Возможные риски'], ['opportunities', 'Возможности'], ['recommendations', 'Что проверить и сделать']]) {
    if (!analysis[field]?.length) continue;
    body.append(node('h4', label)); const list = node('ul');
    analysis[field].forEach((text, index) => {
      const li = node('li', text), grounding = analysis.grounding?.[field]?.[index];
      if (field === 'recommendations' && grounding) {
        if (grounding.condition) li.append(node('p', 'Условие: ' + grounding.condition, 'condition'));
        if (grounding.required_data?.length) li.append(node('p', 'Нужно уточнить: ' + grounding.required_data.join('; '), 'condition'));
      }
      references(li, field === 'recommendations' ? grounding?.claim_indexes : grounding, analysis, cardId); list.append(li);
    }); body.append(list);
  }
  textList(body, 'Недостающие данные', analysis.missing_data);
  textList(body, 'Ограничения', analysis.limitations);
  if (analysis.claims?.length) {
    body.append(node('h4', 'На чём основаны выводы'));
    analysis.claims.forEach((claim, index) => {
      const item = node('div', undefined, 'claim'); item.append(node('strong', `${index + 1}. ${claim.kind === 'fact' ? 'Факт из новости' : claim.kind === 'bank' ? 'Материал банка' : 'Условный вывод по компании'}`));
      item.append(node('p', claim.text));
      if (claim.conditions?.length) item.append(node('p', 'Условия: ' + claim.conditions.join('; '), 'condition'));
      references(item, [index], analysis, cardId); body.append(item);
    });
  }
  if (analysis.sources?.length) body.append(node('h4', 'Источники и подтверждения'));
  (analysis.sources || []).forEach((source, index) => {
    const item = node('div', undefined, 'source'); item.id = sourceId(cardId, index);
    item.append(node('strong', `${index + 1}. ${source.title || 'Источник'}`));
    item.append(node('p', `${source.kind === 'company' ? 'Данные компании' : source.kind === 'bank' ? 'Банковский материал' : 'Публикация'}${source.published_at ? ' · ' + date(source.published_at) : ''}${source.page ? ' · стр. ' + source.page : ''}`, 'source-kind'));
    const link = sourceLink(source, 'Открыть оригинал'); if (link) item.append(link);
    if (source.excerpt) { const details = node('details'); details.append(node('summary', 'Посмотреть использованный фрагмент'), node('blockquote', source.excerpt)); item.append(details); }
    body.append(item);
  });
  return body;
}

// /live/feed is the publication boundary; these are display/scope guards, not LLM validation.
function readyCard(card) {
  return card?.company_id === company && card.audience_role === role && !card.stale && card.analysis && (!favorites || card.favorite === true)
    && (card.status === undefined || ['succeeded', 'ready'].includes(card.status));
}
function removeCard(id) { save(); feedTotal = null; elements.get(id)?.remove(); elements.delete(id); cards.delete(id); }
function scopedJobs() {
  return jobs.filter(job => (!job.company_id || job.company_id === company) &&
    (job.audience_role === role || (!job.audience_role && job.kind === 'question' && cards.has(job.analysis_id))));
}
function runningForView() { return feedRunning === null ? runningAnalyses().length > 0 : feedRunning; }
function runningAnalyses() { return scopedJobs().filter(job => job.kind === 'analysis' && job.status === 'running'); }
function updateCardCount() {
  $('card-count').textContent = count(feedTotal ?? cards.size);
  $('card-count-label').textContent = feedTotal === null && cursor ? 'Показано готовых выводов' : 'Готовые выводы · выбранная роль';
}
function recordError(title, error, cid = company, selectedRole = role) {
  clientErrors.unshift({ title, company: cid, role: selectedRole, time: Date.now(), detail: friendlyError(error), code: error.code || (error.status ? 'HTTP ' + error.status : 'NETWORK') });
  clientErrors.length = Math.min(clientErrors.length, 30); renderJobs();
}
function questionJob(id) {
  const tracked = draftRequests.get(id);
  if (tracked) return tracked.job_id ? jobs.find(job => job.id === tracked.job_id) : undefined;
  return jobs.filter(job => job.kind === 'question' && job.analysis_id === id).sort((a,b) => (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0))[0];
}
function questionState(id) {
  const article = elements.get(id); if (!article) return;
  const tracked = draftRequests.get(id), job = questionJob(id), state = job?.status || tracked?.status;
  if (tracked && job) tracked.status = job.status;
  const field = article.querySelector('textarea'), button = article.querySelector('.question-submit'), status = article.querySelector('[data-question-status]');
  const pending = ['submitting', 'queued', 'running', 'deferred'].includes(state) || (state === 'succeeded' && Boolean(tracked));
  const unresolved = ['unknown', 'submission_unknown'].includes(state);
  field.readOnly = pending || unresolved;
  button.disabled = pending || state === 'unknown';
  button.textContent = state === 'submission_unknown' ? 'Проверить отправку' : state === 'failed' || state === 'superseded' ? 'Отправить повторно' : 'Задать вопрос';
  status.dataset.pending = String(pending && state !== 'deferred');
  if (state === 'submitting') status.textContent = 'Отправляем вопрос…';
  else if (state === 'running') status.textContent = 'Готовим ответ…';
  else if (state === 'queued') status.textContent = 'Вопрос принят. Ответ появится после завершения.';
  else if (state === 'deferred') status.textContent = 'Ответ будет подготовлен позже. Вопрос сохранён.';
  else if (state === 'succeeded') status.textContent = tracked ? 'Ответ готов. Обновляем диалог…' : 'Ответ сохранён.';
  else if (unresolved) status.textContent = 'Отправка уточняется. Вопрос сохранён; новый запрос не создаётся.';
  else if (['failed', 'superseded'].includes(state)) status.textContent = 'Ответ не подготовлен. Вопрос сохранён; подробности — в журнале.';
  else status.textContent = '';
}

function cardControls(card, element) {
  const favorite = element.querySelector('.favorite'); favorite.textContent = card.favorite ? '★ В избранном' : '☆ В избранное'; favorite.setAttribute('aria-pressed', String(Boolean(card.favorite)));
  const badge = element.querySelector('.badge'); badge.textContent = card.stale ? 'Есть новая версия новости' : 'Результат проверен'; badge.classList.toggle('stale', Boolean(card.stale));
  element.querySelector('.stale-notice').hidden = !card.stale;
  questionState(card.id);
}
function renderCard(card) {
  const article = node('article', undefined, 'card'); article.id = 'card-' + encodeURIComponent(card.id); article.dataset.analysisId = card.id;
  const top = node('div', undefined, 'card-top'), meta = node('div', undefined, 'card-meta');
  meta.append(node('span', '', 'badge'), node('time', date(card.created_at)));
  const favorite = node('button', '', 'favorite'); favorite.type = 'button';
  favorite.addEventListener('click', async () => {
    const cid = company, rev = epoch; favorite.disabled = true;
    try { const value = unbox(await request(`/v1/live/analyses/${encodeURIComponent(card.id)}/favorite`, { company_id: cid, favorite: !cards.get(card.id)?.favorite })); if (rev !== epoch) return; const updated = { ...cards.get(card.id), favorite: value.favorite }; cards.set(card.id, updated); cardControls(updated, article); if (favorites && !updated.favorite) { removeCard(card.id); updateCardCount(); renderEmpty(); } }
    catch (error) { if (rev === epoch) notice(friendlyError(error), true); } finally { favorite.disabled = false; }
  });
  top.append(meta, favorite); article.append(top, node('h3', card.title || card.analysis?.summary || 'Анализ новости', 'card-title'));
  article.append(node('p', 'Публикация изменилась. Ниже сохранён предыдущий вывод; учитывайте это до появления новой проверенной версии.', 'stale-notice'));
  const analysis = card.analysis || {};
  article.append(node('p', analysis.summary || 'Сохранённый анализ', 'card-summary'));
  if (analysis.why_relevant) { const why = node('div', undefined, 'relevance'); why.append(node('strong', 'Почему касается компании'), node('p', analysis.why_relevant)); article.append(why); }
  const newsSource = analysis.sources?.find(source => source.kind === 'news' && safeUrl(source.url));
  if (newsSource) { const link = sourceLink(newsSource, 'Первоисточник новости ↗'); link.className = 'muted'; article.append(link); }
  const details = node('details'); details.className = 'analysis-details'; details.append(node('summary', 'Действия, основания и источники'), analysisBody(analysis, card.id));
  const versions = node('div', undefined, 'versions'); versions.dataset.versions = 'true'; details.append(versions);
  const questionSection = node('section', undefined, 'question-section'); questionSection.append(node('h4', 'Уточнить по этому анализу'), node('p', 'Ответ использует сохранённые источники и профиль компании. История сохраняется на сервере.', 'muted'));
  const history = node('div'); history.dataset.history = 'true'; questionSection.append(history);
  const form = node('form'), label = node('label', 'Ваш вопрос'), textarea = node('textarea'); textarea.rows = 3; textarea.required = true; textarea.minLength = 3; textarea.maxLength = 2000; textarea.placeholder = 'Какие условия договора нужно проверить?'; textarea.id = 'question-' + encodeURIComponent(card.id); label.htmlFor = textarea.id;
  if (persisted.drafts?.[card.id]?.text) { textarea.value = persisted.drafts[card.id].text; if (persisted.drafts[card.id].key && !draftRequests.has(card.id)) { const restored = { ...persisted.drafts[card.id] }; if (restored.status === 'submitting' && !restored.job_id) restored.status = 'submission_unknown'; draftRequests.set(card.id, restored); } }
  textarea.addEventListener('input', () => { const tracked = draftRequests.get(card.id); if (tracked && !['queued','running','deferred','unknown','submission_unknown','submitting','succeeded'].includes(tracked.status) && tracked.text !== textarea.value.trim()) draftRequests.delete(card.id); save(); });
  const submit = node('button', 'Задать вопрос', 'question-submit'); submit.type = 'submit'; const questionStatus = node('p', '', 'question-status'); questionStatus.dataset.questionStatus = 'true';
  form.append(label, textarea, submit, questionStatus); questionSection.append(form); details.append(questionSection); article.append(details);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (submit.disabled || !cards.has(card.id)) return;
    const text = textarea.value.trim(); if (text.length < 3) return;
    const previous = draftRequests.get(card.id);
    const retry = ['failed', 'superseded'].includes(previous?.status);
    const key = !retry && previous?.text === text ? previous.key : crypto.randomUUID();
    const record = { key, text, status: 'submitting' };
    draftRequests.set(card.id, record); save(); questionState(card.id);
    const cid = company, selectedRole = role;
    try {
      const job = unbox(await request('/v1/live/analyses/' + encodeURIComponent(card.id) + '/questions', { company_id: cid, question: text, idempotency_key: key }));
      if (draftRequests.get(card.id) !== record) return;
      Object.assign(record, { job_id: job.id, status: job.status }); save();
      if (company !== cid || role !== selectedRole) return;
      jobs = [job, ...jobs.filter(item => item.id !== job.id)]; questionState(card.id);
      await refreshJobs(epoch);
    } catch (error) {
      if (draftRequests.get(card.id) !== record) return;
      if (record.job_id) { recordError('Обновление состояния вопроса', error, cid, selectedRole); if (company === cid && role === selectedRole) questionState(card.id); return; }
      record.status = error.status && error.status < 500 && error.code !== 'MODEL_OUTCOME_UNKNOWN' ? 'failed' : 'submission_unknown';
      recordError('Отправка вопроса', error, cid, selectedRole); save();
      if (company === cid && role === selectedRole) questionState(card.id);
    }
  });
  details.addEventListener('toggle', () => {
    if (details.open) { expanded.add(card.id); void refreshDetails(card.id); } else expanded.delete(card.id);
    save();
  });
  if (expanded.has(card.id)) details.open = true;
  cardControls(card, article); return article;
}
async function refreshDetails(id) {
  if (detailsLoading.has(id) || !elements.has(id) || !company) return;
  const rev = epoch, cid = company; detailsLoading.add(id);
  try {
    const value = unbox(await request(`/v1/live/analyses/${encodeURIComponent(id)}?${query({ company_id: cid, audience_role: role })}`));
    if (rev !== epoch || !elements.has(id)) return;
    const article = elements.get(id), history = article.querySelector('[data-history]');
    const successfulHistory = (value.history || []).filter(item => (item.status === undefined || ['succeeded','ready'].includes(item.status)) && typeof (item.answer ?? item.response?.data?.answer) === 'string' && (item.answer ?? item.response?.data?.answer).trim());
    const historyKey = JSON.stringify(successfulHistory);
    if (history.dataset.revision !== historyKey) {
      history.dataset.revision = historyKey; history.replaceChildren();
      for (const item of successfulHistory) {
        const message = node('div', undefined, 'history-message'); message.append(node('strong', item.question), node('p', item.answer || item.response?.data?.answer || ''));
        const answer = item.response?.data;
        if (answer?.limitations?.length) message.append(node('p', answer.limitations.join(' '), 'condition'));
        if (answer?.claims?.length) { const evidence = node('details'); evidence.append(node('summary', 'Основания ответа')); for (const claim of answer.claims) { evidence.append(node('p', claim.text)); references(evidence, [0], { claims: [claim], sources: cards.get(id)?.analysis?.sources || [] }, id); } message.append(evidence); }
        history.append(message);
      }
    }
    if (value.card && !readyCard(value.card)) { removeCard(id); updateCardCount(); renderEmpty(); return; }
    if (value.card) { cards.set(id, value.card); cardControls(value.card, article); }
    const versions = article.querySelector('[data-versions]'); const versionKey = JSON.stringify(value.versions || []);
    if (versions.dataset.revision !== versionKey) {
      versions.dataset.revision = versionKey; versions.replaceChildren();
      if (value.versions?.length > 1) {
        const heading = node('p', 'Сохранённые версии анализа'); versions.append(heading);
        for (const version of value.versions) {
          const button = node('button', `${date(version.created_at)}${version.id === id ? ' · открыта' : ''}`, 'text-button'); button.disabled = version.id === id;
          button.addEventListener('click', async () => {
            const versionEpoch = epoch; button.disabled = true;
            try {
              const prior = unbox(await request(`/v1/live/analyses/${encodeURIComponent(version.id)}?${query({ company_id: cid, audience_role: role })}`));
              if (versionEpoch !== epoch) return;
              const existing = versions.querySelector('.previous-version'); if (existing) existing.remove();
              const box = node('details', undefined, 'previous-version'); box.open = true; box.append(node('summary', 'Предыдущая версия · ' + date(prior.card.created_at)), node('p', prior.card.analysis.summary), analysisBody(prior.card.analysis, prior.card.id + '-history')); versions.append(box);
            } catch (error) { notice(friendlyError(error), true); } finally { button.disabled = false; }
          }); versions.append(button, document.createTextNode(' '));
        }
      }
    }
    const tracked = draftRequests.get(id), job = questionJob(id);
    const received = tracked && successfulHistory.some(item => item.question === tracked.text &&
      ((tracked.job_id && item.job_id === tracked.job_id) || (job?.status === 'succeeded' && new Date(item.created_at).getTime() >= new Date(job.created_at).getTime())));
    if (received) {
      const field = article.querySelector('textarea');
      if (field.value.trim() === tracked.text) field.value = '';
      draftRequests.delete(id); delete persisted.drafts?.[id]; save();
    }
    questionState(id);
    if (received || (!tracked && successfulHistory.length && !['queued','running','deferred','unknown','failed'].includes(job?.status))) {
      article.querySelector('[data-question-status]').textContent = 'Ответ сохранён.';
      article.querySelector('[data-question-status]').dataset.pending = 'false';
      article.querySelector('.question-submit').disabled = false;
      article.querySelector('textarea').readOnly = false;
    }
  } catch (error) { if (rev === epoch) { recordError('Обновление диалога', error); questionState(id); const status = elements.get(id)?.querySelector('[data-question-status]'); if (status) { status.dataset.pending = 'false'; status.textContent = 'Не удалось обновить ответ. Вопрос и предыдущий диалог сохранены.'; } } }
  finally { detailsLoading.delete(id); }
}
function renderEmpty() {
  $('empty').hidden = cards.size > 0;
  if (!company) { $('empty-title').textContent = 'Начните с компании'; $('empty-description').textContent = 'Выберите профиль, чтобы открыть сохранённые выводы.'; return; }
  if (favorites) { $('empty-title').textContent = 'В избранном пока пусто'; $('empty-description').textContent = 'Сохраните готовую карточку кнопкой «В избранное».'; return; }
  $('empty-title').textContent = runningForView() ? 'Готовим выводы' : 'Готовых выводов пока нет';
  $('empty-description').textContent = runningForView() ? 'После успешного завершения карточки появятся здесь автоматически.' : 'Здесь появятся только успешно подготовленные результаты для выбранной компании и роли.';
}
function applyPage(page, { reset = false, fresh = false } = {}) {
  preserveReader(() => {
    if (reset) { cards.clear(); elements.clear(); $('feed').replaceChildren(); }
    if (fresh) { const ids = new Set(Array.isArray(page.visible_ids) ? page.visible_ids : (page.items || []).filter(readyCard).map(card => card.id)); for (const id of cards.keys()) if (!ids.has(id)) removeCard(id); }
    for (const card of page.items || []) {
      if (!readyCard(card)) { if (elements.has(card.id)) removeCard(card.id); continue; }
      const sameArticle = [...cards.values()].find(previous => previous.news_id === card.news_id && previous.audience_role === card.audience_role && previous.id !== card.id);
      if (sameArticle && fresh) { elements.get(sameArticle.id)?.remove(); cards.delete(sameArticle.id); elements.delete(sameArticle.id); }
      if (elements.has(card.id)) { cards.set(card.id, card); cardControls(card, elements.get(card.id)); continue; }
      const article = renderCard(card); cards.set(card.id, card); elements.set(card.id, article); $('feed').append(article);
    }
    for (const card of [...cards.values()].sort((a, b) => b.seq - a.seq)) $('feed').append(elements.get(card.id));
    const total = page.total_ready ?? page.total;
    if (fresh && !Number.isSafeInteger(total)) feedTotal = null;
    cursor = page.next_cursor; $('load-more').hidden = !cursor; if (Number.isSafeInteger(total) && total >= 0) feedTotal = total;
    if (typeof page.has_running_tasks === 'boolean') feedRunning = page.has_running_tasks;
    if (Number.isSafeInteger(page.running_tasks) && page.running_tasks >= 0) { feedRunningCount = page.running_tasks; feedRunning = page.running_tasks > 0; } updateCardCount(); renderEmpty();
    for (const id of cards.keys()) questionState(id);
  });
  for (const id of expanded) if (elements.has(id)) void refreshDetails(id);
}
async function refreshFeed(rev = epoch, { append = false, initial = false } = {}) {
  if (!company) return;
  let page = unbox(await request('/v1/live/feed?' + scopeQuery({ limit: 20, cursor: append ? cursor : null, favorites: favorites ? 1 : null })));
  if (rev !== epoch) return;
  if (!Array.isArray(page.items)) throw new Error('Feed response has no items');
  if (append) applyPage(page);
  else if (initial || firstFeed) {
    applyPage(page, { reset: true }); firstFeed = false;
    // Restore a reader who had paged further down, using saved GET results only.
    if (persisted.company === company && persisted.role === role && Boolean(persisted.favorites) === favorites) {
      const restorePages = Math.min(10, Math.max(1, Number(persisted.pages) || 1));
      for (let loaded = 1; cursor && loaded < restorePages; loaded++) {
        if (persisted.anchor?.id && elements.has(persisted.anchor.id)) break;
        const next = unbox(await request('/v1/live/feed?' + scopeQuery({ limit: 20, cursor, favorites: favorites ? 1 : null })));
        if (rev !== epoch) return;
        applyPage(next);
      }
    }
    restoreReader();
  }
  else {
    // Reconcile the loaded window, including removals omitted by a ready-only API.
    const oldest = Math.min(...[...cards.values()].map(card => Number(card.seq)));
    let next = page.next_cursor, items = [...(page.items || [])], pages = 1;
    while (next && pages < 10 && items.length && Number(items.at(-1).seq) > oldest) {
      const more = unbox(await request('/v1/live/feed?' + scopeQuery({ limit: 20, cursor: next, favorites: favorites ? 1 : null })));
      if (rev !== epoch) return;
      if (!Array.isArray(more.items)) throw new Error('Feed page has no items');
      items.push(...more.items); next = more.next_cursor; pages++;
    }
    page = { ...page, items, next_cursor: next }; applyPage(page, { fresh: true });
  }
}
function reasonText(reason, status) {
  const value = String(reason || '');
  const descriptions = {
    official_key_rate_context_for_all_companies: 'Решение Банка России: общий денежно-кредитный контекст',
    official_general_tax_context: 'Общее изменение налоговых правил: проверить применимость',
    verified_company_event: 'Событие связано с компанией по подтверждённым данным',
    verified_counterparty_exposure_check: 'Есть связь с контрагентами: проверить косвенное влияние',
    verified_bank_product_exposure: 'У компании есть затронутый банковский продукт',
    verified_foreign_trade_currency_exposure: 'В профиле подтверждена внешняя торговля',
    verified_industry_business_change: 'Изменение касается отрасли компании',
    verified_trade_country_change: 'Изменение касается страны внешней торговли',
    verified_regional_business_disruption: 'Изменение в регионе работы компании',
    forecast_or_proposal_requires_review: 'Прогноз или предложение требуют отдельной проверки',
    forecast_requires_review: 'Прогноз требует отдельной проверки',
    multi_event_roundup_requires_extraction: 'Обзор нескольких событий требует раздельного анализа',
    rate_topic_is_background: 'Ставка упомянута как фон, а не как отдельное событие',
    no_confirmed_business_change: 'Конкретное изменение для бизнеса не подтверждено',
    no_verified_company_exposure: 'Связь с профилем компании не подтверждена',
    peripheral_or_ceremonial_topic: 'Тематическое совпадение без значимого делового события',
    explicit_industry_mismatch: 'Указанная отрасль не совпадает с профилем компании',
    target_role_mismatch: 'Указанная категория получателей не совпадает с профилем',
    below_relevance_threshold: 'Не достигнут порог значимости',
    already_processed_or_queued: 'Уже обработано или находится в очереди',
    company_daily_limit: 'Достигнут дневной лимит компании',
    previous_generation_failed: 'Предыдущая попытка завершилась ошибкой',
    material_revision_queued: 'Изменённая новость направлена на повторный анализ',
    awaiting_full_text: 'Ожидает загрузки полного текста',
    insufficient_source_text: 'Недостаточно текста для проверяемого вывода',
    source_text_truncated: 'Текст неполный; требуется проверка источника'
  };
  if (descriptions[value]) return descriptions[value];
  if (/key|disabled|not_configured|generation_unavailable|llm_unavailable/iu.test(value)) return 'Ожидает подключения модели';
  if (/budget|quota|limit|429/iu.test(value)) return 'Ожидает освобождения бюджета';
  if (/supersed|revision|obsolete/iu.test(value)) return 'Новость обновлена; требуется новая версия';
  if (/contract|validat|grounding|invalid_result/iu.test(value)) return 'Ответ не прошёл проверку и не опубликован';
  if (/timeout|unavailable|connection|fetch|502|503|504|lease|worker/iu.test(value)) return status === 'failed' ? 'Задача завершилась без результата.' : 'Сервис временно недоступен.';
  if (/irrelevant|relevance|score/iu.test(value)) return 'Не достигнут порог значимости для компании';
  if (/duplicate/iu.test(value)) return 'Повторная публикация того же события';
  if (/full_text|excerpt|text_required|incomplete_text/iu.test(value)) return 'Ожидает загрузки полного текста';
  if (/^[\p{L}\p{N}\s.,:;!?()«»—–-]+$/u.test(value) && /[а-яё]/iu.test(value)) return value.slice(0, 220);
  return 'Обработка отложена; подробности доступны в журнале сервиса';
}
function jobState(job) { return ({ unknown: 'Исход запроса уточняется; повторная отправка заблокирована', queued: 'В очереди', running: 'Готовится и проверяется', deferred: 'Отложено', succeeded: 'Готово', failed: 'Требует проверки', superseded: 'Заменено новой версией' })[job.status] || 'Обрабатывается'; }
const roleLabel = () => ({ cfo: 'Финансовый директор', ceo: 'Генеральный директор', treasury: 'Казначейство' })[role];
function renderActivity() {
  let busy = false, title = company ? (cards.size ? 'Готовые выводы доступны' : 'Готовых выводов пока нет') : 'Выберите компанию';
  let description = company ? 'Лента обновляется автоматически.' : 'После выбора загрузятся сохранённые результаты.';
  if (activityAction) { busy = true; title = activityAction.title; description = 'Ожидаем подтверждения сервера.'; }
  else if (activityRead) { busy = true; title = 'Обновляем ленту'; description = 'Загружаем сохранённые результаты.'; }
  else if (company && runningForView()) { busy = true; title = 'Готовим выводы'; description = 'Готовые карточки появятся после успешного завершения.'; }
  else if (connectionFailed) { description = 'Показаны последние доступные результаты. Проверим обновления автоматически.'; }
  $('activity-title').textContent = title; $('activity-description').textContent = description;
  $('activity-spinner').hidden = !busy; $('activity').setAttribute('aria-busy', String(busy));
  const active = runningAnalyses();
  $('queue-count').textContent = company ? count(feedRunningCount ?? active.length) : '—'; $('queue-summary').textContent = company ? 'Для выбранной компании и роли' : 'Выберите компанию';
}
function renderJobs() {
  if ($('event-journal').hidden) return;
  const selection = runtime?.selection;
  $('journal-description').textContent = 'Отбор: ' + roleLabel() + (selection?.scanned_at ? ' · ' + date(selection.scanned_at) : ' · ещё не выполнялся') + '. Задания ниже относятся к выбранной компании и роли. Это последний отбор и до 100 последних заданий, не полный архив.';
  const rows = [
    ...clientErrors.filter(item => item.company === company && item.role === role).map(item => ({ ...item, category: 'Действие в интерфейсе', status: item.code, state: 'failed' })),
    ...jobs.map(job => ({ title: job.kind === 'question' ? 'Вопрос: ' + job.title : job.title, status: jobState(job), detail: job.error ? (job.status === 'failed' ? 'Ответ не опубликован. ' : '') + reasonText(job.error, job.status) : '', url: cards.get(job.analysis_id)?.analysis?.sources?.find(source => source.kind === 'news')?.url || selection?.items?.find(item => item.news_id === job.news_id)?.source_url, time: job.updated_at, category: 'Задание компании', state: job.status })),
    ...(selection?.items || []).map(item => ({ title: item.title, status: item.selected ? 'Отобрано для обработки' : reasonText(item.reason), url: item.source_url, category: 'Последний отбор · ' + roleLabel(), state: 'selection' }))
  ];
  journalPage = Math.min(journalPage, Math.max(0, Math.ceil(rows.length / 25) - 1));
  $('journal-events').replaceChildren();
  for (const entry of rows.slice(journalPage * 25, (journalPage + 1) * 25)) {
    const row = node('article', undefined, 'journal-event');
    row.append(node('p', entry.category + (entry.time ? ' · ' + date(entry.time) : ''), 'muted'), node('h4', entry.title || 'Событие без заголовка'));
    const status = node('p', entry.status, 'job-state'); status.dataset.state = entry.state; row.append(status);
    if (entry.detail) row.append(node('p', entry.detail, 'job-error'));
    const link = sourceLink({ url: entry.url }, 'Открыть новость ↗');
    row.append(link || node('p', 'Ссылка не передана для этого задания.', 'muted'));
    $('journal-events').append(row);
  }
  if (!rows.length) $('journal-events').append(node('p', 'Событий пока нет. Просмотр журнала не запускает подбор.', 'muted'));
  $('journal-page').textContent = rows.length ? (journalPage * 25 + 1) + '–' + Math.min(rows.length, (journalPage + 1) * 25) + ' из ' + rows.length : '0 событий';
  $('journal-prev').disabled = journalPage === 0;
  $('journal-next').disabled = (journalPage + 1) * 25 >= rows.length;
}
async function refreshJobs(rev = epoch) {
  if (!company) return;
  const value = unbox(await request('/v1/live/jobs?' + scopeQuery({ limit: 100 }))); if (rev !== epoch) return; jobs = value.items || []; renderJobs();
  for (const id of cards.keys()) questionState(id);
  renderEmpty(); renderActivity(); save();
  for (const id of new Set([...expanded, ...draftRequests.keys()])) if (elements.has(id)) void refreshDetails(id);
}
function displayRuntime(value) {
  runtime = value; generationEnabled = Boolean(value.generation_enabled);
  $('model-notice').hidden = generationEnabled && !value.recovery_review_required;
  $('model-notice').textContent = value.recovery_review_required ? 'Генерация приостановлена: после восстановления базы требуется проверка оператором. Сохранённые карточки доступны.' : 'Генерация пока не подключена. Сбор новостей, отбор и сохранение очереди работают. Выводы появятся после настройки ключа модели.';
  const collector = unbox(value.collector) || {}, feeds = collector.feeds || [];
  const queue = value.queue?.jobs || value.queue || {};
  $('queue-count').textContent = count((Number(queue.queued) || 0) + (Number(queue.running) || 0) + (Number(queue.deferred) || 0));
  $('queue-summary').textContent = `В работе: ${count(queue.running || 0)} · отложено: ${count(queue.deferred || 0)}${queue.unknown ? ' · исход уточняется: ' + count(queue.unknown) : ''}`;
  updateCardCount();
  const budget = value.budget;
  $('budget-count').textContent = budget?.error ? 'Недоступен' : budget ? `${count(budget.used?.calls)} / ${count(budget.limits?.calls)}` : 'Нет данных';
  $('budget-summary').textContent = budget?.error ? 'Не удалось получить расход модели. Значения не подтверждены.' : budget ? `Вызовы за день · токены: ${count(budget.used?.tokens)}${budget.resets_at ? ' · сброс ' + date(budget.resets_at) : ''}` : 'Сервер не передал данные о расходе.';
  $('collector-summary').textContent = `${collector.running ? 'Сейчас загружаются публикации.' : 'Источники проверяются по расписанию.'}${collector.last_success ? ' Последняя успешная загрузка: ' + date(collector.last_success) + '.' : ''}${collector.full_text_count !== undefined ? ' Полных текстов: ' + count(collector.full_text_count) + '.' : ''}${collector.full_text_errors ? ' Не удалось загрузить полный текст: ' + count(collector.full_text_errors) + '.' : ''}`;
  $('sources-status').replaceChildren();
  for (const feed of feeds) {
    const item = node('div', undefined, 'source-state'); let host; try { host = new URL(feed.url).hostname; } catch { host = 'Источник'; }
    item.append(node('strong', feed.name || host), node('p', feed.last_success ? 'Загружен: ' + date(feed.last_success) : 'Ещё не загружен'));
    if (feed.last_error) item.append(node('p', reasonText(feed.last_error)));
    const link = sourceLink({ url: feed.url }, 'Открыть источник'); if (link) item.append(link); $('sources-status').append(item);
  }
  const subscription = value.subscriptions?.find(item => item.company_id === company && item.audience_role === role);
  $('subscribe').textContent = subscription?.enabled ? 'Подбор включён' : 'Включить подбор'; $('subscribe').disabled = !company || Boolean(subscription?.enabled) || Boolean(activityAction);
  $('pause-subscription').hidden = !subscription?.enabled; $('scan').disabled = !company || !subscription?.enabled || Boolean(activityAction);
  $('journal-toggle').disabled = !company;
  $('feed-description').textContent = value.selection?.considered !== undefined ? `Последний отбор${value.selection.scanned_at ? ' · ' + date(value.selection.scanned_at) : ''} · ${roleLabel()}: проверено ${count(value.selection.considered)}, значимых ${count(value.selection.eligible)}, добавлено в очередь ${count(value.selection.queued)}. Просмотр не вызывает модель.` : 'Отбор для выбранной компании и роли ещё не выполнялся. Просмотр ленты не вызывает модель.';
  if (!company) clearSummary();
  renderEmpty(); renderJobs(); renderActivity();
}
function clearSummary() {
  $('queue-count').textContent = '—'; $('queue-summary').textContent = 'Выберите компанию';
  $('card-count').textContent = '—'; $('budget-count').textContent = '—';
  $('budget-summary').textContent = 'Расход загрузится после выбора компании';
}
async function refreshStatus(rev = epoch) {
  if (!company) { const v=unbox(await request("/v1/runtime")); if(rev===epoch) displayRuntime({...v,subscriptions:[]}); return; }
  const value = unbox(await request('/v1/live/status' + (company ? '?' + scopeQuery() : ''))); if (rev !== epoch) return; displayRuntime(value);
}
async function refresh(rev = epoch, initial = false) {
  activityRead = true; renderActivity();
  const tasks = [refreshStatus(rev), ...(company ? [refreshFeed(rev, { initial }), refreshJobs(rev)] : [])];
  const results = await Promise.allSettled(tasks); if (rev !== epoch) return;
  activityRead = false;
  const errors = results.filter(item => item.status === 'rejected');
  connectionFailed = Boolean(errors.length);
  renderActivity();
  $('connection').textContent = errors.length ? 'Проверяем обновления' : 'Обновлено ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); $('connection').dataset.offline = String(Boolean(errors.length));
  for (const error of errors) recordError('Обновление результатов', error.reason);
  if (errors.length && initial) notice('Не удалось загрузить все результаты. Повторим проверку автоматически.');
}
async function companies() {
  const revision = ++companyListEpoch;
  try {
    const value = unbox(await request('/v1/companies?' + query({ offset: companyOffset, limit: 100 }))); if (revision !== companyListEpoch) return;
    $('company-list').replaceChildren(node('option', 'Выберите из списка')); $('company-list').firstChild.value = '';
    for (const item of value.items || []) { const id = typeof item === 'string' ? item : item.company_id || item.id; const option = node('option', id); option.value = id; $('company-list').append(option); }
    $('company-list').value = Array.from($('company-list').children).some(option => option.value === company) ? company : '';
    $('more-companies').hidden = (value.items || []).length < 100;
  } catch (error) { notice(friendlyError(error), true); }
}
async function chooseCompany(id) {
  save(); requestedCompany = id; feedTotal = null; feedRunning = null; feedRunningCount = null; const rev = ++epoch; activityRead = false; activityAction = null; connectionFailed = false; journalPage = 0; $('event-journal').hidden = true; $('journal-toggle').setAttribute('aria-expanded', 'false'); $('journal-toggle').disabled = true; $('feed-description').textContent = 'Загружаем сохранённую ленту выбранной компании и роли.'; company = ''; $('company-list').value = ''; clearSummary(); runtime = null; firstFeed = true; cursor = null; jobs = [];
  cards.clear(); elements.clear(); $('feed').replaceChildren(); $('journal-events').replaceChildren(); $('load-more').hidden = true; $('subscribe').disabled = true; $('scan').disabled = true; $('pause-subscription').hidden = true;
  if (!id) { $('profile').textContent = 'Профиль не выбран'; renderEmpty(); renderActivity(); return; }
  activityRead = true; renderActivity();
  $('profile').textContent = 'Загружаю профиль…';
  try {
    const value = await request('/v1/companies/' + encodeURIComponent(id)); if (rev !== epoch) return;
    const profile = value.data; company = profile.company_id; $('company-id').value = company;
    $('company-list').value = Array.from($('company-list').children).some(option => option.value === company) ? company : '';
    $('profile').textContent = `${company} · ${profile.industry?.name || 'Отрасль не указана'} · ${profile.geography?.region || 'Регион не указан'}`;
    if (value.meta?.mode === 'mock') { company = ''; activityRead = false; $('profile').textContent += ' · учебный профиль не используется в live-ленте'; renderEmpty(); renderActivity(); return; }
    notice('Компания выбрана. Загружаю сохранённые результаты.'); $('subscribe').disabled = false; $('scan').disabled = false;
    await refresh(rev, true); if (rev === epoch) { save(); notice(''); }
  } catch (error) { if (rev === epoch) { activityRead = false; connectionFailed = true; $('profile').textContent = 'Профиль не загружен'; notice(friendlyError(error), true); renderEmpty(); renderActivity(); } }
}
async function subscription(enabled) {
  if (!company) return; const cid = company, selectedRole = role, rev = epoch; if (activityAction) return; const action = { title: enabled ? 'Включаем подбор' : 'Останавливаем автоподбор' }; activityAction = action; renderActivity(); $('scan').disabled = true; $('subscribe').disabled = true; $('pause-subscription').disabled = true;
  try { await request('/v1/live/subscriptions', { company_id: cid, audience_role: selectedRole, limit: 5, min_score: 0.2, enabled }); if (rev !== epoch) return; notice(enabled ? 'Подбор включён. Значимые новости будут обработаны в фоне.' : 'Автоподбор остановлен для компании и роли. Уже поставленные задания, включая вопросы, могут завершиться и расходовать бюджет.'); await refresh(rev); }
  catch (error) { if (rev === epoch) notice(friendlyError(error), true); } finally { if (activityAction === action) { activityAction = null; $('pause-subscription').disabled = false; renderActivity(); $('scan').disabled = !runtime?.subscriptions?.some(item => item.company_id === cid && item.audience_role === selectedRole && item.enabled); } if (company === cid && role === selectedRole && !runtime?.subscriptions?.some(item => item.company_id === cid && item.audience_role === selectedRole && item.enabled)) $('subscribe').disabled = false; }
}
function setFavoriteFilter(selected) {
  save(); favorites = selected; epoch++; feedTotal = null; feedRunning = null; feedRunningCount = null; firstFeed = true;
  $('all-cards').classList.toggle('active', !selected); $('all-cards').setAttribute('aria-pressed', String(!selected)); $('favorite-cards').classList.toggle('active', selected); $('favorite-cards').setAttribute('aria-pressed', String(selected));
  cards.clear(); elements.clear(); $('feed').replaceChildren(); save(); renderEmpty(); if (company) void refresh(epoch, true);
}
$('company-form').addEventListener('submit', event => { event.preventDefault(); void chooseCompany($('company-id').value.trim()); });
$('company-list').addEventListener('change', () => { if ($('company-list').value) void chooseCompany($('company-list').value); });
$('more-companies').addEventListener('click', () => { companyOffset += 100; void companies(); });
$('role').value = role;
$('role').addEventListener('change', () => { role = $('role').value; const selected = requestedCompany || company; void chooseCompany(selected); });
$('subscribe').addEventListener('click', () => void subscription(true)); $('pause-subscription').addEventListener('click', () => void subscription(false));
$('scan').addEventListener('click', async () => { if (!company || activityAction || $('scan').disabled) return; const rev = epoch, action = { title: 'Обновляем подбор новостей' }; activityAction = action; renderActivity(); $('scan').disabled = true; try { await request('/v1/live/scan', { company_id: company, audience_role: role }); if (rev === epoch) { notice('Подбор обновлён. Задачи сохраняются в очереди.'); await refresh(rev); } } catch (error) { if (rev === epoch) notice(friendlyError(error), true); } finally { if (activityAction === action) { activityAction = null; renderActivity(); $('scan').disabled = !runtime?.subscriptions?.some(item => item.company_id === company && item.audience_role === role && item.enabled); } } });
$('journal-toggle').addEventListener('click', () => { const open = $('event-journal').hidden; $('event-journal').hidden = !open; $('journal-toggle').setAttribute('aria-expanded', String(open)); renderJobs(); });
$('journal-close').addEventListener('click', () => { $('event-journal').hidden = true; $('journal-toggle').setAttribute('aria-expanded', 'false'); });
$('journal-prev').addEventListener('click', () => { journalPage = Math.max(0, journalPage - 1); renderJobs(); });
$('journal-next').addEventListener('click', () => { journalPage++; renderJobs(); });
$('all-cards').addEventListener('click', () => setFavoriteFilter(false)); $('favorite-cards').addEventListener('click', () => setFavoriteFilter(true));
$('load-more').addEventListener('click', async () => { if (!cursor) return; const rev = epoch; $('load-more').disabled = true; try { await refreshFeed(rev, { append: true }); save(); } catch (error) { if (rev === epoch) notice(friendlyError(error), true); } finally { $('load-more').disabled = false; } });
let scrollTimer; window.addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(save, 200); }, { passive: true });
window.addEventListener('pagehide', save);
$('all-cards').classList.toggle('active', !favorites); $('all-cards').setAttribute('aria-pressed', String(!favorites)); $('favorite-cards').classList.toggle('active', favorites); $('favorite-cards').setAttribute('aria-pressed', String(favorites));
await companies();
if (persisted.company) await chooseCompany(String(persisted.company)); else await refresh();
async function poll() {
  if (polling || document.hidden || activityAction) return;
  polling = true;
  try { await refresh(); } finally { polling = false; }
}
let timer;
function startPolling() { clearInterval(timer); timer = setInterval(poll, 10000); }
startPolling();
document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
window.addEventListener('pageshow', () => { startPolling(); void poll(); });
window.addEventListener('pagehide', () => clearInterval(timer));
