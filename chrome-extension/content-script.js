(function runContentScript() {
  const helpers = globalThis.UVSCPageHelpers;
  if (!helpers) {
    console.error("[VisaSponsorChecker] UVSCPageHelpers was not loaded before content-script.js");
    return;
  }

  const {
    STATUS_ROOT_CLASS,
    findJobCards,
    findTopLevelLeftPanelCandidates,
    findActiveCard,
    extractDetailCompanyInfo,
    extractDetailTitle,
    extractJobKey,
    extractJobKeyFromLocation,
    extractCardTitle,
    extractCardCompanyName,
    extractCardCompanyInfo,
    extractVisibleTextLines,
    collectOrderedTextCandidates,
    normalizeComparableText,
    normalizeCardElement,
    looksLikeJobCard,
    countJobLinks,
    countDismissButtons,
    getCardDebugSnapshot,
    isActiveCard,
    resetCardBadgeLayer,
    ensureCardBadgeHost,
    ensureDetailBadgeHost,
    upsertBadge,
    findDetailTopCard,
    findCardElementFromTarget,
    isInsideDetailPanel
  } = helpers;

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
    lastDiscoveryDebugSignature: "",
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
      return null;
    }

    const matchContext = buildCardMatchContext(effectiveRoot, detailCompanyName, activeCard);
    if (!matchContext) {
      return null;
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
    return result;
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
    const leftPanelCandidates = findTopLevelLeftPanelCandidates();
    const activeEntry = findActiveCard(cards);
    const activeCard = activeEntry?.matchRoot || activeEntry?.root || null;
    const detailInfo = extractDetailCompanyInfo(activeCard);
    const detailCompanyName = detailInfo.name;
    const debug = getCardDebugSnapshot();
    const debugJobs = cards.slice(0, 25).map((entry, index) => {
      const card = entry.matchRoot || entry.root;
      const link = card.querySelector('a[href*="/jobs/view/"], a[href*="currentJobId="]');

      return {
        index: index + 1,
        jobKey: extractJobKey(card),
        title: extractCardTitle(card),
        company: extractCardCompanyName(card),
        active: isActiveCard(entry.root),
        href: link?.href || "",
        textPreview: extractVisibleTextLines(card).slice(0, 4).join(" | ")
      };
    });
    let annotatedCount = 0;
    const debugMatchBooleans = [];
    const locationJobKey = extractJobKeyFromLocation();
    const cardLayer = resetCardBadgeLayer();

    console.log(`[VisaSponsorChecker] scanLinkedInJobsPage found ${cards.length} cards`);
    console.table(debugJobs);

    const discoverySignature = `${leftPanelCandidates.length}:${cards.length}`;
    if (leftPanelCandidates.length !== cards.length && state.lastDiscoveryDebugSignature !== discoverySignature) {
      state.lastDiscoveryDebugSignature = discoverySignature;

      console.log(
        `[VisaSponsorChecker] discovery mismatch: ${leftPanelCandidates.length} top-level list candidates vs ${cards.length} extracted cards`
      );
      console.table(
        leftPanelCandidates.slice(0, 40).map((candidate, index) => {
          const normalized = normalizeCardElement(candidate) || candidate;
          const accepted = cards.some(
            (entry) =>
              entry.root === candidate ||
              entry.root === normalized ||
              entry.matchRoot === candidate ||
              entry.matchRoot === normalized
          );

          return {
            index: index + 1,
            accepted,
            looksLikeJobCard: looksLikeJobCard(candidate),
            jobLinks: countJobLinks(candidate),
            dismissButtons: countDismissButtons(candidate),
            title: extractCardTitle(candidate),
            company: extractCardCompanyName(candidate),
            textPreview: extractVisibleTextLines(candidate).slice(0, 4).join(" | ")
          };
        })
      );
    }

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
      const result = annotateCard(entry.root, detailCompanyName, activeCard, cardLayer, entry.anchor, entry.matchRoot);
      debugMatchBooleans.push(Boolean(result?.matched));
      if (result) {
        annotatedCount += 1;
      }
    }

    console.log("[VisaSponsorChecker] match booleans", debugMatchBooleans);
    console.table(
      debugJobs.map((job, index) => ({
        index: job.index,
        title: job.title,
        company: job.company,
        matched: debugMatchBooleans[index] ?? false
      }))
    );

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
