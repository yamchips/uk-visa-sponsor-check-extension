(function runContentScript() {
  const BADGE_ROOT_CLASS = "uvsc-badge";
  const CARD_LAYER_CLASS = "uvsc-card-layer";
  const CARD_HOST_CLASS = "uvsc-card-badge-host";
  const DETAIL_HOST_CLASS = "uvsc-detail-badge-host";
  const STATUS_ROOT_CLASS = "uvsc-status";
  const DISMISS_BUTTON_SELECTOR = 'button[aria-label*="Dismiss"][aria-label*="job"]';
  const EXTENSION_VERSION = chrome.runtime?.getManifest?.().version || "dev";

  const state = {
    sponsorIndex: null,
    scanQueued: false,
    scanTimerId: null,
    cardSnapshotByJobKey: new Map(),
    cardResultByJobKey: new Map(),
    selectedJobKey: "",
    detailNameByJobKey: new Map(),
    matchResultByKey: new Map(),
    observer: null,
    eventTeardown: [],
    status: {
      mode: "booting",
      message: "Starting"
    }
  };

  function logError(message, error) {
    console.error(`[VisaSponsorChecker] ${message}`, error);
  }

  async function loadSponsorIndex() {
    const url = `${chrome.runtime.getURL("data/sponsor-index.json")}?v=${encodeURIComponent(EXTENSION_VERSION)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load sponsor-index.json (${response.status}) from ${url}`);
    }

    const payload = await response.json();
    return {
      exactAliases: new Set(payload.exactAliases || []),
      brandAliases: new Set(payload.brandAliases || []),
      stats: payload.stats || {}
    };
  }

  function upsertStatus(mode, message) {
    state.status = { mode, message };

    let chip = document.querySelector(`.${STATUS_ROOT_CLASS}`);
    if (!chip) {
      chip = document.createElement("div");
      chip.className = STATUS_ROOT_CLASS;
      document.documentElement.appendChild(chip);
    }

    chip.className = `${STATUS_ROOT_CLASS} is-${mode}`;
    chip.textContent = `Visa checker: ${message}`;
  }

  function scheduleScan() {
    if (state.scanQueued || !state.sponsorIndex) {
      return;
    }

    state.scanQueued = true;
    if (state.scanTimerId) {
      window.clearTimeout(state.scanTimerId);
    }

    state.scanTimerId = window.setTimeout(() => {
      state.scanQueued = false;
      state.scanTimerId = null;
      scanLinkedInJobsPage();
    }, 120);
  }

  function collectUniqueElements(selectors) {
    const seen = new Set();
    const items = [];

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!seen.has(element)) {
          seen.add(element);
          items.push(element);
        }
      }
    }

    return items;
  }

  function isJobLinkElement(element) {
    return element instanceof HTMLElement && element.matches('a[href*="/jobs/view/"], a[href*="currentJobId="]');
  }

  function countJobLinks(root) {
    if (!(root instanceof HTMLElement)) {
      return 0;
    }

    return (isJobLinkElement(root) ? 1 : 0) + root.querySelectorAll('a[href*="/jobs/view/"], a[href*="currentJobId="]').length;
  }

  function countDismissButtons(root) {
    if (!(root instanceof HTMLElement)) {
      return 0;
    }

    return root.querySelectorAll(DISMISS_BUTTON_SELECTOR).length;
  }

  function isInsideDetailPanel(element) {
    return Boolean(
      element instanceof HTMLElement &&
        element.closest(
          '.jobs-search__right-rail, .job-details-jobs-unified-top-card, .jobs-unified-top-card'
        )
    );
  }

  function looksLikeJobCard(element) {
    if (!element || !(element instanceof HTMLElement)) {
      return false;
    }

    if (isInsideDetailPanel(element)) {
      return false;
    }

    if (isJobLinkElement(element) || element.querySelector('a[href*="/jobs/view/"], a[href*="currentJobId="]')) {
      return true;
    }

    if (element.hasAttribute("data-job-id")) {
      return true;
    }

    if (element.hasAttribute("data-occludable-job-id")) {
      return true;
    }

    const title = extractCardTitle(element);
    const company = extractCardCompanyName(element);

    return Boolean(title && company);
  }

  function findCardFromDismissButton(button) {
    let current = button?.parentElement || null;
    let depth = 0;

    while (current instanceof HTMLElement && depth < 14) {
      if (isInsideDetailPanel(current)) {
        return null;
      }

      const title = extractCardTitle(current);
      const company = extractCardCompanyName(current);

      if (title && company) {
        return current;
      }

      current = current.parentElement;
      depth += 1;
    }

    return null;
  }

  function normalizeCardElement(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    return (
      element.closest(".jobs-search-results__list-item") ||
      element.closest(".job-card-container") ||
      element.closest("[data-job-id]") ||
      element.closest("[data-occludable-job-id]") ||
      element.closest('[role="listitem"]') ||
      element.closest("li") ||
      element.closest("article") ||
      element
    );
  }

  function createCardEntry(matchRoot, anchor) {
    if (!(matchRoot instanceof HTMLElement)) {
      return null;
    }

    const visualRoot = normalizeCardElement(matchRoot) || matchRoot;
    const normalizedAnchor =
      (anchor instanceof HTMLElement && anchor) || visualRoot.querySelector(DISMISS_BUTTON_SELECTOR) || visualRoot;

    return {
      root: visualRoot,
      matchRoot,
      anchor: normalizedAnchor
    };
  }

  function findCardEntryFromDismissButton(button) {
    let current = button?.parentElement || null;
    let bestSingleDismissRoot = null;
    let fallbackRoot = null;
    let depth = 0;

    while (current instanceof HTMLElement && depth < 14) {
      if (isInsideDetailPanel(current)) {
        return null;
      }

      const title = extractCardTitle(current);
      const company = extractCardCompanyName(current);

      if (title && company) {
        fallbackRoot = current;
        if (countDismissButtons(current) === 1) {
          bestSingleDismissRoot = current;
        }
      }

      current = current.parentElement;
      depth += 1;
    }

    return createCardEntry(bestSingleDismissRoot || fallbackRoot, button);
  }

  function findJobCards() {
    const entries = [];

    for (const dismissButton of document.querySelectorAll(DISMISS_BUTTON_SELECTOR)) {
      const entry = findCardEntryFromDismissButton(dismissButton);
      if (!entry) {
        continue;
      }

      entries.push(entry);
    }

    if (entries.length) {
      return entries;
    }

    const fallbackCandidates = collectUniqueElements([
      ".jobs-search-results__list-item",
      ".job-card-container",
      "[data-job-id]",
      "[data-occludable-job-id]",
      '[data-entity-urn*="jobPosting"]',
      ".jobs-search-results-list li",
      ".scaffold-layout__list-container li",
      ".scaffold-layout__list > li"
    ]);

    const seen = new Set();
    const fallbackEntries = [];

    for (const candidate of fallbackCandidates) {
      if (isInsideDetailPanel(candidate) || !looksLikeJobCard(candidate)) {
        continue;
      }

      const entry = createCardEntry(candidate, candidate.querySelector(DISMISS_BUTTON_SELECTOR));
      if (!entry || seen.has(entry.matchRoot)) {
        continue;
      }

      seen.add(entry.matchRoot);
      fallbackEntries.push(entry);
    }

    return fallbackEntries;
  }

  function getCardDebugSnapshot() {
    const jobViewLinks = document.querySelectorAll('a[href*="/jobs/view/"]').length;
    const currentJobLinks = document.querySelectorAll('a[href*="currentJobId="]').length;
    const dismissButtons = document.querySelectorAll(DISMISS_BUTTON_SELECTOR).length;
    const listCandidates = document.querySelectorAll(".jobs-search-results-list li, .scaffold-layout__list-container li").length;
    const jobIdCandidates = document.querySelectorAll("[data-job-id], [data-occludable-job-id]").length;

    return {
      jobViewLinks,
      currentJobLinks,
      dismissButtons,
      listCandidates,
      jobIdCandidates
    };
  }

  function extractText(element) {
    if (!element) {
      return;
    }

    return (element.textContent || "").replace(/\s+/g, " ").trim();
  }

  function extractVisibleTextLines(element) {
    if (!(element instanceof HTMLElement)) {
      return [];
    }

    const rawText = typeof element.innerText === "string" && element.innerText.trim() ? element.innerText : element.textContent || "";
    const seen = new Set();
    const lines = [];

    for (const rawLine of rawText.split(/\r?\n+/)) {
      const text = normalizeComparableText(rawLine);
      if (!text || seen.has(text)) {
        continue;
      }

      seen.add(text);
      lines.push(text);
    }

    return lines;
  }

  function readTextFromSelectors(root, selectors) {
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const text = extractText(element);
      if (text) {
        return text;
      }
    }

    return "";
  }

  function normalizeComparableText(text) {
    return (text || "")
      .replace(/\bverified job\b/gi, "")
      .replace(/[()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function looksLikeCompensation(text) {
    return /(?:£|\$|€|usd|gbp|eur|salary|\b\d+(?:\.\d+)?\s*K\b|\/(?:yr|year|hr|hour|day|month))/i.test(text);
  }

  function isLikelyMetaText(text) {
    return (
      !text ||
      looksLikeCompensation(text) ||
      /\b(viewed|posted|posted on|be an early applicant|applicants?|responses managed|promoted by|school alumni|connections work here|clicked apply|show all|show more|save|dismiss|apply|follow|helpful|learn more|premium|beta|people you can reach out to|match details|unable to load|reactivate premium|i['’]m interested|more options)\b/i.test(
        text
      )
    );
  }

  function isLikelyStandaloneTitle(text) {
    if (!text || text.length < 4 || text.length > 140) {
      return false;
    }

    if (looksLikeLocation(text) || isLikelyMetaText(text)) {
      return false;
    }

    return (
      /\b(engineer|developer|scientist|analyst|manager|consultant|designer|architect|specialist|lead|intern|assistant|officer|technician|researcher|administrator|coordinator|director|associate|principal|head|graduate|product|data|software|web|backend|front[- ]end|full[- ]stack|devops|qa|security)\b/i.test(
        text
      ) || text.split(" ").length >= 2
    );
  }

  function hasNestedMeaningfulTextElements(element) {
    return Array.from(element.children).some((child) => extractText(child));
  }

  function collectOrderedTextCandidates(root, selector = "p, a, span, strong, div") {
    const items = [];
    const seen = new Set();

    for (const element of root.querySelectorAll(selector)) {
      if (
        element.closest(`.${CARD_HOST_CLASS}`) ||
        element.closest(`.${DETAIL_HOST_CLASS}`) ||
        element.closest(`.${STATUS_ROOT_CLASS}`)
      ) {
        continue;
      }

      if (element.tagName === "A" && hasNestedMeaningfulTextElements(element)) {
        continue;
      }

      if (element.tagName === "DIV" && hasNestedMeaningfulTextElements(element)) {
        continue;
      }

      const text = normalizeComparableText(extractText(element));
      if (!text || seen.has(text)) {
        continue;
      }

      seen.add(text);
      items.push({ element, text });
    }

    return items;
  }

  function findBestTextAnchor(element, expectedText) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    const normalizedExpected = normalizeComparableText(expectedText);
    if (!normalizedExpected) {
      return null;
    }

    const candidates = [];

    if (element.matches("a, p, span, strong, h1, h2, h3, h4")) {
      candidates.push(element);
    }

    candidates.push(...element.querySelectorAll("a, p, span, strong, h1, h2, h3, h4"));

    let bestCandidate = null;
    let bestScore = -Infinity;

    for (const candidate of candidates) {
      const text = normalizeComparableText(extractText(candidate));
      if (!text) {
        continue;
      }

      let score = 0;
      if (text === normalizedExpected) {
        score += 100;
      } else if (text.includes(normalizedExpected)) {
        score += 50;
      } else if (normalizedExpected.includes(text)) {
        score += 20;
      } else {
        continue;
      }

      score -= text.length;

      if (score > bestScore) {
        bestCandidate = candidate;
        bestScore = score;
      }
    }

    return bestCandidate;
  }

  function extractCardTitle(card) {
    for (const selector of [
      ".job-card-list__title",
      ".job-card-list__title--link",
      ".job-card-container__link",
      '[class*="job-card-list__title"]',
      '[class*="job-card-container__link"]',
      '[class*="job-card"][class*="title"]',
      'a[class*="title"]',
      'p[class*="title"]',
      'h1, h2, h3, h4'
    ]) {
      for (const element of card.querySelectorAll(selector)) {
        const text = normalizeComparableText(extractText(element));
        if (isLikelyStandaloneTitle(text)) {
          return text;
        }
      }
    }

    const jobLink = isJobLinkElement(card) ? card : card.querySelector('a[href*="/jobs/view/"], a[href*="currentJobId="]');
    if (jobLink) {
      const jobLinkCandidates = collectOrderedTextCandidates(jobLink, "h1, h2, h3, h4, p, span, strong, a");
      if (!jobLinkCandidates.length) {
        const directText = normalizeComparableText(extractText(jobLink));
        if (isLikelyStandaloneTitle(directText)) {
          return directText;
        }
      }

      for (const { text } of jobLinkCandidates) {
        if (isLikelyStandaloneTitle(text)) {
          return text;
        }
      }
    }

    for (const { text } of collectOrderedTextCandidates(card, "h1, h2, h3, h4, p, span, strong, a")) {
      if (isLikelyStandaloneTitle(text)) {
        return text;
      }
    }

    for (const text of extractVisibleTextLines(card)) {
      if (isLikelyStandaloneTitle(text)) {
        return text;
      }
    }

    return "";
  }

  function extractCardCompanyInfo(card) {
    const title = normalizeComparableText(extractCardTitle(card));

    for (const selector of [
      'a[href*="/company/"]',
      ".job-card-container__company-name",
      ".job-card-container__primary-description",
      ".job-card-list__subtitle",
      ".artdeco-entity-lockup__subtitle",
      ".artdeco-entity-lockup__caption",
      '[class*="company-name"]',
      '[class*="primary-description"]',
      '[class*="subtitle"]'
    ]) {
      for (const element of card.querySelectorAll(selector)) {
        const text = normalizeComparableText(extractText(element));
        if (text && text !== title && isLikelyCompanyName(text) && !looksLikeLocation(text)) {
          return {
            name: text,
            element: findBestTextAnchor(element, text) || element
          };
        }
      }
    }

    const orderedCandidates = collectOrderedTextCandidates(card);
    let startIndex = 0;

    if (title) {
      const titleIndex = orderedCandidates.findIndex(({ text }) => text === title);
      if (titleIndex >= 0) {
        startIndex = titleIndex + 1;
      }
    }

    for (const { text, element } of orderedCandidates.slice(startIndex)) {
      if (!text || text === title || (title && text.includes(title))) {
        continue;
      }

      if (!isLikelyCompanyName(text) || looksLikeLocation(text)) {
        continue;
      }

      return {
        name: text,
        element
      };
    }

    for (const { text, element } of orderedCandidates) {
      if (!text || text === title || (title && text.includes(title))) {
        continue;
      }

      if (!isLikelyCompanyName(text) || looksLikeLocation(text)) {
        continue;
      }

      return {
        name: text,
        element
      };
    }

    const visibleLines = extractVisibleTextLines(card);
    let lineStartIndex = 0;

    if (title) {
      const titleIndex = visibleLines.findIndex((text) => text === title);
      if (titleIndex >= 0) {
        lineStartIndex = titleIndex + 1;
      }
    }

    for (const text of visibleLines.slice(lineStartIndex)) {
      if (!text || text === title || (title && text.includes(title))) {
        continue;
      }

      if (!isLikelyCompanyName(text) || looksLikeLocation(text)) {
        continue;
      }

      return {
        name: text,
        element: findBestTextAnchor(card, text) || card
      };
    }

    return {
      name: "",
      element: null
    };
  }

  function extractCardCompanyName(card) {
    return extractCardCompanyInfo(card).name;
  }

  function looksLikeLocation(text) {
    return /\b(united kingdom|england|scotland|wales|northern ireland|hybrid|remote|on-site|onsite)\b/i.test(text) || /,/.test(text);
  }

  function detailRootHasApplyOrSave(root) {
    for (const element of root.querySelectorAll("button, a")) {
      const text = normalizeComparableText(extractText(element));
      const ariaLabel = normalizeComparableText(element.getAttribute("aria-label") || "");
      if (/\b(apply|save)\b/i.test(text) || /\b(apply|save)\b/i.test(ariaLabel)) {
        return true;
      }
    }

    return false;
  }

  function scoreDetailRoot(root) {
    if (!(root instanceof HTMLElement)) {
      return -Infinity;
    }

    let score = 0;
    const dismissButtons = countDismissButtons(root);
    const title = extractDetailTitle(root);

    if (title) {
      score += 6;
    }

    if (detailRootHasApplyOrSave(root)) {
      score += 6;
    }

    if (root.querySelector('[aria-label^="Company,"], [aria-label*="Company,"], a[href*="/company/"], [class*="company-name"]')) {
      score += 4;
    }

    if (root.querySelector("h1, h2, h3, h4")) {
      score += 2;
    }

    if (dismissButtons > 0) {
      score -= dismissButtons * 5;
    }

    return score;
  }

  function findDetailTopCard() {
    const candidates = collectUniqueElements([
      '[data-testid="lazy-column"][data-component-type="LazyColumn"]',
      '[data-component-type="LazyColumn"]',
      ".job-details-jobs-unified-top-card",
      ".job-details-jobs-unified-top-card__container--two-pane",
      ".jobs-unified-top-card",
      ".job-view-layout",
      ".jobs-search__right-rail .job-view-layout",
      ".jobs-search__right-rail"
    ]);

    let bestCandidate = null;
    let bestScore = -Infinity;

    for (const candidate of candidates) {
      const score = scoreDetailRoot(candidate);
      if (score > bestScore) {
        bestCandidate = candidate;
        bestScore = score;
      }
    }

    return bestScore > 0 ? bestCandidate : null;
  }

  function extractDetailTitle(detailRoot) {
    if (!detailRoot) {
      return "";
    }

    for (const selector of ["h1", "h2", "h3", "h4", '[class*="title"]']) {
      for (const element of detailRoot.querySelectorAll(selector)) {
        const text = normalizeComparableText(extractText(element));
        if (isLikelyStandaloneTitle(text)) {
          return text;
        }
      }
    }

    for (const { text } of collectOrderedTextCandidates(detailRoot, "h1, h2, h3, h4, p, a, span, strong")) {
      if (isLikelyStandaloneTitle(text)) {
        return text;
      }
    }

    return "";
  }

  function findDetailTitleElement(detailRoot) {
    if (!detailRoot) {
      return null;
    }

    for (const selector of ["h1", "h2", "h3", "h4", '[class*="title"]']) {
      for (const element of detailRoot.querySelectorAll(selector)) {
        const text = normalizeComparableText(extractText(element));
        if (isLikelyStandaloneTitle(text)) {
          return findBestTextAnchor(element, text) || element;
        }
      }
    }

    return detailRoot.querySelector("h1, h2, h3, h4");
  }

  function extractDetailCompanyInfo(activeCard) {
    const detailRoot = findDetailTopCard();
    if (!detailRoot) {
      return {
        name: activeCard ? extractCardCompanyName(activeCard) : "",
        element: null,
        root: null
      };
    }

    const detailTitle = normalizeComparableText(extractDetailTitle(detailRoot));

    for (const selector of [
      '[aria-label^="Company,"]',
      '[aria-label*="Company,"]',
      '.job-details-jobs-unified-top-card__company-name a[href*="/company/"]',
      ".job-details-jobs-unified-top-card__company-name",
      '.jobs-unified-top-card__company-name a[href*="/company/"]',
      ".jobs-unified-top-card__company-name",
      '[class*="company-name"] a[href*="/company/"]',
      '[class*="company-name"]',
      'a[href*="/company/"]'
    ]) {
      for (const element of detailRoot.querySelectorAll(selector)) {
        const text = normalizeComparableText(extractText(element));
        if (text && text !== detailTitle && isLikelyCompanyName(text) && !looksLikeLocation(text)) {
          return {
            name: text,
            element: findBestTextAnchor(element, text) || element,
            root: detailRoot
          };
        }
      }
    }

    const orderedCandidates = collectOrderedTextCandidates(detailRoot, "p, a, span, strong, h1, h2, h3, h4, div").slice(0, 40);

    for (const { text, element } of orderedCandidates) {
      if (!text || text === detailTitle || (detailTitle && text.includes(detailTitle))) {
        continue;
      }

      if (!isLikelyCompanyName(text) || looksLikeLocation(text)) {
        continue;
      }

      return {
        name: text,
        element,
        root: detailRoot
      };
    }

    const fallbackName = activeCard ? extractCardCompanyName(activeCard) : "";
    return {
      name: fallbackName,
      element: detailRoot.querySelector("h1, h2, h3, h4") || null,
      root: detailRoot
    };
  }

  function isLikelyCompanyName(text) {
    if (!text || text.length < 2 || text.length > 120) {
      return false;
    }

    if (!/[a-z]/i.test(text)) {
      return false;
    }

    return !isLikelyMetaText(text) && !/\b(hours? ago|minutes? ago|days? ago|weeks? ago|months? ago|reposted|easy apply|visa sponsor)\b/i.test(text);
  }

  function isActiveCard(card) {
    if (!card) {
      return false;
    }

    if (card.matches(".jobs-search-results__list-item--active, [aria-current='true']")) {
      return true;
    }

    if (card.closest(".jobs-search-results__list-item--active")) {
      return true;
    }

    const className = card.className || "";
    return typeof className === "string" && className.includes("active");
  }

  function findActiveCard(cards) {
    return cards.find((entry) => isActiveCard(entry.root)) || null;
  }

  function extractJobKey(card) {
    if (!card) {
      return "";
    }

    const directJobId = card.getAttribute("data-job-id");
    if (directJobId) {
      return directJobId;
    }

    const nestedJobIdElement = card.querySelector("[data-job-id]");
    if (nestedJobIdElement) {
      const nestedJobId = nestedJobIdElement.getAttribute("data-job-id");
      if (nestedJobId) {
        return nestedJobId;
      }
    }

    if (isJobLinkElement(card)) {
      return extractJobKeyFromHref(card.getAttribute("href") || "");
    }

    const jobLink = card.querySelector('a[href*="/jobs/view/"], a[href*="currentJobId="]');
    if (jobLink) {
      return extractJobKeyFromHref(jobLink.getAttribute("href") || "");
    }

    return "";
  }

  function extractJobKeyFromHref(href) {
    const text = href || "";
    const currentJobMatch = text.match(/[?&]currentJobId=(\d+)/);
    if (currentJobMatch) {
      return currentJobMatch[1];
    }

    const viewMatch = text.match(/\/jobs\/view\/(\d+)/);
    if (viewMatch) {
      return viewMatch[1];
    }

    return text;
  }

  function extractJobKeyFromLocation() {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get("currentJobId") || extractJobKeyFromHref(url.href);
    } catch (_error) {
      return "";
    }
  }

  function findCardElementFromTarget(target) {
    if (!(target instanceof HTMLElement)) {
      return null;
    }

    const candidate = normalizeCardElement(
      target.closest(".jobs-search-results__list-item, .job-card-container, [data-job-id], [data-occludable-job-id], [role='listitem'], li, article, a[href*='/jobs/view/'], a[href*='currentJobId=']")
    );

    if (!candidate || isInsideDetailPanel(candidate) || !looksLikeJobCard(candidate)) {
      return null;
    }

    return candidate;
  }

  function getBadgeState(result) {
    if (result.matched) {
      return {
        className: "is-sponsored",
        label: "UK Visa Sponsor",
        title: `Matched official sponsor list using "${result.sourceName}" (${result.matchType} match).`
      };
    }

    return {
      className: "is-not-sponsored",
      label: "Not a UK Visa Sponsor",
      title: `No sponsor match found for: ${result.checkedNames.join(" / ") || "unknown company"}.`
    };
  }

  function ensureCardBadgeLayer() {
    let layer = document.documentElement.querySelector(`:scope > .${CARD_LAYER_CLASS}`);
    if (!layer) {
      layer = document.createElement("div");
      layer.className = CARD_LAYER_CLASS;
      document.documentElement.appendChild(layer);
    }

    return layer;
  }

  function resetCardBadgeLayer() {
    for (const host of document.querySelectorAll(`.${CARD_HOST_CLASS}`)) {
      host.remove();
    }

    const layer = ensureCardBadgeLayer();
    layer.replaceChildren();
    return layer;
  }

  function ensureCardBadgeHost(card, layer, anchorButton = null) {
    const dismissButton =
      (anchorButton instanceof HTMLElement && anchorButton) || card.querySelector(DISMISS_BUTTON_SELECTOR);
    if (dismissButton instanceof HTMLElement && dismissButton.parentElement instanceof HTMLElement) {
      const existingSiblingHost = dismissButton.parentElement.querySelector(`:scope > .${CARD_HOST_CLASS}.is-inline-anchor`);
      if (existingSiblingHost instanceof HTMLElement) {
        return existingSiblingHost;
      }

      const host = document.createElement("div");
      host.className = `${CARD_HOST_CLASS} is-inline-anchor`;
      dismissButton.parentElement.insertBefore(host, dismissButton);
      return host;
    }

    const host = document.createElement("div");
    host.className = CARD_HOST_CLASS;
    const anchor = dismissButton instanceof HTMLElement ? dismissButton : card;
    const rect = anchor.getBoundingClientRect();
    const badgeSize = 10;
    const top = Math.max(8, rect.top + Math.max(0, (rect.height - badgeSize) / 2));
    const left = Math.max(8, rect.left - badgeSize - 18);

    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    layer.appendChild(host);
    return host;
  }

  function findDetailBadgeAnchor(detailRoot) {
    const selectorFallbacks = [
      "h1, h2, h3, h4",
      '[aria-label^="Company,"]',
      '[aria-label*="Company,"]',
      '.job-details-jobs-unified-top-card__company-name a[href*="/company/"]',
      ".job-details-jobs-unified-top-card__company-name",
      '.jobs-unified-top-card__company-name a[href*="/company/"]',
      ".jobs-unified-top-card__company-name",
      '[class*="company-name"] a[href*="/company/"]',
      '[class*="company-name"]'
    ];

    for (const selector of selectorFallbacks) {
      const element = detailRoot.querySelector(selector);
      if (element instanceof HTMLElement) {
        const normalizedText = normalizeComparableText(extractText(element));
        const bestAnchor = findBestTextAnchor(element, normalizedText);
        if (bestAnchor instanceof HTMLElement) {
          return bestAnchor;
        }

        return element;
      }
    }

    return detailRoot.querySelector("h1, h2, h3, h4") || detailRoot.firstElementChild || detailRoot;
  }

  function ensureDetailBadgeHost(detailRoot, anchorElement = null) {
    const titleAnchor = findDetailTitleElement(detailRoot);
    const anchor =
      (titleAnchor instanceof HTMLElement && titleAnchor) ||
      (anchorElement instanceof HTMLElement && anchorElement) ||
      findDetailBadgeAnchor(detailRoot);

    let host = document.documentElement.querySelector(`:scope > .${DETAIL_HOST_CLASS}`);
    if (!host) {
      host = document.createElement("span");
      host.className = DETAIL_HOST_CLASS;
      document.documentElement.appendChild(host);
    }

    const targetRect = (anchor instanceof HTMLElement ? anchor : detailRoot).getBoundingClientRect();
    const top = Math.max(12, targetRect.top + 8);
    const left = Math.min(window.innerWidth - 20, targetRect.right + 8);

    host.style.left = `${left}px`;
    host.style.top = `${top}px`;

    return host;
  }

  function upsertBadge(host, result, scopeLabel, mode = "full") {
    const badgeState = getBadgeState(result);
    let badge = host.querySelector(`.${BADGE_ROOT_CLASS}`);

    if (!badge) {
      badge = document.createElement(mode === "dot" ? "span" : "div");
      badge.className = BADGE_ROOT_CLASS;
      host.appendChild(badge);
    }

    badge.className = `${BADGE_ROOT_CLASS} ${badgeState.className}${mode === "dot" ? " is-card-dot" : ""}`;
    badge.title = `${badgeState.title} Source: ${scopeLabel}.`;

    if (mode === "dot") {
      badge.textContent = "";
      badge.setAttribute("aria-label", badgeState.label);
      return;
    }

    badge.textContent = badgeState.label;
    badge.removeAttribute("aria-label");
  }

  function getCachedMatchResult(namesToCheck) {
    const normalizedKey = namesToCheck
      .map((name) => SponsorMatcher.normalizeName(name))
      .filter(Boolean)
      .sort()
      .join("|");

    if (!normalizedKey) {
      return null;
    }

    if (!state.matchResultByKey.has(normalizedKey)) {
      state.matchResultByKey.set(normalizedKey, SponsorMatcher.matchCompanyNames(namesToCheck, state.sponsorIndex));
    }

    return state.matchResultByKey.get(normalizedKey);
  }

  function normalizeMatcherName(value) {
    return SponsorMatcher.normalizeName(value || "");
  }

  function collectUniqueStrings(values) {
    const seen = new Set();
    const results = [];

    for (const value of values || []) {
      const text = String(value || "").trim();
      if (!text || seen.has(text)) {
        continue;
      }

      seen.add(text);
      results.push(text);
    }

    return results;
  }

  function findKnownSponsorAliasInText(text) {
    const normalized = normalizeMatcherName(text);
    if (!normalized || !state.sponsorIndex) {
      return "";
    }

    const tokens = normalized.split(" ").filter(Boolean);
    let bestAlias = "";

    for (let start = 0; start < Math.min(tokens.length, 4); start += 1) {
      for (let length = 1; length <= Math.min(6, tokens.length - start); length += 1) {
        const alias = tokens.slice(start, start + length).join(" ");
        if (state.sponsorIndex.exactAliases.has(alias) || state.sponsorIndex.brandAliases.has(alias)) {
          if (alias.length > bestAlias.length) {
            bestAlias = alias;
          }
        }
      }
    }

    return bestAlias;
  }

  function extractSponsorAwareCardCandidates(card) {
    if (!(card instanceof HTMLElement)) {
      return [];
    }

    const title = normalizeComparableText(extractCardTitle(card));
    const candidates = [];
    const textSources = [
      ...extractVisibleTextLines(card),
      ...collectOrderedTextCandidates(card, "p, a, span, strong, div").map(({ text }) => text)
    ];

    for (const sourceText of textSources) {
      if (!sourceText) {
        continue;
      }

      candidates.push(sourceText);

      if (title && sourceText.includes(title)) {
        const remainder = normalizeComparableText(sourceText.replace(title, " "));
        if (remainder) {
          candidates.push(remainder);
        }
      }
    }

    const aliases = [];
    for (const candidate of collectUniqueStrings(candidates)) {
      const alias = findKnownSponsorAliasInText(candidate);
      if (alias) {
        aliases.push(alias);
      }
    }

    return collectUniqueStrings(aliases);
  }

  function getLeadingToken(value) {
    return normalizeMatcherName(value).split(" ").filter(Boolean)[0] || "";
  }

  function scoreCardSnapshotMatch(snapshot, detailTitle, detailCompanyName) {
    if (!snapshot || !detailTitle) {
      return -Infinity;
    }

    let score = 0;
    const snapshotTitle = normalizeMatcherName(snapshot.title);
    const normalizedDetailTitle = normalizeMatcherName(detailTitle);
    const snapshotCompany = normalizeMatcherName(snapshot.company);
    const normalizedDetailCompany = normalizeMatcherName(detailCompanyName);

    if (snapshotTitle === normalizedDetailTitle) {
      score += 100;
    } else if (snapshotTitle.includes(normalizedDetailTitle) || normalizedDetailTitle.includes(snapshotTitle)) {
      score += 50;
    } else {
      return -Infinity;
    }

    if (snapshotCompany && normalizedDetailCompany) {
      if (snapshotCompany === normalizedDetailCompany) {
        score += 40;
      } else if (snapshotCompany.includes(normalizedDetailCompany) || normalizedDetailCompany.includes(snapshotCompany)) {
        score += 25;
      } else if (getLeadingToken(snapshotCompany) && getLeadingToken(snapshotCompany) === getLeadingToken(normalizedDetailCompany)) {
        score += 20;
      }
    }

    return score;
  }

  function findSnapshotResultForDetail(detailInfo) {
    const detailTitle = detailInfo?.root ? extractDetailTitle(detailInfo.root) : "";
    const detailCompanyName = detailInfo?.name || "";
    if (!detailTitle) {
      return null;
    }

    let bestSnapshot = null;
    let bestScore = -Infinity;

    for (const snapshot of state.cardSnapshotByJobKey.values()) {
      const score = scoreCardSnapshotMatch(snapshot, detailTitle, detailCompanyName);
      if (score > bestScore) {
        bestSnapshot = snapshot;
        bestScore = score;
      }
    }

    return bestScore > 0 ? bestSnapshot?.result || null : null;
  }

  function buildCardMatchContext(card, detailCompanyName, activeCard) {
    const companyInfo = extractCardCompanyInfo(card);
    const cardCompanyName = companyInfo.name;
    const sponsorAwareCandidates = extractSponsorAwareCardCandidates(card);

    if (!cardCompanyName && !sponsorAwareCandidates.length) {
      return null;
    }

    const namesToCheck = collectUniqueStrings([cardCompanyName, ...sponsorAwareCandidates]);
    const jobKey = extractJobKey(card);

    if (jobKey && state.detailNameByJobKey.has(jobKey)) {
      namesToCheck.push(state.detailNameByJobKey.get(jobKey));
    }

    if (detailCompanyName && activeCard === card) {
      namesToCheck.push(detailCompanyName);
      if (jobKey) {
        state.detailNameByJobKey.set(jobKey, detailCompanyName);
      }
    }

    return {
      companyInfo,
      namesToCheck,
      jobKey
    };
  }

  function annotateCard(card, detailCompanyName, activeCard, cardLayer, anchorButton = null, matchRoot = null) {
    const effectiveRoot = matchRoot instanceof HTMLElement ? matchRoot : card;

    if (isInsideDetailPanel(card) || isInsideDetailPanel(effectiveRoot)) {
      return false;
    }

    const matchContext = buildCardMatchContext(effectiveRoot, detailCompanyName, activeCard);
    if (!matchContext) {
      return false;
    }

    const result = getCachedMatchResult(matchContext.namesToCheck);
    if (matchContext.jobKey) {
      state.cardResultByJobKey.set(matchContext.jobKey, result);
      state.cardSnapshotByJobKey.set(matchContext.jobKey, {
        title: extractCardTitle(card),
        company: matchContext.companyInfo.name,
        result
      });
    }
    const host = ensureCardBadgeHost(card, cardLayer, anchorButton);
    upsertBadge(host, result, "job card", "dot");
    return true;
  }

  function getSelectedDetailResult(detailInfo, activeCard, preferredResult = null) {
    const locationJobKey = extractJobKeyFromLocation();
    if (locationJobKey && state.cardResultByJobKey.has(locationJobKey)) {
      state.selectedJobKey = locationJobKey;
      return state.cardResultByJobKey.get(locationJobKey);
    }

    if (state.selectedJobKey && state.cardResultByJobKey.has(state.selectedJobKey)) {
      return state.cardResultByJobKey.get(state.selectedJobKey);
    }

    if (activeCard) {
      const activeJobKey = extractJobKey(activeCard);
      if (activeJobKey && state.cardResultByJobKey.has(activeJobKey)) {
        state.selectedJobKey = activeJobKey;
        return state.cardResultByJobKey.get(activeJobKey);
      }
    }

    const snapshotResult = findSnapshotResultForDetail(detailInfo);
    if (snapshotResult) {
      return snapshotResult;
    }

    return preferredResult;
  }

  function annotateDetailPanel(detailInfo, preferredResult = null, activeCard = null) {
    const detailRoot = detailInfo?.root || findDetailTopCard();
    const detailCompanyName = detailInfo?.name || "";
    if (!detailRoot) {
      return;
    }

    const fallbackNames = [];
    if (detailCompanyName) {
      fallbackNames.push(detailCompanyName);
    }

    if (activeCard) {
      const activeCardCompanyName = extractCardCompanyName(activeCard);
      if (activeCardCompanyName) {
        fallbackNames.push(activeCardCompanyName);
      }
    }

    const result = getSelectedDetailResult(detailInfo, activeCard, preferredResult) || getCachedMatchResult(fallbackNames);
    if (!result) {
      return;
    }

    const host = ensureDetailBadgeHost(detailRoot, detailInfo?.element || null);
    upsertBadge(host, result, "detail panel", "dot");
  }

  function scanLinkedInJobsPage() {
    const cards = findJobCards();
    const activeEntry = findActiveCard(cards);
    const activeCard = activeEntry?.matchRoot || activeEntry?.root || null;
    const detailInfo = extractDetailCompanyInfo(activeCard);
    const detailCompanyName = detailInfo.name;
    const debug = getCardDebugSnapshot();
    let annotatedCount = 0;
    const locationJobKey = extractJobKeyFromLocation();
    const cardLayer = resetCardBadgeLayer();

    if (locationJobKey) {
      state.selectedJobKey = locationJobKey;
    }

    if (detailCompanyName && activeCard) {
      const jobKey = extractJobKey(activeCard);
      if (jobKey) {
        state.detailNameByJobKey.set(jobKey, detailCompanyName);
      }
    }

    const activeCardMatchContext = activeCard ? buildCardMatchContext(activeCard, detailCompanyName, activeCard) : null;
    const activeCardResult = activeCardMatchContext ? getCachedMatchResult(activeCardMatchContext.namesToCheck) : null;

    if (activeCardMatchContext?.jobKey && activeCardResult) {
      state.cardResultByJobKey.set(activeCardMatchContext.jobKey, activeCardResult);
      if (!state.selectedJobKey) {
        state.selectedJobKey = activeCardMatchContext.jobKey;
      }
    }

    for (const entry of cards) {
      if (annotateCard(entry.root, detailCompanyName, activeCard, cardLayer, entry.anchor, entry.matchRoot)) {
        annotatedCount += 1;
      }
    }

    annotateDetailPanel(detailInfo, activeCardResult, activeCard);

    if (!cards.length) {
      upsertStatus(
        "ready",
        `0 job cards detected • links ${debug.jobViewLinks}/${debug.currentJobLinks} • dismiss ${debug.dismissButtons} • list items ${debug.listCandidates} • ids ${debug.jobIdCandidates}`
      );
      return;
    }

    upsertStatus(
      "ready",
      `${cards.length} job cards detected • ${annotatedCount} annotated${detailCompanyName ? " • detail company found" : ""}`
    );
  }

  function startObservers() {
    if (state.observer) {
      state.observer.disconnect();
    }

    for (const teardown of state.eventTeardown) {
      teardown();
    }
    state.eventTeardown = [];

    state.observer = new MutationObserver(() => {
      scheduleScan();
    });

    state.observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "href", "aria-current", "data-job-id"]
    });

    const onPopstate = () => scheduleScan();
    const onFocus = () => scheduleScan();
    const onScroll = () => scheduleScan();
    const onClick = (event) => {
      const clickedCard = findCardElementFromTarget(event.target);
      if (clickedCard) {
        const jobKey = extractJobKey(clickedCard);
        if (jobKey) {
          state.selectedJobKey = jobKey;
        }
      }

      window.setTimeout(scheduleScan, 80);
    };

    window.addEventListener("popstate", onPopstate);
    window.addEventListener("focus", onFocus);
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    document.addEventListener("click", onClick, true);

    state.eventTeardown.push(() => window.removeEventListener("popstate", onPopstate));
    state.eventTeardown.push(() => window.removeEventListener("focus", onFocus));
    state.eventTeardown.push(() => window.removeEventListener("scroll", onScroll, true));
    state.eventTeardown.push(() => document.removeEventListener("click", onClick, true));
  }

  async function init() {
    try {
      upsertStatus("booting", "Loading sponsor list");
      state.sponsorIndex = await loadSponsorIndex();
      startObservers();
      scheduleScan();
    } catch (error) {
      logError("Extension failed to initialize.", error);
      upsertStatus("error", error instanceof Error ? error.message : "Initialization failed");
    }
  }

  init();
})();
