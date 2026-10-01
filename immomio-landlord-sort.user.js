// ==UserScript==
// @name         Immomio – Anbieter sortieren & filtern
// @namespace    https://github.com/tekes/immomio-landlord-sort
// @version      0.1.0
// @description  Sort, filter and "load all" for the Immomio landlord overview
// @author       Sahin Tekes
// @license      MIT
// @homepageURL  https://github.com/tekes/immomio-landlord-sort
// @supportURL   https://github.com/tekes/immomio-landlord-sort/issues
// @updateURL    https://raw.githubusercontent.com/tekes/immomio-landlord-sort/main/immomio-landlord-sort.user.js
// @downloadURL  https://raw.githubusercontent.com/tekes/immomio-landlord-sort/main/immomio-landlord-sort.user.js
// @match        https://tenant.immomio.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  // ----- Configuration -----

  const STORAGE_KEY = "tm-immomio-landlord-sort";

  const LOAD_ALL_TIMEOUT_MS = 60 * 1000;
  const PAGE_LOAD_TIMEOUT_MS = 10 * 1000;
  const BUSY_RETRY_MS = 250;
  const POLL_INTERVAL_MS = 150;

  const SELECTORS = {
    list: "app-landlord-customer-list",
    card: "app-landlord-customer-list a.landlord-customer-card__card",
    name: ".landlord-customer-card__name",
    since: ".landlord-customer-card__since",
    countValue: ".landlord-customer-card__count-value",
    activeSearchProfile: ".landlord-customer-card__sp-status--active",
    section: ".immomio-now-page__section",
    pager: "im-pagination-indicator"
  };

  const DEFAULT_SETTINGS = {
    sort: "offers",
    reverse: false,
    activityFilter: "all",
    autoLoad: false
  };

  // direction: -1 = descending, 1 = ascending
  const SORT_OPTIONS = {
    offers: { label: "Angebote", direction: -1, getValue: (card) => card.getOffers() },
    applications: { label: "Bewerbungen", direction: -1, getValue: (card) => card.getApplications() },
    appointments: { label: "Termine", direction: -1, getValue: (card) => card.getAppointments() },
    activity: { label: "Aktivität (Summe)", direction: -1, getValue: (card) => card.getTotalActivity() },
    name: { label: "Name", direction: 1, getValue: (card) => card.getName() },
    since: { label: "Verbunden seit", direction: -1, getValue: (card) => card.getConnectedSince() },
    profile: { label: "Suchprofil aktiv", direction: -1, getValue: (card) => (card.hasActiveSearchProfile() ? 1 : 0) },
    original: { label: "Originalreihenfolge", direction: 1, getValue: (card) => card.getOriginalIndex() }
  };

  const ACTIVITY_FILTERS = {
    all: { label: "Alle", matches: () => true },
    offers: { label: "Mit Angeboten", matches: (card) => card.hasOffers() },
    applications: { label: "Mit Bewerbungen", matches: (card) => card.hasApplications() },
    appointments: { label: "Mit Terminen", matches: (card) => card.hasAppointments() }
  };

  // month index as expected by Date.UTC (0 = January)
  const MONTHS = {
    januar: 0, january: 0, februar: 1, february: 1, "märz": 2, march: 2,
    april: 3, mai: 4, may: 4, juni: 5, june: 5, juli: 6, july: 6, august: 7,
    september: 8, oktober: 9, october: 9, november: 10, dezember: 11, december: 11
  };

  const collator = new Intl.Collator("de", { sensitivity: "base", numeric: true });

  // ----- Styles (colors follow Immomio's CSS variables) -----

  const TOOLBAR_STYLE = {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "16px 20px",
    borderRadius: "12px",
    border: "1px solid var(--im-color-border, #ced2d5)",
    background: "var(--im-color-container, #fff)",
    color: "var(--im-color-text-primary, #050b13)"
  };

  const ROW_STYLE = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px" };

  const LABEL_STYLE = { display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer", userSelect: "none" };

  const CONTROL_STYLE = {
    font: "inherit",
    height: "36px",
    padding: "0 10px",
    border: "1px solid var(--im-color-border, #ced2d5)",
    borderRadius: "8px",
    background: "var(--im-color-container, #fff)",
    color: "var(--im-color-text-primary, #050b13)",
    cursor: "pointer"
  };

  const SEARCH_STYLE = { ...CONTROL_STYLE, cursor: "text", flex: "1 1 180px", minWidth: "140px" };

  const INFO_STYLE = { marginLeft: "auto", fontSize: "14px", color: "var(--im-color-text-secondary, #7c8592)" };

  // ----- Helpers -----

  function createHtmlElement(tag, props = {}, ...children) {
    const { style, ...attributes } = props;
    const element = document.createElement(tag);

    Object.assign(element, attributes);
    if (style) {
      Object.assign(element.style, style);
    }
    element.append(...children);

    return element;
  }

  function createCheckbox(label, isChecked, onToggle) {
    const checkbox = createHtmlElement("input", { type: "checkbox", checked: isChecked });
    checkbox.addEventListener("change", () => onToggle(checkbox.checked));

    return createHtmlElement("label", { style: LABEL_STYLE }, checkbox, label);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitUntil(condition, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (condition()) {
        return true;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return false;
  }

  // "Verbunden seit 28. September 2026" or "Connected since September 28, 2026" -> timestamp, 0 if unknown
  function readDate(text) {
    const lowerText = text.toLowerCase();
    const german = lowerText.match(/(\d{1,2})\.\s*([a-zäöü]+)\s+(\d{4})/);
    const english = lowerText.match(/([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/);

    if (german && Object.hasOwn(MONTHS, german[2])) {
      return Date.UTC(Number(german[3]), MONTHS[german[2]], Number(german[1]));
    }
    if (english && Object.hasOwn(MONTHS, english[1])) {
      return Date.UTC(Number(english[3]), MONTHS[english[1]], Number(english[2]));
    }
    return 0;
  }

  // ----- Settings -----

  class Settings {
    #values;
    #onChange;

    constructor(onChange) {
      this.#values = this.#load();
      this.#onChange = onChange;
    }

    getSortKey() {
      return this.#values.sort;
    }

    getSortOption() {
      return SORT_OPTIONS[this.#values.sort];
    }

    getSortDirection() {
      const { direction } = this.getSortOption();
      return this.#values.reverse ? -direction : direction;
    }

    isDescending() {
      return this.getSortDirection() < 0;
    }

    changeSort(key) {
      this.#values.sort = key;
      this.#values.reverse = false;
      this.#save();
    }

    toggleDirection() {
      this.#values.reverse = !this.#values.reverse;
      this.#save();
    }

    getActivityFilterKey() {
      return this.#values.activityFilter;
    }

    getActivityFilter() {
      return ACTIVITY_FILTERS[this.#values.activityFilter];
    }

    changeActivityFilter(key) {
      this.#values.activityFilter = key;
      this.#save();
    }

    isAutoLoadEnabled() {
      return this.#values.autoLoad;
    }

    setAutoLoad(isEnabled) {
      this.#values.autoLoad = isEnabled;
      this.#save();
    }

    #load() {
      let stored = {};
      try {
        stored = JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
      } catch (error) {
        console.warn("immomio-landlord-sort: could not read settings", error);
      }

      const values = { ...DEFAULT_SETTINGS, ...stored };

      if (!Object.hasOwn(SORT_OPTIONS, values.sort)) {
        values.sort = DEFAULT_SETTINGS.sort;
      }
      if (!Object.hasOwn(ACTIVITY_FILTERS, values.activityFilter)) {
        values.activityFilter = DEFAULT_SETTINGS.activityFilter;
      }

      return values;
    }

    #save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#values));
      } catch (error) {
        console.warn("immomio-landlord-sort: could not save settings", error);
      }
      this.#onChange();
    }
  }

  // ----- Landlord card -----

  class LandlordCard {
    #element;
    #originalIndex;
    #name;
    #offers;
    #applications;
    #appointments;
    #connectedSince;
    #hasActiveSearchProfile;

    static readAllFromPage() {
      return [...document.querySelectorAll(SELECTORS.card)].map((element, index) => new LandlordCard(element, index));
    }

    static countOnPage() {
      return document.querySelectorAll(SELECTORS.card).length;
    }

    constructor(element, originalIndex) {
      const counts = [...element.querySelectorAll(SELECTORS.countValue)].map((value) => parseInt(value.textContent, 10) || 0);
      const [offers = 0, applications = 0, appointments = 0] = counts;

      this.#element = element;
      this.#originalIndex = originalIndex;
      this.#name = element.querySelector(SELECTORS.name)?.textContent.trim() ?? "";
      this.#offers = offers;
      this.#applications = applications;
      this.#appointments = appointments;
      this.#connectedSince = readDate(element.querySelector(SELECTORS.since)?.textContent ?? "");
      this.#hasActiveSearchProfile = element.querySelector(SELECTORS.activeSearchProfile) !== null;
    }

    getName() {
      return this.#name;
    }

    getOriginalIndex() {
      return this.#originalIndex;
    }

    getOffers() {
      return this.#offers;
    }

    getApplications() {
      return this.#applications;
    }

    getAppointments() {
      return this.#appointments;
    }

    getTotalActivity() {
      return this.#offers + this.#applications + this.#appointments;
    }

    getConnectedSince() {
      return this.#connectedSince;
    }

    hasOffers() {
      return this.#offers > 0;
    }

    hasApplications() {
      return this.#applications > 0;
    }

    hasAppointments() {
      return this.#appointments > 0;
    }

    hasActiveSearchProfile() {
      return this.#hasActiveSearchProfile;
    }

    matchesName(query) {
      return this.#name.toLowerCase().includes(query);
    }

    // the list is a flex container, so "order" changes the visual order without touching Angular's DOM
    moveTo(position) {
      this.#element.style.order = String(position);
    }

    setVisible(isVisible) {
      this.#element.style.display = isVisible ? "" : "none";
    }
  }

  // ----- Pagination ("10 von 17 Ergebnissen" / "10 of 17 results" + "Mehr anzeigen" button) -----

  class Pagination {
    hasMore() {
      const { loaded, total } = this.#readCounter();
      return this.#getButton() !== null && (total === 0 || loaded < total);
    }

    getTotal() {
      return this.#readCounter().total;
    }

    isBusy() {
      return this.#getButton()?.disabled === true;
    }

    requestMore() {
      this.#getButton()?.click();
    }

    #getPager() {
      return document.querySelector(SELECTORS.pager);
    }

    #getButton() {
      return this.#getPager()?.querySelector("button") ?? null;
    }

    #readCounter() {
      const counter = this.#getPager()?.textContent.match(/(\d+)\D+(\d+)/);
      return {
        loaded: counter ? Number(counter[1]) : 0,
        total: counter ? Number(counter[2]) : 0
      };
    }
  }

  // ----- Load all -----

  class LandlordLoader {
    #pagination;
    #onStateChange;
    #isLoading = false;

    constructor(pagination, onStateChange) {
      this.#pagination = pagination;
      this.#onStateChange = onStateChange;
    }

    isLoading() {
      return this.#isLoading;
    }

    async loadAll() {
      if (this.#isLoading) {
        return;
      }
      this.#setLoading(true);

      const deadline = Date.now() + LOAD_ALL_TIMEOUT_MS;
      try {
        while (this.#pagination.hasMore() && Date.now() < deadline) {
          if (this.#pagination.isBusy()) {
            await sleep(BUSY_RETRY_MS);
            continue;
          }

          const hasLoadedMore = await this.#loadNextPage();
          if (!hasLoadedMore) {
            break;
          }
        }
      } finally {
        this.#setLoading(false);
      }
    }

    async #loadNextPage() {
      const countBefore = LandlordCard.countOnPage();
      this.#pagination.requestMore();

      return waitUntil(() => LandlordCard.countOnPage() > countBefore || !this.#pagination.hasMore(), PAGE_LOAD_TIMEOUT_MS);
    }

    #setLoading(isLoading) {
      this.#isLoading = isLoading;
      this.#onStateChange();
    }
  }

  // ----- Toolbar -----

  class Toolbar {
    #element;
    #directionButton;
    #loadAllButton;
    #infoText;

    constructor(settings, { onSearch, onLoadAll }) {
      this.#directionButton = createHtmlElement("button", { type: "button", title: "Richtung umkehren", style: CONTROL_STYLE });
      this.#directionButton.addEventListener("click", () => settings.toggleDirection());

      this.#loadAllButton = createHtmlElement("button", { type: "button", style: CONTROL_STYLE });
      this.#loadAllButton.addEventListener("click", () => onLoadAll());

      this.#infoText = createHtmlElement("span", { style: INFO_STYLE });

      const controls = createHtmlElement("div", { style: ROW_STYLE },
        this.#createSortSelect(settings),
        this.#directionButton,
        this.#createSearchInput(onSearch),
        this.#loadAllButton,
        createCheckbox("Immer alle laden", settings.isAutoLoadEnabled(), (isChecked) => settings.setAutoLoad(isChecked)),
        this.#infoText);

      const activityFilter = this.#createRadioGroup({
        label: "Filter:",
        name: "tm-landlord-activity-filter",
        options: ACTIVITY_FILTERS,
        selectedKey: settings.getActivityFilterKey(),
        onSelect: (key) => settings.changeActivityFilter(key)
      });

      this.#element = createHtmlElement("div", { id: "tm-landlord-sort-bar", style: TOOLBAR_STYLE },
        controls, activityFilter);
    }

    mountBefore(list) {
      const heading = list.closest(SELECTORS.section)?.querySelector(":scope > h2");
      if (heading) {
        heading.after(this.#element);
      } else {
        list.before(this.#element);
      }
    }

    isMounted() {
      return this.#element.isConnected;
    }

    contains(node) {
      return this.#element.contains(node);
    }

    render({ isDescending, isLoading, hasMore, visibleCount, loadedCount, total }) {
      this.#directionButton.textContent = isDescending ? "↓ absteigend" : "↑ aufsteigend";

      this.#loadAllButton.disabled = isLoading || !hasMore;
      this.#loadAllButton.textContent = this.#getLoadAllLabel(isLoading, hasMore);

      this.#infoText.textContent = `${visibleCount} sichtbar · ${loadedCount} geladen`;
      if (total > 0) {
        this.#infoText.textContent += ` von ${total}`;
      }
    }

    #getLoadAllLabel(isLoading, hasMore) {
      if (isLoading) {
        return "Lade …";
      }
      return hasMore ? "Alle anzeigen" : "Alle geladen";
    }

    #createSortSelect(settings) {
      const select = createHtmlElement("select", { title: "Sortierung", style: CONTROL_STYLE });
      for (const [key, option] of Object.entries(SORT_OPTIONS)) {
        select.append(createHtmlElement("option", { value: key, textContent: option.label }));
      }
      select.value = settings.getSortKey();
      select.addEventListener("change", () => settings.changeSort(select.value));

      return select;
    }

    #createSearchInput(onSearch) {
      const input = createHtmlElement("input", { type: "search", placeholder: "Name filtern …", style: SEARCH_STYLE });
      input.addEventListener("input", () => onSearch(input.value));

      return input;
    }

    #createRadioGroup({ label, name, options, selectedKey, onSelect }) {
      const group = createHtmlElement("div", { role: "radiogroup", ariaLabel: label, style: ROW_STYLE },
        createHtmlElement("strong", { textContent: label }));

      for (const [key, option] of Object.entries(options)) {
        const radio = createHtmlElement("input", { type: "radio", name, value: key, checked: key === selectedKey });
        radio.addEventListener("change", () => onSelect(key));
        group.append(createHtmlElement("label", { style: LABEL_STYLE }, radio, option.label));
      }

      return group;
    }
  }

  // ----- Page controller -----

  class LandlordOverview {
    #settings = new Settings(() => this.scheduleUpdate());
    #pagination = new Pagination();
    #loader = new LandlordLoader(this.#pagination, () => this.scheduleUpdate());
    #toolbar = new Toolbar(this.#settings, {
      onSearch: (query) => this.#search(query),
      onLoadAll: () => this.#loader.loadAll()
    });

    #searchQuery = "";
    #updateQueued = false;

    start() {
      // re-run on page changes, but ignore changes inside our own toolbar
      const observer = new MutationObserver((mutations) => {
        const pageChanged = mutations.some((mutation) => !this.#toolbar.contains(mutation.target));
        if (pageChanged) {
          this.scheduleUpdate();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      this.scheduleUpdate();
    }

    scheduleUpdate() {
      if (this.#updateQueued) {
        return;
      }
      this.#updateQueued = true;
      requestAnimationFrame(() => {
        this.#updateQueued = false;
        this.#update();
      });
    }

    #search(query) {
      this.#searchQuery = query.trim().toLowerCase();
      this.scheduleUpdate();
    }

    #update() {
      const list = document.querySelector(SELECTORS.list);
      if (list === null) {
        return;
      }
      if (!this.#toolbar.isMounted()) {
        this.#toolbar.mountBefore(list);
      }

      const cards = LandlordCard.readAllFromPage().sort((a, b) => this.#compare(a, b));
      let visibleCount = 0;

      cards.forEach((card, position) => {
        const isVisible = this.#isVisible(card);
        card.moveTo(position);
        card.setVisible(isVisible);

        if (isVisible) {
          visibleCount++;
        }
      });

      this.#toolbar.render({
        isDescending: this.#settings.isDescending(),
        isLoading: this.#loader.isLoading(),
        hasMore: this.#pagination.hasMore(),
        visibleCount,
        loadedCount: cards.length,
        total: this.#pagination.getTotal()
      });

      this.#autoLoadOnce(list);
    }

    #compare(a, b) {
      const { getValue } = this.#settings.getSortOption();
      const valueA = getValue(a);
      const valueB = getValue(b);
      const result = typeof valueA === "string" ? collator.compare(valueA, valueB) : valueA - valueB;

      // equal values: fall back to name, then to the original position
      return this.#settings.getSortDirection() * result
        || collator.compare(a.getName(), b.getName())
        || a.getOriginalIndex() - b.getOriginalIndex();
    }

    #isVisible(card) {
      return card.matchesName(this.#searchQuery) && this.#settings.getActivityFilter().matches(card);
    }

    // the list element is recreated on navigation, so the flag resets automatically
    #autoLoadOnce(list) {
      if (!this.#settings.isAutoLoadEnabled()) {
        return;
      }

      if (list.dataset.autoLoaded === "true") {
        return;
      }

      if (this.#loader.isLoading()) {
        return;
      }

      if (!this.#pagination.hasMore()) {
        return;
      }

      list.dataset.autoLoaded = "true";
      this.#loader.loadAll();
    }
  }

  new LandlordOverview().start();
})();
