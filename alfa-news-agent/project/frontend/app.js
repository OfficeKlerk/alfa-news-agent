"use strict";
const $ = (s) => document.querySelector(s);
const state = {
  company: null,
  news: [],
  selected: null,
  analysis: null,
  bootstrap: null,
  view: "events",
  tab: "analysis",
  generation: 0,
  conversations: {},
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n || 0);
const url = (s) => {
  try {
    const u = new URL(s);
    return ["https:", "http:"].includes(u.protocol) ? u.href : "";
  } catch {
    return "";
  }
};
const CONV_KEY = "alfa-conversations";
function loadConversations() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONV_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}
function saveConversations() {
  try {
    localStorage.setItem(CONV_KEY, JSON.stringify(state.conversations));
  } catch {}
}
function notice(text, error = false) {
  const n = $("#notice");
  n.textContent = text;
  n.className = "notice" + (error ? " error" : "");
  n.hidden = !text;
}
async function api(path, options = {}) {
  if (window.__V1?.active) {
    const headers = { ...(state.company ? { "X-Company-ID": state.company.id } : {}), ...options.headers };
    return window.__V1.handle(path, { ...options, headers });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100000, state.bootstrap?.request_timeout_ms ?? 100000));
  try {
    const r = await fetch(path, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(state.company ? { "X-Company-ID": state.company.id } : {}),
        ...options.headers,
      },
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || "Ошибка сервера");
    return body;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Истекло время ожидания. Повторите запрос.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
function loading(text) {
  return `<div class="loading"><span class="spinner"></span>${esc(text)}</div>`;
}
function showView(view) {
  state.view = view;
  for (const x of ["events", "profile", "library"]) $(`#${x}-view`).hidden = x !== view;
  document.querySelectorAll("[data-view]").forEach((b) => {
    b.classList.toggle(b.classList.contains("nav-item") ? "active" : "selected", b.dataset.view === view);
  });
  if (view === "library") searchResearch();
}
async function bootstrap() {
  try {
    state.conversations = loadConversations();
    state.bootstrap = await api("/api/bootstrap");
    const b = state.bootstrap;
    $("#stat-companies").textContent = fmt(b.stats.companies);
    $("#mode").textContent = b.mode === "demo" ? "Деморежим · без LLM" : `Live · ${b.model.split("/")[1]}`;
    $("#mode").classList.toggle("live", b.mode === "live");
    if (b.mode === "demo")
      notice(
        "Деморежим: компании и материалы банка настоящие, стартовые новости синтетические. Анализ и ответы шаблонные, модель не вызывается.",
      );
    else if (!b.key_configured)
      notice("Live-режим выбран, но ключ не настроен. Добавьте LLM_API_KEY в .env и перезапустите сервер.", true);
    let remembered = null;
    try {
      remembered = localStorage.getItem("alfa-company");
    } catch {}
    await selectCompany(remembered || b.suggestions[0]?.id || "U_67");
  } catch (e) {
    notice(e.message, true);
    $("#feed").innerHTML =
      '<p class="state-error">Не удалось загрузить приложение. Проверьте сервер и перезагрузите страницу.</p>';
  }
}
async function selectCompany(cid) {
  const gen = ++state.generation;
  state.selected = null;
  state.analysis = null;
  $("#analysis-panel").innerHTML = loading("Загружаем профиль…");
  const company = await api("/api/companies/" + encodeURIComponent(cid));
  if (gen !== state.generation) return;
  state.company = company;
  try {
    localStorage.setItem("alfa-company", cid);
  } catch {}
  $("#company-name").textContent = company.name;
  $("#company-picker").textContent = company.name + " ⌄";
  $("#company-description").textContent = company.industry + " · " + company.region;
  $("#company-tags").innerHTML = [
    ...company.products,
    company.foreign_trade ? "Есть внешнеторговый признак" : "",
    company.workers ? "Сотрудники: " + company.workers : "",
  ]
    .filter(Boolean)
    .map((t) => `<span class="tag">${esc(t)}</span>`)
    .join("");
  renderProfile();
  await loadFeed();
  if (gen === state.generation)
    $("#analysis-panel").innerHTML =
      '<div class="empty"><div class="empty-icon">◈</div><h2>У события есть контекст</h2><p>Выберите новость слева.<br>Здесь появятся её связь с компанией,<br>возможные последствия и источники.</p><span class="empty-footnote">Факты · Позиция банка · Выводы AI</span></div>';
}
async function loadFeed() {
  const cid = state.company?.id;
  if (!cid) return;
  const response = await api("/api/feed?demo=" + ($("#real-only").checked ? "0" : "1"));
  if (cid !== state.company?.id) return;
  state.news = response.items;
  renderFeed();
}
function renderFeed() {
  $("#news-count").textContent = state.news.length;
  $("#feed").innerHTML = state.news.length
    ? state.news
        .map(
          (n) => {
            const ranking = feedRanking(n);
            return `<button class="news-card ${n.id === state.selected ? "active" : ""}" data-nid="${esc(n.id)}"><div class="card-meta"><span class="priority ${ranking.neutral ? "low" : ""}" title="${esc(ranking.explanation)}">${esc(ranking.label)}</span><span>${esc(n.published.slice(0, 10))}</span></div><h3>${esc(n.title)}</h3><p>${esc(n.reasons[0])}</p><div class="card-footer"><span>${n.is_demo ? '<span class="test-badge">ТЕСТОВОЕ СОБЫТИЕ</span>' : "Добавлено из источника"}</span><span class="relevance" title="${esc(ranking.explanation)}">${esc(ranking.value)}</span></div></button>`;
          },
        )
        .join("")
    : '<div class="source-card"><p class="muted">Событий пока нет. Добавьте текст новости или загрузите настроенные RSS.</p></div>';
}
function feedRanking(news) {
  if (!Object.hasOwn(news, "score") && !Object.hasOwn(news, "score_kind")) {
    return { label: `${news.priority} приоритет`, value: `Индекс ${news.relevance} / 100 ↗`,
      neutral: news.relevance < 60, explanation: "Индекс по правилам отбора новостей." };
  }
  const scales = new Map([
    ["manual_feature_baseline", ["Баллы по правилам", "Сумма вкладов признаков. Шкала не ограничена 0–1; это не вероятность и не размер ущерба."]],
    ["logistic_relevance_uncalibrated", ["Модель · без калибровки", "Неоткалиброванный балл релевантности. Он не показывает вероятность события или ущерба."]],
    ["mock", ["Тестовая оценка", "Условный тестовый балл; не оценка важности или вероятности события."]],
  ]);
  const [label, explanation] = scales.get(news.score_kind) || ["Шкала не указана", "Без описания шкалы балл нельзя интерпретировать как важность или вероятность."];
  const value = Number.isFinite(news.score)
    ? "Балл " + new Intl.NumberFormat("ru-RU", { maximumSignificantDigits: 6 }).format(news.score)
    : "Балл недоступен";
  return { label, value, explanation, neutral: true };
}
async function openNews(nid, force = false) {
  const cid = state.company.id;
  const gen = ++state.generation;
  state.selected = nid;
  state.analysis = null;
  renderFeed();
  const n = state.news.find((n) => n.id === nid);
  $("#analysis-panel").innerHTML =
    `<div class="analysis-head"><div class="analysis-meta">ПОДГОТОВКА АНАЛИЗА</div><h2>${esc(n?.title || "Событие")}</h2></div>${loading("Собираем контекст и проверяем источники…")}<div class="analysis-body"><p class="validation-note">${state.bootstrap.mode === "live" ? "Модель выбирает инструменты и выполняет поиск. Запрос может занять несколько минут." : "Шаблонный анализ без модели; поиск по материалам банка выполняется."}</p></div>`;
  try {
    const job = await api("/api/analysis", {
      method: "POST",
      body: JSON.stringify({ news_id: nid, role: $("#role").value, force }),
    });
    for (let i = 0; i < 480; i++) {
      if (gen !== state.generation || cid !== state.company.id) return;
      const j = await api("/api/jobs/" + job.job_id, { headers: { "X-Company-ID": cid } });
      if (gen !== state.generation) return;
      if (j.status === "completed") {
        state.analysis = j.result;
        state.tab = "analysis";
        renderAnalysis();
        return;
      }
      if (j.status === "failed") throw new Error(j.error || "Анализ не выполнен");
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error("Анализ не завершился за отведённое время. Попробуйте снова.");
  } catch (e) {
    if (gen === state.generation)
      $("#analysis-panel").innerHTML =
        `<div class="state-error"><h2>Не удалось подготовить анализ</h2><p>${esc(e.message)}</p><button class="button dark" data-retry="${esc(nid)}">Повторить</button></div>`;
  }
}
function sourceCards(sources) {
  return sources
    .map(
      (s) =>
        `<div class="source-card"><div class="source-kind">${esc(s.kind === "bank" ? "АНАЛИТИКА БАНКА · OCR · СТР. " + s.page : s.kind === "company" ? "ДАННЫЕ КОМПАНИИ" : s.is_demo ? "СИНТЕТИЧЕСКАЯ НОВОСТЬ" : "НОВОСТЬ")} ${s.published ? esc(s.published) : ""}</div><h3>${esc(s.title)}</h3><div class="source-text">${esc(s.kind === "company" ? JSON.stringify({ id: state.company.id, industry: state.company.industry, products: state.company.products, foreign_trade: state.company.foreign_trade, top_partners: state.company.top_partners }, null, 2) : s.text)}</div>${url(s.url) ? `<p><a href="${esc(url(s.url))}" target="_blank" rel="noopener noreferrer">Открыть оригинал ↗</a></p>` : ""}<span class="citation">${esc(s.id)}</span></div>`,
    )
    .join("");
}
function renderAnalysis() {
  const a = state.analysis;
  if (!a) return;
  const list = (title, items) =>
    items.length
      ? `<section class="analysis-section"><h3>${title}</h3><ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>`
      : "";
  let body = "";
  if (state.tab === "analysis") {
    body = `<section class="analysis-section"><h3>Что произошло</h3><p>${esc(a.summary)}</p></section><div class="context-box"><h3>ПОЧЕМУ ЭТО ВАЖНО ДЛЯ ВАС</h3><p>${esc(a.why_relevant)}</p></div>`;
    body += a.claims
      .map(
        (c) =>
          `<div class="claim"><span class="claim-label ${esc(c.kind)}">${{ fact: "ФАКТ ИЗ ИСТОЧНИКА", bank: "ФРАГМЕНТ ПОЗИЦИИ БАНКА", ai: "ПЕРСОНАЛЬНЫЙ ВЫВОД AI" }[c.kind]}</span><p>${esc(c.text)}</p>${c.source_ids.map((id) => `<button class="citation" data-tab="sources">${esc(id === "company" ? "Данные компании" : id.startsWith("research:") ? "Аналитика банка" : "Новостной источник")} ↗</button>`).join("")}</div>`,
      )
      .join("");
    if (!a.claims.some((c) => c.kind === "bank"))
      body +=
        '<div class="limit-box">Подтверждённая применимая позиция банка не выделена. Найденные материалы можно проверить во вкладке источников.</div>';
    body +=
      "<br>" +
      list("Возможные риски", a.risks) +
      list("Возможности", a.opportunities) +
      list("Что проверить", a.actions) +
      `<div class="limit-box"><strong>Ограничения анализа</strong><ul>${a.limitations.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
  } else if (state.tab === "sources")
    body = `<p class="validation-note">Это реестр использованного и найденного контекста. Связи конкретных утверждений указаны в анализе. OCR может ошибаться; даты и цифры проверяйте по оригиналу.</p>${sourceCards(a.sources)}`;
  else
    body = `<p class="validation-note">${esc(a.validation)}</p>${a.trace.map((t, i) => `<div class="trace-step"><span>${i + 1}</span><div><strong>${esc(t.step)}</strong><p>${esc(t.detail)}</p><span class="source-kind">${fmt(t.elapsed_ms)} мс от начала</span></div></div>`).join("")}`;
  $("#analysis-panel").innerHTML =
    `<div class="analysis-head"><div class="analysis-meta"><span>${a.mode === "demo" ? "ДЕМО · БЕЗ ВЫЗОВА LLM" : "AI · " + esc(a.model)}</span><span>·</span><span>${a.cached ? "Из кеша" : "Новый анализ"}</span>${a.is_demo_news ? '<span class="test-badge">ТЕСТОВАЯ НОВОСТЬ</span>' : ""}</div><h2>${esc(a.title)}</h2><div class="panel-actions"><span class="source-kind">${esc(a.role)}</span><button class="text-button" data-retry="${esc(a.news_id)}">Пересчитать ↻</button></div></div><div class="analysis-tabs"><button data-tab="analysis" class="${state.tab === "analysis" ? "active" : ""}">Интерпретация</button><button data-tab="sources" class="${state.tab === "sources" ? "active" : ""}">Источники · ${a.sources.length}</button><button data-tab="trace" class="${state.tab === "trace" ? "active" : ""}">Ход анализа</button></div><div class="analysis-body">${body}</div><div class="question-box"><h3>Уточните влияние на ваш бизнес</h3><div id="answers">${(state.conversations[a.id] || []).map((x) => `<div class="question-label">${esc(x.question)}</div><div class="answer">${esc(x.answer)}</div>`).join("")}</div><form id="question-form" class="question-form"><input name="question" minlength="3" maxlength="2000" placeholder="Например: какие данные стоит проверить?" required><button class="button dark">Спросить ↗</button></form></div>`;
}
function renderProfile() {
  const c = state.company;
  const cell = (a, b) => `<div class="profile-cell"><span>${esc(a)}</span><strong>${esc(b || "Нет данных")}</strong></div>`;
  $("#profile-view").innerHTML =
    `<h2>Что известно о компании</h2><p class="muted">Исходные признаки используются при отборе и анализе событий.</p><div class="profile-grid">${cell("Идентификатор", c.id)}${cell("Регион", c.region)}${cell("Основная деятельность", c.industry)}${cell("Продукты банка", c.products.join(", "))}${cell("Внешнеторговый признак", c.foreign_trade ? "Есть" : "В исходных данных не отмечен")}${cell("Численность работников", c.workers)}${cell("REVENUE_COMPANY · единицы не подтверждены", fmt(c.revenue))}${cell("Группа компаний", c.group_id)}${cell("Исходящие связи · строк платежей", fmt(c.outgoing.n))}${cell("Входящие связи · строк платежей", fmt(c.incoming.n))}</div><h3>Крупнейшие получатели платежей</h3><table class="profile-table"><thead><tr><th>Контрагент</th><th>Отрасль</th><th>Сумма в данных</th></tr></thead><tbody>${c.top_partners.map((p) => `<tr><td>${esc(p.id)}</td><td>${esc(p.industry)}</td><td>${fmt(p.amount)}</td></tr>`).join("") || '<tr><td colspan="3">Связи не найдены</td></tr>'}</tbody></table><div class="limit-box">${c.data_notes.map(esc).join("<br>")}</div>`;
}
let searchTimer;
async function searchCompanies() {
  const query = $("#company-search").value;
  const d = await api("/api/companies?q=" + encodeURIComponent(query));
  if (query !== $("#company-search").value) return;
  $("#company-results").innerHTML =
    d.items
      .map(
        (c) =>
          `<button class="company-result" data-cid="${esc(c.id)}"><strong>Компания ${esc(c.id)}</strong><p>${esc(c.industry)} · ${esc(c.region)}</p></button>`,
      )
      .join("") || '<p class="muted">Ничего не найдено.</p>';
}
async function searchResearch() {
  const query = $("#research-query").value;
  $("#research-results").innerHTML = loading("Ищем фрагменты…");
  try {
    const r = await api("/api/research?q=" + encodeURIComponent(query));
    if (query !== $("#research-query").value) return;
    $("#research-results").innerHTML = r.items.length
      ? sourceCards(r.items.map((d) => ({ ...d, kind: "bank" })))
      : '<p class="muted">Подходящие фрагменты не найдены. Уточните запрос.</p>';
  } catch (e) {
    $("#research-results").textContent = e.message;
  }
}
document.addEventListener("click", async (event) => {
  const b = event.target.closest("button");
  if (!b) return;
  try {
    if (b.dataset.view) showView(b.dataset.view);
    if (b.dataset.close) $("#" + b.dataset.close).close();
    if (b.dataset.cid) {
      $("#picker-dialog").close();
      await selectCompany(b.dataset.cid);
    }
    if (b.dataset.nid) await openNews(b.dataset.nid);
    if (b.dataset.retry) await openNews(b.dataset.retry, true);
    if (b.dataset.tab) {
      state.tab = b.dataset.tab;
      renderAnalysis();
    }
  } catch (e) {
    notice(e.message, true);
  }
});
$("#company-picker").addEventListener("click", () => {
  $("#picker-dialog").showModal();
  searchCompanies().catch((e) => notice(e.message, true));
  $("#company-search").focus();
});
$("#company-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchCompanies().catch((e) => notice(e.message, true)), 250);
});
$("#add-news").addEventListener("click", () => $("#news-dialog").showModal());
$("#refresh").addEventListener("click", () => loadFeed().catch((e) => notice(e.message, true)));
$("#real-only").addEventListener("change", () => loadFeed().catch((e) => notice(e.message, true)));
$("#role").addEventListener("change", () => {
  if (state.selected) openNews(state.selected);
});
$("#research-form").addEventListener("submit", (e) => {
  e.preventDefault();
  searchResearch();
});
$("#news-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button");
  button.disabled = true;
  try {
    const n = await api("/api/news", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
    $("#news-dialog").close();
    e.target.reset();
    $("#real-only").checked = false;
    showView("events");
    await loadFeed();
    if (n.date_status && n.date_status !== "valid") {
      notice(n.date_status === "future" ? "Новость сохранена. Она появится в ленте после даты публикации." : "Новость сохранена для проверки. Укажите корректную дату публикации из первоисточника, чтобы добавить её в ленту.");
    } else {
      await openNews(n.id);
    }
  } catch (err) {
    notice(err.message, true);
  } finally {
    button.disabled = false;
  }
});
$("#rss-refresh").addEventListener("click", async (e) => {
  const b = e.target;
  b.disabled = true;
  try {
    const r = await api("/api/feeds/refresh", { method: "POST", body: "{}" });
    notice(`Обработано записей RSS: ${r.processed}. Ошибок источников: ${r.failed_hosts.length}.`);
    await loadFeed();
  } catch (err) {
    notice(err.message, true);
  } finally {
    b.disabled = false;
  }
});
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "question-form") return;
  e.preventDefault();
  const form = e.target;
  const input = form.elements.question;
  const q = input.value;
  const a = state.analysis;
  const gen = state.generation;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const response = await api("/api/analyses/" + a.id + "/questions", { method: "POST", body: JSON.stringify({ question: q }) });
    if (gen !== state.generation || state.analysis?.id !== a.id) return;
    state.conversations[a.id] ??= [];
    state.conversations[a.id].push({ question: q, answer: response.answer });
    saveConversations();
    const answers = $("#answers");
    if (answers)
      answers.insertAdjacentHTML(
        "beforeend",
        `<div class="question-label">${esc(q)}</div><div class="answer">${esc(response.answer)}</div>`,
      );
    input.value = "";
  } catch (err) {
    notice(err.message, true);
  } finally {
    button.disabled = false;
  }
});
bootstrap();
