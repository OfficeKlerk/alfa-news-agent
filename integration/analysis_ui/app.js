import { AlfaApi } from '/integration/client.js';
import { AnalysisState, safeUrl, sourceAnchor } from './state.js';
const api = new AlfaApi(), state = new AnalysisState(), $ = id => document.getElementById(id);
let company = '', events = [], selected = null, offset = 0, busy = false, companyRevision = 0, newsRevision = 0, listRevision = 0;
let polling = false;
let generationEnabled = false;
const node = (tag, text, className) => { const n = document.createElement(tag); if(text !== undefined) n.textContent = text; if(className) n.className = className; return n; };
const localDate = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0,16);
$('as-of').value = localDate(); $('news-form').elements.published.value = localDate();
function status(message, error = false) { $('status').textContent = message; $('status').dataset.error = String(error); }
function fail(e) { if(e.name !== 'AbortError') status(`${e.code || 'ERROR'}: ${e.message}${e.requestId ? ' · запрос ' + e.requestId : ''}${e.diagnostics?.generation_id ? ' · диагностика ' + e.diagnostics.generation_id : ''}${e.diagnostics?.draft_saved === false ? ' · снимок черновика не сохранён' : ''}`, true); }
function controls() { $('prepare').disabled = !company || !selected || busy; $('generate').disabled = !generationEnabled || busy || !state.preview; $('ask').disabled = !generationEnabled || busy || !state.result; $('cancel').hidden = !busy; }
function invalidate(message) {
  state.reset(); busy = false; $('preview').hidden = true; $('answer').hidden = true; $('empty').hidden = false;
  $('history').replaceChildren(); controls(); if(message) status(message);
}
function requestBody() {
  const asOf = new Date($('as-of').value); if(!Number.isFinite(asOf.getTime())) throw new Error('Укажите дату анализа');
  return { company_id: company, event: selected, as_of: asOf.toISOString(), audience_role: $('role').value };
}
async function companies() {
  const revision = ++listRevision;
  try { const value = await api.companies(undefined, offset); if(revision !== listRevision) return; $('companies').replaceChildren(node('option', 'Выберите компанию'));
    $('companies').firstChild.value = ''; for(const id of value.data.items) { const o = node('option', id); o.value = id; $('companies').append(o); }
    $('prev').disabled = offset === 0; $('next').disabled = value.data.items.length < 100;
  } catch(e) { fail(e); }
}
async function loadCompany(id, refreshNews = true) {
  const rev = ++companyRevision; company = ''; invalidate('Загружаю профиль…'); $('profile').textContent = 'Загрузка…';
  if(!id) { $('profile').textContent = 'Профиль не выбран'; return; }
  try { const value = await api.profile(id); if(rev !== companyRevision) return; company = value.data.company_id; $('company-id').value = company;
    const p = value.data; $('profile').textContent = `${p.industry.name || 'Отрасль неизвестна'} · ${p.geography.region || 'Регион неизвестен'} · ${value.meta.mode === 'mock' ? 'Учебный профиль' : 'Профиль из базы'}`;
    controls(); if(refreshNews) await search(); if(rev === companyRevision) status(refreshNews ? 'Компания выбрана. Новости отсортированы по её профилю.' : 'Компания выбрана.');
  } catch(e) { if(rev === companyRevision) { $('profile').textContent = 'Профиль не загружен'; fail(e); } }
}
function setEvents(items, preserve = false) {
  const previous = selected;
  // Keep the reviewed snapshot visible until the user chooses a newer revision.
  if (preserve && previous && !items.some(item => JSON.stringify(item) === JSON.stringify(previous))) items = [previous, ...items];
  newsRevision++; events = items; selected = preserve ? previous : null; $('news').replaceChildren(node('option', 'Выберите новость')); $('news').firstChild.value = '';
  items.forEach((event, i) => { const o = node('option', `${event.is_mock ? '[Учебная] ' : ''}${event.title}`); o.value = String(i); $('news').append(o); });
  if (preserve && previous) { $('news').value = String(items.findIndex(item => JSON.stringify(item) === JSON.stringify(previous))); controls(); }
  else invalidate(items.length ? 'Выберите новость из списка. Порядок учитывает выбранную компанию.' : 'Доступных новостей пока нет. Проверьте статус источников.');
}
async function search(preserve = false) {
  const rev = ++newsRevision, companyAtStart = company;
  try { const date = new Date($('as-of').value); if(!Number.isFinite(date.getTime())) throw new Error('Укажите дату анализа');
    const value = await api.search($('search').value, date.toISOString()); if(rev !== newsRevision) return;
    let items = value.data.items;
    if (companyAtStart && items.length) {
      const ranked = await api.rank(companyAtStart, items, date.toISOString());
      if(rev !== newsRevision || company !== companyAtStart) return;
      const byId = new Map(items.map(item => [item.event_id, item]));
      items = ranked.data.items.map(item => byId.get(item.event_id)).filter(Boolean);
    }
    setEvents(items, preserve);
  } catch(e) { if(rev === newsRevision) fail(e); }
}
async function collectionStatus() {
  try {
    const value = await api.feedStatus(), s = value.data;
    const ok = s.feeds.filter(feed => feed.last_success), failed = s.feeds.filter(feed => feed.last_error);
    $('collection-status').textContent = `${s.enabled ? 'Автосбор включён' : 'Автосбор выключен'} · ${ok.length}/${s.feeds.length} источников загружено` +
      (s.running ? ' · идёт загрузка' : '') + (s.last_success ? ` · последнее обновление ${new Date(s.last_success).toLocaleString('ru-RU')}` : '') +
      failed.map(feed => ` · ${new URL(feed.url).hostname}: ${feed.last_error}`).join('');
    return s;
  } catch(e) { $('collection-status').textContent = 'Статус сбора недоступен: ' + e.message; return null; }
}
async function runtimeStatus() {
  try {
    const value = await api.runtimeStatus(); generationEnabled = value.data.generation_enabled;
    $('generation-status').textContent = generationEnabled ? 'Генерация включена. Анализ и уточняющие вопросы расходуют вызовы модели.' :
      'Сбор новостей и персональный отбор работают. Генерация выводов выключена до подключения модели.';
  } catch(e) { generationEnabled = false; $('generation-status').textContent = 'Не удалось проверить доступность генерации: ' + e.message; }
  controls();
}
async function pollNews() {
  if(polling || document.hidden) return;
  polling = true;
  try {
    const s = await collectionStatus();
    if(s && $('follow-news').checked && !busy && !state.preview && !state.result && !selected) {
      $('as-of').value = localDate();
      await search(true);
    }
  } finally { polling = false; }
}
$('collect-news').onclick = async () => {
  $('collect-news').disabled = true;
  try { await api.refreshFeeds(); await collectionStatus(); if(!busy && !state.preview && !state.result) { if($('follow-news').checked) $('as-of').value = localDate(); await search(true); } }
  catch(e) { fail(e); } finally { $('collect-news').disabled = false; }
};
function pickEvent(index) {
  selected = events[index] || null; invalidate(selected ? 'Новость выбрана. Подготовьте контекст.' : 'Выберите новость.');
  $('news-info').textContent = selected ? `${new Date(selected.published_at).toLocaleString('ru-RU')} · ${selected.is_mock ? 'Синтетические данные' : 'Источник требует проверки'} · ${selected.text}` : '';
}
function refs(parent, indexes, claims) {
  const ids = [...new Set((indexes || []).flatMap(i => claims[i]?.source_ids || []))]; const row = node('div', undefined, 'refs');
  for(const id of ids) { const a = node('a', id); a.href = sourceAnchor(id).href; row.append(a); } parent.append(row);
}
function list(title, lines, parent) { if(!lines?.length) return; parent.append(node('h3', title)); const ul = node('ul'); lines.forEach(t => ul.append(node('li', t))); parent.append(ul); }
function renderClaims(claims, parent) {
  claims.forEach((c, i) => { const box = node('div', undefined, 'claim'); box.append(node('strong', `${i + 1}. ${c.kind === 'ai' ? 'Условный вывод' : c.kind === 'bank' ? 'Цитата банка' : 'Факт новости'}`));
    box.append(node(c.quote ? 'blockquote' : 'p', c.text));
    if(c.profile_paths?.length) box.append(node('p', 'Поля компании: ' + c.profile_paths.join(', '), 'conditions'));
    if(c.conditions?.length) box.append(node('p', 'Условия: ' + c.conditions.join('; '), 'conditions'));
    refs(box, [i], claims); parent.append(box); });
}
function render(value) {
  const a = value.data, sections = $('sections'); sections.replaceChildren(); $('claims').replaceChildren(); $('sources').replaceChildren();
  $('mode').textContent = a.mode === 'live' ? `Ответ LLM${value.meta.mode === 'mock' || a.sources.some(s => s.is_mock) ? ' · контекст содержит учебные данные' : ''}` : `Демонстрационный ответ · ${a.mode} · внешняя LLM не использовалась`;
  for(const [key, title] of [['summary','Суть новости'],['why_relevant','Почему это касается компании']]) {
    sections.append(node('h3', title)); const p = node('div'); p.append(node('p', a[key])); refs(p, a.grounding?.[key], a.claims); sections.append(p);
  }
  for(const [key, title] of [['risks','Риски'],['opportunities','Возможности'],['recommendations','Что проверить и сделать']]) {
    if(!a[key].length) continue; sections.append(node('h3', title)); const ul = node('ul');
    a[key].forEach((text, i) => { const li = node('li'); li.append(node('p', text)); const g = a.grounding?.[key]?.[i];
      if(key === 'recommendations' && g) { li.append(node('p', 'Условие: ' + g.condition, 'conditions')); li.append(node('p', 'Нужны данные: ' + g.required_data.join('; '), 'conditions')); }
      refs(li, key === 'recommendations' ? g?.claim_indexes : g, a.claims); ul.append(li); }); sections.append(ul);
  }
  list('Недостающие данные', a.missing_data, sections); list('Ограничения', [...new Set([...a.limitations, ...value.meta.warnings])], sections);
  renderClaims(a.claims, $('claims'));
  a.sources.forEach(s => { const box = node('div', undefined, 'source'); box.id = sourceAnchor(s.id).id;
    box.append(node('strong', `${s.title}${s.is_mock ? ' · учебный источник' : ''}`)); box.append(node('p', `${s.id} · ${s.kind}${s.published_at ? ' · ' + s.published_at : ''}${s.page ? ' · стр. ' + s.page : ''}`, 'muted'));
    const url = safeUrl(s.url); if(url) { const a = node('a', 'Открыть источник'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; box.append(a); }
    const d = node('details'); d.append(node('summary', s.kind === 'company' ? 'Полный профиль компании' : 'Переданный фрагмент')); d.append(node('pre', s.excerpt)); box.append(d); $('sources').append(box); });
  $('answer').hidden = false; $('empty').hidden = true;
}
$('load-company').onclick = () => loadCompany($('company-id').value.trim());
$('company-id').oninput = () => { companyRevision++; company = ''; invalidate('Загрузите профиль по введённому ID.'); };
$('companies').onchange = () => loadCompany($('companies').value);
$('next').onclick = () => { offset += 100; companies(); }; $('prev').onclick = () => { offset = Math.max(0, offset - 100); companies(); };
$('find').onclick = () => search(); $('news').onchange = () => pickEvent($('news').value);
$('as-of').oninput = () => { $('follow-news').checked = false; newsRevision++; invalidate('Дата изменена. Подготовьте новый контекст.'); }; $('role').onchange = () => invalidate('Роль изменена. Подготовьте новый контекст.');
$('news-form').onsubmit = e => {
  e.preventDefault(); const f = e.target.elements, url = safeUrl(f.url.value); if(!url) { fail(new Error('Укажите HTTP/HTTPS-адрес источника без логина и пароля')); return; }
  const published = new Date(f.published.value); if(!Number.isFinite(published.getTime())) { fail(new Error('Укажите дату публикации')); return; }
  const id = 'manual-' + crypto.randomUUID(), title = f.title.value.trim(), text = f.text.value.trim();
  const event = { news_id:id,event_id:id,title,text,event_type:'other',published_at:published.toISOString(),event_at:null,fact_status:'reported',
    okved_divisions:[],countries:[],regions:[],company_ids:[],entity_mapping_source:null,is_mock:false,
    sources:[{id:'news:' + id,kind:'news',title,url,excerpt:text,document_id:null,page:null,published_at:published.toISOString(),is_mock:false}] };
  setEvents([event]); $('news').value = '0'; pickEvent(0);
};
$('import').onchange = async e => {
  const file = e.target.files[0]; if(!file) return;
  const rev = state.revision;
  try { if(file.size > 1000000) throw new Error('JSON больше 1 МБ'); const data = JSON.parse(await file.text()); if(rev !== state.revision) return;
    const items = Array.isArray(data) ? data : data.events || [data.event || data];
    if(!items.length || items.length > 100 || !items.every(item => typeof item.title === 'string' && typeof item.news_id === 'string')) throw new Error('Нужен Event, AnalysisEventRequest или RankRequest, до 100 событий');
    if(data.company_id) await loadCompany(data.company_id, false); setEvents(items);
  } catch(e) { fail(e); } finally { e.target.value = ''; }
};
$('prepare').onclick = async () => {
  invalidate(); const job = state.start(); busy = true; controls(); status('Готовлю контекст без обращения к LLM…');
  try { const body = requestBody(), value = await api.context(body, job.signal); if(!state.current(job)) return;
    state.preview = { body, value }; $('context-json').textContent = JSON.stringify(value, null, 2);
    $('preview-info').textContent = `Компания ${body.company_id} · ${body.event.title} · ${value.data.serialized_bytes} байт · ML ${value.data.input.ranked_item.score} (${value.data.input.ranked_item.score_kind})`;
    $('preview-warnings').textContent = [...value.meta.warnings, ...value.data.input.research.limitations,
      ...(!value.data.input.research.items.length ? ['Банковские материалы отсутствуют.'] : []),
      ...(value.meta.mode === 'mock' || body.event.is_mock ? ['Есть учебные данные.'] : [])].join(' ');
    $('preview').hidden = false; $('empty').hidden = true; status('Контекст готов. Просмотрите данные перед формированием ответа.');
  } catch(e) { if(state.current(job)) fail(e); } finally { if(state.current(job)) { busy = false; controls(); } }
};
$('generate').onclick = async () => {
  if(!generationEnabled || !state.preview || busy) return; const job = state.start(), preview = state.preview; busy = true; controls(); status('Формирую и проверяю ответ…');
  state.result = null; $('answer').hidden = true; $('history').replaceChildren();
  try { const value = await api.analyzeEvent({ ...preview.body, expected_context_sha256: preview.value.data.sha256 }, job.signal);
    if(!state.current(job)) return; state.result = value; render(value); $('history').replaceChildren(); status('Анализ готов. Основания и ограничения приведены ниже.');
  } catch(e) { if(state.current(job)) { if(e.status === 409) { state.preview = null; $('preview').hidden = true; } fail(e); } }
  finally { if(state.current(job)) { busy = false; controls(); } }
};
$('cancel').onclick = () => invalidate('Ожидание прекращено. Уже отправленный запрос LLM может завершиться и быть учтён в лимите.');
$('question-form').onsubmit = async e => {
  e.preventDefault(); if(!generationEnabled || !state.result || busy) return; const job = state.start(), question = $('question').value.trim(), a = state.result.data;
  busy = true; controls(); status('Готовлю ответ на уточнение…');
  try { const value = await api.question(a.id, a.company_id, question, job.signal); if(!state.current(job)) return;
    const box = node('div', undefined, 'message'); box.append(node('strong', question)); box.append(node('p', value.data.answer));
    const claims = value.data.claims || value.data.source_ids.map(id => ({source_ids:[id]})); refs(box, claims.map((_, i) => i), claims);
    list('Недостающие данные', value.data.missing_data, box); list('Ограничения', value.data.limitations, box);
    if(value.data.claims) { const details = node('details'); details.append(node('summary','Основания ответа')); renderClaims(value.data.claims,details); box.append(details); }
    $('history').append(box); $('question').value = ''; status('Ответ на уточнение готов.');
  } catch(e) { if(state.current(job)) fail(e); } finally { if(state.current(job)) { busy = false; controls(); } }
};
$('download').onclick = () => { if(!state.result) return; const url = URL.createObjectURL(new Blob([JSON.stringify(state.result, null, 2)], {type:'application/json'}));
  const a = node('a'); a.href = url; a.download = 'analysis-' + state.result.data.company_id + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
await Promise.all([companies(), search(), collectionStatus(), runtimeStatus()]); controls();
const pollTimer = setInterval(() => void pollNews(), 30000);
window.addEventListener('pagehide', () => clearInterval(pollTimer), { once: true });
