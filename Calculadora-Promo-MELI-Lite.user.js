// ==UserScript==
// @name         Calculadora Promo — MELI Margem Lite 3
// @namespace    http://tampermonkey.net/
// @version      9.12.0-LITE
// @description  Exibe somente custo, imposto, lucro e margem nas promoções visíveis e gera diagnóstico de desempenho no F12.
// @match        https://vendedores.mercadolivre.com.br/anuncios/lista/promos*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      docs.google.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const APP = '[MELI Margem Lite]';
  const VERSION = '9.12.0-LITE';
  const BOX_SELECTOR = '.sc-list-collapsible-row__promotion-box';
  // Controles solicitados pelo usuário. Não combinamos o trigger aberto com o
  // trigger fechado para impedir ciclos de abre/fecha após atualizações do DOM.
  const PROMOTION_TRIGGER_SELECTOR =
    'button.andes-button.sc-list-collapsible-row__trigger' +
    '.sc-list-collapsible-row__trigger--up-enabled' +
    '.andes-button--small.andes-button--mute';
  const CHEVRON_SELECTOR =
    'div.sc-ui-icon.sc-ui-icon--pointer.sc-ui-chevron--down';
  const EXPAND_SELECTORS = [
    PROMOTION_TRIGGER_SELECTOR,
    CHEVRON_SELECTOR
  ];
  const EXPAND_SELECTOR = EXPAND_SELECTORS.join(',');
  const CARD_CLASS = 'meli-margin-card';

  // Configuração preservada do código fornecido.
  const SHEET_ID = '1LjN3kQiYtQYmUOX5RQKRqFj22eQ_L5zqY5KmzodhojU';
  const SHEET_NAME = 'Custos';
  const SHEET_CSV_URL =
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
    `?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}&range=A2:B3000`;
  const TAX_RATE = 0.13;
  const PACKAGING_COST = 0; // Custo fixo de embalagem por venda, descontado do lucro.

  const MAX_DETAIL_ROWS = 50;
  const MAX_BOXES_PER_FRAME = 50;
  const MAX_EXPANDERS_PER_FRAME = 50;
  const CALCULATION_ROOT_MARGIN_PX = 0;
  const EXPANSION_ROOT_MARGIN_PX = CALCULATION_ROOT_MARGIN_PX;
  const SCROLL_SETTLE_MS = 140;
  const INITIAL_DOM_SETTLE_MS = 600;
  const INITIAL_READY_TIMEOUT_MS = 15000;
  const money = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });

  let custoMap = Object.create(null);
  let custosCarregados = false;
  let workScheduled = false;
  let expansionScheduled = false;
  let userIsScrolling = false;
  let scrollSettleTimer = null;
  let appStarted = false;
  let autoReportTimer = null;

  const observedBoxes = new WeakSet();
  const observedExpanders = new WeakSet();
  const queuedExpanders = new WeakSet();
  const pendingBoxes = new Set();
  const pendingExpanders = [];

  const metrics = {
    version: VERSION,
    startedAt: new Date().toISOString(),
    startTime: performance.now(),
    sheet: {
      requests: 0,
      durationMs: 0,
      rowsLoaded: 0,
      errors: []
    },
    discovery: {
      scans: 0,
      scanDurationMs: 0,
      boxesObserved: 0
    },
    processing: {
      queued: 0,
      processed: 0,
      recalculated: 0,
      missingCost: 0,
      missingPrice: 0,
      missingReceivable: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      slowOperations: []
    },
    dom: {
      cardsCreated: 0,
      cardsReplaced: 0,
      mutationCallbacks: 0,
      mutationRecords: 0,
      pageNodesAdded: 0,
      ownNodesAdded: 0
    },
    expansion: {
      buttonsFound: 0,
      queued: 0,
      clicked: 0,
      skipped: 0,
      errors: [],
      totalDurationMs: 0,
      maxDurationMs: 0
    },
    browser: {
      longTasks: [],
      layoutShifts: [],
      errors: [],
      unhandledRejections: []
    }
  };

  function keepLast(list, value) {
    list.push(value);
    if (list.length > MAX_DETAIL_ROWS) list.shift();
  }

  function round(value, digits = 2) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function parseCSVLine(line) {
    const fields = [];
    let current = '';
    let quoted = false;

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') {
        if (quoted && line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (char === ',' && !quoted) {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    fields.push(current);
    return fields;
  }

  function parseCost(value) {
    if (value == null) return null;
    let normalized = String(value)
      .trim()
      .replace(/^"|"$/g, '')
      .replace(/R\$\s*/i, '');

    if (!normalized) return null;
    if (normalized.includes(',') && normalized.includes('.')) {
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else if (normalized.includes(',')) {
      normalized = normalized.replace(',', '.');
    }

    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeId(value) {
    const match = String(value || '').match(/(\d{7,})/);
    return match ? match[1] : '';
  }

  function parseCostsCSV(csvText) {
    const map = Object.create(null);
    let count = 0;

    for (const rawLine of csvText.split(/\r\n|\n|\r/)) {
      if (!rawLine.trim()) continue;
      const fields = parseCSVLine(rawLine);
      const id = normalizeId(fields[0]);
      const cost = parseCost(fields[1]);
      if (!id || cost === null) continue;
      map[id] = cost;
      count += 1;
    }

    return { map, count };
  }

  function loadCosts() {
    const started = performance.now();
    metrics.sheet.requests += 1;

    GM_xmlhttpRequest({
      method: 'GET',
      url: SHEET_CSV_URL,
      anonymous: true,
      timeout: 15000,
      onload(response) {
        metrics.sheet.durationMs = round(performance.now() - started);
        try {
          if (response.status !== 200) {
            throw new Error(`Google Sheets respondeu com HTTP ${response.status}`);
          }
          const parsed = parseCostsCSV(response.responseText || '');
          custoMap = parsed.map;
          metrics.sheet.rowsLoaded = parsed.count;
          custosCarregados = true;
          console.info(`${APP} ${parsed.count} custos carregados em ${metrics.sheet.durationMs} ms.`);
          queueVisibleObservedBoxes();
        } catch (error) {
          registerSheetError(error);
        }
      },
      onerror(error) {
        metrics.sheet.durationMs = round(performance.now() - started);
        registerSheetError(error);
      },
      ontimeout() {
        metrics.sheet.durationMs = round(performance.now() - started);
        registerSheetError(new Error('Tempo limite ao carregar a planilha de custos'));
      }
    });
  }

  function registerSheetError(error) {
    const message = error instanceof Error ? error.message : String(error);
    keepLast(metrics.sheet.errors, {
      at: new Date().toISOString(),
      message
    });
    custosCarregados = true;
    console.error(`${APP} Não foi possível carregar os custos:`, message);
    queueVisibleObservedBoxes();
  }

  function parseMoney(text) {
    if (!text) return 0;
    const match = String(text).match(/R\$\s*(-?[\d.]+(?:,[\d]{1,2})?|-?[\d,]+)/i);
    if (!match) return 0;
    const value = Number.parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(value) ? value : 0;
  }

  function queryFirst(root, selectors) {
    if (!root) return null;
    for (const selector of selectors) {
      try {
        const element = root.querySelector(selector);
        if (element) return element;
      } catch (_) {
        // Um seletor alternativo inválido não impede os demais.
      }
    }
    return null;
  }

  function findRow(box) {
    return box.closest('.sc-list-row') ||
      box.closest('[class*="sc-list-row"]') ||
      box.closest('article') ||
      box.parentElement;
  }

  function extractFullPrice(row) {
    const element = queryFirst(row, [
      'span.sc-list-description__price-text',
      '[class*="price-text"]'
    ]);
    return parseMoney(element ? element.textContent : '');
  }

  function extractTotalDiscount(row, box) {
    for (const root of [box, row]) {
      if (!root) continue;
      const text = (root.innerText || root.textContent || '').replace(/\s+/g, ' ');
      const match = text.match(/R\$\s*([\d.,]+)\s*\(\s*[\d.,]+%\s*\)/i);
      if (match) {
        const value = parseMoney(`R$ ${match[1]}`);
        if (value > 0.0001) return value;
      }
    }

    const element = queryFirst(box, [
      '.sc-list-collapsible-row__promotion-box__column__3 ' +
        '.sc-list-collapsible-row__promotion-box__column__line__text-black'
    ]);
    return parseMoney(element ? element.textContent : '');
  }

  function extractReceivable(box) {
    const column = queryFirst(box, [
      '.sc-list-collapsible-row__promotion-box__column__5',
      '[class*="promotion-box__column__5"]'
    ]);
    return parseMoney(column ? (column.innerText || column.textContent) : '');
  }

  function extractIds(box, row) {
    const text = (row || box).innerText || (row || box).textContent || '';
    const ids = [];
    const regex = /#(\d{7,})/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
      if (!ids.includes(match[1])) ids.push(match[1]);
    }
    return ids;
  }

  function findCost(ids) {
    for (const id of ids) {
      if (Object.prototype.hasOwnProperty.call(custoMap, id)) {
        return { id, cost: custoMap[id] };
      }
    }
    return { id: ids[0] || '', cost: null };
  }

  function findOutputTarget(box) {
    return queryFirst(box, [
      '.sc-list-collapsible-row__promotion-box__column__3',
      '[class*="promotion-box__column__3"]'
    ]) || box;
  }

  function createMetric(label, value, modifier = '') {
    const cell = document.createElement('div');
    cell.className = `meli-margin-metric ${modifier}`.trim();

    const title = document.createElement('span');
    title.className = 'meli-margin-label';
    title.textContent = label;

    const number = document.createElement('strong');
    number.className = 'meli-margin-value';
    number.textContent = value;

    cell.append(title, number);
    return cell;
  }

  function renderResult(box, data) {
    const oldCard = box.querySelector(`.${CARD_CLASS}`);
    if (oldCard) {
      oldCard.remove();
      metrics.dom.cardsReplaced += 1;
    }

    const card = document.createElement('div');
    card.className = CARD_CLASS;
    card.dataset.meliMarginOwned = '1';

    if (data.status !== 'ok') {
      card.classList.add('meli-margin-unavailable');
      card.textContent = data.message;
    } else {
      const marginModifier = data.margin >= 15
        ? 'meli-margin-positive'
        : 'meli-margin-warning';
      card.append(
        createMetric('Custo', money.format(data.cost)),
        createMetric(`Imposto ${round(TAX_RATE * 100, 0)}%`, money.format(data.tax)),
        createMetric('Lucro', money.format(data.profit)),
        createMetric('Margem', `${data.margin.toFixed(1).replace('.', ',')}%`, marginModifier)
      );
      card.title =
        `Preço final: ${money.format(data.finalPrice)} | ` +
        `Você recebe: ${money.format(data.receivable)} | ` +
        `Embalagem: ${money.format(data.packagingCost)} | ` +
        `MLB: ${data.id || 'não identificado'}`;
    }

    findOutputTarget(box).appendChild(card);
    metrics.dom.cardsCreated += 1;
  }

  function processBox(box) {
    if (!box.isConnected || !custosCarregados) return;

    const started = performance.now();
    const wasProcessed = box.dataset.meliMarginProcessed === '1';
    const oldCard = box.querySelector(`.${CARD_CLASS}`);
    if (wasProcessed && oldCard) return;

    try {
      const row = findRow(box);
      const fullPrice = extractFullPrice(row);
      const totalDiscount = extractTotalDiscount(row, box);
      const receivable = extractReceivable(box);
      const ids = extractIds(box, row);
      const { id, cost } = findCost(ids);

      if (!fullPrice) {
        metrics.processing.missingPrice += 1;
        renderResult(box, {
          status: 'missing',
          message: 'Margem indisponível: preço não identificado'
        });
      } else if (cost === null) {
        metrics.processing.missingCost += 1;
        renderResult(box, {
          status: 'missing',
          message: `Margem indisponível: custo não encontrado${id ? ` para #${id}` : ''}`
        });
      } else if (!receivable) {
        metrics.processing.missingReceivable += 1;
        renderResult(box, {
          status: 'missing',
          message: 'Margem indisponível: “Você recebe” não identificado'
        });
      } else {
        const finalPrice = fullPrice - totalDiscount;
        const tax = finalPrice * TAX_RATE;
        const profit = receivable - cost - tax - PACKAGING_COST;
        const margin = finalPrice > 0 ? (profit / finalPrice) * 100 : 0;

        renderResult(box, {
          status: 'ok',
          id,
          cost,
          tax,
          profit,
          margin,
          finalPrice,
          receivable,
          packagingCost: PACKAGING_COST
        });
      }

      box.dataset.meliMarginProcessed = '1';
      metrics.processing.processed += 1;
      if (wasProcessed) metrics.processing.recalculated += 1;
    } catch (error) {
      keepLast(metrics.browser.errors, {
        at: new Date().toISOString(),
        source: 'userscript',
        message: error instanceof Error ? error.message : String(error)
      });
      console.error(`${APP} Falha ao calcular uma promoção:`, error);
    } finally {
      const duration = performance.now() - started;
      metrics.processing.totalDurationMs += duration;
      metrics.processing.maxDurationMs = Math.max(
        metrics.processing.maxDurationMs,
        duration
      );
      if (duration >= 16) {
        keepLast(metrics.processing.slowOperations, {
          at: new Date().toISOString(),
          durationMs: round(duration),
          item: normalizeId((findRow(box) || box).textContent)
        });
      }
    }
  }

  function scheduleWork() {
    if (
      workScheduled ||
      userIsScrolling ||
      !pendingBoxes.size ||
      !custosCarregados
    ) return;
    workScheduled = true;

    // Processa no próximo quadro após a rolagem manual estabilizar. Só mantém
    // itens que ainda estão dentro da área visível.
    window.requestAnimationFrame(() => {
      workScheduled = false;
      if (userIsScrolling) return;
      let processedInFrame = 0;

      while (pendingBoxes.size && processedInFrame < MAX_BOXES_PER_FRAME) {
        const box = pendingBoxes.values().next().value;
        pendingBoxes.delete(box);
        if (!isNearViewport(box, 0)) continue;
        processBox(box);
        processedInFrame += 1;
      }

      if (pendingBoxes.size) scheduleWork();
    });
  }

  function queueBox(box) {
    if (!box || !box.isConnected) return;
    if (!pendingBoxes.has(box)) {
      pendingBoxes.add(box);
      metrics.processing.queued += 1;
    }
    scheduleWork();
  }

  function isNearViewport(box, margin = CALCULATION_ROOT_MARGIN_PX) {
    const rect = box.getBoundingClientRect();
    return rect.bottom >= -margin && rect.top <= window.innerHeight + margin;
  }

  const intersectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) queueBox(entry.target);
    }
  }, {
    root: null,
    rootMargin: `${CALCULATION_ROOT_MARGIN_PX}px 0px`,
    threshold: 0
  });

  function observeBox(box) {
    if (observedBoxes.has(box)) return;
    observedBoxes.add(box);
    intersectionObserver.observe(box);
    metrics.discovery.boxesObserved += 1;
  }

  function discoverBoxes(root) {
    const started = performance.now();
    metrics.discovery.scans += 1;

    if (root instanceof Element && root.matches(BOX_SELECTOR)) {
      observeBox(root);
    }
    if (root && typeof root.querySelectorAll === 'function') {
      root.querySelectorAll(BOX_SELECTOR).forEach(observeBox);
    }

    metrics.discovery.scanDurationMs += performance.now() - started;
  }

  function queueExpander(button) {
    const target = button ? canonicalActivationTarget(button) : null;
    if (!target || queuedExpanders.has(target)) return;
    queuedExpanders.add(target);
    pendingExpanders.push(target);
    metrics.expansion.queued += 1;
    scheduleExpansion();
  }

  function canonicalActivationTarget(element) {
    // O chevron de 16 px é filho do botão "Conferir mais promoções". Nesse
    // caso, clicaríamos duas vezes no mesmo controle se ambos fossem enfileirados.
    return element.closest(PROMOTION_TRIGGER_SELECTOR) || element;
  }

  const expansionIntersectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      expansionIntersectionObserver.unobserve(entry.target);
      queueExpander(entry.target);
    }
  }, {
    root: null,
    rootMargin: `${EXPANSION_ROOT_MARGIN_PX}px 0px`,
    threshold: 0
  });

  function observeExpander(button) {
    const target = button ? canonicalActivationTarget(button) : null;
    if (!target || observedExpanders.has(target)) return;
    observedExpanders.add(target);
    expansionIntersectionObserver.observe(target);
    metrics.expansion.buttonsFound += 1;
  }

  function discoverExpanders(root) {
    if (root instanceof Element && root.matches(EXPAND_SELECTOR)) {
      observeExpander(root);
    }
    if (root && typeof root.querySelectorAll === 'function') {
      root.querySelectorAll(EXPAND_SELECTOR).forEach(observeExpander);
    }
  }

  function dispatchMouseStep(element, type, options = {}) {
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + Math.max(0, rect.width / 2);
    const clientY = rect.top + Math.max(0, rect.height / 2);
    const eventWindow = element.ownerDocument.defaultView;
    const common = {
      bubbles: options.bubbles !== false,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
      button: 0,
      buttons: options.buttons || 0
    };

    if (type.startsWith('pointer') && typeof eventWindow.PointerEvent === 'function') {
      return element.dispatchEvent(new eventWindow.PointerEvent(type, {
        ...common,
        pointerId: 1,
        width: 1,
        height: 1,
        pressure: options.buttons ? 0.5 : 0,
        pointerType: 'mouse',
        isPrimary: true
      }));
    }

    return element.dispatchEvent(new eventWindow.MouseEvent(type, common));
  }

  function activateLikeUser(element) {
    // Mantém uma única sequência de clique. O clique final usa o método nativo
    // do protótipo para não depender de uma possível sobrescrita em element.click.
    dispatchMouseStep(element, 'pointerover');
    dispatchMouseStep(element, 'mouseover');
    dispatchMouseStep(element, 'pointerenter', { bubbles: false });
    dispatchMouseStep(element, 'mouseenter', { bubbles: false });
    dispatchMouseStep(element, 'pointerdown', { buttons: 1 });
    dispatchMouseStep(element, 'mousedown', { buttons: 1 });
    dispatchMouseStep(element, 'pointerup');
    dispatchMouseStep(element, 'mouseup');
    element.ownerDocument.defaultView.HTMLElement.prototype.click.call(element);
  }

  function scheduleExpansion() {
    if (expansionScheduled || userIsScrolling || !pendingExpanders.length) return;
    expansionScheduled = true;

    // Clica em todos os controles já disponíveis em lotes grandes. O limite por
    // frame evita transformar centenas de cliques em uma única tarefa longa.
    window.requestAnimationFrame(() => {
      expansionScheduled = false;
      if (userIsScrolling) return;
      const batch = pendingExpanders.splice(0, MAX_EXPANDERS_PER_FRAME);

      for (const button of batch) {
        if (
          !button ||
          !button.isConnected ||
          !button.matches(EXPAND_SELECTOR) ||
          button.disabled
        ) {
          metrics.expansion.skipped += 1;
          continue;
        }

        if (!isNearViewport(button, 0)) {
          // O usuário passou pelo elemento antes da rolagem estabilizar. Libera
          // para que ele seja observado novamente quando voltar à tela.
          queuedExpanders.delete(button);
          expansionIntersectionObserver.observe(button);
          continue;
        }

        const started = performance.now();
        try {
          activateLikeUser(button);
          metrics.expansion.clicked += 1;
        } catch (error) {
          keepLast(metrics.expansion.errors, {
            at: new Date().toISOString(),
            message: error instanceof Error ? error.message : String(error)
          });
          console.error(`${APP} Falha ao expandir um grupo:`, error);
        } finally {
          const duration = performance.now() - started;
          metrics.expansion.totalDurationMs += duration;
          metrics.expansion.maxDurationMs = Math.max(
            metrics.expansion.maxDurationMs,
            duration
          );
        }
      }

      if (pendingExpanders.length) scheduleExpansion();
    });
  }

  function setupManualScrollGuard() {
    window.addEventListener('scroll', () => {
      userIsScrolling = true;
      if (scrollSettleTimer !== null) {
        window.clearTimeout(scrollSettleTimer);
      }

      scrollSettleTimer = window.setTimeout(() => {
        scrollSettleTimer = null;
        userIsScrolling = false;
        scheduleWork();
        scheduleExpansion();
      }, SCROLL_SETTLE_MS);
    }, { passive: true });
  }

  function queueVisibleObservedBoxes() {
    document.querySelectorAll(BOX_SELECTOR).forEach((box) => {
      if (isNearViewport(box)) queueBox(box);
    });
  }

  function isOwnNode(node) {
    if (!(node instanceof Element)) return false;
    return node.matches(`.${CARD_CLASS}`) ||
      Boolean(node.closest(`.${CARD_CLASS}`)) ||
      node.dataset.meliMarginOwned === '1';
  }

  const mutationObserver = new MutationObserver((records) => {
    metrics.dom.mutationCallbacks += 1;
    metrics.dom.mutationRecords += records.length;

    for (const record of records) {
      for (const node of record.addedNodes) {
        if (isOwnNode(node)) {
          metrics.dom.ownNodesAdded += 1;
          continue;
        }

        metrics.dom.pageNodesAdded += 1;
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        discoverBoxes(node);
        discoverExpanders(node);

        const changedBox = node.closest(BOX_SELECTOR);
        if (changedBox && changedBox.dataset.meliMarginProcessed === '1') {
          delete changedBox.dataset.meliMarginProcessed;
          const card = changedBox.querySelector(`.${CARD_CLASS}`);
          if (card) card.remove();
          if (isNearViewport(changedBox)) queueBox(changedBox);
        }
      }
    }
  });

  function setupPerformanceObservers() {
    if (!('PerformanceObserver' in window)) return;

    try {
      const longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          keepLast(metrics.browser.longTasks, {
            startMs: round(entry.startTime),
            durationMs: round(entry.duration),
            name: entry.name || 'longtask'
          });
        }
      });
      longTaskObserver.observe({ type: 'longtask', buffered: true });
    } catch (_) {
      // Nem todos os navegadores expõem Long Tasks.
    }

    try {
      const layoutShiftObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput) continue;
          keepLast(metrics.browser.layoutShifts, {
            startMs: round(entry.startTime),
            value: round(entry.value, 4)
          });
        }
      });
      layoutShiftObserver.observe({ type: 'layout-shift', buffered: true });
    } catch (_) {
      // Layout Instability API pode não estar disponível.
    }
  }

  function setupErrorCapture() {
    window.addEventListener('error', (event) => {
      keepLast(metrics.browser.errors, {
        at: new Date().toISOString(),
        source: event.filename && event.filename.includes('userscript')
          ? 'userscript'
          : 'page-or-extension',
        message: event.message || 'Erro sem mensagem',
        file: event.filename || '',
        line: event.lineno || 0
      });
    }, true);

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      keepLast(metrics.browser.unhandledRejections, {
        at: new Date().toISOString(),
        message: reason instanceof Error ? reason.message : String(reason)
      });
    });
  }

  function buildReport() {
    const elapsedMs = performance.now() - metrics.startTime;
    const processed = metrics.processing.processed;
    const average = processed
      ? metrics.processing.totalDurationMs / processed
      : 0;
    const layoutShiftTotal = metrics.browser.layoutShifts
      .reduce((sum, entry) => sum + entry.value, 0);
    const recommendations = [];

    if (metrics.processing.maxDurationMs >= 50) {
      recommendations.push('Há cálculo individual acima de 50 ms; revise os seletores desse item.');
    }
    if (metrics.browser.longTasks.length) {
      recommendations.push('Foram observadas tarefas longas na página; compare os horários com as operações do userscript.');
    }
    if (layoutShiftTotal > 0.1) {
      recommendations.push('O deslocamento visual acumulado passou de 0,1; reduza a altura do cartão de margem.');
    }
    if (metrics.processing.missingCost) {
      recommendations.push('Existem anúncios sem custo localizado; confira os IDs na aba Custos.');
    }
    if (metrics.expansion.maxDurationMs >= 16) {
      recommendations.push('Um clique de expansão ocupou mais de 16 ms; compare com as tarefas longas registradas.');
    }
    if (metrics.expansion.errors.length) {
      recommendations.push('Ocorreram erros ao expandir grupos; confira os detalhes de expansão no JSON.');
    }
    if (!recommendations.length) {
      recommendations.push('Nenhum sinal relevante de lentidão causado pelo userscript foi detectado nesta sessão.');
    }

    return {
      generatedAt: new Date().toISOString(),
      page: location.href,
      version: VERSION,
      summary: {
        elapsedSeconds: round(elapsedMs / 1000),
        sheetRowsLoaded: metrics.sheet.rowsLoaded,
        boxesObserved: metrics.discovery.boxesObserved,
        boxesProcessed: processed,
        averageCalculationMs: round(average),
        slowestCalculationMs: round(metrics.processing.maxDurationMs),
        cardsInDOM: document.querySelectorAll(`.${CARD_CLASS}`).length,
        expansionButtonsFound: metrics.expansion.buttonsFound,
        expansionClicks: metrics.expansion.clicked,
        expansionSkipped: metrics.expansion.skipped,
        longTasksObserved: metrics.browser.longTasks.length,
        layoutShiftTotal: round(layoutShiftTotal, 4),
        capturedErrors: metrics.browser.errors.length,
        capturedUnhandledRejections: metrics.browser.unhandledRejections.length
      },
      metrics: {
        ...metrics,
        discovery: {
          ...metrics.discovery,
          scanDurationMs: round(metrics.discovery.scanDurationMs)
        },
        processing: {
          ...metrics.processing,
          totalDurationMs: round(metrics.processing.totalDurationMs),
          maxDurationMs: round(metrics.processing.maxDurationMs)
        },
        expansion: {
          ...metrics.expansion,
          totalDurationMs: round(metrics.expansion.totalDurationMs),
          maxDurationMs: round(metrics.expansion.maxDurationMs)
        }
      },
      recommendations
    };
  }

  function printReport(options = {}) {
    const report = buildReport();
    const label = options.automatic ? 'relatório automático' : 'relatório solicitado';

    console.group(`${APP} ${label}`);
    console.table(report.summary);
    console.table(report.recommendations.map((recommendation, index) => ({
      prioridade: index + 1,
      recomendação: recommendation
    })));

    if (report.metrics.processing.slowOperations.length) {
      console.groupCollapsed('Cálculos acima de 16 ms');
      console.table(report.metrics.processing.slowOperations);
      console.groupEnd();
    }
    if (report.metrics.browser.longTasks.length) {
      console.groupCollapsed('Tarefas longas observadas na página');
      console.table(report.metrics.browser.longTasks);
      console.groupEnd();
    }
    if (report.metrics.browser.errors.length) {
      console.groupCollapsed('Erros capturados (podem ser da página ou de extensões)');
      console.table(report.metrics.browser.errors);
      console.groupEnd();
    }
    console.info('JSON completo:', report);
    console.groupEnd();
    return report;
  }

  function reprocessVisible() {
    document.querySelectorAll(BOX_SELECTOR).forEach((box) => {
      if (!isNearViewport(box, 0)) return;
      delete box.dataset.meliMarginProcessed;
      const card = box.querySelector(`.${CARD_CLASS}`);
      if (card) card.remove();
      queueBox(box);
    });
  }

  function exposeDiagnostics() {
    const api = Object.freeze({
      version: VERSION,
      relatorio: () => printReport(),
      json: () => JSON.stringify(buildReport(), null, 2),
      reprocessarVisiveis: reprocessVisible,
      expandirVisiveis: () => {
        let queued = 0;
        document.querySelectorAll(EXPAND_SELECTOR).forEach((button) => {
          if (!isNearViewport(button, EXPANSION_ROOT_MARGIN_PX)) return;
          const wasQueued = queuedExpanders.has(button);
          queueExpander(button);
          if (!wasQueued) queued += 1;
        });
        return queued;
      }
    });

    try {
      unsafeWindow.MELIMargem = api;
    } catch (_) {
      window.MELIMargem = api;
    }

    console.info(
      `${APP} ativo. No F12, use MELIMargem.relatorio() para ver o relatório ` +
      'ou MELIMargem.json() para obter o JSON.'
    );
  }

  function addStyles() {
    if (document.querySelector('#meli-margin-lite-style')) return;
    const style = document.createElement('style');
    style.id = 'meli-margin-lite-style';
    style.dataset.meliMarginOwned = '1';
    style.textContent = `
      .${CARD_CLASS} {
        display: grid;
        grid-template-columns: repeat(2, minmax(72px, 1fr));
        gap: 3px;
        margin-top: 4px;
        padding: 4px;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        background: #fff;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .${CARD_CLASS} .meli-margin-metric {
        min-width: 0;
        padding: 3px 5px;
        border-radius: 4px;
        background: #f3f4f6;
        text-align: center;
      }
      .${CARD_CLASS} .meli-margin-label,
      .${CARD_CLASS} .meli-margin-value {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .${CARD_CLASS} .meli-margin-label {
        color: #6b7280;
        font-size: 9px;
        line-height: 1.2;
      }
      .${CARD_CLASS} .meli-margin-value {
        margin-top: 2px;
        color: #1f2937;
        font-size: 11px;
        line-height: 1.2;
      }
      .${CARD_CLASS} .meli-margin-positive {
        background: #dcfce7;
      }
      .${CARD_CLASS} .meli-margin-positive .meli-margin-value {
        color: #166534;
      }
      .${CARD_CLASS} .meli-margin-warning {
        background: #fee2e2;
      }
      .${CARD_CLASS} .meli-margin-warning .meli-margin-value {
        color: #991b1b;
      }
      .${CARD_CLASS}.meli-margin-unavailable {
        display: block;
        padding: 5px 7px;
        color: #92400e;
        background: #fffbeb;
        border-color: #fcd34d;
        font-size: 10px;
        line-height: 1.3;
      }
    `;
    document.head.appendChild(style);
  }

  function start() {
    if (appStarted) return;
    appStarted = true;
    addStyles();
    setupPerformanceObservers();
    setupErrorCapture();
    setupManualScrollGuard();
    exposeDiagnostics();
    discoverBoxes(document);
    discoverExpanders(document);

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    loadCosts();

    // Um único relatório automático, sem polling periódico.
    autoReportTimer = window.setTimeout(() => {
      autoReportTimer = null;
      printReport({ automatic: true });
    }, 30000);
  }

  function startAfterPageIsReady() {
    const waitForStableDOM = () => {
      if (!document.body) {
        window.requestAnimationFrame(waitForStableDOM);
        return;
      }

      let settleTimer = null;
      let maxTimer = null;
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        initialObserver.disconnect();
        if (settleTimer !== null) window.clearTimeout(settleTimer);
        if (maxTimer !== null) window.clearTimeout(maxTimer);
        start();
      };

      const scheduleAfterQuietPeriod = () => {
        if (settleTimer !== null) window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(finish, INITIAL_DOM_SETTLE_MS);
      };

      const initialObserver = new MutationObserver(scheduleAfterQuietPeriod);
      initialObserver.observe(document.body, {
        childList: true,
        subtree: true
      });

      scheduleAfterQuietPeriod();
      maxTimer = window.setTimeout(finish, INITIAL_READY_TIMEOUT_MS);
    };

    if (document.readyState === 'complete') {
      waitForStableDOM();
    } else {
      window.addEventListener('load', waitForStableDOM, { once: true });
    }
  }

  startAfterPageIsReady();
})();
