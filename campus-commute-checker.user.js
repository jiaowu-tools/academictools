// ==UserScript==
// @name         小蚁课表校区通勤核对助手
// @namespace    local.codex.campus-commute-checker
// @version      1.4.4
// @description  在小蚁教师课表页检查校区通勤冲突，并查找老师/督导共同空档
// @match        https://www.antiedu.tech/*
// @downloadURL  https://raw.githubusercontent.com/jiaowu-tools/academictools/main/campus-commute-checker.user.js
// @updateURL    https://raw.githubusercontent.com/jiaowu-tools/academictools/main/campus-commute-checker.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Version rule: keep this value in sync with @version above.
  // x.y.9 -> x.y.10 -> x.(y+1).0; when y=10 and z+1>10, roll to (x+1).0.0.
  const SCRIPT_VERSION = '1.4.4';
  const PANEL_POSITION_STORAGE_KEY = 'campus-commute-checker.panelPosition';
  const DRAFT_NOTE_POSITION_STORAGE_KEY = 'campus-commute-checker.draftNotePosition';
  const DRAFT_MODAL_POSITION_STORAGE_KEY = 'campus-commute-checker.draftModalPosition';
  const ATTENDEE_HELPER_POSITION_STORAGE_KEY = 'campus-commute-checker.attendeeHelperPosition';
  const MEETING_DRAFT_STORAGE_KEY = 'campus-commute-checker.meetingDraft';
  const MEETING_ADD_PATH = '/meeting/add';
  const MEETING_NAME_STORAGE_KEY = 'campus-commute-checker.lastMeetingName';
  const SUPERVISOR_SCHEDULE_STORAGE_KEY = 'campus-commute-checker.supervisorSchedule';
  const SUPERVISOR_TEST_SCHEDULE_STORAGE_KEY = 'campus-commute-checker.supervisorTest.schedule';
  const CONFIG = {
    defaultAdjacentGapMinutes: 15,
    defaultOnlinePressureBufferMinutes: 60,
    defaultMinutesPerPixel: 1.5,
    defaultDurationMinutes: 45,
    scanPauseMs: 60,
    detailHoverTimeoutMs: 180,
    detailHoverPollMs: 20,
    detailScanBudgetMs: 450,
    visibleDetailScanBudgetMs: 1200,
    maxDetailMissesPerScan: 6,
    maxScanSteps: 700,
    defaultMeetingDurationMinutes: 45,
    meetingEventBufferMinutes: 5,
    meetingWindowStartMinutes: 9 * 60,
    meetingWindowEndMinutes: 18 * 60 + 10,
    eveningMeetingWindowStartMinutes: 18 * 60 + 10,
    eveningMeetingWindowEndMinutes: 21 * 60,
    meetingSearchStepMinutes: 15,
    meetingAttendeeAutoSelectDelayMs: 1500,
    meetingAttendeeAutoSelectReadyRetries: 8,
    meetingAttendeeAutoSelectReadyIntervalMs: 350,
    meetingAttendeeSearchSettleMs: 180,
    meetingAttendeeDropdownTimeoutMs: 5200,
    meetingAttendeeAfterClickSettleMs: 280,
    meetingAttendeeBetweenTeachersMs: 120,
    meetingExcludedRanges: [
      { startMinutes: 12 * 60 + 20, endMinutes: 13 * 60 + 15 }
    ],
    supervisorWindowStartMinutes: 8 * 60 + 30,
    supervisorWindowEndMinutes: 21 * 60 + 30,
    supervisorShiftWindows: {
      N: { startMinutes: 8 * 60 + 30, endMinutes: 17 * 60 + 30 },
      A: { startMinutes: 13 * 60 + 15, endMinutes: 21 * 60 + 30 }
    },
    campusByColor: {
      '#E3E648': '下沙校区',
      '#26E8DC': '小和山校区',
      '#EE85EC': '永康校区',
      '#A3E043': '金华校区',
      '#7F91F5': '虚拟校区',
      '#FB5757': '钱江校区',
      '#FFBF41': '城建校区',
      '#B290FE': '紫金港校区'
    },
    onlineByColor: {
      '#FFAFDE': '会议/教研/线上占用'
    },
    realCampuses: new Set([
      '下沙校区',
      '小和山校区',
      '永康校区',
      '金华校区',
      '钱江校区',
      '城建校区',
      '紫金港校区'
    ]),
    commuteRules: {
      '城建校区|钱江校区': 45,
      '城建校区|紫金港校区': 45,
      '钱江校区|紫金港校区': 90,
      '城建校区|金华校区': 150,
      '钱江校区|金华校区': 150,
      '紫金港校区|金华校区': 195,
      '城建校区|永康校区': 150,
      '钱江校区|永康校区': 150,
      '紫金港校区|永康校区': 195,
      '金华校区|永康校区': 90
    }
  };

  const state = {
    lastResult: null,
    lastEvents: [],
    currentMarkers: [],
    isScanning: false,
    networkLogs: [],
    latestDiagramData: null,
    courseDetailCache: new Map(),
    lastScanDateRange: null,
    activeView: 'audit',
    meetingPlanner: {
      selectedTeachers: new Set()
    },
    supervisorPlanner: {
      workbookName: '',
      supervisors: [],
      selectedSupervisors: new Set(),
      dateColumns: [],
      warnings: []
    },
    currentMeetingDraft: null,
    currentMeetingDraftAutoSelectKey: '',
    currentMeetingDraftFieldAutoFillKey: ''
  };

  if (shouldRunSelfTest()) {
    runCampusCommuteSelfTests();
    return;
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  installNetworkCapture();

  function init() {
    syncFloatingToolsForRoute();
    if (isMeetingSubmitPage()) {
      injectStyles();
      cleanupMeetingPresetDraftCache();
      initMeetingDraftPrefill();
      injectMeetingAttendeeHelper();
      installMeetingSubmitReturnFallback();
      return;
    }
    if (!isTeacherSchedulePage()) return;
    injectStyles();
    injectPanel();
    setStatus(`v${SCRIPT_VERSION} 准备就绪。选择课表日期后可点击“异常扫描”或直接查询跑校区。`);
  }

  function syncFloatingToolsForRoute() {
    if (!isTeacherSchedulePage()) removeElementById('ccheck-panel');
    if (!isMeetingSubmitPage()) {
      removeElementById('ccheck-attendee-helper');
      removeElementById('ccheck-meeting-draft-note');
      state.currentMeetingDraft = null;
      state.currentMeetingDraftAutoSelectKey = '';
      state.currentMeetingDraftFieldAutoFillKey = '';
    }
    if (!isTeacherSchedulePage()) removeElementById('ccheck-draft-modal');
  }

  function removeElementById(id) {
    const element = document.getElementById(id);
    if (element) element.remove();
  }

  function scheduleInit() {
    window.setTimeout(init, 0);
    window.setTimeout(init, 300);
    window.setTimeout(init, 1000);
  }

  function installRouteWatcher() {
    if (window.__ccheckRouteWatcherInstalled) return;
    window.__ccheckRouteWatcherInstalled = true;
    let lastUrl = location.href;
    const check = () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      scheduleInit();
    };
    ['pushState', 'replaceState'].forEach((method) => {
      const original = history[method];
      if (typeof original !== 'function') return;
      history[method] = function ccheckHistoryMethod() {
        const result = original.apply(this, arguments);
        scheduleInit();
        return result;
      };
    });
    window.addEventListener('popstate', scheduleInit);
    const observeRoute = () => {
      const root = document.documentElement || document.body;
      if (!root) {
        window.setTimeout(observeRoute, 100);
        return;
      }
      new MutationObserver(check).observe(root, { childList: true, subtree: true });
    };
    observeRoute();
  }

  function installRoutePoller() {
    if (window.__ccheckRoutePollerInstalled) return;
    window.__ccheckRoutePollerInstalled = true;
    let lastState = '';
    const poll = () => {
      const stateKey = [
        location.href,
        isTeacherSchedulePage() ? 'teacher' : '',
        isMeetingSubmitPage() ? 'meeting-add' : '',
        document.getElementById('ccheck-panel') ? 'panel' : '',
        document.getElementById('ccheck-attendee-helper') ? 'attendee' : ''
      ].join('|');
      if (stateKey !== lastState) {
        lastState = stateKey;
        scheduleInit();
      } else if ((isTeacherSchedulePage() && !document.getElementById('ccheck-panel'))
        || (isMeetingSubmitPage() && !document.getElementById('ccheck-attendee-helper'))) {
        scheduleInit();
      }
    };
    poll();
    window.setInterval(poll, 500);
  }

  function isTeacherSchedulePage() {
    return location.pathname.startsWith('/schedule/teacher');
  }

  function isMeetingPage() {
    return location.pathname.startsWith('/meeting/');
  }

  function injectStyles() {
    if (document.getElementById('ccheck-style')) return;
    const style = document.createElement('style');
    style.id = 'ccheck-style';
    style.textContent = `
      #ccheck-panel {
        position: fixed;
        z-index: 999999;
        right: 16px;
        top: 86px;
        width: 370px;
        max-height: calc(100vh - 108px);
        display: flex;
        flex-direction: column;
        gap: 10px;
        box-sizing: border-box;
        padding: 14px;
        color: #172033;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(17, 24, 39, 0.12);
        border-radius: 8px;
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        font-size: 13px;
        line-height: 1.45;
      }

      #ccheck-panel.ccheck-collapsed {
        width: auto;
        max-width: 240px;
        padding: 10px 12px;
      }

      #ccheck-panel.ccheck-collapsed .ccheck-body {
        display: none;
      }

      .ccheck-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        cursor: move;
        user-select: none;
      }

      .ccheck-title {
        display: flex;
        align-items: baseline;
        gap: 6px;
        font-size: 15px;
        font-weight: 700;
      }

      .ccheck-version {
        color: #64748b;
        font-size: 12px;
        font-weight: 600;
      }

      .ccheck-toggle {
        width: 28px;
        height: 28px;
        border: 1px solid #d5dae3;
        border-radius: 6px;
        background: #ffffff;
        color: #475569;
        cursor: pointer;
      }

      #ccheck-panel.ccheck-dragging {
        user-select: none;
      }

      .ccheck-body {
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-height: 0;
        overflow: auto;
        padding-right: 2px;
      }

      .ccheck-actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .ccheck-tabs {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 6px;
        padding: 4px;
        background: #f1f5f9;
        border: 1px solid #e2e8f0;
        border-radius: 7px;
      }

      .ccheck-tab {
        height: 30px;
        border: 1px solid transparent;
        border-radius: 5px;
        background: transparent;
        color: #475569;
        cursor: pointer;
        font-size: 13px;
        font-weight: 700;
      }

      .ccheck-tab.ccheck-tab-active {
        border-color: #ff9800;
        background: #ffffff;
        color: #172033;
        box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
      }

      .ccheck-view[hidden] {
        display: none !important;
      }

      .ccheck-btn {
        height: 34px;
        border: 1px solid #d4dae6;
        border-radius: 6px;
        background: #ffffff;
        color: #172033;
        cursor: pointer;
        font-size: 13px;
      }

      .ccheck-btn-primary {
        border-color: #ff9800;
        background: #ff9800;
        color: #ffffff;
        font-weight: 700;
      }

      .ccheck-btn:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }

      .ccheck-settings {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }

      .ccheck-field {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 0;
        padding: 7px 8px;
        background: #f8fafc;
        border: 1px solid #edf1f7;
        border-radius: 6px;
      }

      .ccheck-field input,
      .ccheck-field select {
        width: 54px;
        height: 24px;
        box-sizing: border-box;
        border: 1px solid #cbd5e1;
        border-radius: 5px;
        text-align: center;
        font: inherit;
      }

      .ccheck-field select {
        width: 64px;
        background: #ffffff;
      }

      .ccheck-field-check {
        justify-content: flex-start;
      }

      .ccheck-field-check input {
        width: auto;
        height: auto;
      }

      .ccheck-status {
        min-height: 32px;
        max-height: 120px;
        overflow-y: auto;
        overflow-x: hidden;
        box-sizing: border-box;
        flex: 0 0 auto;
        padding: 7px 8px;
        margin: 0 0 4px;
        border-radius: 6px;
        background: #f8fafc;
        color: #475569;
        font-size: 12px;
        line-height: 1.45;
        word-break: break-word;
        overflow-wrap: anywhere;
        white-space: pre-line;
      }

      .ccheck-summary {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
      }

      .ccheck-stat {
        padding: 8px;
        background: #f8fafc;
        border: 1px solid #edf1f7;
        border-radius: 6px;
      }

      .ccheck-stat strong {
        display: block;
        font-size: 18px;
        line-height: 1.2;
      }

      .ccheck-commute-query {
        margin-top: 8px;
        padding: 10px;
        background: #fffaf2;
        border: 1px solid #fed7aa;
        border-radius: 6px;
      }

      .ccheck-commute-tools {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .ccheck-commute-field-date {
        grid-column: 1 / -1;
        align-items: flex-start;
      }

      .ccheck-commute-date-options {
        display: flex;
        flex: 1 1 auto;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 6px;
        max-height: 86px;
        overflow: auto;
      }

      .ccheck-commute-date-option {
        min-width: 52px;
        height: 28px;
        padding: 0 9px;
        border: 1px solid #fdba74;
        border-radius: 999px;
        background: #ffffff;
        color: #9a3412;
        cursor: pointer;
        font: inherit;
      }

      .ccheck-commute-date-option.is-selected {
        border-color: #f97316;
        background: #f97316;
        color: #ffffff;
        font-weight: 700;
      }

      .ccheck-commute-field-campus select {
        width: 112px;
        max-width: 100%;
      }

      .ccheck-commute-actions {
        display: grid;
        grid-template-columns: 1fr 2fr;
        gap: 8px;
        margin-top: 8px;
      }

      .ccheck-commute-results {
        margin-top: 8px;
      }

      .ccheck-commute-results[hidden],
      .ccheck-list[hidden] {
        display: none;
      }

      .ccheck-commute-summary {
        margin-bottom: 7px;
        color: #9a3412;
        font-weight: 700;
      }

      .ccheck-commute-card {
        margin-top: 7px;
        padding: 8px;
        background: #ffffff;
        border: 1px solid #fdba74;
        border-left: 4px solid #f97316;
        border-radius: 6px;
      }

      .ccheck-commute-card strong,
      .ccheck-commute-card small {
        display: block;
      }

      .ccheck-commute-card small {
        margin-top: 2px;
        color: #475569;
      }

      .ccheck-commute-locate {
        margin-top: 7px;
        height: 28px;
        padding: 0 10px;
        border: 1px solid #f97316;
        border-radius: 5px;
        background: #ffffff;
        color: #c2410c;
        cursor: pointer;
      }

      .ccheck-list {
        overflow: auto;
        max-height: 44vh;
        border-top: 1px solid #edf1f7;
        padding-top: 8px;
      }

      .ccheck-empty {
        padding: 18px 10px;
        color: #64748b;
        text-align: center;
        background: #f8fafc;
        border: 1px dashed #dbe3ef;
        border-radius: 6px;
      }

      .ccheck-card {
        margin-bottom: 8px;
        padding: 9px;
        border: 1px solid #fecaca;
        border-left: 4px solid #ef4444;
        border-radius: 6px;
        background: #fff7f7;
      }

      .ccheck-card-title {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
        font-weight: 700;
      }

      .ccheck-card small {
        display: block;
        color: #475569;
      }

      .ccheck-locate {
        margin-top: 8px;
        height: 28px;
        padding: 0 10px;
        border: 1px solid #ef4444;
        border-radius: 5px;
        background: #ffffff;
        color: #b91c1c;
        cursor: pointer;
      }

      .ccheck-unknown {
        margin-top: 8px;
        padding: 8px;
        color: #92400e;
        background: #fffbeb;
        border: 1px solid #fde68a;
        border-radius: 6px;
      }

      .ccheck-supervisor-warning-list {
        max-height: 150px;
        overflow: auto;
        text-align: left;
      }

      .ccheck-supervisor-warning-list strong {
        display: block;
        margin-bottom: 4px;
      }

      .ccheck-meeting {
        padding: 10px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
      }

      .ccheck-section-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
        font-weight: 700;
      }

      .ccheck-meeting-tools {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }

      .ccheck-date-range-row {
        grid-column: 1 / -1;
        position: relative;
      }

      .ccheck-date-range-trigger {
        width: 100%;
        justify-content: flex-start;
        min-height: 31px;
        background: #ffffff;
        color: #0f172a;
        border-color: #cbd5e1;
        font-weight: 500;
      }

      .ccheck-date-range-trigger[data-empty="true"] {
        color: #64748b;
      }

      .ccheck-date-picker {
        position: absolute;
        z-index: 2147483647;
        left: 0;
        top: calc(100% + 6px);
        width: min(100%, 292px);
        padding: 8px;
        background: #ffffff;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        box-shadow: 0 12px 28px rgba(15, 23, 42, 0.18);
      }

      .ccheck-date-picker-head {
        display: grid;
        grid-template-columns: 28px 28px 1fr 28px 28px;
        gap: 6px;
        align-items: center;
        margin-bottom: 7px;
      }

      .ccheck-date-picker-title {
        text-align: center;
        font-weight: 700;
      }

      .ccheck-date-picker-nav,
      .ccheck-date-day {
        border: 1px solid #e2e8f0;
        background: #f8fafc;
        color: #0f172a;
        border-radius: 5px;
        cursor: pointer;
      }

      .ccheck-date-picker-nav {
        width: 28px;
        height: 28px;
      }

      .ccheck-date-grid {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 4px;
      }

      .ccheck-date-picker-hint {
        margin-bottom: 7px;
        color: #475569;
        font-size: 12px;
      }

      .ccheck-date-weekday {
        text-align: center;
        color: #64748b;
        font-size: 11px;
      }

      .ccheck-date-day {
        height: 27px;
        padding: 0;
        font-size: 12px;
      }

      .ccheck-date-day:hover {
        border-color: #2563eb;
      }

      .ccheck-date-day.is-empty {
        visibility: hidden;
      }

      .ccheck-date-day.is-selected {
        background: #2563eb;
        border-color: #2563eb;
        color: #ffffff;
      }

      .ccheck-date-day.is-in-range {
        background: #dbeafe;
        border-color: #93c5fd;
        color: #1e3a8a;
      }

      .ccheck-date-picker-foot {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        margin-top: 8px;
      }

      .ccheck-meeting-quick {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: end;
        margin-bottom: 8px;
      }

      .ccheck-field-teacher-query input {
        width: 100%;
        min-width: 0;
      }

      .ccheck-field-date input {
        width: 124px;
      }

      .ccheck-field-duration input {
        width: 58px;
      }

      .ccheck-field-file {
        grid-column: 1 / -1;
        align-items: flex-start;
        flex-direction: column;
      }

      .ccheck-field-file input {
        width: 100%;
        height: auto;
        text-align: left;
      }

      .ccheck-supervisor-list {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        max-height: 156px;
        margin-top: 8px;
        overflow: auto;
      }

      .ccheck-supervisor-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 8px;
      }

      .ccheck-supervisor-pill {
        padding: 3px 6px;
        border-radius: 999px;
        background: #e0f2fe;
        color: #075985;
        font-size: 12px;
      }

      .ccheck-rules {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .ccheck-rule-card {
        padding: 8px;
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
      }

      .ccheck-rule-title {
        margin-bottom: 6px;
        color: #172033;
        font-weight: 800;
      }

      .ccheck-rule-table {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 5px 8px;
      }

      .ccheck-rule-row {
        display: contents;
      }

      .ccheck-rule-label {
        min-width: 0;
        color: #475569;
      }

      .ccheck-rule-value {
        min-width: 0;
        color: #172033;
        font-weight: 700;
        text-align: left;
        word-break: break-word;
      }

      .ccheck-color-rule {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }

      .ccheck-color-swatch {
        flex: 0 0 auto;
        width: 12px;
        height: 12px;
        border: 1px solid rgba(15, 23, 42, 0.22);
        border-radius: 3px;
      }

      .ccheck-rule-note {
        margin-top: 6px;
        color: #64748b;
        font-size: 12px;
      }

      .ccheck-meeting-actions {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
        margin-top: 8px;
      }

      .ccheck-teacher-list {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        max-height: 132px;
        margin-top: 8px;
        overflow: auto;
      }

      .ccheck-teacher-option {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        padding: 6px 7px;
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 5px;
      }

      .ccheck-teacher-option input {
        flex: 0 0 auto;
      }

      .ccheck-teacher-option span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .ccheck-meeting-results {
        margin-top: 8px;
      }

      .ccheck-slot-card {
        margin-top: 7px;
        padding: 8px;
        background: #ffffff;
        border: 1px solid #bbf7d0;
        border-left: 4px solid #22c55e;
        border-radius: 6px;
      }

      .ccheck-slot-title {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        font-weight: 700;
      }

      .ccheck-slot-date {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }

      .ccheck-slot-shifts {
        margin-top: 2px;
        color: #15803d;
        font-size: 11px;
        font-weight: 700;
        line-height: 1.25;
      }

      .ccheck-slot-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        margin-top: 7px;
      }

      .ccheck-draft-modal {
        position: fixed;
        z-index: 1000000;
        right: 16px;
        top: 86px;
        width: 370px;
        max-height: calc(100vh - 108px);
        display: flex;
        flex-direction: column;
        gap: 10px;
        box-sizing: border-box;
        padding: 14px;
        color: #172033;
        background: rgba(255, 255, 255, 0.98);
        border: 1px solid rgba(17, 24, 39, 0.14);
        border-radius: 8px;
        box-shadow: 0 22px 56px rgba(15, 23, 42, 0.24);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        font-size: 13px;
        line-height: 1.45;
      }

      .ccheck-draft-modal-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        font-weight: 700;
      }

      .ccheck-draft-close {
        width: 28px;
        height: 28px;
        border: 1px solid #d5dae3;
        border-radius: 6px;
        background: #ffffff;
        color: #475569;
        cursor: pointer;
      }

      .ccheck-draft-options {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        max-height: 260px;
        overflow: auto;
      }

      .ccheck-draft-option-full {
        grid-column: 1 / -1;
      }

      .ccheck-draft-option {
        min-height: 34px;
        border: 1px solid #d4dae6;
        border-radius: 6px;
        background: #ffffff;
        color: #172033;
        cursor: pointer;
        font-weight: 700;
      }

      .ccheck-draft-option:hover {
        border-color: #ff9800;
        background: #fff7ed;
      }

      .ccheck-draft-name-field {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 10px 11px;
        color: #9a5b00;
        font-weight: 800;
        background: #fff8ef;
        border: 1px solid #ffd8a8;
        border-radius: 8px;
      }

      .ccheck-draft-name-field .ccheck-draft-name-label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 800;
      }

      .ccheck-draft-name-field .ccheck-draft-name-label::before {
        content: "*";
        color: #ef4444;
      }

      .ccheck-draft-name-field .ccheck-draft-name-hint {
        color: #b45309;
        font-size: 12px;
        font-weight: 600;
      }

      .ccheck-draft-name-field input {
        width: 100%;
        height: 34px;
        box-sizing: border-box;
        padding: 0 10px;
        border: 1px solid #f59e0b;
        border-radius: 6px;
        color: #172033;
        font: inherit;
        font-weight: 400;
        background: #ffffff;
      }

      .ccheck-draft-note {
        position: fixed;
        z-index: 999999;
        right: 16px;
        top: 86px;
        width: 320px;
        box-sizing: border-box;
        padding: 0;
        color: #172033;
        background: rgba(255, 255, 255, 0.97);
        border: 1px solid rgba(17, 24, 39, 0.14);
        border-radius: 8px;
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        font-size: 13px;
        line-height: 1.45;
        cursor: move;
      }

      .ccheck-draft-note.ccheck-draft-note-dragging {
        user-select: none;
      }

      .ccheck-draft-note-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-height: 38px;
        padding: 10px 12px;
        box-sizing: border-box;
        cursor: move;
        user-select: none;
      }

      .ccheck-draft-note-title {
        font-weight: 700;
      }

      .ccheck-draft-note-toggle {
        width: 26px;
        height: 26px;
        border: 1px solid #d5dae3;
        border-radius: 6px;
        background: #ffffff;
        color: #475569;
        cursor: pointer;
        line-height: 1;
      }

      .ccheck-draft-note button,
      .ccheck-draft-note a,
      .ccheck-draft-note label {
        cursor: pointer;
      }

      .ccheck-draft-note input,
      .ccheck-draft-note select,
      .ccheck-draft-note textarea {
        cursor: text;
      }

      .ccheck-draft-note-body {
        padding: 0 12px 12px;
      }

      .ccheck-draft-note small {
        display: block;
        margin-top: 6px;
        color: #64748b;
      }

      .ccheck-draft-note-strong,
      .ccheck-draft-note-strong strong {
        color: #172033;
        font-weight: 700;
      }

      .ccheck-draft-note-name {
        margin: 6px 0 2px;
        padding: 6px 8px;
        border-radius: 6px;
        background: #fff7ed;
        color: #9a5b00;
        font-weight: 700;
      }

      .ccheck-draft-note-name-missing {
        color: #f59e0b;
      }

      .ccheck-draft-note.ccheck-draft-note-collapsed {
        width: auto;
        min-width: 150px;
      }

      .ccheck-draft-note.ccheck-draft-note-collapsed .ccheck-draft-note-body {
        display: none;
      }

      .ccheck-attendee-helper.ccheck-draft-note-collapsed {
        width: auto;
        min-width: 150px;
      }

      .ccheck-attendee-helper.ccheck-draft-note-collapsed .ccheck-draft-note-body {
        display: none;
      }

      .ccheck-attendee-helper {
        position: fixed;
        z-index: 999998;
        right: 16px;
        top: 248px;
        width: 320px;
        box-sizing: border-box;
        padding: 12px;
        color: #172033;
        background: rgba(255, 255, 255, 0.97);
        border: 1px solid rgba(17, 24, 39, 0.14);
        border-radius: 8px;
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.16);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        font-size: 13px;
        line-height: 1.45;
      }

      .ccheck-attendee-helper textarea {
        width: 100%;
        min-height: 96px;
        box-sizing: border-box;
        padding: 8px;
        border: 1px solid #d5dae3;
        border-radius: 6px;
        resize: vertical;
        font: inherit;
      }

      .ccheck-attendee-helper .ccheck-smart-meeting-textarea {
        min-height: 118px;
      }

      .ccheck-attendee-helper-section {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid #e2e8f0;
      }

      .ccheck-attendee-helper-section:first-child {
        margin-top: 0;
        padding-top: 0;
        border-top: 0;
      }

      .ccheck-attendee-helper-label {
        display: block;
        margin-bottom: 5px;
        color: #172033;
        font-weight: 700;
      }

      .ccheck-attendee-helper-actions {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }

      .ccheck-attendee-helper-result {
        margin-top: 8px;
        color: #64748b;
        font-size: 12px;
      }

      .ccheck-muted {
        display: block;
        margin-top: 4px;
        color: #64748b;
      }

      .ccheck-mark {
        outline: 3px solid #ef4444 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 5px rgba(239, 68, 68, 0.18) !important;
      }

      .ccheck-day-mark {
        outline: 3px solid rgba(239, 68, 68, 0.85) !important;
        outline-offset: -3px !important;
        box-shadow: inset 0 0 0 2px rgba(239, 68, 68, 0.22) !important;
      }

      .ccheck-meeting-mark {
        position: absolute;
        left: 4px;
        right: 4px;
        z-index: 5;
        pointer-events: none;
        border: 2px solid #22c55e;
        border-radius: 4px;
        background: rgba(34, 197, 94, 0.12);
        box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.16);
      }
    `;
    document.head.appendChild(style);
  }

  function installNetworkCapture() {
    if (window.__ccheckNetworkCaptureInstalled) return;
    window.__ccheckNetworkCaptureInstalled = true;

    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = async function ccheckFetch(input, init) {
        const startedAt = Date.now();
        const url = getRequestUrl(input);
        const method = getRequestMethod(input, init);

        try {
          const response = await originalFetch.apply(this, arguments);
          if (shouldCaptureNetworkBody(url)) {
            response.clone().text()
              .then((body) => pushNetworkLog({
                type: 'fetch',
                method,
                url,
                status: response.status,
                durationMs: Date.now() - startedAt,
                body
              }))
              .catch(() => pushNetworkLog({
                type: 'fetch',
                method,
                url,
                status: response.status,
                durationMs: Date.now() - startedAt,
                body: ''
              }));
          } else {
            pushNetworkLog({
              type: 'fetch',
              method,
              url,
              status: response.status,
              durationMs: Date.now() - startedAt,
              body: '',
              skippedBody: true
            });
          }
          return response;
        } catch (error) {
          pushNetworkLog({
            type: 'fetch',
            method,
            url,
            status: null,
            durationMs: Date.now() - startedAt,
            error: String(error && error.message || error)
          });
          throw error;
        }
      };
    }

    const xhrOpen = XMLHttpRequest.prototype.open;
    const xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function ccheckXhrOpen(method, url) {
      this.__ccheckRequest = {
        method: method || 'GET',
        url: String(url || ''),
        startedAt: 0
      };
      return xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function ccheckXhrSend() {
      const request = this.__ccheckRequest || {};
      request.startedAt = Date.now();
      this.addEventListener('loadend', () => {
        let body = '';
        const shouldReadBody = shouldCaptureNetworkBody(request.url);
        if (shouldReadBody) {
          try {
            body = typeof this.responseText === 'string' ? this.responseText : '';
          } catch (_) {
            body = '';
          }
        }
        pushNetworkLog({
          type: 'xhr',
          method: request.method || 'GET',
          url: request.url || '',
          status: this.status,
          durationMs: Date.now() - request.startedAt,
          body,
          skippedBody: !shouldReadBody
        });
      });
      return xhrSend.apply(this, arguments);
    };
  }

  function shouldCaptureNetworkBody(url) {
    return /TeacherCourseSchedule\/diagram/i.test(String(url || ''));
  }

  function getRequestUrl(input) {
    if (typeof input === 'string') return input;
    if (input && input.url) return String(input.url);
    return '';
  }

  function getRequestMethod(input, init) {
    if (init && init.method) return String(init.method).toUpperCase();
    if (input && input.method) return String(input.method).toUpperCase();
    return 'GET';
  }

  function pushNetworkLog(input) {
    const body = String(input.body || '');
    const url = String(input.url || '');
    checkMeetingSubmitSuccess(input, body, url);
    rememberDiagramData(url, body);
    const relevant = hasRestText(body)
      || /schedule|teacher|course|lesson|class|calendar|rest|day/i.test(url)
      || /课程|老师|教师|休息|休假|请假|调休|换休|校区/.test(body);

    state.networkLogs.push({
      type: input.type,
      method: input.method,
      url,
      status: input.status,
      durationMs: input.durationMs,
      relevant,
      containsRest: hasRestText(body),
      bodyLength: body.length,
      bodySnippet: relevant ? body.slice(0, 24000) : body.slice(0, 1200),
      error: input.error || '',
      skippedBody: Boolean(input.skippedBody)
    });

    if (state.networkLogs.length > 40) {
      state.networkLogs.splice(0, state.networkLogs.length - 40);
    }
  }

  function rememberDiagramData(url, body) {
    if (!/TeacherCourseSchedule\/diagram/i.test(String(url || ''))) return;
    try {
      const payload = JSON.parse(body);
      const data = payload && payload.data;
      if (!data || !Array.isArray(data.lst_teacher)) return;
      state.latestDiagramData = {
        receivedAt: new Date().toISOString(),
        dates: Array.isArray(data.dates) ? data.dates : [],
        teachers: data.lst_teacher
      };
    } catch (_) {
      // Ignore non-JSON or partial diagnostic responses.
    }
  }

  function injectPanel() {
    if (document.getElementById('ccheck-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'ccheck-panel';
    panel.innerHTML = `
      <div class="ccheck-head">
        <div class="ccheck-title">校区通勤核对 <span class="ccheck-version">v${SCRIPT_VERSION}</span></div>
        <button class="ccheck-toggle" type="button" title="收起/展开">-</button>
      </div>
      <div class="ccheck-body">
        <div class="ccheck-tabs">
          <button class="ccheck-tab ccheck-tab-active" type="button" data-view="audit">核对课表</button>
          <button class="ccheck-tab" type="button" data-view="meeting">排会议</button>
          <button class="ccheck-tab" type="button" data-view="supervisor">督导排班</button>
        </div>
        <div class="ccheck-status" id="ccheck-status"></div>
        <div class="ccheck-view" id="ccheck-view-audit">
          <div class="ccheck-actions">
            <button class="ccheck-btn ccheck-btn-primary" type="button" data-action="scan-all">异常扫描</button>
            <button class="ccheck-btn" type="button" data-action="scan-visible">扫当前可见</button>
            <button class="ccheck-btn" type="button" data-action="clear">清除标记</button>
            <button class="ccheck-btn" type="button" data-action="export">导出CSV</button>
          </div>
          <div class="ccheck-settings">
            <label class="ccheck-field">紧邻分钟 <input id="ccheck-adjacent" type="number" min="0" max="60" step="5" value="${CONFIG.defaultAdjacentGapMinutes}"></label>
            <label class="ccheck-field">拥挤缓冲 <input id="ccheck-buffer" type="number" min="0" max="180" step="5" value="${CONFIG.defaultOnlinePressureBufferMinutes}"></label>
          </div>
          <div class="ccheck-summary" id="ccheck-summary">
            <div class="ccheck-stat"><strong>0</strong>色块</div>
            <div class="ccheck-stat"><strong>0</strong>异常</div>
            <div class="ccheck-stat"><strong>0</strong>未知色</div>
          </div>
          <div class="ccheck-commute-query">
            <div class="ccheck-section-title">跑校区查询</div>
            <div class="ccheck-commute-tools">
              <div class="ccheck-field ccheck-commute-field-date">
                <span>日期</span>
                <div class="ccheck-commute-date-options" id="ccheck-commute-dates"></div>
              </div>
              <label class="ccheck-field ccheck-commute-field-campus">出发 <select id="ccheck-commute-from">${renderCommuteCampusOptions()}</select></label>
              <label class="ccheck-field ccheck-commute-field-campus">到达 <select id="ccheck-commute-to">${renderCommuteCampusOptions()}</select></label>
            </div>
            <div class="ccheck-commute-actions">
              <button class="ccheck-btn" type="button" data-action="commute-swap">交换方向</button>
              <button class="ccheck-btn ccheck-btn-primary" type="button" data-action="commute-query">查询跑校区</button>
            </div>
            <div class="ccheck-commute-results" id="ccheck-commute-results" hidden>
              <div class="ccheck-empty">选择教师课表日期后，可直接查询跑校区。</div>
            </div>
          </div>
          <div class="ccheck-list" id="ccheck-list">
            <div class="ccheck-empty">还没有扫描结果。</div>
          </div>
        </div>
        <div class="ccheck-view" id="ccheck-view-meeting" hidden>
          <div class="ccheck-actions">
            <button class="ccheck-btn ccheck-btn-primary" type="button" data-action="scan-all">全表扫描</button>
            <button class="ccheck-btn" type="button" data-action="scan-visible">扫当前可见</button>
            <button class="ccheck-btn" type="button" data-action="clear-data">清空数据</button>
            <button class="ccheck-btn" type="button" data-action="clear">清除标记</button>
          </div>
          <div class="ccheck-meeting">
            <div class="ccheck-section-title">共同空档</div>
            <div class="ccheck-meeting-quick">
              <label class="ccheck-field ccheck-field-teacher-query">人员 <input id="ccheck-meeting-teacher-query" type="text" placeholder="老师、督导姓名"></label>
              <button class="ccheck-btn ccheck-btn-primary" type="button" data-action="meeting-query">查询</button>
            </div>
            <div class="ccheck-meeting-tools">
              <div class="ccheck-field ccheck-date-range-row">
                <span>日期范围</span>
                <button class="ccheck-btn ccheck-date-range-trigger" type="button" data-action="meeting-date-range" data-empty="true">选择日期范围</button>
                <div class="ccheck-date-picker" id="ccheck-meeting-date-picker" hidden></div>
              </div>
              <label class="ccheck-field ccheck-field-check"><input id="ccheck-meeting-include-supervisors" type="checkbox" checked> 包含督导</label>
              <label class="ccheck-field ccheck-field-date">开始 <input id="ccheck-meeting-start" type="date"></label>
              <label class="ccheck-field ccheck-field-date">结束 <input id="ccheck-meeting-end" type="date"></label>
              <label class="ccheck-field ccheck-field-duration">时长 <input id="ccheck-meeting-duration" type="number" min="5" max="240" step="5" value="${CONFIG.defaultMeetingDurationMinutes}"></label>
              <label class="ccheck-field">范围 <span id="ccheck-meeting-range">09:00-18:10</span></label>
              <label class="ccheck-field">形式 <select id="ccheck-meeting-mode"><option value="any">都可以</option><option value="offline">线下</option><option value="online">线上</option></select></label>
              <label class="ccheck-field ccheck-field-check"><input id="ccheck-meeting-evening" type="checkbox"> 晚间会议</label>
            </div>
            <div class="ccheck-meeting-actions">
              <button class="ccheck-btn" type="button" data-action="meeting-select-all">全选老师</button>
              <button class="ccheck-btn" type="button" data-action="meeting-clear">清空选择</button>
              <button class="ccheck-btn" type="button" data-action="clear-data">清空数据</button>
              <button class="ccheck-btn ccheck-btn-primary" type="button" data-action="meeting-find">查找空档</button>
            </div>
            <div class="ccheck-teacher-list" id="ccheck-meeting-teachers">
              <div class="ccheck-empty">扫描后显示老师。</div>
            </div>
            <small class="ccheck-muted">不计算：12:20-13:15；上一节课/会议结束后空 5 分钟。</small>
            <div class="ccheck-meeting-results" id="ccheck-meeting-results"></div>
          </div>
        </div>
        <div class="ccheck-view" id="ccheck-view-supervisor" hidden>
          <div class="ccheck-meeting">
            <div class="ccheck-section-title">督导排班表导入</div>
            <div class="ccheck-meeting-tools">
              <label class="ccheck-field ccheck-field-file">石墨 XLS/XLSX
                <input id="ccheck-supervisor-file" type="file" accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
              </label>
            </div>
            <div class="ccheck-supervisor-list" id="ccheck-supervisor-list">
              <div class="ccheck-empty">上传督导 XLS/XLSX 后显示名单。</div>
            </div>
            <small class="ccheck-muted">这里仅导入排班表。回到“排会议”时“包含督导”默认已勾选，会从同一人员名单里自动识别督导并读取排班。</small>
            <div class="ccheck-supervisor-meta" id="ccheck-supervisor-meta"></div>
            <div class="ccheck-meeting-results" id="ccheck-supervisor-results"></div>
          </div>
        </div>
        <div class="ccheck-view" id="ccheck-view-rules" hidden>
          ${renderRulesOverviewHtml()}
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    setPanelCollapsed(panel, true);
    restorePanelPosition(panel);
    enablePanelDragging(panel);

    panel.querySelector('.ccheck-toggle').addEventListener('click', () => {
      setPanelCollapsed(panel, !panel.classList.contains('ccheck-collapsed'));
      if (panel.dataset.ccheckMoved === 'true') {
        requestAnimationFrame(() => clampPanelPosition(panel));
      }
    });

    panel.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      if (action === 'scan-all') {
        const scanMode = button.closest('#ccheck-view-audit') ? 'audit' : 'full';
        scanAll({ mode: scanMode });
      }
      if (action === 'scan-visible') scanVisible();
      if (action === 'clear') clearMarkers();
      if (action === 'clear-data') clearCurrentData();
      if (action === 'export') exportCsv();
      if (action === 'commute-swap') swapCommuteCampuses();
      if (action === 'commute-query') queryCampusCommutes();
      if (action === 'commute-date-pick') selectCommuteDate(button.dataset.date);
      if (action === 'debug-rest') debugRest();
      if (action === 'export-debug') exportDebugData();
      if (action === 'meeting-select-all') selectAllMeetingTeachers();
      if (action === 'meeting-clear') clearMeetingTeacherSelection();
      if (action === 'meeting-query') queryMeetingSlotsByName();
      if (action === 'meeting-find') {
        const skipSystemDateSearch = button.dataset.skipSystemDateSearch === 'true';
        delete button.dataset.skipSystemDateSearch;
        findMeetingSlots({ skipSystemDateSearch });
      }
      if (action === 'meeting-date-range') toggleMeetingDateRangePicker();
      if (action.startsWith('meeting-date-')) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (action === 'meeting-date-prev') moveMeetingDatePickerMonth(-1);
      if (action === 'meeting-date-next') moveMeetingDatePickerMonth(1);
      if (action === 'meeting-date-prev-year') moveMeetingDatePickerMonth(-12);
      if (action === 'meeting-date-next-year') moveMeetingDatePickerMonth(12);
      if (action === 'meeting-date-clear') clearMeetingDateRangePicker();
      if (action === 'meeting-date-close') closeMeetingDateRangePicker();
      if (action === 'meeting-date-pick') pickMeetingDate(button.dataset.date);
      if (action === 'supervisor-select-all') selectAllSupervisors();
      if (action === 'supervisor-clear') clearSupervisorSelection();
      if (action === 'supervisor-find') findSupervisorSlots();
    });

    panel.addEventListener('change', (event) => {
      const checkbox = event.target.closest('input[data-meeting-teacher]');
      if (checkbox) {
        updateMeetingTeacherSelection(checkbox.value, checkbox.checked);
        return;
      }
      const supervisorCheckbox = event.target.closest('input[data-supervisor-name]');
      if (supervisorCheckbox) {
        updateSupervisorSelection(supervisorCheckbox.value, supervisorCheckbox.checked);
        return;
      }
      if (event.target && event.target.id === 'ccheck-supervisor-file') {
        handleSupervisorFileChange(event.target);
        return;
      }
      if (event.target && event.target.id === 'ccheck-meeting-evening') {
        updateMeetingRangeLabel();
      }
      if (event.target && (event.target.id === 'ccheck-meeting-start' || event.target.id === 'ccheck-meeting-end')) {
        updateMeetingDateRangeTrigger();
      }
    });

    panel.addEventListener('click', (event) => {
      const tab = event.target.closest('button[data-view]');
      if (!tab) return;
      switchView(tab.dataset.view);
    });

    document.addEventListener('click', (event) => {
      const picker = document.getElementById('ccheck-meeting-date-picker');
      if (!picker || picker.hidden) return;
      if (event.target.closest('#ccheck-meeting-date-picker, button[data-action="meeting-date-range"]')) return;
      setTimeout(() => {
        const currentPicker = document.getElementById('ccheck-meeting-date-picker');
        if (currentPicker && !currentPicker.hidden) closeMeetingDateRangePicker();
      }, 0);
    });

    updateMeetingDateRangeTrigger();
    updateMeetingRangeLabel();
    refreshCommuteDateOptions();
    installCommuteDateRangeSync();
    const restoredSupervisorWorkbook = restoreSupervisorWorkbookFromStorage();
    renderSupervisorPlanner();
    if (restoredSupervisorWorkbook && state.supervisorPlanner.warnings.length) {
      renderSupervisorMessage(`已恢复督导排班缓存，有 ${state.supervisorPlanner.warnings.length} 条排班提醒，明细见下方。`, {
        includeSupervisorWarnings: true
      });
    }
  }

  function renderRulesOverviewHtml() {
    const campusRows = Object.entries(CONFIG.campusByColor)
      .concat(Object.entries(CONFIG.onlineByColor))
      .map(([hex, meaning]) => renderRulesTableRow(
        `<span class="ccheck-color-rule"><span class="ccheck-color-swatch" style="background:${escapeHtml(hex)}"></span>${escapeHtml(hex)}</span>`,
        escapeHtml(meaning)
      ))
      .join('');

    const commuteRows = Object.entries(CONFIG.commuteRules)
      .map(([pair, minutes]) => renderRulesTableRow(escapeHtml(pair.replace('|', ' - ')), `${minutes} 分钟`))
      .join('');

    const excludedRanges = CONFIG.meetingExcludedRanges
      .map(formatRulesTimeRange)
      .join('、') || '无';

    const supervisorRows = Object.entries(CONFIG.supervisorShiftWindows)
      .map(([code, range]) => renderRulesTableRow(`${code} 班`, formatRulesTimeRange(range)))
      .join('');

    return `
      <div class="ccheck-rules">
        ${renderRulesCard('版本与状态', `
          <div class="ccheck-rule-table">
            ${renderRulesTableRow('当前版本', `v${SCRIPT_VERSION}`)}
            ${renderRulesTableRow('适用范围', '小蚁全站待命，按页面显示对应助手')}
            ${renderRulesTableRow('督导排班', '正式功能，排会议默认包含督导')}
          </div>
        `)}
        ${renderRulesCard('校区颜色', `
          <div class="ccheck-rule-table">${campusRows}</div>
        `)}
        ${renderRulesCard('通勤时间', `
          <div class="ccheck-rule-table">${commuteRows}</div>
          <div class="ccheck-rule-note">任一方为下沙校区或小和山校区且未单列时，按 90 分钟；同校区按 0 分钟。</div>
        `)}
        ${renderRulesCard('会议规则', `
          <div class="ccheck-rule-table">
            ${renderRulesTableRow('默认时长', `${CONFIG.defaultMeetingDurationMinutes} 分钟`)}
            ${renderRulesTableRow('搜索步长', `${CONFIG.meetingSearchStepMinutes} 分钟`)}
            ${renderRulesTableRow('老师白天范围', `${formatMinutes(CONFIG.meetingWindowStartMinutes)}-${formatMinutes(CONFIG.meetingWindowEndMinutes)}`)}
            ${renderRulesTableRow('晚间会议范围', `${formatMinutes(CONFIG.eveningMeetingWindowStartMinutes)}-${formatMinutes(CONFIG.eveningMeetingWindowEndMinutes)}`)}
            ${renderRulesTableRow('课/会议缓冲', `${CONFIG.meetingEventBufferMinutes} 分钟`)}
            ${renderRulesTableRow('午间排除', escapeHtml(excludedRanges))}
          </div>
        `)}
        ${renderRulesCard('督导规则', `
          <div class="ccheck-rule-table">
            ${renderRulesTableRow('可排范围', `${formatMinutes(CONFIG.supervisorWindowStartMinutes)}-${formatMinutes(CONFIG.supervisorWindowEndMinutes)}`)}
            ${supervisorRows}
            ${renderRulesTableRow('F 班', '覆盖 N/A 可选范围')}
            ${renderRulesTableRow('红字/休假', '按不可排处理，可识别具体时段')}
          </div>
        `)}
      </div>
    `;
  }

  function renderRulesCard(title, contentHtml) {
    return `
      <div class="ccheck-rule-card">
        <div class="ccheck-rule-title">${escapeHtml(title)}</div>
        ${contentHtml}
      </div>
    `;
  }

  function renderRulesTableRow(labelHtml, valueHtml) {
    return `
      <div class="ccheck-rule-row">
        <div class="ccheck-rule-label">${labelHtml}</div>
        <div class="ccheck-rule-value">${valueHtml}</div>
      </div>
    `;
  }

  function formatRulesTimeRange(range) {
    return `${formatMinutes(range.startMinutes)}-${formatMinutes(range.endMinutes)}`;
  }

  function setPanelCollapsed(panel, collapsed) {
    if (!panel) return;
    panel.classList.toggle('ccheck-collapsed', collapsed);
    const toggle = panel.querySelector('.ccheck-toggle');
    if (toggle) toggle.textContent = collapsed ? '+' : '-';
  }

  function enablePanelDragging(panel) {
    const handle = panel.querySelector('.ccheck-head');
    if (!handle) return;
    let dragState = null;

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target.closest('button, input, select, textarea, a, label')) return;
      const rect = panel.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top
      };
      panel.classList.add('ccheck-dragging');
      setPanelPosition(panel, rect.left, rect.top);
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener('pointermove', (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      setPanelPosition(
        panel,
        dragState.startLeft + event.clientX - dragState.startX,
        dragState.startTop + event.clientY - dragState.startY
      );
    });

    const finishDrag = (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      handle.releasePointerCapture?.(event.pointerId);
      dragState = null;
      panel.classList.remove('ccheck-dragging');
      savePanelPosition(panel);
    };

    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
    window.addEventListener('resize', () => {
      if (panel.dataset.ccheckMoved !== 'true') return;
      clampPanelPosition(panel);
      savePanelPosition(panel);
    });
  }

  function restorePanelPosition(panel) {
    const position = readPanelPosition();
    if (!position) return;
    setPanelPosition(panel, position.left, position.top);
  }

  function readPanelPosition() {
    try {
      const raw = localStorage.getItem(PANEL_POSITION_STORAGE_KEY);
      if (!raw) return null;
      const position = JSON.parse(raw);
      if (!Number.isFinite(position?.left) || !Number.isFinite(position?.top)) return null;
      return position;
    } catch (_) {
      return null;
    }
  }

  function savePanelPosition(panel) {
    try {
      const rect = panel.getBoundingClientRect();
      localStorage.setItem(PANEL_POSITION_STORAGE_KEY, JSON.stringify({
        left: Math.round(rect.left),
        top: Math.round(rect.top)
      }));
    } catch (_) {
      // Position persistence is optional; dragging still works if storage is blocked.
    }
  }

  function setPanelPosition(panel, left, top) {
    const position = getClampedPanelPosition(panel, left, top);
    panel.style.left = `${position.left}px`;
    panel.style.top = `${position.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.dataset.ccheckMoved = 'true';
  }

  function clampPanelPosition(panel) {
    const rect = panel.getBoundingClientRect();
    setPanelPosition(panel, rect.left, rect.top);
  }

  function getClampedPanelPosition(panel, left, top) {
    const margin = 8;
    const rect = panel.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    return {
      left: Math.round(Math.min(Math.max(left, margin), maxLeft)),
      top: Math.round(Math.min(Math.max(top, margin), maxTop))
    };
  }

  function enableFloatingElementDragging(element, options = {}) {
    const selector = options.handleSelector || '';
    const handle = selector && element?.matches?.(selector)
      ? element
      : element?.querySelector?.(selector);
    if (!element || !handle || handle.dataset.ccheckFloatingDragHandle === 'true') return;
    element.dataset.ccheckFloatingDrag = 'true';
    handle.dataset.ccheckFloatingDragHandle = 'true';
    let dragState = null;

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target.closest('button, input, select, textarea, a, label')) return;
      const rect = element.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top
      };
      element.classList.add(options.draggingClass || 'ccheck-dragging');
      setFloatingElementPosition(element, rect.left, rect.top);
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener('pointermove', (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      setFloatingElementPosition(
        element,
        dragState.startLeft + event.clientX - dragState.startX,
        dragState.startTop + event.clientY - dragState.startY
      );
    });

    const finishDrag = (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      handle.releasePointerCapture?.(event.pointerId);
      dragState = null;
      element.classList.remove(options.draggingClass || 'ccheck-dragging');
      saveFloatingElementPosition(element, options.storageKey);
    };

    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
    window.addEventListener('resize', () => {
      if (element.dataset.ccheckMoved !== 'true') return;
      clampFloatingElementPosition(element, options.storageKey);
    });
  }

  function restoreDraftNotePosition(note) {
    const position = readFloatingElementPosition(DRAFT_NOTE_POSITION_STORAGE_KEY);
    if (!position) return;
    setFloatingElementPosition(note, position.left, position.top);
  }

  function restoreFloatingElementPosition(element, storageKey) {
    const position = readFloatingElementPosition(storageKey);
    if (!position) return;
    setFloatingElementPosition(element, position.left, position.top);
  }

  function readFloatingElementPosition(storageKey) {
    if (!storageKey) return null;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const position = JSON.parse(raw);
      if (!Number.isFinite(position?.left) || !Number.isFinite(position?.top)) return null;
      return position;
    } catch (_) {
      return null;
    }
  }

  function saveFloatingElementPosition(element, storageKey) {
    if (!storageKey) return;
    try {
      const rect = element.getBoundingClientRect();
      localStorage.setItem(storageKey, JSON.stringify({
        left: Math.round(rect.left),
        top: Math.round(rect.top)
      }));
    } catch (_) {
      // Position persistence is optional.
    }
  }

  function setFloatingElementPosition(element, left, top) {
    const position = getClampedFloatingElementPosition(element, left, top);
    element.style.left = `${position.left}px`;
    element.style.top = `${position.top}px`;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
    element.dataset.ccheckMoved = 'true';
  }

  function clampFloatingElementPosition(element, storageKey) {
    const rect = element.getBoundingClientRect();
    setFloatingElementPosition(element, rect.left, rect.top);
    saveFloatingElementPosition(element, storageKey);
  }

  function getClampedFloatingElementPosition(element, left, top) {
    const margin = 8;
    const rect = element.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    return {
      left: Math.round(Math.min(Math.max(left, margin), maxLeft)),
      top: Math.round(Math.min(Math.max(top, margin), maxTop))
    };
  }

  async function scanAll(options = {}) {
    if (state.isScanning) return;
    const scanMode = options.mode === 'audit' || options.mode === 'commute' ? options.mode : 'full';
    const scanLabel = scanMode === 'audit' ? '异常扫描' : (scanMode === 'commute' ? '跑校区扫描' : '全表扫描');
    state.isScanning = true;
    setButtonsDisabled(true);
    clearMarkers();
    setStatus(`${scanLabel}中，优先尝试接口数据。`);

    try {
      const interfaceEvents = collectEventsFromDiagramData();
      if (interfaceEvents.some((event) => event.hex)) {
        setStatus('接口数据已读取，正在合并页面全表的课程详情。');
        const pageEvents = await collectEventsWithCourseDetails(
          getScrollTop(findScrollContainer()),
          CONFIG.visibleDetailScanBudgetMs
        );
        const merged = mergeInterfaceEventsWithPageEvents(interfaceEvents, pageEvents);
        finishScan(merged.events, `${scanLabel}完成`);
        setStatus(`v${SCRIPT_VERSION} ${scanLabel}完成：识别 ${merged.events.filter((event) => event.hex).length} 个课程/占用，采用 ${merged.pageMatchedCount} 个页面色块，接口补充 ${merged.interfaceOnlyCount} 个事件。`);
        return true;
      }

      setStatus(`${scanLabel}接口数据不足，改用页面扫描；会临时滚动课表，结束后会回到原位置。`);
      const scroller = findScrollContainer();
      const oldTop = getScrollTop(scroller);
      const maxTop = getMaxScrollTop(scroller);
      const step = getScanStep(scroller);
      const positions = buildScanPositions(oldTop, maxTop, step);
      const eventMap = new Map();

      for (let index = 0; index < positions.length; index += 1) {
        setScrollTop(scroller, positions[index]);
        await sleep(CONFIG.scanPauseMs);
        const chunk = await collectEventsWithCourseDetails(positions[index], CONFIG.detailScanBudgetMs);
        chunk.forEach((event) => eventMap.set(event.key, event));
        if (index % 10 === 0 || index === positions.length - 1) {
          setStatus(`${scanLabel}中：${index + 1}/${positions.length}，已识别 ${eventMap.size} 个色块。`);
        }
      }

      setScrollTop(scroller, oldTop);
      await sleep(CONFIG.scanPauseMs);
      finishScan(Array.from(eventMap.values()), `${scanLabel}完成`);
      return true;
    } catch (error) {
      setStatus(`扫描失败：${error.message || error}`);
      return false;
    } finally {
      state.isScanning = false;
      setButtonsDisabled(false);
    }
  }

  async function scanVisible() {
    if (state.isScanning) return;
    state.isScanning = true;
    setButtonsDisabled(true);
    clearMarkers();
    setStatus('当前可见区域扫描中，正在读取课程详情。');

    try {
      finishScan(await collectEventsWithCourseDetails(getScrollTop(findScrollContainer()), CONFIG.visibleDetailScanBudgetMs), '当前可见区域扫描完成', {
        resetMeetingDates: true
      });
    } catch (error) {
      setStatus(`扫描失败：${error.message || error}`);
    } finally {
      state.isScanning = false;
      setButtonsDisabled(false);
    }
  }

  function debugRest() {
    const textMatches = collectVisibleRestTextMatches(document.body);
    const pseudoMatches = collectVisiblePseudoRestMatches(document.body);
    const matches = textMatches.concat(pseudoMatches);
    const events = collectEvents(getScrollTop(findScrollContainer()));
    const restEvents = events.filter(isRestDayEvent);
    const diagramRestEvents = restEvents.filter((event) => event.text.includes('接口休息日'));
    const list = document.getElementById('ccheck-list');

    setStatus(`v${SCRIPT_VERSION}：DOM休息 ${textMatches.length} 个，伪元素休息 ${pseudoMatches.length} 个，接口休息 ${diagramRestEvents.length} 个，休息标记 ${restEvents.length} 个。`);
    console.table(matches.map((item) => ({
      source: item.source,
      text: item.text,
      x: Math.round(item.rect.x),
      y: Math.round(item.rect.y),
      w: Math.round(item.rect.width),
      h: Math.round(item.rect.height),
      tag: item.element.tagName,
      className: item.element.className
    })));

    if (!matches.length && !restEvents.length) {
      list.innerHTML = '<div class="ccheck-empty">页面和接口里都没有找到休息标记。请点页面橙色“搜索”后再试。</div>';
      return;
    }

    const interfaceHtml = restEvents.map((event, index) => `
      <div class="ccheck-card">
        <div class="ccheck-card-title">
          <span>${index + 1}. 接口休息日</span>
          <span>${escapeHtml(event.date)}</span>
        </div>
        <small>${escapeHtml(event.teacher)}：${escapeHtml(event.text)}</small>
      </div>
    `).join('');

    const textHtml = matches.slice(0, 12).map((item, index) => `
      <div class="ccheck-card">
        <div class="ccheck-card-title">
          <span>${index + 1}. 休息文字</span>
          <span>x${Math.round(item.rect.x)} y${Math.round(item.rect.y)}</span>
        </div>
        <small>${escapeHtml(item.source)}：${escapeHtml(item.text)}</small>
        <small>${escapeHtml(item.element.tagName.toLowerCase())}.${escapeHtml(String(item.element.className || '').replace(/\s+/g, '.'))}</small>
      </div>
    `).join('');
    list.innerHTML = interfaceHtml + textHtml;
  }

  function initMeetingDraftPrefill() {
    const draft = readMeetingDraftFromPage();
    if (!draft) {
      state.currentMeetingDraft = null;
      return;
    }
    state.currentMeetingDraft = draft;
    applyMeetingDraftWhenReady(draft);
  }

  function cleanupMeetingPresetDraftCache() {
    try {
      localStorage.removeItem('campus-commute-checker.meetingPresetQueue');
    } catch (_) {
      // Ignore storage cleanup failures.
    }
  }

  function injectMeetingAttendeeHelper() {
    if (!isMeetingSubmitPage() || document.getElementById('ccheck-attendee-helper')) return;
    const helper = document.createElement('div');
    helper.id = 'ccheck-attendee-helper';
    helper.className = 'ccheck-attendee-helper';
    helper.innerHTML = `
      <div class="ccheck-draft-note-head">
        <span class="ccheck-draft-note-title">参会人粘贴选择</span>
        <button class="ccheck-draft-note-toggle" type="button" data-attendee-helper-toggle title="收起/展开">-</button>
      </div>
      <div class="ccheck-draft-note-body">
        <div class="ccheck-attendee-helper-section">
          <label class="ccheck-attendee-helper-label" for="ccheck-smart-meeting-text">整句识别</label>
          <textarea id="ccheck-smart-meeting-text" class="ccheck-smart-meeting-textarea" placeholder="粘贴会议文字，自动识别名称、日期、时间、形式、校区和参会人"></textarea>
          <div class="ccheck-attendee-helper-actions">
            <button class="ccheck-btn ccheck-btn-primary" type="button" data-smart-meeting-fill>识别并填写</button>
            <button class="ccheck-btn" type="button" data-smart-meeting-clear>清空</button>
          </div>
        </div>
        <div class="ccheck-attendee-helper-section">
          <label class="ccheck-attendee-helper-label" for="ccheck-attendee-names">参会人粘贴选择</label>
          <textarea id="ccheck-attendee-names" placeholder="粘贴老师姓名，可用换行、逗号、顿号或空格分隔"></textarea>
          <div class="ccheck-attendee-helper-actions">
            <button class="ccheck-btn ccheck-btn-primary" type="button" data-attendee-helper-select>选择参会人</button>
            <button class="ccheck-btn" type="button" data-attendee-helper-clear>清空</button>
          </div>
        </div>
        <div class="ccheck-attendee-helper-result" id="ccheck-attendee-helper-result">不会自动点击系统“确定”。</div>
      </div>
    `;
    document.body.appendChild(helper);
    setFloatingNoteCollapsed(helper, true, '[data-attendee-helper-toggle]');
    restoreFloatingElementPosition(helper, ATTENDEE_HELPER_POSITION_STORAGE_KEY);
    enableFloatingElementDragging(helper, {
      handleSelector: '.ccheck-draft-note-head',
      draggingClass: 'ccheck-draft-note-dragging',
      storageKey: ATTENDEE_HELPER_POSITION_STORAGE_KEY
    });
    prefillMeetingAttendeeHelper(helper, state.currentMeetingDraft);
    bindMeetingAttendeeHelper(helper);
  }

  function prefillMeetingAttendeeHelper(helper, draft) {
    const textarea = helper?.querySelector?.('#ccheck-attendee-names');
    const teachers = getMeetingDraftTeachers(draft);
    if (!textarea || !teachers.length) return;
    textarea.value = teachers.join('\n');
    setMeetingAttendeeHelperResult(`已自动带入 ${teachers.length} 位老师，可直接点击“选择参会人”。`);
  }

  function refreshMeetingPageFromHelperClear(message) {
    setMeetingAttendeeHelperResult(message || '正在刷新当前页面。');
    window.setTimeout(() => {
      location.reload();
    }, 120);
  }

  function getMeetingDraftTeachers(draft) {
    return Array.isArray(draft?.teachers)
      ? Array.from(new Set(draft.teachers.map(normalizePastedTeacherName).filter(Boolean)))
      : [];
  }

  function bindMeetingAttendeeHelper(helper) {
    helper.querySelector('[data-attendee-helper-toggle]')?.addEventListener('click', () => {
      const collapsed = !helper.classList.contains('ccheck-draft-note-collapsed');
      setFloatingNoteCollapsed(helper, collapsed, '[data-attendee-helper-toggle]');
      clampFloatingElementPosition(helper, ATTENDEE_HELPER_POSITION_STORAGE_KEY);
    });

    helper.querySelector('[data-attendee-helper-clear]')?.addEventListener('click', () => {
      refreshMeetingPageFromHelperClear('正在刷新当前页面，清空本次填写。');
    });

    helper.querySelector('[data-smart-meeting-clear]')?.addEventListener('click', () => {
      state.currentMeetingDraft = null;
      state.currentMeetingDraftAutoSelectKey = '';
      state.currentMeetingDraftFieldAutoFillKey = '';
      clearRecurringMeetingQueue();
      refreshMeetingPageFromHelperClear('正在刷新当前页面，清空本次整句识别填写。');
    });

    helper.querySelector('[data-smart-meeting-fill]')?.addEventListener('click', async () => {
      const text = helper.querySelector('#ccheck-smart-meeting-text')?.value || '';
      const draft = parseSmartMeetingText(text);
      if (!draft.ok) {
        setMeetingAttendeeHelperResult(draft.message);
        return;
      }
      const attendeeTextarea = helper.querySelector('#ccheck-attendee-names');
      if (attendeeTextarea && draft.teachers.length) attendeeTextarea.value = draft.teachers.join('\n');
      setMeetingAttendeeHelperResult('已识别，正在填写会议信息...');
      clearRecurringMeetingQueue();
      state.currentMeetingDraft = draft;
      const filled = applyMeetingDraftToForm(draft);
      const fieldResult = await autoFillMeetingDraftExtraFields(draft);
      let attendeeResult = { selected: [], missed: draft.teachers, skipped: true, reason: '未识别到参会人。' };
      if (draft.teachers.length) {
        attendeeResult = await trySelectMeetingAttendees({ teachers: draft.teachers });
      }
      showMeetingDraftNote(draft, formatMeetingDraftNoteMessage(attendeeResult, fieldResult));
      setMeetingAttendeeHelperResult(formatSmartMeetingFillResult(filled, fieldResult, attendeeResult, draft));
    });

    helper.querySelector('[data-attendee-helper-select]')?.addEventListener('click', async () => {
      const text = helper.querySelector('#ccheck-attendee-names')?.value || '';
      const teachers = parsePastedTeacherNames(text);
      if (!teachers.length) {
        setMeetingAttendeeHelperResult('请先粘贴老师姓名。');
        return;
      }
      setMeetingAttendeeHelperResult(`正在选择 ${teachers.length} 位参会人...`);
      const result = await trySelectMeetingAttendees({ teachers });
      setMeetingAttendeeHelperResult(formatMeetingAttendeeHelperResult(result));
    });
  }

  function parsePastedTeacherNames(text) {
    const parts = [];
    stripPastedTeacherListLabel(text)
      .replace(/[+＋，、；;。.!！?|/\\]+/g, '\n')
      .replace(/\s+/g, '\n')
      .split('\n')
      .forEach((part) => {
        expandPastedTeacherNamePart(part).forEach((name) => {
          const normalized = normalizePastedTeacherName(name);
          if (normalized) parts.push(normalized);
        });
      });
    return Array.from(new Set(parts));
  }

  function stripPastedTeacherListLabel(text) {
    return String(text || '')
      .trim()
      .replace(/^(?:参会人员|参与人员|参加人员|出席人员|参会人|参与人|参加人|出席人|参会|参与|参加|出席|人员)\s*[:：]\s*/u, '');
  }

  function expandPastedTeacherNamePart(part) {
    const text = String(part || '').trim();
    if (!text) return [];
    if (!text.includes('老师')) return [text];
    const names = [];
    const pattern = /(.+?)老师/g;
    let match;
    while ((match = pattern.exec(text))) {
      const name = match[1].trim();
      if (name) names.push(name);
    }
    return names.length ? names : [text];
  }

  function normalizePastedTeacherName(name) {
    const normalized = String(name || '')
      .trim()
      .replace(/(?:老师)+$/g, '')
      .trim();
    if (normalized === '我' || normalized === '本人') return '';
    if (normalized === '雪梨') return '张佳颖';
    if (normalized === '夏苏') return '夏苏尚华';
    if (normalized === '陶邓为') return '陶邓为1';
    if (normalized === '兰兰') return '滕艳兰';
    if (normalized === '芝芝') return '蔡守芝';
    if (normalized === '侯女士') return '侯艳芬';
    if (normalized === '潘潘') return '潘沁雯';
    if (normalized === '浪浪') return '王雯浪';
    return normalized;
  }

  function parseSmartMeetingText(text, options = {}) {
    const raw = String(text || '').trim();
    if (!raw) return { ok: false, message: '请先粘贴要排会议的信息。' };
    const normalizedText = normalizeSmartMeetingText(raw);
    const compactRaw = compactSmartMeetingText(raw);
    const now = options.now || new Date();
    const recurringDraft = parseSmartRecurringMeetingText(raw, normalizedText, compactRaw, now);
    if (recurringDraft) return recurringDraft;
    const date = parseSmartMeetingDate(normalizedText, now);
    const startMinutes = parseSmartMeetingStartMinutes(normalizedText);
    if (!date) return { ok: false, message: '没有识别到会议日期，例如 7.9 或 7月9日。' };
    if (!Number.isFinite(startMinutes)) return { ok: false, message: '没有识别到起始时间，例如 18:30。' };

    const explicitEndMinutes = parseSmartMeetingEndMinutes(normalizedText, startMinutes);
    const durationMinutes = Number.isFinite(explicitEndMinutes)
      ? explicitEndMinutes - startMinutes
      : parseSmartMeetingDurationMinutes(normalizedText) || getDefaultSmartMeetingDurationMinutes();
    const endMinutes = Number.isFinite(explicitEndMinutes) ? explicitEndMinutes : startMinutes + durationMinutes;
    const teachers = parseSmartMeetingTeachers(raw, compactRaw);
    const meetingMode = parseSmartMeetingMode(normalizedText);
    const campusInfo = parseSmartMeetingCampus(normalizedText);
    const meetingClassroomPrefixes = getSmartMeetingClassroomPrefixes(normalizedText, meetingMode, campusInfo);
    const baseMeetingName = parseSmartMeetingName(raw, compactRaw);
    const meetingName = appendZhangNingOfflineCampusToMeetingName(baseMeetingName, teachers, meetingMode, campusInfo);
    return buildSmartMeetingDraft({
      sourceKind: 'smart-meeting-text',
      date,
      startMinutes,
      endMinutes,
      durationMinutes,
      teachers,
      meetingMode,
      campusInfo,
      meetingClassroomPrefixes,
      meetingName
    });
  }

  function buildSmartMeetingDraft({
    sourceKind,
    date,
    startMinutes,
    endMinutes,
    durationMinutes,
    teachers,
    meetingMode,
    campusInfo,
    meetingClassroomPrefixes,
    meetingName,
    endDate,
    weekday,
    weekdayValues
  }) {
    return {
      source: 'campus-commute-checker',
      sourceKind,
      version: SCRIPT_VERSION,
      createdAt: new Date().toISOString(),
      ok: true,
      date,
      endDate,
      startTime: formatMinutes(startMinutes),
      endTime: formatMinutes(endMinutes),
      durationMinutes,
      startMinutes,
      endMinutes,
      timePeriod: getMeetingPeriodByStartMinutes(startMinutes),
      meetingMode,
      meetingCampus: campusInfo.campus,
      meetingCampusAliases: campusInfo.aliases,
      meetingClassroomPrefix: Array.isArray(meetingClassroomPrefixes) ? meetingClassroomPrefixes[0] || '' : '',
      meetingClassroomPrefixes: Array.isArray(meetingClassroomPrefixes) ? meetingClassroomPrefixes : [],
      teachers,
      meetingName,
      weekday,
      weekdayValues
    };
  }

  function parseSmartRecurringMeetingText(raw, normalizedText, compactRaw, now) {
    if (parseSmartRecurringWeekday(normalizedText) == null) return null;
    const startMinutes = parseSmartMeetingStartMinutes(normalizedText);
    if (!Number.isFinite(startMinutes)) return { ok: false, message: '没有识别到起始时间，例如 10:40。' };
    const dates = parseSmartRecurringMeetingDates(normalizedText, now);
    if (!dates) return null;
    if (!dates.length) {
      return { ok: false, message: '固定星期安排没有生成今天之后的日期，请检查月份和星期。' };
    }

    const explicitEndMinutes = parseSmartMeetingEndMinutes(normalizedText, startMinutes);
    const durationMinutes = Number.isFinite(explicitEndMinutes)
      ? explicitEndMinutes - startMinutes
      : parseSmartMeetingDurationMinutes(normalizedText) || getDefaultSmartMeetingDurationMinutes();
    const endMinutes = Number.isFinite(explicitEndMinutes) ? explicitEndMinutes : startMinutes + durationMinutes;
    const teachers = parseSmartMeetingTeachers(raw, compactRaw);
    const meetingMode = parseSmartMeetingMode(normalizedText);
    const campusInfo = parseSmartMeetingCampus(normalizedText);
    const meetingClassroomPrefixes = getSmartMeetingClassroomPrefixes(normalizedText, meetingMode, campusInfo);
    const baseMeetingName = parseSmartMeetingName(raw, compactRaw);
    const meetingName = String(baseMeetingName || '').trim();
    const weekday = parseSmartRecurringWeekday(normalizedText);
    return buildSmartMeetingDraft({
      sourceKind: 'smart-recurring-meeting-text',
      date: dates[0],
      endDate: dates[dates.length - 1],
      startMinutes,
      endMinutes,
      durationMinutes,
      teachers,
      meetingMode,
      campusInfo,
      meetingClassroomPrefixes,
      meetingName,
      weekday: formatSmartRecurringWeekday(weekday),
      weekdayValues: getSmartRecurringWeekdayFillValues(weekday)
    });
  }

  function parseSmartRecurringMeetingDates(text, now = new Date()) {
    const source = String(text || '');
    const weekday = parseSmartRecurringWeekday(source);
    if (weekday == null) return null;
    const months = parseSmartRecurringMonths(source, now);
    if (!months.length) return null;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const includeToday = shouldRecurringMeetingIncludeToday(source);
    const dates = [];
    months.forEach(({ year, month }) => {
      const date = new Date(year, month - 1, 1);
      while (date.getMonth() === month - 1) {
        if (date.getDay() === weekday && isRecurringMeetingDateInRange(date, today, includeToday)) {
          dates.push(formatDateInput(date));
        }
        date.setDate(date.getDate() + 1);
      }
    });
    return Array.from(new Set(dates)).sort();
  }

  function isRecurringMeetingDateInRange(date, today, includeToday) {
    if (date > today) return true;
    if (date < today) return false;
    return includeToday;
  }

  function shouldRecurringMeetingIncludeToday(text) {
    return /(?:从|自)?今天(?:开始|起)?(?:也)?排|今天也(?:排|安排)|包含今天/u.test(String(text || ''));
  }

  function parseSmartRecurringWeekday(text) {
    const match = String(text || '').match(/每(?:个)?(?:周|星期|礼拜)([一二三四五六日天1-7])/u);
    if (!match) return null;
    const map = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 0 };
    return map[match[1]];
  }

  function formatSmartRecurringWeekday(weekday) {
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday] || '';
  }

  function getSmartRecurringWeekdayFillValues(weekday) {
    const short = formatSmartRecurringWeekday(weekday);
    if (!short) return [];
    return [short, short.replace(/^周/u, '星期')];
  }

  function parseSmartRecurringMonths(text, now = new Date()) {
    const source = String(text || '');
    const naturalRangeMatch = source.match(/(?:(\d{4})年)?(\d{1,2})月(?:开始|起)?(?:到|至)(?:(\d{4})年)?(\d{1,2})月底?(?:结束|为止)?/u);
    if (naturalRangeMatch) {
      const startYear = naturalRangeMatch[1] ? Number(naturalRangeMatch[1]) : now.getFullYear();
      const startMonth = Number(naturalRangeMatch[2]);
      const endYear = naturalRangeMatch[3] ? Number(naturalRangeMatch[3]) : inferRecurringEndYear(startYear, startMonth, Number(naturalRangeMatch[4]));
      const endMonth = Number(naturalRangeMatch[4]);
      return expandRecurringMonths(startYear, startMonth, endYear, endMonth);
    }
    const rangeMatch = source.match(/(?:(\d{4})年)?(\d{1,2})月(?:和|及|、|,|至|到|-|~|～)(?:(\d{4})年)?(\d{1,2})月/u);
    if (rangeMatch) {
      const startYear = rangeMatch[1] ? Number(rangeMatch[1]) : now.getFullYear();
      const startMonth = Number(rangeMatch[2]);
      const endYear = rangeMatch[3] ? Number(rangeMatch[3]) : inferRecurringEndYear(startYear, startMonth, Number(rangeMatch[4]));
      const endMonth = Number(rangeMatch[4]);
      return expandRecurringMonths(startYear, startMonth, endYear, endMonth);
    }
    const singleMatch = source.match(/(?:(\d{4})年)?(\d{1,2})月/u);
    if (!singleMatch) return [];
    return [{ year: singleMatch[1] ? Number(singleMatch[1]) : now.getFullYear(), month: Number(singleMatch[2]) }]
      .filter((item) => isValidRecurringMonth(item.year, item.month));
  }

  function inferRecurringEndYear(startYear, startMonth, endMonth) {
    return endMonth < startMonth ? startYear + 1 : startYear;
  }

  function expandRecurringMonths(startYear, startMonth, endYear, endMonth) {
    if (!isValidRecurringMonth(startYear, startMonth) || !isValidRecurringMonth(endYear, endMonth)) return [];
    const output = [];
    let cursor = startYear * 12 + startMonth - 1;
    const end = endYear * 12 + endMonth - 1;
    while (cursor <= end && output.length < 24) {
      output.push({ year: Math.floor(cursor / 12), month: (cursor % 12) + 1 });
      cursor += 1;
    }
    return output;
  }

  function isValidRecurringMonth(year, month) {
    return Number.isInteger(year) && Number.isInteger(month) && month >= 1 && month <= 12;
  }

  function normalizeSmartMeetingText(text) {
    return String(text || '')
      .replace(/[：]/g, ':')
      .replace(/[，；、。]/g, ',')
      .replace(/[（）]/g, (char) => char === '（' ? '(' : ')')
      .replace(/\s+/g, '')
      .trim();
  }

  function compactSmartMeetingText(text) {
    return String(text || '')
      .replace(/[：]/g, ':')
      .replace(/[，；、。]/g, ',')
      .replace(/[（）]/g, (char) => char === '（' ? '(' : ')')
      .replace(/\s+/g, '')
      .trim();
  }

  function parseSmartMeetingDate(text, now = new Date()) {
    const source = String(text || '');
    const explicitPattern = /(?:(\d{4})[年\/.-])?(\d{1,2})\s*(?:月|[\/.-])\s*(\d{1,2})\s*(?:日|号)?/g;
    let match = explicitPattern.exec(source);
    while (match) {
      const year = match[1] ? Number(match[1]) : now.getFullYear();
      const date = makeDateInput(year, Number(match[2]), Number(match[3]));
      if (date) return date;
      match = explicitPattern.exec(source);
    }
    const dayOnlyMatch = source.match(/(?:^|[^\d])(\d{1,2})\s*(?:日|号)/u);
    if (dayOnlyMatch) return makeDateInput(now.getFullYear(), now.getMonth() + 1, Number(dayOnlyMatch[1]));
    const relativeMatch = source.match(/(?:今天|明天|后天|大后天)/u);
    if (relativeMatch) {
      const dayOffset = getSmartMeetingRelativeDayOffset(relativeMatch[0]);
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
      return makeDateInput(date.getFullYear(), date.getMonth() + 1, date.getDate());
    }
    return '';
  }

  function getSmartMeetingRelativeDayOffset(text) {
    if (text === '明天') return 1;
    if (text === '后天') return 2;
    if (text === '大后天') return 3;
    return 0;
  }

  function parseSmartMeetingStartMinutes(text) {
    const match = findSmartMeetingClockMatches(text)[0];
    return match ? match.minutes : NaN;
  }

  function parseSmartMeetingEndMinutes(text, startMinutes) {
    const source = String(text || '');
    const matches = findSmartMeetingClockMatches(source);
    for (let index = 0; index < matches.length - 1; index += 1) {
      const current = matches[index];
      const next = matches[index + 1];
      const between = source.slice(current.endIndex, next.index);
      if (!/^\s*(?:-|－|—|–|到|至|~|～)\s*$/u.test(between)) continue;
      let endMinutes = next.minutes;
      if (endMinutes <= current.minutes && current.minutes >= 12 * 60 && next.rawHour < 12) {
        endMinutes += 12 * 60;
      }
      if (Math.abs(current.minutes - startMinutes) <= 1 && endMinutes > startMinutes) return endMinutes;
    }
    return NaN;
  }

  function parseSmartMeetingDurationMinutes(text) {
    const normalized = stripSmartMeetingClockText(String(text || ''));
    const lessonMatch = normalized.match(/([0-9一二两三四五六七八九十]{1,3})\s*课时/u);
    if (lessonMatch) {
      const lessonCount = parseSmartMeetingTimeNumber(lessonMatch[1]);
      if (Number.isFinite(lessonCount) && lessonCount > 0) {
        return clampNumber(lessonCount * 45 + Math.max(0, lessonCount - 1) * 5, getDefaultSmartMeetingDurationMinutes(), 5, 240);
      }
    }
    const durationMatch = normalized.match(/(?:时长|持续|开|排|约|预计|大约)(\d{1,3})\s*(?:分钟|min|mins|minute|minutes)/i)
      || normalized.match(/(\d{1,3})\s*(?:分钟|min|mins|minute|minutes)(?:左右|会议|家长会)?/i);
    if (durationMatch) return clampNumber(Number(durationMatch[1]), getDefaultSmartMeetingDurationMinutes(), 5, 240);
    const hourMatch = normalized.match(/(?:时长|持续|开|排|约|预计|大约)(\d(?:\.\d+)?)\s*(?:小时|个小时|h|hr|hrs)/i)
      || normalized.match(/(\d(?:\.\d+)?)\s*(?:小时|个小时|h|hr|hrs)(?:左右|会议|家长会)?/i);
    if (hourMatch) return clampNumber(Math.round(Number(hourMatch[1]) * 60), getDefaultSmartMeetingDurationMinutes(), 5, 240);
    return 0;
  }

  function getDefaultSmartMeetingDurationMinutes() {
    return 45;
  }

  function stripSmartMeetingClockText(text) {
    return String(text || '').replace(new RegExp(`(^|[^\\d零〇一二两三四五六七八九十])${getSmartMeetingClockPatternSource()}`, 'gu'), '$1 ');
  }

  function findSmartMeetingClockMatches(text) {
    const source = String(text || '');
    const pattern = /(^|每(?:个)?(?:周|星期|礼拜)[一二三四五六日天1-7]|[^\d零〇一二两三四五六七八九十])((?:[01]?\d|2[0-3]|[零〇一二两三四五六七八九十两]{1,3}))\s*([:：点时])\s*([0-5]?\d|[零〇一二两三四五六七八九十两]{1,3})?\s*(半|分)?/gu;
    const matches = [];
    let match;
    while ((match = pattern.exec(source))) {
      const prefix = match[1] || '';
      const delimiter = match[3] || '';
      const minuteText = match[4] || '';
      const suffix = match[5] || '';
      if ((delimiter === ':' || delimiter === '：') && !/^[0-5]\d$/.test(minuteText)) continue;
      let rawHour = parseSmartMeetingTimeNumber(match[2]);
      let minute = suffix === '半' ? 30 : parseSmartMeetingMinuteText(minuteText, delimiter);
      if (!Number.isFinite(rawHour) || !Number.isFinite(minute)) continue;
      if (rawHour > 23 || minute > 59) continue;
      const index = match.index + prefix.length;
      const hour = adjustSmartMeetingHourByPeriod(rawHour, source, index);
      matches.push({
        index,
        endIndex: match.index + match[0].length,
        text: match[0].slice(prefix.length),
        minutes: hour * 60 + minute,
        rawHour
      });
    }
    return matches;
  }

  function parseSmartMeetingMinuteText(text, delimiter) {
    const source = String(text || '').trim();
    if (source) return parseSmartMeetingTimeNumber(source);
    return delimiter === '点' || delimiter === '时' ? 0 : NaN;
  }

  function parseSmartMeetingTimeNumber(text) {
    const source = String(text || '').trim();
    if (!source) return NaN;
    if (/^\d+$/.test(source)) return Number(source);
    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (source.includes('十')) {
      const parts = source.split('十');
      const tens = parts[0] ? digits[parts[0]] : 1;
      const ones = parts[1] ? digits[parts[1]] : 0;
      return Number.isFinite(tens) && Number.isFinite(ones) ? tens * 10 + ones : NaN;
    }
    const values = Array.from(source).map((char) => digits[char]);
    if (values.some((value) => !Number.isFinite(value))) return NaN;
    return values.reduce((total, value) => total * 10 + value, 0);
  }

  function adjustSmartMeetingHourByPeriod(hour, source, index) {
    const context = String(source || '').slice(Math.max(0, index - 8), index);
    if (hour < 12 && /下午|晚上|晚间|傍晚/.test(context)) return hour + 12;
    if (hour <= 2 && /中午|午间/.test(context)) return hour + 12;
    return hour;
  }

  function getSmartMeetingClockPatternSource() {
    return '(?:[01]?\\d|2[0-3]|[零〇一二两三四五六七八九十两]{1,3})\\s*(?:[:：]\\s*[0-5]\\d|[点时]\\s*(?:(?:[0-5]?\\d|[零〇一二两三四五六七八九十两]{1,3})\\s*分?|半)?)';
  }

  function parseSmartMeetingTeachers(rawText, compactText) {
    const rawSource = String(rawText || '');
    const compactSource = String(compactText || rawText || '');
    const matched = extractSmartMeetingTeacherSegment(rawSource)
      || extractSmartMeetingTeacherSegment(compactSource)
      || extractSmartMeetingTeacherSuffixSegment(rawSource)
      || extractSmartMeetingTeacherSuffixSegment(compactSource)
      || extractSmartMeetingOccupyTeacherSegment(rawSource)
      || extractSmartMeetingOccupyTeacherSegment(compactSource)
      || extractSmartMeetingPossessiveTeacherSegment(rawSource)
      || extractSmartMeetingPossessiveTeacherSegment(compactSource)
      || extractSmartMeetingUnlabeledTeacherSegment(rawSource);
    return matched ? parsePastedTeacherNames(matched) : [];
  }

  function extractSmartMeetingTeacherSegment(text) {
    const source = String(text || '');
    const match = source.match(/(?:参会人员|参与人员|参加人员|出席人员|参会人|参与人|参加人|出席人|参会|参与|参加|出席|人员)\s*[:：]?\s*([\s\S]+)/u);
    if (!match) return '';
    return cutSmartMeetingTeacherSegment(match[1]);
  }

  function extractSmartMeetingOccupyTeacherSegment(text) {
    const source = String(text || '');
    const datePattern = getSmartMeetingDatePatternSource();
    const patterns = [
      new RegExp(`(?:占空|占用|辛苦占空|辛苦占用)\\s*([^,，;；。\\n\\r]+?)\\s*(?=${datePattern})`, 'u'),
      new RegExp(`(?:占空|占用|辛苦占空|辛苦占用)\\s*([^,，;；。\\n\\r]+?)\\s*(?=(?:上午|下午|晚上|晚间|中午|早上)?${getSmartMeetingClockPatternSource()})`, 'u')
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      const cleanedSegment = String(match?.[1] || '')
        .replace(/^\s*一下/u, '')
        .replace(/老师\s*$/u, '');
      const names = parsePastedTeacherNames(cleanedSegment);
      if (names.length) return cleanedSegment;
    }
    return '';
  }

  function extractSmartMeetingTeacherSuffixSegment(text) {
    const source = String(text || '');
    const match = source.match(/(?:^|[\n\r,，;；。])\s*([\u4e00-\u9fa5A-Za-z]{2,8})老师(?=\s*(?:的|[,，;；。]|$))/u);
    return match ? match[1] : '';
  }

  function extractSmartMeetingPossessiveTeacherSegment(text) {
    const source = String(text || '');
    const patterns = [
      /(?:^|[^\d])(?:\d{4}[年\/.-])?\d{1,2}\s*(?:月|[\/.-])\s*\d{1,2}\s*(?:日|号)?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,8})老师的(?:会议|家长会|会)/u,
      /(?:今天|明天|后天|大后天)\s*([\u4e00-\u9fa5A-Za-z0-9]{1,8})老师的(?:会议|家长会|会)/u,
      /(?:^|[\n\r,，;；。])\s*([\u4e00-\u9fa5A-Za-z0-9]{1,8})老师的(?:会议|家长会|会)?(?=\s*(?:[,，;；。]|$))/u
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      const names = parsePastedTeacherNames(match?.[1] || '');
      if (names.length) return match[1];
    }
    return '';
  }

  function extractSmartMeetingUnlabeledTeacherSegment(text) {
    const lines = String(text || '')
      .split(/[\n\r]+/u)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = stripPastedTeacherListLabel(lines[index]);
      if (!line || isSmartMeetingDetailLine(line)) continue;
      const names = parsePastedTeacherNames(line);
      if (names.length > 1 || (names.length === 1 && isLikelyStandaloneTeacherName(names[0]))) {
        return line;
      }
    }
    return '';
  }

  function isSmartMeetingDetailLine(text) {
    return /(?:时间|日期|地点|校区|会议形式|形式|教室|会议名称|名称|主题|学生待定|学生|学员|线下|线上)/u.test(String(text || ''))
      || /(?:上午|下午|晚上|晚间|中午|早上)?\d{1,2}[:：点时]/u.test(String(text || ''));
  }

  function isLikelyStandaloneTeacherName(name) {
    return /^[\u4e00-\u9fa5A-Za-z0-9]{1,8}$/u.test(String(name || '').trim());
  }

  function cutSmartMeetingTeacherSegment(text) {
    const source = String(text || '');
    const detailPatterns = [
      /(?:^|[\n\r,，;；。])\s*(?:时间|日期|地点|校区|会议形式|形式|教室|会议名称|名称|主题)\s*[:：]?/u,
      /(?:^|[\n\r,，;；。+])\s*(?:学生待定|学生|学员)\s*[:：]?/u,
      /(?:^|[\n\r,，;；。+])\s*(?:已|已经)?(?:跟|和|同|与).{0,12}(?:沟通|确认|说好|约好)/u,
      /(?:^|[\n\r,，;；。])\s*(?:上午|下午|晚上|晚间|中午|早上)?(?:\d{1,2}|[零〇一二两三四五六七八九十两]{1,3})[:：点时](?:[0-5]?\d|[零〇一二两三四五六七八九十两]{1,3}|半)?(?:分)?/u,
      /(?:^|[\n\r,，;；。])\s*(?:城西|紫金港?|钱江|城建|下沙|小和山|永康|金华)?(?:线下|线上)/u,
      /(?:^|[\n\r,，;；。])\s*(?:城西|紫金港?|钱江|城建|下沙|小和山|永康|金华)(?:校区|大厦)?(?:哈|呀|噢|哦|~|～)?/u,
      /(?:时间|日期|地点|校区|学生待定|学生|学员)\s*[:：]?/u
    ];
    const cutIndex = detailPatterns
      .map((pattern) => {
        const found = source.match(pattern);
        return found ? found.index : -1;
      })
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];
    return (cutIndex == null ? source : source.slice(0, cutIndex)).trim();
  }

  function parseSmartMeetingMode(text) {
    const normalized = String(text || '');
    if (/线上|在线|腾讯会议|钉钉|飞书|直播|远程/.test(normalized)) return 'online';
    return 'offline';
  }

  function getSmartMeetingClassroomPrefixes(text, meetingMode, campusInfo) {
    if (!campusInfo?.campus) return [];
    const source = String(text || '');
    if (/小教室/u.test(source)) return ['V'];
    if (/会议室/u.test(source)) return ['会议室', 'M'];
    return ['M'];
  }

  function parseSmartMeetingCampus(text) {
    const normalized = String(text || '');
    const explicitLocation = extractSmartMeetingExplicitLocation(normalized);
    if (explicitLocation) return explicitLocation;
    const rows = [
      { pattern: /\b(?:CUA|CUB)\b|(?:CUA|CUB)\d+/i, campus: '城建大厦', aliases: ['城建大厦', '城建校区', '城建', 'CUA', 'CUB'] },
      { pattern: /\bQUA\b|QUA\d+/i, campus: '钱江校区', aliases: ['钱江校区', '钱江', 'QUA'] },
      { pattern: /\bZUA\b|ZUA\d+/i, campus: '紫金港', aliases: ['紫金港', '紫金港校区', '紫金', 'ZUA'] },
      { pattern: /城西|紫金|紫金港/, campus: '紫金港', aliases: ['紫金港', '紫金港校区', '紫金', '城西'] },
      { pattern: /钱江/, campus: '钱江校区', aliases: ['钱江校区', '钱江'] },
      { pattern: /城建/, campus: '城建大厦', aliases: ['城建大厦', '城建校区', '城建'] },
      { pattern: /下沙/, campus: '下沙校区', aliases: ['下沙校区', '下沙'] },
      { pattern: /小和山/, campus: '小和山校区', aliases: ['小和山校区', '小和山'] },
      { pattern: /永康/, campus: '永康校区', aliases: ['永康校区', '永康'] },
      { pattern: /金华/, campus: '金华校区', aliases: ['金华校区', '金华'] }
    ];
    const matched = rows.find((row) => row.pattern.test(normalized));
    return matched || { campus: '', aliases: [] };
  }

  function extractSmartMeetingExplicitLocation(text) {
    const source = String(text || '');
    const match = source.match(/(?:地点|校区|上课地点|会议地点)\s*[:：]?\s*([^,，;；。\n\r]+)/u);
    if (!match) return null;
    const locationText = match[1] || '';
    return matchSmartMeetingCampusText(locationText);
  }

  function matchSmartMeetingCampusText(text) {
    const source = String(text || '');
    const rows = [
      { pattern: /\b(?:CUA|CUB)\b|(?:CUA|CUB)\d+/i, campus: '城建大厦', aliases: ['城建大厦', '城建校区', '城建', 'CUA', 'CUB'] },
      { pattern: /\bQUA\b|QUA\d+/i, campus: '钱江校区', aliases: ['钱江校区', '钱江', 'QUA'] },
      { pattern: /\bZUA\b|ZUA\d+/i, campus: '紫金港', aliases: ['紫金港', '紫金港校区', '紫金', 'ZUA'] },
      { pattern: /城西|紫金|紫金港/, campus: '紫金港', aliases: ['紫金港', '紫金港校区', '紫金', '城西'] },
      { pattern: /钱江/, campus: '钱江校区', aliases: ['钱江校区', '钱江'] },
      { pattern: /城建/, campus: '城建大厦', aliases: ['城建大厦', '城建校区', '城建'] },
      { pattern: /下沙/, campus: '下沙校区', aliases: ['下沙校区', '下沙'] },
      { pattern: /小和山/, campus: '小和山校区', aliases: ['小和山校区', '小和山'] },
      { pattern: /永康/, campus: '永康校区', aliases: ['永康校区', '永康'] },
      { pattern: /金华/, campus: '金华校区', aliases: ['金华校区', '金华'] }
    ];
    return rows.find((row) => row.pattern.test(source)) || null;
  }

  function parseSmartMeetingName(rawText, compactText) {
    const explicitName = parseSmartMeetingExplicitName(rawText) || parseSmartMeetingExplicitName(compactText);
    if (explicitName) return explicitName;
    const occupyName = parseSmartMeetingOccupyName(rawText) || parseSmartMeetingOccupyName(compactText);
    if (occupyName) return occupyName;
    const leadingName = parseSmartMeetingLeadingName(rawText);
    if (leadingName) return leadingName;
    const namedAfterTime = parseSmartMeetingNameAfterClock(rawText);
    if (namedAfterTime) return namedAfterTime;
    const text = String(rawText || compactText || '').trim();
    if (!text) return '';
    const afterIntro = trimSmartMeetingNameIntro(text);
    const beforeDetails = cutSmartMeetingNameBeforeDetails(afterIntro);
    return cleanSmartMeetingName(beforeDetails);
  }

  function parseSmartMeetingOccupyName(text) {
    const source = String(text || '').trim();
    if (/^\s*(?:老师[，,]\s*)?辛苦(?:老师)?[，,]?\s*占空(?:一下)?(?=[\u4e00-\u9fa5A-Za-z]{2,8}老师?)/u.test(source)) return '占空';
    const match = source.match(/^\s*(?:辛苦老师)?(?:帮|给)?\s*((?!我)[\u4e00-\u9fa5A-Za-z]{2,8})占空(?:一下)?/u);
    return match ? `${match[1]}占空` : '';
  }

  function parseSmartMeetingLeadingName(text) {
    const source = String(text || '').trim();
    const match = source.match(/^\s*([^:：\n\r,，;；]+?)\s*[:：]\s*(?=(?:(?:(?:\d{4}年)?\d{1,2}月(?:开始|起)?(?:到|至)(?:(?:\d{4}年)?\d{1,2}月底?(?:结束|为止)?)|(?:\d{4}年)?\d{1,2}月(?:开始|起)?\s*)[，,、\s]*)?每(?:个)?(?:周|星期|礼拜)[一二三四五六日天1-7])/u);
    return match ? cleanSmartMeetingName(match[1]) : '';
  }

  function parseSmartMeetingExplicitName(text) {
    const source = String(text || '').trim();
    if (!source) return '';
    const labeled = source.match(/(?:(?:会议|家长会)?(?:名称|主题)|会议)\s*[:：]\s*([^,，;；。\n\r]+)/u);
    if (labeled) return cleanSmartMeetingName(cutSmartMeetingNameBeforeDetails(cutSmartMeetingExplicitNameValue(labeled[1])));
    const bracket = source.match(/[【\[]([^】\]\n\r]+)[】\]]/u);
    if (!bracket) return '';
    if (isSmartMeetingDateOnly(bracket[1])) return '';
    return cleanSmartMeetingName(cutSmartMeetingNameBeforeDetails(source.slice(bracket.index)));
  }

  function isSmartMeetingDateOnly(text) {
    const pattern = new RegExp(`^\\s*${getSmartMeetingDatePatternSource()}\\s*$`, 'u');
    return pattern.test(String(text || ''));
  }

  function cutSmartMeetingExplicitNameValue(text) {
    const source = String(text || '');
    const cutPatterns = [
      /\s+时间\s*[:：]?\s*(?=(?:上午|下午|晚上|晚间|中午|早上)?(?:\d{1,2}|[零〇一二两三四五六七八九十两]{1,3})[:：点时])/u,
      /\s+(?:日期|地点|校区|会议形式|形式|教室|参会人员|参与人员|参加人员|出席人员|参会人|参与人|参加人|出席人|参会|参与|参加|出席)\s*[:：]/u
    ];
    const cutIndex = cutPatterns
      .map((pattern) => {
        const match = source.match(pattern);
        return match ? match.index : -1;
      })
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];
    return cutIndex == null ? source : source.slice(0, cutIndex);
  }

  function parseSmartMeetingNameAfterClock(rawText) {
    const source = String(rawText || '').trim();
    const match = findSmartMeetingNameStartAfterDateTime(source);
    if (!match) return '';
    const afterTime = cutSmartMeetingNameAfterTimeTail(source.slice(match.index + match[0].length));
    return cleanSmartMeetingName(cutSmartMeetingNameBeforeDetails(afterTime));
  }

  function cutSmartMeetingNameAfterTimeTail(text) {
    const source = String(text || '').replace(/^\s*的\s*/u, '');
    const match = source.match(/(?:^|[\n\r,，;；。\s])\s*(?:地点|校区|上课地点|会议地点|参会人员|参与人员|参加人员|出席人员|参会人|参与人|参加人|出席人|参会|参与|参加|出席|时间|日期|会议形式|形式|教室)\s*[:：]?/u);
    const beforeDetails = match ? source.slice(0, match.index) : source;
    return beforeDetails.split(/[\n\r]+/u).map((line) => line.trim()).find(Boolean) || '';
  }

  function findSmartMeetingNameStartAfterDateTime(source) {
    const rangeMatch = findSmartMeetingTimeRangeAfterDate(source);
    if (rangeMatch) return rangeMatch;
    return findSmartMeetingSingleClockAfterDate(source);
  }

  function findSmartMeetingTimeRangeAfterDate(source) {
    const pattern = new RegExp(`${getSmartMeetingDatePatternSource()}\\s*(?:[】\\]])?\\s*(?:的|[,，])?\\s*(?:上午|下午|晚上|晚间|中午|早上)?\\s*${getSmartMeetingClockPatternSource()}\\s*(?:-|－|—|–|到|至|~|～)\\s*${getSmartMeetingClockPatternSource()}`, 'gu');
    let match = pattern.exec(source);
    while (match) {
      const before = source.slice(0, match.index).trim();
      if (!before || /[【\[]\s*$/u.test(before) || /(?:^|[\n\r,，;；。])\s*(?:时间|日期|会议时间|起始时间|开始时间|排课时间)\s*[:：]?\s*$/u.test(before)) {
        return match;
      }
      match = pattern.exec(source);
    }
    return null;
  }

  function findSmartMeetingSingleClockAfterDate(source) {
    const pattern = new RegExp(`${getSmartMeetingDatePatternSource()}\\s*(?:[】\\]])?\\s*(?:的|[,，])?\\s*(?:上午|下午|晚上|晚间|中午|早上)?\\s*${getSmartMeetingClockPatternSource()}`, 'gu');
    let match = pattern.exec(source);
    while (match) {
      const nextText = source.slice(pattern.lastIndex);
      const previousText = source.slice(0, match.index);
      const hasNameAfterPossessiveTime = /^\s*的\s*\S/u.test(nextText);
      if (!/^\s*(?:-|－|—|–|到|至|~|～)/u.test(nextText)
        && !/(?:-|－|—|–|到|至|~|～)\s*$/u.test(previousText)
        && (hasNameAfterPossessiveTime || !previousText.trim() || /[【\[]\s*$/u.test(previousText) || /(?:^|[\n\r,，;；。])\s*(?:时间|日期|会议时间|起始时间|开始时间|排课时间)\s*[:：]?\s*$/u.test(previousText))) {
        return match;
      }
      match = pattern.exec(source);
    }
    return null;
  }

  function trimSmartMeetingNameIntro(text) {
    return String(text || '')
      .replace(/^.*?(?:排一下|排一个|排一次|排个|安排一下|安排一个|安排一次|安排个|安排|排)\s*/u, '')
      .replace(/^(?:会议|家长会)?(?:名称|主题)\s*[:：]\s*/u, '')
      .replace(/^会议\s*[:：]\s*/u, '')
      .replace(/^\d{4}[年\/.-]\d{1,2}(?:月|[\/.-])\d{1,2}(?:日|号)?\s*(?:的)?\s*(?:上午|下午|晚上|晚间|中午|早上)?/u, '')
      .replace(/^\d{1,2}(?:月|[\/.-])\d{1,2}(?:日|号)?\s*(?:的)?\s*(?:上午|下午|晚上|晚间|中午|早上)?/u, '')
      .replace(/^\s*(?:上午|下午|晚上|晚间|中午|早上)/u, '');
  }

  function getSmartMeetingDatePatternSource() {
    return '(?:(?:\\d{4}[年\\/.-])?\\d{1,2}\\s*(?:月|[\\/.-])\\s*\\d{1,2}\\s*(?:日|号)?|\\d{1,2}\\s*(?:日|号)|今天|明天|后天|大后天)';
  }

  function cutSmartMeetingNameBeforeDetails(text) {
    const source = String(text || '');
    const cutPatterns = [
      /(?:会议)?(?:日期|起始时间|开始时间|上课时间|排课时间)\s*[:：]?/u,
      /时间\s*[:：]?/u,
      /(?:参会人员|参与人员|参加人员|出席人员|参会人|参与人|参加人|出席人|参会|参与|参加|出席)\s*[:：]?/u,
      /(?:在)?(?:(?:\d{4})年)?\d{1,2}月(?:和|及|、|,|至|到|-|~|～)(?:(?:\d{4})年)?\d{1,2}月(?:的)?每(?:个)?(?:周|星期|礼拜)[一二三四五六日天1-7]/u,
      /(?:(?:\d{4})年)?\d{1,2}月(?:开始|起)?(?:到|至)(?:(?:\d{4})年)?\d{1,2}月底?(?:结束|为止)?[，,、\s]*(?:的)?每(?:个)?(?:周|星期|礼拜)[一二三四五六日天1-7]/u,
      /(?:在)?(?:(?:\d{4})年)?\d{1,2}月(?:的)?每(?:个)?(?:周|星期|礼拜)[一二三四五六日天1-7]/u,
      /(?:^|[,，;；])\s*每(?:个)?(?:周|星期|礼拜)[一二三四五六日天1-7]/u,
      new RegExp(`${getSmartMeetingDatePatternSource()}\\s*(?:的|[,，])?\\s*(?:上午|下午|晚上|晚间|中午|早上)?\\s*${getSmartMeetingClockPatternSource()}`, 'u'),
      /(?:今天|明天|后天|大后天)(?:上午|下午|晚上|晚间|中午|早上)?(?:\d{1,2}|[零〇一二两三四五六七八九十两]{1,3})[:：点时](?:[0-5]?\d|[零〇一二两三四五六七八九十两]{1,3}|半)?(?:分)?/u,
      /(?:^|[,，])(?:上午|下午|晚上|晚间|中午|早上)?(?:\d{1,2}|[零〇一二两三四五六七八九十两]{1,3})[:：点时](?:[0-5]?\d|[零〇一二两三四五六七八九十两]{1,3}|半)?(?:分)?/u,
      /(?:^|[\n\r,，])\s*(?:城西|紫金港?|钱江|城建|下沙|小和山|永康|金华)?(?:线下|线上)/u
    ];
    const cutIndex = cutPatterns
      .map((pattern) => {
        const match = source.match(pattern);
        return match ? match.index : -1;
      })
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];
    return cutIndex == null ? source : source.slice(0, cutIndex);
  }

  function cleanSmartMeetingName(text) {
    const cleaned = String(text || '')
      .trim()
      .replace(/^[,，;；。]+|[,，;；。]+$/g, '')
      .replace(/^(?:开|排|安排|一个|一次|个|次)+/u, '')
      .replace(/^([【\[])\s*(?:线下|线上)\s*/u, '$1')
      .replace(/^\s*(?:线下|线上)\s+/u, '')
      .replace(/[-—–]+\s*(?:在)?(?:城西|紫金港?|钱江|城建|下沙|小和山|永康|金华)?(?:线下|线上)[\s\S]*$/u, '')
      .replace(/(?:,?)(?:在)?(?:城西|紫金港?|钱江|城建|下沙|小和山|永康|金华)?(?:线下|线上)$/u, '')
      .replace(/([】\]])\s*(?:\[[^\]\n\r]{1,8}\]\s*)+$/u, '$1')
      .trim()
      .replace(/^[,，;；。]+|[,，;；。]+$/g, '');
    if (/^(?:帮我|请|麻烦|辛苦)?占空$/u.test(cleaned)) return '占空';
    if (/^[\u4e00-\u9fa5A-Za-z]{1,8}占空$/u.test(cleaned)) return cleaned;
    return normalizeSmartMeetingNaturalName(cleaned);
  }

  function normalizeSmartMeetingNaturalName(name) {
    const source = String(name || '').trim();
    if (!source || /^[【\[]/.test(source)) return source;
    const match = source.match(/^(.+?)和(.+?)的([^的]+(?:会|会议))$/u);
    if (!match) return source;
    const left = match[1].trim();
    const right = match[2].trim();
    const topic = match[3].trim();
    return left && right && topic ? `${left}-${right} ${topic}` : source;
  }

  function appendZhangNingOfflineCampusToMeetingName(meetingName, teachers, meetingMode, campusInfo) {
    const normalizedTeachers = Array.isArray(teachers) ? teachers.map(normalizePastedTeacherName) : [];
    if (!normalizedTeachers.includes('张宁') || meetingMode !== 'offline' || !campusInfo?.campus) {
      return String(meetingName || '').trim();
    }
    const suffix = formatSmartMeetingOfflineCampusLabel(campusInfo);
    const baseName = String(meetingName || '').trim();
    if (!suffix) return baseName;
    const suffixPattern = escapeRegExp(suffix);
    const existingSuffix = baseName.match(new RegExp(`^(.*?)[\\s,，;；。-]+${suffixPattern}$`, 'u'));
    if (existingSuffix) {
      const name = existingSuffix[1].trim();
      return name ? `${name}-${suffix}` : suffix;
    }
    return baseName ? `${baseName}-${suffix}` : suffix;
  }

  function formatSmartMeetingOfflineCampusLabel(campusInfo) {
    const aliases = Array.isArray(campusInfo?.aliases) ? campusInfo.aliases : [];
    const alias = aliases.find((item) => item && !/校区|大厦|^[A-Z]+$/i.test(item));
    const shortName = String(alias || campusInfo?.campus || '').replace(/校区|大厦$/u, '').trim();
    return shortName ? `${shortName}线下` : '';
  }

  function getMeetingPeriodByStartMinutes(minutes) {
    if (minutes < 12 * 60) return '上午';
    if (minutes < 18 * 60) return '下午';
    return '晚上';
  }

  function setMeetingAttendeeHelperResult(message) {
    const result = document.getElementById('ccheck-attendee-helper-result');
    if (result) result.textContent = message;
  }

  function formatMeetingAttendeeHelperResult(result) {
    if (!result || result.skipped) return result?.reason || '未找到参会人选择框，请确认当前页面有“参会人”字段。';
    const selected = result.selected.length ? `已选中：${result.selected.join('、')}` : '没有自动选中参会人';
    const missed = result.missed.length ? `；未选中：${result.missed.join('、')}` : '';
    return `${selected}${missed}。请人工核对后再点击系统“确定”。`;
  }

  function formatSmartMeetingFillResult(formFilled, fieldResult, attendeeResult, draft) {
    const base = formFilled ? `v${SCRIPT_VERSION} 已填写会议名称、日期和起止时间。` : `v${SCRIPT_VERSION} 已识别，但基础字段未全部写入，请核对会议表单。`;
    const recurring = formatRecurringMeetingDraftStatus(draft);
    const fields = formatMeetingDraftFieldResult(fieldResult);
    const attendees = attendeeResult?.skipped
      ? attendeeResult.reason || ''
      : formatMeetingAttendeeHelperResult(attendeeResult);
    return [base, recurring, fields, attendees].filter(Boolean).join(' ');
  }

  function formatRecurringMeetingDraftStatus(draft) {
    if (!draft?.endDate || !draft?.weekday) return '';
    return `固定星期会议：${draft.date} 至 ${draft.endDate}，${draft.weekday}。`;
  }

  function installMeetingSubmitReturnFallback() {
    if (!isMeetingPage() || window.__ccheckMeetingReturnInstalled) return;
    window.__ccheckMeetingReturnInstalled = true;
    markExistingMeetingSuccessMessagesIgnored();
    installMeetingSuccessWatcher();

    document.addEventListener('click', (event) => {
      const button = event.target?.closest?.('button');
      if (!button) return;
      if (!isMeetingSubmitPage()) return;
      const buttonText = normalizeName(textOf(button));
      if (!/(确定|提交|保存|新增|添加|完成|保存并|确认)/.test(buttonText)) return;
      markExistingMeetingSuccessMessagesIgnored();
      window.__ccheckMeetingSubmitClickedAt = Date.now();
      beginMeetingSuccessPolling();
    }, true);
  }

  function installMeetingSuccessWatcher() {
    if (window.__ccheckMeetingSuccessObserver) return;
    const observer = new MutationObserver(() => {
      checkMeetingFreshSuccessMessage();
    });
    window.__ccheckMeetingSuccessObserver = observer;
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    window.addEventListener('beforeunload', () => observer.disconnect(), { once: true });
  }

  function checkMeetingFreshSuccessMessage() {
    if (!isMeetingSubmitPage()) return;
    if (hasMeetingSuccessMessage()) scheduleMeetingSuccessNavigation();
  }

  function beginMeetingSuccessPolling() {
    if (window.__ccheckMeetingSuccessPolling) return;
    window.__ccheckMeetingSuccessPolling = true;
    const startedAt = Date.now();
    const poll = () => {
      if (!isMeetingSubmitPage()) {
        window.__ccheckMeetingSuccessPolling = false;
        return;
      }
      if (hasMeetingSuccessMessage()) {
        window.__ccheckMeetingSuccessPolling = false;
        scheduleMeetingSuccessNavigation();
        return;
      }
      if (Date.now() - startedAt > 30000 || window.__ccheckMeetingReturning) {
        window.__ccheckMeetingSuccessPolling = false;
        return;
      }
      window.setTimeout(poll, 300);
    };
    poll();
  }

  function hasMeetingSuccessMessage() {
    const messages = getMeetingMessageElements().concat(getVisibleMeetingSuccessTextElements());
    return messages.some((element) => {
      if (window.__ccheckIgnoredMeetingSuccessElements?.has?.(element)) return false;
      return isMeetingSuccessTextElement(element);
    });
  }

  function getMeetingMessageElements() {
    return Array.from(document.querySelectorAll([
      '.el-message',
      '.el-notification',
      '[role="alert"]',
      '.el-message-box',
      '.el-dialog__body',
      '.el-dialog__footer',
      '.el-form-item__error',
      '.ant-message-notice',
      '.ant-notification-notice',
      '.ivu-message-notice',
      '.ivu-notice',
      '.message',
      '.notice',
      '.notification',
      '.toast'
    ].join(',')));
  }

  function getVisibleMeetingSuccessTextElements() {
    const elements = [];
    const walker = document.createTreeWalker(
      document.body || document.documentElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const text = normalizeName(node.nodeValue);
          if (!text || !/成功|新增成功|保存成功|提交成功|操作成功|已保存|已提交|已添加|添加成功/.test(text)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (/失败|错误|异常|不能为空|请选择|请先|请填写/.test(text)) {
            return NodeFilter.FILTER_REJECT;
          }
          const parent = node.parentElement;
          if (!parent || parent.closest('#ccheck-meeting-draft-note')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let node = walker.nextNode();
    while (node) {
      const element = node.parentElement?.closest?.('.el-message, .el-notification, [role="alert"], .ant-message-notice, .message, .notice, .notification, .toast, div, span')
        || node.parentElement;
      if (element && isVisibleElement(element)) elements.push(element);
      node = walker.nextNode();
    }
    return elements;
  }

  function isMeetingSuccessTextElement(element) {
    if (!isVisibleElement(element)) return false;
    const text = normalizeName(textOf(element));
    return /成功|新增成功|保存成功|提交成功|操作成功|已保存|已提交|已添加|添加成功/.test(text)
      && !/失败|错误|异常|不能为空|请选择|请先|请填写/.test(text);
  }

  function markExistingMeetingSuccessMessagesIgnored() {
    const ignored = new WeakSet();
    getMeetingMessageElements().forEach((element) => {
      if (isMeetingSuccessTextElement(element)) {
        ignored.add(element);
      }
    });
    window.__ccheckIgnoredMeetingSuccessElements = ignored;
  }

  function checkMeetingSubmitSuccess(input, body, url) {
    if (!isMeetingSubmitNetworkEvent(input, url)) return;
    window.__ccheckMeetingSubmitClickedAt = Date.now();
    beginMeetingSuccessPolling();
  }

  function isMeetingSubmitNetworkEvent(input, url) {
    if (!isMeetingSubmitPage()) return false;
    const method = String(input.method || '').toUpperCase();
    if (!['POST', 'PUT', 'PATCH'].includes(method)) return false;
    if (!/meeting/i.test(String(url || ''))) return false;
    const status = Number(input.status);
    return Number.isFinite(status) && status >= 200 && status < 300;
  }

  function scheduleMeetingIndexReturn() {
    if (window.__ccheckMeetingReturning) return;
    window.__ccheckMeetingReturning = true;
    window.setTimeout(() => {
      clearMeetingDraftCache();
      location.href = `${location.origin}/meeting/index`;
    }, 700);
  }

  function clearMeetingDraftCache() {
    try {
      localStorage.removeItem(MEETING_DRAFT_STORAGE_KEY);
    } catch (_) {
      // Ignore storage cleanup failures.
    }
  }

  function clearRecurringMeetingQueue() {
    try {
      localStorage.removeItem('campus-commute-checker.recurringMeetingQueue');
    } catch (_) {
      // Ignore storage failures.
    }
  }

  function removeMeetingDraftUrlParam() {
    if (!new URLSearchParams(location.search).has('ccheckDraft')) return;
    const url = new URL(location.href);
    url.searchParams.delete('ccheckDraft');
    history.replaceState(history.state, document.title, `${url.pathname}${url.search}${url.hash}`);
  }

  function scheduleMeetingSuccessNavigation() {
    clearRecurringMeetingQueue();
    scheduleMeetingIndexReturn();
  }

  function isMeetingSubmitPage() {
    return location.pathname.startsWith('/meeting/add') || isMeetingAddPage();
  }

  function readMeetingDraftFromPage() {
    const draftParam = new URLSearchParams(location.search).get('ccheckDraft');
    const fromUrl = decodeMeetingDraft(draftParam);
    if (fromUrl) return fromUrl;
    if (!draftParam && !location.pathname.startsWith('/meeting/add')) return null;

    try {
      const raw = localStorage.getItem(MEETING_DRAFT_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && parsed.source === 'campus-commute-checker' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  async function applyMeetingDraftWhenReady(draft) {
    for (let index = 0; index < 30; index += 1) {
      if (applyMeetingDraftToForm(draft)) {
        removeMeetingDraftUrlParam();
        state.currentMeetingDraft = draft;
        syncMeetingDraftToAttendeeHelper(draft);
        clearMeetingDraftCache();
        scheduleMeetingDraftFieldAutoFill(draft);
        scheduleMeetingDraftAutoSelect(draft);
        showMeetingDraftNote(draft, formatMeetingDraftNoteMessage({
          selected: [],
          missed: getMeetingDraftTeachers(draft),
          skipped: true,
          reason: '已自动带入参会人名单，稍后会自动选择一次。'
        }));
        return;
      }
      await sleep(200);
    }
    showMeetingDraftNote(draft, '已收到会议草稿，但暂时没有找到新建会议表单。请确认当前页面是“会议-新建”。');
  }

  function scheduleMeetingDraftFieldAutoFill(draft) {
    const key = [
      draft?.date || '',
      draft?.endDate || '',
      draft?.startTime || '',
      draft?.endTime || '',
      draft?.meetingMode || '',
      draft?.meetingCampus || '',
      draft?.timePeriod || ''
    ].join('::');
    if (state.currentMeetingDraftFieldAutoFillKey === key) return;
    state.currentMeetingDraftFieldAutoFillKey = key;

    window.setTimeout(async () => {
      if (!isMeetingSubmitPage()) return;
      const fieldResult = await autoFillMeetingDraftExtraFields(draft);
      if (!fieldResult.attempted.length) return;
      showMeetingDraftNote(draft, formatMeetingDraftNoteMessage({
        selected: [],
        missed: getMeetingDraftTeachers(draft),
        skipped: true,
        reason: '已自动带入参会人名单，稍后会自动选择一次。'
      }, fieldResult));
    }, 300);
  }

  function syncMeetingDraftToAttendeeHelper(draft) {
    const helper = document.getElementById('ccheck-attendee-helper');
    if (!helper) return;
    prefillMeetingAttendeeHelper(helper, draft);
  }

  function scheduleMeetingDraftAutoSelect(draft) {
    const teachers = getMeetingDraftTeachers(draft);
    if (!teachers.length) return;
    const key = [
      draft?.date || '',
      draft?.startTime || '',
      draft?.endTime || '',
      teachers.join('|')
    ].join('::');
    if (state.currentMeetingDraftAutoSelectKey === key) return;
    state.currentMeetingDraftAutoSelectKey = key;

    window.setTimeout(async () => {
      if (!isMeetingSubmitPage()) return;
      setMeetingAttendeeHelperResult(`页面稳定后自动选择 ${teachers.length} 位参会人...`);
      const ready = await waitForMeetingAttendeeReady();
      if (!ready) {
        const result = { selected: [], missed: teachers, skipped: true, reason: '参会人控件暂时未稳定，请手动点击“选择参会人”。' };
        showMeetingDraftNote(draft, formatMeetingDraftNoteMessage(result));
        setMeetingAttendeeHelperResult(formatMeetingAttendeeHelperResult(result));
        return;
      }
      const result = await trySelectMeetingAttendees({ teachers });
      showMeetingDraftNote(draft, formatMeetingDraftNoteMessage(result));
      setMeetingAttendeeHelperResult(formatMeetingAttendeeHelperResult(result));
    }, CONFIG.meetingAttendeeAutoSelectDelayMs);
  }

  async function waitForMeetingAttendeeReady() {
    for (let index = 0; index < CONFIG.meetingAttendeeAutoSelectReadyRetries; index += 1) {
      const item = findMeetingFormItem('参会人');
      const input = item?.querySelector('input');
      if (item && input && !input.disabled) return true;
      await sleep(CONFIG.meetingAttendeeAutoSelectReadyIntervalMs);
    }
    return false;
  }

  function applyMeetingDraftToForm(draft) {
    if (!draft || !isMeetingAddPage()) return false;
    const fields = [
      { label: '会议名称', value: draft.meetingName || '', kind: 'text', required: false },
      { label: '起始时间', value: draft.startTime, kind: 'time', required: true },
      { label: '结束时间', value: draft.endTime, kind: 'time', required: true }
    ];

    const dateOk = draft.endDate
      ? setMeetingFormDateRange('会议日期', draft.date, draft.endDate)
      : setMeetingFormInput('会议日期', draft.date, 'date');
    const results = fields.map((field) => ({
      field,
      ok: setMeetingFormInput(field.label, field.value, field.kind)
    }));
    return dateOk && results.filter((item) => item.field.required).every((item) => item.ok);
  }

  async function autoFillMeetingDraftExtraFields(draft) {
    const result = { attempted: [], filled: [], missed: [] };
    const tasks = [
      { key: 'meetingMode', label: '会议形式', values: getMeetingModeFillValues(draft) },
      { key: 'timePeriod', label: '时间段', values: [draft?.timePeriod].filter(Boolean) },
      { key: 'weekday', label: '星期', values: getMeetingWeekdayFillValues(draft), select: selectMeetingWeekdayOption },
      { key: 'meetingCampus', label: '校区', values: getMeetingCampusFillValues(draft) }
    ];

    for (const task of tasks) {
      if (!task.values.length) continue;
      result.attempted.push(task.label);
      const ok = task.select
        ? await task.select(task.values)
        : await selectMeetingFormOption(task.label, task.values);
      (ok ? result.filled : result.missed).push(task.label);
      await sleep(160);
    }

    const classroomPrefixes = getMeetingDraftClassroomPrefixes(draft);
    if (classroomPrefixes.length) {
      await waitForMeetingClassroomReady(2200);
      result.attempted.push('教室');
      const classroomResult = await selectFirstMeetingClassroomByPrefixes(classroomPrefixes);
      const roomOk = classroomResult.ok;
      result.classroomDropdown = classroomResult.dropdown;
      (roomOk ? result.filled : result.missed).push('教室');
      if (roomOk && getMeetingCampusFillValues(draft).length) {
        await sleep(180);
        await selectMeetingFormOption('校区', getMeetingCampusFillValues(draft));
      }
    }
    return result;
  }

  function getMeetingModeFillValues(draft) {
    if (draft?.meetingMode === 'offline') return ['线下'];
    if (draft?.meetingMode === 'online') return ['线上'];
    return [];
  }

  function getMeetingCampusFillValues(draft) {
    return Array.from(new Set([
      draft?.meetingCampus || '',
      ...(Array.isArray(draft?.meetingCampusAliases) ? draft.meetingCampusAliases : [])
    ]
      .map((item) => String(item || '').trim())
      .filter((item) => item && !/^[A-Z]+$/i.test(item))));
  }

  function getMeetingWeekdayFillValues(draft) {
    return Array.from(new Set([
      ...(Array.isArray(draft?.weekdayValues) ? draft.weekdayValues : []),
      draft?.weekday || ''
    ]
      .map((item) => String(item || '').trim())
      .filter(Boolean)));
  }

  function getMeetingDraftClassroomPrefixes(draft) {
    return Array.from(new Set([
      ...(Array.isArray(draft?.meetingClassroomPrefixes) ? draft.meetingClassroomPrefixes : []),
      draft?.meetingClassroomPrefix || ''
    ].map((item) => String(item || '').trim()).filter(Boolean)));
  }

  async function selectMeetingFormOption(label, values) {
    const item = findMeetingFormItem(label);
    const targets = normalizeMeetingOptionTargets(values, label);
    if (!item || !targets.length) return false;
    if (isMeetingFormOptionSelected(item, targets)) return true;
    if (clickMeetingInlineOption(item, targets)) {
      await sleep(160);
      if (isMeetingFormOptionSelected(item, targets)) return true;
    }
    return selectMeetingDropdownOption(item, targets);
  }

  async function selectMeetingWeekdayOption(values) {
    const item = findMeetingFormItem('星期');
    const targets = normalizeMeetingOptionTargets(values, '星期');
    if (!item || !targets.length) return false;
    if (isMeetingFormOptionSelected(item, targets)) return true;
    if (clickMeetingInlineOption(item, targets)) {
      await sleep(160);
      if (isMeetingFormOptionSelected(item, targets)) return true;
    }
    return selectMeetingDropdownOption(item, targets, { allowSearch: false, closeAfterSelect: true });
  }

  function normalizeMeetingOptionTargets(values, label = '') {
    const exactOnly = label === '校区' || label === '星期';
    return (Array.isArray(values) ? values : [values])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .map((value) => ({ raw: value, key: normalizeName(value), exactOnly }))
      .filter((value) => value.key);
  }

  function isMeetingFormOptionSelected(item, targets) {
    const inputValues = Array.from(item.querySelectorAll('input, textarea'))
      .filter((input) => !input.classList.contains('el-cascader__search-input'))
      .map((input) => normalizeMeetingOptionText(input.value || input.getAttribute('value') || ''))
      .filter(Boolean);
    const visibleValues = Array.from(item.querySelectorAll([
      '.el-select__tags-text',
      '.el-tag',
      '.el-select__selected-item',
      '.el-cascader__label',
      '.is-selected',
      '.is-checked',
      '[aria-selected="true"]',
      '[aria-checked="true"]',
      '[title]'
    ].join(',')))
      .filter((element) => isVisibleElement(element))
      .map((element) => normalizeMeetingOptionText(textOf(element) || element.getAttribute('title') || ''))
      .filter(Boolean);
    const context = findMeetingFormVueContext(item);
    const modelValues = flattenMeetingModelValues(context?.model && context.prop ? getValueByPath(context.model, context.prop) : '')
      .map((value) => normalizeMeetingOptionText(value))
      .filter(Boolean);
    const values = [...inputValues, ...visibleValues, ...modelValues];
    return targets.some((target) => (
      values.some((value) => {
        const targetKey = normalizeMeetingOptionText(target.raw);
        return target.exactOnly ? value === targetKey : value === targetKey || value.includes(targetKey);
      })
    ));
  }

  function clickMeetingInlineOption(item, targets) {
    const options = Array.from(item.querySelectorAll([
      '.el-radio',
      '.el-radio-button',
      '.el-checkbox',
      'label',
      'button',
      '[role="radio"]',
      '[role="option"]'
    ].join(',')))
      .filter((option) => isVisibleElement(option))
      .filter((option) => !option.classList.contains('is-disabled') && option.getAttribute('aria-disabled') !== 'true')
      .map((option) => ({ option, score: scoreMeetingOptionText(textOf(option), targets) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    const target = options[0]?.option;
    if (!target) return false;
    clickElementLikeUser(target);
    return true;
  }

  async function selectMeetingDropdownOption(item, targets, options = {}) {
    const trigger = findMeetingDropdownTrigger(item);
    if (!trigger) return false;
    closeMeetingOpenDropdowns(trigger);
    await sleep(140);
    const triggerInput = getMeetingDropdownTriggerInput(trigger);
    (triggerInput || trigger).focus?.({ preventScroll: true });
    clickElementLikeUser(triggerInput || trigger);
    await waitForMeetingDropdownStable(trigger, 200, 1300);
    const searchTargets = options.allowSearch === false
      ? [null]
      : (isMeetingDropdownSearchableTrigger(trigger) ? targets : [null]);
    for (const target of searchTargets) {
      if (target) {
        setNativeInputValue(triggerInput || trigger, target.raw);
        await waitForMeetingDropdownStable(trigger, 260, 1500);
      }
      const option = await waitForMeetingDropdownOption(trigger, targets, 1800);
      if (option) {
        gentlyRevealElement(option);
        await sleep(60);
        clickElementLikeUser(option, getMeetingOptionClickPoint(option));
        await sleep(220);
        if (isMeetingFormOptionSelected(item, targets)) {
          if (options.closeAfterSelect) {
            sendKey(triggerInput || trigger, 'Escape');
            triggerInput?.blur?.();
          }
          return true;
        }
      }
    }
    sendKey(trigger, 'Escape');
    return false;
  }

  function closeMeetingOpenDropdowns(exceptElement) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    const exceptItem = exceptElement?.closest?.('.el-form-item') || null;
    Array.from(document.querySelectorAll('.el-cascader__search-input, .el-select input, .el-cascader input'))
      .filter((input) => !exceptItem || !exceptItem.contains(input))
      .forEach((input) => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
        input.blur?.();
      });
  }

  async function waitForMeetingDropdownStable(trigger, stableMs = 360, timeoutMs = 1800) {
    const startedAt = Date.now();
    let stableSince = 0;
    let lastSignature = '';
    while (Date.now() - startedAt <= timeoutMs) {
      const signature = getMeetingDropdownPanelsSignature(trigger);
      if (signature && signature === lastSignature) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) return true;
      } else {
        lastSignature = signature;
        stableSince = 0;
      }
      await sleep(90);
    }
    return false;
  }

  function getMeetingDropdownPanelsSignature(trigger) {
    const anchorRect = trigger?.getBoundingClientRect?.();
    return findAttendeeDropdownPanels(anchorRect)
      .map((panel) => Array.from(panel.querySelectorAll([
        '.el-select-dropdown__item',
        '.el-cascader-node',
        '.el-cascader__suggestion-item',
        '.el-autocomplete-suggestion li',
        'li',
        '[role="option"]',
        '[role="treeitem"]'
      ].join(',')))
        .filter((option) => isVisibleElement(option))
        .map((option) => normalizeMeetingOptionText(textOf(option)))
        .filter(Boolean)
        .join('|'))
      .filter(Boolean)
      .join('||');
  }

  function getMeetingOptionClickPoint(option) {
    const rect = option.getBoundingClientRect();
    return {
      clientX: Math.round(rect.left + Math.min(Math.max(rect.width / 2, 12), Math.max(rect.width - 12, 12))),
      clientY: Math.round(rect.top + rect.height / 2)
    };
  }

  function findMeetingDropdownTrigger(item) {
    const triggers = Array.from(item.querySelectorAll([
      '.el-select',
      '.el-cascader',
      'input:not(.el-cascader__search-input)',
      '[role="combobox"]',
      '.el-input'
    ].join(',')))
      .filter((element) => isVisibleElement(element))
      .filter((element) => !element.disabled);
    return triggers.find((element) => element.classList?.contains('el-select') || element.classList?.contains('el-cascader'))
      || triggers.find((element) => element.tagName === 'INPUT')
      || triggers[0]
      || null;
  }

  function isMeetingDropdownSearchableTrigger(trigger) {
    if (!trigger) return false;
    if (trigger.tagName === 'INPUT') return !trigger.readOnly;
    const input = trigger.querySelector?.('input:not([readonly]):not(.el-cascader__search-input)');
    return Boolean(input && !input.disabled);
  }

  function getMeetingDropdownTriggerInput(trigger) {
    if (!trigger) return null;
    if (trigger.tagName === 'INPUT') return trigger;
    return trigger.querySelector?.('input:not(.el-cascader__search-input), input') || null;
  }

  async function waitForMeetingDropdownOption(trigger, targets, timeoutMs) {
    const startedAt = Date.now();
    let stableOption = null;
    let stableText = '';
    let stableSince = 0;
    while (Date.now() - startedAt <= timeoutMs) {
      const option = findMeetingDropdownOption(trigger, targets);
      const optionText = option ? normalizeMeetingOptionText(textOf(option)) : '';
      if (option && option === stableOption && optionText === stableText) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 220) return option;
      } else {
        stableOption = option;
        stableText = optionText;
        stableSince = 0;
      }
      await sleep(90);
    }
    return null;
  }

  function findMeetingDropdownOption(trigger, targets) {
    const anchorRect = trigger?.getBoundingClientRect?.();
    const panels = findAttendeeDropdownPanels(anchorRect);
    for (const panel of panels) {
      const options = Array.from(panel.querySelectorAll([
        '.el-select-dropdown__item',
        '.el-cascader-node',
        '.el-cascader__suggestion-item',
        '.el-autocomplete-suggestion li',
        'li',
        '[role="option"]',
        '[role="treeitem"]'
      ].join(',')))
        .filter((option) => isVisibleElement(option))
        .filter((option) => !option.classList.contains('is-disabled') && option.getAttribute('aria-disabled') !== 'true')
        .map((option) => ({ option, score: scoreMeetingOptionText(textOf(option), targets) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);
      if (options.length) return options[0].option;
    }
    return null;
  }

  function scoreMeetingOptionText(text, targets) {
    const key = normalizeMeetingOptionText(text);
    if (!key) return 0;
    return Math.max(0, ...targets.map((target) => {
      const targetKey = normalizeMeetingOptionText(target.raw);
      if (key === targetKey) return 100;
      if (target.exactOnly) return 0;
      if (key.startsWith(targetKey)) return 80;
      if (key.includes(targetKey)) return 60;
      if (targetKey.includes(key) && key.length >= 2) return 20;
      return 0;
    }));
  }

  function normalizeMeetingOptionText(text) {
    return normalizeName(text).replace(/校区$/u, '');
  }

  async function selectFirstMeetingClassroomByPrefixes(prefixes) {
    const allowFallback = !prefixes.some((prefix) => normalizeName(prefix).toUpperCase() === 'V');
    const fallbackPrefixes = prefixes.length && allowFallback ? [...prefixes, ''] : [...prefixes];
    const attempts = [];
    for (const prefix of prefixes) {
      const result = await selectFirstMeetingClassroomByPrefix(prefix);
      attempts.push(result.dropdown);
      if (result.ok) return { ok: true, dropdown: mergeMeetingClassroomDropdownAttempts(prefixes, attempts) };
    }
    if (prefixes.length && allowFallback) {
      const result = await selectFirstMeetingClassroomByPrefix('');
      attempts.push(result.dropdown);
      if (result.ok) return { ok: true, dropdown: mergeMeetingClassroomDropdownAttempts(fallbackPrefixes, attempts) };
    }
    return { ok: false, dropdown: mergeMeetingClassroomDropdownAttempts(fallbackPrefixes, attempts) };
  }

  async function waitForMeetingClassroomReady(timeoutMs) {
    const item = findMeetingFormItem('教室');
    if (!item) {
      await sleep(420);
      return false;
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const text = normalizeName(textOf(item));
      const inputValue = Array.from(item.querySelectorAll('input'))
        .map((input) => normalizeName(input.value || input.getAttribute('value') || ''))
        .filter(Boolean)
        .join('');
      if (!text.includes('无数据') || inputValue) return true;
      await sleep(120);
    }
    return false;
  }

  async function selectFirstMeetingClassroomByPrefix(prefix) {
    const item = findMeetingFormItem('教室');
    const dropdown = createMeetingClassroomDropdownDebug(prefix);
    if (!item) return { ok: false, dropdown: { ...dropdown, reason: '未找到教室字段' } };
    const trigger = findMeetingDropdownTrigger(item);
    if (!trigger) return { ok: false, dropdown: { ...dropdown, reason: '未找到教室下拉触发器' } };
    const input = getMeetingDropdownTriggerInput(trigger) || trigger;
    input.focus?.({ preventScroll: true });
    clickElementLikeUser(input);
    await waitForMeetingDropdownStable(trigger, 200, 1300);
    resetMeetingClassroomDropdownScroll(trigger);
    await sleep(80);
    const match = await waitForMeetingClassroomOption(trigger, prefix, 3000);
    Object.assign(dropdown, match.debug);
    if (!match.option) {
      sendKey(trigger, 'Escape');
      return { ok: false, dropdown };
    }
    const option = match.option;
    gentlyRevealElement(option);
    await sleep(60);
    clickElementLikeUser(option, getMeetingOptionClickPoint(option));
    await sleep(220);
    if (isMeetingClassroomSelected(item, prefix)) return { ok: true, dropdown };
    sendKey(trigger, 'Escape');
    return { ok: false, dropdown: { ...dropdown, reason: '已点击教室选项，但表单未确认选中' } };
  }

  async function waitForMeetingClassroomOption(trigger, prefix, timeoutMs) {
    const startedAt = Date.now();
    let stableOption = null;
    let stableText = '';
    let stableSince = 0;
    let lastDebug = createMeetingClassroomDropdownDebug(prefix);
    let scrolls = 0;
    const debugAttempts = [];
    while (Date.now() - startedAt <= timeoutMs) {
      const found = findMeetingClassroomOption(trigger, prefix);
      debugAttempts.push(found.debug);
      lastDebug = found.debug;
      const option = found.option;
      const optionText = option ? normalizeName(textOf(option)).toUpperCase() : '';
      if (option && option === stableOption && optionText === stableText) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 220) {
          const debug = mergeMeetingClassroomDropdownAttempts([prefix], debugAttempts);
          debug.scrolls = scrolls;
          return { option, debug };
        }
      } else {
        stableOption = option;
        stableText = optionText;
        stableSince = 0;
      }
      const scrollResult = option ? { moved: false, trace: [] } : scrollMeetingClassroomDropdown(trigger);
      if (scrollResult.trace?.length) debugAttempts.push(createMeetingClassroomScrollDebug(prefix, scrollResult.trace));
      if (!option && scrollResult.moved) {
        scrolls += 1;
        await sleep(180);
        continue;
      }
      await sleep(90);
    }
    const debug = mergeMeetingClassroomDropdownAttempts([prefix], debugAttempts);
    debug.scrolls = scrolls;
    return { option: null, debug: debugAttempts.length ? debug : lastDebug };
  }

  function findMeetingClassroomOption(trigger, prefix) {
    const expectedPrefix = normalizeName(prefix);
    const panels = findMeetingClassroomDropdownPanels(trigger);
    const debug = createMeetingClassroomDropdownDebug(prefix);
    for (const panel of panels) {
      const options = Array.from(panel.querySelectorAll([
        '.el-select-dropdown__item',
        '.el-cascader-node',
        '.el-cascader__suggestion-item',
        'li',
        '[role="option"]',
        '[role="treeitem"]'
      ].join(',')))
        .filter((item) => isVisibleElement(item))
        .filter((item) => !item.classList.contains('is-disabled') && item.getAttribute('aria-disabled') !== 'true');
      const records = options
        .filter((item) => isMeetingClassroomOptionInPanelViewport(item, panel))
        .map((item) => ({ item, text: normalizeName(textOf(item)), upper: normalizeName(textOf(item)).toUpperCase() }))
        .filter((record) => record.text);
      debug.total += records.length;
      records.forEach((record) => {
        if (debug.options.length < 12) debug.options.push(record.text);
        if (record.upper.startsWith('V') && debug.skippedV.length < 6) debug.skippedV.push(record.text);
      });
      const matched = records.find((record) => {
        if (record.upper.startsWith('V') && expectedPrefix.toUpperCase() !== 'V') return false;
        if (expectedPrefix === '会议室') return record.text.includes(expectedPrefix);
        return expectedPrefix ? record.upper.startsWith(expectedPrefix.toUpperCase()) : true;
      });
      if (matched) {
        debug.matched = matched.text;
        debug.reason = expectedPrefix ? `命中候选 ${expectedPrefix}` : '兜底命中第一个非 V 教室';
        return { option: matched.item, debug };
      }
    }
    debug.reason = debug.total ? '下拉已展开，但没有匹配的非 V 教室' : '下拉已展开，但没有检测到可用教室选项';
    return { option: null, debug };
  }

  function createMeetingClassroomDropdownDebug(prefix) {
    return {
      prefix: String(prefix || ''),
      total: 0,
      options: [],
      skippedV: [],
      scrollTrace: [],
      matched: '',
      reason: '',
      scrolls: 0
    };
  }

  function mergeMeetingClassroomDropdownAttempts(prefixes, attempts) {
    const records = (attempts || []).filter(Boolean);
    const last = records[records.length - 1] || createMeetingClassroomDropdownDebug('');
    return {
      prefixes: (prefixes || []).map((item) => String(item || '')),
      total: Math.max(0, ...records.map((item) => item.total || 0)),
      options: Array.from(new Set(records.flatMap((item) => item.options || []))).slice(0, 12),
      skippedV: Array.from(new Set(records.flatMap((item) => item.skippedV || []))).slice(0, 6),
      scrollTrace: records.flatMap((item) => item.scrollTrace || []).slice(-8),
      matched: records.find((item) => item.matched)?.matched || '',
      reason: records.find((item) => item.matched)?.reason || last.reason || '',
      scrolls: records.reduce((total, item) => total + (item.scrolls || 0), 0)
    };
  }

  function resetMeetingClassroomDropdownScroll(trigger) {
    findMeetingClassroomDropdownScrollers(trigger).forEach((scroller) => {
      if (scroller.scrollTop > 0) {
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
    });
  }

  function scrollMeetingClassroomDropdown(trigger) {
    const panels = findMeetingClassroomDropdownPanels(trigger);
    const scrollers = findMeetingClassroomDropdownScrollers(trigger);
    const targets = Array.from(new Set([...scrollers, ...panels, trigger].filter(Boolean)));
    const fallbackStep = 220;
    let moved = false;
    const trace = [];
    targets.forEach((target) => dispatchMeetingClassroomWheel(target, fallbackStep));
    scrollers.forEach((scroller) => {
      const oldTop = scroller.scrollTop;
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const step = Math.max(80, Math.round((scroller.clientHeight || 120) * 0.85));
      dispatchMeetingClassroomWheel(scroller, step);
      if (oldTop < maxTop - 2) {
        if (typeof scroller.scrollBy === 'function') {
          scroller.scrollBy({ top: step, behavior: 'auto' });
        }
        scroller.scrollTop = Math.min(maxTop, Math.max(scroller.scrollTop, oldTop + step));
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
      const newTop = scroller.scrollTop;
      trace.push({
        tag: getMeetingClassroomScrollerLabel(scroller),
        oldTop: Math.round(oldTop),
        newTop: Math.round(newTop),
        maxTop: Math.round(maxTop),
        moved: newTop !== oldTop
      });
      if (newTop !== oldTop || oldTop < maxTop - 2) moved = true;
    });
    if (!moved && targets.length) {
      sendKey(trigger, 'PageDown');
      trace.push({ tag: 'PageDown', oldTop: 0, newTop: 0, maxTop: 0, moved: true });
      moved = true;
    }
    return { moved, trace };
  }

  function createMeetingClassroomScrollDebug(prefix, trace) {
    const debug = createMeetingClassroomDropdownDebug(prefix);
    debug.scrollTrace = Array.isArray(trace) ? trace : [];
    debug.reason = debug.scrollTrace.length ? '已尝试滚动下拉继续检测' : '';
    return debug;
  }

  function findMeetingClassroomDropdownPanels(trigger) {
    return Array.from(new Set([
      ...findAttendeeDropdownPanels(trigger?.getBoundingClientRect?.()),
      ...Array.from(document.querySelectorAll([
        '.el-select-dropdown',
        '.el-cascader__dropdown',
        '.el-popper',
        '[x-placement]',
        '[data-popper-placement]'
      ].join(','))).filter((panel) => isVisibleElement(panel))
    ]));
  }

  function findMeetingClassroomDropdownScrollers(trigger) {
    const panels = findMeetingClassroomDropdownPanels(trigger);
    return Array.from(new Set(panels.flatMap((panel) => [
      panel,
      ...Array.from(panel.querySelectorAll([
        '.el-select-dropdown__wrap',
        '.el-scrollbar__wrap',
        '.el-cascader-menu__wrap',
        '.el-cascader-menu',
        '[role="listbox"]',
        '[role="tree"]'
      ].join(',')))
    ]))).filter((element) => isVisibleElement(element) && element.scrollHeight > element.clientHeight + 4);
  }

  function isMeetingClassroomOptionInPanelViewport(option, panel) {
    const optionRect = option?.getBoundingClientRect?.();
    if (!optionRect) return false;
    const scroller = option.closest?.('.el-select-dropdown__wrap, .el-scrollbar__wrap, .el-cascader-menu__wrap, .el-cascader-menu')
      || panel?.querySelector?.('.el-select-dropdown__wrap, .el-scrollbar__wrap, .el-cascader-menu__wrap, .el-cascader-menu')
      || panel;
    const viewportRect = scroller?.getBoundingClientRect?.() || panel?.getBoundingClientRect?.();
    if (!viewportRect) return true;
    return optionRect.bottom > viewportRect.top + 2
      && optionRect.top < viewportRect.bottom - 2
      && optionRect.right > viewportRect.left + 2
      && optionRect.left < viewportRect.right - 2;
  }

  function dispatchMeetingClassroomWheel(element, deltaY) {
    const rect = element?.getBoundingClientRect?.();
    const clientX = rect ? Math.round(rect.left + rect.width / 2) : 0;
    const clientY = rect ? Math.round(rect.top + rect.height / 2) : 0;
    try {
      element.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY
      }));
      element.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        deltaY,
        deltaMode: 0
      }));
    } catch (_) {
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  }

  function getMeetingClassroomScrollerLabel(element) {
    const className = String(element?.className || '').trim().replace(/\s+/g, '.');
    const role = element?.getAttribute?.('role') || '';
    return [
      String(element?.tagName || '').toLowerCase(),
      className ? `.${className}` : '',
      role ? `[role=${role}]` : ''
    ].join('').slice(0, 80) || 'unknown';
  }

  function isMeetingClassroomSelected(item, prefix) {
    const expectedPrefix = normalizeName(prefix).toUpperCase();
    const inputValues = Array.from(item.querySelectorAll('input, textarea'))
      .filter((input) => !input.classList.contains('el-cascader__search-input'))
      .map((input) => normalizeName(input.value || input.getAttribute('value') || '').toUpperCase())
      .filter(Boolean);
    const visibleValues = Array.from(item.querySelectorAll([
      '.el-select__tags-text',
      '.el-tag',
      '.el-select__selected-item',
      '.el-cascader__label',
      '.el-input__inner',
      '[title]'
    ].join(',')))
      .map((element) => normalizeName(textOf(element) || element.getAttribute('title') || '').toUpperCase())
      .filter(Boolean);
    const context = findMeetingFormVueContext(item);
    const modelValues = flattenMeetingModelValues(context?.model && context.prop ? getValueByPath(context.model, context.prop) : '')
      .map((value) => normalizeName(value).toUpperCase())
      .filter(Boolean);
    const values = [...inputValues, ...visibleValues, ...modelValues];
    if (!expectedPrefix) return values.some((value) => value && !value.startsWith('V'));
    return values.some((value) => value.startsWith(expectedPrefix) || value.includes(expectedPrefix));
  }

  function flattenMeetingModelValues(value) {
    if (Array.isArray(value)) return value.flatMap((item) => flattenMeetingModelValues(item));
    if (value && typeof value === 'object') {
      return Object.values(value).flatMap((item) => flattenMeetingModelValues(item));
    }
    return [String(value || '')];
  }

  function isMeetingAddPage() {
    return location.pathname.startsWith('/meeting/add')
      || Boolean(findMeetingFormItem('会议日期') && findMeetingFormItem('起始时间') && findMeetingFormItem('结束时间'));
  }

  function setMeetingFormInput(label, value, kind = 'text') {
    if (!value) return false;
    const item = findMeetingFormItem(label);
    const input = item?.querySelector('input:not(.el-cascader__search-input), textarea');
    if (!input || input.disabled) return false;
    setNativeInputValue(input, value);
    const modelSynced = syncElementMeetingField(item, input, value, kind);
    if (kind === 'date' || kind === 'time') setNativeInputValue(input, value);
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return kind === 'text' ? input.value === String(value) : modelSynced;
  }

  function setMeetingFormDateRange(label, startDate, endDate) {
    if (!startDate || !endDate) return false;
    const item = findMeetingFormItem(label);
    const inputs = Array.from(item?.querySelectorAll('input:not(.el-cascader__search-input)') || [])
      .filter((input) => !input.disabled);
    if (inputs.length < 2) return false;
    setNativeInputValue(inputs[0], startDate);
    setNativeInputValue(inputs[1], endDate);
    const modelSynced = syncElementMeetingDateRangeField(item, inputs, startDate, endDate);
    setNativeInputValue(inputs[0], startDate);
    setNativeInputValue(inputs[1], endDate);
    inputs.forEach((input) => input.dispatchEvent(new Event('blur', { bubbles: true })));
    return modelSynced || (inputs[0].value === String(startDate) && inputs[1].value === String(endDate));
  }

  function findMeetingFormItem(label) {
    return Array.from(document.querySelectorAll('.el-form-item')).find((item) => {
      const labelElement = item.querySelector('.el-form-item__label');
      const labelText = textOf(labelElement).replace(/[:：]$/, '');
      return labelText === label;
    }) || null;
  }

  function setNativeInputValue(input, value, options = {}) {
    const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value')?.set;
    if (setter) setter.call(input, String(value));
    else input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (options.blur) input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function syncElementMeetingField(item, input, value, kind) {
    const component = findMeetingFieldVueComponent(item, input, kind);
    const text = String(value || '').trim();
    const modelValue = toElementMeetingModelValue(value, kind, component);

    if (component) {
      syncElementMeetingComponent(component, input, text, modelValue, kind);
    }

    const context = findMeetingFormVueContext(item);
    if (context?.model && context.prop) {
      setValueByPath(context.model, context.prop, modelValue, context.formItemVm || context.formVm);
      if (!isMeetingModelValueFilled(getValueByPath(context.model, context.prop), value, kind) && modelValue !== String(value)) {
        setValueByPath(context.model, context.prop, String(value), context.formItemVm || context.formVm);
      }
      safeCall(() => {
        syncMeetingFormItemValidation(context, modelValue);
      });
      return isMeetingModelValueFilled(getValueByPath(context.model, context.prop), value, kind);
    }

    return Boolean(component);
  }

  function syncElementMeetingDateRangeField(item, inputs, startDate, endDate) {
    const component = findMeetingFieldVueComponent(item, inputs[0], 'date');
    const modelValue = toElementMeetingDateRangeModelValue(startDate, endDate, component);
    if (component) {
      safeCall(() => {
        if ('userInput' in component) component.userInput = [startDate, endDate];
        component.handleInput?.(modelValue);
        component.emitInput?.(modelValue);
        component.$emit?.('input', modelValue);
        if (component.picker && 'value' in component.picker) component.picker.value = modelValue;
        component.handleChange?.(modelValue);
        component.emitChange?.(modelValue);
        component.$emit?.('change', modelValue);
        component.dispatch?.('ElFormItem', 'el.form.change', [modelValue]);
        if ('pickerVisible' in component) component.pickerVisible = false;
        component.$forceUpdate?.();
        component.$nextTick?.(() => {
          setNativeInputValue(inputs[0], startDate);
          setNativeInputValue(inputs[1], endDate);
        });
      });
    }

    const context = findMeetingFormVueContext(item);
    if (context?.model && context.prop) {
      setValueByPath(context.model, context.prop, modelValue, context.formItemVm || context.formVm);
      safeCall(() => {
        syncMeetingFormItemValidation(context, modelValue);
      });
      return isMeetingDateRangeModelFilled(getValueByPath(context.model, context.prop), startDate, endDate);
    }

    return Boolean(component);
  }

  function syncElementMeetingComponent(component, input, text, modelValue, kind) {
    safeCall(() => {
      if (kind === 'date' || kind === 'time') {
        if ('userInput' in component) component.userInput = text;
        component.handleInput?.(text);
        component.emitInput?.(modelValue);
        component.$emit?.('input', modelValue);
        if (component.picker && 'value' in component.picker) component.picker.value = modelValue;
        component.handleChange?.(modelValue);
        component.emitChange?.(modelValue);
        component.$emit?.('change', modelValue);
        component.dispatch?.('ElFormItem', 'el.form.change', [modelValue]);
        if ('pickerVisible' in component) component.pickerVisible = false;
      } else {
        component.$emit?.('input', modelValue);
        component.$emit?.('change', modelValue);
        component.handleInput?.(modelValue);
        component.handleChange?.(modelValue);
      }
      component.$forceUpdate?.();
      component.$nextTick?.(() => setNativeInputValue(input, text));
    });
  }

  function syncMeetingFormItemValidation(context, modelValue) {
    context.formItemVm?.clearValidate?.();
    if (context.formItemVm) {
      context.formItemVm.validateState = '';
      context.formItemVm.validateMessage = '';
      context.formItemVm.$forceUpdate?.();
      context.formItemVm.dispatch?.('ElFormItem', 'el.form.change', [modelValue]);
    }
    context.formVm?.clearValidate?.([context.prop]);
  }

  function findMeetingFieldVueComponent(item, input, kind) {
    const components = collectVueComponents(input, item);
    const matcher = kind === 'date'
      ? /date/i
      : kind === 'time'
        ? /time/i
        : /input/i;
    return components.find((component) => matcher.test(getVueComponentName(component)))
      || components.find((component) => /picker|select|input/i.test(getVueComponentName(component)))
      || null;
  }

  function findMeetingFormVueContext(item) {
    const components = collectVueComponents(item);
    const formItemVm = components.find((component) => {
      const name = getVueComponentName(component);
      return name === 'ElFormItem' || Boolean(component.prop && component.elForm);
    });
    const formVm = formItemVm?.elForm
      || components.find((component) => getVueComponentName(component) === 'ElForm')
      || null;
    const prop = formItemVm?.prop || '';
    return { formItemVm, formVm, prop, model: formVm?.model || formItemVm?.elForm?.model || null };
  }

  function collectVueComponents(...roots) {
    const seen = new Set();
    const components = [];
    const addComponent = (component) => {
      let current = component;
      while (current && !seen.has(current)) {
        seen.add(current);
        components.push(current);
        current = current.$parent;
      }
    };

    roots.filter(Boolean).forEach((root) => {
      addComponent(root.__vue__);
      root.querySelectorAll?.('*').forEach((element) => addComponent(element.__vue__));
    });
    return components;
  }

  function getVueComponentName(component) {
    return String(component?.$options?.componentName || component?.$options?.name || '');
  }

  function toElementMeetingModelValue(value, kind, component) {
    const text = String(value || '').trim();
    const valueFormat = component?.valueFormat;
    if (valueFormat === 'timestamp') {
      const parsed = kind === 'date' ? parseDateValue(text) : parseTimeValue(text);
      return parsed ? parsed.getTime() : text;
    }
    if (valueFormat) return text;
    if (kind === 'date' && /date/i.test(getVueComponentName(component))) {
      return parseDateValue(text) || text;
    }
    if (kind === 'time' && /timepicker/i.test(getVueComponentName(component))) {
      return parseTimeValue(text) || text;
    }
    return text;
  }

  function toElementMeetingDateRangeModelValue(startDate, endDate, component) {
    const startText = String(startDate || '').trim();
    const endText = String(endDate || '').trim();
    if (component?.valueFormat === 'timestamp') {
      const start = parseDateValue(startText);
      const end = parseDateValue(endText);
      return [start ? start.getTime() : startText, end ? end.getTime() : endText];
    }
    if (component?.valueFormat) return [startText, endText];
    if (/date/i.test(getVueComponentName(component))) {
      return [parseDateValue(startText) || startText, parseDateValue(endText) || endText];
    }
    return [startText, endText];
  }

  function parseDateValue(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function parseTimeValue(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const date = new Date(1970, 0, 1, Number(match[1]), Number(match[2]), 0, 0);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function setValueByPath(root, path, value, vm) {
    const parts = pathToParts(path);
    if (!root || !parts.length) return false;
    let target = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index];
      if (target[key] == null || typeof target[key] !== 'object') {
        if (vm?.$set) vm.$set(target, key, {});
        else target[key] = {};
      }
      target = target[key];
    }
    const last = parts[parts.length - 1];
    if (vm?.$set) vm.$set(target, last, value);
    else target[last] = value;
    return true;
  }

  function getValueByPath(root, path) {
    return pathToParts(path).reduce((target, key) => target == null ? undefined : target[key], root);
  }

  function pathToParts(path) {
    return String(path || '').replace(/\[(\w+)\]/g, '.$1').split('.').filter(Boolean);
  }

  function isMeetingModelValueFilled(actual, expected, kind) {
    if (actual == null || actual === '') return false;
    const expectedText = String(expected || '').trim();
    if (actual instanceof Date) {
      if (Number.isNaN(actual.getTime())) return false;
      if (kind === 'date') return formatDateValue(actual) === expectedText;
      if (kind === 'time') return formatMinutes(actual.getHours() * 60 + actual.getMinutes()) === expectedText;
    }
    if ((typeof actual === 'number' && Number.isFinite(actual)) || /^\d{11,}$/.test(String(actual).trim())) {
      const date = new Date(Number(actual));
      if (!Number.isNaN(date.getTime())) {
        if (kind === 'date') return formatDateValue(date) === expectedText;
        if (kind === 'time') return formatMinutes(date.getHours() * 60 + date.getMinutes()) === expectedText;
      }
    }
    const actualText = String(actual).trim();
    if (kind === 'date') {
      const dateText = actualText.match(/\d{4}-\d{2}-\d{2}/)?.[0];
      if (dateText === expectedText) return true;
    }
    return actualText === expectedText || actualText.includes(expectedText);
  }

  function isMeetingDateRangeModelFilled(actual, startDate, endDate) {
    if (!Array.isArray(actual) || actual.length < 2) return false;
    return isMeetingModelValueFilled(actual[0], startDate, 'date')
      && isMeetingModelValueFilled(actual[1], endDate, 'date');
  }

  function formatDateValue(date) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function safeCall(fn) {
    try {
      return fn();
    } catch (_) {
      return undefined;
    }
  }

  async function trySelectMeetingAttendees(draft) {
    const teachers = Array.isArray(draft?.teachers) ? draft.teachers.filter(Boolean) : [];
    if (!teachers.length) return { selected: [], missed: [], skipped: true };

    const selected = [];
    const missed = [];
    for (const teacher of teachers) {
      const result = await selectMeetingAttendeeByName(teacher);
      if (result?.ok) selected.push(result.name || teacher);
      else missed.push(teacher);
      await sleep(CONFIG.meetingAttendeeBetweenTeachersMs);
    }
    return { selected, missed, skipped: false };
  }

  async function selectMeetingAttendeeByName(teacher) {
    const item = findMeetingFormItem('参会人');
    const triggerInput = item?.querySelector('input');
    if (!triggerInput || triggerInput.disabled) return { ok: false };
    if (isMeetingAttendeeSelected(item, teacher)) {
      return { ok: true, name: resolveSelectedMeetingAttendeeName(item, teacher) || teacher };
    }

    triggerInput.focus({ preventScroll: true });
    triggerInput.click();
    await sleep(120);
    const searchInput = item.querySelector('.el-cascader__search-input') || triggerInput;
    setNativeInputValue(searchInput, '');
    await waitForAttendeeDropdownIdle(item, searchInput, 220);
    setNativeInputValue(searchInput, teacher);
    await sleep(CONFIG.meetingAttendeeSearchSettleMs);

    const option = await waitForVisibleAttendeeOption(teacher, item, searchInput, CONFIG.meetingAttendeeDropdownTimeoutMs);
    if (!option) {
      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { ok: false };
    }

    const selected = await clickAttendeeOption(option, item, teacher, searchInput);
    if (!selected) searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitForAttendeeDropdownIdle(item, searchInput, 180);
    return selected
      ? { ok: true, name: resolveSelectedMeetingAttendeeName(item, teacher, option) || teacher }
      : { ok: false };
  }

  async function waitForVisibleAttendeeOption(teacher, item, searchInput, timeoutMs) {
    const startedAt = Date.now();
    let stableOption = null;
    let stableSince = 0;
    while (Date.now() - startedAt <= timeoutMs) {
      const option = findVisibleAttendeeOption(teacher, item, searchInput);
      if (option) {
        if (option === stableOption) {
          if (Date.now() - stableSince >= 260) return option;
        } else {
          stableOption = option;
          stableSince = Date.now();
        }
      } else {
        stableOption = null;
        stableSince = 0;
      }
      await sleep(120);
    }
    return null;
  }

  function findVisibleAttendeeOption(teacher, item, searchInput) {
    const expected = normalizeName(teacher);
    const anchor = searchInput || item?.querySelector('.el-cascader__search-input, input');
    const anchorRect = anchor?.getBoundingClientRect?.() || item?.getBoundingClientRect?.();
    const panels = findAttendeeDropdownPanels(anchorRect);

    for (const panel of panels) {
      const option = findMatchingAttendeeOptionInPanel(panel, expected);
      if (option) return option;
    }

    const candidates = Array.from(document.querySelectorAll([
      '.el-cascader-node',
      '.el-cascader__suggestion-item',
      '.el-select-dropdown__item',
      '.el-autocomplete-suggestion li',
      '.el-dropdown-menu__item',
      '.el-popper li',
      '[role="treeitem"]',
      '[role="option"]'
    ].join(',')))
      .filter((element) => isVisibleElement(element))
      .filter((element) => !anchorRect || isElementNearAnchor(element, anchorRect))
      .filter((element) => {
        const text = normalizeName(textOf(element));
        return text === expected || text.includes(expected);
      });
    return candidates[0] || null;
  }

  function findAttendeeDropdownPanels(anchorRect) {
    const panels = Array.from(document.querySelectorAll([
      '.el-cascader__dropdown',
      '.el-cascader__suggestion-panel',
      '.el-select-dropdown',
      '.el-autocomplete-suggestion',
      '.el-popper',
      '[x-placement]'
    ].join(',')))
      .filter((panel) => isVisibleElement(panel))
      .filter((panel) => !anchorRect || isDropdownPanelNearAnchor(panel, anchorRect));

    return panels.sort((a, b) => panelDistanceFromAnchor(a, anchorRect) - panelDistanceFromAnchor(b, anchorRect));
  }

  function findMatchingAttendeeOptionInPanel(panel, expected) {
    const options = Array.from(panel.querySelectorAll([
      '.el-cascader__suggestion-item',
      '.el-cascader-node',
      '.el-select-dropdown__item',
      '.el-autocomplete-suggestion li',
      '.el-dropdown-menu__item',
      'li',
      '[role="treeitem"]',
      '[role="option"]'
    ].join(',')))
      .filter((option) => isVisibleElement(option))
      .filter((option) => !option.classList.contains('is-disabled') && option.getAttribute('aria-disabled') !== 'true')
      .map((option) => ({ option, text: normalizeName(textOf(option)) }))
      .filter((entry) => entry.text === expected || entry.text.includes(expected));

    options.sort((a, b) => attendeeOptionScore(b.text, expected) - attendeeOptionScore(a.text, expected));
    return options[0]?.option || null;
  }

  function attendeeOptionScore(text, expected) {
    if (text === expected) return 40;
    if (text.endsWith(expected)) return 30;
    if (text.includes(`/${expected}`) || text.includes(`／${expected}`)) return 25;
    if (text.includes(expected)) return 10;
    return 0;
  }

  function isDropdownPanelNearAnchor(panel, anchorRect) {
    const rect = panel.getBoundingClientRect();
    const overlapsX = rect.right >= anchorRect.left - 24 && rect.left <= anchorRect.right + 24;
    const closeY = rect.bottom >= anchorRect.top - 12 && rect.top <= anchorRect.bottom + 420;
    return overlapsX && closeY;
  }

  function isElementNearAnchor(element, anchorRect) {
    const rect = element.getBoundingClientRect();
    const overlapsX = rect.right >= anchorRect.left - 32 && rect.left <= anchorRect.right + 32;
    const closeY = rect.bottom >= anchorRect.top - 16 && rect.top <= anchorRect.bottom + 420;
    return overlapsX && closeY;
  }

  function panelDistanceFromAnchor(panel, anchorRect) {
    if (!anchorRect) return 0;
    const rect = panel.getBoundingClientRect();
    return Math.abs(rect.top - anchorRect.bottom) + Math.abs(rect.left - anchorRect.left) / 4;
  }

  async function clickAttendeeOption(option, item, teacher, searchInput) {
    gentlyRevealElement(option);
    await sleep(80);

    const clickPoint = getAttendeeOptionClickPoint(option, teacher);
    const clickTarget = getSingleAttendeeClickTarget(option, clickPoint);
    clickElementLikeUser(clickTarget, clickPoint);
    if (await waitForMeetingAttendeeSelected(item, teacher, 2200)) return true;

    if (searchInput) {
      searchInput.focus?.({ preventScroll: true });
      sendKey(searchInput, 'ArrowDown');
      await sleep(100);
      sendKey(searchInput, 'Enter');
      if (await waitForMeetingAttendeeSelected(item, teacher, 1800)) return true;
    }
    return false;
  }

  function gentlyRevealElement(element) {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.right <= window.innerWidth) return;
    const scroller = findNearestScrollContainer(element);
    if (scroller) {
      const scrollerRect = scroller.getBoundingClientRect();
      if (rect.top < scrollerRect.top) scroller.scrollTop -= scrollerRect.top - rect.top + 8;
      if (rect.bottom > scrollerRect.bottom) scroller.scrollTop += rect.bottom - scrollerRect.bottom + 8;
      return;
    }
    element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  function findNearestScrollContainer(element) {
    let current = element?.parentElement || null;
    while (current && current !== document.body) {
      const style = getComputedStyle(current);
      const canScrollY = /(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight;
      if (canScrollY) return current;
      current = current.parentElement;
    }
    return null;
  }

  function getSingleAttendeeClickTarget(option, point) {
    const pointTarget = document.elementFromPoint(point.clientX, point.clientY);
    return pointTarget?.closest?.('.el-cascader__suggestion-item, .el-cascader-node, .el-select-dropdown__item, [role="option"], [role="treeitem"], li')
      || option.closest?.('.el-cascader__suggestion-item, .el-cascader-node, .el-select-dropdown__item, [role="option"], [role="treeitem"], li')
      || option;
  }

  function getAttendeeOptionClickPoint(option, teacher) {
    const expected = normalizeName(teacher);
    const optionRect = option.getBoundingClientRect();
    const label = Array.from(option.querySelectorAll('span, .el-cascader-node__label, .el-select-dropdown__item, [class*="label"]'))
      .filter((element) => isVisibleElement(element))
      .find((element) => normalizeName(textOf(element)).includes(expected));
    const targetRect = label?.getBoundingClientRect?.() || optionRect;
    const rawX = targetRect.left + targetRect.width / 2;
    const rawY = targetRect.top + targetRect.height / 2;
    return {
      clientX: Math.round(Math.max(optionRect.left + 8, Math.min(optionRect.right - 8, rawX))),
      clientY: Math.round(Math.max(optionRect.top + 4, Math.min(optionRect.bottom - 4, rawY)))
    };
  }

  function clickElementLikeUser(element, point) {
    if (!element || !isVisibleElement(element)) return;
    const rect = element.getBoundingClientRect();
    const clientX = Math.max(0, Math.min(window.innerWidth - 1, point?.clientX ?? rect.left + rect.width / 2));
    const clientY = Math.max(0, Math.min(window.innerHeight - 1, point?.clientY ?? rect.top + rect.height / 2));
    const pointTarget = document.elementFromPoint(clientX, clientY);
    const target = pointTarget?.closest?.('.el-select-dropdown__item, .el-cascader-node, .el-cascader__suggestion-item, .el-select, .el-cascader, input, button, label, [role="option"], [role="treeitem"], li')
      || pointTarget
      || element;
    target.focus?.({ preventScroll: true });
    dispatchPointerOrMouse(target, 'pointerover', clientX, clientY);
    dispatchPointerOrMouse(target, 'mouseover', clientX, clientY);
    dispatchPointerOrMouse(target, 'mousemove', clientX, clientY);
    dispatchPointerOrMouse(target, 'pointerdown', clientX, clientY);
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0, buttons: 1 }));
    dispatchPointerOrMouse(target, 'pointerup', clientX, clientY);
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0 }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0, detail: 1 }));
  }

  function dispatchPointerOrMouse(element, type, clientX, clientY) {
    const common = { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0 };
    if (typeof PointerEvent === 'function' && type.startsWith('pointer')) {
      element.dispatchEvent(new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    } else if (!type.startsWith('pointer')) {
      element.dispatchEvent(new MouseEvent(type, common));
    }
  }

  function sendKey(element, key) {
    element.focus?.({ preventScroll: true });
    const keyCodes = { Enter: 13, ArrowDown: 40, Escape: 27 };
    const code = key === 'Escape' ? 'Escape' : key;
    const keyCode = keyCodes[key] || 0;
    element.dispatchEvent(new KeyboardEvent('keydown', { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
  }

  async function waitForMeetingAttendeeSelected(item, teacher, timeoutMs) {
    const startedAt = Date.now();
    let stableSince = 0;
    while (Date.now() - startedAt <= timeoutMs) {
      if (isMeetingAttendeeSelected(item, teacher)) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 120) return true;
      } else {
        stableSince = 0;
      }
      await sleep(80);
    }
    return false;
  }

  async function waitForAttendeeDropdownIdle(item, searchInput, minimumMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < minimumMs) {
      await sleep(120);
    }
    const anchor = searchInput || item?.querySelector('.el-cascader__search-input, input');
    const anchorRect = anchor?.getBoundingClientRect?.() || item?.getBoundingClientRect?.();
    const panels = findAttendeeDropdownPanels(anchorRect);
    if (panels.length) await sleep(220);
  }

  function isMeetingAttendeeSelected(item, teacher) {
    if (!item) return false;
    const expected = normalizeName(teacher);
    const tags = Array.from(item.querySelectorAll([
      '.el-tag',
      '.el-select__tags-text',
      '.el-cascader__tags .el-tag',
      '.el-select__tags .el-tag'
    ].join(',')));
    if (tags.some((tag) => normalizeName(textOf(tag)).includes(expected))) return true;

    const visibleText = normalizeName(textOf(item));
    if (visibleText.includes(expected)) return true;

    return getMeetingAttendeeSelectedTexts(item).some((text) => normalizeName(text).includes(expected));
  }

  function getMeetingAttendeeSelectedTexts(item) {
    const components = collectVueComponents(item);
    const values = [];
    components.forEach((component) => {
      collectMeetingAttendeeTextValues(component?.value, values);
      collectMeetingAttendeeTextValues(component?.checkedValue, values);
      collectMeetingAttendeeTextValues(component?.presentText, values);
      collectMeetingAttendeeTextValues(component?.selectedLabel, values);
      collectMeetingAttendeeTextValues(component?.selectedLabels, values);
      collectMeetingAttendeeTextValues(component?.checkedNodes, values);
      collectMeetingAttendeeTextValues(component?.checkedValue, values);
    });
    return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
  }

  function resolveSelectedMeetingAttendeeName(item, teacher, option) {
    const expected = normalizeName(teacher);
    const values = [];
    Array.from(item?.querySelectorAll([
      '.el-tag',
      '.el-select__tags-text',
      '.el-cascader__tags .el-tag',
      '.el-select__tags .el-tag'
    ].join(',')) || []).forEach((tag) => values.push(textOf(tag)));
    getMeetingAttendeeSelectedTexts(item).forEach((text) => values.push(text));
    if (option) values.push(textOf(option));
    return pickMeetingAttendeeDisplayName(values, expected);
  }

  function pickMeetingAttendeeDisplayName(values, expected) {
    const candidates = [];
    values.forEach((value) => {
      String(value || '')
        .split(/[、,，;；\s/／|｜\n\r\t]+/u)
        .map(cleanMeetingAttendeeDisplayName)
        .filter(Boolean)
        .forEach((name) => candidates.push(name));
      const cleaned = cleanMeetingAttendeeDisplayName(value);
      if (cleaned && !/[\/／|｜]/u.test(String(value || ''))) candidates.push(cleaned);
    });
    return Array.from(new Set(candidates))
      .map((name) => ({ name, score: scoreMeetingAttendeeDisplayName(name, expected) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.name.length - b.name.length)[0]?.name || '';
  }

  function cleanMeetingAttendeeDisplayName(value) {
    return String(value || '')
      .replace(/[×xX]$/u, '')
      .replace(/^(?:参会人员|参与人员|参加人员|出席人员|参会人|参与人|参加人|出席人|参会|参与|参加|出席|人员)\s*[:：]?/u, '')
      .replace(/\s*[（(][^）)]*[）)]\s*$/u, '')
      .replace(/(?:老师|教师)+$/u, '')
      .trim();
  }

  function scoreMeetingAttendeeDisplayName(name, expected) {
    const key = normalizeName(name);
    if (!key || !expected || !key.includes(expected)) return -1;
    let score = 0;
    if (/^[\u4e00-\u9fa5]{2,5}$/u.test(key)) score += 40;
    if (key.endsWith(expected)) score += 20;
    if (key === expected) score += 20;
    if (expected.length <= 2 && key.length > expected.length) score += 70;
    if (key.length > expected.length) score += Math.min(20, key.length - expected.length);
    if (key.length > 12) score -= 40;
    return score;
  }

  function collectMeetingAttendeeTextValues(value, output, depth = 0) {
    if (value == null || depth > 3) return;
    if (typeof value === 'string' || typeof value === 'number') {
      output.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectMeetingAttendeeTextValues(item, output, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      ['label', 'text', 'name', 'value', 'fullName', 'teacherName'].forEach((key) => {
        if (value[key] != null) collectMeetingAttendeeTextValues(value[key], output, depth + 1);
      });
      if (typeof value.getText === 'function') {
        safeCall(() => collectMeetingAttendeeTextValues(value.getText(), output, depth + 1));
      }
    }
  }

  function isVisibleElement(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 1
      && rect.height > 1
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || 1) !== 0;
  }

  function formatMeetingDraftNoteMessage(result, fieldResult) {
    const fieldLine = formatMeetingDraftFieldResult(fieldResult);
    if (!result || result.skipped) {
      return {
        type: 'text',
        text: [fieldLine, result?.reason || '请补充会议形式、校区/教室、参会人后，再人工点击系统“确定”。'].filter(Boolean).join(' ')
      };
    }
    return {
      type: 'attendee-result',
      selected: Array.isArray(result.selected) ? result.selected : [],
      missed: Array.isArray(result.missed) ? result.missed : [],
      fieldText: fieldLine
    };
  }

  function formatMeetingDraftFieldResult(fieldResult) {
    if (!fieldResult || !Array.isArray(fieldResult.attempted) || !fieldResult.attempted.length) return '';
    const filled = fieldResult.filled?.length ? `已填：${fieldResult.filled.join('、')}` : '';
    const missed = fieldResult.missed?.length ? `未自动填：${fieldResult.missed.join('、')}` : '';
    const classroom = formatMeetingClassroomDropdownDebug(fieldResult.classroomDropdown);
    return [filled, missed, classroom].filter(Boolean).join('；') + '。';
  }

  function formatMeetingClassroomDropdownDebug(dropdown) {
    if (!dropdown || !Array.isArray(dropdown.prefixes)) return '';
    if (dropdown.matched) return `教室：${dropdown.matched}`;
    return `教室：未自动选择（${dropdown.reason || '无匹配选项'}）`;
  }

  function formatMeetingClassroomScrollTrace(trace) {
    if (!Array.isArray(trace) || !trace.length) return '';
    const text = trace.slice(-3).map((item) => {
      if (item.tag === 'PageDown') return 'PageDown';
      return `${item.oldTop}->${item.newTop}/${item.maxTop}`;
    }).join('，');
    return `；滚动轨迹：${text}`;
  }

  function renderMeetingDraftNoteExtra(extraMessage) {
    if (extraMessage?.type === 'attendee-result') {
      const missed = extraMessage.missed || [];
      const missedLine = missed.length
        ? `<small class="ccheck-draft-note-strong">未选中：<strong>${escapeHtml(missed.join('、'))}</strong></small>`
        : '';
      const fieldLine = extraMessage.fieldText
        ? `<small class="ccheck-draft-note-strong">${escapeHtml(extraMessage.fieldText)}</small>`
        : '';
      const tip = missed.length
        ? '请手动核对参会人后再点系统“确定”。'
        : '请核对会议形式、校区/教室后，再人工点击系统“确定”。';
      return `${fieldLine}${missedLine}<small>${escapeHtml(tip)}</small>`;
    }
    const text = typeof extraMessage === 'object'
      ? extraMessage?.text
      : extraMessage;
    return `<small>${escapeHtml(text || '请补充会议形式、校区/教室、参会人后，再人工点击系统“确定”。')}</small>`;
  }

  function showMeetingDraftNote(draft, extraMessage) {
    let note = document.getElementById('ccheck-meeting-draft-note');
    if (!note) {
      note = document.createElement('div');
      note.id = 'ccheck-meeting-draft-note';
      note.className = 'ccheck-draft-note';
      document.body.appendChild(note);
      restoreDraftNotePosition(note);
      enableDraftNoteControls(note);
    }
    const selectedTeachers = extraMessage?.type === 'attendee-result' && Array.isArray(extraMessage.selected)
      ? extraMessage.selected.filter(Boolean)
      : [];
    const teachers = selectedTeachers.length
      ? selectedTeachers.join('、')
      : (Array.isArray(draft.teachers) ? draft.teachers.join('、') : '');
    const mode = formatMeetingDraftMode(draft);
    const recurringStatus = formatRecurringMeetingDraftStatus(draft);
    const dateText = draft.endDate ? `${draft.date || ''} 至 ${draft.endDate}` : (draft.date || '');
    const collapsed = note.classList.contains('ccheck-draft-note-collapsed');
    const meetingName = String(draft.meetingName || '').trim();
    note.innerHTML = `
      <div class="ccheck-draft-note-head">
        <span class="ccheck-draft-note-title">会议草稿已预填${meetingName ? '' : ' · 会议名称未填'}</span>
        <button class="ccheck-draft-note-toggle" type="button" title="收起/展开">${collapsed ? '+' : '-'}</button>
      </div>
      <div class="ccheck-draft-note-body">
        <div>v${escapeHtml(SCRIPT_VERSION)} ${escapeHtml(dateText)} ${escapeHtml(draft.startTime || '')}-${escapeHtml(draft.endTime || '')}</div>
        ${recurringStatus ? `<small class="ccheck-draft-note-strong">${escapeHtml(recurringStatus)}</small>` : ''}
        <div class="ccheck-draft-note-name${meetingName ? '' : ' ccheck-draft-note-name-missing'}">
          会议名称：${meetingName ? escapeHtml(meetingName) : '未填写'}
        </div>
        <small>${escapeHtml(mode)}${draft.meetingCampus ? `｜${escapeHtml(draft.meetingCampus)}` : ''}</small>
        ${teachers ? `<small class="ccheck-draft-note-strong">参会人：<strong>${escapeHtml(teachers)}</strong></small>` : ''}
        ${renderMeetingDraftNoteExtra(extraMessage)}
      </div>
    `;
    setFloatingNoteCollapsed(note, collapsed, '.ccheck-draft-note-toggle');
    enableDraftNoteControls(note);
  }

  function enableDraftNoteControls(note) {
    if (!note) return;
    if (note.dataset.ccheckFloatingDrag !== 'true') {
      enableFloatingElementDragging(note, {
        handleSelector: '.ccheck-draft-note',
        draggingClass: 'ccheck-draft-note-dragging',
        storageKey: DRAFT_NOTE_POSITION_STORAGE_KEY
      });
    }
    bindDraftNoteToggle(note);
  }

  function bindDraftNoteToggle(note) {
    const toggle = note?.querySelector?.('.ccheck-draft-note-toggle');
    if (!toggle || toggle.dataset.ccheckBound === 'true') return;
    toggle.dataset.ccheckBound = 'true';
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const collapsed = !note.classList.contains('ccheck-draft-note-collapsed');
      setFloatingNoteCollapsed(note, collapsed, '.ccheck-draft-note-toggle');
      clampFloatingElementPosition(note, DRAFT_NOTE_POSITION_STORAGE_KEY);
    });
  }

  function setFloatingNoteCollapsed(element, collapsed, toggleSelector) {
    if (!element) return;
    element.classList.toggle('ccheck-draft-note-collapsed', collapsed);
    const toggle = toggleSelector ? element.querySelector(toggleSelector) : null;
    if (toggle) toggle.textContent = collapsed ? '+' : '-';
  }

  function formatMeetingDraftMode(draft) {
    if (draft?.meetingMode === 'online') return '线上会议';
    if (draft?.meetingMode === 'offline') return '线下会议';
    return '线上/线下均可';
  }

  function finishScan(events, label, options = {}) {
    const settings = readSettings();
    const result = analyze(events, settings);
    state.lastEvents = events;
    state.lastResult = result;
    state.lastScanDateRange = getTeacherScheduleDateRange();
    refreshCommuteDateOptions(events);
    setAuditResultMode('audit');
    renderResult(result, label);
    refreshMeetingPlanner(events, options);
  }

  function renderCommuteCampusOptions() {
    return ['<option value="">选择校区</option>']
      .concat(Array.from(CONFIG.realCampuses).map((campus) => `<option value="${escapeHtml(campus)}">${escapeHtml(campus)}</option>`))
      .join('');
  }

  function installCommuteDateRangeSync() {
    if (window.__ccheckCommuteDateRangeSyncInstalled) return;
    window.__ccheckCommuteDateRangeSyncInstalled = true;
    const refresh = (event) => {
      const placeholder = event?.target?.placeholder || '';
      if (placeholder !== '开始日期' && placeholder !== '结束日期') return;
      window.setTimeout(() => refreshCommuteDateOptions(), 0);
      window.setTimeout(() => refreshCommuteDateOptions(), 240);
    };
    document.addEventListener('input', refresh, true);
    document.addEventListener('change', refresh, true);
  }

  function getTeacherScheduleDateRange() {
    const startDate = String(findScheduleDateInput('开始日期')?.value || '').trim();
    const endDate = String(findScheduleDateInput('结束日期')?.value || '').trim();
    return isIsoDate(startDate) && isIsoDate(endDate) && startDate <= endDate
      ? { startDate, endDate }
      : null;
  }

  function isSameTeacherScheduleDateRange(left, right) {
    if (!left || !right) return false;
    return left.startDate === right.startDate && left.endDate === right.endDate;
  }

  function resolveCommuteDateOptions(events, dateRange, headerDates = []) {
    if (dateRange?.startDate && dateRange?.endDate) {
      const rangeDates = buildDateRange(dateRange.startDate, dateRange.endDate);
      if (rangeDates.length) return rangeDates;
    }

    const eventDates = Array.from(new Set((events || [])
      .map((event) => event?.date)
      .filter(isIsoDate)))
      .sort();
    if (eventDates.length) return eventDates;

    return Array.from(new Set((headerDates || []).filter(isIsoDate))).sort();
  }

  function refreshCommuteDateOptions(events = state.lastEvents) {
    const container = document.getElementById('ccheck-commute-dates');
    if (!container) return [];
    const headerDates = getHeaderColumns().map((column) => column.date).filter(Boolean);
    const dates = resolveCommuteDateOptions(events, getTeacherScheduleDateRange(), headerDates);
    const previousDate = container.dataset.selectedDate || '';
    const selectedDate = dates.includes(previousDate) ? previousDate : dates[0] || '';
    container.dataset.selectedDate = selectedDate;
    container.innerHTML = dates.length
      ? dates.map((date) => `
          <button class="ccheck-commute-date-option${date === selectedDate ? ' is-selected' : ''}" type="button" data-action="commute-date-pick" data-date="${escapeHtml(date)}" title="${escapeHtml(date)}">${escapeHtml(formatShortDate(date))}</button>
        `).join('')
      : '<span class="ccheck-muted">先在教师课表选择日期</span>';
    return dates;
  }

  function selectCommuteDate(date) {
    const container = document.getElementById('ccheck-commute-dates');
    if (!container || !isIsoDate(date)) return;
    const buttons = Array.from(container.querySelectorAll('[data-action="commute-date-pick"]'));
    if (!buttons.some((button) => button.dataset.date === date)) return;
    container.dataset.selectedDate = date;
    buttons.forEach((button) => button.classList.toggle('is-selected', button.dataset.date === date));
  }

  function findCampusCommuteLegs(events, query) {
    const date = String(query?.date || '');
    const fromCampus = String(query?.fromCampus || '');
    const toCampus = String(query?.toCampus || '');
    if (!date || !fromCampus || !toCampus || fromCampus === toCampus) return [];

    const grouped = new Map();
    (events || []).forEach((event) => {
      if (!event || event.date !== date || !event.teacher || !isCampusAuditEvent(event)) return;
      const key = `${event.teacher}||${event.date}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(event);
    });

    const legs = [];
    grouped.forEach((teacherEvents) => {
      const timeline = teacherEvents.slice().sort(compareByTime);
      const campusGroups = [];

      timeline.forEach((event, timelineIndex) => {
        const campus = getPhysicalCampusForAudit(event);
        if (!campus) return;
        const lastGroup = campusGroups[campusGroups.length - 1];
        if (lastGroup?.campus === campus) {
          lastGroup.lastEvent = event;
          lastGroup.lastIndex = timelineIndex;
          return;
        }
        campusGroups.push({
          campus,
          firstEvent: event,
          lastEvent: event,
          firstIndex: timelineIndex,
          lastIndex: timelineIndex
        });
      });

      for (let index = 0; index < campusGroups.length - 1; index += 1) {
        const fromGroup = campusGroups[index];
        const toGroup = campusGroups[index + 1];
        if (fromGroup.campus !== fromCampus || toGroup.campus !== toCampus) continue;
        const intermediateEvents = timeline.slice(fromGroup.lastIndex + 1, toGroup.firstIndex);
        const intermediateOnlineEvents = intermediateEvents.filter(isOnlineCourseEvent);
        legs.push({
          teacher: fromGroup.lastEvent.teacher,
          date,
          fromCampus,
          toCampus,
          fromEvent: fromGroup.lastEvent,
          toEvent: toGroup.firstEvent,
          availableMinutes: toGroup.firstEvent.startMinutes - fromGroup.lastEvent.endMinutes,
          hasIntermediateOnline: intermediateOnlineEvents.length > 0,
          intermediateOnlineEvents
        });
      }
    });

    return legs.sort((a, b) => (
      a.fromEvent.endMinutes - b.fromEvent.endMinutes
      || a.toEvent.startMinutes - b.toEvent.startMinutes
      || a.teacher.localeCompare(b.teacher, 'zh-CN')
    ));
  }

  function swapCommuteCampuses() {
    const fromSelect = document.getElementById('ccheck-commute-from');
    const toSelect = document.getElementById('ccheck-commute-to');
    if (!fromSelect || !toSelect) return;
    const fromCampus = fromSelect.value;
    fromSelect.value = toSelect.value;
    toSelect.value = fromCampus;
    if (fromSelect.value && toSelect.value) queryCampusCommutes();
  }

  async function queryCampusCommutes() {
    const container = document.getElementById('ccheck-commute-results');
    const fromCampus = document.getElementById('ccheck-commute-from')?.value || '';
    const toCampus = document.getElementById('ccheck-commute-to')?.value || '';
    if (!container) return;
    setAuditResultMode('commute');

    if (!fromCampus || !toCampus) {
      container.innerHTML = '<div class="ccheck-empty">请选择出发校区和到达校区。</div>';
      return;
    }
    if (fromCampus === toCampus) {
      container.innerHTML = '<div class="ccheck-empty">出发校区和到达校区不能相同。</div>';
      return;
    }

    const selectedRange = getTeacherScheduleDateRange();
    refreshCommuteDateOptions();
    let date = document.getElementById('ccheck-commute-dates')?.dataset.selectedDate || '';
    if (!date) {
      container.innerHTML = '<div class="ccheck-empty">请先在教师课表顶部选择开始日期和结束日期。</div>';
      setStatus('查询跑校区需要先选择教师课表日期范围。');
      return;
    }

    const needsAutoScan = !state.lastEvents.length
      || (selectedRange && !isSameTeacherScheduleDateRange(selectedRange, state.lastScanDateRange));
    if (needsAutoScan) {
      container.innerHTML = '<div class="ccheck-empty">正在按教师课表当前日期自动扫描，请稍候。</div>';
      setStatus('正在读取教师课表当前日期并刷新课表数据。');
      if (selectedRange) {
        const refreshed = await refreshTeacherScheduleForCommuteQuery();
        if (!refreshed) {
          container.innerHTML = '<div class="ccheck-empty">没有找到教师课表“搜索”按钮，请先确认当前页面是教师课表。</div>';
          return;
        }
      }
      const scanned = await scanAll({ mode: 'commute' });
      setAuditResultMode('commute');
      if (!scanned) {
        container.innerHTML = '<div class="ccheck-empty">自动扫描没有完成，请确认教师课表已经搜索出结果后重试。</div>';
        return;
      }
      refreshCommuteDateOptions(state.lastEvents);
      date = document.getElementById('ccheck-commute-dates')?.dataset.selectedDate || '';
    }

    const loadedDates = new Set(state.lastEvents.map((event) => event?.date).filter(Boolean));
    if (!loadedDates.has(date)) {
      container.innerHTML = '<div class="ccheck-empty">所选日期没有扫描到课表数据，请确认教师课表搜索结果后重试。</div>';
      setStatus(`${date} 没有扫描到课表数据，请确认页面当前日期范围和搜索结果。`);
      return;
    }

    const legs = findCampusCommuteLegs(state.lastEvents, { date, fromCampus, toCampus });
    if (!legs.length) {
      container.innerHTML = `<div class="ccheck-empty">${escapeHtml(date)} 没有查到 ${escapeHtml(fromCampus)}→${escapeHtml(toCampus)} 的老师。</div>`;
      setStatus(`${date}：没有查到 ${fromCampus}→${toCampus}。`);
      return;
    }

    const teacherCount = new Set(legs.map((leg) => leg.teacher)).size;
    container.innerHTML = `
      <div class="ccheck-commute-summary">${escapeHtml(date)}：${teacherCount} 位老师，${legs.length} 趟 ${escapeHtml(fromCampus)}→${escapeHtml(toCampus)}</div>
      ${legs.map((leg, index) => renderCampusCommuteLeg(leg, index)).join('')}
    `;
    bindCampusCommuteLocateButtons(legs);
    setStatus(`${date}：查到 ${teacherCount} 位老师、${legs.length} 趟 ${fromCampus}→${toCampus}。`);
  }

  async function refreshTeacherScheduleForCommuteQuery() {
    const button = findScheduleSearchButton();
    if (!button) return false;
    const previousReceivedAt = state.latestDiagramData?.receivedAt || '';
    clickElementLikeUser(button);
    setStatus('已按当前日期点击教师课表“搜索”，正在等待色块图刷新。');
    await waitForScheduleDiagramData(previousReceivedAt, 8000);
    await sleep(450);
    return true;
  }

  function setAuditResultMode(mode) {
    const auditList = document.getElementById('ccheck-list');
    const commuteResults = document.getElementById('ccheck-commute-results');
    const showCommute = mode === 'commute';
    if (auditList) auditList.hidden = showCommute;
    if (commuteResults) commuteResults.hidden = !showCommute;
  }

  function renderCampusCommuteLeg(leg, index) {
    const gapText = leg.availableMinutes >= 0
      ? `间隔 ${leg.availableMinutes} 分钟`
      : `时间重叠 ${Math.abs(leg.availableMinutes)} 分钟`;
    const onlineText = leg.hasIntermediateOnline ? '中间含线上课' : '中间无线上课';
    return `
      <div class="ccheck-commute-card">
        <strong>${escapeHtml(leg.teacher)}｜${escapeHtml(leg.fromCampus)} ${escapeHtml(leg.fromEvent.end)} → ${escapeHtml(leg.toCampus)} ${escapeHtml(leg.toEvent.start)}</strong>
        <small>${escapeHtml(gapText)}｜${escapeHtml(onlineText)}</small>
        <button class="ccheck-commute-locate" type="button" data-commute-locate="${index}">定位老师</button>
      </div>
    `;
  }

  function bindCampusCommuteLocateButtons(legs) {
    const container = document.getElementById('ccheck-commute-results');
    if (!container) return;
    container.querySelectorAll('[data-commute-locate]').forEach((button) => {
      button.addEventListener('click', async () => {
        const leg = legs[Number(button.dataset.commuteLocate)];
        if (leg) await locateCampusCommuteLeg(leg);
      });
    });
  }

  function createCampusCommuteLocateAnomaly(leg) {
    return {
      teacher: leg?.teacher || '',
      date: leg?.date || '',
      previous: leg?.fromEvent || null,
      current: leg?.toEvent || null,
      blockingEvents: leg?.intermediateOnlineEvents || [],
      relatedEvents: []
    };
  }

  async function locateCampusCommuteLeg(leg) {
    if (!leg?.teacher || !leg?.date || !leg?.fromEvent || !leg?.toEvent) return;
    const anomaly = createCampusCommuteLocateAnomaly(leg);
    await locateAnomaly(anomaly, [anomaly], { teacher: leg.teacher, date: leg.date }, leg.fromEvent);
  }

  async function collectEventsWithCourseDetails(scanTop, detailBudgetMs) {
    const events = collectEvents(scanTop);
    await attachCourseDetails(events, detailBudgetMs);
    return events;
  }

  function mergeInterfaceEventsWithPageEvents(interfaceEvents, pageEvents) {
    const remainingInterfaceIndexes = new Set((interfaceEvents || []).map((_, index) => index));
    const mergedEvents = [];
    let pageMatchedCount = 0;

    (pageEvents || []).forEach((pageEvent) => {
      const matchedIndex = findMatchingInterfaceEventIndex(interfaceEvents, pageEvent, remainingInterfaceIndexes);
      if (matchedIndex < 0) {
        mergedEvents.push(pageEvent);
        return;
      }

      remainingInterfaceIndexes.delete(matchedIndex);
      const interfaceEvent = interfaceEvents[matchedIndex];
      mergedEvents.push({
        ...interfaceEvent,
        ...pageEvent,
        isMeeting: isCourseFormEvent(pageEvent)
          ? false
          : Boolean(pageEvent.isMeeting || interfaceEvent.isMeeting),
        source: '页面+接口'
      });
      pageMatchedCount += 1;
    });

    remainingInterfaceIndexes.forEach((index) => mergedEvents.push(interfaceEvents[index]));
    return {
      events: dedupeEvents(mergedEvents),
      pageMatchedCount,
      interfaceOnlyCount: remainingInterfaceIndexes.size
    };
  }

  function isSameUnavailableEvent(target, source) {
    if (!target || !source) return false;
    if (target.key === source.key) return true;
    return normalizeName(target.teacher) === normalizeName(source.teacher)
      && target.date === source.date
      && isDayOffEvent(target)
      && isDayOffEvent(source)
      && normalizeDayOffText(target.text) === normalizeDayOffText(source.text);
  }

  function hasCourseDetailInfo(event) {
    return Boolean(event && (event.courseForm || event.detailCampus || event.courseCampus));
  }

  function findMatchingInterfaceEventIndex(interfaceEvents, pageEvent, allowedIndexes) {
    let bestIndex = -1;
    let bestScore = 0;
    (interfaceEvents || []).forEach((event, index) => {
      if (allowedIndexes && !allowedIndexes.has(index)) return;
      if (isSameUnavailableEvent(event, pageEvent)) {
        bestIndex = index;
        bestScore = Number.POSITIVE_INFINITY;
        return;
      }
      const score = scoreCourseDetailMatch(event, pageEvent);
      if (score > bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    });
    return bestScore >= 10 ? bestIndex : -1;
  }

  function scoreCourseDetailMatch(target, source) {
    if (!target || !source || target.type === 'dayOff' || source.type === 'dayOff') return 0;
    if (normalizeName(target.teacher) !== normalizeName(source.teacher)) return 0;
    if (target.date && source.date && target.date !== source.date) return 0;
    if (!Number.isFinite(target.startMinutes) || !Number.isFinite(source.startMinutes)) return 0;
    if (!Number.isFinite(target.endMinutes) || !Number.isFinite(source.endMinutes)) return 0;
    if (Math.abs(target.startMinutes - source.startMinutes) > 10 || Math.abs(target.endMinutes - source.endMinutes) > 10) return 0;

    let score = 8;
    if (target.date && source.date) score += 3;
    if (target.parentIndex === source.parentIndex) score += 2;
    if (target.hex && source.hex && target.hex === source.hex) score += 2;

    const targetText = normalizeDetailText(target.text);
    const sourceText = normalizeDetailText(source.text);
    if (targetText && sourceText) {
      if (targetText === sourceText) score += 3;
      else if (targetText.includes(sourceText) || sourceText.includes(targetText)) score += 2;
    }

    return score;
  }

  function collectEventsFromDiagramData() {
    const data = state.latestDiagramData;
    if (!data || !Array.isArray(data.teachers)) return [];

    const events = [];
    data.teachers.forEach((teacher, rowIndex) => {
      const teacherName = teacher.name || teacher.teacher_name || teacher.teacherName || '';
      if (!teacherName) return;

      const schedules = Array.isArray(teacher.course_schedule) ? teacher.course_schedule : [];
      schedules.forEach((schedule, dateIndex) => {
        const date = normalizeDiagramDate(schedule.date || schedule.day || schedule.schedule_date);
        if (!date) return;

        const courseEvents = collectDiagramCourseCandidates(schedule).map((course, itemIndex) => {
          const event = createEventFromDiagramCourse({
            teacherName,
            schedule,
            course,
            rowIndex,
            dateIndex,
            itemIndex,
            date
          });
          return event || null;
        }).filter(Boolean);

        if (Number(schedule.is_rest_date) === 1 && shouldCreateDiagramRestEvent(schedule, courseEvents)) {
          events.push(createDiagramRestEvent(teacherName, schedule, rowIndex, dateIndex, date));
        }

        courseEvents.forEach((event) => events.push(event));
      });
    });

    return dedupeEvents(events);
  }

  function collectDiagramCourseCandidates(schedule) {
    const seen = new Set();
    const candidates = [];
    const add = (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const keys = Object.keys(value);
      if (!keys.some((key) => /course|lesson|class|time|start|end|校区|课程|班级|teacher|date/i.test(key))) return;
      const fingerprint = JSON.stringify(value);
      if (seen.has(fingerprint)) return;
      seen.add(fingerprint);
      candidates.push(value);
    };

    Object.keys(schedule || {}).forEach((key) => {
      const value = schedule[key];
      if (Array.isArray(value)) value.forEach(add);
      if (/^\d+$/.test(key)) add(value);
    });

    return candidates;
  }

  function createEventFromDiagramCourse(input) {
    const { teacherName, course, rowIndex, dateIndex, itemIndex, date } = input;
    const startMinutes = readDiagramStartMinutes(course);
    const endMinutes = readDiagramEndMinutes(course, startMinutes);
    if (startMinutes == null || endMinutes == null || endMinutes <= startMinutes) return null;

    const text = readDiagramText(course);
    const isMeeting = isDiagramMeetingCourse(course);
    const courseForm = normalizeDiagramCourseForm(course);
    const campus = normalizeCampusName(readFirstField(course, [
      'campus_name',
      'campusName',
      'school_name',
      'schoolName',
      'school_area_name',
      'schoolAreaName',
      'campus',
      'school',
      '校区名称',
      '校区'
    ]));
    const rawHex = normalizeHex(readFirstField(course, [
      'color',
      'background_color',
      'backgroundColor',
      'bg_color',
      'bgColor',
      'hex'
    ]));
    const campusHex = findColorForCampus(campus, courseForm);
    const hex = rawHex || (campusHex === '#UNKNOWN' ? '' : campusHex) || (isMeeting ? '#FFAFDE' : '');
    const colorInfo = classifyColor(hex);
    const isNoCourse = hasNoCourseText(text);
    const isRestText = hasExplicitDayOffMarkerText(text);
    const isSameDayUnavailable = isSameDayUnavailableText(text);
    const event = {
      key: [
        teacherName,
        date,
        startMinutes,
        endMinutes,
        'diagram',
        itemIndex,
        text,
        hex
      ].join('|'),
      teacher: teacherName,
      text,
      hex,
      isMeeting,
      type: (isNoCourse || isRestText || isSameDayUnavailable) ? 'dayOff' : colorInfo.type,
      campus: (isNoCourse || isRestText || isSameDayUnavailable) ? '休息' : colorInfo.campus,
      colorMeaning: isNoCourse ? '不排课' : ((isRestText || isSameDayUnavailable) ? getDayOffUnavailableKind({ text }) || '休息' : colorInfo.meaning),
      date,
      dateLabel: '',
      dateIndex,
      startMinutes,
      endMinutes,
      start: formatMinutes(startMinutes),
      end: formatMinutes(endMinutes),
      parentIndex: dateIndex + 3,
      rowIndex,
      itemIndex,
      scanTop: 0,
      rect: null,
      source: '接口'
    };

    if (courseForm || campus) {
      applyCourseDetailToEvent(event, {
        rawText: JSON.stringify(course).slice(0, 2000),
        courseForm,
        campus
      });
    }

    return event;
  }

  function createDiagramRestEvent(teacherName, schedule, rowIndex, dateIndex, date) {
    const range = parseDiagramRestTimeRange(schedule);
    const startMinutes = range?.startMinutes ?? 0;
    const endMinutes = range?.endMinutes ?? 1440;
    const hasRange = Boolean(range);
    return {
      key: [teacherName, date, 'diagram-rest', dateIndex].join('|'),
      teacher: teacherName,
      text: hasRange
        ? `休息（接口休息日 ${formatMinutes(startMinutes)}-${formatMinutes(endMinutes)}）`
        : '休息（接口休息日）',
      hex: '',
      type: 'dayOff',
      campus: '休息',
      colorMeaning: '休息',
      date,
      dateLabel: '',
      dateIndex,
      startMinutes,
      endMinutes,
      start: hasRange ? formatMinutes(startMinutes) : '全天',
      end: hasRange ? formatMinutes(endMinutes) : '全天',
      parentIndex: dateIndex + 3,
      rowIndex,
      itemIndex: -1,
      scanTop: 0,
      rect: null,
      source: '接口休息日'
    };
  }

  function shouldCreateDiagramRestEvent(schedule, courseEvents) {
    if (hasDiagramRestMeaning(schedule)) return true;
    return (courseEvents || []).some(isCourseEventEligibleForDayOffAnomaly);
  }

  function hasDiagramRestMeaning(schedule) {
    return collectDiagramRestMeaningTexts(schedule).length > 0;
  }

  function parseDiagramRestTimeRange(schedule) {
    const texts = collectDiagramRestMeaningTexts(schedule);
    for (const text of texts) {
      const range = parseDayOffTimeRange(text);
      if (range) return range;
    }
    return null;
  }

  function collectDiagramRestMeaningTexts(value, result = [], depth = 0) {
    if (value == null || depth > 5) return result;
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value);
      if (hasDiagramRestMeaningText(text)) result.push(text);
      return result;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectDiagramRestMeaningTexts(item, result, depth + 1));
      return result;
    }
    if (typeof value === 'object') {
      Object.keys(value).forEach((key) => {
        const item = value[key];
        const keyText = String(key);
        if ((typeof item === 'string' || typeof item === 'number') && hasDiagramRestMeaningText(`${keyText}:${item}`)) {
          result.push(`${keyText}:${item}`);
          return;
        }
        collectDiagramRestMeaningTexts(item, result, depth + 1);
      });
    }
    return result;
  }

  function hasDiagramRestMeaningText(text) {
    return hasExplicitDayOffMarkerText(text) || hasNoCourseText(text);
  }

  function readDiagramStartMinutes(course) {
    return readDiagramTimeMinutes(course, [
      'start_time',
      'startTime',
      'begin_time',
      'beginTime',
      'course_start_time',
      'courseStartTime',
      'start',
      'begin',
      '上课时间',
      '开始时间'
    ]);
  }

  function readDiagramEndMinutes(course, startMinutes) {
    const end = readDiagramTimeMinutes(course, [
      'end_time',
      'endTime',
      'finish_time',
      'finishTime',
      'course_end_time',
      'courseEndTime',
      'end',
      'finish',
      '下课时间',
      '结束时间'
    ]);
    if (end != null) return end;

    const duration = Number(readFirstField(course, ['duration', 'duration_minutes', 'durationMinutes', 'minutes', '时长']));
    if (Number.isFinite(duration) && duration > 0 && startMinutes != null) return startMinutes + duration;
    return startMinutes == null ? null : startMinutes + CONFIG.defaultDurationMinutes;
  }

  function readDiagramTimeMinutes(course, keys) {
    const value = readFirstField(course, keys);
    const parsed = parseFlexibleTimeMinutes(value);
    if (parsed != null) return parsed;
    const text = readDiagramText(course);
    const range = parseTimeRangeFromText(text);
    if (!range) return null;
    return /end|finish|下课|结束/i.test(keys.join('|')) ? range.endMinutes : range.startMinutes;
  }

  function parseFlexibleTimeMinutes(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number') {
      if (value > 0 && value < 24 * 60) return Math.round(value);
      return null;
    }
    const text = String(value);
    const match = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
    if (!match) return null;
    const minutes = Number(match[1]) * 60 + Number(match[2]);
    return minutes >= 0 && minutes < 24 * 60 ? minutes : null;
  }

  function parseTimeRangeFromText(text) {
    const match = String(text || '').match(/(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:-|－|–|—|~|～|至|到)\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
    if (!match) return null;
    const startMinutes = Number(match[1]) * 60 + Number(match[2]);
    const endMinutes = Number(match[3]) * 60 + Number(match[4]);
    return endMinutes > startMinutes ? { startMinutes, endMinutes } : null;
  }

  function readDiagramText(course) {
    const meetingName = readFirstField(course, ['meeting_name', 'meetingName', 'meeting', '会议名称']);
    if (meetingName) return String(meetingName).trim();

    const parts = [
      readFirstField(course, ['class_number', 'classNumber', 'class_no', 'classNo', '班号']),
      readFirstField(course, ['course_name', 'courseName', 'lesson_name', 'lessonName', 'subject_name', 'subjectName', '课程名称']),
      readFirstField(course, ['class_name', 'className', '班级名称']),
      readFirstField(course, ['student_name', 'studentName', 'student', '学生']),
      readFirstField(course, ['name', 'title', 'content', 'text'])
    ].filter(Boolean);
    return parts.join(' ').trim() || JSON.stringify(course).slice(0, 120);
  }

  function isDiagramMeetingCourse(course) {
    const type = readFirstField(course, ['type']);
    if (String(type) === '1') return true;
    const meetingId = Number(readFirstField(course, ['meeting_id', 'meetingId']));
    return Number.isFinite(meetingId) && meetingId > 0 && Boolean(readFirstField(course, ['meeting_name', 'meetingName']));
  }

  function normalizeDiagramCourseForm(course) {
    if (isDiagramMeetingCourse(course)) return '';
    const raw = readFirstField(course, ['course_form', 'courseForm']);
    if (String(raw) === '1') return '线上';
    if (String(raw) === '0') return '线下';
    return normalizeCourseForm(readFirstField(course, [
      'course_form_name',
      'courseFormName',
      'course_type_name',
      'courseTypeName',
      'class_type_name',
      'classTypeName',
      'teach_type_name',
      'teachTypeName',
      'lesson_type_name',
      'lessonTypeName',
      'type_name',
      'typeName',
      '课程形式'
    ]));
  }

  function readFirstField(object, keys) {
    if (!object || typeof object !== 'object') return '';
    for (const key of keys) {
      if (object[key] != null && object[key] !== '') return object[key];
    }
    const normalizedKeys = new Map(Object.keys(object).map((key) => [normalizeFieldName(key), key]));
    for (const key of keys) {
      const matched = normalizedKeys.get(normalizeFieldName(key));
      if (matched && object[matched] != null && object[matched] !== '') return object[matched];
    }
    return '';
  }

  function normalizeFieldName(value) {
    return String(value || '').replace(/[_\-\s]/g, '').toLowerCase();
  }

  function normalizeDiagramDate(value) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return String(value);
    const match = String(value || '').match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (match) return makeDateInput(Number(match[1]), Number(match[2]), Number(match[3]));
    return '';
  }

  function findColorForCampus(campus, courseForm) {
    if (courseForm === '线上' && !campus) return '#7F91F5';
    const matched = Object.entries(CONFIG.campusByColor).find(([, value]) => value === campus);
    if (matched) return matched[0];
    if (courseForm === '线上') return '#7F91F5';
    return '#UNKNOWN';
  }

  function normalizeHex(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^rgba?\(/i.test(text)) return rgbToHex(text);
    const shortHex = text.match(/^#?([0-9a-f]{3})$/i);
    if (shortHex) {
      return '#' + shortHex[1].split('').map((item) => item + item).join('').toUpperCase();
    }
    const longHex = text.match(/^#?([0-9a-f]{6})$/i);
    return longHex ? `#${longHex[1].toUpperCase()}` : '';
  }

  function dedupeEvents(events) {
    const seen = new Set();
    return events.filter((event) => {
      if (!event || !event.key) return false;
      if (seen.has(event.key)) return false;
      seen.add(event.key);
      return true;
    });
  }

  async function attachCourseDetails(events, detailBudgetMs) {
    const courseEvents = events.filter((event) => event.hex && event.type !== 'dayOff');
    const startedAt = Date.now();
    const hoverCandidates = collectImmediateCourseDetailCandidates(courseEvents, (event) => {
      const cached = state.courseDetailCache.get(event.key);
      if (cached) return { detail: cached };

      try {
        const item = findVisibleElementForEvent(event);
        if (!item) return null;
        return {
          item,
          detail: readCourseDetailFromEmbeddedPopover(item, event)
        };
      } catch (error) {
        console.warn('[campus-commute-checker] 内嵌课程详情读取失败，已跳过该色块', error);
        return null;
      }
    }).sort((a, b) => {
      return Number(Boolean(CONFIG.onlineByColor[normalizeHex(b.event.hex)]))
        - Number(Boolean(CONFIG.onlineByColor[normalizeHex(a.event.hex)]));
    });

    let detailMisses = 0;
    for (const candidate of hoverCandidates) {
      if (Number.isFinite(detailBudgetMs) && Date.now() - startedAt > detailBudgetMs) return;
      if (detailMisses >= CONFIG.maxDetailMissesPerScan) return;
      const { event, item } = candidate;

      try {
        const detail = await readCourseDetailFromHover(item, event);
        if (!detail) {
          detailMisses += 1;
          continue;
        }

        state.courseDetailCache.set(event.key, detail);
        applyCourseDetailToEvent(event, detail);
      } catch (error) {
        detailMisses += 1;
        console.warn('[campus-commute-checker] 课程详情读取失败，已跳过该色块', error);
      }
    }
  }

  function collectImmediateCourseDetailCandidates(courseEvents, resolveCandidate) {
    const hoverCandidates = [];
    (courseEvents || []).forEach((event) => {
      const candidate = resolveCandidate(event);
      if (!candidate) return;
      if (candidate.detail) {
        state.courseDetailCache.set(event.key, candidate.detail);
        applyCourseDetailToEvent(event, candidate.detail);
        return;
      }
      if (candidate.item) hoverCandidates.push({ event, item: candidate.item });
    });
    return hoverCandidates;
  }

  function readCourseDetailFromEmbeddedPopover(item, event) {
    const panels = Array.from(item.querySelectorAll('.el-popover, [role="tooltip"], .el-popper'))
      .map((element) => ({ element, text: textOf(element) }))
      .filter((panel) => panel.text.includes('课程详情') && panel.text.includes('课程形式'));
    const matched = pickCourseDetailPanel(panels, event) || panels[0];
    return matched ? parseCourseDetailText(matched.text) : null;
  }

  async function readCourseDetailFromHover(item, event) {
    const beforeTexts = new Set(collectCourseDetailPanels().map((panel) => panel.normalizedText));
    const hoverTarget = getCourseDetailHoverTarget(item);
    dispatchCourseDetailHover(hoverTarget);

    try {
      const detail = await waitForCourseDetailPanel(beforeTexts, event);
      return detail;
    } finally {
      dispatchCourseDetailLeave(hoverTarget);
    }
  }

  function getCourseDetailHoverTarget(item) {
    if (!item) return item;
    return item.querySelector('.el-popover__reference, [aria-describedby], .el-popover__reference-wrapper > *') || item;
  }

  async function waitForCourseDetailPanel(beforeTexts, event) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= CONFIG.detailHoverTimeoutMs) {
      const panels = collectCourseDetailPanels();
      const freshPanels = panels.filter((panel) => !beforeTexts.has(panel.normalizedText));
      const matched = pickCourseDetailPanel(freshPanels, event) || pickCourseDetailPanel(panels, event);
      if (matched) return parseCourseDetailText(matched.text);
      if (freshPanels.length === 1) return parseCourseDetailText(freshPanels[0].text);
      await sleep(CONFIG.detailHoverPollMs);
    }
    return null;
  }

  function collectCourseDetailPanels() {
    return Array.from(document.body.querySelectorAll('.el-popover, [role="tooltip"], .el-popper'))
      .filter((element) => {
        if (element.closest('#ccheck-panel')) return false;
        const text = textOf(element);
        if (!text.includes('课程详情') || !text.includes('课程形式')) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 80 || rect.width > 700 || rect.height > 800) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || 1) !== 0
          && element.offsetParent !== null;
      })
      .map((element) => {
        const text = textOf(element);
        return {
          element,
          text,
          normalizedText: normalizeDetailText(text),
          rect: element.getBoundingClientRect()
        };
      })
      .sort((a, b) => a.normalizedText.length - b.normalizedText.length);
  }

  function pickCourseDetailPanel(panels, event) {
    if (!panels.length) return null;
    return panels.find((panel) => isCourseDetailForEvent(panel.text, event)) || null;
  }

  function isCourseDetailForEvent(text, event) {
    const teacher = normalizeName(event.teacher);
    const normalizedText = normalizeName(text);
    if (teacher && !normalizedText.includes(teacher)) return false;

    const timeText = readDetailField(text, '时间');
    if (timeText) return isDetailTimeForEvent(timeText, event);

    const courseName = normalizeDetailText(readDetailField(text, '课程名称'));
    const eventText = normalizeDetailText(event.text);
    if (courseName && eventText.includes(courseName)) return true;

    return !timeText && !courseName;
  }

  function isDetailTimeForEvent(timeText, event) {
    const match = String(timeText || '').match(/(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:-|－|–|—|~|～|至|到)\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
    if (!match) return false;
    const startMinutes = Number(match[1]) * 60 + Number(match[2]);
    const endMinutes = Number(match[3]) * 60 + Number(match[4]);
    return Math.abs(startMinutes - event.startMinutes) <= 10 && Math.abs(endMinutes - event.endMinutes) <= 10;
  }

  function parseCourseDetailText(text) {
    const detail = {
      rawText: text,
      courseForm: normalizeCourseForm(readDetailField(text, '课程形式')),
      campus: normalizeCampusName(readDetailField(text, '校区名称') || readDetailField(text, '校区'))
    };
    if (!detail.courseForm && !detail.campus) return null;
    return detail;
  }

  function applyCourseDetailToEvent(event, detail) {
    if (!event || !detail || event.type === 'dayOff' || isNoCourseDayOffEvent(event)) return;

    event.courseForm = detail.courseForm || '';
    event.detailCampus = detail.campus || '';
    event.courseCampus = detail.campus && CONFIG.realCampuses.has(detail.campus) ? detail.campus : '';
    event.detailText = detail.rawText || '';

    if (detail.courseForm === '线上') {
      event.type = 'online';
      event.campus = '线上';
      event.colorMeaning = detail.campus ? `线上（${detail.campus}）` : '线上';
      return;
    }

    if (detail.courseForm === '线下') {
      event.type = 'real';
      if (detail.campus && CONFIG.realCampuses.has(detail.campus)) {
        event.campus = detail.campus;
        event.colorMeaning = `线下（${detail.campus}）`;
      } else {
        event.colorMeaning = event.campus && event.campus !== '未知颜色'
          ? `线下（${event.campus}）`
          : '线下';
      }
    }
  }

  function dispatchCourseDetailHover(item) {
    const rect = item.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    dispatchMouseLikeEvent(item, 'pointerenter', clientX, clientY);
    dispatchMouseLikeEvent(item, 'pointerover', clientX, clientY);
    dispatchMouseLikeEvent(item, 'mouseover', clientX, clientY);
    dispatchMouseLikeEvent(item, 'mouseenter', clientX, clientY);
    dispatchMouseLikeEvent(item, 'mousemove', clientX, clientY);
  }

  function dispatchCourseDetailLeave(item) {
    const rect = item.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    dispatchMouseLikeEvent(item, 'mouseleave', clientX, clientY);
    dispatchMouseLikeEvent(item, 'mouseout', clientX, clientY);
    dispatchMouseLikeEvent(item, 'pointerout', clientX, clientY);
    dispatchMouseLikeEvent(item, 'pointerleave', clientX, clientY);
  }

  function dispatchMouseLikeEvent(element, type, clientX, clientY) {
    const EventCtor = type.startsWith('pointer') && typeof PointerEvent === 'function'
      ? PointerEvent
      : MouseEvent;
    element.dispatchEvent(new EventCtor(type, {
      bubbles: !/mouseenter|mouseleave|pointerenter|pointerleave/.test(type),
      cancelable: true,
      view: window,
      clientX,
      clientY
    }));
  }

  function readDetailField(text, label) {
    const labels = [
      '教师',
      '时间',
      '课程形式',
      '校区名称',
      '校区',
      '教室',
      '班号',
      '班级名称',
      '课程名称',
      '课次'
    ];
    const tailPattern = labels.map(escapeRegExp).join('|');
    const match = String(text || '').match(new RegExp(`${escapeRegExp(label)}\\s*[:：]\\s*(.*?)\\s*(?=(?:${tailPattern})\\s*[:：]|$)`));
    return match ? match[1].trim() : '';
  }

  function normalizeCourseForm(value) {
    const normalized = normalizeDetailText(value);
    if (/线上|在线|网课|直播|远程/.test(normalized)) return '线上';
    if (/线下|面授|到校|实体/.test(normalized)) return '线下';
    return '';
  }

  function normalizeCampusName(value) {
    const normalized = normalizeDetailText(value);
    if (!normalized) return '';
    const campus = Array.from(CONFIG.realCampuses).find((item) => {
      const fullName = normalizeDetailText(item);
      const shortName = fullName.replace(/校区$/, '');
      return normalized.includes(fullName)
        || normalized.includes(shortName)
        || fullName.includes(normalized);
    });
    if (campus) return campus;
    if (normalized.includes('虚拟校区')) return '虚拟校区';
    if (normalized.includes('线上')) return '线上';
    return String(value || '').trim();
  }

  function normalizeDetailText(value) {
    return String(value || '')
      .replace(/\s+/g, '')
      .replace(/[，,。.;；()（）【】\[\]{}]/g, '');
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function collectEvents(scanTop) {
    const rows = Array.from(document.querySelectorAll('.row'));
    const headerColumns = getHeaderColumns();
    const restTextMatches = collectVisibleRestTextMatches(document.body)
      .concat(collectVisiblePseudoRestMatches(document.body));
    const events = [];

    rows.forEach((row, rowIndex) => {
      const teacher = textOf(row.children[0]).trim();
      if (!teacher) return;

      const rowTiming = getRowTiming(row);
      const rowChildren = Array.from(row.children);

      Array.from(row.querySelectorAll('.item')).forEach((item, itemIndex) => {
        const rect = item.getBoundingClientRect();
        const text = textOf(item);
        if (!text || text.includes('课程详情') || rect.width < 50 || rect.height < 10) return;

        const parentIndex = rowChildren.indexOf(item.parentElement);
        const dateIndex = parentIndex - 3;
        if (dateIndex < 0) return;

        const style = getComputedStyle(item);
        const hex = rgbToHex(style.backgroundColor);
        const top = parseCssNumber(style.top, rect.y - item.parentElement.getBoundingClientRect().y);
        const height = parseCssNumber(style.height, rect.height);
        const startMinutes = roundToFive(rowTiming.baseMinutes + top * rowTiming.minutesPerPixel);
        const durationMinutes = Math.max(5, roundToFive(height * rowTiming.minutesPerPixel)) || CONFIG.defaultDurationMinutes;
        const endMinutes = startMinutes + durationMinutes;
        const colorInfo = classifyColor(hex);
        const isNoCourse = hasNoCourseText(text);
        const isRestText = hasExplicitDayOffMarkerText(text);
        const isSameDayUnavailable = isSameDayUnavailableText(text);
        const date = headerColumns[dateIndex]?.date || addDays(getBaseDate(), dateIndex);
        const dateLabel = headerColumns[dateIndex]?.label || '';
        const key = [
          teacher,
          date,
          startMinutes,
          endMinutes,
          parentIndex,
          text,
          hex
        ].join('|');

        events.push({
          key,
          teacher,
          text,
          hex,
          type: (isNoCourse || isRestText || isSameDayUnavailable) ? 'dayOff' : colorInfo.type,
          campus: (isNoCourse || isRestText || isSameDayUnavailable) ? '休息' : colorInfo.campus,
          colorMeaning: isNoCourse ? '不排课' : ((isRestText || isSameDayUnavailable) ? getDayOffUnavailableKind({ text }) || '休息' : colorInfo.meaning),
          date,
          dateLabel,
          dateIndex,
          startMinutes,
          endMinutes,
          start: formatMinutes(startMinutes),
          end: formatMinutes(endMinutes),
          parentIndex,
          rowIndex,
          itemIndex,
          scanTop,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height)
          }
        });
      });

      events.push(...collectRestDayMarkers(row, rowIndex, rowTiming, headerColumns, scanTop, restTextMatches));
    });

    return events;
  }

  function collectRestDayMarkers(row, rowIndex, rowTiming, headerColumns, scanTop, restTextMatches) {
    const rowChildren = Array.from(row.children);
    const teacher = textOf(row.children[0]).trim();
    const markers = [];

    rowChildren.slice(3).forEach((cell, dateIndex) => {
      const markerElement = findRestLabelElementInCell(cell);
      const isRestBackground = !markerElement && isRestBackgroundDateCell(cell);
      if (!markerElement && !isRestBackground) return;

      const parentIndex = rowChildren.indexOf(cell);
      markers.push(createRestDayMarker({
        row,
        rowIndex,
        rowTiming,
        headerColumns,
        scanTop,
        teacher,
        dateIndex,
        parentIndex,
        markerElement: markerElement || cell,
        source: markerElement ? '页面休息文字' : '页面休息背景',
        fullDay: isRestBackground || isFullDayRestMarkerElement(markerElement)
      }));
    });

    if (!markers.length && headerColumns.length === 1) {
      const markerElement = findRestLabelElementInScope(row) || findRestLabelElementByRowGeometry(row, restTextMatches);
      if (markerElement) {
        const fallbackCell = rowChildren[3] || row;
        markers.push(createRestDayMarker({
          row,
          rowIndex,
          rowTiming,
          headerColumns,
          scanTop,
          teacher,
          dateIndex: 0,
          parentIndex: fallbackCell === row ? 3 : rowChildren.indexOf(fallbackCell),
          markerElement,
          source: '页面休息文字',
          fullDay: isFullDayRestMarkerElement(markerElement)
        }));
      }
    }

    return markers;
  }

  function findRestLabelElementByRowGeometry(row, restTextMatches) {
    const rowRect = row.getBoundingClientRect();
    const timeRect = row.children[2]?.getBoundingClientRect();
    const minX = timeRect ? timeRect.right - 2 : rowRect.left;
    const matches = restTextMatches || collectVisibleRestTextMatches(document.body);

    const match = matches.find((item) => {
      return item.rect.bottom >= rowRect.top
        && item.rect.top <= rowRect.bottom
        && item.rect.left >= minX;
    });

    return match?.element || null;
  }

  function isFullDayRestMarkerElement(element) {
    return Boolean(element && isRestLabelText(textOf(element)) && !element.closest('.item'));
  }

  function normalizeName(value) {
    return String(value || '').replace(/\s+/g, '').trim();
  }

  function createRestDayMarker(input) {
    const { row, rowIndex, rowTiming, headerColumns, scanTop, teacher, dateIndex, parentIndex, markerElement, source, fullDay } = input;
    const date = headerColumns[dateIndex]?.date || addDays(getBaseDate(), dateIndex);
    const dateLabel = headerColumns[dateIndex]?.label || '';
    const rowRect = row.getBoundingClientRect();
    const markerRect = markerElement.getBoundingClientRect();
    const top = Math.max(0, markerRect.y - rowRect.y);
    const startMinutes = fullDay ? 0 : roundToFive(rowTiming.baseMinutes + top * rowTiming.minutesPerPixel);
    const endMinutes = fullDay ? 1440 : startMinutes + CONFIG.defaultDurationMinutes;
    const key = [
      teacher,
      date,
      'rest-day',
      parentIndex,
      '休息'
    ].join('|');

    return {
      key,
      teacher,
      text: source ? `休息（${source}）` : '休息',
      hex: '',
      type: 'dayOff',
      campus: '休息',
      colorMeaning: '休息',
      date,
      dateLabel,
      dateIndex,
      startMinutes,
      endMinutes,
      start: fullDay ? '全天' : formatMinutes(startMinutes),
      end: fullDay ? '全天' : formatMinutes(endMinutes),
      parentIndex,
      rowIndex,
      itemIndex: -1,
      scanTop,
      rect: {
        x: Math.round(markerRect.x),
        y: Math.round(markerRect.y),
        w: Math.round(markerRect.width),
        h: Math.round(markerRect.height)
      }
    };
  }

  function analyze(events, settings) {
    const grouped = new Map();
    const colorCounts = new Map();
    const anomalies = [];
    const notes = [];
    const rangeDayOffs = buildRangeDayOffEvents(events);

    events.forEach((event) => {
      if (event.hex) colorCounts.set(event.hex, (colorCounts.get(event.hex) || 0) + 1);
      const key = `${event.teacher}||${event.date}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(event);
    });

    grouped.forEach((list, groupKey) => {
      const sorted = list.slice().sort(compareByTime);
      const dayOffEvents = sorted.filter(isDayOffEvent);
      const rangeDayOffEvent = rangeDayOffs.get(groupKey);
      if (rangeDayOffEvent && !dayOffEvents.some((event) => event.key === rangeDayOffEvent.key)) {
        dayOffEvents.unshift(rangeDayOffEvent);
      } else {
        dayOffEvents.sort((a, b) => compareDayOffEventPriority(a, b));
      }
      if (dayOffEvents.length) {
        sorted
          .map((event) => ({ event, dayOffEvent: dayOffEvents.find((item) => isCourseEventDuringDayOff(event, item)) }))
          .filter((item) => item.dayOffEvent)
          .forEach((courseEvent) => {
            anomalies.push(createDayOffAnomaly(courseEvent.dayOffEvent, courseEvent.event));
          });
      }

      createCampusAuditAnomalies(sorted, settings, notes).forEach((anomaly) => anomalies.push(anomaly));

      createMeetingBufferAnomalies(sorted).forEach((anomaly) => anomalies.push(anomaly));
    });

    const unknownColors = Array.from(colorCounts.entries())
      .filter(([hex]) => !CONFIG.campusByColor[hex] && !CONFIG.onlineByColor[hex])
      .map(([hex, count]) => ({ hex, count }));

    return {
      scannedAt: new Date(),
      totalEvents: events.filter((event) => event.hex).length,
      restMarkers: events.filter(isRestDayEvent).length,
      colors: Array.from(colorCounts.entries()).map(([hex, count]) => ({
        hex,
        count,
        meaning: CONFIG.campusByColor[hex] || CONFIG.onlineByColor[hex] || '未知颜色'
      })).sort((a, b) => b.count - a.count),
      unknownColors,
      anomalies: dedupeAnomalies(anomalies),
      notes,
      settings
    };
  }

  function createCampusAuditAnomalies(events, settings, notes) {
    const context = (events || [])
      .filter(isCampusAuditEvent)
      .sort(compareByTime)
      .map((event, index) => createCampusAuditItem(event, index));
    const anomalies = [];

    context.forEach((item, index) => {
      if (!item.isVirtual) return;
      const previous = findCampusAuditPhysical(context, index, -1);
      const next = findCampusAuditPhysical(context, index, 1);
      const assignment = getVirtualCampusAssignment(item, previous, next, settings, context, index);
      if (!assignment) return;

      const commuteIssue = getVirtualAssignmentCommuteIssue(item, assignment, previous, next);
      if (commuteIssue) {
        anomalies.push(createCampusAuditAnomaly({
          kind: '异常：时间不够跑校区',
          previous: commuteIssue.previous,
          current: commuteIssue.current,
          blockingEvents: [item.event],
          requiredMinutes: commuteIssue.requiredMinutes,
          availableMinutes: commuteIssue.availableMinutes,
          reason: commuteIssue.reason
        }));
        return;
      }

      if (!isSameCampusChoice(item.selectedCampus, assignment.campus)) {
        anomalies.push(createCampusAuditAnomaly({
          kind: '未改校区',
          previous: previous?.event || item.event,
          current: next?.event || item.event,
          blockingEvents: [item.event],
          requiredMinutes: null,
          availableMinutes: null,
          reason: '未改校区'
        }));
      }
    });

    const physicalItems = context.filter((item) => item.physicalCampus);
    for (let index = 0; index < physicalItems.length - 1; index += 1) {
      const previous = physicalItems[index];
      const current = physicalItems[index + 1];
      if (!previous.physicalCampus || !current.physicalCampus || previous.physicalCampus === current.physicalCampus) continue;

      const summerNoonExtraGap = getMaSiyuSummerNoonExtraGap(previous.event, current.event);
      if (summerNoonExtraGap && summerNoonExtraGap.availableMinutes < summerNoonExtraGap.requiredMinutes) {
        anomalies.push(createCampusAuditAnomaly({
          kind: '马思雨暑假跑校区',
          previous: previous.event,
          current: current.event,
          requiredMinutes: summerNoonExtraGap.requiredMinutes,
          availableMinutes: summerNoonExtraGap.availableMinutes,
          blockingEvents: [],
          reason: '马思雨暑假跑校区需要额外空一课时'
        }));
        continue;
      }

      const requiredMinutes = getCommuteMinutes(previous.physicalCampus, current.physicalCampus);
      if (requiredMinutes == null) {
        notes.push({
          teacher: previous.event.teacher,
          date: previous.event.date,
          reason: `${previous.physicalCampus} 到 ${current.physicalCampus} 缺少通勤规则`
        });
        continue;
      }

      const availableMinutes = current.event.startMinutes - previous.event.endMinutes;
      if (availableMinutes < requiredMinutes) {
        anomalies.push(createCampusAuditAnomaly({
          kind: '异常：时间不够跑校区',
          previous: previous.event,
          current: current.event,
          requiredMinutes,
          availableMinutes,
          blockingEvents: [],
          reason: `${previous.physicalCampus} 到 ${current.physicalCampus} 可通勤 ${availableMinutes} 分钟，需要 ${requiredMinutes} 分钟`
        }));
      }
    }

    const physicalCampuses = Array.from(new Set(physicalItems.map((item) => item.physicalCampus).filter(Boolean)));
    const selectedCampusItems = context.filter((item) => item.selectedCampus);
    const selectedCampuses = Array.from(new Set(selectedCampusItems.map((item) => item.selectedCampus)));
    const hasOnlineCourses = context.some((item) => item.isVirtual
      && isOnlineCourseEvent(item.event)
      && !isMeetingEvent(item.event));
    anomalies.push(...createOnlyOnlineDifferentCampusAnomalies(context, physicalCampuses));
    anomalies.push(...createTwoColorSandwichAnomalies(events, settings));
    if (physicalCampuses.length >= 3) {
      const first = physicalItems[0];
      const last = physicalItems[physicalItems.length - 1];
      anomalies.push(createCampusAuditAnomaly({
        kind: '异常：存在多个校区',
        previous: first.event,
        current: last.event,
        requiredMinutes: null,
        availableMinutes: null,
        blockingEvents: physicalItems.slice(1, -1).map((item) => item.event),
        reason: context.some((item) => item.isVirtual)
          ? `同一天出现 ${physicalCampuses.length} 个实体校区：${physicalCampuses.join('、')}，提示老师跑了三个校区`
          : '老师跑了三次校区，注意查看'
      }));
    } else if (hasOnlineCourses && selectedCampuses.length >= 3) {
      const first = selectedCampusItems[0];
      const last = selectedCampusItems[selectedCampusItems.length - 1];
      anomalies.push(createCampusAuditAnomaly({
        kind: '异常：存在多个校区',
        previous: first.event,
        current: last.event,
        requiredMinutes: null,
        availableMinutes: null,
        blockingEvents: selectedCampusItems.slice(1, -1).map((item) => item.event),
        reason: '有线上课，未改校区，目前课表有三个校区，注意查看'
      }));
    }

    return dedupeAnomalies(anomalies);
  }

  function createOnlyOnlineDifferentCampusAnomalies(context, physicalCampuses) {
    if (physicalCampuses.length !== 1) return [];
    const physicalCampus = physicalCampuses[0];
    const mismatchedOnlineItems = context.filter((item) => {
      return item.isVirtual
        && isOnlineCourseEvent(item.event)
        && !isMeetingEvent(item.event)
        && item.selectedCampus
        && item.selectedCampus !== physicalCampus;
    });
    if (!mismatchedOnlineItems.length) return [];

    const physicalItem = context.find((item) => item.physicalCampus === physicalCampus);
    const firstMismatch = mismatchedOnlineItems[0];
    return [createCampusAuditAnomaly({
      kind: '检测：有线上课',
      previous: physicalItem?.event || firstMismatch.event,
      current: firstMismatch.event,
      blockingEvents: mismatchedOnlineItems.slice(1).map((item) => item.event),
      requiredMinutes: null,
      availableMinutes: null,
      reason: '只有线上课不在一个校区，建议修改'
    })];
  }

  function isCampusAuditEvent(event) {
    if (!event || event.type === 'dayOff' || isNoCourseDayOffEvent(event)) return false;
    if (!Number.isFinite(event.startMinutes) || !Number.isFinite(event.endMinutes) || event.endMinutes <= event.startMinutes) return false;
    return Boolean(getPhysicalCampusForAudit(event) || getSelectedCampusForAudit(event) || isVirtualAuditEvent(event));
  }

  function createCampusAuditItem(event, index) {
    return {
      event,
      index,
      isVirtual: isVirtualAuditEvent(event),
      selectedCampus: getSelectedCampusForAudit(event),
      physicalCampus: getPhysicalCampusForAudit(event)
    };
  }

  function isVirtualAuditEvent(event) {
    if (!event) return false;
    const normalized = normalizeDayOffText(event.text);
    return event.courseForm === '线上'
      || event.campus === '线上'
      || event.campus === '虚拟校区'
      || CONFIG.campusByColor[normalizeHex(event.hex)] === '虚拟校区'
      || /线上|在线|网课|直播|远程|虚拟/.test(normalized);
  }

  function getSelectedCampusForAudit(event) {
    if (!event) return '';
    const colorCampus = getColorRealCampus(event);
    if (colorCampus) return colorCampus;
    if (event.courseCampus && CONFIG.realCampuses.has(event.courseCampus)) return event.courseCampus;
    if (event.detailCampus && CONFIG.realCampuses.has(event.detailCampus)) return event.detailCampus;
    if (event.campus && CONFIG.realCampuses.has(event.campus)) return event.campus;
    return '';
  }

  function getPhysicalCampusForAudit(event) {
    if (!event || isVirtualAuditEvent(event)) return '';
    const campus = getSelectedCampusForAudit(event);
    return CONFIG.realCampuses.has(campus) ? campus : '';
  }

  function findCampusAuditPhysical(context, startIndex, direction) {
    for (let cursor = startIndex + direction; cursor >= 0 && cursor < context.length; cursor += direction) {
      if (context[cursor].physicalCampus) return context[cursor];
    }
    return null;
  }

  function findCampusAuditCampusItem(context, startIndex, direction) {
    for (let cursor = startIndex + direction; cursor >= 0 && cursor < context.length; cursor += direction) {
      const item = context[cursor];
      if (item?.physicalCampus || item?.selectedCampus) return item;
    }
    return null;
  }

  function getCampusAuditComparableCampus(item) {
    return item?.physicalCampus || item?.selectedCampus || '';
  }

  function getVirtualCampusAssignment(item, previous, next, settings, context, index) {
    const selected = item.selectedCampus;
    const previousCampus = previous?.physicalCampus || '';
    const nextCampus = next?.physicalCampus || '';
    if (!previousCampus && !nextCampus) return null;

    if (previousCampus && nextCampus && previousCampus === nextCampus) {
      return { campus: previousCampus, side: 'same' };
    }
    const allowedGap = Math.max(settings?.adjacentGapMinutes || 0, CONFIG.meetingEventBufferMinutes);
    if (previousCampus && selected === previousCampus) return { campus: previousCampus, side: 'previous' };
    if (nextCampus && selected === nextCampus) return { campus: nextCampus, side: 'next' };
    if (!previousCampus) {
      const forcedNext = getOneSidedVirtualForcedCampus(item, context, index, 1, nextCampus, allowedGap);
      if (forcedNext) return { campus: forcedNext, side: 'next' };
      return selected
        ? { campus: selected, side: 'selected-next' }
        : { campus: nextCampus, side: 'next' };
    }
    if (!nextCampus) {
      const forcedPrevious = getOneSidedVirtualForcedCampus(item, context, index, -1, previousCampus, allowedGap);
      if (forcedPrevious) return { campus: forcedPrevious, side: 'previous' };
      return selected
        ? { campus: selected, side: 'selected-previous' }
        : { campus: previousCampus, side: 'previous' };
    }

    const previousGap = item.event.startMinutes - previous.event.endMinutes;
    const nextGap = next.event.startMinutes - item.event.endMinutes;
    if (previousGap <= allowedGap) return { campus: previousCampus, side: 'previous' };
    if (nextGap <= allowedGap) return { campus: nextCampus, side: 'next' };
    return { campus: previousCampus, side: 'previous' };
  }

  function getOneSidedVirtualForcedCampus(item, context, index, direction, physicalCampus, allowedGap) {
    if (!physicalCampus) return '';
    const neighbor = findCampusAuditCampusItem(context, index, direction);
    if (!neighbor) return '';
    const neighborCampus = getCampusAuditComparableCampus(neighbor);
    if (!neighborCampus || neighborCampus !== physicalCampus) return '';
    const gap = direction > 0
      ? neighbor.event.startMinutes - item.event.endMinutes
      : item.event.startMinutes - neighbor.event.endMinutes;
    return gap <= allowedGap ? physicalCampus : '';
  }

  function getVirtualAssignmentCommuteIssue(item, assignment, previous, next) {
    if (!assignment) return null;
    if (assignment.side === 'same') return null;

    if (assignment.side === 'previous' || assignment.side === 'selected-next') {
      if (!next?.physicalCampus || next.physicalCampus === assignment.campus) return null;
      const requiredMinutes = getCommuteMinutes(assignment.campus, next.physicalCampus);
      if (requiredMinutes == null) return null;
      const availableMinutes = next.event.startMinutes - item.event.endMinutes;
      if (availableMinutes >= requiredMinutes) return null;
      return {
        previous: item.event,
        current: next.event,
        requiredMinutes,
        availableMinutes,
        reason: `${compactEventText(item.event)} 按 ${assignment.campus} 判定；${formatMinutes(item.event.endMinutes)} ${assignment.campus} 结束，到 ${formatMinutes(next.event.startMinutes)} ${next.physicalCampus} 上课，可通勤 ${availableMinutes} 分钟，需要 ${requiredMinutes} 分钟`
      };
    }

    if (!previous?.physicalCampus || previous.physicalCampus === assignment.campus) return null;
    const requiredMinutes = getCommuteMinutes(previous.physicalCampus, assignment.campus);
    if (requiredMinutes == null) return null;
    const availableMinutes = item.event.startMinutes - previous.event.endMinutes;
    if (availableMinutes >= requiredMinutes) return null;
    return {
      previous: previous.event,
      current: item.event,
      requiredMinutes,
      availableMinutes,
      reason: `${compactEventText(item.event)} 按 ${assignment.campus} 判定；${formatMinutes(previous.event.endMinutes)} ${previous.physicalCampus} 结束，到 ${formatMinutes(item.event.startMinutes)} ${assignment.campus} 开始，可通勤 ${availableMinutes} 分钟，需要 ${requiredMinutes} 分钟`
    };
  }

  function isSameCampusChoice(actual, expected) {
    return Boolean(actual && expected && actual === expected);
  }

  function createCampusAuditAnomaly(input) {
    const previous = input.previous;
    const current = input.current;
    const blockingEvents = input.blockingEvents || [];
    return {
      id: [
        previous?.key || '',
        blockingEvents.map((item) => item.key).join('>>'),
        current?.key || '',
        input.kind,
        input.reason || ''
      ].join('>>'),
      kind: input.kind,
      teacher: previous?.teacher || current?.teacher || blockingEvents[0]?.teacher || '',
      date: previous?.date || current?.date || blockingEvents[0]?.date || '',
      previous,
      current,
      requiredMinutes: input.requiredMinutes ?? null,
      availableMinutes: input.availableMinutes ?? null,
      blockingEvents,
      reason: input.reason
    };
  }

  function createTwoColorSandwichAnomalies(events, settings) {
    const anomalies = [];
    const campusEvents = events.filter(isMultiCampusSummaryEvent).sort(compareByTime);
    const groups = buildConsecutiveColorGroups(campusEvents);
    for (let index = 1; index < groups.length - 1; index += 1) {
      const previousGroup = groups[index - 1];
      const middleGroup = groups[index];
      const nextGroup = groups[index + 1];
      if (!previousGroup || !middleGroup || !nextGroup) continue;
      if (previousGroup.colorKey !== nextGroup.colorKey) continue;
      if (middleGroup.colorKey === previousGroup.colorKey) continue;

      const previous = previousGroup.events[previousGroup.events.length - 1];
      const current = nextGroup.events[0];
      const blockingEvents = middleGroup.events;

      const previousCampus = getMultiCampusSummaryCampus(previous);
      const nextCampus = getMultiCampusSummaryCampus(current);
      if (!previousCampus || previousCampus !== nextCampus) continue;

      const middleCampuses = Array.from(new Set(blockingEvents.map(getMultiCampusSummaryCampus).filter(Boolean)));
      if (!middleCampuses.length || middleCampuses.every((campus) => campus === previousCampus)) continue;

      const commuteSummary = getTwoColorSandwichCommuteSummary(previous, blockingEvents, current);
      const hasOnlineOuter = previousGroup.events.some(isOnlineCourseEvent)
        || nextGroup.events.some(isOnlineCourseEvent);
      const hasOnlineMiddle = blockingEvents.some(isOnlineCourseEvent);
      const anomaly = createTwoColorSandwichAnomaly({
        kind: commuteSummary?.hasIssue ? '异常：时间不够跑校区' : '异常：夹心色块',
        previous,
        current,
        blockingEvents,
        requiredMinutes: commuteSummary?.requiredMinutes ?? null,
        availableMinutes: commuteSummary?.availableMinutes ?? null,
        reason: hasOnlineOuter && !hasOnlineMiddle
          ? '老师跑了三次校区，注意查看'
          : (hasOnlineOuter
            ? '有线上课，未改校区，目前课表有三个校区，注意查看'
            : (hasOnlineMiddle ? '含线上，但是线下跑了三次校区' : '线下跑了三次校区'))
      });
      anomalies.push(anomaly);
    }

    return dedupeAnomalies(anomalies);
  }

  function buildConsecutiveColorGroups(events) {
    const groups = [];
    (events || []).forEach((event) => {
      const colorKey = getMultiCampusSummaryColorKey(event);
      if (!colorKey) return;

      const last = groups[groups.length - 1];
      if (!last || last.colorKey !== colorKey) {
        groups.push({
          colorKey,
          campus: getMultiCampusSummaryCampus(event),
          events: [event]
        });
        return;
      }

      last.events.push(event);
    });
    return groups;
  }

  function getTwoColorSandwichCommuteSummary(previous, blockingEvents, current) {
    const middleEvents = (blockingEvents || []).filter(Boolean).sort(compareByTime);
    const firstMiddle = middleEvents[0];
    const lastMiddle = middleEvents[middleEvents.length - 1];
    if (!previous || !firstMiddle || !lastMiddle || !current) return null;

    const checks = [
      buildSandwichCommuteCheck(previous, firstMiddle),
      buildSandwichCommuteCheck(lastMiddle, current)
    ].filter(Boolean);
    if (!checks.length) return null;

    const failed = checks.filter((item) => item.availableMinutes < item.requiredMinutes);
    const targetChecks = failed.length ? failed : checks;
    const requiredMinutes = Math.max(...targetChecks.map((item) => item.requiredMinutes));
    const availableMinutes = Math.min(...targetChecks.map((item) => item.availableMinutes));

    if (failed.length) {
      return {
        hasIssue: true,
        requiredMinutes,
        availableMinutes,
      };
    }

    return {
      hasIssue: false,
      requiredMinutes,
      availableMinutes
    };
  }

  function buildSandwichCommuteCheck(previous, current) {
    const fromCampus = getMultiCampusSummaryCampus(previous);
    const toCampus = getMultiCampusSummaryCampus(current);
    if (!fromCampus || !toCampus || fromCampus === toCampus) return null;

    const requiredMinutes = getCommuteMinutes(fromCampus, toCampus);
    if (requiredMinutes == null) return null;

    return {
      fromCampus,
      toCampus,
      requiredMinutes,
      availableMinutes: current.startMinutes - previous.endMinutes
    };
  }

  function createTwoColorSandwichAnomaly(input) {
    const { kind, previous, current, blockingEvents, requiredMinutes = null, availableMinutes = null, reason } = input;
    return {
      id: `${previous.key}>>${(blockingEvents || []).map((item) => item.key).join('>>')}>>${current.key}>>${kind}`,
      kind,
      teacher: previous.teacher,
      date: previous.date,
      previous,
      current,
      requiredMinutes,
      availableMinutes,
      blockingEvents: blockingEvents || [],
      reason
    };
  }

  function summarizeSandwichCampuses(events) {
    return Array.from(new Set((events || []).map((event) => {
      const campus = getMultiCampusSummaryCampus(event);
      const hex = normalizeHex(event.hex);
      return hex ? `${campus || '未知校区'}(${hex})` : campus;
    }).filter(Boolean))).join('、') || '未知校区';
  }

  function isOnlineCampusRuleContextEvent(event) {
    return Boolean(
      event
      && getCourseRealCampus(event)
      && !isNoCourseDayOffEvent(event)
      && event.type !== 'dayOff'
      && (event.type === 'real' || isVirtualOnlineCampusRuleEvent(event))
    );
  }

  function isVirtualOnlineCampusRuleEvent(event) {
    return Boolean(event && (
      event.courseForm === '线上'
      || event.type === 'online'
      || event.campus === '线上'
      || event.campus === '虚拟校区'
      || Boolean(CONFIG.onlineByColor[normalizeHex(event.hex)])
    ));
  }

  function getCourseRealCampus(event) {
    if (!event) return '';
    const colorCampus = getColorRealCampus(event);
    if (colorCampus) return colorCampus;
    if (event.courseCampus && CONFIG.realCampuses.has(event.courseCampus)) return event.courseCampus;
    if (event.detailCampus && CONFIG.realCampuses.has(event.detailCampus)) return event.detailCampus;
    if (event.campus && CONFIG.realCampuses.has(event.campus)) return event.campus;
    return '';
  }

  function getColorRealCampus(event) {
    const campus = CONFIG.campusByColor[normalizeHex(event?.hex)];
    return CONFIG.realCampuses.has(campus) ? campus : '';
  }

  function createMeetingBufferAnomalies(events) {
    const timedEvents = (events || [])
      .filter((event) => isFiniteMeetingTime(event) && !isNoCourseDayOffEvent(event) && event.type !== 'dayOff')
      .sort(compareByTime);
    const anomalies = [];

    for (let index = 0; index < timedEvents.length - 1; index += 1) {
      const previous = timedEvents[index];
      const current = timedEvents[index + 1];

      const availableMinutes = current.startMinutes - previous.endMinutes;
      if (availableMinutes >= CONFIG.meetingEventBufferMinutes) continue;
      const reason = availableMinutes < 0
        ? `${previous.end} 结束与 ${current.start} 开始重叠 ${Math.abs(availableMinutes)} 分钟，需要至少间隔 ${CONFIG.meetingEventBufferMinutes} 分钟`
        : `${previous.end} 结束到 ${current.start} 开始仅间隔 ${availableMinutes} 分钟，需要至少 ${CONFIG.meetingEventBufferMinutes} 分钟`;

      anomalies.push({
        id: `${previous.key}>>${current.key}>>空足不满5分钟`,
        kind: '空足不满5分钟',
        teacher: previous.teacher,
        date: previous.date,
        previous,
        current,
        requiredMinutes: CONFIG.meetingEventBufferMinutes,
        availableMinutes,
        blockingEvents: [],
        reason
      });
    }

    return anomalies;
  }

  function getMaSiyuSummerNoonExtraGap(previous, current) {
    if (normalizeName(previous?.teacher) !== '马思雨') return null;
    if (!isJulyOrAugust(previous.date)) return null;
    const noonEndMinutes = 12 * 60;
    const requiredMinutes = 110;
    if (previous.endMinutes < noonEndMinutes || previous.endMinutes >= 14 * 60) return null;
    return {
      requiredMinutes,
      availableMinutes: current.startMinutes - previous.endMinutes
    };
  }

  function isJulyOrAugust(dateText) {
    const match = String(dateText || '').match(/^\d{4}-(\d{1,2})-\d{1,2}$/);
    if (!match) return false;
    const month = Number(match[1]);
    return month === 7 || month === 8;
  }

  function isCourseFormEvent(event) {
    return Boolean(event && event.courseForm && !isNoCourseDayOffEvent(event));
  }

  function dedupeAnomalies(anomalies) {
    const seen = new Set();
    return anomalies.filter((anomaly) => {
      if (!anomaly || !anomaly.id) return false;
      if (seen.has(anomaly.id)) return false;
      seen.add(anomaly.id);
      return true;
    });
  }

  function buildRangeDayOffEvents(events) {
    const ranges = [];
    events.forEach((event) => {
      if (!event?.teacher || !event?.text) return;
      const range = parseDayOffDateRange(event.text, event.date);
      if (!range) return;
      ranges.push({ sourceEvent: event, range });
    });

    if (!ranges.length) return new Map();

    const neededDatesByTeacher = new Map();
    events.forEach((event) => {
      if (!event.teacher || !event.date) return;
      const key = normalizeName(event.teacher);
      if (!neededDatesByTeacher.has(key)) neededDatesByTeacher.set(key, new Set());
      neededDatesByTeacher.get(key).add(event.date);
    });

    const dayOffs = new Map();
    ranges.forEach(({ sourceEvent, range }) => {
      const teacherKey = normalizeName(sourceEvent.teacher);
      const neededDates = neededDatesByTeacher.get(teacherKey) || new Set();
      const listedDates = Array.isArray(range.dates) ? new Set(range.dates) : null;
      neededDates.forEach((date) => {
        if (listedDates ? !listedDates.has(date) : date < range.startDate || date > range.endDate) return;
        const groupKey = `${sourceEvent.teacher}||${date}`;
        if (!dayOffs.has(groupKey)) {
          dayOffs.set(groupKey, createRangeDayOffEvent(sourceEvent, date, range));
        }
      });
    });

    return dayOffs;
  }

  function createRangeDayOffEvent(sourceEvent, date, range) {
    const dayRange = getRangeDayOffMinutesForDate(date, range);
    const fullDay = dayRange.startMinutes <= 0 && dayRange.endMinutes >= 1440;
    return {
      key: `${sourceEvent.key}>>range-day-off>>${date}`,
      teacher: sourceEvent.teacher,
      text: Array.isArray(range.dates)
        ? `休息（${range.dates.join('、')} ${range.kind}）`
        : `休息（${range.startDate} 至 ${range.endDate} ${range.kind}）`,
      hex: '',
      type: 'dayOff',
      campus: '休息',
      colorMeaning: '休息',
      date,
      dateLabel: '',
      dateIndex: sourceEvent.dateIndex,
      startMinutes: dayRange.startMinutes,
      endMinutes: dayRange.endMinutes,
      start: fullDay ? '全天' : formatMinutes(dayRange.startMinutes),
      end: fullDay ? '全天' : formatMinutes(dayRange.endMinutes),
      parentIndex: sourceEvent.parentIndex,
      rowIndex: sourceEvent.rowIndex,
      itemIndex: -1,
      scanTop: sourceEvent.scanTop,
      rect: sourceEvent.rect
    };
  }

  function getRangeDayOffMinutesForDate(date, range) {
    let startMinutes = 0;
    let endMinutes = 1440;
    if (date === range.startDate && range.startPeriod) {
      startMinutes = getPeriodBoundaryMinutes(range.startPeriod).startMinutes;
    }
    if (date === range.endDate && range.endPeriod) {
      endMinutes = getPeriodBoundaryMinutes(range.endPeriod).endMinutes;
    }
    if (endMinutes <= startMinutes) return { startMinutes: 0, endMinutes: 1440 };
    return { startMinutes, endMinutes };
  }

  function getPeriodBoundaryMinutes(period) {
    const normalized = normalizeDayOffText(period);
    if (/上午|早上|早间|上半天/.test(normalized)) return { startMinutes: 0, endMinutes: 12 * 60 };
    if (/中午|午间/.test(normalized)) return { startMinutes: 12 * 60, endMinutes: 14 * 60 };
    if (/下午|午后|下半天/.test(normalized)) return { startMinutes: 12 * 60, endMinutes: 1440 };
    if (/晚上|晚间|傍晚/.test(normalized)) return { startMinutes: 18 * 60, endMinutes: 1440 };
    return { startMinutes: 0, endMinutes: 1440 };
  }

  function isMeetingEvent(event) {
    return Boolean(event && (event.isMeeting || (CONFIG.onlineByColor[event.hex] && !isCourseFormEvent(event))));
  }

  function isDayOffEvent(event) {
    if (isRestDayEvent(event)) return true;
    if (isNoCourseDayOffEvent(event)) return true;
    const text = String(event.text || '');
    if (isUnavailableLeaveText(text)) return true;
    if (!hasTimeRange(text) && isSameDayUnavailableText(text)) return true;
    if (!isMeetingEvent(event)) return false;
    return false;
  }

  function compareDayOffEventPriority(a, b) {
    return getDayOffEventPriority(b) - getDayOffEventPriority(a);
  }

  function getDayOffEventPriority(event) {
    if (!event) return 0;
    if (String(event.key || '').includes('range-day-off')) return 3;
    if (isUnavailableLeaveText(event.text)) return 2;
    if (isNoCourseDayOffEvent(event)) return 1;
    return 0;
  }

  function isRestDayEvent(event) {
    return Boolean(event && event.type === 'dayOff' && hasRestText(event.text));
  }

  function isNoCourseDayOffEvent(event) {
    return Boolean(event && hasNoCourseText(event.text));
  }

  function findRestLabelElementInCell(cell) {
    return findRestLabelElementInScope(cell);
  }

  function isRestBackgroundDateCell(cell) {
    if (!cell || cell.closest?.('.item') || cell.closest?.('#ccheck-panel')) return false;
    const rect = cell.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return false;

    const style = getComputedStyle(cell);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (!hasDataUrlBackgroundImage(cell, style)) return false;

    return true;
  }

  function hasDataUrlBackgroundImage(element, style) {
    const inlineStyle = element.getAttribute('style') || '';
    const backgroundImage = String((style || getComputedStyle(element)).backgroundImage || '');
    return /background-image\s*:\s*url\(["']?data:image\//i.test(inlineStyle)
      || /url\(["']?data:image\//i.test(backgroundImage);
  }

  function findRestLabelElementInScope(scope) {
    const exact = findRestLabelElement(scope, isRestLabelText);
    if (exact) return exact;
    return findRestLabelElement(scope, hasRestText);
  }

  function findRestLabelElement(scope, matcher) {
    const cell = scope;
    if (!cell) return null;
    const candidates = [cell].concat(Array.from(cell.querySelectorAll('*')));
    const matchedElement = candidates.find((element) => {
      if (element.closest('.item')) return false;
      if (!matcher(textOf(element))) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    if (matchedElement) return matchedElement;

    const walker = document.createTreeWalker(
      cell,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || parent.closest('.item') || parent.closest('.time')) return NodeFilter.FILTER_REJECT;
          return matcher(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }
    );
    const textNode = walker.nextNode();
    return textNode?.parentElement || null;
  }

  function collectVisibleRestTextMatches(scope) {
    if (!scope) return [];
    const matches = [];
    const walker = document.createTreeWalker(
      scope,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest('#ccheck-panel')) return NodeFilter.FILTER_REJECT;
          if (parent.closest('.item') || parent.closest('.time')) return NodeFilter.FILTER_REJECT;
          if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
          if (!hasRestText(node.nodeValue)) return NodeFilter.FILTER_REJECT;
          const style = getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      const range = document.createRange();
      range.selectNodeContents(node);
      let rect = range.getBoundingClientRect();
      range.detach();

      if (rect.width < 1 || rect.height < 1) {
        rect = parent.getBoundingClientRect();
      }

      if (rect.width >= 1 && rect.height >= 1) {
        matches.push({
          element: parent,
          source: 'dom-text',
          text: textOf(parent) || String(node.nodeValue || '').trim(),
          rect
        });
      }

      node = walker.nextNode();
    }

    return matches;
  }

  function collectVisiblePseudoRestMatches(scope) {
    if (!scope) return [];
    const matches = [];
    const elements = Array.from(scope.querySelectorAll('*'));

    elements.forEach((element) => {
      if (element.closest('#ccheck-panel')) return;
      if (element.closest('.item') || element.closest('.time')) return;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(element.tagName)) return;

      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;

      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return;

      ['::before', '::after'].forEach((pseudo) => {
        const content = cssContentText(getComputedStyle(element, pseudo).content);
        if (!hasRestText(content)) return;
        matches.push({
          element,
          source: pseudo,
          text: content,
          rect
        });
      });
    });

    return dedupeRestMatches(matches);
  }

  function dedupeRestMatches(matches) {
    const seen = new Set();
    return matches.filter((item) => {
      const key = [
        item.source,
        item.text,
        Math.round(item.rect.x),
        Math.round(item.rect.y),
        Math.round(item.rect.width),
        Math.round(item.rect.height)
      ].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function cssContentText(content) {
    const raw = String(content || '');
    if (!raw || raw === 'normal' || raw === 'none' || raw === '""' || raw === "''") return '';
    return raw
      .replace(/^['"]|['"]$/g, '')
      .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/\\(["'\\])/g, '$1');
  }

  function hasRestText(text) {
    return normalizeDayOffText(text).includes('休息');
  }

  function hasExplicitDayOffMarkerText(text) {
    const normalized = normalizeDayOffText(text);
    return hasRestText(text)
      || hasExchangeRestText(text)
      || isSameDayUnavailableText(text)
      || isUnavailableLeaveText(text)
      || /节假日休/.test(normalized);
  }

  function hasNoCourseText(text) {
    const raw = String(text || '');
    const normalized = normalizeDayOffText(raw).replace(/[－–—~～]/g, '-');
    return /(?:不排课|补课不排课|学校补课不排课|不排班课|班课不排|不排班|不排(?!除))/.test(normalized)
      || /空出-?/.test(normalized);
  }

  function isSameDayUnavailableText(text) {
    const normalized = normalizeDayOffText(text);
    const datePart = '\\d{1,2}(?:[./月]\\d{1,2})?日?';
    const kindPart = '(?:请假|休假|调休)';
    return new RegExp(`^(?:全天)?${kindPart}(?:全天)?(?:${datePart})?$`).test(normalized)
      || new RegExp(`^(?:${datePart})?(?:全天)?${kindPart}(?:全天)?$`).test(normalized);
  }

  function hasExchangeRestText(text) {
    return normalizeDayOffText(text).includes('换休');
  }

  function parseDayOffDateRange(text, baseDate, options = {}) {
    const raw = String(text || '');
    const kind = getDayOffRangeKind(raw);
    if (!kind) return null;

    const base = parseIsoDateParts(baseDate);
    if (!base) return null;
    const includeHalfDayRange = options.includeHalfDayRange !== false;

    const normalized = raw
      .replace(/[－–—~～]/g, '-')
      .replace(/至|到/g, '-');

    const listedDates = parseListedDayOffDates(normalized, base, kind);
    if (listedDates) return listedDates;

    const fullIso = normalized.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s*-\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (fullIso) {
      return normalizeDateRange({
        startYear: Number(fullIso[1]),
        startMonth: Number(fullIso[2]),
        startDay: Number(fullIso[3]),
        endYear: Number(fullIso[4]),
        endMonth: Number(fullIso[5]),
        endDay: Number(fullIso[6]),
        kind
      });
    }

    const numericMonthDay = normalized.match(/(\d{1,2})[./](\d{1,2})\s*-\s*(?:(\d{1,2})[./])?(\d{1,2})/);
    if (numericMonthDay) {
      const startMonth = Number(numericMonthDay[1]);
      const endMonth = Number(numericMonthDay[3] || startMonth);
      return normalizeDateRange({
        startYear: base.year,
        startMonth,
        startDay: Number(numericMonthDay[2]),
        endYear: base.year,
        endMonth,
        endDay: Number(numericMonthDay[4]),
        kind
      });
    }

    const chineseWithMonth = normalized.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日?\s*-\s*(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})日?/);
    if (chineseWithMonth) {
      const startYear = Number(chineseWithMonth[1] || base.year);
      const startMonth = Number(chineseWithMonth[2]);
      const endYear = Number(chineseWithMonth[4] || startYear);
      const endMonth = Number(chineseWithMonth[5] || startMonth);
      return normalizeDateRange({
        startYear,
        startMonth,
        startDay: Number(chineseWithMonth[3]),
        endYear,
        endMonth,
        endDay: Number(chineseWithMonth[6]),
        kind
      });
    }

    const dayOnly = normalized.match(/(\d{1,2})日\s*-\s*(\d{1,2})日/);
    if (dayOnly) {
      return normalizeDateRange({
        startYear: base.year,
        startMonth: base.month,
        startDay: Number(dayOnly[1]),
        endYear: base.year,
        endMonth: base.month,
        endDay: Number(dayOnly[2]),
        kind
      });
    }

    const dayPeriod = includeHalfDayRange
      ? normalized.match(/(\d{1,2})日?(上午|早上|早间|上半天|下午|午后|下半天|中午|午间|晚上|晚间|傍晚)?\s*-\s*(\d{1,2})日?(上午|早上|早间|上半天|下午|午后|下半天|中午|午间|晚上|晚间|傍晚)?/)
      : null;
    if (dayPeriod && (dayPeriod[2] || dayPeriod[4])) {
      return normalizeDateRange({
        startYear: base.year,
        startMonth: base.month,
        startDay: Number(dayPeriod[1]),
        endYear: base.year,
        endMonth: base.month,
        endDay: Number(dayPeriod[3]),
        startPeriod: dayPeriod[2] || '',
        endPeriod: dayPeriod[4] || '',
        kind
      });
    }

    return null;
  }

  function getDayOffRangeKind(text) {
    const raw = String(text || '');
    const explicit = raw.match(/请假|休假|调休/);
    if (explicit) return explicit[0];
    return hasDateRangeText(raw) && /休/.test(normalizeDayOffText(raw)) ? '休假' : '';
  }

  function hasDateRangeText(text) {
    const raw = String(text || '').replace(/[－–—~～]/g, '-').replace(/至|到/g, '-');
    return /\d{1,2}[./月]\d{1,2}日?\s*-\s*(?:(?:\d{1,2}[./月])?\d{1,2}日?)/.test(raw)
      || /\d{4}[-/]\d{1,2}[-/]\d{1,2}\s*-\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(raw)
      || /\d{1,2}日\s*-\s*\d{1,2}日/.test(raw)
      || /\d{1,2}日?(?:上午|早上|早间|上半天|下午|午后|下半天|中午|午间|晚上|晚间|傍晚)?\s*-\s*\d{1,2}日?(?:上午|早上|早间|上半天|下午|午后|下半天|中午|午间|晚上|晚间|傍晚)/.test(raw);
  }

  function parseListedDayOffDates(text, base, kind) {
    if (!/[，,、；;]/.test(text)) return null;
    const dates = Array.from(text.matchAll(/(?:(\d{4})[-/.年])?(\d{1,2})[-./月](\d{1,2})日?/g))
      .map((match) => makeDateInput(Number(match[1] || base.year), Number(match[2]), Number(match[3])))
      .filter(Boolean);
    if (dates.length < 2) return null;
    const uniqueDates = Array.from(new Set(dates)).sort();
    return {
      startDate: uniqueDates[0],
      endDate: uniqueDates[uniqueDates.length - 1],
      dates: uniqueDates,
      kind
    };
  }

  function normalizeDateRange(input) {
    const startDate = makeDateInput(input.startYear, input.startMonth, input.startDay);
    const endDate = makeDateInput(input.endYear, input.endMonth, input.endDay);
    if (!startDate || !endDate || startDate > endDate) return null;
    return {
      startDate,
      endDate,
      kind: input.kind,
      startPeriod: input.startPeriod || '',
      endPeriod: input.endPeriod || ''
    };
  }

  function parseIsoDateParts(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (Number.isNaN(date.getTime())) return null;
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return {
      year,
      month,
      day
    };
  }

  function makeDateInput(year, month, day) {
    if (!year || !month || !day) return '';
    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() !== year
      || date.getMonth() !== month - 1
      || date.getDate() !== day
    ) {
      return '';
    }
    return formatDateInput(date);
  }

  function isRestLabelText(text) {
    const normalized = normalizeDayOffText(text);
    return normalized === '休息' || /^(?:休息)+$/.test(normalized);
  }

  function normalizeDayOffText(text) {
    return String(text || '')
      .replace(/\s+/g, '')
      .replace(/[，,。.;；:：()（）【】\[\]{}]/g, '');
  }

  function hasTimeRange(text) {
    return /\d{1,2}\s*[:：]\s*\d{2}\s*(?:-|－|–|—|~|～|至|到)\s*\d{1,2}\s*[:：]\s*\d{2}/.test(String(text || ''));
  }

  function isCourseEventDuringDayOff(event, dayOffEvent) {
    if (!event || event.key === dayOffEvent.key) return false;
    if (!isCourseEventEligibleForDayOffAnomaly(event)) return false;
    const range = getDayOffRange(dayOffEvent);
    return event.startMinutes < range.endMinutes && event.endMinutes > range.startMinutes;
  }

  function isCourseEventEligibleForDayOffAnomaly(event) {
    if (!event) return false;
    if (isNonCourseDayOffMarker(event)) return false;
    if (isHolidayMarkerEvent(event)) return false;
    if (isNoCourseDayOffEvent(event)) return false;
    if (isMeetingEvent(event)) return true;
    if (event.type !== 'real' && !isOnlineCourseEvent(event)) return false;
    return true;
  }

  function isNonCourseDayOffMarker(event) {
    return Boolean(event && (event.type === 'dayOff' || isDayOffEvent(event) || isRestLabelText(event.text) || hasExchangeRestText(event.text)));
  }

  function isHolidayMarkerEvent(event) {
    return Boolean(event && isHolidayActivityMarkerText(event.text));
  }

  function isHolidayActivityMarkerText(text) {
    const normalized = normalizeDayOffText(String(text || '').replace(/\d{1,2}\s*[:：]\s*\d{2}\s*(?:-|－|–|—|~|～|至|到)\s*\d{1,2}\s*[:：]\s*\d{2}/g, ''));
    return /^(?:元旦节?|春节|除夕|清明节?|劳动节|五一|端午节?|中秋节?|国庆节?|十一)$/.test(normalized);
  }

  function isOnlineCourseEvent(event) {
    return Boolean(event && (
      event.courseForm === '线上'
      || event.type === 'online'
      || event.campus === '线上'
      || event.campus === '虚拟校区'
    ));
  }

  function getDayOffRange(event) {
    const explicitRange = parseDayOffTimeRange(event?.text);
    if (explicitRange) return explicitRange;
    const periodRange = parseDayOffPeriodRange(event?.text);
    if (periodRange) return periodRange;
    if (isRangeDayOffEvent(event) && hasFiniteDayOffEventRange(event)) {
      return { startMinutes: event.startMinutes, endMinutes: event.endMinutes };
    }
    if (isUnavailableLeaveText(event?.text) || isSameDayUnavailableText(event?.text)) {
      return { startMinutes: 0, endMinutes: 1440 };
    }
    if (hasFiniteDayOffEventRange(event)) {
      return { startMinutes: event.startMinutes, endMinutes: event.endMinutes };
    }
    if (isNoCourseDayOffEvent(event)) {
      return parseNoCourseRange(event.text) || { startMinutes: 0, endMinutes: 1440 };
    }
    return { startMinutes: 0, endMinutes: 1440 };
  }

  function isRangeDayOffEvent(event) {
    return Boolean(event && String(event.key || '').includes('range-day-off'));
  }

  function hasFiniteDayOffEventRange(event) {
    if (!event || !Number.isFinite(event.startMinutes) || !Number.isFinite(event.endMinutes)) return false;
    if (event.endMinutes <= event.startMinutes) return false;
    return event.startMinutes > 0 || event.endMinutes < 1440;
  }

  function parseNoCourseRange(text) {
    const explicitRange = parseDayOffTimeRange(text);
    if (explicitRange) return explicitRange;
    const periodRange = parseDayOffPeriodRange(text);
    if (periodRange) return periodRange;
    return null;
  }

  function parseDayOffPeriodRange(text) {
    const normalized = normalizeDayOffText(text);
    if (/上午|早上|早间|上半天/.test(normalized)) return { startMinutes: 0, endMinutes: 12 * 60 };
    if (/中午|午间/.test(normalized)) return { startMinutes: 12 * 60, endMinutes: 14 * 60 };
    if (/下午|午后|下半天/.test(normalized)) return { startMinutes: 12 * 60, endMinutes: 18 * 60 };
    if (/晚上|晚间|傍晚/.test(normalized)) return { startMinutes: 18 * 60, endMinutes: 1440 };
    return null;
  }

  function parseDayOffTimeRange(text) {
    const raw = String(text || '');
    const time = raw.match(/(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:-|－|–|—|~|～|至|到)\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
    if (time) {
      const startMinutes = Number(time[1]) * 60 + Number(time[2]);
      const endMinutes = Number(time[3]) * 60 + Number(time[4]);
      if (endMinutes > startMinutes) return { startMinutes, endMinutes };
    }
    return null;
  }

  function createDayOffAnomaly(dayOffEvent, courseEvent) {
    const unavailableKind = getDayOffUnavailableKind(dayOffEvent);
    const isRestDay = !unavailableKind && (isRestDayEvent(dayOffEvent) || isNoCourseDayOffEvent(dayOffEvent));
    const isLeavePeriod = /^(?:请假|休假)$/.test(unavailableKind || '');
    const isNoCourseGap = hasNoCourseGapText(dayOffEvent.text);
    const hasExplicitRange = Boolean(parseDayOffTimeRange(dayOffEvent.text));
    const kind = isLeavePeriod
      ? '休假期间有排课'
      : isRestDay
        ? '占休'
        : `${unavailableKind || '调休'}${hasExplicitRange ? '时段' : '全天'}排课`;
    return {
      id: `${dayOffEvent.key}>>${courseEvent.key}>>${kind}`,
      kind,
      teacher: dayOffEvent.teacher,
      date: dayOffEvent.date,
      previous: dayOffEvent,
      current: courseEvent,
      requiredMinutes: null,
      availableMinutes: null,
      blockingEvents: [],
      reason: formatDayOffAnomalyReason({
        isNoCourseGap,
        isLeavePeriod,
        isRestDay,
        unavailableKind,
        hasExplicitRange
      })
    };
  }

  function formatDayOffAnomalyReason(options) {
    const unavailableKind = options?.unavailableKind || '调休';
    if (options?.isNoCourseGap) return '检测到空出，确认是否占休';
    if (options?.isLeavePeriod) return '休假期间有排课';
    if (options?.isRestDay) return '休息日排课，确认是否占休';
    if (options?.hasExplicitRange) return `${unavailableKind}时段排课，确认是否占休`;
    return `默认${unavailableKind}一天，确认是否占休`;
  }

  function shouldRunSelfTest() {
    return typeof process !== 'undefined'
      && Array.isArray(process.argv)
      && process.argv.includes('--self-test');
  }

  function runCampusCommuteSelfTests() {
    const tests = [
      {
        name: '版本号：@version 与 SCRIPT_VERSION 一致',
        run: assertSelfTestVersionSync
      },
      {
        name: '会议草稿：色块图转到单时间会议页',
        run: assertSelfTestSingleMeetingDraftPath
      },
      {
        name: '占休：纯节日名即使被识别为线上占用也不占休',
        run: () => assertSelfTestDayOff(false, {
          text: '端午节',
          type: 'online',
          campus: '线上',
          courseForm: '线上'
        })
      },
      {
        name: '占休：纯节日名带视觉时间也不占休',
        run: () => assertSelfTestDayOff(false, {
          text: '端午节 09:00-17:30',
          isMeeting: true
        })
      },
      {
        name: '占休：节日活动带时间要占休',
        run: () => assertSelfTestDayOff(true, {
          text: '端午节活动 09:00-17:30',
          isMeeting: true
        })
      },
      {
        name: '占休：普通会议压到休息日要提示占休',
        run: () => assertSelfTestDayOff(true, {
          text: '教研沟通会 09:00-10:00',
          isMeeting: true
        })
      },
      {
        name: '占休：真实课程带节日名仍要提示占休',
        run: () => assertSelfTestDayOff(true, {
          text: '端午节语法课',
          type: 'real',
          campus: '城建校区'
        })
      },
      {
        name: '占休：明确休息时段内课程要提示占休',
        run: () => assertSelfTestDayOff(true, {
          text: '语法课',
          type: 'real',
          campus: '城建校区',
          startMinutes: 9 * 60,
          endMinutes: 10 * 60,
          start: '09:00',
          end: '10:00'
        }, {
          text: '休息 08:30-10:30'
        })
      },
      {
        name: '占休：明确休息时段外课程不占休',
        run: () => assertSelfTestDayOff(false, {
          text: '语法课',
          type: 'real',
          campus: '城建校区',
          startMinutes: 10 * 60 + 40,
          endMinutes: 12 * 60,
          start: '10:40',
          end: '12:00'
        }, {
          text: '休息 08:30-10:30'
        })
      },
      {
        name: '占休：无时间调休即使色块有时段也按全天占休',
        run: () => assertSelfTestDayOff(true, {
          text: '语法课',
          type: 'real',
          campus: '城建校区',
          startMinutes: 17 * 60 + 30,
          endMinutes: 18 * 60,
          start: '17:30',
          end: '18:00'
        }, {
          text: '调休',
          startMinutes: 9 * 60,
          endMinutes: 17 * 60,
          start: '09:00',
          end: '17:00'
        })
      },
      {
        name: '占休：明确调休时段外课程不占休',
        run: () => assertSelfTestDayOff(false, {
          text: '语法课',
          type: 'real',
          campus: '城建校区',
          startMinutes: 10 * 60 + 40,
          endMinutes: 12 * 60,
          start: '10:40',
          end: '12:00'
        }, {
          text: '调休 09:30-10:30'
        })
      },
      {
        name: '占休：上午调休下午课程不占休',
        run: () => assertSelfTestDayOff(false, {
          text: '语法课',
          type: 'real',
          campus: '城建校区',
          startMinutes: 13 * 60 + 15,
          endMinutes: 14 * 60,
          start: '13:15',
          end: '14:00'
        }, {
          text: '上午调休'
        })
      },
      {
        name: '占休：半天跨日期范围结束后不占休',
        run: assertSelfTestHalfDayRangeNoDayOff
      },
      {
        name: '排会议：无时间调休按全天不可排',
        run: assertSelfTestMeetingDayOffFullDay
      },
      {
        name: '排会议：半日日期范围不吃核对新增规则',
        run: assertSelfTestMeetingKeepsLegacyRangeParsing
      },
      {
        name: '督导：红字空白和 N/A/F 班次规则',
        run: assertSelfTestSupervisorCellRules
      },
      {
        name: '督导：XLS/HTML 导入辅助识别',
        run: assertSelfTestSupervisorImportHelpers
      },
      {
        name: '督导：导入页显示提醒明细',
        run: assertSelfTestSupervisorWarningDetails
      },
      {
        name: '督导：排会议页按姓名读取导入表',
        run: assertSelfTestMeetingSupervisorMatching
      },
      {
        name: '排会议：老师和督导两个字唯一匹配全名',
        run: assertSelfTestMeetingPartialNameMatching
      },
      {
        name: '排会议：共同空档只按勾选名单拆分督导',
        run: assertSelfTestMeetingSelectedNamesOverrideQuery
      },
      {
        name: '排会议：不显示逐日无可排列表',
        run: assertSelfTestMeetingNoSlotListHidden
      },
      {
        name: '会议草稿：进入新增页提示默认展开',
        run: assertSelfTestMeetingDraftNoteExpanded
      },
      {
        name: '排会议：督导班次说明',
        run: assertSelfTestMeetingSupervisorShiftDisplay
      },
      {
        name: '督导：F 灵活班和老师阻塞共同空档',
        run: assertSelfTestSupervisorMixedSlots
      },
      {
        name: '未改校区：线上课挂靠同一校区不报错',
        run: assertSelfTestOnlineSameCampusNoMismatch
      },
      {
        name: '未改校区：虚拟会议选错校区按上下线下课判定',
        run: assertSelfTestVirtualMeetingWrongCampusMismatch
      },
      {
        name: '校区：线上会议归属下一线下校区后时间不够',
        run: assertSelfTestOnlineMeetingAttachedToNextCommuteShort
      },
      {
        name: '校区：前置线上课程跟随下一线下校区',
        run: assertSelfTestLeadingOnlineCourseMismatch
      },
      {
        name: '检测：单侧线上不同校区但通勤足够仍提醒',
        run: assertSelfTestSingleSidedOnlineCampusCommuteEnough
      },
      {
        name: '检测：全天同一校区且末节线上课为其他校区',
        run: assertSelfTestOnlyOnlineDifferentCampusReminder
      },
      {
        name: '异常扫描：页面全表覆盖接口差异且不重复',
        run: assertSelfTestAuditScanMergesFullPageEvents
      },
      {
        name: '异常扫描：悬停失败前先读取完整内嵌详情',
        run: assertSelfTestImmediateCourseDetailsBeforeHoverLimit
      },
      {
        name: '异常扫描：同名课程详情不串台且实体颜色决定校区',
        run: assertSelfTestSameCourseNameKeepsColorCampus
      },
      {
        name: '跑校区查询：严格方向、实体段、线上夹层和日期隔离',
        run: assertSelfTestCampusCommuteQuery
      },
      {
        name: '校区：单侧线上异色紧贴线下要报未改校区',
        run: assertSelfTestSingleSidedOnlineCampusStickyMismatch
      },
      {
        name: '校区：两校区 A-B-A 回夹要报异常',
        run: assertSelfTestTwoCampusReturnSandwich
      },
      {
        name: '文案：未改校区和调休占休原因保持简短',
        run: assertSelfTestShortAnomalyReasons
      },
      {
        name: '校区：三实体校区时间不够且提示三校区',
        run: assertSelfTestThreeCampusesWithCommuteShort
      },
      {
        name: '校区：三实体校区时间够仍提示三校区',
        run: assertSelfTestThreeCampusesOnly
      },
      {
        name: '校区：虚拟夹在不同线下校区时间不够优先跑校区',
        run: assertSelfTestVirtualBetweenCampusesCommuteShort
      },
      {
        name: '校区：虚拟夹在不同线下校区时间够报未改',
        run: assertSelfTestVirtualBetweenCampusesMismatch
      },
      {
        name: '校区：全天会议跨三校区也提示三校区',
        run: assertSelfTestMeetingsAcrossThreeCampuses
      },
      {
        name: '规则页：显示当前规则与正式督导排班',
        run: assertSelfTestRulesOverview
      },
      {
        name: '会议新增页：日期 timestamp 模型也算已填入',
        run: assertSelfTestMeetingDateModelFill
      },
      {
        name: '会议新增页：固定星期候选精确匹配',
        run: assertSelfTestMeetingWeekdayFillValues
      },
      {
        name: '会议新增页：整句识别会议草稿',
        run: assertSelfTestSmartMeetingTextParsing
      }
    ];

    tests.forEach((test) => {
      test.run();
    });

    if (typeof console !== 'undefined') {
      console.log(`campus-commute self-test passed: ${tests.length} checks`);
    }
  }

  function assertSelfTestVersionSync() {
    if (typeof require !== 'function' || typeof process === 'undefined') return;
    const fs = require('fs');
    const source = fs.readFileSync(process.argv[1], 'utf8');
    const headerVersion = source.match(/\/\/\s*@version\s+([^\s]+)/)?.[1];
    if (headerVersion !== SCRIPT_VERSION) {
      throw new Error(`@version ${headerVersion || '(missing)'} 与 SCRIPT_VERSION ${SCRIPT_VERSION} 不一致`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(SCRIPT_VERSION)) {
      throw new Error(`SCRIPT_VERSION ${SCRIPT_VERSION} 不是 x.y.z 格式`);
    }
    if (/setNativeInputValue\(input,\s*prefix\)/.test(source)) {
      throw new Error('教室下拉不支持输入筛选，不应向教室输入框写入前缀');
    }
    if (!/data-action="commute-query">查询跑校区<\/button>/.test(source)) {
      throw new Error('跑校区按钮文案应为“查询跑校区”');
    }
    if (!/data-action="scan-all">异常扫描<\/button>/.test(source)) {
      throw new Error('核对课表主扫描按钮应显示为“异常扫描”');
    }
    if (!/const scanned = await scanAll\(\{ mode: 'commute' \}\);/.test(source)) {
      throw new Error('查询跑校区应能自动触发跑校区扫描');
    }
    if (!/const refreshed = await refreshTeacherScheduleForCommuteQuery\(\);/.test(source)) {
      throw new Error('查询跑校区自动扫描前应按当前日期刷新教师课表');
    }
  }

  function assertSelfTestSingleMeetingDraftPath() {
    const url = new URL(MEETING_ADD_PATH, 'https://www.antiedu.tech/');
    if (url.pathname !== '/meeting/add') {
      throw new Error(`色块图会议草稿必须转到单时间会议页 /meeting/add，实际：${url.pathname}`);
    }
    if (url.pathname === '/meeting/addForm') {
      throw new Error('色块图会议草稿不应转到多时间会议页 /meeting/addForm');
    }
  }

  function assertSelfTestRulesOverview() {
    const html = renderRulesOverviewHtml();
    [
      `v${SCRIPT_VERSION}`,
      '校区颜色',
      '通勤时间',
      '会议规则',
      '督导规则',
      '正式功能，排会议默认包含督导',
      'F 班'
    ].forEach((text) => {
      if (!html.includes(text)) {
        throw new Error(`规则页缺少：${text}`);
      }
    });
  }

  function assertSelfTestMeetingDateModelFill() {
    const expected = '2026-07-08';
    const date = new Date(2026, 6, 8);
    const timestamp = date.getTime();
    if (!isMeetingModelValueFilled(date, expected, 'date')) {
      throw new Error('会议日期 Date 模型应判定为已填入');
    }
    if (!isMeetingModelValueFilled(timestamp, expected, 'date')) {
      throw new Error('会议日期 timestamp 模型应判定为已填入');
    }
    if (!isMeetingModelValueFilled(String(timestamp), expected, 'date')) {
      throw new Error('会议日期 timestamp 字符串模型应判定为已填入');
    }
    const timestampComponent = {
      valueFormat: 'timestamp',
      $options: { componentName: 'ElDatePicker' }
    };
    const modelValue = toElementMeetingModelValue(expected, 'date', timestampComponent);
    if (modelValue !== timestamp || !isMeetingModelValueFilled(modelValue, expected, 'date')) {
      throw new Error(`会议日期 timestamp 写入值错误：${modelValue}`);
    }
  }

  function assertSelfTestMeetingWeekdayFillValues() {
    const values = getMeetingWeekdayFillValues({ weekday: '周五', weekdayValues: ['周五', '星期五'] });
    if (values.join(',') !== '周五,星期五') {
      throw new Error(`固定星期填充候选应为周五/星期五，实际：${values.join(',')}`);
    }
    const targets = normalizeMeetingOptionTargets(values, '星期');
    if (!targets.length || !targets.every((target) => target.exactOnly)) {
      throw new Error('固定星期选择必须精确匹配，避免误选其他星期');
    }
    if (scoreMeetingOptionText('周五', targets) <= 0 || scoreMeetingOptionText('周五周六', targets) > 0) {
      throw new Error('固定星期选项评分应只接受精确星期文本');
    }
  }

  function assertSelfTestSmartMeetingTextParsing() {
    const occupyTeacherDraft = parseSmartMeetingText('老师，辛苦占空一下潘沁雯老师7.31下午紫金2:55-3:15，20分钟就行', {
      now: new Date(2026, 0, 1)
    });
    const occupyTeacherExpected = {
      date: '2026-07-31',
      startTime: '14:55',
      endTime: '15:15',
      durationMinutes: 20,
      timePeriod: '下午',
      meetingMode: 'offline',
      meetingCampus: '紫金港',
      meetingName: '占空',
      teachers: '潘沁雯'
    };
    if (!occupyTeacherDraft.ok) throw new Error(`占空原文回归识别失败：${occupyTeacherDraft.message}`);
    Object.entries(occupyTeacherExpected).forEach(([key, value]) => {
      const actual = key === 'teachers' ? occupyTeacherDraft.teachers.join(',') : occupyTeacherDraft[key];
      if (actual !== value) throw new Error(`占空原文回归 ${key} 应为 ${value}，实际：${actual}`);
    });
    if (getMeetingDraftClassroomPrefixes(occupyTeacherDraft).join(',') !== 'M') {
      throw new Error(`占空原文回归应自动选择 M 教室，实际：${getMeetingDraftClassroomPrefixes(occupyTeacherDraft).join(',')}`);
    }
    const supervisorRecurring = parseSmartMeetingText('主管会：8月开始每周二9:00-10:35（M1001）\n参会人：雪梨', {
      now: new Date(2026, 6, 15, 9, 0)
    });
    if (!supervisorRecurring.ok) throw new Error(`主管会原文回归识别失败：${supervisorRecurring.message}`);
    const supervisorExpected = {
      date: '2026-08-04',
      endDate: '2026-08-25',
      startTime: '09:00',
      endTime: '10:35',
      durationMinutes: 95,
      meetingName: '主管会',
      meetingMode: 'offline',
      meetingCampus: '',
      teachers: '张佳颖'
    };
    Object.entries(supervisorExpected).forEach(([key, value]) => {
      const actual = key === 'teachers' ? supervisorRecurring.teachers.join(',') : supervisorRecurring[key];
      if (actual !== value) throw new Error(`主管会原文 ${key} 应为 ${value}，实际 ${actual}`);
    });
    if (getMeetingDraftClassroomPrefixes(supervisorRecurring).length) {
      throw new Error(`未识别校区时不应自动选择 M1001 教室，实际：${getMeetingDraftClassroomPrefixes(supervisorRecurring).join(',')}`);
    }
    const supervisorNaturalRange = parseSmartMeetingText('主管会：8月开始到12月底结束，每周二9:00-10:35（M1001）\n参会人：雪梨', {
      now: new Date(2026, 6, 15, 9, 0)
    });
    if (!supervisorNaturalRange.ok || supervisorNaturalRange.meetingName !== '主管会' || supervisorNaturalRange.date !== '2026-08-04' || supervisorNaturalRange.endDate !== '2026-12-29' || supervisorNaturalRange.startTime !== '09:00' || supervisorNaturalRange.endTime !== '10:35' || supervisorNaturalRange.durationMinutes !== 95 || supervisorNaturalRange.meetingMode !== 'offline' || supervisorNaturalRange.meetingCampus || supervisorNaturalRange.teachers.join(',') !== '张佳颖') {
      throw new Error(`主管会自然月份范围回归失败：${JSON.stringify({ meetingName: supervisorNaturalRange.meetingName, date: supervisorNaturalRange.date, endDate: supervisorNaturalRange.endDate, startTime: supervisorNaturalRange.startTime, endTime: supervisorNaturalRange.endTime, durationMinutes: supervisorNaturalRange.durationMinutes, meetingMode: supervisorNaturalRange.meetingMode, meetingCampus: supervisorNaturalRange.meetingCampus, teachers: supervisorNaturalRange.teachers })}`);
    }
    const supervisorNaturalIntro = parseSmartMeetingText('排一个会议：主管会8月开始到12月底结束每周二9:00-10:35', {
      now: new Date(2026, 6, 15, 9, 0)
    });
    if (!supervisorNaturalIntro.ok || supervisorNaturalIntro.meetingName !== '主管会' || supervisorNaturalIntro.date !== '2026-08-04' || supervisorNaturalIntro.endDate !== '2026-12-29' || supervisorNaturalIntro.startTime !== '09:00' || supervisorNaturalIntro.endTime !== '10:35' || supervisorNaturalIntro.durationMinutes !== 95) {
      throw new Error(`排一个会议自然月份范围回归失败：${JSON.stringify({ meetingName: supervisorNaturalIntro.meetingName, date: supervisorNaturalIntro.date, endDate: supervisorNaturalIntro.endDate, startTime: supervisorNaturalIntro.startTime, endTime: supervisorNaturalIntro.endTime, durationMinutes: supervisorNaturalIntro.durationMinutes })}`);
    }
    const supervisorNameBeforeWeekday = parseSmartMeetingText('给我从8月开始到12月开始排主管会，每周二09:00-10:35', {
      now: new Date(2026, 6, 15, 9, 0)
    });
    if (!supervisorNameBeforeWeekday.ok || supervisorNameBeforeWeekday.meetingName !== '主管会' || supervisorNameBeforeWeekday.date !== '2026-08-04' || supervisorNameBeforeWeekday.endDate !== '2026-12-29' || supervisorNameBeforeWeekday.startTime !== '09:00' || supervisorNameBeforeWeekday.endTime !== '10:35' || supervisorNameBeforeWeekday.durationMinutes !== 95 || supervisorNameBeforeWeekday.meetingMode !== 'offline' || supervisorNameBeforeWeekday.meetingCampus || supervisorNameBeforeWeekday.teachers.length) {
      throw new Error(`周期前会议名称回归失败：${JSON.stringify({ meetingName: supervisorNameBeforeWeekday.meetingName, date: supervisorNameBeforeWeekday.date, endDate: supervisorNameBeforeWeekday.endDate, startTime: supervisorNameBeforeWeekday.startTime, endTime: supervisorNameBeforeWeekday.endTime, durationMinutes: supervisorNameBeforeWeekday.durationMinutes, meetingMode: supervisorNameBeforeWeekday.meetingMode, meetingCampus: supervisorNameBeforeWeekday.meetingCampus, teachers: supervisorNameBeforeWeekday.teachers })}`);
    }
    const twoLessonMeeting = parseSmartMeetingText('7月每周二9:00，两课时，主管培训，参会人：雪梨', {
      now: new Date(2026, 6, 1, 9, 0)
    });
    if (!twoLessonMeeting.ok || twoLessonMeeting.startTime !== '09:00' || twoLessonMeeting.endTime !== '10:35' || twoLessonMeeting.durationMinutes !== 95) {
      throw new Error(`两课时应按 95 分钟计算，实际：${twoLessonMeeting.startTime}-${twoLessonMeeting.endTime}/${twoLessonMeeting.durationMinutes}`);
    }
    const draft = parseSmartMeetingText('7.9晚上排一个【沈悦颜】家长会，18：30城西线下，参会人：沈豪杰+毛婧', {
      now: new Date(2026, 0, 1)
    });
    if (!draft.ok) throw new Error(`整句识别失败：${draft.message}`);
    const expected = {
      date: '2026-07-09',
      startTime: '18:30',
      endTime: '19:15',
      durationMinutes: 45,
      meetingName: '【沈悦颜】家长会',
      meetingMode: 'offline',
      timePeriod: '晚上',
      meetingCampus: '紫金港',
      teachers: '沈豪杰,毛婧'
    };
    Object.entries(expected).forEach(([key, value]) => {
      const actual = key === 'teachers' ? draft.teachers.join(',') : draft[key];
      if (actual !== value) {
        throw new Error(`整句识别 ${key} 应为 ${value}，实际 ${actual}`);
      }
    });
    if (!getMeetingCampusFillValues(draft).includes('紫金港')) {
      throw new Error('城西映射应优先兼容系统内“紫金港”选项');
    }
    if (getMeetingDraftClassroomPrefixes(draft).join(',') !== 'M') {
      throw new Error(`明确城西线下时应生成 M 教室候选，实际：${getMeetingDraftClassroomPrefixes(draft).join(',')}`);
    }
    const noCampusMeeting = parseSmartMeetingText('7.9晚上排一个【沈悦颜】家长会，18：30，参会人：沈豪杰+毛婧', {
      now: new Date(2026, 0, 1)
    });
    if (!noCampusMeeting.ok) throw new Error(`无校区会议识别失败：${noCampusMeeting.message}`);
    if (noCampusMeeting.meetingCampus || getMeetingCampusFillValues(noCampusMeeting).length || getMeetingDraftClassroomPrefixes(noCampusMeeting).length) {
      throw new Error(`未指出校区时不应选择校区或教室，实际校区：${noCampusMeeting.meetingCampus}，教室候选：${getMeetingDraftClassroomPrefixes(noCampusMeeting).join(',')}`);
    }
    const meetingRoomDraft = parseSmartMeetingText('7.9晚上排一个【沈悦颜】家长会，18：30城西线下会议室，参会人：沈豪杰+毛婧', {
      now: new Date(2026, 0, 1)
    });
    if (!meetingRoomDraft.ok) throw new Error(`会议室会议识别失败：${meetingRoomDraft.message}`);
    if (meetingRoomDraft.meetingCampus !== '紫金港' || getMeetingDraftClassroomPrefixes(meetingRoomDraft).join(',') !== '会议室,M') {
      throw new Error(`明确会议室时应先选会议室再兜底 M，实际校区：${meetingRoomDraft.meetingCampus}，教室候选：${getMeetingDraftClassroomPrefixes(meetingRoomDraft).join(',')}`);
    }
    const bigClassroomDraft = parseSmartMeetingText('7.9晚上排一个【沈悦颜】家长会，20:00城西线下大教室，参会人：沈豪杰+毛婧', {
      now: new Date(2026, 0, 1)
    });
    if (!bigClassroomDraft.ok) throw new Error(`大教室会议识别失败：${bigClassroomDraft.message}`);
    if (getMeetingDraftClassroomPrefixes(bigClassroomDraft).join(',') !== 'M') {
      throw new Error(`大教室未写会议室时应优先 M，实际：${getMeetingDraftClassroomPrefixes(bigClassroomDraft).join(',')}`);
    }
    const smallClassroomDraft = parseSmartMeetingText('7.9晚上排一个【沈悦颜】家长会，20:00城西线下小教室，参会人：沈豪杰+毛婧', {
      now: new Date(2026, 0, 1)
    });
    if (!smallClassroomDraft.ok) throw new Error(`小教室会议识别失败：${smallClassroomDraft.message}`);
    if (getMeetingDraftClassroomPrefixes(smallClassroomDraft).join(',') !== 'V') {
      throw new Error(`小教室应只生成 V 教室候选，实际：${getMeetingDraftClassroomPrefixes(smallClassroomDraft).join(',')}`);
    }
    const shortClassroomMessage = formatMeetingClassroomDropdownDebug({
      prefixes: ['会议室', 'M'],
      total: 20,
      options: ['M206', 'M202', '802会议室'],
      skippedV: ['V901'],
      scrolls: 1,
      scrollTrace: [{ oldTop: 0, newTop: 220, maxTop: 424 }],
      matched: '802会议室'
    });
    if (shortClassroomMessage !== '教室：802会议室') {
      throw new Error(`教室提示应只显示选中教室，实际：${shortClassroomMessage}`);
    }
    const planTime = parseSmartMeetingText('7.9 晚上 沈悦颜升学规划时间18点30 参与人沈豪杰+毛婧', {
      now: new Date(2026, 0, 1)
    });
    if (!planTime.ok) throw new Error(`规划时间句识别失败：${planTime.message}`);
    if (planTime.meetingName !== '沈悦颜升学规划') {
      throw new Error(`规划时间前应识别为会议名称，实际：${planTime.meetingName}`);
    }
    if (planTime.durationMinutes !== 45 || planTime.endTime !== '19:15') {
      throw new Error(`未标注时长时应默认 45 分钟，实际 ${planTime.durationMinutes} 分钟，结束 ${planTime.endTime}`);
    }
    if (planTime.meetingMode !== 'offline') {
      throw new Error('没有明确线上时应默认线下');
    }
    if (planTime.teachers.join(',') !== '沈豪杰,毛婧') {
      throw new Error(`参与人应识别参会名单，实际：${planTime.teachers.join(',')}`);
    }
    const halfPastTime = parseSmartMeetingText('7.9 上午09点半 钱江业务小会 参与人：雪梨+小霞', {
      now: new Date(2026, 0, 1)
    });
    if (!halfPastTime.ok) throw new Error(`09点半格式识别失败：${halfPastTime.message}`);
    if (halfPastTime.startTime !== '09:30' || halfPastTime.endTime !== '10:15' || halfPastTime.meetingName !== '钱江业务小会') {
      throw new Error(`09点半应识别为 09:30 和正确会议名称，实际 ${halfPastTime.startTime}-${halfPastTime.endTime}/${halfPastTime.meetingName}`);
    }
    const chineseMixedTime = parseSmartMeetingText('7.9 上午九点30-十点15 钱江业务小会 参与人：雪梨+小霞', {
      now: new Date(2026, 0, 1)
    });
    if (!chineseMixedTime.ok) throw new Error(`九点30格式识别失败：${chineseMixedTime.message}`);
    if (chineseMixedTime.startTime !== '09:30' || chineseMixedTime.endTime !== '10:15' || chineseMixedTime.durationMinutes !== 45) {
      throw new Error(`九点30-十点15 应识别为 09:30-10:15，实际 ${chineseMixedTime.startTime}-${chineseMixedTime.endTime}/${chineseMixedTime.durationMinutes}`);
    }
    const zhangNingOffline = parseSmartMeetingText('7.9 上午九点30 xxx会议 钱江线下 参与人：张宁+小霞', {
      now: new Date(2026, 0, 1)
    });
    if (!zhangNingOffline.ok) throw new Error(`张宁线下会议识别失败：${zhangNingOffline.message}`);
    if (zhangNingOffline.meetingName !== 'xxx会议-钱江线下') {
      throw new Error(`张宁线下会议名称应追加校区线下，实际：${zhangNingOffline.meetingName}`);
    }
    if (zhangNingOffline.meetingCampus !== '钱江校区' || zhangNingOffline.meetingMode !== 'offline') {
      throw new Error(`张宁线下会议应保持钱江校区/线下，实际：${zhangNingOffline.meetingCampus}/${zhangNingOffline.meetingMode}`);
    }
    const zhangNingLocationLine = parseSmartMeetingText('杨芸沁沟通\n钱江线下\n7.9的10:40\n张宁', {
      now: new Date(2026, 0, 1)
    });
    if (!zhangNingLocationLine.ok) throw new Error(`张宁地点独立行格式识别失败：${zhangNingLocationLine.message}`);
    if (zhangNingLocationLine.meetingName !== '杨芸沁沟通-钱江线下') {
      throw new Error(`张宁地点独立行会议名称应为 杨芸沁沟通-钱江线下，实际：${zhangNingLocationLine.meetingName}`);
    }
    if (zhangNingLocationLine.date !== '2026-07-09' || zhangNingLocationLine.startTime !== '10:40' || zhangNingLocationLine.endTime !== '11:25') {
      throw new Error(`张宁地点独立行应识别 2026-07-09 10:40-11:25，实际 ${zhangNingLocationLine.date} ${zhangNingLocationLine.startTime}-${zhangNingLocationLine.endTime}`);
    }
    if (zhangNingLocationLine.meetingCampus !== '钱江校区' || zhangNingLocationLine.meetingMode !== 'offline' || zhangNingLocationLine.timePeriod !== '上午') {
      throw new Error(`张宁地点独立行应识别钱江校区/线下/上午，实际：${zhangNingLocationLine.meetingCampus}/${zhangNingLocationLine.meetingMode}/${zhangNingLocationLine.timePeriod}`);
    }
    if (zhangNingLocationLine.teachers.join(',') !== '张宁') {
      throw new Error(`张宁地点独立行参会人应只识别张宁，实际：${zhangNingLocationLine.teachers.join(',')}`);
    }
    const possessiveTimeTitle = parseSmartMeetingText('给教务老师留言, 辛苦占空 沈豪杰 7.9, 16:30的 王语甜 理科规划沟通会\n参与人: 沈豪杰，毛婧，余素清，郭丽珍', {
      now: new Date(2026, 6, 8)
    });
    if (!possessiveTimeTitle.ok) throw new Error(`时间后“的”标题格式识别失败：${possessiveTimeTitle.message}`);
    if (possessiveTimeTitle.meetingName !== '王语甜 理科规划沟通会') {
      throw new Error(`时间后“的”标题应识别为 王语甜 理科规划沟通会，实际：${possessiveTimeTitle.meetingName}`);
    }
    if (possessiveTimeTitle.date !== '2026-07-09' || possessiveTimeTitle.startTime !== '16:30' || possessiveTimeTitle.endTime !== '17:15') {
      throw new Error(`时间后“的”标题应识别 2026-07-09 16:30-17:15，实际 ${possessiveTimeTitle.date} ${possessiveTimeTitle.startTime}-${possessiveTimeTitle.endTime}`);
    }
    if (possessiveTimeTitle.teachers.join(',') !== '沈豪杰,毛婧,余素清,郭丽珍') {
      throw new Error(`时间后“的”标题参会人识别错误，实际：${possessiveTimeTitle.teachers.join(',')}`);
    }
    const possessiveTimeTitleOccupyTeacher = parseSmartMeetingText('给教务老师留言, 辛苦占空 沈豪杰 7.9, 16:30的 王语甜 理科规划沟通会', {
      now: new Date(2026, 6, 8)
    });
    if (!possessiveTimeTitleOccupyTeacher.ok) throw new Error(`占空老师参会人格式识别失败：${possessiveTimeTitleOccupyTeacher.message}`);
    if (possessiveTimeTitleOccupyTeacher.meetingName !== '王语甜 理科规划沟通会') {
      throw new Error(`占空老师参会人格式会议名称应为 王语甜 理科规划沟通会，实际：${possessiveTimeTitleOccupyTeacher.meetingName}`);
    }
    if (possessiveTimeTitleOccupyTeacher.teachers.join(',') !== '沈豪杰') {
      throw new Error(`占空老师应作为参会人，实际：${possessiveTimeTitleOccupyTeacher.teachers.join(',')}`);
    }
    const participantOnly = parseSmartMeetingText('7.9晚上沈悦颜学习规划参与人沈豪杰+毛婧，18:30城西', {
      now: new Date(2026, 0, 1)
    });
    if (!participantOnly.ok) throw new Error(`参与人句识别失败：${participantOnly.message}`);
    if (participantOnly.meetingName !== '沈悦颜学习规划') {
      throw new Error(`参与人前应识别为会议名称，实际：${participantOnly.meetingName}`);
    }
    const screenshotLike = parseSmartMeetingText('【高瑞逸学业规划】\n时间：7.7上午 11:30-12:15\n地点：钱江校区线下\n参加人：高梨老师+戴+艺艺+吴梦茜', {
      now: new Date(2026, 0, 1)
    });
    if (!screenshotLike.ok) throw new Error(`截图格式整句识别失败：${screenshotLike.message}`);
    if (screenshotLike.timePeriod !== '上午' || screenshotLike.meetingCampus !== '钱江校区' || screenshotLike.meetingMode !== 'offline') {
      throw new Error(`截图格式应识别上午/钱江校区/线下，实际：${screenshotLike.timePeriod}/${screenshotLike.meetingCampus}/${screenshotLike.meetingMode}`);
    }
    if (screenshotLike.meetingName !== '【高瑞逸学业规划】') {
      throw new Error(`截图格式会议名称识别错误，实际：${screenshotLike.meetingName}`);
    }
    if (screenshotLike.teachers.join(',') !== '高梨,戴,艺艺,吴梦茜') {
      throw new Error(`参加人应识别参会名单，实际：${screenshotLike.teachers.join(',')}`);
    }
    const participantBeforeTimeLine = parseSmartMeetingText('【国高备考新生咨询】\n参与人：侯艳芬+沈莺\n时间：7.4 日钱江线下 16:00-17:00', {
      now: new Date(2026, 0, 1)
    });
    if (!participantBeforeTimeLine.ok) throw new Error(`参与人换行时间句识别失败：${participantBeforeTimeLine.message}`);
    if (participantBeforeTimeLine.teachers.join(',') !== '侯艳芬,沈莺') {
      throw new Error(`参与人遇到时间行应截断，实际：${participantBeforeTimeLine.teachers.join(',')}`);
    }
    if (participantBeforeTimeLine.startTime !== '16:00' || participantBeforeTimeLine.endTime !== '17:00' || participantBeforeTimeLine.durationMinutes !== 60) {
      throw new Error(`显式时间段应识别为 16:00-17:00，实际 ${participantBeforeTimeLine.startTime}-${participantBeforeTimeLine.endTime}/${participantBeforeTimeLine.durationMinutes}`);
    }
    const noisyParticipantLine = parseSmartMeetingText('【国高备考新生咨询】 参与人：侯艳芬+沈莺 学生待定 时间：7.4日钱江线下16:00-17:00', {
      now: new Date(2026, 0, 1)
    });
    if (!noisyParticipantLine.ok) throw new Error(`学生待定格式识别失败：${noisyParticipantLine.message}`);
    if (noisyParticipantLine.teachers.join(',') !== '侯艳芬,沈莺') {
      throw new Error(`学生待定前应截断参会人，实际：${noisyParticipantLine.teachers.join(',')}`);
    }
    const nameAfterClock = parseSmartMeetingText('7月10日上午10:00 钱江业务小会 参与人：雪梨、小霞、守艺、我', {
      now: new Date(2026, 0, 1)
    });
    if (!nameAfterClock.ok) throw new Error(`时间后会议名称格式识别失败：${nameAfterClock.message}`);
    if (nameAfterClock.meetingName !== '钱江业务小会') {
      throw new Error(`时间后的正文应识别为会议名称，实际：${nameAfterClock.meetingName}`);
    }
    if (nameAfterClock.teachers.join(',') !== '张佳颖,小霞,守艺') {
      throw new Error(`我/本人不应进入自动参会人，实际：${nameAfterClock.teachers.join(',')}`);
    }
    const spacedNameAfterClock = parseSmartMeetingText('7月10日 上午10：00 钱江业务小会, 参与人：雪梨、小霞、守芝+我', {
      now: new Date(2026, 0, 1)
    });
    if (!spacedNameAfterClock.ok) throw new Error(`截图时间后会议名称格式识别失败：${spacedNameAfterClock.message}`);
    if (spacedNameAfterClock.date !== '2026-07-10' || spacedNameAfterClock.startTime !== '10:00' || spacedNameAfterClock.endTime !== '10:45') {
      throw new Error(`截图格式日期时间应为 2026-07-10 10:00-10:45，实际 ${spacedNameAfterClock.date} ${spacedNameAfterClock.startTime}-${spacedNameAfterClock.endTime}`);
    }
    if (spacedNameAfterClock.meetingName !== '钱江业务小会') {
      throw new Error(`截图格式会议名称应识别为钱江业务小会，实际：${spacedNameAfterClock.meetingName}`);
    }
    if (spacedNameAfterClock.meetingMode !== 'offline' || spacedNameAfterClock.timePeriod !== '上午' || spacedNameAfterClock.meetingCampus !== '钱江校区') {
      throw new Error(`截图格式应识别线下/上午/钱江校区，实际：${spacedNameAfterClock.meetingMode}/${spacedNameAfterClock.timePeriod}/${spacedNameAfterClock.meetingCampus}`);
    }
    if (spacedNameAfterClock.teachers.join(',') !== '张佳颖,小霞,守芝') {
      throw new Error(`截图格式参会人应过滤我并保留人员，实际：${spacedNameAfterClock.teachers.join(',')}`);
    }
    const bracketDateHeading = parseSmartMeetingText('辛苦帮忙排一下\n\n【7月14日】\n14：30 城西续费&新签梳理--线上\n\n雪梨+我+素清\n雪梨给的时间', {
      now: new Date(2026, 6, 12)
    });
    if (!bracketDateHeading.ok) throw new Error(`日期方括号会议格式识别失败：${bracketDateHeading.message}`);
    if (bracketDateHeading.date !== '2026-07-14' || bracketDateHeading.startTime !== '14:30' || bracketDateHeading.endTime !== '15:15') {
      throw new Error(`日期方括号会议日期时间应为 2026-07-14 14:30-15:15，实际 ${bracketDateHeading.date} ${bracketDateHeading.startTime}-${bracketDateHeading.endTime}`);
    }
    if (bracketDateHeading.meetingName !== '城西续费&新签梳理') {
      throw new Error(`日期方括号与备注不应进入会议名称，实际：${bracketDateHeading.meetingName}`);
    }
    if (bracketDateHeading.meetingMode !== 'online' || bracketDateHeading.meetingCampus !== '紫金港' || getMeetingDraftClassroomPrefixes(bracketDateHeading).join(',') !== 'M') {
      throw new Error(`日期方括号会议应识别线上/紫金港且选 M 教室，实际：${bracketDateHeading.meetingMode}/${bracketDateHeading.meetingCampus}/${getMeetingDraftClassroomPrefixes(bracketDateHeading).join(',')}`);
    }
    if (bracketDateHeading.teachers.join(',') !== '张佳颖,素清') {
      throw new Error(`日期方括号会议应识别雪梨和素清并过滤我，实际：${bracketDateHeading.teachers.join(',')}`);
    }
    const nameAfterTimeRange = parseSmartMeetingText('7月7日下午13:15-15:15 00钱江新生梳理 参与人：雪梨+小霞', {
      now: new Date(2026, 0, 1)
    });
    if (!nameAfterTimeRange.ok) throw new Error(`时间范围后会议名称格式识别失败：${nameAfterTimeRange.message}`);
    if (nameAfterTimeRange.date !== '2026-07-07' || nameAfterTimeRange.startTime !== '13:15' || nameAfterTimeRange.endTime !== '15:15') {
      throw new Error(`时间范围后格式日期时间应为 2026-07-07 13:15-15:15，实际 ${nameAfterTimeRange.date} ${nameAfterTimeRange.startTime}-${nameAfterTimeRange.endTime}`);
    }
    if (nameAfterTimeRange.meetingName !== '00钱江新生梳理') {
      throw new Error(`时间范围后的正文应识别为会议名称，实际：${nameAfterTimeRange.meetingName}`);
    }
    if (nameAfterTimeRange.meetingMode !== 'offline' || nameAfterTimeRange.timePeriod !== '下午' || nameAfterTimeRange.meetingCampus !== '钱江校区') {
      throw new Error(`时间范围后格式应识别线下/下午/钱江校区，实际：${nameAfterTimeRange.meetingMode}/${nameAfterTimeRange.timePeriod}/${nameAfterTimeRange.meetingCampus}`);
    }
    if (nameAfterTimeRange.teachers.join(',') !== '张佳颖,小霞') {
      throw new Error(`时间范围后格式参会人识别错误，实际：${nameAfterTimeRange.teachers.join(',')}`);
    }
    const spokenAliasNames = parsePastedTeacherNames('兰兰+芝芝，侯女士、潘潘 浪浪');
    if (spokenAliasNames.join(',') !== '滕艳兰,蔡守芝,侯艳芬,潘沁雯,王雯浪') {
      throw new Error(`口头叫法应归一到正式老师姓名，实际：${spokenAliasNames.join(',')}`);
    }
    const resolvedGenericAttendeeName = pickMeetingAttendeeDisplayName(['李明霞 / 教师'], normalizeName('明霞'));
    if (resolvedGenericAttendeeName !== '李明霞') {
      throw new Error(`参会人显示名应优先使用系统选中全名，实际：${resolvedGenericAttendeeName}`);
    }
    const resolvedGroupedAttendeeName = pickMeetingAttendeeDisplayName(['全体英语教师 / 张任新'], normalizeName('张任新'));
    if (resolvedGroupedAttendeeName !== '张任新') {
      throw new Error(`参会人显示名不应带上分组标签，实际：${resolvedGroupedAttendeeName}`);
    }
    const classroomCampusCodes = [
      ['7.8上午10:00 CUA507线下 会议名称：城建教室会 参与人：小霞', '城建大厦', 'CUA'],
      ['7.8上午10:00 cub508线下 会议名称：城建小写教室会 参与人：小霞', '城建大厦', 'CUB'],
      ['7.8上午10:00 QUA209线下 会议名称：钱江教室会 参与人：小霞', '钱江校区', 'QUA'],
      ['7.8上午10:00 zua101线下 会议名称：紫金教室会 参与人：小霞', '紫金港', 'ZUA']
    ];
    classroomCampusCodes.forEach(([text, expectedCampus, alias]) => {
      const parsed = parseSmartMeetingText(text, { now: new Date(2026, 0, 1) });
      if (!parsed.ok) throw new Error(`教室编码校区识别失败：${parsed.message}`);
      if (parsed.meetingCampus !== expectedCampus) {
        throw new Error(`${alias} 应识别为 ${expectedCampus}，实际：${parsed.meetingCampus}`);
      }
      if (!parsed.meetingCampusAliases.some((value) => normalizeName(value) === normalizeName(alias))) {
        throw new Error(`${alias} 应作为校区识别别名保留，实际：${parsed.meetingCampusAliases.join(',')}`);
      }
      if (getMeetingCampusFillValues(parsed).some((value) => /^[A-Z]+$/i.test(value))) {
        throw new Error(`${alias} 不应进入实际校区下拉候选，实际：${getMeetingCampusFillValues(parsed).join(',')}`);
      }
      if (getMeetingDraftClassroomPrefixes(parsed).some((value) => normalizeName(value).toUpperCase() === alias)) {
        throw new Error(`${alias} 只应作为校区识别候选，不应进入教室前缀候选`);
      }
    });
    const explicitLocationName = parseSmartMeetingText('排一下【线下 高嘉昱学业规划】\n时间：7月5号15点\n地点：钱江线下\n参加人：小霞老师+我', {
      now: new Date(2026, 0, 1)
    });
    if (!explicitLocationName.ok) throw new Error(`明确地点会议名称格式识别失败：${explicitLocationName.message}`);
    if (explicitLocationName.meetingName !== '【高嘉昱学业规划】') {
      throw new Error(`排一下/线下标签应从会议名称中去除，实际：${explicitLocationName.meetingName}`);
    }
    if (explicitLocationName.meetingCampus !== '钱江校区') {
      throw new Error(`明确地点钱江线下应优先识别为钱江校区，实际：${explicitLocationName.meetingCampus}`);
    }
    if (explicitLocationName.meetingMode !== 'offline' || explicitLocationName.timePeriod !== '下午') {
      throw new Error(`明确地点格式应识别线下/下午，实际：${explicitLocationName.meetingMode}/${explicitLocationName.timePeriod}`);
    }
    if (explicitLocationName.teachers.join(',') !== '小霞') {
      throw new Error(`明确地点格式参会人应过滤我并去老师后缀，实际：${explicitLocationName.teachers.join(',')}`);
    }
    const communicationRemark = parseSmartMeetingText('辛苦教务老师安排一下【周沐昀家长会】[玫瑰]\n时间：7.11上午10：30\n地点：城西线下\n参会人：雪梨老师+我\n\n已跟雪梨老师沟通噢', {
      now: new Date(2026, 6, 8)
    });
    if (!communicationRemark.ok) throw new Error(`沟通备注格式识别失败：${communicationRemark.message}`);
    if (communicationRemark.meetingName !== '【周沐昀家长会】') {
      throw new Error(`沟通备注格式会议名称应保留【】标题，实际：${communicationRemark.meetingName}`);
    }
    if (communicationRemark.date !== '2026-07-11' || communicationRemark.startTime !== '10:30' || communicationRemark.endTime !== '11:15') {
      throw new Error(`沟通备注格式日期时间应为 2026-07-11 10:30-11:15，实际 ${communicationRemark.date} ${communicationRemark.startTime}-${communicationRemark.endTime}`);
    }
    if (communicationRemark.meetingCampus !== '紫金港' || communicationRemark.meetingMode !== 'offline' || communicationRemark.timePeriod !== '上午') {
      throw new Error(`沟通备注格式应识别城西线下/紫金港/上午，实际：${communicationRemark.meetingCampus}/${communicationRemark.meetingMode}/${communicationRemark.timePeriod}`);
    }
    if (communicationRemark.teachers.join(',') !== '张佳颖') {
      throw new Error(`沟通备注不应进入参会人，实际：${communicationRemark.teachers.join(',')}`);
    }
    const explicitDateBeatsRelativeText = parseSmartMeetingText('辛苦老师明天上班排【金大川家长会】\n时间：7.10城西线下16:00\n参会人员：张宁、雪梨、余素清、毛婧、王梦楠', {
      now: new Date(2026, 6, 8)
    });
    if (!explicitDateBeatsRelativeText.ok) throw new Error(`明确日期优先格式识别失败：${explicitDateBeatsRelativeText.message}`);
    if (explicitDateBeatsRelativeText.meetingName !== '【金大川家长会】-紫金港线下') {
      throw new Error(`张宁城西线下会议名称应追加紫金港线下，实际：${explicitDateBeatsRelativeText.meetingName}`);
    }
    if (explicitDateBeatsRelativeText.date !== '2026-07-10' || explicitDateBeatsRelativeText.startTime !== '16:00' || explicitDateBeatsRelativeText.endTime !== '16:45') {
      throw new Error(`明确 7.10 应优先于寒暄“明天”，实际 ${explicitDateBeatsRelativeText.date} ${explicitDateBeatsRelativeText.startTime}-${explicitDateBeatsRelativeText.endTime}`);
    }
    if (explicitDateBeatsRelativeText.meetingCampus !== '紫金港' || explicitDateBeatsRelativeText.meetingMode !== 'offline' || explicitDateBeatsRelativeText.timePeriod !== '下午') {
      throw new Error(`明确日期优先格式应识别城西线下/紫金港/下午，实际：${explicitDateBeatsRelativeText.meetingCampus}/${explicitDateBeatsRelativeText.meetingMode}/${explicitDateBeatsRelativeText.timePeriod}`);
    }
    if (explicitDateBeatsRelativeText.teachers.join(',') !== '张宁,张佳颖,余素清,毛婧,王梦楠') {
      throw new Error(`明确日期优先格式参会人识别错误，实际：${explicitDateBeatsRelativeText.teachers.join(',')}`);
    }
    const recurringWeeklyMeeting = parseSmartMeetingText('麻烦帮我排一下【市场中台周会】，在7月和8月的每个周五上午10:40-11:30，\n出席人：雪梨，泽凡，沈莺，童娜，子月，何滢，汪元元。城建校区哈～', {
      now: new Date(2026, 6, 8, 9, 0)
    });
    if (!recurringWeeklyMeeting.ok) throw new Error(`固定周会格式识别失败：${recurringWeeklyMeeting.message}`);
    if (recurringWeeklyMeeting.date !== '2026-07-10' || recurringWeeklyMeeting.endDate !== '2026-08-28') {
      throw new Error(`固定周会日期范围应为 2026-07-10 至 2026-08-28，实际：${recurringWeeklyMeeting.date} 至 ${recurringWeeklyMeeting.endDate}`);
    }
    if (recurringWeeklyMeeting.sourceKind !== 'smart-recurring-meeting-text' || recurringWeeklyMeeting.weekday !== '周五') {
      throw new Error(`固定周会应生成单条日期范围草稿并选择周五，实际：${recurringWeeklyMeeting.sourceKind}/${recurringWeeklyMeeting.weekday}`);
    }
    if ((recurringWeeklyMeeting.weekdayValues || []).join(',') !== '周五,星期五') {
      throw new Error(`固定周会星期候选应兼容周五/星期五，实际：${(recurringWeeklyMeeting.weekdayValues || []).join(',')}`);
    }
    if (recurringWeeklyMeeting.meetingName !== '【市场中台周会】') {
      throw new Error(`固定周会名称应保留标题，实际：${recurringWeeklyMeeting.meetingName}`);
    }
    if (recurringWeeklyMeeting.startTime !== '10:40' || recurringWeeklyMeeting.endTime !== '11:30' || recurringWeeklyMeeting.durationMinutes !== 50) {
      throw new Error(`固定周会时间应为 10:40-11:30，实际：${recurringWeeklyMeeting.startTime}-${recurringWeeklyMeeting.endTime}/${recurringWeeklyMeeting.durationMinutes}`);
    }
    if (recurringWeeklyMeeting.meetingMode !== 'offline' || recurringWeeklyMeeting.timePeriod !== '上午' || recurringWeeklyMeeting.meetingCampus !== '城建大厦') {
      throw new Error(`固定周会应识别城建线下/上午，实际：${recurringWeeklyMeeting.meetingMode}/${recurringWeeklyMeeting.timePeriod}/${recurringWeeklyMeeting.meetingCampus}`);
    }
    if (recurringWeeklyMeeting.teachers.join(',') !== '张佳颖,泽凡,沈莺,童娜,子月,何滢,汪元元') {
      throw new Error(`出席人应识别参会名单且截断校区尾巴，实际：${recurringWeeklyMeeting.teachers.join(',')}`);
    }
    const recurringZhangNingName = parseSmartMeetingText('麻烦排【市场中台周会】7月每个周五上午10:40-11:30 出席人：张宁、雪梨。城建校区哈～', {
      now: new Date(2026, 6, 8, 9, 0)
    });
    if (!recurringZhangNingName.ok) throw new Error(`固定周会张宁格式识别失败：${recurringZhangNingName.message}`);
    if (recurringZhangNingName.meetingName !== '【市场中台周会】') {
      throw new Error(`固定星期张宁参会时会议名不应追加校区，实际：${recurringZhangNingName.meetingName}`);
    }
    if (recurringZhangNingName.teachers.join(',') !== '张宁,张佳颖') {
      throw new Error(`固定星期张宁参会人识别错误，实际：${recurringZhangNingName.teachers.join(',')}`);
    }
    const recurringSameDayDefaultNextWeek = parseSmartMeetingText('排【周五会】7月每个周五上午10:40-11:30 出席人：雪梨、泽凡 城建校区', {
      now: new Date(2026, 6, 10, 9, 0)
    });
    if (!recurringSameDayDefaultNextWeek.ok || recurringSameDayDefaultNextWeek.date !== '2026-07-17' || recurringSameDayDefaultNextWeek.endDate !== '2026-07-31') {
      throw new Error(`固定周会默认不含今天，应从下周开始并保持日期范围，实际：${recurringSameDayDefaultNextWeek.date || recurringSameDayDefaultNextWeek.message} 至 ${recurringSameDayDefaultNextWeek.endDate || ''}`);
    }
    const recurringSameDayIncludeToday = parseSmartMeetingText('从今天开始排【周五会】7月每个周五上午10:40-11:30 出席人：雪梨、泽凡 城建校区', {
      now: new Date(2026, 6, 10, 9, 0)
    });
    if (!recurringSameDayIncludeToday.ok || recurringSameDayIncludeToday.date !== '2026-07-10' || recurringSameDayIncludeToday.endDate !== '2026-07-31') {
      throw new Error(`固定周会明确从今天开始时应包含今天，实际：${recurringSameDayIncludeToday.date || recurringSameDayIncludeToday.message}`);
    }
    const attendeePeopleLabel = parseSmartMeetingText('辛苦老师排【凌旻溱升学规划会】\n时间：7.8号下午14：00 城建线下\n参会人员：雪梨+陈江华+滕艳兰', {
      now: new Date(2026, 0, 1)
    });
    if (!attendeePeopleLabel.ok) throw new Error(`参会人员标签格式识别失败：${attendeePeopleLabel.message}`);
    if (attendeePeopleLabel.meetingName !== '【凌旻溱升学规划会】') {
      throw new Error(`参会人员标签格式会议名称应保留标题，实际：${attendeePeopleLabel.meetingName}`);
    }
    if (attendeePeopleLabel.date !== '2026-07-08' || attendeePeopleLabel.startTime !== '14:00' || attendeePeopleLabel.endTime !== '14:45') {
      throw new Error(`参会人员标签格式日期时间应为 2026-07-08 14:00-14:45，实际 ${attendeePeopleLabel.date} ${attendeePeopleLabel.startTime}-${attendeePeopleLabel.endTime}`);
    }
    if (attendeePeopleLabel.meetingMode !== 'offline' || attendeePeopleLabel.timePeriod !== '下午' || attendeePeopleLabel.meetingCampus !== '城建大厦') {
      throw new Error(`参会人员标签格式应识别线下/下午/城建大厦，实际：${attendeePeopleLabel.meetingMode}/${attendeePeopleLabel.timePeriod}/${attendeePeopleLabel.meetingCampus}`);
    }
    if (attendeePeopleLabel.teachers.join(',') !== '张佳颖,陈江华,滕艳兰') {
      throw new Error(`参会人员标签格式参会人应去除标签并归一雪梨，实际：${attendeePeopleLabel.teachers.join(',')}`);
    }
    const possessiveTeacherMeeting = parseSmartMeetingText('老师，辛苦调整一下7.17雪梨老师的会议，会议名称：【公办国际部学员家长分享】 时间 19:00-20:00[玫瑰]', {
      now: new Date(2026, 6, 9)
    });
    if (!possessiveTeacherMeeting.ok) throw new Error(`某老师的会议格式识别失败：${possessiveTeacherMeeting.message}`);
    if (possessiveTeacherMeeting.date !== '2026-07-17' || possessiveTeacherMeeting.startTime !== '19:00' || possessiveTeacherMeeting.endTime !== '20:00') {
      throw new Error(`某老师的会议格式日期时间应为 2026-07-17 19:00-20:00，实际 ${possessiveTeacherMeeting.date} ${possessiveTeacherMeeting.startTime}-${possessiveTeacherMeeting.endTime}`);
    }
    if (possessiveTeacherMeeting.meetingName !== '【公办国际部学员家长分享】') {
      throw new Error(`某老师的会议格式会议名称应只保留标题，实际：${possessiveTeacherMeeting.meetingName}`);
    }
    if (possessiveTeacherMeeting.teachers.join(',') !== '张佳颖') {
      throw new Error(`某老师的会议格式应从“雪梨老师的会议”识别参会人，实际：${possessiveTeacherMeeting.teachers.join(',')}`);
    }
    const dayOnlyExplicitName = parseSmartMeetingText('辛苦老师排【凌旻溱升学规划会】\n时间：8号下午14：00 城建线下 \n参会人员：雪梨+陈江华+滕艳兰', {
      now: new Date(2026, 6, 7)
    });
    if (!dayOnlyExplicitName.ok) throw new Error(`仅日期号格式识别失败：${dayOnlyExplicitName.message}`);
    if (dayOnlyExplicitName.meetingName !== '【凌旻溱升学规划会】') {
      throw new Error(`仅日期号格式应优先使用【】标题，实际：${dayOnlyExplicitName.meetingName}`);
    }
    if (dayOnlyExplicitName.date !== '2026-07-08' || dayOnlyExplicitName.startTime !== '14:00' || dayOnlyExplicitName.endTime !== '14:45') {
      throw new Error(`仅日期号格式应按当前月识别为 2026-07-08 14:00-14:45，实际 ${dayOnlyExplicitName.date} ${dayOnlyExplicitName.startTime}-${dayOnlyExplicitName.endTime}`);
    }
    if (dayOnlyExplicitName.meetingMode !== 'offline' || dayOnlyExplicitName.timePeriod !== '下午' || dayOnlyExplicitName.meetingCampus !== '城建大厦') {
      throw new Error(`仅日期号格式应识别线下/下午/城建大厦，实际：${dayOnlyExplicitName.meetingMode}/${dayOnlyExplicitName.timePeriod}/${dayOnlyExplicitName.meetingCampus}`);
    }
    if (dayOnlyExplicitName.teachers.join(',') !== '张佳颖,陈江华,滕艳兰') {
      throw new Error(`仅日期号格式参会人应去除标签并归一雪梨，实际：${dayOnlyExplicitName.teachers.join(',')}`);
    }
    const naturalStudentMeetingName = parseSmartMeetingText('给我排一个我和凌旻溱的升学规划会\n时间：8号下午14：00 城建线下\n参会人员：雪梨+陈江华+滕艳兰', {
      now: new Date(2026, 6, 7)
    });
    if (!naturalStudentMeetingName.ok) throw new Error(`自然名称格式识别失败：${naturalStudentMeetingName.message}`);
    if (naturalStudentMeetingName.meetingName !== '我-凌旻溱 升学规划会') {
      throw new Error(`自然名称格式应规整为“我-凌旻溱 升学规划会”，实际：${naturalStudentMeetingName.meetingName}`);
    }
    if (naturalStudentMeetingName.date !== '2026-07-08' || naturalStudentMeetingName.startTime !== '14:00') {
      throw new Error(`自然名称格式应识别当前月 8 号 14:00，实际 ${naturalStudentMeetingName.date} ${naturalStudentMeetingName.startTime}`);
    }
    const naturalOnceMeetingName = parseSmartMeetingText('给我排一次我和凌旻溱的升学规划会\n时间：8号下午14：00 城建线下\n参会人员：雪梨+陈江华+滕艳兰', {
      now: new Date(2026, 6, 7)
    });
    if (!naturalOnceMeetingName.ok) throw new Error(`排一次自然名称格式识别失败：${naturalOnceMeetingName.message}`);
    if (naturalOnceMeetingName.meetingName !== '我-凌旻溱 升学规划会') {
      throw new Error(`排一次自然名称格式应忽略动作词，实际：${naturalOnceMeetingName.meetingName}`);
    }
    [
      ['参会人员：雪梨、陈江华', '张佳颖,陈江华'],
      ['参会人：雪梨、陈江华', '张佳颖,陈江华'],
      ['出席人：雪梨、陈江华', '张佳颖,陈江华'],
      ['人员：雪梨、陈江华', '张佳颖,陈江华'],
      ['雪梨、陈江华', '张佳颖,陈江华']
    ].forEach(([text, expectedNames]) => {
      const names = parsePastedTeacherNames(text).join(',');
      if (names !== expectedNames) {
        throw new Error(`参会人粘贴标签应只识别姓名，${text} 实际：${names}`);
      }
    });
    const personnelLabelMeeting = parseSmartMeetingText('辛苦老师排【凌旻溱升学规划会】\n时间：8号下午14：00 城建线下\n人员：雪梨+陈江华+滕艳兰', {
      now: new Date(2026, 6, 7)
    });
    if (!personnelLabelMeeting.ok) throw new Error(`人员标签整句识别失败：${personnelLabelMeeting.message}`);
    if (personnelLabelMeeting.teachers.join(',') !== '张佳颖,陈江华,滕艳兰') {
      throw new Error(`人员标签整句应只识别姓名，实际：${personnelLabelMeeting.teachers.join(',')}`);
    }
    const unlabeledNamesMeeting = parseSmartMeetingText('辛苦老师排【凌旻溱升学规划会】\n时间：8号下午14：00 城建线下\n雪梨+陈江华+滕艳兰', {
      now: new Date(2026, 6, 7)
    });
    if (!unlabeledNamesMeeting.ok) throw new Error(`无标签参会人整句识别失败：${unlabeledNamesMeeting.message}`);
    if (unlabeledNamesMeeting.teachers.join(',') !== '张佳颖,陈江华,滕艳兰') {
      throw new Error(`无标签参会人整句应只识别姓名，实际：${unlabeledNamesMeeting.teachers.join(',')}`);
    }
    const meetingLabelWithUnlabeledNames = parseSmartMeetingText('会议：城西业务小会\n时间：7月30号13：30-15：30\n张佳颖++毛婧+素清', {
      now: new Date(2026, 6, 18)
    });
    const meetingLabelExpected = {
      meetingName: '城西业务小会',
      date: '2026-07-30',
      startTime: '13:30',
      endTime: '15:30',
      durationMinutes: 120,
      meetingMode: 'offline',
      timePeriod: '下午',
      meetingCampus: '紫金港',
      teachers: '张佳颖,毛婧,素清'
    };
    Object.entries(meetingLabelExpected).forEach(([key, value]) => {
      const actual = key === 'teachers' ? meetingLabelWithUnlabeledNames.teachers.join(',') : meetingLabelWithUnlabeledNames[key];
      if (actual !== value) throw new Error(`会议标签无参会人标签格式 ${key} 应为 ${value}，实际 ${actual}`);
    });
    if (getMeetingDraftClassroomPrefixes(meetingLabelWithUnlabeledNames).join(',') !== 'M') {
      throw new Error(`会议标签城西业务小会应生成 M 教室候选，实际：${getMeetingDraftClassroomPrefixes(meetingLabelWithUnlabeledNames).join(',')}`);
    }
    const occupyPossessiveTeacher = parseSmartMeetingText('7月25日 9:00-10:35帮我占空\n郝崇研老师的，钱江线下', {
      now: new Date(2026, 6, 20)
    });
    const occupyExpected = {
      meetingName: '占空',
      date: '2026-07-25',
      startTime: '09:00',
      endTime: '10:35',
      durationMinutes: 95,
      meetingMode: 'offline',
      timePeriod: '上午',
      meetingCampus: '钱江校区',
      teachers: '郝崇研'
    };
    Object.entries(occupyExpected).forEach(([key, value]) => {
      const actual = key === 'teachers' ? occupyPossessiveTeacher.teachers.join(',') : occupyPossessiveTeacher[key];
      if (actual !== value) throw new Error(`占空老师格式 ${key} 应为 ${value}，实际 ${actual}`);
    });
    if (getMeetingDraftClassroomPrefixes(occupyPossessiveTeacher).join(',') !== 'M') {
      throw new Error(`占空老师钱江线下应生成 M 教室候选，实际：${getMeetingDraftClassroomPrefixes(occupyPossessiveTeacher).join(',')}`);
    }
    ['雨娟', '梦瑶'].forEach((name) => {
      const namedOccupy = parseSmartMeetingText(`7月25日9:00-10:35${name}占空，钱江线下`, {
        now: new Date(2026, 6, 20)
      });
      if (!namedOccupy.ok || namedOccupy.meetingName !== `${name}占空` || namedOccupy.date !== '2026-07-25' || namedOccupy.startTime !== '09:00' || namedOccupy.endTime !== '10:35' || namedOccupy.durationMinutes !== 95 || namedOccupy.meetingMode !== 'offline' || namedOccupy.meetingCampus !== '钱江校区') {
        throw new Error(`${name}占空格式识别失败：${JSON.stringify({ meetingName: namedOccupy.meetingName, date: namedOccupy.date, startTime: namedOccupy.startTime, endTime: namedOccupy.endTime, durationMinutes: namedOccupy.durationMinutes, meetingMode: namedOccupy.meetingMode, meetingCampus: namedOccupy.meetingCampus })}`);
      }
    });
    const politeNamedOccupy = parseSmartMeetingText('辛苦老师帮包珂珂占空一下7.24上午9:00-10:35，王瑾音老师，紫金线下', {
      now: new Date(2026, 6, 20)
    });
    const politeNamedOccupyExpected = {
      meetingName: '包珂珂占空',
      date: '2026-07-24',
      startTime: '09:00',
      endTime: '10:35',
      durationMinutes: 95,
      meetingMode: 'offline',
      timePeriod: '上午',
      meetingCampus: '紫金港',
      teachers: '王瑾音'
    };
    Object.entries(politeNamedOccupyExpected).forEach(([key, value]) => {
      const actual = key === 'teachers' ? politeNamedOccupy.teachers.join(',') : politeNamedOccupy[key];
      if (actual !== value) throw new Error(`礼貌占空格式 ${key} 应为 ${value}，实际 ${actual}`);
    });
    if (getMeetingDraftClassroomPrefixes(politeNamedOccupy).join(',') !== 'M') {
      throw new Error(`礼貌占空紫金线下应生成 M 教室候选，实际：${getMeetingDraftClassroomPrefixes(politeNamedOccupy).join(',')}`);
    }
    const relativeOriLessonMeeting = parseSmartMeetingText('帮我排一下 ori批课 \n明天下午14:00-17:00\n席佳颖 +利锦 \n先城西线下排个教室', {
      now: new Date(2026, 6, 7)
    });
    if (!relativeOriLessonMeeting.ok) throw new Error(`ori批课相对日期格式识别失败：${relativeOriLessonMeeting.message}`);
    if (relativeOriLessonMeeting.meetingName !== 'ori批课') {
      throw new Error(`ori批课相对日期格式会议名称应为 ori批课，实际：${relativeOriLessonMeeting.meetingName}`);
    }
    if (relativeOriLessonMeeting.date !== '2026-07-08' || relativeOriLessonMeeting.startTime !== '14:00' || relativeOriLessonMeeting.endTime !== '17:00') {
      throw new Error(`ori批课相对日期格式应识别明天 14:00-17:00，实际 ${relativeOriLessonMeeting.date} ${relativeOriLessonMeeting.startTime}-${relativeOriLessonMeeting.endTime}`);
    }
    if (relativeOriLessonMeeting.meetingMode !== 'offline' || relativeOriLessonMeeting.timePeriod !== '下午' || relativeOriLessonMeeting.meetingCampus !== '紫金港') {
      throw new Error(`ori批课相对日期格式应识别城西线下/紫金港，实际：${relativeOriLessonMeeting.meetingMode}/${relativeOriLessonMeeting.timePeriod}/${relativeOriLessonMeeting.meetingCampus}`);
    }
    if (relativeOriLessonMeeting.teachers.join(',') !== '席佳颖,利锦') {
      throw new Error(`ori批课相对日期格式无标签参会人识别错误，实际：${relativeOriLessonMeeting.teachers.join(',')}`);
    }
    const online = parseSmartMeetingText('7.9晚上沈悦颜学习规划时间18:30线上，参与人沈豪杰+毛婧', {
      now: new Date(2026, 0, 1)
    });
    if (online.meetingMode !== 'online') {
      throw new Error('明确线上时应识别为线上会议');
    }
  }

  function assertSelfTestDayOff(expected, courseOverrides, dayOffOverrides) {
    const actual = isCourseEventDuringDayOff(
      makeSelfTestCourseEvent(courseOverrides),
      makeSelfTestDayOffEvent(dayOffOverrides)
    );
    if (actual !== expected) {
      throw new Error(`期望 ${expected ? '占休' : '不占休'}，实际 ${actual ? '占休' : '不占休'}：${courseOverrides.text}`);
    }
  }

  function makeSelfTestCourseEvent(overrides) {
    return {
      key: `course-${overrides?.text || 'default'}`,
      teacher: '测试老师',
      date: '2026-06-23',
      text: '语法课',
      type: 'real',
      campus: '城建校区',
      hex: '#SELFTEST',
      startMinutes: 9 * 60,
      endMinutes: 10 * 60,
      start: '09:00',
      end: '10:00',
      ...(overrides || {})
    };
  }

  function makeSelfTestDayOffEvent(overrides) {
    return {
      key: `day-off-${overrides?.text || 'default'}`,
      teacher: '测试老师',
      date: '2026-06-23',
      text: '休息',
      type: 'dayOff',
      campus: '休息',
      startMinutes: 0,
      endMinutes: 1440,
      start: '全天',
      end: '全天',
      ...(overrides || {})
    };
  }

  function assertSelfTestMeetingDayOffFullDay() {
    const source = getMeetingIntervalSourceEvent(makeSelfTestDayOffEvent({
      text: '调休',
      startMinutes: 9 * 60,
      endMinutes: 17 * 60,
      start: '09:00',
      end: '17:00'
    }), {
      windowStartMinutes: 9 * 60,
      windowEndMinutes: 18 * 60 + 10
    });
    if (source.startMinutes !== 9 * 60 || source.endMinutes !== 18 * 60 + 10) {
      throw new Error(`无时间调休应按全天不可排会议，实际 ${formatMinutes(source.startMinutes)}-${formatMinutes(source.endMinutes)}`);
    }
  }

  function assertSelfTestMeetingKeepsLegacyRangeParsing() {
    const range = parseDayOffDateRange('16上午-20上午请假', '2026-06-16', {
      includeHalfDayRange: false
    });
    if (range) {
      throw new Error('排会议共同空档不应因核对新增的半日日期范围解析而改变');
    }
  }

  function assertSelfTestSupervisorCellRules() {
    assertSupervisorRanges(parseSupervisorCell('', false).availableRanges, [], '空白格应按休息不可排');
    assertSupervisorRanges(parseSupervisorCell('N', false).availableRanges, [
      { startMinutes: 8 * 60 + 30, endMinutes: 17 * 60 + 30 }
    ], 'N 应为早班');
    assertSupervisorRanges(parseSupervisorCell('N查收', false).availableRanges, [
      { startMinutes: 8 * 60 + 30, endMinutes: 17 * 60 + 30 }
    ], 'N查收 应为早班');
    assertSupervisorRanges(parseSupervisorCell('A', false).availableRanges, [
      { startMinutes: 13 * 60 + 15, endMinutes: 21 * 60 + 30 }
    ], 'A 应为晚班');
    assertSupervisorRanges(parseSupervisorCell('A查收', false).availableRanges, [
      { startMinutes: 13 * 60 + 15, endMinutes: 21 * 60 + 30 }
    ], 'A查收 应为晚班');
    assertSupervisorRanges(parseSupervisorCell('F', false).availableRanges, [
      { startMinutes: 8 * 60 + 30, endMinutes: 21 * 60 + 30 }
    ], 'F 应覆盖 N/A 可选范围');
    assertSupervisorRanges(parseSupervisorCell('F查收', false).availableRanges, [
      { startMinutes: 8 * 60 + 30, endMinutes: 21 * 60 + 30 }
    ], 'F查收 应覆盖 N/A 可选范围');
    const holiday = parseSupervisorCell('端午', false);
    assertSupervisorRanges(holiday.availableRanges, [], '督导纯法定节日备注应按休息不可排');
    if (holiday.warnings.length) {
      throw new Error('督导纯法定节日备注不应产生未识别提醒');
    }
    const holidayWithTime = parseSupervisorCell('端午节 09:00-17:30', false);
    assertSupervisorRanges(holidayWithTime.availableRanges, [], '督导带视觉时间的纯法定节日备注应按休息不可排');
    if (holidayWithTime.warnings.length) {
      throw new Error('督导带视觉时间的纯法定节日备注不应产生未识别提醒');
    }
    assertSupervisorRanges(parseSupervisorCell('N', true).availableRanges, [], '红字 N 应按调休不可排');
    assertSupervisorRanges(parseSupervisorCell('调休 09:00-10:00', true).availableRanges, [
      { startMinutes: 8 * 60 + 30, endMinutes: 9 * 60 },
      { startMinutes: 10 * 60, endMinutes: 21 * 60 + 30 }
    ], '红字明确时段应只排除该时段');
    const unknown = parseSupervisorCell('外出', false);
    if (unknown.availableRanges.length || !unknown.warnings.length) {
      throw new Error('未识别督导单元格应不可排并提示');
    }
  }

  function assertSelfTestSupervisorImportHelpers() {
    const zipLike = new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;
    const oleLike = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).buffer;
    const htmlLike = new TextEncoder().encode('<html><body><table><tr><td>N</td></tr></table></body></html>').buffer;
    if (!isZipArrayBuffer(zipLike)) throw new Error('PK zip 头应识别为 xlsx');
    if (!isOleCompoundArrayBuffer(oleLike)) throw new Error('OLE 文件头应识别为二进制 xls');
    if (isZipArrayBuffer(htmlLike)) throw new Error('HTML 型 xls 不应识别为 zip');
    const decoded = decodeSpreadsheetText(htmlLike);
    if (!/<table/i.test(decoded)) throw new Error('HTML 型 xls 文本应可解码出 table');
    if (!isHtmlColorRed('red') || !isHtmlColorRed('#ff0000') || !isHtmlColorRed('rgb(255,0,0)')) {
      throw new Error('HTML 红色字体识别失败');
    }
    if (isHtmlColorRed('#00aa00')) throw new Error('绿色不应识别为红色调休');

    const weekdayColumns = inferSupervisorWeekdayDateColumns([
      { value: '' },
      { value: '星期一' },
      { value: '星期二' },
      { value: '星期三' }
    ], { year: 2026, month: 6 });
    if (weekdayColumns.map((column) => column.date).join(',') !== '2026-06-01,2026-06-02,2026-06-03') {
      throw new Error('星期表头应按文件月份推断日期列');
    }

    const parsed = parseSupervisorRows([
      [{ value: '姓名' }],
      [{ value: '' }, { value: '星期一' }, { value: '星期二' }, { value: '星期三' }, { value: '星期四' }],
      [
        { value: '张三' },
        { value: 'N查收' },
        { value: 'A查收' },
        { value: 'F查收' },
        { value: 'N', red: true }
      ]
    ], '督导2026年6月排班.xls');
    if (parsed.supervisors.length !== 1 || parsed.dateColumns.length !== 4) {
      throw new Error('星期行督导表应识别姓名行和日期列');
    }
    const supervisor = parsed.supervisors[0];
    assertSupervisorRanges(supervisor.days.get('2026-06-01'), [
      { startMinutes: 8 * 60 + 30, endMinutes: 17 * 60 + 30 }
    ], '星期行 N查收 应为早班');
    assertSupervisorRanges(supervisor.days.get('2026-06-02'), [
      { startMinutes: 13 * 60 + 15, endMinutes: 21 * 60 + 30 }
    ], '星期行 A查收 应为晚班');
    assertSupervisorRanges(supervisor.days.get('2026-06-03'), [
      { startMinutes: 8 * 60 + 30, endMinutes: 21 * 60 + 30 }
    ], '星期行 F查收 应覆盖 N/A 可选范围');
    assertSupervisorRanges(supervisor.days.get('2026-06-04'), [], '红字 N 应不可排');
  }

  function assertSelfTestSupervisorWarningDetails() {
    const previousWarnings = state.supervisorPlanner.warnings;
    try {
      state.supervisorPlanner.warnings = [
        '第 44 行 许艾琛 2026-06-11：未识别“婚假”，已按不可排处理',
        '第 45 行 胡蓉 2026-06-19：未识别“<未知>”，已按不可排处理'
      ];
      const clippedHtml = renderSupervisorWarningDetails(undefined, 1);
      if (!clippedHtml.includes('提醒明细') || !clippedHtml.includes('1. 许艾琛 2026-06-11：婚假，按休息处理')) {
        throw new Error('督导导入页应显示提醒标题和人性化短格式明细');
      }
      if (clippedHtml.includes('第 44 行')) {
        throw new Error('督导导入页提醒明细不应显示表格行号');
      }
      if (!clippedHtml.includes('还有 1 条未显示')) {
        throw new Error('督导导入页提醒过多时应提示剩余数量');
      }
      const fullHtml = renderSupervisorWarningDetails(undefined, 2);
      if (fullHtml.includes('<未知>') || !fullHtml.includes('&lt;未知&gt;')) {
        throw new Error('督导导入页提醒明细应转义表格文本');
      }
      const newWarning = formatSupervisorWarningText('测试督导', '2026-06-20', '未识别“婚假”，已按不可排处理');
      if (newWarning !== '测试督导 2026-06-20：婚假，按休息处理') {
        throw new Error('督导新提醒应按姓名、日期、人性化原因生成');
      }
    } finally {
      state.supervisorPlanner.warnings = previousWarnings;
    }
  }

  function assertSelfTestMeetingSupervisorMatching() {
    const previousPlanner = state.supervisorPlanner;
    try {
      state.supervisorPlanner = {
        workbookName: '测试督导表.xlsx',
        supervisors: [
          {
            name: '测试督导',
            rowIndex: 1,
            days: new Map(),
            shiftCodes: new Map()
          },
          {
            name: '余素清',
            rowIndex: 2,
            days: new Map(),
            shiftCodes: new Map()
          },
          {
            name: '邢子樱',
            rowIndex: 3,
            days: new Map(),
            shiftCodes: new Map()
          }
        ],
        selectedSupervisors: new Set(),
        dateColumns: [{ columnIndex: 1, date: '2026-06-01' }],
        warnings: []
      };
      const matched = matchMeetingSupervisors(['测试督导']);
      if (matched.matched.length !== 1 || matched.missed.length || matched.teacherNames.length) {
        throw new Error('排会议页应能按姓名匹配已导入督导');
      }
      const missed = matchMeetingSupervisors(['不存在督导']);
      if (missed.matched.length || missed.teacherNames[0] !== '不存在督导') {
        throw new Error('未匹配督导的姓名应保留为老师');
      }
      const split = matchMeetingSupervisors(['测试老师', '测试督导']);
      if (split.teacherNames.join(',') !== '测试老师' || split.matched.length !== 1 || split.matched[0].name !== '测试督导') {
        throw new Error('包含督导时应从同一名单里自动拆分老师和督导');
      }
      const shortNames = matchMeetingSupervisors(['素清', '子樱']);
      if (shortNames.matched.map((supervisor) => supervisor.name).join(',') !== '余素清,邢子樱') {
        throw new Error('督导两个字应唯一匹配到完整姓名');
      }
      if (shortNames.resolvedNames.join(',') !== '余素清,邢子樱') {
        throw new Error('督导两个字应展开为系统筛选可用的完整姓名');
      }
      const displaySelections = buildMeetingDisplaySelectionNames(
        ['测试老师', '测试督导'],
        ['测试老师', '测试督导'],
        { supervisors: split.matched },
        { matched: ['测试老师'] }
      );
      if (displaySelections.join(',') !== '测试老师,测试督导') {
        throw new Error('共同空档勾选区应自动勾选老师和督导完整名单');
      }
      state.supervisorPlanner.supervisors.push({
        name: '张素清',
        rowIndex: 4,
        days: new Map(),
        shiftCodes: new Map()
      });
      const ambiguous = matchMeetingSupervisors(['素清']);
      if (ambiguous.matched.length || ambiguous.teacherNames[0] !== '素清' || ambiguous.resolvedNames[0] !== '素清') {
        throw new Error('督导两个字不唯一时不应自动匹配');
      }
    } finally {
      state.supervisorPlanner = previousPlanner;
    }
  }

  function assertSelfTestMeetingPartialNameMatching() {
    const teacherMatch = matchMeetingTeachers(['王淑', '小夏', '苏尚'], ['王淑婷', '王小夏', '夏苏尚华']);
    if (teacherMatch.matched.join(',') !== '王淑婷,王小夏,夏苏尚华' || teacherMatch.missed.length) {
      throw new Error('老师输入两个字应唯一匹配到扫描后的完整姓名');
    }
    const ambiguousTeacher = matchMeetingTeachers(['王淑'], ['王淑婷', '王淑华']);
    if (ambiguousTeacher.matched.length || ambiguousTeacher.missed[0] !== '王淑') {
      throw new Error('老师两个字不唯一时不应自动猜测');
    }

    const previousPlanner = state.supervisorPlanner;
    try {
      state.supervisorPlanner = {
        workbookName: '测试督导表.xlsx',
        supervisors: [
          { name: '王淑婷', rowIndex: 1, days: new Map(), shiftCodes: new Map() },
          { name: '夏苏尚华', rowIndex: 2, days: new Map(), shiftCodes: new Map() }
        ],
        selectedSupervisors: new Set(),
        dateColumns: [{ columnIndex: 1, date: '2026-06-01' }],
        warnings: []
      };
      const supervisorMatch = matchMeetingSupervisors(['王淑', '苏尚']);
      if (supervisorMatch.matched.map((supervisor) => supervisor.name).join(',') !== '王淑婷,夏苏尚华') {
        throw new Error('督导输入两个字应唯一匹配到完整姓名');
      }
      if (supervisorMatch.resolvedNames.join(',') !== '王淑婷,夏苏尚华') {
        throw new Error('督导两个字应写回完整姓名用于系统筛选和共同空档');
      }
      state.supervisorPlanner.supervisors.push({ name: '王淑华', rowIndex: 3, days: new Map(), shiftCodes: new Map() });
      const ambiguousSupervisor = matchMeetingSupervisors(['王淑']);
      if (ambiguousSupervisor.matched.length || ambiguousSupervisor.teacherNames[0] !== '王淑') {
        throw new Error('督导两个字不唯一时不应自动猜测');
      }
    } finally {
      state.supervisorPlanner = previousPlanner;
    }
  }

  function assertSelfTestMeetingSelectedNamesOverrideQuery() {
    const previousPlanner = state.supervisorPlanner;
    const previousDocument = typeof document === 'undefined' ? undefined : document;
    const checkbox = { checked: true };
    const input = { value: '王小霞 胡永芳 王淑娴' };
    try {
      state.supervisorPlanner = {
        workbookName: '测试督导表.xlsx',
        supervisors: [
          { name: '王小霞', rowIndex: 1, days: new Map(), shiftCodes: new Map() },
          { name: '胡永芳', rowIndex: 2, days: new Map(), shiftCodes: new Map() },
          { name: '王淑娴', rowIndex: 3, days: new Map(), shiftCodes: new Map() }
        ],
        selectedSupervisors: new Set(),
        dateColumns: [{ columnIndex: 1, date: '2026-06-09' }],
        warnings: []
      };
      globalThis.document = {
        getElementById(id) {
          if (id === 'ccheck-meeting-include-supervisors') return checkbox;
          if (id === 'ccheck-meeting-teacher-query') return input;
          return null;
        }
      };
      const merge = readMeetingSupervisorMerge({ dates: ['2026-06-09'] }, ['王小霞', '胡永芳']);
      const names = merge.supervisors.map((supervisor) => supervisor.name).join(',');
      if (!merge.ok || names !== '王小霞,胡永芳') {
        throw new Error(`共同空档应只按勾选名单拆分督导，实际 ${names || '(空)'}`);
      }
    } finally {
      state.supervisorPlanner = previousPlanner;
      if (previousDocument === undefined) {
        try {
          delete globalThis.document;
        } catch (_) {
          globalThis.document = undefined;
        }
      } else {
        globalThis.document = previousDocument;
      }
    }
  }

  function assertSelfTestMeetingNoSlotListHidden() {
    const previousDocument = typeof document === 'undefined' ? undefined : document;
    const result = { innerHTML: '' };
    try {
      globalThis.document = {
        getElementById(id) {
          return id === 'ccheck-meeting-results' ? result : null;
        }
      };
      renderMeetingNoSlotsMessage(['王小霞', '余素清'], {
        dates: ['2026-06-03', '2026-06-07']
      });
      if (result.innerHTML.includes('2026-06-03') || result.innerHTML.includes('无可排') || result.innerHTML.includes('ccheck-slot-card')) {
        throw new Error(`没有共同空档时不应显示逐日无可排卡片，实际 ${result.innerHTML}`);
      }
    } finally {
      if (previousDocument === undefined) {
        try {
          delete globalThis.document;
        } catch (_) {
          globalThis.document = undefined;
        }
      } else {
        globalThis.document = previousDocument;
      }
    }
  }

  function assertSelfTestMeetingDraftNoteExpanded() {
    const previousDocument = typeof document === 'undefined' ? undefined : document;
    const created = [];
    try {
      globalThis.document = {
        body: {
          appendChild() {}
        },
        createElement() {
          const element = createSelfTestDomElement();
          created.push(element);
          return element;
        },
        getElementById() {
          return null;
        }
      };
      showMeetingDraftNote({
        date: '2026-06-24',
        startTime: '09:00',
        endTime: '09:45',
        meetingMode: 'offline',
        meetingCampus: '钱江校区',
        meetingName: '测试会议',
        teachers: ['王小霞', '胡永芳']
      }, '请人工确认后再点系统“确定”。');
      const note = created[0];
      if (!note || note.id !== 'ccheck-meeting-draft-note') {
        throw new Error('会议草稿提示未创建');
      }
      if (note.classList.contains('ccheck-draft-note-collapsed')) {
        throw new Error('会议草稿提示进入新增页时不应默认缩略');
      }
      if (!note.innerHTML.includes('title="收起/展开">-</button>')) {
        throw new Error('会议草稿提示默认展开时按钮应显示收起符号');
      }
      if (!note.innerHTML.includes('参会人：')) {
        throw new Error('会议草稿参会人行应保留参会人标签');
      }
      if (!note.innerHTML.includes('参会人：<strong>王小霞、胡永芳')) {
        throw new Error('会议草稿参会人行应直接显示老师名字');
      }
      if (note.innerHTML.includes('全体英语教师')) {
        throw new Error('会议草稿参会人行不应显示分组标签');
      }
    } finally {
      if (previousDocument === undefined) {
        try {
          delete globalThis.document;
        } catch (_) {
          globalThis.document = undefined;
        }
      } else {
        globalThis.document = previousDocument;
      }
    }
  }

  function createSelfTestDomElement() {
    const element = {
      id: '',
      className: '',
      dataset: {},
      innerHTML: '',
      querySelector() {
        return null;
      }
    };
    element.classList = {
      contains(className) {
        return element.className.split(/\s+/).filter(Boolean).includes(className);
      },
      toggle(className, force) {
        const classes = new Set(element.className.split(/\s+/).filter(Boolean));
        const shouldAdd = force === undefined ? !classes.has(className) : Boolean(force);
        if (shouldAdd) {
          classes.add(className);
        } else {
          classes.delete(className);
        }
        element.className = Array.from(classes).join(' ');
        return shouldAdd;
      }
    };
    return element;
  }

  function assertSelfTestMeetingSupervisorShiftDisplay() {
    const date = '2026-06-09';
    const settings = {
      dates: [date],
      durationMinutes: 45,
      meetingMode: 'online',
      includeEveningMeeting: false,
      windowStartMinutes: CONFIG.meetingWindowStartMinutes,
      windowEndMinutes: CONFIG.meetingWindowEndMinutes,
      excludedRanges: CONFIG.meetingExcludedRanges.slice()
    };
    const supervisors = [
      makeSelfTestSupervisor('王小霞', date, 'N'),
      makeSelfTestSupervisor('胡永芳', date, 'A')
    ];
    const participants = ['王小霞', '胡永芳'];
    const previousPlanner = state.supervisorPlanner;
    try {
      state.supervisorPlanner = {
        workbookName: '测试督导表.xlsx',
        supervisors,
        selectedSupervisors: new Set(participants),
        dateColumns: [{ columnIndex: 1, date }],
        warnings: []
      };
      const shiftText = formatMeetingSupervisorShiftSummary(date, participants);
      if (shiftText !== '王小霞N，胡永芳A') {
        throw new Error(`督导班次应显示姓名+班次，实际 ${shiftText}`);
      }
      const commonRanges = getMeetingSupervisorCommonAvailableRanges(supervisors, date, settings);
      assertSupervisorRanges(commonRanges, [
        { startMinutes: 13 * 60 + 15, endMinutes: 17 * 60 + 30 }
      ], 'N + A 应显示督导班次交集');
      const slots = buildOnlineMeetingSlots(buildSupervisorPlannerEvents(supervisors, settings), participants, settings);
      if (!slots.length || slots[0].startMinutes !== 13 * 60 + 15 || slots[0].endMinutes !== 17 * 60 + 30) {
        throw new Error(`N + A 应参与共同空档计算，实际 ${slots.map((slot) => `${formatMinutes(slot.startMinutes)}-${formatMinutes(slot.endMinutes)}`).join('；')}`);
      }
      const visibleShiftText = formatMeetingSupervisorShiftSummary(date, participants);
      if (visibleShiftText !== '王小霞N，胡永芳A') {
        throw new Error(`共同空档卡片应只保留督导班次，实际 ${visibleShiftText}`);
      }
    } finally {
      state.supervisorPlanner = previousPlanner;
    }
  }

  function assertSelfTestSupervisorMixedSlots() {
    const date = '2026-06-01';
    const settings = {
      dates: [date],
      durationMinutes: 45,
      meetingMode: 'online',
      requestedMeetingMode: 'supervisor',
      windowStartMinutes: CONFIG.supervisorWindowStartMinutes,
      windowEndMinutes: CONFIG.supervisorWindowEndMinutes,
      excludedRanges: []
    };
    const flexSupervisor = makeSelfTestSupervisor('灵活督导', date, 'F');
    const lateSupervisor = makeSelfTestSupervisor('晚班督导', date, 'A');
    const supervisorEvents = buildSupervisorPlannerEvents([flexSupervisor, lateSupervisor], settings);
    const baseSlots = buildOnlineMeetingSlots(supervisorEvents, ['灵活督导', '晚班督导'], settings);
    if (!baseSlots.length || baseSlots[0].startMinutes !== 13 * 60 + 15 || baseSlots[0].endMinutes !== 21 * 60 + 30) {
      throw new Error(`F + A 应得到晚班共同时间，实际 ${baseSlots.map((slot) => `${formatMinutes(slot.startMinutes)}-${formatMinutes(slot.endMinutes)}`).join('；')}`);
    }

    const teacherEvent = {
      key: 'teacher-block',
      teacher: '测试老师',
      text: '测试课程',
      date,
      startMinutes: 13 * 60 + 15,
      endMinutes: 14 * 60,
      campus: '城建校区',
      type: 'real'
    };
    const mixedSlots = buildOnlineMeetingSlots(
      supervisorEvents.concat(teacherEvent),
      ['灵活督导', '晚班督导', '测试老师'],
      settings
    );
    if (!mixedSlots.length || mixedSlots[0].startMinutes !== 14 * 60 + 5) {
      throw new Error(`老师阻塞应加 5 分钟缓冲，实际 ${mixedSlots.map((slot) => `${formatMinutes(slot.startMinutes)}-${formatMinutes(slot.endMinutes)}`).join('；')}`);
    }
  }

  function assertSupervisorRanges(actual, expected, message) {
    const actualText = (actual || []).map((range) => `${range.startMinutes}-${range.endMinutes}`).join(',');
    const expectedText = (expected || []).map((range) => `${range.startMinutes}-${range.endMinutes}`).join(',');
    if (actualText !== expectedText) {
      throw new Error(`${message}，期望 ${expectedText || '空'}，实际 ${actualText || '空'}`);
    }
  }

  function makeSelfTestSupervisor(name, date, code) {
    const parsed = parseSupervisorCell(code, false);
    return {
      name,
      days: new Map([[date, parsed.availableRanges]]),
      shiftCodes: new Map([[date, parsed.shiftCode]]),
      rowIndex: 0
    };
  }

  function assertSelfTestOnlineSameCampusNoMismatch() {
    const events = [
      makeSelfTestCourseEvent({
        key: 'previous-qianjiang',
        text: '前一节钱江课',
        type: 'real',
        campus: '钱江校区',
        hex: '#FB5757',
        startMinutes: 9 * 60,
        endMinutes: 10 * 60 + 30,
        start: '09:00',
        end: '10:30'
      }),
      makeSelfTestCourseEvent({
        key: 'online-qianjiang',
        text: '线上课挂靠钱江',
        type: 'online',
        campus: '线上',
        hex: '#FFAFDE',
        courseForm: '线上',
        courseCampus: '钱江校区',
        detailCampus: '钱江校区',
        startMinutes: 11 * 60 + 15,
        endMinutes: 12 * 60,
        start: '11:15',
        end: '12:00'
      }),
      makeSelfTestCourseEvent({
        key: 'next-qianjiang',
        text: '后一节钱江课',
        type: 'real',
        campus: '钱江校区',
        hex: '#FB5757',
        startMinutes: 11 * 60 + 30,
        endMinutes: 12 * 60 + 15,
        start: '11:30',
        end: '12:15'
      })
    ];
    const anomalies = createTwoColorSandwichAnomalies(events, { adjacentGapMinutes: 15 });
    if (anomalies.some((item) => item.kind === '未改校区')) {
      throw new Error('线上课挂靠钱江且前后均为钱江时，不应提示未改校区');
    }
  }

  function assertSelfTestAuditScanMergesFullPageEvents() {
    const interfaceEvents = [];
    const pageEvents = [];
    ['张泽凡', '沈莺', '童娜', '张子月'].forEach((teacher, index) => {
      const base = {
        teacher,
        date: '2026-07-22',
        parentIndex: 3,
        rowIndex: index
      };
      interfaceEvents.push(
        makeSelfTestCourseEvent({
          ...base,
          key: `interface-${teacher}-offline`,
          text: `${teacher}紫金港线下`,
          campus: '紫金港校区',
          hex: '#B290FE',
          startMinutes: 9 * 60,
          endMinutes: 9 * 60 + 45,
          start: '09:00',
          end: '09:45'
        }),
        makeSelfTestCourseEvent({
          ...base,
          key: `interface-${teacher}-online`,
          text: `${teacher}线上课`,
          type: 'online',
          campus: '会议/教研/线上占用',
          hex: '#FFAFDE',
          isMeeting: true,
          startMinutes: 19 * 60 + 4,
          endMinutes: 19 * 60 + 49,
          start: '19:04',
          end: '19:49'
        })
      );
      pageEvents.push(
        makeSelfTestCourseEvent({
          ...base,
          key: `page-${teacher}-offline`,
          text: `${teacher}紫金港线下`,
          campus: '紫金港校区',
          hex: '#B290FE',
          startMinutes: 9 * 60,
          endMinutes: 9 * 60 + 45,
          start: '09:00',
          end: '09:45'
        }),
        makeSelfTestCourseEvent({
          ...base,
          key: `page-${teacher}-online`,
          text: `${teacher}线上课`,
          type: 'online',
          campus: '线上',
          hex: '#FFAFDE',
          courseForm: '线上',
          courseCampus: '城建校区',
          detailCampus: '城建校区',
          startMinutes: 19 * 60,
          endMinutes: 19 * 60 + 45,
          start: '19:00',
          end: '19:45'
        })
      );
    });
    interfaceEvents.push(makeSelfTestCourseEvent({
      key: 'interface-only-event',
      teacher: '接口补充老师',
      date: '2026-07-22',
      text: '仅接口存在的课程',
      campus: '钱江校区',
      hex: '#FB5757',
      startMinutes: 14 * 60,
      endMinutes: 14 * 60 + 45,
      start: '14:00',
      end: '14:45'
    }));

    const merged = mergeInterfaceEventsWithPageEvents(interfaceEvents, pageEvents);
    if (merged.pageMatchedCount !== pageEvents.length || merged.interfaceOnlyCount !== 1) {
      throw new Error(`异常扫描合并计数不正确：页面匹配 ${merged.pageMatchedCount}，接口补充 ${merged.interfaceOnlyCount}`);
    }
    if (merged.events.length !== pageEvents.length + 1) {
      throw new Error(`接口与页面同一色块不应重复，实际合并后 ${merged.events.length} 个事件`);
    }
    const pageOnline = merged.events.filter((event) => event.courseForm === '线上');
    if (pageOnline.length !== 4 || pageOnline.some((event) => event.start !== '19:00' || event.source !== '页面+接口' || event.isMeeting)) {
      throw new Error('异常扫描应采用页面色块的线上详情和准确时间，并清除接口遗留的会议标记');
    }
    const result = analyze(merged.events, makeSelfTestSettings());
    const reminders = result.anomalies.filter((item) => item.kind === '检测：有线上课');
    if (reminders.length !== 4) {
      throw new Error(`离屏线上课应完整识别 4 条提醒，实际 ${reminders.length} 条`);
    }
  }

  function assertSelfTestImmediateCourseDetailsBeforeHoverLimit() {
    const unresolved = Array.from({ length: CONFIG.maxDetailMissesPerScan }, (_, index) => makeSelfTestCourseEvent({
      key: `immediate-unresolved-${index}`,
      text: `无内嵌详情 ${index}`,
      hex: '#FB5757'
    }));
    const embedded = makeSelfTestCourseEvent({
      key: 'immediate-embedded-online',
      text: '离屏内嵌线上课',
      hex: '#FFAFDE'
    });
    const events = unresolved.concat(embedded);
    const hoverCandidates = collectImmediateCourseDetailCandidates(events, (event) => {
      if (event !== embedded) return { item: {} };
      return {
        item: {},
        detail: {
          rawText: '课程详情 课程形式：线上 校区名称：城建校区',
          courseForm: '线上',
          campus: '城建校区'
        }
      };
    });

    try {
      if (hoverCandidates.length !== CONFIG.maxDetailMissesPerScan) {
        throw new Error(`无内嵌详情事件应保留给悬停读取，实际 ${hoverCandidates.length} 个`);
      }
      if (embedded.courseForm !== '线上' || embedded.courseCampus !== '城建校区') {
        throw new Error('即使前面已有 6 个悬停候选，也必须先读取后续离屏色块的内嵌详情');
      }
    } finally {
      events.forEach((event) => state.courseDetailCache.delete(event.key));
    }
  }

  function assertSelfTestSameCourseNameKeepsColorCampus() {
    const staleMorningDetail = [
      '课程详情',
      '教师：金潇洒',
      '时间：09:00-09:45',
      '课程形式：线下',
      '校区名称：钱江校区',
      '课程名称：精品听力'
    ].join(' ');
    const eveningCourse = makeSelfTestCourseEvent({
      key: 'same-name-evening-course',
      teacher: '金潇洒',
      date: '2026-07-24',
      text: '潘佳妮 精品听力',
      campus: '城建校区',
      hex: '#FFBF41',
      startMinutes: 18 * 60 + 45,
      endMinutes: 19 * 60 + 30,
      start: '18:45',
      end: '19:30'
    });
    if (isCourseDetailForEvent(staleMorningDetail, eveningCourse)) {
      throw new Error('同名“精品听力”的上午钱江详情不应匹配晚间城建色块');
    }

    const makeEvent = (key, text, hex, startMinutes, endMinutes) => makeSelfTestCourseEvent({
      key,
      teacher: '金潇洒',
      date: '2026-07-24',
      text,
      campus: '钱江校区',
      hex,
      courseForm: '线上',
      courseCampus: '钱江校区',
      detailCampus: '钱江校区',
      startMinutes,
      endMinutes,
      start: formatMinutes(startMinutes),
      end: formatMinutes(endMinutes)
    });
    const events = [
      makeEvent('same-name-qianjiang-1', '周思言Anita 精品听力', '#FB5757', 9 * 60, 9 * 60 + 45),
      makeEvent('same-name-qianjiang-2', '周思言Anita 精品听力', '#FB5757', 9 * 60 + 50, 10 * 60 + 35),
      makeEvent('same-name-qianjiang-3', '徐薏涵 进阶听力', '#FB5757', 10 * 60 + 40, 11 * 60 + 25),
      makeEvent('same-name-qianjiang-4', '徐薏涵 进阶听力', '#FB5757', 11 * 60 + 30, 12 * 60 + 15),
      makeEvent('same-name-qianjiang-5', 'QBD2607-168 听力', '#FB5757', 13 * 60, 13 * 60 + 45),
      makeEvent('same-name-qianjiang-6', 'QBD2607-168 听力', '#FB5757', 13 * 60 + 50, 14 * 60 + 35),
      makeEvent('same-name-zijingang', '施胤泽 听力A', '#B290FE', 16 * 60 + 30, 17 * 60 + 15),
      makeEvent('same-name-chengjian-1', '潘佳妮 精品听力', '#FFBF41', 18 * 60 + 45, 19 * 60 + 30),
      makeEvent('same-name-chengjian-2', '潘佳妮 精品听力', '#FFBF41', 19 * 60 + 35, 20 * 60 + 20)
    ];
    const selectedCampuses = events.map((event) => getSelectedCampusForAudit(event));
    const expectedCampuses = [
      '钱江校区', '钱江校区', '钱江校区', '钱江校区', '钱江校区', '钱江校区',
      '紫金港校区', '城建校区', '城建校区'
    ];
    if (selectedCampuses.join('|') !== expectedCampuses.join('|')) {
      throw new Error(`实体颜色应决定校区，实际：${selectedCampuses.join('、')}`);
    }
    if (!events.every((event) => isOnlineCourseEvent(event))) {
      throw new Error('原始复现场景的 9 个色块均应由课程详情识别为线上课');
    }

    const result = analyze(events, makeSelfTestSettings());
    const multiCampusAnomalies = result.anomalies.filter((item) => item.kind === '异常：存在多个校区');
    if (multiCampusAnomalies.length !== 1 || multiCampusAnomalies[0].reason !== '有线上课，未改校区，目前课表有三个校区，注意查看') {
      throw new Error(`三色线上课表应且只应生成 1 条多校区提醒，实际：${multiCampusAnomalies.map((item) => item.reason).join('；') || '无'}`);
    }
    assertNoSelfTestAnomaly(result, '异常：时间不够跑校区', '原始复现场景各段通勤时间充足，不应误报时间不足');
  }

  function assertSelfTestVirtualMeetingWrongCampusMismatch() {
    const events = [
      makeSelfTestCourseEvent({
        key: 'previous-chengjian',
        text: '前一节城建课',
        type: 'real',
        campus: '城建校区',
        hex: '#FFBF41',
        startMinutes: 9 * 60,
        endMinutes: 9 * 60 + 45,
        start: '09:00',
        end: '09:45'
      }),
      makeSelfTestCourseEvent({
        key: 'virtual-meeting-qianjiang',
        text: '线上钱江会议',
        type: 'online',
        campus: '线上',
        hex: '#FFAFDE',
        isMeeting: true,
        courseForm: '线上',
        courseCampus: '钱江校区',
        detailCampus: '钱江校区',
        startMinutes: 9 * 60 + 50,
        endMinutes: 10 * 60 + 35,
        start: '09:50',
        end: '10:35'
      }),
      makeSelfTestCourseEvent({
        key: 'next-chengjian',
        text: '后一节城建课',
        type: 'real',
        campus: '城建校区',
        hex: '#FFBF41',
        startMinutes: 11 * 60 + 30,
        endMinutes: 12 * 60 + 15,
        start: '11:30',
        end: '12:15'
      })
    ];
    const result = analyze(events, {
      adjacentGapMinutes: 15,
      onlinePressureBufferMinutes: 60
    });
    const mismatches = result.anomalies.filter((item) => item.kind === '未改校区');
    if (mismatches.length !== 1) {
      throw new Error(`虚拟会议选错校区应且只应提示 1 条未改校区，实际 ${mismatches.length} 条`);
    }
    const commuteToVirtual = result.anomalies.find((item) => {
      return item.kind !== '未改校区' && /城建校区 到 钱江校区/.test(item.reason || '');
    });
    if (commuteToVirtual) {
      throw new Error('虚拟会议选错校区不应按城建到钱江实体通勤不足处理');
    }
  }

  function assertSelfTestHalfDayRangeNoDayOff() {
    const result = analyze([
      makeSelfTestDayOffEvent({
        key: 'leave-16am-20am',
        date: '2026-06-16',
        text: '16上午-20上午请假'
      }),
      makeSelfTestCourseEvent({
        key: 'course-20pm',
        date: '2026-06-20',
        text: '20号下午课',
        startMinutes: 13 * 60 + 15,
        endMinutes: 14 * 60,
        start: '13:15',
        end: '14:00'
      })
    ], makeSelfTestSettings());
    assertNoSelfTestAnomaly(result, '休假期间有排课', '20号下午课不在 16上午-20上午请假范围内');
  }

  function assertSelfTestOnlineMeetingAttachedToNextCommuteShort() {
    const result = analyze([
      makeSelfTestCourseEvent({
        key: 'offline-chengjian',
        text: 'A城建线下',
        campus: '城建校区',
        hex: '#FFBF41',
        startMinutes: 9 * 60,
        endMinutes: 9 * 60 + 45,
        start: '09:00',
        end: '09:45'
      }),
      makeSelfTestCourseEvent({
        key: 'online-meeting-qianjiang',
        text: 'B线上钱江会议',
        type: 'online',
        campus: '线上',
        hex: '#FFAFDE',
        isMeeting: true,
        courseForm: '线上',
        courseCampus: '钱江校区',
        detailCampus: '钱江校区',
        startMinutes: 9 * 60 + 50,
        endMinutes: 10 * 60 + 35,
        start: '09:50',
        end: '10:35'
      }),
      makeSelfTestCourseEvent({
        key: 'offline-qianjiang',
        text: 'B钱江线下',
        campus: '钱江校区',
        hex: '#FB5757',
        startMinutes: 11 * 60 + 30,
        endMinutes: 12 * 60 + 15,
        start: '11:30',
        end: '12:15'
      })
    ], makeSelfTestSettings());
    assertHasSelfTestAnomaly(result, '异常：时间不够跑校区', /城建校区.*钱江校区/);
    assertNoSelfTestAnomaly(result, '未改校区', '线上钱江会议已归属下一节钱江线下');
  }

  function assertSelfTestLeadingOnlineCourseMismatch() {
    const result = analyze([
      makeSelfTestCourseEvent({
        key: 'leading-online-chengjian',
        text: 'A线上城建',
        type: 'online',
        campus: '线上',
        courseForm: '线上',
        courseCampus: '城建校区',
        detailCampus: '城建校区',
        startMinutes: 9 * 60,
        endMinutes: 9 * 60 + 45,
        start: '09:00',
        end: '09:45'
      }),
      makeSelfTestCourseEvent({
        key: 'online-meeting-qianjiang-2',
        text: 'B线上会议钱江',
        type: 'online',
        campus: '线上',
        isMeeting: true,
        courseForm: '线上',
        courseCampus: '钱江校区',
        detailCampus: '钱江校区',
        startMinutes: 9 * 60 + 50,
        endMinutes: 10 * 60 + 35,
        start: '09:50',
        end: '10:35'
      }),
      makeSelfTestCourseEvent({
        key: 'offline-qianjiang-2',
        text: 'B钱江线下',
        campus: '钱江校区',
        hex: '#FB5757',
        startMinutes: 10 * 60 + 40,
        endMinutes: 11 * 60 + 25,
        start: '10:40',
        end: '11:25'
      })
    ], makeSelfTestSettings());
    assertHasSelfTestAnomaly(result, '未改校区', /^未改校区$/);
  }

  function assertSelfTestSingleSidedOnlineCampusCommuteEnough() {
    const result = analyze([
      makeSelfTestCourseEvent({
        key: 'single-online-qianjiang',
        text: 'A线上钱江',
        type: 'online',
        campus: '线上',
        courseForm: '线上',
        courseCampus: '钱江校区',
        detailCampus: '钱江校区',
        startMinutes: 9 * 60 + 55,
        endMinutes: 10 * 60 + 40,
        start: '09:55',
        end: '10:40'
      }),
      makeSelfTestCourseEvent({
        key: 'single-offline-chengjian',
        text: 'B城建线下',
        campus: '城建校区',
        hex: '#FFBF41',
        startMinutes: 13 * 60 + 15,
        endMinutes: 14 * 60,
        start: '13:15',
        end: '14:00'
      })
    ], makeSelfTestSettings());
    assertNoSelfTestAnomaly(result, '未改校区', '线上钱江到城建线下时间足够且只有两个校区时不应报未改校区');
    assertNoSelfTestAnomaly(result, '异常：时间不够跑校区', '线上钱江到城建线下时间足够时不应报跑校区时间不够');
    assertHasSelfTestAnomaly(result, '检测：有线上课', /^只有线上课不在一个校区，建议修改$/);
  }

  function assertSelfTestOnlyOnlineDifferentCampusReminder() {
    const offlineStartMinutes = [
      9 * 60,
      9 * 60 + 45,
      10 * 60 + 30,
      11 * 60 + 15,
      13 * 60 + 15,
      14 * 60,
      14 * 60 + 45,
      15 * 60 + 30,
      16 * 60 + 15,
      17 * 60
    ];
    const events = offlineStartMinutes.map((startMinutes, index) => makeSelfTestCourseEvent({
      key: `repro-zijingang-${index + 1}`,
      text: `紫金港线下课${index + 1}`,
      campus: '紫金港校区',
      hex: '#B290FE',
      startMinutes,
      endMinutes: startMinutes + 45,
      start: formatMinutes(startMinutes),
      end: formatMinutes(startMinutes + 45)
    }));
    events.push(makeSelfTestCourseEvent({
      key: 'repro-final-online-chengjian',
      text: 'CYD2607-068 强化听力',
      type: 'online',
      campus: '线上',
      hex: '#FFBF41',
      courseForm: '线上',
      courseCampus: '城建校区',
      detailCampus: '城建校区',
      startMinutes: 19 * 60,
      endMinutes: 19 * 60 + 45,
      start: '19:00',
      end: '19:45'
    }));

    const result = analyze(events, makeSelfTestSettings());
    assertHasSelfTestAnomaly(result, '检测：有线上课', /^只有线上课不在一个校区，建议修改$/);
    if (result.anomalies.filter((item) => item.kind === '检测：有线上课').length !== 1) {
      throw new Error(`原始复现场景应且只应提示 1 条线上课校区检测，实际 ${result.anomalies.filter((item) => item.kind === '检测：有线上课').length} 条`);
    }
    assertNoSelfTestAnomaly(result, '异常：时间不够跑校区', '紫金港到城建线上课有足够通勤时间，不应误报时间不足');
  }

  function assertSelfTestSingleSidedOnlineCampusStickyMismatch() {
    const result = analyze([
      makeSelfTestCourseEvent({
        key: 'sticky-online-chengjian',
        text: 'A线上城建',
        type: 'online',
        campus: '线上',
        courseForm: '线上',
        courseCampus: '城建校区',
        detailCampus: '城建校区',
        startMinutes: 9 * 60,
        endMinutes: 9 * 60 + 45,
        start: '09:00',
        end: '09:45'
      }),
      makeSelfTestCourseEvent({
        key: 'sticky-offline-qianjiang-1',
        text: 'B钱江线下',
        campus: '钱江校区',
        hex: '#FB5757',
        startMinutes: 9 * 60 + 50,
        endMinutes: 10 * 60 + 35,
        start: '09:50',
        end: '10:35'
      }),
      makeSelfTestCourseEvent({
        key: 'sticky-offline-qianjiang-2',
        text: 'B钱江线下2',
        campus: '钱江校区',
        hex: '#FB5757',
        startMinutes: 10 * 60 + 40,
        endMinutes: 11 * 60 + 25,
        start: '10:40',
        end: '11:25'
      })
    ], makeSelfTestSettings());
    assertHasSelfTestAnomaly(result, '未改校区', /^未改校区$/);
  }

  function assertSelfTestTwoCampusReturnSandwich() {
    const result = analyze([
      makeSelfTestCourseEvent({
        key: 'return-chengjian-1',
        text: 'A城建线下',
        campus: '城建校区',
        hex: '#FFBF41',
        startMinutes: 9 * 60,
        endMinutes: 9 * 60 + 45,
        start: '09:00',
        end: '09:45'
      }),
      makeSelfTestCourseEvent({
        key: 'return-chengjian-2',
        text: 'A城建线下续课',
        campus: '城建校区',
        hex: '#FFBF41',
        startMinutes: 9 * 60 + 45,
        endMinutes: 10 * 60 + 30,
        start: '09:45',
        end: '10:30'
      }),
      makeSelfTestCourseEvent({
        key: 'return-qianjiang-1',
        text: 'B钱江线下',
        campus: '钱江校区',
        hex: '#FB5757',
        startMinutes: 11 * 60 + 15,
        endMinutes: 12 * 60,
        start: '11:15',
        end: '12:00'
      }),
      makeSelfTestCourseEvent({
        key: 'return-qianjiang-2',
        text: 'B钱江线上续课',
        campus: '钱江校区',
        hex: '#FB5757',
        courseForm: '线上',
        startMinutes: 12 * 60,
        endMinutes: 12 * 60 + 45,
        start: '12:00',
        end: '12:45'
      }),
      makeSelfTestCourseEvent({
        key: 'return-chengjian-3',
        text: 'A城建线下返回',
        campus: '城建校区',
        hex: '#FFBF41',
        startMinutes: 13 * 60 + 30,
        endMinutes: 14 * 60 + 15,
        start: '13:30',
        end: '14:15'
      })
    ], makeSelfTestSettings());
    assertHasSelfTestAnomaly(result, '异常：夹心色块', /^含线上，但是线下跑了三次校区$/);

    const onlineOuterResult = analyze([
      makeSelfTestCourseEvent({
        key: 'outer-online-chengjian-1',
        text: 'A城建线下',
        campus: '城建校区',
        hex: '#FFBF41',
        startMinutes: 9 * 60,
        endMinutes: 9 * 60 + 45,
        start: '09:00',
        end: '09:45'
      }),
      makeSelfTestCourseEvent({
        key: 'outer-online-qianjiang-1',
        text: 'B钱江线下',
        campus: '钱江校区',
        hex: '#FB5757',
        startMinutes: 10 * 60 + 30,
        endMinutes: 11 * 60 + 15,
        start: '10:30',
        end: '11:15'
      }),
      makeSelfTestCourseEvent({
        key: 'outer-online-qianjiang-2',
        text: 'B钱江线上',
        campus: '钱江校区',
        hex: '#FB5757',
        courseForm: '线上',
        startMinutes: 11 * 60 + 20,
        endMinutes: 12 * 60 + 5,
        start: '11:20',
        end: '12:05'
      }),
      makeSelfTestCourseEvent({
        key: 'outer-online-chengjian-2',
        text: 'A城建线上',
        campus: '城建校区',
        hex: '#FFBF41',
        courseForm: '线上',
        startMinutes: 12 * 60 + 50,
        endMinutes: 13 * 60 + 35,
        start: '12:50',
        end: '13:35'
      })
    ], makeSelfTestSettings());
    assertHasSelfTestAnomaly(onlineOuterResult, '异常：夹心色块', /^有线上课，未改校区，目前课表有三个校区，注意查看$/);

    const onlineAfterOfflineMiddleResult = analyze([
      makeSelfTestCourseEvent({
        key: 'offline-middle-chengjian-1',
        text: 'A城建线下',
        campus: '城建校区',
        hex: '#FFBF41',
        startMinutes: 9 * 60,
        endMinutes: 9 * 60 + 45,
        start: '09:00',
        end: '09:45'
      }),
      makeSelfTestCourseEvent({
        key: 'offline-middle-qianjiang',
        text: 'B钱江线下',
        campus: '钱江校区',
        hex: '#FB5757',
        startMinutes: 10 * 60 + 30,
        endMinutes: 11 * 60 + 15,
        start: '10:30',
        end: '11:15'
      }),
      makeSelfTestCourseEvent({
        key: 'offline-middle-chengjian-2',
        text: 'A城建线下返回',
        campus: '城建校区',
        hex: '#FFBF41',
        startMinutes: 12 * 60,
        endMinutes: 12 * 60 + 45,
        start: '12:00',
        end: '12:45'
      }),
      makeSelfTestCourseEvent({
        key: 'offline-middle-chengjian-3',
        text: 'A城建线上续课',
        campus: '城建校区',
        hex: '#FFBF41',
        courseForm: '线上',
        startMinutes: 12 * 60 + 50,
        endMinutes: 13 * 60 + 35,
        start: '12:50',
        end: '13:35'
      })
    ], makeSelfTestSettings());
    assertHasSelfTestAnomaly(onlineAfterOfflineMiddleResult, '异常：夹心色块', /^老师跑了三次校区，注意查看$/);
  }

  function assertSelfTestThreeCampusesWithCommuteShort() {
    const result = analyze(makeSelfTestThreeCampusEvents(13 * 60 + 15), makeSelfTestSettings());
    assertHasSelfTestAnomaly(result, '异常：时间不够跑校区', /钱江校区.*紫金港校区/);
    assertHasSelfTestAnomaly(result, '异常：存在多个校区', /^老师跑了三次校区，注意查看$/);
  }

  function assertSelfTestThreeCampusesOnly() {
    const result = analyze(makeSelfTestThreeCampusEvents(14 * 60 + 5), makeSelfTestSettings());
    assertNoSelfTestAnomaly(result, '异常：时间不够跑校区', '钱江到紫金港 110 分钟应足够');
    assertHasSelfTestAnomaly(result, '异常：存在多个校区', /^老师跑了三次校区，注意查看$/);
  }

  function assertSelfTestVirtualBetweenCampusesCommuteShort() {
    const result = analyze(makeSelfTestVirtualBetweenCampusEvents(10 * 60 + 40), makeSelfTestSettings());
    assertHasSelfTestAnomaly(result, '异常：时间不够跑校区', /城建校区.*钱江校区/);
    assertNoSelfTestAnomaly(result, '未改校区', '虚拟校区压缩通勤时间时优先报跑校区时间不够');
  }

  function assertSelfTestVirtualBetweenCampusesMismatch() {
    const result = analyze(makeSelfTestVirtualBetweenCampusEvents(11 * 60 + 30), makeSelfTestSettings());
    assertNoSelfTestAnomaly(result, '异常：时间不够跑校区', '虚拟校区后到钱江有 55 分钟应足够');
    assertHasSelfTestAnomaly(result, '未改校区', /^未改校区$/);
  }

  function assertSelfTestShortAnomalyReasons() {
    const mismatchResult = analyze([
      makeSelfTestCourseEvent({
        key: 'short-reason-online',
        text: 'A线上城建',
        type: 'online',
        campus: '线上',
        courseForm: '线上',
        courseCampus: '城建校区',
        detailCampus: '城建校区',
        startMinutes: 9 * 60,
        endMinutes: 9 * 60 + 45,
        start: '09:00',
        end: '09:45'
      }),
      makeSelfTestCourseEvent({
        key: 'short-reason-offline',
        text: 'B钱江线下',
        campus: '钱江校区',
        hex: '#FB5757',
        startMinutes: 9 * 60 + 50,
        endMinutes: 10 * 60 + 35,
        start: '09:50',
        end: '10:35'
      })
    ], makeSelfTestSettings());
    const mismatch = mismatchResult.anomalies.find((item) => item.kind === '未改校区');
    if (!mismatch || mismatch.reason !== '未改校区') {
      throw new Error(`未改校区原因应保持简短，实际：${mismatch?.reason || '无'}`);
    }

    const dayOff = createDayOffAnomaly(makeSelfTestDayOffEvent({ text: '调休' }), makeSelfTestCourseEvent({ text: '语法课' }));
    if (dayOff.reason !== '默认调休一天，确认是否占休') {
      throw new Error(`调休占休原因应保持简短，实际：${dayOff.reason}`);
    }
  }

  function assertSelfTestMeetingsAcrossThreeCampuses() {
    const result = analyze([
      makeSelfTestMeetingEvent('meeting-qianjiang', '钱江会议', '钱江校区', '#FB5757', 9 * 60, 9 * 60 + 45),
      makeSelfTestMeetingEvent('meeting-chengjian', '城建会议', '城建校区', '#FFBF41', 10 * 60 + 40, 11 * 60 + 25),
      makeSelfTestMeetingEvent('meeting-zijingang', '紫金会议', '紫金港校区', '#B290FE', 14 * 60 + 5, 14 * 60 + 50)
    ], makeSelfTestSettings());
    assertHasSelfTestAnomaly(result, '异常：存在多个校区', /^老师跑了三次校区，注意查看$/);
  }

  function makeSelfTestThreeCampusEvents(zijingangStartMinutes) {
    return [
      makeSelfTestCourseEvent({
        key: 'three-chengjian',
        text: 'A城建线下',
        campus: '城建校区',
        hex: '#FFBF41',
        startMinutes: 9 * 60,
        endMinutes: 9 * 60 + 45,
        start: '09:00',
        end: '09:45'
      }),
      makeSelfTestCourseEvent({
        key: 'three-qianjiang',
        text: 'B钱江线下',
        campus: '钱江校区',
        hex: '#FB5757',
        startMinutes: 10 * 60 + 40,
        endMinutes: 12 * 60 + 15,
        start: '10:40',
        end: '12:15'
      }),
      makeSelfTestCourseEvent({
        key: 'three-zijingang',
        text: 'C紫金线下',
        campus: '紫金港校区',
        hex: '#B290FE',
        startMinutes: zijingangStartMinutes,
        endMinutes: zijingangStartMinutes + 45,
        start: formatMinutes(zijingangStartMinutes),
        end: formatMinutes(zijingangStartMinutes + 45)
      })
    ];
  }

  function assertSelfTestCampusCommuteQuery() {
    const date = '2026-07-20';
    const makeLegEvent = (key, teacher, campus, hex, startMinutes, endMinutes, overrides = {}) => makeSelfTestCourseEvent({
      key,
      teacher,
      date,
      text: key,
      campus,
      hex,
      startMinutes,
      endMinutes,
      start: formatMinutes(startMinutes),
      end: formatMinutes(endMinutes),
      ...overrides
    });
    const events = [
      makeLegEvent('甲城建第一节', '甲老师', '城建校区', '#FFBF41', 9 * 60, 9 * 60 + 45),
      makeLegEvent('甲城建第二节', '甲老师', '城建校区', '#FFBF41', 10 * 60, 10 * 60 + 45),
      makeLegEvent('甲线上课', '甲老师', '虚拟校区', '#7F91F5', 11 * 60, 11 * 60 + 45, { type: 'online', courseForm: '线上' }),
      makeLegEvent('甲钱江第一节', '甲老师', '钱江校区', '#FB5757', 12 * 60, 12 * 60 + 45),
      makeLegEvent('甲城建返回', '甲老师', '城建校区', '#FFBF41', 13 * 60, 13 * 60 + 45),
      makeLegEvent('甲钱江第二趟', '甲老师', '钱江校区', '#FB5757', 14 * 60, 14 * 60 + 45),
      makeLegEvent('乙钱江先上课', '乙老师', '钱江校区', '#FB5757', 9 * 60, 9 * 60 + 45),
      makeLegEvent('乙城建后上课', '乙老师', '城建校区', '#FFBF41', 10 * 60, 10 * 60 + 45),
      makeLegEvent('丙城建第一节', '丙老师', '城建校区', '#FFBF41', 9 * 60, 9 * 60 + 45),
      makeLegEvent('丙城建第二节', '丙老师', '城建校区', '#FFBF41', 10 * 60, 10 * 60 + 45),
      makeLegEvent('丁城建', '丁老师', '城建校区', '#FFBF41', 9 * 60, 9 * 60 + 45),
      makeLegEvent('丁紫金港', '丁老师', '紫金港校区', '#B290FE', 11 * 60, 11 * 60 + 45),
      makeLegEvent('丁钱江', '丁老师', '钱江校区', '#FB5757', 14 * 60, 14 * 60 + 45),
      makeLegEvent('戊另一天城建', '戊老师', '城建校区', '#FFBF41', 9 * 60, 9 * 60 + 45, { date: '2026-07-21' }),
      makeLegEvent('戊另一天钱江', '戊老师', '钱江校区', '#FB5757', 11 * 60, 11 * 60 + 45, { date: '2026-07-21' })
    ];

    const forward = findCampusCommuteLegs(events, { date, fromCampus: '城建校区', toCampus: '钱江校区' });
    if (forward.length !== 2 || forward.some((leg) => leg.teacher !== '甲老师')) {
      throw new Error(`城建到钱江应只识别甲老师两趟，实际：${forward.map((leg) => `${leg.teacher}:${leg.fromEvent.text}->${leg.toEvent.text}`).join('；') || '无'}`);
    }
    if (forward[0].fromEvent.text !== '甲城建第二节' || forward[0].toEvent.text !== '甲钱江第一节') {
      throw new Error('连续同校区课程应取城建最后一项和钱江第一项');
    }
    if (!forward[0].hasIntermediateOnline || forward[1].hasIntermediateOnline) {
      throw new Error('线上夹层标记与实际事件不一致');
    }
    if (forward.some((leg) => leg.teacher === '丁老师' || leg.teacher === '戊老师')) {
      throw new Error('A-C-B 或其他日期不应计入直接 A-B 查询');
    }

    const reverse = findCampusCommuteLegs(events, { date, fromCampus: '钱江校区', toCampus: '城建校区' });
    if (reverse.length !== 2 || !reverse.some((leg) => leg.teacher === '乙老师')) {
      throw new Error('反向查询应独立识别钱江到城建，不得与正向混合');
    }

    const rangeDates = resolveCommuteDateOptions([], { startDate: '2026-07-22', endDate: '2026-07-23' });
    if (rangeDates.join('|') !== '2026-07-22|2026-07-23') {
      throw new Error(`教师课表日期范围应拆成两个日期选项，实际：${rangeDates.join('|')}`);
    }
    if (!isSameTeacherScheduleDateRange(
      { startDate: '2026-07-22', endDate: '2026-07-23' },
      { startDate: '2026-07-22', endDate: '2026-07-23' }
    ) || isSameTeacherScheduleDateRange(
      { startDate: '2026-07-22', endDate: '2026-07-23' },
      { startDate: '2026-07-23', endDate: '2026-07-24' }
    )) {
      throw new Error('跑校区自动扫描必须正确判断教师课表日期范围是否已变化');
    }
    const locateAnomaly = createCampusCommuteLocateAnomaly(forward[0]);
    if (locateAnomaly.previous !== forward[0].fromEvent
      || locateAnomaly.current !== forward[0].toEvent
      || locateAnomaly.blockingEvents.length !== forward[0].intermediateOnlineEvents.length) {
      throw new Error('跑校区定位数据应保留前后色块和中间线上课');
    }

    const hadOwnDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document');
    const previousDocument = globalThis.document;
    const auditList = { hidden: false };
    const commuteResults = { hidden: true };
    globalThis.document = {
      getElementById(id) {
        if (id === 'ccheck-list') return auditList;
        if (id === 'ccheck-commute-results') return commuteResults;
        return null;
      }
    };
    try {
      setAuditResultMode('commute');
      if (!auditList.hidden || commuteResults.hidden) {
        throw new Error('显示跑校区列表时必须隐藏核对课表列表');
      }
      setAuditResultMode('audit');
      if (auditList.hidden || !commuteResults.hidden) {
        throw new Error('显示核对课表列表时必须隐藏跑校区列表');
      }
    } finally {
      if (hadOwnDocument) globalThis.document = previousDocument;
      else delete globalThis.document;
    }
  }

  function makeSelfTestVirtualBetweenCampusEvents(nextStartMinutes) {
    return [
      makeSelfTestCourseEvent({
        key: 'virtual-prev-chengjian',
        text: 'A城建线下',
        campus: '城建校区',
        hex: '#FFBF41',
        startMinutes: 9 * 60,
        endMinutes: 9 * 60 + 45,
        start: '09:00',
        end: '09:45'
      }),
      makeSelfTestCourseEvent({
        key: 'virtual-middle',
        text: 'C虚拟校区',
        type: 'online',
        campus: '虚拟校区',
        hex: '#7F91F5',
        startMinutes: 9 * 60 + 50,
        endMinutes: 10 * 60 + 35,
        start: '09:50',
        end: '10:35'
      }),
      makeSelfTestCourseEvent({
        key: 'virtual-next-qianjiang',
        text: 'B钱江线下',
        campus: '钱江校区',
        hex: '#FB5757',
        startMinutes: nextStartMinutes,
        endMinutes: nextStartMinutes + 45,
        start: formatMinutes(nextStartMinutes),
        end: formatMinutes(nextStartMinutes + 45)
      })
    ];
  }

  function makeSelfTestMeetingEvent(key, text, campus, hex, startMinutes, endMinutes) {
    return makeSelfTestCourseEvent({
      key,
      text,
      type: 'real',
      isMeeting: true,
      campus,
      courseCampus: campus,
      detailCampus: campus,
      hex,
      startMinutes,
      endMinutes,
      start: formatMinutes(startMinutes),
      end: formatMinutes(endMinutes)
    });
  }

  function makeSelfTestSettings() {
    return {
      adjacentGapMinutes: CONFIG.defaultAdjacentGapMinutes,
      onlinePressureBufferMinutes: CONFIG.defaultOnlinePressureBufferMinutes
    };
  }

  function assertHasSelfTestAnomaly(result, kind, reasonPattern) {
    const anomaly = result.anomalies.find((item) => {
      if (item.kind !== kind) return false;
      return !reasonPattern || reasonPattern.test(String(item.reason || ''));
    });
    if (!anomaly) {
      throw new Error(`期望异常 ${kind}，实际：${result.anomalies.map((item) => `${item.kind}:${item.reason}`).join('；') || '无'}`);
    }
  }

  function assertNoSelfTestAnomaly(result, kind, message) {
    const anomaly = result.anomalies.find((item) => item.kind === kind);
    if (anomaly) {
      throw new Error(`${message}，但实际出现 ${kind}：${anomaly.reason}`);
    }
  }

  function hasNoCourseGapText(text) {
    return /空出-?/.test(normalizeDayOffText(text).replace(/[－–—~～]/g, '-'));
  }

  function getDayOffUnavailableKind(event) {
    const match = normalizeDayOffText(event?.text || event).match(/请假|休假|调休/);
    return match ? match[0] : getDayOffRangeKind(event?.text || event);
  }

  function isMultiCampusSummaryEvent(event) {
    if (!event || isNoCourseDayOffEvent(event) || isMeetingEvent(event)) return false;
    if (isCampusColorEvent(event)) return true;
    return Boolean(isOnlineCourseEvent(event) && getCourseRealCampus(event));
  }

  function getMultiCampusSummaryCampus(event) {
    if (!event) return '';
    if (isVirtualOnlineCampusRuleEvent(event)) return getCourseRealCampus(event) || event.detailCampus || event.courseCampus || event.campus;
    const colorCampus = getColorRealCampus(event);
    if (colorCampus) return colorCampus;
    return getCourseRealCampus(event) || event.detailCampus || event.courseCampus || event.campus;
  }

  function getMultiCampusSummaryColorKey(event) {
    if (!event) return '';
    const hex = normalizeHex(event.hex);
    if (hex) return hex;

    const campus = getMultiCampusSummaryCampus(event);
    const fallbackHex = findColorForCampus(campus, isOnlineCourseEvent(event) ? '线上' : '线下');
    if (fallbackHex && fallbackHex !== '#UNKNOWN') return fallbackHex;
    return campus ? `${isOnlineCourseEvent(event) ? '线上' : '线下'}:${campus}` : '';
  }

  function isCampusColorEvent(event) {
    return Boolean(event && event.hex && getColorRealCampus(event) && !isNoCourseDayOffEvent(event));
  }

  function renderResult(result, label) {
    const statusBits = [
      `v${SCRIPT_VERSION} ${label}：识别 ${result.totalEvents} 个色块`,
      `休息标记 ${result.restMarkers || 0} 个`,
      `异常 ${result.anomalies.length} 条`
    ];
    if (result.unknownColors.length) statusBits.push(`未知颜色 ${result.unknownColors.length} 种`);
    setStatus(statusBits.join('，') + '。');

    document.getElementById('ccheck-summary').innerHTML = `
      <div class="ccheck-stat"><strong>${result.totalEvents}</strong>色块</div>
      <div class="ccheck-stat"><strong>${result.anomalies.length}</strong>异常</div>
      <div class="ccheck-stat"><strong>${result.unknownColors.length}</strong>未知色</div>
    `;

    const list = document.getElementById('ccheck-list');
    const unknownHtml = result.unknownColors.length
      ? `<div class="ccheck-unknown">未知颜色：${result.unknownColors.map((item) => `${item.hex}(${item.count})`).join('、')}</div>`
      : '';

    if (!result.anomalies.length) {
      list.innerHTML = `<div class="ccheck-empty">没有发现异常。</div>${unknownHtml}`;
      return;
    }

    const anomalyGroups = groupAnomaliesByTeacherDate(result.anomalies);

    list.innerHTML = anomalyGroups.map((group, index) => {
      return `
        <div class="ccheck-card">
          <div class="ccheck-card-title">
            <span>${index + 1}. ${escapeHtml(group.teacher)} - ${escapeHtml(group.date)}</span>
          </div>
          <small>${escapeHtml(summarizeAnomalyKinds(group.anomalies))}</small>
          <small>${escapeHtml(summarizeAnomalyReasons(group.anomalies))}</small>
          <button class="ccheck-locate" type="button" data-locate-group="${index}">定位老师</button>
        </div>
      `;
    }).join('') + unknownHtml;

    list.querySelectorAll('[data-locate-group]').forEach((button) => {
      button.addEventListener('click', () => locateAnomalyGroup(anomalyGroups[Number(button.dataset.locateGroup)]));
    });
  }

  function refreshMeetingPlanner(events, options = {}) {
    const container = document.getElementById('ccheck-meeting-teachers');
    if (!container) return;

    const teachers = getMeetingTeachers(events);
    const validTeachers = new Set(teachers);
    state.meetingPlanner.selectedTeachers.forEach((teacher) => {
      if (!validTeachers.has(teacher)) state.meetingPlanner.selectedTeachers.delete(teacher);
    });
    setMeetingDefaultDates(events, options);

    if (!teachers.length) {
      container.innerHTML = '<div class="ccheck-empty">本次扫描没有识别到老师。</div>';
      return;
    }

    container.innerHTML = teachers.map((teacher) => {
      const checked = state.meetingPlanner.selectedTeachers.has(teacher) ? 'checked' : '';
      return `
        <label class="ccheck-teacher-option">
          <input type="checkbox" data-meeting-teacher value="${escapeHtml(teacher)}" ${checked}>
          <span title="${escapeHtml(teacher)}">${escapeHtml(teacher)}</span>
        </label>
      `;
    }).join('');
  }

  function switchView(view) {
    const nextView = view === 'meeting' || view === 'supervisor' ? view : 'audit';
    state.activeView = nextView;
    document.querySelectorAll('#ccheck-panel [data-view]').forEach((button) => {
      button.classList.toggle('ccheck-tab-active', button.dataset.view === nextView);
    });
    const auditView = document.getElementById('ccheck-view-audit');
    const meetingView = document.getElementById('ccheck-view-meeting');
    const supervisorView = document.getElementById('ccheck-view-supervisor');
    const rulesView = document.getElementById('ccheck-view-rules');
    if (auditView) auditView.hidden = nextView !== 'audit';
    if (meetingView) meetingView.hidden = nextView !== 'meeting';
    if (supervisorView) supervisorView.hidden = nextView !== 'supervisor';
    if (rulesView) rulesView.hidden = nextView !== 'rules';
    if (nextView === 'meeting' && state.lastEvents.length) refreshMeetingPlanner(state.lastEvents);
    if (nextView === 'supervisor') {
      renderSupervisorPlanner();
      setStatus('已切换到督导排班表导入。上传石墨 XLS/XLSX 后，回到排会议页默认包含督导。');
    } else {
      setStatus(nextView === 'meeting' ? '已切换到排会议。先扫描课表，再选择老师查找共同空档。' : '已切换到核对课表。');
    }
  }

  function clearCurrentData() {
    state.lastResult = null;
    state.lastEvents = [];
    state.lastScanDateRange = null;
    state.meetingPlanner.selectedTeachers.clear();
    clearMarkers();
    setAuditResultMode('audit');

    const summary = document.getElementById('ccheck-summary');
    if (summary) {
      summary.innerHTML = `
        <div class="ccheck-stat"><strong>0</strong>色块</div>
        <div class="ccheck-stat"><strong>0</strong>异常</div>
        <div class="ccheck-stat"><strong>0</strong>未知色</div>
      `;
    }

    const list = document.getElementById('ccheck-list');
    if (list) list.innerHTML = '<div class="ccheck-empty">当前数据已清空。</div>';

    const commuteResults = document.getElementById('ccheck-commute-results');
    if (commuteResults) commuteResults.innerHTML = '<div class="ccheck-empty">当前数据已清空，选择教师课表日期后可直接查询跑校区。</div>';

    const teacherList = document.getElementById('ccheck-meeting-teachers');
    if (teacherList) teacherList.innerHTML = '<div class="ccheck-empty">扫描后显示老师。</div>';

    const meetingResults = document.getElementById('ccheck-meeting-results');
    if (meetingResults) meetingResults.innerHTML = '';

    clearMeetingDateInputs();
    setStatus('当前扫描数据已清空，可以重新扫描。');
  }

  function getMeetingTeachers(events) {
    const teachers = new Set((events || [])
      .map((event) => event.teacher)
      .filter(Boolean));

    (state.latestDiagramData?.teachers || []).forEach((teacher) => {
      const name = teacher.name || teacher.teacher_name || teacher.teacherName || '';
      if (name) teachers.add(String(name).trim());
    });

    Array.from(document.querySelectorAll('.row')).forEach((row) => {
      const name = textOf(row.children[0]).trim();
      if (name) teachers.add(name);
    });

    return Array.from(teachers).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  async function handleSupervisorFileChange(input) {
    const file = input?.files?.[0];
    if (!file) return;
    setButtonsDisabled(true);
    renderSupervisorMessage('正在读取督导 XLS/XLSX...');
    setStatus(`正在读取督导表：${file.name}`);
    try {
      const workbook = await parseSupervisorWorkbookFile(file);
      applySupervisorWorkbook(workbook);
      setStatus(`已读取督导表：${workbook.supervisors.length} 位督导，${workbook.dateColumns.length} 个日期。`);
    } catch (error) {
      console.warn('[campus-commute-checker] 督导 XLS/XLSX 读取失败', error);
      state.supervisorPlanner.workbookName = file.name;
      state.supervisorPlanner.supervisors = [];
      state.supervisorPlanner.selectedSupervisors.clear();
      state.supervisorPlanner.dateColumns = [];
      state.supervisorPlanner.warnings = [`读取失败：${error?.message || error}`];
      renderSupervisorPlanner();
      const message = error?.message || String(error);
      renderSupervisorMessage(`督导 XLS/XLSX 读取失败：${message}`);
      setStatus(`督导 XLS/XLSX 读取失败：${message}`);
    } finally {
      setButtonsDisabled(false);
    }
  }

  async function parseSupervisorWorkbookFile(file) {
    if (!file || !/\.(?:xls|xlsx)$/i.test(file.name || '')) {
      throw new Error('请上传石墨导出的 .xls 或 .xlsx 文件。');
    }
    if (typeof DOMParser === 'undefined') {
      throw new Error('当前浏览器不支持解析表格 XML/HTML，请换用新版 Chrome 后再试。');
    }

    const arrayBuffer = await file.arrayBuffer();
    if (!isZipArrayBuffer(arrayBuffer)) {
      if (isOleCompoundArrayBuffer(arrayBuffer)) {
        return parseSupervisorBinaryXlsWorkbook(arrayBuffer, file.name);
      }
      return parseSupervisorHtmlWorkbook(arrayBuffer, file.name);
    }

    const entries = await readXlsxZipEntries(arrayBuffer);
    const sheetPath = findFirstWorksheetPath(entries);
    if (!sheetPath) throw new Error('没有在 XLSX 中找到工作表。');

    const sharedStrings = entries.has('xl/sharedStrings.xml')
      ? parseXlsxSharedStrings(parseXmlDocument(decodeUtf8(entries.get('xl/sharedStrings.xml'))))
      : [];
    const redStyleIds = entries.has('xl/styles.xml')
      ? parseXlsxRedStyleIds(parseXmlDocument(decodeUtf8(entries.get('xl/styles.xml'))))
      : new Set();
    const rows = parseXlsxSheetRows(
      parseXmlDocument(decodeUtf8(entries.get(sheetPath))),
      sharedStrings,
      redStyleIds
    );
    return parseSupervisorRows(rows, file.name);
  }

  function isZipArrayBuffer(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    return bytes.length >= 4
      && bytes[0] === 0x50
      && bytes[1] === 0x4b
      && bytes[2] === 0x03
      && bytes[3] === 0x04;
  }

  function isOleCompoundArrayBuffer(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
  }

  function parseSupervisorBinaryXlsWorkbook(arrayBuffer, workbookName) {
    const workbookStream = readOleWorkbookStream(arrayBuffer);
    const records = readBiffRecords(workbookStream);
    const strings = readBiffSharedStrings(records);
    const redStyleIds = readBiffRedStyleIds(records);
    const sheets = readBiffBoundsheets(records, workbookStream.length);
    const errors = [];
    for (let index = 0; index < sheets.length; index += 1) {
      const sheet = sheets[index];
      const nextSheet = sheets[index + 1];
      const rows = readBiffSheetRows(records, strings, redStyleIds, sheet.offset, nextSheet?.offset || workbookStream.length);
      try {
        return parseSupervisorRows(rows, workbookName);
      } catch (error) {
        errors.push(`${sheet.name || `Sheet${index + 1}`}：${error?.message || error}`);
      }
    }
    throw new Error(`没有在二进制 .xls 中识别到督导排班结构：${errors[0] || '没有工作表'}`);
  }

  function readOleWorkbookStream(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const endOfChain = 0xfffffffe;
    const freeSector = 0xffffffff;
    const sectorSize = 1 << view.getUint16(30, true);
    const miniSectorSize = 1 << view.getUint16(32, true);
    const fatSectorCount = view.getUint32(44, true);
    const firstDirectorySector = view.getUint32(48, true);
    const miniStreamCutoff = view.getUint32(56, true);
    const firstMiniFatSector = view.getUint32(60, true);
    const difat = [];
    for (let index = 0; index < 109; index += 1) {
      const sector = view.getUint32(76 + index * 4, true);
      if (sector < 0xfffffff0 && difat.length < fatSectorCount) difat.push(sector);
    }
    const sectorOffset = (sector) => (sector + 1) * sectorSize;
    const fat = [];
    difat.forEach((sector) => {
      const offset = sectorOffset(sector);
      for (let item = 0; item < sectorSize / 4; item += 1) {
        fat.push(view.getUint32(offset + item * 4, true));
      }
    });
    const readChain = (startSector) => {
      const parts = [];
      const seen = new Set();
      let sector = startSector;
      while (sector !== endOfChain && sector !== freeSector && sector < fat.length && !seen.has(sector)) {
        seen.add(sector);
        const offset = sectorOffset(sector);
        parts.push(bytes.slice(offset, offset + sectorSize));
        sector = fat[sector];
      }
      return concatUint8Arrays(parts);
    };
    const directoryStream = readChain(firstDirectorySector);
    const entries = [];
    for (let offset = 0; offset + 128 <= directoryStream.length; offset += 128) {
      const entry = directoryStream.slice(offset, offset + 128);
      const nameLength = getUint16(entry, 64);
      if (nameLength < 2) continue;
      const name = decodeUtf16Le(entry.slice(0, nameLength - 2));
      const type = entry[66];
      const startSector = getUint32(entry, 116);
      const size = getUint32(entry, 120);
      entries.push({ name, type, startSector, size });
    }
    const root = entries.find((entry) => entry.name === 'Root Entry');
    const workbook = entries.find((entry) => entry.name === 'Workbook' || entry.name === 'Book');
    if (!workbook) throw new Error('二进制 .xls 中没有找到 Workbook 数据流。');

    const miniStream = root ? readChain(root.startSector) : new Uint8Array();
    const miniFatStream = firstMiniFatSector < 0xfffffff0 ? readChain(firstMiniFatSector) : new Uint8Array();
    const miniFat = [];
    for (let offset = 0; offset + 4 <= miniFatStream.length; offset += 4) {
      miniFat.push(getUint32(miniFatStream, offset));
    }
    const readMiniChain = (startSector, size) => {
      const parts = [];
      const seen = new Set();
      let sector = startSector;
      while (sector !== endOfChain && sector !== freeSector && sector < miniFat.length && !seen.has(sector)) {
        seen.add(sector);
        const offset = sector * miniSectorSize;
        parts.push(miniStream.slice(offset, offset + miniSectorSize));
        sector = miniFat[sector];
      }
      return concatUint8Arrays(parts).slice(0, size);
    };
    return workbook.size >= miniStreamCutoff
      ? readChain(workbook.startSector).slice(0, workbook.size)
      : readMiniChain(workbook.startSector, workbook.size);
  }

  function concatUint8Arrays(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    parts.forEach((part) => {
      output.set(part, offset);
      offset += part.length;
    });
    return output;
  }

  function getUint16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function getUint32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  function decodeUtf16Le(bytes) {
    return new TextDecoder('utf-16le').decode(bytes);
  }

  function readBiffRecords(workbookStream) {
    const records = [];
    let offset = 0;
    while (offset + 4 <= workbookStream.length) {
      const id = getUint16(workbookStream, offset);
      const length = getUint16(workbookStream, offset + 2);
      const start = offset + 4;
      const data = workbookStream.slice(start, start + length);
      records.push({ id, offset, data });
      offset = start + length;
    }
    return records;
  }

  function readBiffSharedStrings(records) {
    const record = records.find((item) => item.id === 0x00fc);
    if (!record) return [];
    const strings = [];
    const uniqueCount = getUint32(record.data, 4);
    let offset = 8;
    for (let index = 0; index < uniqueCount && offset < record.data.length; index += 1) {
      const parsed = readBiffUnicodeString(record.data, offset);
      strings.push(parsed.text);
      offset = parsed.offset;
    }
    return strings;
  }

  function readBiffUnicodeString(bytes, offset) {
    const length = getUint16(bytes, offset);
    offset += 2;
    const flags = bytes[offset] || 0;
    offset += 1;
    let richRuns = 0;
    let extensionSize = 0;
    if (flags & 0x08) {
      richRuns = getUint16(bytes, offset);
      offset += 2;
    }
    if (flags & 0x04) {
      extensionSize = getUint32(bytes, offset);
      offset += 4;
    }
    let text = '';
    if (flags & 0x01) {
      text = decodeUtf16Le(bytes.slice(offset, offset + length * 2));
      offset += length * 2;
    } else {
      text = new TextDecoder('latin1').decode(bytes.slice(offset, offset + length));
      offset += length;
    }
    offset += richRuns * 4 + extensionSize;
    return { text, offset };
  }

  function readBiffRedStyleIds(records) {
    const fontColors = [];
    records.forEach((record) => {
      if (record.id !== 0x0031 || record.data.length < 6) return;
      fontColors.push(getUint16(record.data, 4));
    });
    const redFontIndexes = new Set();
    fontColors.forEach((colorIndex, recordIndex) => {
      const actualIndex = recordIndex >= 4 ? recordIndex + 1 : recordIndex;
      if (isBiffRedColorIndex(colorIndex)) {
        redFontIndexes.add(recordIndex);
        redFontIndexes.add(actualIndex);
      }
    });
    const redStyleIds = new Set();
    let styleIndex = 0;
    records.forEach((record) => {
      if (record.id !== 0x00e0 || record.data.length < 2) return;
      const fontIndex = getUint16(record.data, 0);
      if (redFontIndexes.has(fontIndex)) redStyleIds.add(styleIndex);
      styleIndex += 1;
    });
    return redStyleIds;
  }

  function isBiffRedColorIndex(colorIndex) {
    return colorIndex === 2 || colorIndex === 3 || colorIndex === 10;
  }

  function readBiffBoundsheets(records, streamLength) {
    const sheets = records
      .filter((record) => record.id === 0x0085 && record.data.length >= 8)
      .map((record, index) => ({
        offset: getUint32(record.data, 0),
        name: readBiffShortSheetName(record.data, 6) || `Sheet${index + 1}`
      }))
      .filter((sheet) => sheet.offset > 0 && sheet.offset < streamLength)
      .sort((a, b) => a.offset - b.offset);
    return sheets.length ? sheets : [{ offset: 0, name: 'Sheet1' }];
  }

  function readBiffShortSheetName(bytes, offset) {
    const length = bytes[offset] || 0;
    const flags = bytes[offset + 1] || 0;
    const start = offset + 2;
    return flags & 0x01
      ? decodeUtf16Le(bytes.slice(start, start + length * 2))
      : new TextDecoder('latin1').decode(bytes.slice(start, start + length));
  }

  function readBiffSheetRows(records, strings, redStyleIds, startOffset, endOffset) {
    const rows = [];
    records.forEach((record) => {
      if (record.offset < startOffset || record.offset >= endOffset) return;
      const data = record.data;
      if (record.id === 0x00fd && data.length >= 10) {
        const row = getUint16(data, 0);
        const column = getUint16(data, 2);
        const style = getUint16(data, 4);
        const stringIndex = getUint32(data, 6);
        setSupervisorBiffCell(rows, row, column, strings[stringIndex] || '', redStyleIds.has(style));
      } else if (record.id === 0x0201 && data.length >= 6) {
        setSupervisorBiffCell(rows, getUint16(data, 0), getUint16(data, 2), '', redStyleIds.has(getUint16(data, 4)));
      } else if (record.id === 0x027e && data.length >= 10) {
        const row = getUint16(data, 0);
        const column = getUint16(data, 2);
        const style = getUint16(data, 4);
        setSupervisorBiffCell(rows, row, column, String(decodeBiffRk(getUint32(data, 6))), redStyleIds.has(style));
      } else if (record.id === 0x00bd && data.length >= 8) {
        readBiffMulRkCells(rows, data, redStyleIds);
      } else if (record.id === 0x00be && data.length >= 6) {
        readBiffMulBlankCells(rows, data, redStyleIds);
      } else if (record.id === 0x0203 && data.length >= 14) {
        const row = getUint16(data, 0);
        const column = getUint16(data, 2);
        const style = getUint16(data, 4);
        const value = new DataView(data.buffer, data.byteOffset + 6, 8).getFloat64(0, true);
        setSupervisorBiffCell(rows, row, column, String(value), redStyleIds.has(style));
      }
    });
    return rows;
  }

  function setSupervisorBiffCell(rows, row, column, value, red) {
    if (!rows[row]) rows[row] = [];
    rows[row][column] = { value: String(value ?? '').trim(), red: Boolean(red) };
  }

  function readBiffMulBlankCells(rows, data, redStyleIds) {
    const row = getUint16(data, 0);
    const firstColumn = getUint16(data, 2);
    const lastColumn = getUint16(data, data.length - 2);
    let offset = 4;
    for (let column = firstColumn; column <= lastColumn && offset + 2 <= data.length - 2; column += 1) {
      const style = getUint16(data, offset);
      offset += 2;
      setSupervisorBiffCell(rows, row, column, '', redStyleIds.has(style));
    }
  }

  function readBiffMulRkCells(rows, data, redStyleIds) {
    const row = getUint16(data, 0);
    const firstColumn = getUint16(data, 2);
    const lastColumn = getUint16(data, data.length - 2);
    let offset = 4;
    for (let column = firstColumn; column <= lastColumn && offset + 6 <= data.length - 2; column += 1) {
      const style = getUint16(data, offset);
      const rk = getUint32(data, offset + 2);
      offset += 6;
      setSupervisorBiffCell(rows, row, column, String(decodeBiffRk(rk)), redStyleIds.has(style));
    }
  }

  function decodeBiffRk(rk) {
    let value;
    if (rk & 0x02) {
      value = rk >> 2;
    } else {
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      view.setUint32(4, rk & 0xfffffffc, true);
      value = view.getFloat64(0, true);
    }
    if (rk & 0x01) value /= 100;
    return Number.isInteger(value) ? value : Number(value.toFixed(6));
  }

  function parseSupervisorHtmlWorkbook(arrayBuffer, workbookName) {
    const text = decodeSpreadsheetText(arrayBuffer);
    if (!/<table[\s>]/i.test(text)) {
      throw new Error('这个 .xls 不是石墨常见的 HTML 表格，也不是 xlsx 压缩格式；请在石墨里另存/导出为 .xlsx 后再上传。');
    }
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const cssRedClasses = collectHtmlRedClasses(doc);
    const tables = Array.from(doc.querySelectorAll('table'));
    if (!tables.length) throw new Error('没有在 .xls 文件里找到表格。');
    const errors = [];
    for (const table of tables) {
      const rows = htmlTableToRows(table, cssRedClasses);
      try {
        return parseSupervisorRows(rows, workbookName);
      } catch (error) {
        errors.push(error?.message || String(error));
      }
    }
    throw new Error(`没有在 ${tables.length} 张表里识别到督导排班结构：${errors[0] || '未知原因'}`);
  }

  function htmlTableToRows(table, cssRedClasses) {
    const rows = [];
    const occupied = [];
    Array.from(table.rows || []).forEach((row, rowIndex) => {
      if (!rows[rowIndex]) rows[rowIndex] = [];
      if (!occupied[rowIndex]) occupied[rowIndex] = [];
      let columnIndex = 0;
      Array.from(row.cells || []).forEach((cell) => {
        while (occupied[rowIndex][columnIndex]) columnIndex += 1;
        const rowspan = Math.max(1, Number(cell.getAttribute('rowspan') || 1));
        const colspan = Math.max(1, Number(cell.getAttribute('colspan') || 1));
        const parsedCell = {
          value: htmlCellText(cell),
          red: isHtmlCellRed(cell, cssRedClasses)
        };
        for (let rowOffset = 0; rowOffset < rowspan; rowOffset += 1) {
          const targetRow = rowIndex + rowOffset;
          if (!rows[targetRow]) rows[targetRow] = [];
          if (!occupied[targetRow]) occupied[targetRow] = [];
          for (let colOffset = 0; colOffset < colspan; colOffset += 1) {
            const targetColumn = columnIndex + colOffset;
            occupied[targetRow][targetColumn] = true;
            rows[targetRow][targetColumn] = rowOffset === 0 && colOffset === 0
              ? parsedCell
              : { value: parsedCell.value, red: parsedCell.red, merged: true };
          }
        }
        columnIndex += colspan;
      });
    });
    return rows;
  }

  function decodeSpreadsheetText(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const labels = ['utf-8', 'gb18030', 'utf-16le'];
    let best = '';
    let bestScore = -Infinity;
    labels.forEach((label) => {
      try {
        const text = new TextDecoder(label).decode(bytes);
        const score = scoreSpreadsheetText(text);
        if (score > bestScore) {
          best = text;
          bestScore = score;
        }
      } catch (error) {
        // Some browsers may not support every legacy decoder label.
      }
    });
    return best;
  }

  function scoreSpreadsheetText(text) {
    let score = 0;
    if (/<table[\s>]/i.test(text)) score += 1000;
    if (/<html[\s>]/i.test(text)) score += 200;
    score -= (text.match(/\uFFFD/g) || []).length * 20;
    score += (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    return score;
  }

  function htmlCellText(cell) {
    return String(cell?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function collectHtmlRedClasses(doc) {
    const redClasses = new Set();
    Array.from(doc.querySelectorAll('style')).forEach((style) => {
      const text = style.textContent || '';
      const rulePattern = /\.([_a-zA-Z][-_a-zA-Z0-9]*)[^{}]*\{([^}]*)\}/g;
      let match;
      while ((match = rulePattern.exec(text)) !== null) {
        if (/color\s*:\s*([^;]+)/i.test(match[2]) && isHtmlColorRed(RegExp.$1)) redClasses.add(match[1]);
      }
    });
    return redClasses;
  }

  function isHtmlCellRed(cell, cssRedClasses) {
    if (!cell) return false;
    const candidates = [cell].concat(Array.from(cell.querySelectorAll('*')));
    return candidates.some((element) => {
      const style = element.getAttribute('style') || '';
      const styleColor = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)?.[1] || '';
      const fontColor = element.tagName === 'FONT' ? element.getAttribute('color') || '' : '';
      const classColor = Array.from(element.classList || []).some((className) => cssRedClasses.has(className));
      return classColor || isHtmlColorRed(styleColor) || isHtmlColorRed(fontColor);
    });
  }

  function isHtmlColorRed(value) {
    const color = String(value || '').trim().toLowerCase();
    if (!color) return false;
    if (color === 'red' || color.includes('ff0000')) return true;
    let match = color.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/i);
    if (match) {
      const hex = match[1].length === 3
        ? match[1].split('').map((item) => item + item).join('')
        : match[1];
      return isRgbRed(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16));
    }
    match = color.match(/rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/i);
    if (match) return isRgbRed(Number(match[1]), Number(match[2]), Number(match[3]));
    return false;
  }

  function isRgbRed(red, green, blue) {
    return red >= 180 && green <= 110 && blue <= 110;
  }

  async function readXlsxZipEntries(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const eocdOffset = findZipEndOfCentralDirectory(view);
    if (eocdOffset < 0) throw new Error('XLSX 压缩包结构不完整。');
    const centralDirSize = view.getUint32(eocdOffset + 12, true);
    const centralDirOffset = view.getUint32(eocdOffset + 16, true);
    const endOffset = centralDirOffset + centralDirSize;
    const entries = new Map();
    let offset = centralDirOffset;

    while (offset < endOffset) {
      if (view.getUint32(offset, true) !== 0x02014b50) break;
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const fileNameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localHeaderOffset = view.getUint32(offset + 42, true);
      const nameBytes = bytes.slice(offset + 46, offset + 46 + fileNameLength);
      const name = decodeUtf8(nameBytes).replace(/\\/g, '/');

      if (!name.endsWith('/')) {
        const localNameLength = view.getUint16(localHeaderOffset + 26, true);
        const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
        const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
        const compressed = bytes.slice(dataStart, dataStart + compressedSize);
        entries.set(name, await inflateZipEntry(compressed, method));
      }
      offset += 46 + fileNameLength + extraLength + commentLength;
    }
    return entries;
  }

  function findZipEndOfCentralDirectory(view) {
    const minOffset = Math.max(0, view.byteLength - 0xffff - 22);
    for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) return offset;
    }
    return -1;
  }

  async function inflateZipEntry(bytes, method) {
    if (method === 0) return bytes;
    if (method !== 8) throw new Error(`暂不支持的 XLSX 压缩方式：${method}`);
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持直接解压 XLSX，请换用新版 Chrome。');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function findFirstWorksheetPath(entries) {
    return Array.from(entries.keys())
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      [0] || '';
  }

  function decodeUtf8(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  function parseXmlDocument(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (getXmlElements(doc, 'parsererror').length) throw new Error('XLSX XML 解析失败。');
    return doc;
  }

  function getXmlElements(parent, name) {
    const direct = Array.from(parent.getElementsByTagName(name));
    if (direct.length || !parent.getElementsByTagNameNS) return direct;
    return Array.from(parent.getElementsByTagNameNS('*', name));
  }

  function getXmlDirectChildren(parent, name) {
    return Array.from(parent.children || []).filter((child) => child.localName === name || child.nodeName === name);
  }

  function parseXlsxSharedStrings(doc) {
    return getXmlElements(doc, 'si').map((item) => (
      getXmlElements(item, 't').map((node) => node.textContent || '').join('')
    ));
  }

  function parseXlsxRedStyleIds(doc) {
    const fontsNode = getXmlElements(doc, 'fonts')[0];
    const fontRedFlags = fontsNode
      ? getXmlDirectChildren(fontsNode, 'font').map((font) => isXlsxFontRed(font))
      : [];
    const cellXfsNode = getXmlElements(doc, 'cellXfs')[0];
    const redStyleIds = new Set();
    if (!cellXfsNode) return redStyleIds;
    getXmlDirectChildren(cellXfsNode, 'xf').forEach((xf, index) => {
      const fontId = Number(xf.getAttribute('fontId') || 0);
      if (fontRedFlags[fontId]) redStyleIds.add(String(index));
    });
    return redStyleIds;
  }

  function isXlsxFontRed(font) {
    return getXmlElements(font, 'color').some(isXlsxColorRed);
  }

  function isXlsxColorRed(colorNode) {
    const indexed = colorNode.getAttribute('indexed');
    if (indexed === '3' || indexed === '10') return true;
    const rgb = colorNode.getAttribute('rgb') || '';
    const hex = rgb.replace(/[^0-9a-f]/gi, '').slice(-6);
    if (hex.length !== 6) return false;
    const red = parseInt(hex.slice(0, 2), 16);
    const green = parseInt(hex.slice(2, 4), 16);
    const blue = parseInt(hex.slice(4, 6), 16);
    return red >= 180 && green <= 110 && blue <= 110;
  }

  function parseXlsxSheetRows(doc, sharedStrings, redStyleIds) {
    return getXmlElements(doc, 'row').map((row) => {
      const cells = [];
      getXmlDirectChildren(row, 'c').forEach((cell) => {
        const reference = cell.getAttribute('r') || '';
        const columnIndex = xlsxColumnIndex(reference);
        if (columnIndex < 0) return;
        cells[columnIndex] = {
          value: readXlsxCellValue(cell, sharedStrings),
          red: redStyleIds.has(cell.getAttribute('s') || '') || isXlsxCellRichTextRed(cell)
        };
      });
      return cells;
    });
  }

  function readXlsxCellValue(cell, sharedStrings) {
    const type = cell.getAttribute('t') || '';
    if (type === 'inlineStr') return getXmlElements(cell, 't').map((node) => node.textContent || '').join('');
    const rawValue = getXmlElements(cell, 'v')[0]?.textContent || '';
    if (type === 's') return sharedStrings[Number(rawValue)] || '';
    if (type === 'str') return rawValue;
    return rawValue;
  }

  function isXlsxCellRichTextRed(cell) {
    return getXmlElements(cell, 'rPr').some((runProps) => getXmlElements(runProps, 'color').some(isXlsxColorRed));
  }

  function xlsxColumnIndex(reference) {
    const letters = String(reference || '').match(/^[A-Z]+/i)?.[0] || '';
    if (!letters) return -1;
    return letters.toUpperCase().split('').reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  }

  function parseSupervisorRows(rows, workbookName) {
    const header = detectSupervisorHeader(rows, workbookName);
    const supervisors = [];
    const warnings = [];

    rows.slice(header.rowIndex + 1).forEach((row, relativeIndex) => {
      const rowIndex = header.rowIndex + 1 + relativeIndex;
      const name = String(row[header.nameColumn]?.value || '').trim();
      if (!name || /合计|备注|说明|日期|姓名|督导/.test(name)) return;
      const days = new Map();
      const shiftCodes = new Map();
      header.dateColumns.forEach((column) => {
        const cell = row[column.columnIndex] || { value: '', red: false };
        const parsed = parseSupervisorCell(cell.value, cell.red, name, column.date);
        days.set(column.date, parsed.availableRanges);
        if (parsed.shiftCode) shiftCodes.set(column.date, parsed.shiftCode);
        parsed.warnings.forEach((warning) => warnings.push(formatSupervisorWarningText(name, column.date, warning)));
      });
      supervisors.push({ name, days, shiftCodes, rowIndex });
    });

    if (!supervisors.length) throw new Error('没有识别到督导姓名行。');
    return {
      workbookName,
      supervisors,
      dateColumns: header.dateColumns,
      warnings
    };
  }

  function detectSupervisorHeader(rows, workbookName) {
    let best = null;
    const baseContext = inferSupervisorDateContext(workbookName, rows);
    rows.slice(0, 30).forEach((row, rowIndex) => {
      const rowContext = inferSupervisorDateContext(row.map((cell) => cell?.value || '').join(' '), rows, baseContext);
      const dateColumns = [];
      row.forEach((cell, columnIndex) => {
        const date = parseSupervisorHeaderDate(cell?.value, rowContext);
        if (date) dateColumns.push({ columnIndex, date });
      });
      const inferredWeekdayColumns = dateColumns.length >= 3 ? [] : inferSupervisorWeekdayDateColumns(row, rowContext);
      const candidateColumns = dateColumns.length >= 3 ? dateColumns : inferredWeekdayColumns;
      if (candidateColumns.length >= 3 && (!best || candidateColumns.length > best.dateColumns.length)) {
        best = {
          rowIndex,
          dateColumns: candidateColumns,
          nameColumn: findSupervisorNameColumn(rows, rowIndex, candidateColumns[0].columnIndex)
        };
      }
    });
    if (!best) throw new Error('没有识别到日期表头，请确认第一张表是“姓名行 + 日期列”。');
    best.dateColumns = dedupeSupervisorDateColumns(best.dateColumns);
    return best;
  }

  function inferSupervisorWeekdayDateColumns(row, context) {
    if (!context?.year || !context?.month) return [];
    const daysInMonth = new Date(context.year, context.month, 0).getDate();
    let day = 1;
    const columns = [];
    (row || []).forEach((cell, columnIndex) => {
      const text = String(cell?.value || '').trim();
      if (!/^(?:星期|周)[一二三四五六日天]$/.test(text)) return;
      if (day > daysInMonth) return;
      columns.push({
        columnIndex,
        date: formatIsoDateParts(context.year, context.month, day)
      });
      day += 1;
    });
    return columns;
  }

  function inferSupervisorDateContext(text, rows, fallback = {}) {
    const source = `${text || ''} ${(rows || []).slice(0, 6).map((row) => row.map((cell) => cell?.value || '').join(' ')).join(' ')}`;
    const current = new Date();
    const yearMonth = source.match(/(20\d{2})\D{0,4}([01]?\d)\s*月?/) || source.match(/(20\d{2})[-_.年\/]([01]?\d)/);
    if (yearMonth) {
      return { year: Number(yearMonth[1]), month: Number(yearMonth[2]) };
    }
    const monthOnly = source.match(/([01]?\d)\s*月/);
    return {
      year: fallback.year || current.getFullYear(),
      month: Number(monthOnly?.[1] || fallback.month || current.getMonth() + 1)
    };
  }

  function parseSupervisorHeaderDate(value, context) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    if (/^\d+(?:\.\d+)?$/.test(text)) {
      const number = Number(text);
      if (number >= 1 && number <= 31 && context?.year && context?.month) {
        return formatIsoDateParts(context.year, context.month, number);
      }
      if (number > 25000 && number < 80000) return excelSerialToIsoDate(number);
    }

    let match = text.match(/(20\d{2})\D+([01]?\d)\D+([0-3]?\d)/);
    if (match) return formatIsoDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
    match = text.match(/([01]?\d)\s*月\s*([0-3]?\d)\s*日?/);
    if (match) return formatIsoDateParts(context.year, Number(match[1]), Number(match[2]));
    match = text.match(/(?:^|\D)([01]?\d)[\/.-]([0-3]?\d)(?:\D|$)/);
    if (match) return formatIsoDateParts(context.year, Number(match[1]), Number(match[2]));
    match = text.match(/^([0-3]?\d)\s*(?:日|号)?(?:\s*(?:周|星期)[一二三四五六日天])?$/);
    if (match && context?.year && context?.month) return formatIsoDateParts(context.year, context.month, Number(match[1]));
    return '';
  }

  function formatIsoDateParts(year, month, day) {
    if (!year || month < 1 || month > 12 || day < 1 || day > 31) return '';
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function excelSerialToIsoDate(serial) {
    const millis = Math.round((serial - 25569) * 86400 * 1000);
    const date = new Date(millis);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  function findSupervisorNameColumn(rows, headerRowIndex, firstDateColumn) {
    for (let columnIndex = Math.max(0, firstDateColumn - 1); columnIndex >= 0; columnIndex -= 1) {
      const hasNames = rows.slice(headerRowIndex + 1, headerRowIndex + 8)
        .some((row) => String(row[columnIndex]?.value || '').trim());
      if (hasNames) return columnIndex;
    }
    return 0;
  }

  function dedupeSupervisorDateColumns(dateColumns) {
    const seen = new Set();
    return dateColumns.filter((column) => {
      if (!column.date || seen.has(column.date)) return false;
      seen.add(column.date);
      return true;
    });
  }

  function parseSupervisorCell(value, isRed, supervisorName = '', date = '') {
    const text = String(value || '').trim();
    const warnings = [];
    const explicitRanges = parseSupervisorTimeRanges(text);
    const unavailableByText = /休|调休|请假|休假|年假|病假|事假/.test(text);
    const holidayRestByText = isHolidayActivityMarkerText(text);

    if (!text) {
      return { availableRanges: [], shiftCode: '', warnings };
    }
    if (holidayRestByText) {
      return { availableRanges: [], shiftCode: '', warnings };
    }
    if (isRed || unavailableByText) {
      const unavailableRanges = explicitRanges.length
        ? explicitRanges
        : [{ startMinutes: CONFIG.supervisorWindowStartMinutes, endMinutes: CONFIG.supervisorWindowEndMinutes }];
      return {
        availableRanges: invertSupervisorRanges(unavailableRanges),
        shiftCode: '',
        warnings
      };
    }

    const shiftCode = parseSupervisorShiftCode(text);
    if (shiftCode === 'N' || shiftCode === 'A') {
      return { availableRanges: [CONFIG.supervisorShiftWindows[shiftCode]], shiftCode, warnings };
    }
    if (shiftCode === 'F') {
      return {
        availableRanges: mergeMeetingIntervals([
          CONFIG.supervisorShiftWindows.N,
          CONFIG.supervisorShiftWindows.A
        ]),
        shiftCode,
        warnings
      };
    }
    if (explicitRanges.length) {
      return { availableRanges: explicitRanges, shiftCode: '', warnings };
    }

    warnings.push(`${text}，按休息处理`);
    return { availableRanges: [], shiftCode: '', warnings };
  }

  function parseSupervisorShiftCode(text) {
    const compact = String(text || '').trim().toUpperCase().replace(/\s+/g, '');
    if (/^N(?:查收)?$/.test(compact) || /早班?/.test(text)) return 'N';
    if (/^A(?:查收)?$/.test(compact) || /晚班?/.test(text)) return 'A';
    if (/^F(?:查收)?$/.test(compact) || /灵活/.test(text)) return 'F';
    return '';
  }

  function parseSupervisorTimeRanges(text) {
    const ranges = [];
    const pattern = /(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:-|－|–|—|~|～|至|到)\s*(\d{1,2})\s*[:：]\s*(\d{2})/g;
    let match;
    while ((match = pattern.exec(String(text || ''))) !== null) {
      const startMinutes = Number(match[1]) * 60 + Number(match[2]);
      const endMinutes = Number(match[3]) * 60 + Number(match[4]);
      const clipped = clipSupervisorRange(startMinutes, endMinutes);
      if (clipped) ranges.push(clipped);
    }
    return mergeMeetingIntervals(ranges);
  }

  function clipSupervisorRange(startMinutes, endMinutes, settings = null) {
    const windowStart = settings?.windowStartMinutes ?? CONFIG.supervisorWindowStartMinutes;
    const windowEnd = settings?.windowEndMinutes ?? CONFIG.supervisorWindowEndMinutes;
    const start = Math.max(windowStart, startMinutes);
    const end = Math.min(windowEnd, endMinutes);
    return end > start ? { startMinutes: start, endMinutes: end } : null;
  }

  function invertSupervisorRanges(ranges, settings = null) {
    const windowStart = settings?.windowStartMinutes ?? CONFIG.supervisorWindowStartMinutes;
    const windowEnd = settings?.windowEndMinutes ?? CONFIG.supervisorWindowEndMinutes;
    const normalized = mergeMeetingIntervals((ranges || []).map((range) => clipSupervisorRange(range.startMinutes, range.endMinutes, {
      windowStartMinutes: windowStart,
      windowEndMinutes: windowEnd
    })).filter(Boolean));
    return invertMeetingIntervals(normalized, {
      windowStartMinutes: windowStart,
      windowEndMinutes: windowEnd
    });
  }

  function applySupervisorWorkbook(workbook) {
    state.supervisorPlanner.workbookName = workbook.workbookName;
    state.supervisorPlanner.supervisors = workbook.supervisors;
    state.supervisorPlanner.dateColumns = workbook.dateColumns;
    state.supervisorPlanner.warnings = workbook.warnings;
    state.supervisorPlanner.selectedSupervisors = new Set(workbook.supervisors.map((supervisor) => supervisor.name));
    persistSupervisorWorkbookToStorage();
    setSupervisorDefaultDates();
    renderSupervisorPlanner();
    renderSupervisorMessage(workbook.warnings.length
      ? `已读取并保存表格，有 ${workbook.warnings.length} 条排班提醒，明细见下方。回到“排会议”页默认包含督导。`
      : '已读取并保存表格。回到“排会议”页默认包含督导。', {
      includeSupervisorWarnings: Boolean(workbook.warnings.length)
    });
  }

  function persistSupervisorWorkbookToStorage() {
    if (typeof localStorage === 'undefined') return;
    const data = {
      workbookName: state.supervisorPlanner.workbookName,
      dateColumns: state.supervisorPlanner.dateColumns,
      warnings: state.supervisorPlanner.warnings,
      supervisors: state.supervisorPlanner.supervisors.map((supervisor) => ({
        name: supervisor.name,
        rowIndex: supervisor.rowIndex,
        days: Array.from(supervisor.days.entries()),
        shiftCodes: Array.from(supervisor.shiftCodes.entries())
      }))
    };
    localStorage.setItem(SUPERVISOR_SCHEDULE_STORAGE_KEY, JSON.stringify(data));
  }

  function restoreSupervisorWorkbookFromStorage() {
    if (typeof localStorage === 'undefined') return false;
    if (state.supervisorPlanner.supervisors.length) return true;
    try {
      let raw = localStorage.getItem(SUPERVISOR_SCHEDULE_STORAGE_KEY);
      let shouldMigrateFromTestKey = false;
      if (!raw) {
        raw = localStorage.getItem(SUPERVISOR_TEST_SCHEDULE_STORAGE_KEY);
        shouldMigrateFromTestKey = Boolean(raw);
      }
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.supervisors) || !Array.isArray(data.dateColumns)) return false;
      state.supervisorPlanner.workbookName = data.workbookName || '';
      state.supervisorPlanner.dateColumns = data.dateColumns;
      state.supervisorPlanner.warnings = Array.isArray(data.warnings) ? data.warnings : [];
      state.supervisorPlanner.supervisors = data.supervisors.map((supervisor) => ({
        name: supervisor.name,
        rowIndex: Number(supervisor.rowIndex) || 0,
        days: new Map(supervisor.days || []),
        shiftCodes: new Map(supervisor.shiftCodes || [])
      })).filter((supervisor) => supervisor.name);
      state.supervisorPlanner.selectedSupervisors = new Set(state.supervisorPlanner.supervisors.map((supervisor) => supervisor.name));
      if (shouldMigrateFromTestKey) {
        localStorage.setItem(SUPERVISOR_SCHEDULE_STORAGE_KEY, raw);
      }
      return Boolean(state.supervisorPlanner.supervisors.length);
    } catch (error) {
      console.warn('[campus-commute-checker] 督导排班缓存读取失败，已忽略。', error);
      return false;
    }
  }

  function setSupervisorDefaultDates() {
    const dates = state.supervisorPlanner.dateColumns.map((column) => column.date).filter(Boolean).sort();
    const startInput = document.getElementById('ccheck-supervisor-start');
    const endInput = document.getElementById('ccheck-supervisor-end');
    if (startInput) startInput.value = dates[0] || '';
    if (endInput) endInput.value = dates[dates.length - 1] || '';
    const meetingStartInput = document.getElementById('ccheck-meeting-start');
    const meetingEndInput = document.getElementById('ccheck-meeting-end');
    if (meetingStartInput && !meetingStartInput.value) meetingStartInput.value = dates[0] || '';
    if (meetingEndInput && !meetingEndInput.value) meetingEndInput.value = dates[dates.length - 1] || '';
    updateMeetingDateRangeTrigger();
  }

  function renderSupervisorPlanner() {
    const list = document.getElementById('ccheck-supervisor-list');
    const meta = document.getElementById('ccheck-supervisor-meta');
    if (!list || !meta) return;
    const supervisors = state.supervisorPlanner.supervisors || [];
    if (!supervisors.length) {
      list.innerHTML = '<div class="ccheck-empty">上传督导 XLS/XLSX 后显示名单。</div>';
    } else {
      list.innerHTML = supervisors.map((supervisor) => {
        return `
          <div class="ccheck-teacher-option">
            <span title="${escapeHtml(supervisor.name)}">${escapeHtml(supervisor.name)}</span>
          </div>
        `;
      }).join('');
    }

    const dates = state.supervisorPlanner.dateColumns.map((column) => column.date).filter(Boolean).sort();
    meta.innerHTML = [
      state.supervisorPlanner.workbookName ? `<span class="ccheck-supervisor-pill">${escapeHtml(state.supervisorPlanner.workbookName)}</span>` : '',
      supervisors.length ? `<span class="ccheck-supervisor-pill">${supervisors.length} 位督导</span>` : '',
      dates.length ? `<span class="ccheck-supervisor-pill">${escapeHtml(dates[0])} 至 ${escapeHtml(dates[dates.length - 1])}</span>` : '',
      state.supervisorPlanner.warnings.length ? `<span class="ccheck-supervisor-pill">${state.supervisorPlanner.warnings.length} 条提醒</span>` : ''
    ].filter(Boolean).join('');
  }

  function updateSupervisorSelection(name, checked) {
    if (!name) return;
    if (checked) state.supervisorPlanner.selectedSupervisors.add(name);
    else state.supervisorPlanner.selectedSupervisors.delete(name);
  }

  function selectAllSupervisors() {
    state.supervisorPlanner.supervisors.forEach((supervisor) => state.supervisorPlanner.selectedSupervisors.add(supervisor.name));
    renderSupervisorPlanner();
    setStatus(state.supervisorPlanner.supervisors.length ? `已选择 ${state.supervisorPlanner.supervisors.length} 位督导。` : '请先上传督导 XLS/XLSX。');
  }

  function clearSupervisorSelection() {
    state.supervisorPlanner.selectedSupervisors.clear();
    renderSupervisorPlanner();
    renderSupervisorMessage('已清空督导选择。');
  }

  function findSupervisorSlots() {
    const selectedSupervisors = getSelectedSupervisorRecords();
    if (!selectedSupervisors.length) {
      renderSupervisorMessage('请先上传 XLS/XLSX 并勾选督导。');
      setStatus('督导共同时间需要先选择督导。');
      return;
    }
    const settings = readSupervisorPlannerSettings();
    if (!settings.dates.length) {
      renderSupervisorMessage('所选日期不在督导表范围内。');
      setStatus('督导共同时间没有可用日期。');
      return;
    }

    const participants = selectedSupervisors.map((supervisor) => supervisor.name);
    let plannerEvents = buildSupervisorPlannerEvents(selectedSupervisors, settings);
    const teacherMerge = readSupervisorTeacherMerge(settings);
    if (teacherMerge.enabled) {
      if (!teacherMerge.ok) {
        renderSupervisorMessage(teacherMerge.message);
        setStatus(teacherMerge.message);
        return;
      }
      settings.dates = settings.dates.filter((date) => teacherMerge.loadedDateSet.has(date));
      if (!settings.dates.length) {
        renderSupervisorMessage('督导日期和当前已加载老师课表日期没有交集。');
        setStatus('督导和老师没有共同可计算日期。');
        return;
      }
      participants.push(...teacherMerge.teachers);
      plannerEvents = plannerEvents.concat(buildMeetingPlannerEvents(state.lastEvents, settings));
    }

    const slots = mergeDisplayMeetingSlots(
      sortMeetingSlots(buildOnlineMeetingSlots(plannerEvents, participants, settings)),
      plannerEvents,
      participants,
      settings
    );
    renderSupervisorSlots(slots, selectedSupervisors, teacherMerge, settings);
    setStatus(slots.length ? `督导共同时间已找到 ${slots.length} 段。` : '没有找到督导共同时间。');
  }

  function getSelectedSupervisorRecords() {
    const selected = state.supervisorPlanner.selectedSupervisors;
    return (state.supervisorPlanner.supervisors || []).filter((supervisor) => selected.has(supervisor.name));
  }

  function readSupervisorPlannerSettings() {
    const allDates = state.supervisorPlanner.dateColumns.map((column) => column.date).filter(Boolean).sort();
    const loadedDateSet = new Set(allDates);
    const startInput = document.getElementById('ccheck-supervisor-start');
    const endInput = document.getElementById('ccheck-supervisor-end');
    let startDate = isIsoDate(startInput?.value) ? startInput.value : allDates[0];
    let endDate = isIsoDate(endInput?.value) ? endInput.value : allDates[allDates.length - 1];
    if (startDate && endDate && startDate > endDate) {
      const swap = startDate;
      startDate = endDate;
      endDate = swap;
    }
    const durationInput = document.getElementById('ccheck-supervisor-duration');
    const durationMinutes = roundToFive(clampNumber(
      Number(durationInput?.value),
      CONFIG.defaultMeetingDurationMinutes,
      5,
      240
    ));
    return {
      startDate,
      endDate,
      dates: startDate && endDate ? buildDateRange(startDate, endDate).filter((date) => loadedDateSet.has(date)) : [],
      durationMinutes,
      meetingMode: 'online',
      requestedMeetingMode: 'supervisor',
      includeEveningMeeting: true,
      windowStartMinutes: CONFIG.supervisorWindowStartMinutes,
      windowEndMinutes: CONFIG.supervisorWindowEndMinutes,
      excludedRanges: CONFIG.meetingExcludedRanges.slice()
    };
  }

  function buildSupervisorPlannerEvents(supervisors, settings) {
    return (supervisors || []).flatMap((supervisor) => (
      settings.dates.flatMap((date) => {
        const available = supervisor.days.get(date) || [];
        const unavailable = invertSupervisorRanges(available, settings);
        return unavailable.map((range, index) => ({
          key: `${supervisor.name}>>${date}>>supervisor-unavailable>>${index}`,
          teacher: supervisor.name,
          text: available.length ? '督导不可排' : '休息（督导表）',
          hex: '',
          type: 'supervisorUnavailable',
          campus: '督导不可排',
          colorMeaning: '督导不可排',
          date,
          dateLabel: date,
          dateIndex: -1,
          startMinutes: range.startMinutes,
          endMinutes: range.endMinutes,
          start: formatMinutes(range.startMinutes),
          end: formatMinutes(range.endMinutes),
          parentIndex: -1,
          rowIndex: supervisor.rowIndex,
          itemIndex: index,
          source: '督导表格'
        }));
      })
    ));
  }

  function readSupervisorTeacherMerge(settings) {
    const enabled = Boolean(document.getElementById('ccheck-supervisor-include-teachers')?.checked);
    if (!enabled) return { enabled: false, ok: true, teachers: [], loadedDateSet: new Set(settings.dates) };
    const teachers = Array.from(state.meetingPlanner.selectedTeachers || []).filter(Boolean);
    if (!teachers.length) {
      return {
        enabled,
        ok: false,
        message: '已开启合并老师课表，但“排会议”页没有已勾选老师。请先在排会议页扫描并勾选老师。'
      };
    }
    if (!Array.isArray(state.lastEvents) || !state.lastEvents.length) {
      return {
        enabled,
        ok: false,
        message: '已开启合并老师课表，但当前没有扫描结果。请先扫描老师课表。'
      };
    }
    return {
      enabled,
      ok: true,
      teachers,
      loadedDateSet: new Set(getLoadedMeetingDates(state.lastEvents))
    };
  }

  function renderSupervisorSlots(slots, supervisors, teacherMerge, settings) {
    const result = document.getElementById('ccheck-supervisor-results');
    if (!result) return;
    const warningItems = collectSupervisorDisplayWarnings(settings);
    const teacherText = teacherMerge.enabled ? `；合并老师：${teacherMerge.teachers.join('、')}` : '';
    const warningHtml = warningItems.length
      ? `<div class="ccheck-unknown">${warningItems.map((item) => `<div>${escapeHtml(item)}</div>`).join('')}${state.supervisorPlanner.warnings.length > warningItems.length ? '<div>还有更多提醒未显示。</div>' : ''}</div>`
      : '';
    if (!slots.length) {
      result.innerHTML = `${warningHtml}<div class="ccheck-empty">没有找到可排时间。</div>`;
      return;
    }
    result.innerHTML = `
      <span class="ccheck-muted">找到 ${slots.length} 段可排时间。督导：${escapeHtml(supervisors.map((item) => item.name).join('、'))}${escapeHtml(teacherText)}</span>
      ${warningHtml}
      ${slots.map((slot) => `
        <div class="ccheck-slot-card">
          <div class="ccheck-slot-title">
            <span>${escapeHtml(slot.date)}</span>
            <span>${formatMinutes(slot.startMinutes)}-${formatMinutes(slot.endMinutes)}</span>
          </div>
          <small class="ccheck-muted">${escapeHtml(formatSupervisorSlotNote(slot, supervisors))}</small>
        </div>
      `).join('')}
    `;
  }

  function collectSupervisorDisplayWarnings(settings) {
    const dateSet = new Set(settings.dates || []);
    return (state.supervisorPlanner.warnings || [])
      .filter((warning) => !dateSet.size || Array.from(dateSet).some((date) => warning.includes(date)))
      .map((warning) => compactSupervisorWarningText(warning))
      .slice(0, 12);
  }

  function formatSupervisorSlotNote(slot, supervisors) {
    const flexNames = (supervisors || [])
      .filter((supervisor) => supervisor.shiftCodes.get(slot.date) === 'F')
      .map((supervisor) => supervisor.name);
    if (!flexNames.length) return '督导共同可排';
    return `${flexNames.join('、')} 为 F，可按所选具体时间自动适配 N 或 A`;
  }

  function renderSupervisorWarningDetails(warnings = state.supervisorPlanner.warnings, limit = 40) {
    const items = (Array.isArray(warnings) ? warnings : [])
      .map((warning) => String(warning || '').trim())
      .map((warning) => compactSupervisorWarningText(warning))
      .filter(Boolean);
    if (!items.length) return '';
    const visibleItems = items.slice(0, limit);
    const hiddenCount = items.length - visibleItems.length;
    return `
      <div class="ccheck-unknown ccheck-supervisor-warning-list">
        <strong>提醒明细</strong>
        ${visibleItems.map((warning, index) => `<div>${index + 1}. ${escapeHtml(warning)}</div>`).join('')}
        ${hiddenCount > 0 ? `<div>还有 ${hiddenCount} 条未显示。</div>` : ''}
      </div>
    `;
  }

  function formatSupervisorWarningText(name, date, reason) {
    const left = [name, date]
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .join(' ');
    const right = formatSupervisorWarningReason(reason);
    return right ? `${left}：${right}` : left;
  }

  function formatSupervisorWarningReason(reason) {
    const text = String(reason || '').trim();
    if (!text) return '';
    const unknown = text.match(/^未识别[“"](.+?)[”"]，已按不可排处理$/);
    if (unknown) return `${unknown[1]}，按休息处理`;
    const unavailable = text.match(/^(.+?)，已按不可排处理$/);
    if (unavailable) return `${unavailable[1]}，按休息处理`;
    return text;
  }

  function compactSupervisorWarningText(warning) {
    const text = String(warning || '').trim();
    if (!text) return '';
    const oldFormat = text.match(/^第\s*\d+\s*行\s+(.+?)\s+(\d{4}-\d{2}-\d{2})[：:]\s*(.+)$/);
    if (oldFormat) {
      return formatSupervisorWarningText(oldFormat[1], oldFormat[2], oldFormat[3]);
    }
    const currentFormat = text.match(/^(.+?)\s+(\d{4}-\d{2}-\d{2})[：:]\s*(.+)$/);
    if (currentFormat) {
      return formatSupervisorWarningText(currentFormat[1], currentFormat[2], currentFormat[3]);
    }
    return text;
  }

  function renderSupervisorMessage(message, options = {}) {
    const result = document.getElementById('ccheck-supervisor-results');
    if (!result) return;
    const warningHtml = options.includeSupervisorWarnings
      ? renderSupervisorWarningDetails(undefined, options.warningLimit || 40)
      : '';
    result.innerHTML = `<div class="ccheck-empty">${escapeHtml(message)}</div>${warningHtml}`;
  }

  function setMeetingDefaultDates(events, options = {}) {
    const dates = getLoadedMeetingDates(events);
    if (!dates.length) return;
    const startInput = document.getElementById('ccheck-meeting-start');
    const endInput = document.getElementById('ccheck-meeting-end');
    if (startInput && (options.resetMeetingDates || !startInput.value)) startInput.value = dates[0];
    if (endInput && (options.resetMeetingDates || !endInput.value)) endInput.value = dates[dates.length - 1];
    updateMeetingDateRangeTrigger();
  }

  function clearMeetingDateInputs() {
    const startInput = document.getElementById('ccheck-meeting-start');
    const endInput = document.getElementById('ccheck-meeting-end');
    if (startInput) startInput.value = '';
    if (endInput) endInput.value = '';
    updateMeetingDateRangeTrigger();
  }

  function updateMeetingTeacherSelection(teacher, checked) {
    if (!teacher) return;
    if (checked) {
      state.meetingPlanner.selectedTeachers.add(teacher);
    } else {
      state.meetingPlanner.selectedTeachers.delete(teacher);
    }
    syncMeetingTeacherQueryFromSelection();
  }

  function selectAllMeetingTeachers() {
    const boxes = Array.from(document.querySelectorAll('#ccheck-meeting-teachers input[data-meeting-teacher]'));
    boxes.forEach((checkbox) => {
      checkbox.checked = true;
      state.meetingPlanner.selectedTeachers.add(checkbox.value);
    });
    syncMeetingTeacherQueryFromSelection();
    setStatus(boxes.length ? `已选择 ${boxes.length} 位老师。` : '请先扫描课表，再选择老师。');
  }

  function clearMeetingTeacherSelection() {
    state.meetingPlanner.selectedTeachers.clear();
    document.querySelectorAll('#ccheck-meeting-teachers input[data-meeting-teacher]').forEach((checkbox) => {
      checkbox.checked = false;
    });
    syncMeetingTeacherQueryFromSelection();
    renderMeetingMessage('已清空老师选择。');
  }

  function syncMeetingTeacherQueryFromSelection() {
    const input = document.getElementById('ccheck-meeting-teacher-query');
    if (!input) return;
    input.value = Array.from(state.meetingPlanner.selectedTeachers).filter(Boolean).join(' ');
  }

  async function queryMeetingSlotsByName() {
    const nameInput = document.getElementById('ccheck-meeting-teacher-query');
    const requestedParticipants = parsePastedTeacherNames(nameInput?.value || '');
    if (!requestedParticipants.length) {
      renderMeetingMessage('请输入参会人姓名，可用顿号、逗号、空格或换行分隔。');
      setStatus('快速查询需要先输入参会人姓名。');
      return;
    }
    if (nameInput) nameInput.value = requestedParticipants.join(' ');

    const dateRange = readMeetingDateRangeForSystemSearch();
    if (!dateRange) {
      renderMeetingMessage('请先选择开始日期和结束日期。');
      setStatus('快速查询需要先选择日期范围。');
      return;
    }

    const includeSupervisors = isMeetingSupervisorIncluded();
    const supervisorPrecheck = includeSupervisors
      ? readMeetingSupervisorParticipantsFromNames(requestedParticipants, null, {
        allowWithoutSupervisorWorkbook: true,
        allowWithoutSupervisorMatch: true
      })
      : { ok: true, supervisors: [], teacherNames: requestedParticipants };
    if (!supervisorPrecheck.ok) {
      renderMeetingMessage(supervisorPrecheck.message);
      setStatus(supervisorPrecheck.message);
      return;
    }
    let systemSearchParticipants = requestedParticipants;
    if (nameInput) nameInput.value = systemSearchParticipants.join(' ');

    renderMeetingMessage('正在同步系统筛选栏并搜索课表，完成后会继续查询共同空档。');
    setStatus(`正在选择参会人并搜索课表：${systemSearchParticipants.join('、')}。`);
    let searchResult = await applyScheduleSearchFiltersAndSearch(systemSearchParticipants, dateRange);
    if (!searchResult.ok && includeSupervisors && supervisorPrecheck.supervisors.length) {
      const resolvedParticipants = supervisorPrecheck.resolvedNames || requestedParticipants;
      if (!areMeetingNameListsEqual(resolvedParticipants, systemSearchParticipants)) {
        systemSearchParticipants = resolvedParticipants;
        if (nameInput) nameInput.value = systemSearchParticipants.join(' ');
        renderMeetingMessage('正在用督导完整姓名重试系统筛选栏。');
        setStatus(`正在用督导完整姓名重试：${systemSearchParticipants.join('、')}。`);
        searchResult = await applyScheduleSearchFiltersAndSearch(systemSearchParticipants, dateRange);
      }
    }
    if (!searchResult.ok) {
      renderMeetingMessage(searchResult.message);
      setStatus(searchResult.message);
      return;
    }

    await scanAll();
    const events = Array.isArray(state.lastEvents) ? state.lastEvents : [];
    const selectedSearchParticipants = searchResult.selected.length ? searchResult.selected : systemSearchParticipants;
    const supervisorMerge = includeSupervisors
      ? readMeetingSupervisorParticipantsFromNames(selectedSearchParticipants, null, {
        allowWithoutSupervisorWorkbook: true,
        allowWithoutSupervisorMatch: true
      })
      : { ok: true, supervisors: [], teacherNames: selectedSearchParticipants, resolvedNames: selectedSearchParticipants };
    if (!supervisorMerge.ok) {
      renderMeetingMessage(supervisorMerge.message);
      setStatus(supervisorMerge.message);
      return;
    }
    if (!events.length && !supervisorMerge.supervisors.length) {
      renderMeetingMessage('系统搜索后仍没有扫描结果，请确认参会人和日期范围内有课表数据。');
      setStatus('快速查询没有可用课表数据。');
      return;
    }

    const teacherNames = includeSupervisors ? supervisorMerge.teacherNames : selectedSearchParticipants;
    const availableTeachers = getMeetingTeachers(events);
    const matchResult = matchMeetingTeachers(teacherNames, availableTeachers);
    const displaySelections = buildMeetingDisplaySelectionNames(selectedSearchParticipants, availableTeachers, supervisorMerge, matchResult);
    selectOnlyMeetingTeachers(displaySelections);
    if (nameInput && displaySelections.length) nameInput.value = displaySelections.join(' ');

    if (matchResult.missed.length) {
      const matchedText = matchResult.matched.length ? `已选中：${matchResult.matched.join('、')}；` : '';
      renderMeetingMessage(`${matchedText}未匹配到：${matchResult.missed.join('、')}。请输入能唯一对应全名的至少两个字，或先加载对应参会人课表后再扫描。`);
      setStatus(`快速查询未匹配到 ${matchResult.missed.length} 位老师。`);
      return;
    }

    const supervisorText = supervisorMerge.supervisors.length
      ? `，自动识别督导：${supervisorMerge.supervisors.map((supervisor) => supervisor.name).join('、')}`
      : '';
    setStatus(`已在系统筛选栏选中 ${searchResult.selected.length} 位参会人；列表勾选 ${displaySelections.length} 位${supervisorText}，正在自动点击“查找空档”。`);
    clickMeetingFindButton({ skipSystemDateSearch: true });
  }

  function readMeetingDateRangeForSystemSearch() {
    const startInput = document.getElementById('ccheck-meeting-start');
    const endInput = document.getElementById('ccheck-meeting-end');
    let startDate = isIsoDate(startInput?.value) ? startInput.value : '';
    let endDate = isIsoDate(endInput?.value) ? endInput.value : '';
    if (!startDate || !endDate) return null;
    if (startDate > endDate) {
      const swap = startDate;
      startDate = endDate;
      endDate = swap;
    }
    return { startDate, endDate };
  }

  function toggleMeetingDateRangePicker() {
    const picker = document.getElementById('ccheck-meeting-date-picker');
    if (!picker) return;
    if (!picker.hidden) {
      closeMeetingDateRangePicker();
      return;
    }
    const dateRange = readMeetingDateRangeForSystemSearch();
    const anchorDate = dateRange?.startDate || dateRange?.endDate || formatDateInput(new Date());
    picker.dataset.cursorMonth = anchorDate.slice(0, 7);
    picker.dataset.pendingStart = '';
    picker.dataset.selectingEnd = 'false';
    renderMeetingDateRangePicker();
    picker.hidden = false;
  }

  function closeMeetingDateRangePicker() {
    const picker = document.getElementById('ccheck-meeting-date-picker');
    if (picker) picker.hidden = true;
  }

  function clearMeetingDateRangePicker() {
    clearMeetingDateInputs();
    const picker = document.getElementById('ccheck-meeting-date-picker');
    if (picker) {
      picker.dataset.pendingStart = '';
      picker.dataset.selectingEnd = 'false';
      renderMeetingDateRangePicker();
    }
  }

  function moveMeetingDatePickerMonth(offset) {
    const picker = document.getElementById('ccheck-meeting-date-picker');
    if (!picker) return;
    const cursorMonth = parseMeetingPickerMonth(picker.dataset.cursorMonth) || new Date();
    cursorMonth.setMonth(cursorMonth.getMonth() + offset);
    picker.dataset.cursorMonth = `${cursorMonth.getFullYear()}-${String(cursorMonth.getMonth() + 1).padStart(2, '0')}`;
    renderMeetingDateRangePicker();
  }

  function pickMeetingDate(dateText) {
    if (!isIsoDate(dateText)) return;
    const picker = document.getElementById('ccheck-meeting-date-picker');
    if (!picker) return;
    const startInput = document.getElementById('ccheck-meeting-start');
    const endInput = document.getElementById('ccheck-meeting-end');
    const pendingStart = isIsoDate(picker.dataset.pendingStart) ? picker.dataset.pendingStart : '';
    const selectingEnd = picker.dataset.selectingEnd === 'true';
    if (!selectingEnd || !pendingStart) {
      picker.dataset.pendingStart = dateText;
      picker.dataset.selectingEnd = 'true';
      if (startInput) startInput.value = dateText;
      if (endInput) endInput.value = '';
      updateMeetingDateRangeTrigger();
      renderMeetingDateRangePicker();
      return;
    }

    let startDate = pendingStart;
    let endDate = dateText;
    if (startDate > endDate) {
      const swap = startDate;
      startDate = endDate;
      endDate = swap;
    }
    if (startInput) startInput.value = startDate;
    if (endInput) endInput.value = endDate;
    picker.dataset.pendingStart = '';
    picker.dataset.selectingEnd = 'false';
    updateMeetingDateRangeTrigger();
    renderMeetingDateRangePicker();
    closeMeetingDateRangePicker();
  }

  function updateMeetingDateRangeTrigger() {
    const trigger = document.querySelector('#ccheck-panel button[data-action="meeting-date-range"]');
    if (!trigger) return;
    const startInput = document.getElementById('ccheck-meeting-start');
    const endInput = document.getElementById('ccheck-meeting-end');
    const startDate = isIsoDate(startInput?.value) ? startInput.value : '';
    const endDate = isIsoDate(endInput?.value) ? endInput.value : '';
    if (!startDate && !endDate) {
      trigger.textContent = '选择日期范围';
      trigger.dataset.empty = 'true';
      return;
    }
    trigger.textContent = startDate && endDate
      ? `${formatShortDate(startDate)} 至 ${formatShortDate(endDate)}`
      : `${formatShortDate(startDate || endDate)} 至 ...`;
    trigger.dataset.empty = 'false';
  }

  function renderMeetingDateRangePicker() {
    const picker = document.getElementById('ccheck-meeting-date-picker');
    if (!picker) return;
    const cursor = parseMeetingPickerMonth(picker.dataset.cursorMonth) || new Date();
    const year = cursor.getFullYear();
    const month = cursor.getMonth() + 1;
    const daysInMonth = new Date(year, month, 0).getDate();
    const firstDay = new Date(year, month - 1, 1).getDay();
    const dateRange = readMeetingDateRangeForSystemSearch();
    const pendingStart = isIsoDate(picker.dataset.pendingStart) ? picker.dataset.pendingStart : '';
    const selectingEnd = picker.dataset.selectingEnd === 'true';
    const activeStart = selectingEnd ? pendingStart : dateRange?.startDate || '';
    const activeEnd = selectingEnd ? '' : dateRange?.endDate || '';
    const cells = [];
    for (let index = 0; index < firstDay; index += 1) {
      cells.push('<button class="ccheck-date-day is-empty" type="button" tabindex="-1"></button>');
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      const dateText = makeDateInput(year, month, day);
      const inRange = activeStart && activeEnd && dateText > activeStart && dateText < activeEnd;
      const selected = dateText === activeStart || dateText === activeEnd;
      cells.push(`<button class="ccheck-date-day${selected ? ' is-selected' : ''}${inRange ? ' is-in-range' : ''}" type="button" data-action="meeting-date-pick" data-date="${dateText}">${day}</button>`);
    }
    picker.innerHTML = `
      <div class="ccheck-date-picker-head">
        <button class="ccheck-date-picker-nav" type="button" data-action="meeting-date-prev-year">‹‹</button>
        <button class="ccheck-date-picker-nav" type="button" data-action="meeting-date-prev">‹</button>
        <div class="ccheck-date-picker-title">${year}年${month}月</div>
        <button class="ccheck-date-picker-nav" type="button" data-action="meeting-date-next">›</button>
        <button class="ccheck-date-picker-nav" type="button" data-action="meeting-date-next-year">››</button>
      </div>
      <div class="ccheck-date-picker-hint">${selectingEnd && pendingStart ? `已选开始：${formatShortDate(pendingStart)}，请再点结束日期` : '先点开始日期，再点结束日期'}</div>
      <div class="ccheck-date-grid">
        ${['日', '一', '二', '三', '四', '五', '六'].map((item) => `<div class="ccheck-date-weekday">${item}</div>`).join('')}
        ${cells.join('')}
      </div>
      <div class="ccheck-date-picker-foot">
        <button class="ccheck-btn" type="button" data-action="meeting-date-clear">清空</button>
        <button class="ccheck-btn" type="button" data-action="meeting-date-close">关闭</button>
      </div>
    `;
  }

  function parseMeetingPickerMonth(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, 1);
  }

  async function applyScheduleSearchFiltersAndSearch(teachers, dateRange) {
    const dateOk = await setScheduleDateFilters(dateRange);
    if (!dateOk) {
      return { ok: false, message: '没有真正选中页面顶部的开始日期/结束日期，请手动点开系统日期范围确认后再试。' };
    }

    const teacherResult = await selectScheduleTeachersByName(teachers);
    if (!teacherResult.selected.length) {
      return {
        ok: false,
        message: `没有在系统教师下拉里选中：${teacherResult.missed.join('、')}。请确认姓名完整，或先在顶部教师框手动确认能搜到。`
      };
    }
    if (teacherResult.missed.length) {
      return {
        ok: false,
        message: `已选中：${teacherResult.selected.join('、')}；未选中：${teacherResult.missed.join('、')}。请核对姓名后再查询。`
      };
    }
    closeScheduleTeacherDropdown();

    const button = findScheduleSearchButton();
    if (!button) {
      return { ok: false, message: '没有找到页面顶部的“搜索”按钮。' };
    }

    const previousReceivedAt = state.latestDiagramData?.receivedAt || '';
    clickElementLikeUser(button);
    setStatus('已点击系统搜索，正在等待课表数据返回。');
    await waitForScheduleDiagramData(previousReceivedAt, 8000);
    await sleep(450);
    return { ok: true, selected: teacherResult.selected };
  }

  async function applyScheduleDateFiltersAndSearch(dateRange) {
    const dateOk = await setScheduleDateFilters(dateRange);
    if (!dateOk) {
      return { ok: false, message: '没有真正选中页面顶部的开始日期/结束日期，请手动点开系统日期范围确认后再试。' };
    }

    const button = findScheduleSearchButton();
    if (!button) {
      return { ok: false, message: '没有找到页面顶部的“搜索”按钮。' };
    }

    closeScheduleTeacherDropdown();
    const previousReceivedAt = state.latestDiagramData?.receivedAt || '';
    clickElementLikeUser(button);
    setStatus('已点击系统搜索，正在等待课表数据返回。');
    await waitForScheduleDiagramData(previousReceivedAt, 8000);
    await sleep(450);
    return { ok: true };
  }

  async function setScheduleDateFilters(dateRange) {
    const startInput = findScheduleDateInput('开始日期');
    const endInput = findScheduleDateInput('结束日期');
    if (!startInput || !endInput) return false;

    const picked = await selectScheduleDateRangeInPicker(dateRange, startInput, endInput);
    if (picked) return true;

    setNativeInputValue(startInput, dateRange.startDate, { blur: true });
    setNativeInputValue(endInput, dateRange.endDate, { blur: true });
    return startInput.value === dateRange.startDate && endInput.value === dateRange.endDate;
  }

  function findScheduleDateInput(placeholder) {
    return Array.from(document.querySelectorAll('input'))
      .filter((input) => !isCcheckFloatingElement(input))
      .find((input) => input.placeholder === placeholder)
      || null;
  }

  async function selectScheduleDateRangeInPicker(dateRange, startInput, endInput) {
    const control = findScheduleDateRangeControl(startInput, endInput);
    if (!control) return false;

    clickElementLikeUser(startInput);
    clickElementLikeUser(control);
    let panel = await waitForScheduleDatePanel(1800);
    if (!panel) return false;

    if (!await selectScheduleDateInOpenPanel(dateRange.startDate)) return false;
    await sleep(180);

    panel = await waitForScheduleDatePanel(1800);
    if (!panel) {
      clickElementLikeUser(startInput);
      panel = await waitForScheduleDatePanel(1800);
      if (!panel) return false;
    }

    if (!await selectScheduleDateInOpenPanel(dateRange.endDate)) return false;
    await sleep(220);
    sendKey(endInput || startInput, 'Escape');
    startInput.dispatchEvent(new Event('blur', { bubbles: true }));
    endInput.dispatchEvent(new Event('blur', { bubbles: true }));
    return waitForScheduleDateInputs(dateRange, startInput, endInput, 1200);
  }

  function findScheduleDateRangeControl(startInput, endInput) {
    return startInput?.closest?.('.el-date-editor.el-range-editor, .el-date-editor')
      || endInput?.closest?.('.el-date-editor.el-range-editor, .el-date-editor')
      || startInput?.parentElement
      || null;
  }

  async function waitForScheduleDatePanel(timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const panel = findVisibleScheduleDatePanel();
      if (panel) return panel;
      await sleep(80);
    }
    return null;
  }

  function findVisibleScheduleDatePanel() {
    return Array.from(document.querySelectorAll('.el-date-range-picker, .el-date-picker, .el-picker-panel'))
      .filter((panel) => !isCcheckFloatingElement(panel))
      .filter((panel) => isVisibleElement(panel))
      .find((panel) => panel.querySelector('td.available, td:not(.disabled)'))
      || null;
  }

  async function selectScheduleDateInOpenPanel(dateText) {
    if (!isIsoDate(dateText)) return false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      let panel = await waitForScheduleDatePanel(800);
      if (!panel) return false;

      const cell = findScheduleDateCell(panel, dateText);
      if (cell) {
        gentlyRevealElement(cell);
        clickElementLikeUser(cell.querySelector('div, span') || cell);
        return true;
      }

      const moved = moveScheduleDatePanelToward(panel, dateText);
      if (!moved) return false;
      await sleep(160);
    }
    return false;
  }

  function moveScheduleDatePanelToward(panel, dateText) {
    const targetSerial = getDateMonthSerial(dateText);
    const sections = getScheduleDatePanelSections(panel);
    if (!Number.isFinite(targetSerial) || !sections.length) return false;
    const minSerial = Math.min(...sections.map((section) => section.serial));
    const maxSerial = Math.max(...sections.map((section) => section.serial));
    if (targetSerial < minSerial) return clickScheduleDatePanelNav(panel, 'prev');
    if (targetSerial > maxSerial) return clickScheduleDatePanelNav(panel, 'next');
    return false;
  }

  function clickScheduleDatePanelNav(panel, direction) {
    const selector = direction === 'prev' ? '.el-icon-arrow-left' : '.el-icon-arrow-right';
    const button = Array.from(panel.querySelectorAll(`button${selector}, .${selector.replace(/^\./, '')}`))
      .filter((item) => isVisibleElement(item))
      .find((item) => !item.disabled);
    if (!button) return false;
    clickElementLikeUser(button);
    return true;
  }

  function findScheduleDateCell(panel, dateText) {
    const parts = parseIsoDateParts(dateText);
    if (!parts) return null;
    const targetSerial = parts.year * 12 + parts.month - 1;
    const section = getScheduleDatePanelSections(panel).find((item) => item.serial === targetSerial);
    if (!section) return null;
    return Array.from(section.content.querySelectorAll('td'))
      .filter((cell) => isVisibleElement(cell))
      .filter((cell) => !/\bdisabled\b|\bprev-month\b|\bnext-month\b/.test(cell.className))
      .find((cell) => Number(textOf(cell).replace(/\D/g, '')) === parts.day)
      || null;
  }

  function getScheduleDatePanelSections(panel) {
    return Array.from(panel.querySelectorAll('.el-date-range-picker__content, .el-date-picker__header'))
      .map((element) => {
        const content = element.classList.contains('el-date-range-picker__content') ? element : element.closest('.el-picker-panel__content');
        const header = element.querySelector?.('.el-date-range-picker__header') || element;
        const match = textOf(header).match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
        if (!content || !match) return null;
        const year = Number(match[1]);
        const month = Number(match[2]);
        return { content, year, month, serial: year * 12 + month - 1 };
      })
      .filter(Boolean);
  }

  function getDateMonthSerial(dateText) {
    const parts = parseIsoDateParts(dateText);
    return parts ? parts.year * 12 + parts.month - 1 : NaN;
  }

  async function waitForScheduleDateInputs(dateRange, startInput, endInput, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      if (startInput.value === dateRange.startDate && endInput.value === dateRange.endDate) return true;
      await sleep(80);
    }
    return startInput.value === dateRange.startDate && endInput.value === dateRange.endDate;
  }

  async function selectScheduleTeachersByName(teachers) {
    const selected = [];
    const missed = [];
    const firstInput = findScheduleTeacherInput();
    if (!firstInput) return { selected, missed: teachers.slice() };

    await clearScheduleTeacherInput(firstInput);
    for (const teacher of teachers) {
      const input = findScheduleTeacherInput();
      if (!input) {
        missed.push(teacher);
        continue;
      }
      const result = await selectScheduleTeacherOption(input, teacher, selected.length + 1);
      if (result.ok) selected.push(result.name || teacher);
      else missed.push(teacher);
      closeScheduleTeacherDropdown();
      await sleep(750);
    }
    return { selected, missed };
  }

  function findScheduleTeacherInput() {
    const inputs = Array.from(document.querySelectorAll('input'))
      .filter((input) => !isCcheckFloatingElement(input))
      .filter((input) => isVisibleElement(input))
      .filter((input) => input.placeholder === '请选择' || input.closest('.el-select, .el-cascader'));
    return inputs.find((input) => isScheduleTeacherControl(input))
      || inputs[0]
      || null;
  }

  function isScheduleTeacherControl(input) {
    const rect = input.getBoundingClientRect();
    const label = Array.from(document.querySelectorAll('label, span, div'))
      .filter((element) => !isCcheckFloatingElement(element))
      .filter((element) => isVisibleElement(element))
      .find((element) => {
        if (textOf(element) !== '教师') return false;
        const labelRect = element.getBoundingClientRect();
        return Math.abs(labelRect.top - rect.top) < 24 && labelRect.right <= rect.left + 12;
      });
    return Boolean(label);
  }

  async function clearScheduleTeacherInput(input) {
    const control = input.closest('.el-select, .el-cascader') || input.parentElement;
    clearScheduleTeacherVueSelection(control, input);
    const clearButtons = Array.from(control?.querySelectorAll?.('.el-icon-circle-close, .el-tag__close, [class*="close"]') || [])
      .filter((element) => isVisibleElement(element));
    clearButtons.forEach((button) => clickElementLikeUser(button));
    setNativeInputValue(input, '');
    await sleep(180);
  }

  function clearScheduleTeacherVueSelection(control, input) {
    collectVueComponents(control, input)
      .filter(Boolean)
      .forEach((component) => {
        safeCall(() => {
          if (Array.isArray(component.value)) component.value = [];
          if (Array.isArray(component.selected)) component.selected = [];
          if (Array.isArray(component.selectedLabel)) component.selectedLabel = [];
          if (Array.isArray(component.selectedLabels)) component.selectedLabels = [];
          component.$emit?.('input', []);
          component.$emit?.('change', []);
          component.handleInput?.([]);
          component.handleChange?.([]);
          component.deleteSelected?.();
          component.$forceUpdate?.();
        });
      });
  }

  async function selectScheduleTeacherOption(input, teacher, minSelectedCount = 1) {
    const selectedCountBefore = getScheduleTeacherSelectedCount(input.closest('.el-select, .el-cascader') || input.parentElement || input);
    input.focus({ preventScroll: true });
    input.click();
    await sleep(260);
    setNativeInputValue(input, '');
    await sleep(260);
    setNativeInputValue(input, teacher);
    await sleep(Math.max(650, CONFIG.meetingAttendeeSearchSettleMs));

    const option = await waitForScheduleTeacherOption(input, teacher, CONFIG.meetingAttendeeDropdownTimeoutMs);
    if (!option) {
      sendKey(input, 'Escape');
      return { ok: false, name: teacher };
    }
    const selectedName = extractScheduleOptionTeacherName(option, teacher);

    gentlyRevealElement(option);
    await sleep(80);
    const clickTarget = getScheduleOptionClickTarget(option);
    clickElementLikeUser(clickTarget, getAttendeeOptionClickPoint(option, teacher));
    safeCall(() => clickTarget.click?.());
    safeCall(() => option.click?.());
    if (await waitForScheduleTeacherSelected(input, selectedName, 2200, Math.max(minSelectedCount, selectedCountBefore + 1))) {
      return { ok: true, name: selectedName };
    }

    input.focus?.({ preventScroll: true });
    sendKey(input, 'ArrowDown');
    await sleep(100);
    sendKey(input, 'Enter');
    if (await waitForScheduleTeacherSelected(input, selectedName, 1600, Math.max(minSelectedCount, selectedCountBefore + 1))) {
      return { ok: true, name: selectedName };
    }
    safeCall(() => option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })));
    return {
      ok: await waitForScheduleTeacherSelected(input, selectedName, 2200, Math.max(minSelectedCount, selectedCountBefore + 1)),
      name: selectedName
    };
  }

  async function waitForScheduleTeacherOption(input, teacher, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const option = findScheduleTeacherOption(input, teacher);
      if (option) return option;
      await sleep(120);
    }
    return null;
  }

  function findScheduleTeacherOption(input, teacher) {
    const expected = normalizeMeetingTeacherName(teacher);
    const anchorRect = input.getBoundingClientRect();
    const panels = findAttendeeDropdownPanels(anchorRect);
    for (const panel of panels) {
      const option = findMatchingAttendeeOptionInPanel(panel, expected);
      if (option) return option;
    }
    return null;
  }

  function extractScheduleOptionTeacherName(option, fallback) {
    const texts = [];
    collectMeetingAttendeeTextValues(option?.__vue__?.label, texts);
    collectMeetingAttendeeTextValues(option?.__vue__?.value, texts);
    collectMeetingAttendeeTextValues(option?.__vue__?.item, texts);
    collectMeetingAttendeeTextValues(option?.__vue__?.option, texts);
    [option?.getAttribute?.('title'), option?.getAttribute?.('aria-label'), textOf(option)].forEach((text) => {
      if (text) texts.push(text);
    });
    const fallbackKey = normalizeMeetingTeacherName(fallback);
    const candidate = texts
      .map((text) => String(text || '').replace(/[×√]/g, ' ').trim())
      .flatMap((text) => [text].concat(text.split(/[\s,，、;；|/\\]+/)))
      .map((text) => text.trim())
      .filter(Boolean)
      .sort((a, b) => scheduleOptionNameScore(b, fallbackKey) - scheduleOptionNameScore(a, fallbackKey))
      .find((text) => {
        const key = normalizeMeetingTeacherName(text);
        return key === fallbackKey || (fallbackKey.length >= 2 && key.includes(fallbackKey));
      });
    return candidate || fallback;
  }

  function scheduleOptionNameScore(text, fallbackKey) {
    const key = normalizeMeetingTeacherName(text);
    const base = attendeeOptionScore(key, fallbackKey);
    const lengthBonus = Math.max(0, 20 - Math.abs(key.length - Math.max(fallbackKey.length, 3)));
    return base * 100 + lengthBonus;
  }

  function getScheduleOptionClickTarget(option) {
    return option.closest?.('.el-select-dropdown__item, .el-cascader-node, [role="option"], li') || option;
  }

  async function waitForScheduleTeacherSelected(input, teacher, timeoutMs, minSelectedCount = 1) {
    const expected = normalizeMeetingTeacherName(teacher);
    const control = input.closest('.el-select, .el-cascader') || input.parentElement || input;
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      if (getScheduleTeacherSelectedCount(control) >= minSelectedCount) return true;
      if (isScheduleTeacherSelectedInVue(control, teacher)) return true;
      const text = normalizeName(textOf(control));
      if (text.includes(expected)) return true;
      await sleep(120);
    }
    return false;
  }

  function getScheduleTeacherSelectedCount(control) {
    const text = textOf(control);
    const plusMatch = text.match(/\+\s*(\d+)/);
    const plusCount = plusMatch ? Number(plusMatch[1]) : 0;
    const visibleTagTexts = Array.from(control?.querySelectorAll?.('.el-tag') || [])
      .map(textOf)
      .map((item) => item.replace(/×/g, '').trim())
      .filter(Boolean)
      .filter((item) => !/^\+\s*\d+$/.test(item));
    return visibleTagTexts.length + plusCount;
  }

  function isScheduleTeacherSelectedInVue(control, teacher) {
    const expected = normalizeMeetingTeacherName(teacher);
    const values = [];
    collectVueComponents(control)
      .filter(Boolean)
      .forEach((component) => {
        collectMeetingAttendeeTextValues(component?.value, values);
        collectMeetingAttendeeTextValues(component?.selected, values);
        collectMeetingAttendeeTextValues(component?.selectedLabel, values);
        collectMeetingAttendeeTextValues(component?.selectedLabels, values);
      });
    return values.some((value) => normalizeMeetingTeacherName(value).includes(expected));
  }

  function findScheduleSearchButton() {
    return Array.from(document.querySelectorAll('button'))
      .filter((button) => !isCcheckFloatingElement(button))
      .filter((button) => isVisibleElement(button))
      .find((button) => /搜索/.test(textOf(button)))
      || null;
  }

  function closeScheduleTeacherDropdown() {
    const input = findScheduleTeacherInput();
    const activeElement = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    const targets = Array.from(new Set([input, activeElement].filter(Boolean)));
    targets.forEach((target) => {
      sendKey(target, 'Escape');
      safeCall(() => target.blur?.());
    });
    const roots = targets
      .map((target) => target.closest?.('.el-select, .el-cascader') || target.parentElement || target)
      .filter(Boolean);
    collectVueComponents(...roots).forEach((component) => {
      safeCall(() => { component.visible = false; });
      safeCall(() => { component.menuVisible = false; });
      safeCall(() => { component.dropDownVisible = false; });
      safeCall(() => { component.suggestionVisible = false; });
      safeCall(() => component.toggleDropDownVisible?.(false));
      safeCall(() => component.handleClose?.());
      safeCall(() => component.hideSuggestionPanel?.());
      safeCall(() => component.blur?.());
      safeCall(() => component.$forceUpdate?.());
    });
  }

  async function waitForScheduleDiagramData(previousReceivedAt, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      if (state.latestDiagramData?.receivedAt && state.latestDiagramData.receivedAt !== previousReceivedAt) return true;
      await sleep(160);
    }
    return false;
  }

  function matchMeetingTeachers(requestedTeachers, availableTeachers) {
    const matched = [];
    const missed = [];
    requestedTeachers.forEach((teacher) => {
      const match = findUniqueMeetingNameMatch(teacher, availableTeachers || []);
      if (match) matched.push(match);
      else missed.push(teacher);
    });

    return {
      matched: Array.from(new Set(matched)),
      missed
    };
  }

  function normalizeMeetingTeacherName(teacher) {
    return normalizeName(normalizePastedTeacherName(teacher));
  }

  function findUniqueMeetingNameMatch(inputName, candidateNames) {
    const key = normalizeMeetingTeacherName(inputName);
    if (!key) return null;
    const candidates = (candidateNames || [])
      .map((name) => String(name || '').trim())
      .filter(Boolean);
    const exact = candidates.find((name) => normalizeMeetingTeacherName(name) === key);
    if (exact) return exact;
    if (key.length < 2) return null;
    const containsMatches = candidates.filter((name) => {
      const candidateKey = normalizeMeetingTeacherName(name);
      return candidateKey !== key && candidateKey.includes(key);
    });
    return containsMatches.length === 1 ? containsMatches[0] : null;
  }

  function areMeetingNameListsEqual(left, right) {
    const normalizeList = (items) => (items || []).map(normalizeMeetingTeacherName).filter(Boolean);
    const leftList = normalizeList(left);
    const rightList = normalizeList(right);
    if (leftList.length !== rightList.length) return false;
    return leftList.every((item, index) => item === rightList[index]);
  }

  function selectOnlyMeetingTeachers(teachers) {
    const teacherSet = new Set(teachers || []);
    state.meetingPlanner.selectedTeachers.clear();
    teacherSet.forEach((teacher) => state.meetingPlanner.selectedTeachers.add(teacher));
    document.querySelectorAll('#ccheck-meeting-teachers input[data-meeting-teacher]').forEach((checkbox) => {
      checkbox.checked = teacherSet.has(checkbox.value);
    });
    syncMeetingTeacherQueryFromSelection();
  }

  function buildMeetingDisplaySelectionNames(requestedParticipants, availableTeachers, supervisorMerge, teacherMatchResult) {
    const displayMatch = matchMeetingTeachers(requestedParticipants || [], availableTeachers || []);
    return Array.from(new Set(
      []
        .concat(displayMatch.matched)
        .concat(teacherMatchResult?.matched || [])
        .concat((supervisorMerge?.supervisors || []).map((supervisor) => supervisor.name))
    ));
  }

  function clickMeetingFindButton(options = {}) {
    const button = document.querySelector('#ccheck-panel button[data-action="meeting-find"]');
    if (button && isVisibleElement(button) && !button.disabled) {
      if (options.skipSystemDateSearch) button.dataset.skipSystemDateSearch = 'true';
      clickElementLikeUser(button);
      return;
    }
    findMeetingSlots(options);
  }

  async function findMeetingSlots(options = {}) {
    const events = Array.isArray(state.lastEvents) ? state.lastEvents : [];
    const includeSupervisors = isMeetingSupervisorIncluded();
    if (!events.length && !includeSupervisors) {
      renderMeetingMessage('还没有扫描结果，先点“全表扫描”或“扫当前可见”。');
      setStatus('共同空档需要先扫描课表。');
      return;
    }

    const teachers = Array.from(state.meetingPlanner.selectedTeachers).filter(Boolean);
    if (!teachers.length && !includeSupervisors) {
      renderMeetingMessage('请先勾选需要参加会议的老师。');
      setStatus('共同空档需要先选择老师。');
      return;
    }

    if (teachers.length && !options.skipSystemDateSearch) {
      const synced = await syncMeetingDateSearchAndScan(teachers);
      if (!synced) return;
    }

    renderMeetingSlotsFromCurrentScan();
  }

  async function syncMeetingDateSearchAndScan(teachersBeforeSearch = []) {
    const dateRange = readMeetingDateRangeForSystemSearch();
    if (!dateRange) {
      renderMeetingMessage('请先选择开始日期和结束日期。');
      setStatus('查找空档需要先选择日期范围。');
      return false;
    }

    setButtonsDisabled(true);
    try {
      renderMeetingMessage('正在按当前日期范围刷新系统课表，老师选择保持不变。');
      setStatus(`正在同步系统日期：${dateRange.startDate} 至 ${dateRange.endDate}。`);
      const searchResult = await applyScheduleDateFiltersAndSearch(dateRange);
      if (!searchResult.ok) {
        renderMeetingMessage(searchResult.message);
        setStatus(searchResult.message);
        return false;
      }

      await scanAll();
      const refreshedEvents = Array.isArray(state.lastEvents) ? state.lastEvents : [];
      if (!refreshedEvents.length) {
        renderMeetingMessage('系统搜索后仍没有扫描结果，请确认当前老师和日期范围内有课表数据。');
        setStatus('查找空档没有可用课表数据。');
        return false;
      }
      const matchResult = matchMeetingTeachers(teachersBeforeSearch, getMeetingTeachers(refreshedEvents));
      selectOnlyMeetingTeachers(matchResult.matched);
      if (matchResult.missed.length) {
        const matchedText = matchResult.matched.length ? `已保留：${matchResult.matched.join('、')}；` : '';
        renderMeetingMessage(`${matchedText}刷新后未匹配到：${matchResult.missed.join('、')}。请确认系统当前老师筛选仍包含这些老师。`);
        setStatus(`刷新后未匹配到 ${matchResult.missed.length} 位原已选老师。`);
        return false;
      }
      return true;
    } finally {
      setButtonsDisabled(false);
    }
  }

  function renderMeetingSlotsFromCurrentScan(teachers) {
    const events = Array.isArray(state.lastEvents) ? state.lastEvents : [];
    const selectedTeachers = Array.isArray(teachers) && teachers.length
      ? teachers
      : Array.from(state.meetingPlanner.selectedTeachers).filter(Boolean);
    const settings = readMeetingPlannerSettings(events);
    const supervisorMerge = readMeetingSupervisorMerge(settings, selectedTeachers);
    if (!supervisorMerge.ok) {
      renderMeetingMessage(supervisorMerge.message);
      setStatus(supervisorMerge.message);
      return;
    }
    const teacherParticipants = filterSupervisorNamesFromTeachers(selectedTeachers, supervisorMerge.supervisors);
    const selectedParticipants = Array.from(new Set(teacherParticipants.concat(supervisorMerge.supervisors.map((supervisor) => supervisor.name))));
    if (!selectedParticipants.length) {
      renderMeetingMessage('请先在人员输入框填写老师/督导，或勾选需要参加会议的老师。');
      setStatus('共同空档需要先选择老师或督导。');
      return;
    }
    if (!settings.dates.length) {
      renderMeetingMessage('所选日期不在当前已加载的课表范围内，请先在系统里加载对应日期后再扫描。');
      setStatus('共同空档没有可用日期。');
      return;
    }

    const plannerEvents = buildMeetingPlannerEvents(events, settings)
      .concat(buildSupervisorPlannerEvents(supervisorMerge.supervisors, settings));
    const fullSettingsList = expandMeetingModeSettings(settings);
    const slots = mergeDisplayMeetingSlots(
      sortMeetingSlots(fullSettingsList.flatMap((modeSettings) => buildFullMeetingSlots(plannerEvents, selectedParticipants, modeSettings))),
      plannerEvents,
      selectedParticipants,
      settings
    );
    if (slots.length) {
      renderFullMeetingSlots(slots, selectedParticipants, settings);
      const supervisorText = supervisorMerge.supervisors.length
        ? `，自动识别督导：${supervisorMerge.supervisors.map((supervisor) => supervisor.name).join('、')}`
        : '';
      setStatus(`共同空档已找到 ${slots.length} 段可排时间${supervisorText}。`);
      return;
    }

    renderMeetingNoSlotsMessage(selectedParticipants, settings);
    setStatus('没有找到可排时间。');
  }

  function expandMeetingModeSettings(settings) {
    if (settings.meetingMode === 'any') {
      return [
        { ...settings, meetingMode: 'offline', requestedMeetingMode: 'any' },
        { ...settings, meetingMode: 'online', requestedMeetingMode: 'any' }
      ];
    }
    return [{ ...settings, requestedMeetingMode: settings.meetingMode }];
  }

  function buildMeetingPlannerEvents(events, settings) {
    const baseEvents = Array.isArray(events) ? events : [];
    return baseEvents.concat(
      expandMeetingRangeDayOffEvents(baseEvents, settings.dates),
      expandMeetingFullRestDayEvents(baseEvents, settings.dates)
    );
  }

  function getMeetingPlannerLoadedDates(events) {
    const dates = new Set(getLoadedMeetingDates(events));
    if (isMeetingSupervisorIncluded()) {
      restoreSupervisorWorkbookFromStorage();
      state.supervisorPlanner.dateColumns.forEach((column) => {
        if (isIsoDate(column.date)) dates.add(column.date);
      });
    }
    return Array.from(dates).sort();
  }

  function isMeetingSupervisorIncluded() {
    return Boolean(document.getElementById('ccheck-meeting-include-supervisors')?.checked);
  }

  function readMeetingSupervisorMerge(settings, selectedTeachers = []) {
    if (!isMeetingSupervisorIncluded()) return { ok: true, supervisors: [] };
    const requested = readMeetingParticipantQueryNames();
    const selected = Array.from(new Set((selectedTeachers || []).filter(Boolean)));
    const namesForSplit = selected.length ? selected : requested;
    return readMeetingSupervisorParticipantsFromNames(namesForSplit, settings, {
      allowWithoutSupervisorWorkbook: true,
      allowWithoutSupervisorMatch: true
    });
  }

  function readMeetingParticipantQueryNames() {
    const input = document.getElementById('ccheck-meeting-teacher-query');
    return parsePastedTeacherNames(input?.value || '');
  }

  function readMeetingSupervisorParticipantsFromNames(requestedNames, settings, options = {}) {
    restoreSupervisorWorkbookFromStorage();
    if (!state.supervisorPlanner.supervisors.length) {
      if (options.allowWithoutSupervisorWorkbook) {
        const requested = Array.from(new Set((requestedNames || []).filter(Boolean)));
        return {
          ok: true,
          supervisors: [],
          teacherNames: requested,
          requestedNames: requested,
          resolvedNames: requested
        };
      }
      return {
        ok: false,
        message: '请先到“督导排班”页上传督导排班表。'
      };
    }
    const requested = Array.from(new Set((requestedNames || []).filter(Boolean)));
    if (!requested.length) {
      return {
        ok: false,
        message: '已勾选“包含督导”，请在人员输入框填写包含督导的参会名单。'
      };
    }
    const matchResult = matchMeetingSupervisors(requested);
    if (!matchResult.matched.length) {
      if (options.allowWithoutSupervisorMatch) {
        return {
          ok: true,
          supervisors: [],
          teacherNames: requested,
          requestedNames: requested,
          resolvedNames: requested
        };
      }
      return {
        ok: false,
        message: `没有从人员名单中识别到督导。请确认已导入督导表，姓名和表格一致；如果只填两个字，需要能唯一对应一位督导：${requested.join('、')}。`
      };
    }
    const supervisorDates = new Set(state.supervisorPlanner.dateColumns.map((column) => column.date));
    if (settings?.dates?.length && !settings.dates.some((date) => supervisorDates.has(date))) {
      return {
        ok: false,
        message: '当前日期范围不在已导入的督导排班表内。'
      };
    }
    return {
      ok: true,
      supervisors: matchResult.matched,
      teacherNames: matchResult.teacherNames,
      requestedNames: requested,
      resolvedNames: matchResult.resolvedNames
    };
  }

  function filterSupervisorNamesFromTeachers(teachers, supervisors) {
    const supervisorKeys = new Set((supervisors || []).map((supervisor) => normalizeMeetingTeacherName(supervisor.name)));
    return (teachers || []).filter((teacher) => !supervisorKeys.has(normalizeMeetingTeacherName(teacher)));
  }

  function matchMeetingSupervisors(requestedNames) {
    const byName = new Map();
    const supervisors = state.supervisorPlanner.supervisors || [];
    (state.supervisorPlanner.supervisors || []).forEach((supervisor) => {
      const key = normalizeMeetingTeacherName(supervisor.name);
      if (key && !byName.has(key)) byName.set(key, supervisor);
    });
    const matched = [];
    const teacherNames = [];
    const resolvedNames = [];
    requestedNames.forEach((name) => {
      const match = findMeetingSupervisorByInputName(name, byName, supervisors);
      if (match) {
        matched.push(match);
        resolvedNames.push(match.name);
      } else {
        teacherNames.push(name);
        resolvedNames.push(name);
      }
    });
    const uniqueTeacherNames = Array.from(new Set(teacherNames));
    return {
      matched: Array.from(new Set(matched)),
      missed: uniqueTeacherNames,
      teacherNames: uniqueTeacherNames,
      resolvedNames: Array.from(new Set(resolvedNames))
    };
  }

  function findMeetingSupervisorByInputName(name, byName, supervisors) {
    const rawName = String(name || '').trim();
    const key = normalizeMeetingTeacherName(name);
    if (!key) return null;
    const exact = byName.get(key);
    if (exact) return exact;
    if (/(?:老师)+$/.test(rawName)) return null;
    if (key.length < 2) return null;
    const partialMatches = (supervisors || []).filter((supervisor) => {
      const supervisorKey = normalizeMeetingTeacherName(supervisor.name);
      return supervisorKey !== key && supervisorKey.includes(key);
    });
    return partialMatches.length === 1 ? partialMatches[0] : null;
  }

  function readMeetingPlannerSettings(events) {
    const loadedDates = getMeetingPlannerLoadedDates(events);
    const loadedDateSet = new Set(loadedDates);
    const startInput = document.getElementById('ccheck-meeting-start');
    const endInput = document.getElementById('ccheck-meeting-end');
    let startDate = isIsoDate(startInput?.value) ? startInput.value : loadedDates[0];
    let endDate = isIsoDate(endInput?.value) ? endInput.value : loadedDates[loadedDates.length - 1];
    if (startDate && endDate && startDate > endDate) {
      const swap = startDate;
      startDate = endDate;
      endDate = swap;
    }

    const durationInput = document.getElementById('ccheck-meeting-duration');
    const durationMinutes = roundToFive(clampNumber(
      Number(durationInput?.value),
      CONFIG.defaultMeetingDurationMinutes,
      5,
      240
    ));
    const rawMeetingMode = document.getElementById('ccheck-meeting-mode')?.value;
    const meetingMode = rawMeetingMode === 'online' || rawMeetingMode === 'offline' ? rawMeetingMode : 'any';
    const includeEveningMeeting = isEveningMeetingIncluded();

    const dates = startDate && endDate
      ? buildDateRange(startDate, endDate).filter((date) => loadedDateSet.has(date))
      : [];

    return {
      startDate,
      endDate,
      dates,
      durationMinutes,
      meetingMode,
      includeEveningMeeting,
      windowStartMinutes: CONFIG.meetingWindowStartMinutes,
      windowEndMinutes: includeEveningMeeting ? CONFIG.eveningMeetingWindowEndMinutes : CONFIG.meetingWindowEndMinutes,
      excludedRanges: CONFIG.meetingExcludedRanges.slice()
    };
  }

  function isEveningMeetingIncluded() {
    return Boolean(document.getElementById('ccheck-meeting-evening')?.checked);
  }

  function updateMeetingRangeLabel() {
    const label = document.getElementById('ccheck-meeting-range');
    if (!label) return;
    const start = formatMinutes(CONFIG.meetingWindowStartMinutes);
    const end = isEveningMeetingIncluded()
      ? formatMinutes(CONFIG.eveningMeetingWindowEndMinutes)
      : formatMinutes(CONFIG.meetingWindowEndMinutes);
    label.textContent = isEveningMeetingIncluded() ? `${start}-${end}（含晚间）` : `${start}-${end}`;
  }

  function getLoadedMeetingDates(events) {
    const dates = new Set();
    (events || []).forEach((event) => {
      if (isIsoDate(event.date)) dates.add(event.date);
    });

    try {
      getHeaderColumns().forEach((column) => {
        if (isIsoDate(column.date)) dates.add(column.date);
      });
    } catch (error) {
      console.warn('[campus-commute-checker] 读取表头日期失败，已忽略。', error);
    }

    const diagramData = state.latestDiagramData || {};
    if (Array.isArray(diagramData.dates)) {
      diagramData.dates.forEach((date) => {
        const normalized = normalizeDiagramDate(date);
        if (isIsoDate(normalized)) dates.add(normalized);
      });
    }
    (diagramData.teachers || []).forEach((teacher) => {
      (Array.isArray(teacher.course_schedule) ? teacher.course_schedule : []).forEach((schedule) => {
        const normalized = normalizeDiagramDate(schedule.date || schedule.day || schedule.schedule_date);
        if (isIsoDate(normalized)) dates.add(normalized);
      });
    });

    return Array.from(dates).sort();
  }

  function expandMeetingRangeDayOffEvents(events, dates) {
    const expanded = [];
    const seen = new Set();
    (events || []).forEach((event) => {
      if (!event || !event.teacher || !event.text) return;
      const range = parseDayOffDateRange(event.text, event.date, {
        includeHalfDayRange: false
      });
      if (!range) return;
      dates.forEach((date) => {
        const listedDates = Array.isArray(range.dates) ? new Set(range.dates) : null;
        if (listedDates ? !listedDates.has(date) : date < range.startDate || date > range.endDate) return;
        const key = `${event.key}>>meeting-range-day-off>>${date}`;
        if (seen.has(key)) return;
        seen.add(key);
        expanded.push(createRangeDayOffEvent(event, date, range));
      });
    });
    return expanded;
  }

  function expandMeetingFullRestDayEvents(events, dates) {
    const dateSet = new Set(dates || []);
    const groups = new Map();

    (events || []).forEach((event) => {
      if (!event || !event.teacher || !dateSet.has(event.date)) return;
      if (!isRestDayEvent(event) || isNoCourseDayOffEvent(event)) return;
      const key = `${event.teacher}||${event.date}`;
      if (!groups.has(key)) {
        groups.set(key, {
          teacher: event.teacher,
          date: event.date,
          dateIndex: event.dateIndex,
          restMarkers: []
        });
      }

      const group = groups.get(key);
      group.restMarkers.push(event);
    });

    return Array.from(groups.values())
      .filter((group) => group.restMarkers.length)
      .map(createMeetingFullRestDayEvent);
  }

  function createMeetingFullRestDayEvent(group) {
    const marker = group.restMarkers[0] || {};
    return {
      key: `${group.teacher}>>${group.date}>>meeting-full-rest-day`,
      teacher: group.teacher,
      text: '休息（全天）',
      hex: '',
      type: 'dayOff',
      campus: '休息',
      colorMeaning: '休息',
      date: group.date,
      dateLabel: marker.dateLabel || '',
      dateIndex: group.dateIndex,
      startMinutes: 0,
      endMinutes: 1440,
      start: '全天',
      end: '全天',
      parentIndex: marker.parentIndex ?? -1,
      rowIndex: marker.rowIndex ?? -1,
      itemIndex: -1,
      scanTop: marker.scanTop || 0,
      rect: marker.rect || null
    };
  }

  function buildFullMeetingSlots(events, teachers, settings) {
    if (settings.meetingMode === 'offline') {
      return buildOfflineMeetingSlots(events, teachers, settings);
    }
    return buildOnlineMeetingSlots(events, teachers, settings);
  }

  function buildOnlineMeetingSlots(events, teachers, settings) {
    return settings.dates.flatMap((date) => {
      const blockers = getMeetingBlockingEvents(events, teachers, date, settings);
      const intervals = mergeMeetingIntervals(
        blockers.map((event) => eventToMeetingInterval(event, settings))
          .filter(Boolean)
          .concat(getMeetingExcludedIntervals(settings))
          .concat(getOnlineMeetingCommuteIntervals(events, teachers, date, settings))
      );
      const freeRanges = invertMeetingIntervals(intervals, settings);
      return freeRanges
        .filter((range) => range.endMinutes - range.startMinutes >= settings.durationMinutes)
        .map((range) => ({
          date,
          startMinutes: range.startMinutes,
          endMinutes: range.endMinutes,
          meetingMode: settings.meetingMode
        }));
    });
  }

  function getOnlineMeetingCommuteIntervals(events, teachers, date, settings) {
    const teacherSet = new Set(teachers);
    const byTeacher = new Map();

    (events || []).forEach((event) => {
      if (!event || !teacherSet.has(event.teacher) || event.date !== date) return;
      if (!isFiniteMeetingTime(event) || !isOnlineCampusRuleContextEvent(event)) return;
      if (!byTeacher.has(event.teacher)) byTeacher.set(event.teacher, []);
      byTeacher.get(event.teacher).push(event);
    });

    const intervals = [];
    byTeacher.forEach((teacherEvents) => {
      const sorted = teacherEvents.slice().sort(compareByTime);
      for (let index = 0; index < sorted.length - 1; index += 1) {
        const previous = sorted[index];
        const next = sorted[index + 1];
        const previousEndWithBuffer = getMeetingAfterEventLimitMinutes(previous);
        if (next.startMinutes <= previousEndWithBuffer) continue;

        const previousCampus = getCourseRealCampus(previous);
        const nextCampus = getCourseRealCampus(next);
        if (!previousCampus || !nextCampus || previousCampus === nextCampus) continue;

        const requiredMinutes = getCommuteMinutes(previousCampus, nextCampus);
        if (requiredMinutes == null) {
          intervals.push(clipMeetingInterval(previousEndWithBuffer, next.startMinutes, settings));
          continue;
        }
        if (requiredMinutes <= 0) continue;

        const nextStartWithBuffer = getMeetingBeforeEventLimitMinutes(next);
        intervals.push(clipMeetingInterval(nextStartWithBuffer - requiredMinutes, nextStartWithBuffer, settings));
      }
    });

    return intervals.filter(Boolean);
  }

  function buildOfflineMeetingSlots(events, teachers, settings) {
    const campuses = Array.from(CONFIG.realCampuses);
    return settings.dates.flatMap((date) => {
      const baseIntervals = getMeetingBlockingEvents(events, teachers, date, settings)
        .map((event) => eventToMeetingInterval(event, settings))
        .filter(Boolean)
        .concat(getMeetingExcludedIntervals(settings));

      return campuses.flatMap((meetingCampus) => {
        const intervals = mergeMeetingIntervals(baseIntervals.concat(
          getMeetingCampusCommuteIntervals(events, teachers, date, meetingCampus, settings)
        ));
        return invertMeetingIntervals(intervals, settings)
          .filter((range) => range.endMinutes - range.startMinutes >= settings.durationMinutes)
          .map((range) => ({
            date,
            startMinutes: range.startMinutes,
            endMinutes: range.endMinutes,
            meetingMode: settings.meetingMode,
            meetingCampus
          }));
      });
    });
  }

  function getMeetingCampusCommuteIntervals(events, teachers, date, meetingCampus, settings) {
    const teacherSet = new Set(teachers);
    return (events || []).flatMap((event) => {
      if (!event || !teacherSet.has(event.teacher) || event.date !== date) return [];
      if (!isFiniteMeetingTime(event) || !isOnlineCampusRuleContextEvent(event)) return [];

      const courseCampus = getCourseRealCampus(event);
      const toMeetingMinutes = getCommuteMinutes(courseCampus, meetingCampus);
      const fromMeetingMinutes = getCommuteMinutes(meetingCampus, courseCampus);
      const intervals = [];

      if (toMeetingMinutes == null) {
        intervals.push(clipMeetingInterval(getMeetingAfterEventLimitMinutes(event), settings.windowEndMinutes, settings));
      } else if (toMeetingMinutes > 0) {
        const travelStartMinutes = getMeetingAfterEventLimitMinutes(event);
        intervals.push(clipMeetingInterval(travelStartMinutes, travelStartMinutes + toMeetingMinutes, settings));
      }

      if (fromMeetingMinutes == null) {
        intervals.push(clipMeetingInterval(settings.windowStartMinutes, getMeetingBeforeEventLimitMinutes(event), settings));
      } else if (fromMeetingMinutes > 0) {
        const travelEndMinutes = getMeetingBeforeEventLimitMinutes(event);
        intervals.push(clipMeetingInterval(travelEndMinutes - fromMeetingMinutes, travelEndMinutes, settings));
      }

      return intervals.filter(Boolean);
    });
  }

  function sortMeetingSlots(slots) {
    return (slots || []).slice().sort((a, b) => (
      a.date.localeCompare(b.date)
      || a.startMinutes - b.startMinutes
      || a.endMinutes - b.endMinutes
      || compareMeetingMode(a.meetingMode, b.meetingMode)
      || String(a.meetingCampus || '').localeCompare(String(b.meetingCampus || ''), 'zh-CN')
    ));
  }

  function compareMeetingMode(a, b) {
    const order = { offline: 0, online: 1, any: 2 };
    return (order[a] ?? 9) - (order[b] ?? 9);
  }

  function getMeetingBlockingEvents(events, teachers, date, settings) {
    const teacherSet = new Set(teachers);
    return (events || []).filter((event) => {
      if (!event || !teacherSet.has(event.teacher) || event.date !== date) return false;
      if (!isFiniteMeetingTime(event)) return false;
      if (isNoCourseDayOffEvent(event)) return false;
      return Boolean(eventToMeetingInterval(event, settings));
    });
  }

  function isUnavailableLeaveText(text) {
    return /请假|休假|调休/.test(normalizeDayOffText(text))
      || Boolean(getDayOffRangeKind(text));
  }

  function isFiniteMeetingTime(event) {
    return Number.isFinite(event.startMinutes)
      && Number.isFinite(event.endMinutes)
      && event.endMinutes > event.startMinutes;
  }

  function eventToMeetingInterval(event, settings) {
    const normalizedEvent = getMeetingIntervalSourceEvent(event, settings);
    const startMinutes = Math.max(settings.windowStartMinutes, getMeetingBeforeEventLimitMinutes(normalizedEvent));
    const endMinutes = Math.min(settings.windowEndMinutes, getMeetingAfterEventLimitMinutes(normalizedEvent));
    if (endMinutes <= startMinutes) return null;
    return { startMinutes, endMinutes };
  }

  function getMeetingIntervalSourceEvent(event, settings) {
    const explicitRange = parseDayOffTimeRange(event?.text);
    if (explicitRange && isUnavailableLeaveText(event.text)) {
      return {
        ...event,
        startMinutes: explicitRange.startMinutes,
        endMinutes: explicitRange.endMinutes
      };
    }
    if (isUnavailableLeaveText(event.text)) {
      return {
        ...event,
        startMinutes: settings.windowStartMinutes,
        endMinutes: settings.windowEndMinutes
      };
    }
    if (!isMorningUnavailableMarkerForMeeting(event, settings)) return event;
    return {
      ...event,
      startMinutes: settings.windowStartMinutes,
      endMinutes: settings.windowStartMinutes + CONFIG.defaultMeetingDurationMinutes
    };
  }

  function isMorningUnavailableMarkerForMeeting(event, settings) {
    if (!event || event.type !== 'dayOff') return false;
    if (!Number.isFinite(event.startMinutes) || !Number.isFinite(event.endMinutes)) return false;
    if (!isUnavailableLeaveText(event.text)) return false;
    return event.startMinutes <= settings.windowStartMinutes && event.endMinutes > settings.windowStartMinutes;
  }

  function getMeetingBeforeEventLimitMinutes(event) {
    if (event?.type === 'supervisorUnavailable') return event.startMinutes;
    return event.startMinutes - CONFIG.meetingEventBufferMinutes;
  }

  function getMeetingAfterEventLimitMinutes(event) {
    if (event?.type === 'supervisorUnavailable') return event.endMinutes;
    return event.endMinutes + CONFIG.meetingEventBufferMinutes;
  }

  function clipMeetingInterval(startMinutes, endMinutes, settings) {
    const clippedStart = Math.max(settings.windowStartMinutes, startMinutes);
    const clippedEnd = Math.min(settings.windowEndMinutes, endMinutes);
    if (clippedEnd <= clippedStart) return null;
    return { startMinutes: clippedStart, endMinutes: clippedEnd };
  }

  function getMeetingExcludedIntervals(settings) {
    return (settings.excludedRanges || [])
      .map((range) => {
        const startMinutes = Math.max(settings.windowStartMinutes, range.startMinutes);
        const endMinutes = Math.min(settings.windowEndMinutes, range.endMinutes);
        return endMinutes > startMinutes ? { startMinutes, endMinutes } : null;
      })
      .filter(Boolean);
  }

  function mergeMeetingIntervals(intervals) {
    const sorted = intervals.slice().sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);
    const merged = [];
    sorted.forEach((interval) => {
      const last = merged[merged.length - 1];
      if (!last || interval.startMinutes > last.endMinutes) {
        merged.push({ startMinutes: interval.startMinutes, endMinutes: interval.endMinutes });
      } else {
        last.endMinutes = Math.max(last.endMinutes, interval.endMinutes);
      }
    });
    return merged;
  }

  function invertMeetingIntervals(intervals, settings) {
    const ranges = [];
    let cursor = settings.windowStartMinutes;
    intervals.forEach((interval) => {
      if (interval.startMinutes > cursor) {
        ranges.push({ startMinutes: cursor, endMinutes: interval.startMinutes });
      }
      cursor = Math.max(cursor, interval.endMinutes);
    });
    if (cursor < settings.windowEndMinutes) {
      ranges.push({ startMinutes: cursor, endMinutes: settings.windowEndMinutes });
    }
    return ranges;
  }

  function intervalsOverlap(startA, endA, startB, endB) {
    return startA < endB && endA > startB;
  }

  function renderFullMeetingSlots(slots, teachers, settings) {
    const result = document.getElementById('ccheck-meeting-results');
    if (!result) return;
    result.innerHTML = `
      <span class="ccheck-muted">找到 ${slots.length} 段可排时间。</span>
      ${slots.map((slot, index) => `
        <div class="ccheck-slot-card">
          <div class="ccheck-slot-title">
            <span class="ccheck-slot-date">
              <span>${escapeHtml(slot.date)}</span>
              ${formatMeetingSupervisorShiftSummary(slot.date, teachers) ? `<span class="ccheck-slot-shifts">${escapeHtml(formatMeetingSupervisorShiftSummary(slot.date, teachers))}</span>` : ''}
            </span>
            <span>${formatMinutes(slot.startMinutes)}-${formatMinutes(slot.endMinutes)}</span>
          </div>
          <div class="ccheck-slot-actions">
            <button class="ccheck-locate" type="button" data-meeting-locate="${index}">定位可排</button>
            <button class="ccheck-locate" type="button" data-meeting-draft="${index}">排会议草稿</button>
          </div>
        </div>
      `).join('')}
    `;
    bindMeetingLocateButtons(slots, teachers, settings);
    bindMeetingDraftButtons(slots, teachers, settings);
  }

  function renderMeetingNoSlotsMessage(teachers, settings) {
    const result = document.getElementById('ccheck-meeting-results');
    if (!result) return;
    result.innerHTML = '<div class="ccheck-empty">没有找到可排时间。</div>';
  }

  function mergeDisplayMeetingSlots(slots, events, teachers, settings) {
    const sorted = (slots || []).slice().sort((a, b) => (
      a.date.localeCompare(b.date)
      || a.startMinutes - b.startMinutes
      || a.endMinutes - b.endMinutes
    ));
    const merged = [];

    sorted.forEach((slot) => {
      const last = merged[merged.length - 1];
      if (!last || last.date !== slot.date || slot.startMinutes > last.endMinutes) {
        merged.push({
          date: slot.date,
          startMinutes: slot.startMinutes,
          endMinutes: slot.endMinutes,
          meetingMode: 'available'
        });
        return;
      }
      last.endMinutes = Math.max(last.endMinutes, slot.endMinutes);
    });

    return merged.flatMap((slot) => subtractMeetingDisplayBlockers(slot, events, teachers, settings))
      .filter((slot) => slot.endMinutes - slot.startMinutes >= settings.durationMinutes);
  }

  function subtractMeetingDisplayBlockers(slot, events, teachers, settings) {
    const blockers = mergeMeetingIntervals(
      getMeetingBlockingEvents(events, teachers, slot.date, settings)
        .map((event) => eventToMeetingInterval(event, settings))
        .filter((interval) => interval && intervalsOverlap(
          slot.startMinutes,
          slot.endMinutes,
          interval.startMinutes,
          interval.endMinutes
        ))
    );
    let ranges = [{ startMinutes: slot.startMinutes, endMinutes: slot.endMinutes }];

    blockers.forEach((blocker) => {
      ranges = ranges.flatMap((range) => {
        if (!intervalsOverlap(range.startMinutes, range.endMinutes, blocker.startMinutes, blocker.endMinutes)) {
          return [range];
        }
        return [
          { startMinutes: range.startMinutes, endMinutes: Math.min(range.endMinutes, blocker.startMinutes) },
          { startMinutes: Math.max(range.startMinutes, blocker.endMinutes), endMinutes: range.endMinutes }
        ].filter((item) => item.endMinutes > item.startMinutes);
      });
    });

    return ranges.map((range) => ({
      date: slot.date,
      startMinutes: range.startMinutes,
      endMinutes: range.endMinutes,
      meetingMode: 'available'
    }));
  }

  function getMeetingSupervisorRecordsForParticipants(participants) {
    const supervisorByName = new Map();
    (state.supervisorPlanner.supervisors || []).forEach((supervisor) => {
      const key = normalizeMeetingTeacherName(supervisor.name);
      if (key && !supervisorByName.has(key)) supervisorByName.set(key, supervisor);
    });
    const seen = new Set();
    return (participants || []).map((name) => {
      const key = normalizeMeetingTeacherName(name);
      const supervisor = supervisorByName.get(key);
      if (!supervisor || seen.has(key)) return null;
      seen.add(key);
      return supervisor;
    }).filter(Boolean);
  }

  function formatMeetingSupervisorShiftSummary(date, participants) {
    const parts = getMeetingSupervisorRecordsForParticipants(participants)
      .map((supervisor) => {
        const shiftCode = supervisor.shiftCodes?.get(date) || '';
        if (shiftCode) return `${supervisor.name}${shiftCode}`;
        const ranges = supervisor.days?.get(date);
        if (Array.isArray(ranges) && !ranges.length) return `${supervisor.name}休`;
        if (Array.isArray(ranges) && ranges.length) return `${supervisor.name}${formatMeetingRanges(ranges)}`;
        return '';
      })
      .filter(Boolean);
    return parts.join('，');
  }

  function getMeetingSupervisorCommonAvailableRanges(supervisors, date, settings) {
    const rangesBySupervisor = (supervisors || []).map((supervisor) => (
      (supervisor.days?.get(date) || [])
        .map((range) => clipMeetingInterval(range.startMinutes, range.endMinutes, settings))
        .filter(Boolean)
    ));
    if (!rangesBySupervisor.length) return [];
    let common = rangesBySupervisor[0];
    rangesBySupervisor.slice(1).forEach((ranges) => {
      common = intersectMeetingRanges(common, ranges);
    });
    return mergeMeetingIntervals(common);
  }

  function intersectMeetingRanges(leftRanges, rightRanges) {
    const output = [];
    (leftRanges || []).forEach((left) => {
      (rightRanges || []).forEach((right) => {
        const startMinutes = Math.max(left.startMinutes, right.startMinutes);
        const endMinutes = Math.min(left.endMinutes, right.endMinutes);
        if (endMinutes > startMinutes) output.push({ startMinutes, endMinutes });
      });
    });
    return output;
  }

  function formatMeetingRanges(ranges) {
    return (ranges || []).map(formatMeetingRange).join('、');
  }

  function formatMeetingRange(range) {
    if (!range) return '';
    return `${formatMinutes(range.startMinutes)}-${formatMinutes(range.endMinutes)}`;
  }

  function renderMeetingMessage(message) {
    const result = document.getElementById('ccheck-meeting-results');
    if (result) result.innerHTML = `<div class="ccheck-empty">${escapeHtml(message)}</div>`;
  }

  function keepMeetingButtonFromStealingFocus(button) {
    button.addEventListener('mousedown', (event) => {
      if (event.button === 0) event.preventDefault();
    });
  }

  function bindMeetingLocateButtons(slots, teachers, settings) {
    const result = document.getElementById('ccheck-meeting-results');
    if (!result) return;
    result.querySelectorAll('[data-meeting-locate]').forEach((button) => {
      keepMeetingButtonFromStealingFocus(button);
      button.addEventListener('click', async () => {
        button.blur?.();
        const slot = slots[Number(button.dataset.meetingLocate)];
        await locateMeetingSlot(slot, teachers, settings);
      });
    });
  }

  function bindMeetingDraftButtons(slots, teachers, settings) {
    const result = document.getElementById('ccheck-meeting-results');
    if (!result) return;
    result.querySelectorAll('[data-meeting-draft]').forEach((button) => {
      keepMeetingButtonFromStealingFocus(button);
      button.addEventListener('click', () => {
        button.blur?.();
        const slot = slots[Number(button.dataset.meetingDraft)];
        showMeetingDraftOptions(slot, teachers, settings, slots);
      });
    });
  }

  async function locateMeetingSlot(slot, teachers, settings) {
    if (!slot || !Array.isArray(teachers) || !teachers.length) return;
    const scroller = findScrollContainer();
    clearMarkers();

    const headerColumns = getHeaderColumns();
    if (!headerColumns.some((column) => column.date === slot.date)) {
      const visibleRange = formatHeaderDateRange(headerColumns);
      setStatus(`当前课表表头${visibleRange ? `（${visibleRange}）` : ''}不包含 ${slot.date}，未标记旧日期列。请确认系统搜索后课表已刷新到所选日期范围。`);
      return;
    }

    const targetTeacher = teachers[0];
    const targetEvent = findMeetingLocateAnchorEvent(targetTeacher, slot.date);
    const locatedRow = await locateTeacherRow(scroller, { teacher: targetTeacher, date: slot.date }, targetEvent);
    if (locatedRow) {
      alignMeetingSlotInView(locatedRow, slot, scroller);
      await sleep(80);
    }

    const marked = markVisibleMeetingSlot(teachers, slot, settings);
    setStatus(marked
      ? `已定位 ${slot.date} ${formatMinutes(slot.startMinutes)}-${formatMinutes(slot.endMinutes)}，标记 ${marked} 位可见老师。`
      : `已尝试定位 ${slot.date} ${formatMinutes(slot.startMinutes)}-${formatMinutes(slot.endMinutes)}，当前可见区没有匹配老师。`);
  }

  function showMeetingDraftOptions(slot, teachers, settings) {
    if (!slot || !Array.isArray(teachers) || !teachers.length) {
      setStatus('请先选择老师并查找共同空档。');
      return;
    }
    const options = buildMeetingDraftSlotOptions(slot, settings);
    if (!options.length) {
      setStatus('当前空档不足以按所选时长生成会议草稿。');
      return;
    }

    closeMeetingDraftOptions();
    const modal = document.createElement('div');
    modal.id = 'ccheck-draft-modal';
    modal.className = 'ccheck-draft-modal';
    const lastMeetingName = readLastMeetingName();
    modal.innerHTML = `
      <div class="ccheck-draft-modal-head">
        <span>选择会议时间</span>
        <button class="ccheck-draft-close" type="button" data-draft-close title="关闭">×</button>
      </div>
      <small class="ccheck-muted">${escapeHtml(slot.date)} ${formatMinutes(slot.startMinutes)}-${formatMinutes(slot.endMinutes)}，按 ${settings.durationMinutes} 分钟切分</small>
      <label class="ccheck-draft-name-field">
        <span class="ccheck-draft-name-label">会议名称</span>
        <span class="ccheck-draft-name-hint">建议先填，避免提交前漏看。</span>
        <input id="ccheck-draft-meeting-name" type="text" maxlength="80" placeholder="可留空，跳转后手动填写">
      </label>
      <div class="ccheck-draft-options">
        ${options.map((option, index) => `
          <button class="ccheck-draft-option" type="button" data-draft-option="${index}">
            ${formatMinutes(option.startMinutes)}-${formatMinutes(option.endMinutes)}
          </button>
        `).join('')}
      </div>
      <small class="ccheck-muted">选择后会打开会议新建页并预填草稿，仍需人工点系统“确定”。</small>
    `;
    document.body.appendChild(modal);
    restoreFloatingElementPosition(modal, DRAFT_MODAL_POSITION_STORAGE_KEY);
    enableFloatingElementDragging(modal, {
      handleSelector: '.ccheck-draft-modal-head',
      draggingClass: 'ccheck-draft-note-dragging',
      storageKey: DRAFT_MODAL_POSITION_STORAGE_KEY
    });
    const nameInput = modal.querySelector('#ccheck-draft-meeting-name');
    if (nameInput) {
      nameInput.value = lastMeetingName;
    }
    modal.querySelector('[data-draft-close]')?.addEventListener('click', closeMeetingDraftOptions);
    modal.querySelectorAll('[data-draft-option]').forEach((button) => {
      button.addEventListener('click', () => {
        const selected = options[Number(button.dataset.draftOption)];
        const meetingName = modal.querySelector('#ccheck-draft-meeting-name')?.value?.trim() || '';
        closeMeetingDraftOptions();
        saveLastMeetingName(meetingName);
        openMeetingDraft(selected, teachers, settings, meetingName);
      });
    });
    setStatus(`请选择 ${slot.date} 的具体会议时间。`);
  }

  function closeMeetingDraftOptions() {
    document.getElementById('ccheck-draft-modal')?.remove();
  }

  function readLastMeetingName() {
    try {
      return String(localStorage.getItem(MEETING_NAME_STORAGE_KEY) || '').trim();
    } catch (_) {
      return '';
    }
  }

  function saveLastMeetingName(value) {
    const text = String(value || '').trim();
    if (!text) return;
    try {
      localStorage.setItem(MEETING_NAME_STORAGE_KEY, text);
    } catch (_) {
      // Ignore storage failures.
    }
  }

  function buildMeetingDraftSlotOptions(slot, settings) {
    const duration = Math.max(5, roundToFive(Number(settings?.durationMinutes) || CONFIG.defaultMeetingDurationMinutes));
    const gap = 5;
    return splitSlotByExcludedRanges(slot, settings)
      .flatMap((range) => buildFixedDurationSlotOptions(slot, range, duration, gap));
  }

  function splitSlotByExcludedRanges(slot, settings) {
    const excludedRanges = mergeMeetingIntervals((settings?.excludedRanges || CONFIG.meetingExcludedRanges)
      .map((range) => ({
        startMinutes: Math.max(slot.startMinutes, range.startMinutes),
        endMinutes: Math.min(slot.endMinutes, range.endMinutes)
      }))
      .filter((range) => range.endMinutes > range.startMinutes));

    let ranges = [{ startMinutes: slot.startMinutes, endMinutes: slot.endMinutes }];
    excludedRanges.forEach((excluded) => {
      ranges = ranges.flatMap((range) => {
        if (!intervalsOverlap(range.startMinutes, range.endMinutes, excluded.startMinutes, excluded.endMinutes)) {
          return [range];
        }
        return [
          { startMinutes: range.startMinutes, endMinutes: Math.min(range.endMinutes, excluded.startMinutes) },
          { startMinutes: Math.max(range.startMinutes, excluded.endMinutes), endMinutes: range.endMinutes }
        ].filter((item) => item.endMinutes > item.startMinutes);
      });
    });
    return ranges;
  }

  function buildFixedDurationSlotOptions(sourceSlot, range, duration, gap) {
    const options = [];
    for (let startMinutes = range.startMinutes; startMinutes + duration <= range.endMinutes; startMinutes += duration + gap) {
      options.push({
        ...sourceSlot,
        startMinutes,
        endMinutes: startMinutes + duration
      });
    }
    return options;
  }

  function openMeetingDraft(slot, teachers, settings, meetingName = '') {
    if (!slot || !Array.isArray(teachers) || !teachers.length) {
      setStatus('请先选择老师并查找共同空档。');
      return;
    }

    const draft = buildMeetingDraft(slot, teachers, settings, meetingName);
    openMeetingDraftInNewTab(draft);
    setStatus(`已生成会议草稿：${draft.date} ${draft.startTime}-${draft.endTime}\n新页面会自动预填，请人工确认后再点系统“确定”。`);
  }

  function openMeetingDraftInNewTab(draft) {
    const url = prepareMeetingDraftUrl(draft);
    window.open(url.toString(), '_blank');
  }

  function prepareMeetingDraftUrl(draft) {
    try {
      localStorage.setItem(MEETING_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch (_) {
      // URL 参数仍会携带草稿，localStorage 只是跨页兜底。
    }

    const url = new URL(MEETING_ADD_PATH, location.origin);
    url.searchParams.set('ccheckDraft', encodeMeetingDraft(draft));
    return url;
  }

  function buildMeetingDraft(slot, teachers, settings, meetingName = '') {
    const durationMinutes = Math.max(5, Math.round(slot.endMinutes - slot.startMinutes));
    const meetingMode = slot.meetingMode === 'online' || slot.meetingMode === 'offline'
      ? slot.meetingMode
      : settings?.meetingMode || 'any';
    return {
      source: 'campus-commute-checker',
      version: SCRIPT_VERSION,
      createdAt: new Date().toISOString(),
      date: slot.date,
      startTime: formatMinutes(slot.startMinutes),
      endTime: formatMinutes(slot.endMinutes),
      durationMinutes,
      meetingMode,
      meetingCampus: meetingMode === 'offline' ? slot.meetingCampus || '' : '',
      teachers: teachers.slice(),
      meetingName: String(meetingName || '').trim()
    };
  }

  function encodeMeetingDraft(draft) {
    return encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(draft)))));
  }

  function decodeMeetingDraft(value) {
    if (!value) return null;
    try {
      return JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(value)))));
    } catch (_) {
      return null;
    }
  }

  function findMeetingLocateAnchorEvent(teacher, date) {
    return (state.lastEvents || []).find((event) => event.teacher === teacher && event.date === date)
      || (state.lastEvents || []).find((event) => event.teacher === teacher)
      || null;
  }

  function markVisibleMeetingSlot(teachers, slot, settings) {
    const teacherSet = new Set(teachers);
    let count = 0;
    Array.from(document.querySelectorAll('.row')).forEach((row) => {
      const teacher = textOf(row.children[0]).trim();
      if (!teacherSet.has(teacher)) return;
      const cell = getTeacherDayCell(row, slot.date);
      if (!cell) return;
      markTeacherDayCell(row, slot.date);
      if (addMeetingSlotMarker(cell, row, slot, settings)) count += 1;
    });
    return count;
  }

  function getTeacherDayCell(row, date) {
    const dateIndex = getHeaderColumns().findIndex((column) => column.date === date);
    return dateIndex >= 0 ? row.children[dateIndex + 3] : null;
  }

  function addMeetingSlotMarker(cell, row, slot, settings) {
    const rowTiming = getRowTiming(row);
    const startOffset = Math.max(0, (slot.startMinutes - rowTiming.baseMinutes) / rowTiming.minutesPerPixel);
    const endOffset = Math.max(startOffset + 4, (slot.endMinutes - rowTiming.baseMinutes) / rowTiming.minutesPerPixel);
    const maxHeight = Math.max(12, cell.getBoundingClientRect().height);
    const top = Math.max(0, Math.min(maxHeight - 4, startOffset));
    const height = Math.max(8, Math.min(maxHeight - top, endOffset - startOffset));
    const marker = document.createElement('div');
    marker.className = 'ccheck-meeting-mark';
    marker.title = `可排时间 ${formatMinutes(slot.startMinutes)}-${formatMinutes(slot.endMinutes)}`;
    marker.style.top = `${top}px`;
    marker.style.height = `${height}px`;
    const oldPosition = getComputedStyle(cell).position;
    if (oldPosition === 'static') cell.style.position = 'relative';
    cell.appendChild(marker);
    state.currentMarkers.push(marker);
    return true;
  }

  function alignMeetingSlotInView(row, slot, scroller = findScrollContainer()) {
    if (!row || !slot) return;
    alignTeacherDateInView(row, slot.date);

    const rowTiming = getRowTiming(row);
    if (!rowTiming || !Number.isFinite(rowTiming.minutesPerPixel)) return;
    const rowRect = row.getBoundingClientRect();
    const viewportTop = scroller === document.scrollingElement
      ? 0
      : scroller.getBoundingClientRect().top;
    const viewportHeight = scroller === document.scrollingElement
      ? window.innerHeight
      : scroller.clientHeight;
    const targetY = rowRect.top + ((slot.startMinutes - rowTiming.baseMinutes) / rowTiming.minutesPerPixel);
    const desiredOffset = Math.max(80, Math.min(220, viewportHeight * 0.38));
    setScrollTop(scroller, getScrollTop(scroller) + targetY - viewportTop - desiredOffset);
  }

  function compactEventText(event) {
    const text = String(event.text || event.colorMeaning || event.campus || '占用').replace(/\s+/g, ' ').trim();
    return text.length > 32 ? `${text.slice(0, 32)}...` : text;
  }

  function buildDateRange(startDate, endDate) {
    const dates = [];
    const cursor = new Date(`${startDate}T00:00:00`);
    const end = new Date(`${endDate}T00:00:00`);
    let guard = 0;
    while (!Number.isNaN(cursor.getTime()) && cursor <= end && guard < 370) {
      dates.push(formatDateInput(cursor));
      cursor.setDate(cursor.getDate() + 1);
      guard += 1;
    }
    return dates;
  }

  function isIsoDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const date = new Date(`${value}T00:00:00`);
    return !Number.isNaN(date.getTime()) && formatDateInput(date) === value;
  }

  function summarizeAnomalyKinds(anomalies) {
    const counts = new Map();
    (anomalies || []).forEach((anomaly) => {
      counts.set(anomaly.kind, (counts.get(anomaly.kind) || 0) + 1);
    });
    return Array.from(counts.entries())
      .map(([kind, count]) => (count > 1 ? `${kind} x${count}` : kind))
      .join('、');
  }

  function summarizeAnomalyReasons(anomalies) {
    const reasons = Array.from(new Set((anomalies || [])
      .map(formatVisibleAnomalyReason)
      .filter(Boolean)));
    if (!reasons.length) return '';
    const visible = reasons.slice(0, 2).join('；');
    return reasons.length > 2 ? `${visible}；另 ${reasons.length - 2} 条原因` : visible;
  }

  function formatVisibleAnomalyReason(anomaly) {
    if (!anomaly) return '';
    if (anomaly.kind === '未改校区') return '未改校区';
    return String(anomaly.reason || '').trim();
  }

  function groupAnomaliesByTeacherDate(anomalies) {
    const groups = new Map();
    anomalies.forEach((anomaly) => {
      const key = `${anomaly.teacher}||${anomaly.date}`;
      if (!groups.has(key)) {
        groups.set(key, {
          teacher: anomaly.teacher,
          date: anomaly.date,
          anomalies: []
        });
      }
      groups.get(key).anomalies.push(anomaly);
    });
    return Array.from(groups.values());
  }

  async function locateAnomalyGroup(group) {
    if (!group || !group.anomalies.length) return;
    const first = group.anomalies[0];
    await locateAnomaly(first, group.anomalies, group);
  }

  async function locateAnomaly(anomaly, anomaliesToMark, group, targetOverride = null) {
    const scroller = findScrollContainer();
    const target = targetOverride || anomaly.current || anomaly.relatedEvents?.[0] || anomaly.previous;
    const locatedRow = await locateTeacherRow(scroller, group || anomaly, target);
    clearMarkers();
    if (locatedRow) {
      scrollAnomalyEventIntoView(locatedRow, anomaly, target);
      await sleep(80);
      markTeacherDayCell(locatedRow, anomaly.date);
    }
    const markedCount = markAnomalyEventsBatch(anomaliesToMark || [anomaly]);
    if (locatedRow) {
      setStatus(`已定位：${anomaly.teacher} ${anomaly.date}，已标记 ${markedCount} 个可见色块。`);
    } else {
      setStatus(`暂时没在可见区找到：${anomaly.teacher} ${anomaly.date}。可以先点“全表扫描”刷新索引后再定位。`);
    }
  }

  async function locateTeacherRow(scroller, groupOrAnomaly, targetEvent) {
    const teacher = groupOrAnomaly.teacher;
    const date = groupOrAnomaly.date;
    const visibleRow = findVisibleTeacherRow(teacher);
    if (visibleRow) {
      alignTeacherDateInView(visibleRow, date);
      return visibleRow;
    }

    const candidates = buildLocateCandidates(teacher, date, targetEvent, scroller);

    for (const position of candidates) {
      setScrollTop(scroller, position);
      const row = await waitForVisibleTeacherRow(teacher, CONFIG.scanPauseMs + 180);
      if (row) {
        alignTeacherDateInView(row, date);
        return row;
      }
    }

    const row = findVisibleTeacherRow(teacher);
    if (row) {
      alignTeacherDateInView(row, date);
      return row;
    }
    return null;
  }

  function buildLocateCandidates(teacher, date, targetEvent, scroller = findScrollContainer()) {
    const primary = [];
    const fallback = [];
    const add = (value) => {
      if (!Number.isFinite(value)) return;
      const candidate = Math.max(0, Math.round(value));
      if (candidate <= 0) fallback.push(candidate);
      else primary.push(candidate);
    };

    primary.push(Math.max(0, Math.round(getScrollTop(scroller))));
    add(targetEvent?.scanTop);
    state.lastEvents
      .filter((event) => event.teacher === teacher && event.date === date)
      .forEach((event) => add(event.scanTop));
    state.lastEvents
      .filter((event) => event.teacher === teacher)
      .forEach((event) => add(event.scanTop));

    const maxTop = getMaxScrollTop(scroller);
    const expanded = [];
    primary.concat(fallback).forEach((value) => {
      [value, value - 360, value + 360, value - 720, value + 720].forEach((candidate) => {
        expanded.push(Math.min(maxTop, Math.max(0, candidate)));
      });
    });

    return Array.from(new Set(expanded.map((value) => Math.round(value))));
  }

  function scrollAnomalyEventIntoView(row, anomaly, targetEvent) {
    const event = targetEvent || anomaly?.current || anomaly?.previous || anomaly?.relatedEvents?.[0];
    const dateIndex = Number.isFinite(event?.dateIndex)
      ? event.dateIndex
      : getHeaderColumns().findIndex((column) => column.date === anomaly?.date);
    const cell = dateIndex >= 0 ? row.children[dateIndex + 3] : null;
    if (!cell) return;
    alignRowInScroller(row, findScrollContainer());
    alignCellInlineInScroller(cell);
    const rowTiming = getRowTiming(row);
    if (!Number.isFinite(event?.startMinutes) || !rowTiming || !Number.isFinite(rowTiming.minutesPerPixel)) return;
    const scroller = findScrollContainer();
    const rowRect = row.getBoundingClientRect();
    const targetY = rowRect.top + ((event.startMinutes - rowTiming.baseMinutes) / rowTiming.minutesPerPixel);
    const viewportTop = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
    const currentTop = getScrollTop(scroller);
    setScrollTop(scroller, currentTop + targetY - viewportTop - 180);
  }

  function alignRowInScroller(row, scroller = findScrollContainer()) {
    if (!row || !scroller) return;
    if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
      return;
    }
    const rowRect = row.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const delta = rowRect.top - scrollerRect.top - Math.max(40, (scrollerRect.height - rowRect.height) / 2);
    setScrollTop(scroller, getScrollTop(scroller) + delta);
  }

  function alignTeacherDateInView(row, date) {
    if (!row || !date) return null;
    const cell = getTeacherDayCell(row, date);
    if (cell) alignCellInlineInScroller(cell, { force: true });
    return cell;
  }

  function alignCellInlineInScroller(cell, options = {}) {
    const scroller = findHorizontalScrollContainer(cell);
    if (!cell || !scroller) return;
    const cellRect = cell.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const padding = 16;
    const isVisible = cellRect.left >= scrollerRect.left + padding
      && cellRect.right <= scrollerRect.right - padding;
    if (isVisible && !options.force) return;

    const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const cellWidth = Math.max(1, Math.min(cellRect.width || cell.offsetWidth || 1, scroller.clientWidth));
    const centerOffset = Math.max(padding, (scroller.clientWidth - cellWidth) / 2);
    const targetLeft = scroller.scrollLeft + cellRect.left - scrollerRect.left;
    scroller.scrollLeft = Math.min(maxLeft, Math.max(0, Math.round(targetLeft - centerOffset)));

    const nextRect = cell.getBoundingClientRect();
    if (nextRect.left < scrollerRect.left + padding || nextRect.right > scrollerRect.right - padding) {
      const delta = nextRect.left - scrollerRect.left - centerOffset;
      scroller.scrollLeft = Math.min(maxLeft, Math.max(0, Math.round(scroller.scrollLeft + delta)));
    }
  }

  function findHorizontalScrollContainer(element) {
    let current = element?.parentElement || null;
    let hiddenCandidate = null;
    while (current && current !== document.body) {
      if (isCcheckFloatingElement(current)) return null;
      const style = getComputedStyle(current);
      const hasOverflowX = current.scrollWidth > current.clientWidth + 16;
      if (hasOverflowX && /(auto|scroll|overlay)/.test(style.overflowX)) return current;
      if (hasOverflowX && !hiddenCandidate && /hidden/.test(style.overflowX)) hiddenCandidate = current;
      current = current.parentElement;
    }
    return hiddenCandidate;
  }

  async function waitForVisibleTeacherRow(teacher, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const row = findVisibleTeacherRow(teacher);
      if (row) return row;
      await sleep(40);
    }
    return null;
  }

  function findVisibleTeacherRow(teacher) {
    const expected = normalizeName(teacher);
    return Array.from(document.querySelectorAll('.row')).find((row) => {
      return normalizeName(textOf(row.children[0])) === expected;
    }) || null;
  }

  function markTeacherDayCell(row, date) {
    if (!row) return;
    const dateIndex = getHeaderColumns().findIndex((column) => column.date === date);
    const cell = dateIndex >= 0 ? row.children[dateIndex + 3] : null;
    if (!cell) return;
    cell.classList.add('ccheck-day-mark');
    state.currentMarkers.push(cell);
  }

  function collectAnomalyEventKeys(anomaly) {
    const keys = new Set();
    [anomaly.previous, anomaly.current].forEach((event) => {
      if (event?.key) keys.add(event.key);
    });
    (anomaly.blockingEvents || []).forEach((event) => {
      if (event?.key) keys.add(event.key);
    });
    (anomaly.relatedEvents || []).forEach((event) => {
      if (event?.key) keys.add(event.key);
    });
    return keys;
  }

  function markAnomalyEventsBatch(anomalies) {
    const keys = new Set();
    (anomalies || []).forEach((anomaly) => {
      collectAnomalyEventKeys(anomaly).forEach((key) => keys.add(key));
    });

    if (!keys.size) return 0;

    const visibleEvents = collectEvents(getScrollTop(findScrollContainer()))
      .filter((event) => keys.has(event.key));
    let markedCount = 0;

    visibleEvents.forEach((event) => {
      const matched = findVisibleElementForEvent(event);
      if (!matched || state.currentMarkers.includes(matched)) return;
      matched.classList.add('ccheck-mark');
      state.currentMarkers.push(matched);
      markedCount += 1;
    });

    return markedCount;
  }

  function findVisibleElementForEvent(event) {
    const rows = Array.from(document.querySelectorAll('.row'));
    for (const row of rows) {
      const rowChildren = Array.from(row.children);
      const teacher = textOf(row.children[0]).trim();
      if (teacher !== event.teacher) continue;
      if (event.type === 'dayOff') {
        return findRestLabelElementInCell(rowChildren[event.parentIndex]) || findRestLabelElementInScope(row);
      }
      for (const item of Array.from(row.querySelectorAll('.item'))) {
        const parentIndex = rowChildren.indexOf(item.parentElement);
        const text = textOf(item);
        const style = getComputedStyle(item);
        const hex = rgbToHex(style.backgroundColor);
        if (parentIndex === event.parentIndex && text === event.text && hex === event.hex) {
          return item;
        }
      }
    }
    return null;
  }

  function clearMarkers() {
    state.currentMarkers.forEach((element) => {
      if (element.classList.contains('ccheck-meeting-mark')) {
        element.remove();
        return;
      }
      element.classList.remove('ccheck-mark');
      element.classList.remove('ccheck-day-mark');
    });
    state.currentMarkers = [];
  }

  function exportCsv() {
    const result = state.lastResult;
    if (!result) {
      setStatus('还没有扫描结果，先扫描一次再导出。');
      return;
    }

    const rows = [
      ['老师', '日期', '类型', '休息/调休/上一节时间', '休息/调休/上一节校区', '休息/调休/上一节内容', '占用事件', '冲突/下一节时间', '冲突/下一节校区', '冲突/下一节内容', '可通勤分钟', '需要分钟', '原因']
    ];

    result.anomalies.forEach((anomaly) => {
      rows.push([
        anomaly.teacher,
        anomaly.date,
        anomaly.kind,
        `${anomaly.previous.start}-${anomaly.previous.end}`,
        anomaly.previous.campus,
        formatEventTextForExport(anomaly.previous),
        anomaly.blockingEvents.map((event) => `${event.start}-${event.end} ${formatEventTextForExport(event)}`).join('；'),
        `${anomaly.current.start}-${anomaly.current.end}`,
        anomaly.current.campus,
        formatEventTextForExport(anomaly.current),
        anomaly.availableMinutes == null ? '' : String(anomaly.availableMinutes),
        anomaly.requiredMinutes == null ? '' : String(anomaly.requiredMinutes),
        anomaly.reason
      ]);
    });

    const csv = '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `校区通勤异常_${formatDateForFile(new Date())}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus('CSV 已导出。');
  }

  function formatEventTextForExport(event) {
    if (!event) return '';
    const details = [];
    if (event.courseForm) details.push(event.courseForm);
    if (event.courseCampus) details.push(event.courseCampus);
    const suffix = details.length ? `（${details.join('，')}）` : '';
    return `${event.text || ''}${suffix}`;
  }

  function exportDebugData() {
    let events = [];
    if (Array.isArray(state.lastEvents) && state.lastEvents.length) {
      events = state.lastEvents;
    } else {
      try {
        events = collectEvents(getScrollTop(findScrollContainer()));
      } catch (error) {
        console.warn('[campus-commute-checker] 导出诊断时页面事件采集失败，仍会导出接口诊断。', error);
      }
    }
    const result = analyze(events, readSettings());
    const data = {
      version: SCRIPT_VERSION,
      exportedAt: new Date().toISOString(),
      url: location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      },
      inputs: collectInputSnapshot(),
      headerColumns: getHeaderColumns(),
      scanSummary: {
        totalEvents: result.totalEvents,
        restMarkers: result.restMarkers,
        anomalies: result.anomalies.length,
        unknownColors: result.unknownColors
      },
      diagramSummary: collectDiagramSummary(),
      events: events.map((event) => ({
        teacher: event.teacher,
        date: event.date,
        type: event.type,
        campus: event.campus,
        courseForm: event.courseForm || '',
        detailCampus: event.detailCampus || '',
        courseCampus: event.courseCampus || '',
        colorMeaning: event.colorMeaning || '',
        text: event.text,
        hex: event.hex,
        start: event.start,
        end: event.end,
        source: event.source || '',
        parentIndex: event.parentIndex,
        rect: event.rect
      })),
      restDomTextMatches: collectVisibleRestTextMatches(document.body).map(serializeRestMatch),
      restPseudoMatches: collectVisiblePseudoRestMatches(document.body).map(serializeRestMatch),
      rows: collectRowSnapshots(),
      visualProbe: collectVisualProbe(),
      resources: collectResourceSnapshot(),
      networkLogs: state.networkLogs
    };

    downloadTextFile(
      `校区通勤诊断_${formatDateForFile(new Date())}.json`,
      JSON.stringify(data, null, 2),
      'application/json;charset=utf-8'
    );
    setStatus(`v${SCRIPT_VERSION} 诊断数据已导出。若刚刷新页面后没有点搜索，请点一次搜索后再导出。`);
  }

  function collectDiagramSummary() {
    const data = state.latestDiagramData;
    if (!data) return null;
    return {
      receivedAt: data.receivedAt,
      dates: data.dates,
      teachers: (data.teachers || []).map((teacher) => ({
        name: teacher.name,
        rest_type: teacher.rest_type,
        is_rest_week: teacher.is_rest_week,
        fixed_rest_day: teacher.fixed_rest_day,
        other_rest_day: teacher.other_rest_day,
        rest_datesSample: String(teacher.rest_dates || '').slice(0, 2000),
        course_schedule: Array.isArray(teacher.course_schedule)
          ? teacher.course_schedule.map((schedule) => ({
            date: schedule.date,
            is_rest_date: schedule.is_rest_date,
            keys: Object.keys(schedule || {})
          }))
          : []
      })),
      samples: collectDiagramSamples(data)
    };
  }

  function collectDiagramSamples(data) {
    return (data.teachers || []).slice(0, 6).map((teacher) => ({
      teacherKeys: Object.keys(teacher || {}),
      teacherSample: shallowCloneForDebug(teacher),
      course_schedule: Array.isArray(teacher.course_schedule)
        ? teacher.course_schedule.slice(0, 4).map((schedule) => ({
          scheduleKeys: Object.keys(schedule || {}),
          scheduleSample: shallowCloneForDebug(schedule),
          arrayFields: Object.keys(schedule || {})
            .filter((key) => Array.isArray(schedule[key]))
            .map((key) => ({
              key,
              length: schedule[key].length,
              itemKeys: schedule[key][0] && typeof schedule[key][0] === 'object' ? Object.keys(schedule[key][0]) : [],
              firstItems: schedule[key].slice(0, 3).map((item) => shallowCloneForDebug(item))
            }))
        }))
        : []
    }));
  }

  function shallowCloneForDebug(value) {
    if (!value || typeof value !== 'object') return value;
    const result = {};
    Object.keys(value).forEach((key) => {
      const item = value[key];
      if (Array.isArray(item)) {
        result[key] = `[Array(${item.length})]`;
      } else if (item && typeof item === 'object') {
        result[key] = '[Object]';
      } else {
        result[key] = String(item == null ? '' : item).slice(0, 500);
      }
    });
    return result;
  }

  function collectInputSnapshot() {
    return Array.from(document.querySelectorAll('input, select, textarea')).map((element) => ({
      tag: element.tagName.toLowerCase(),
      type: element.type || '',
      placeholder: element.getAttribute('placeholder') || '',
      value: element.value || '',
      text: textOf(element).slice(0, 200),
      className: String(element.className || '').slice(0, 200),
      rect: serializeRect(element.getBoundingClientRect())
    }));
  }

  function collectRowSnapshots() {
    return Array.from(document.querySelectorAll('.row')).slice(0, 20).map((row, rowIndex) => ({
      rowIndex,
      text: textOf(row).slice(0, 2000),
      rect: serializeRect(row.getBoundingClientRect()),
      outerHTMLSnippet: row.outerHTML.slice(0, 10000),
      children: Array.from(row.children).map((child, childIndex) => ({
        childIndex,
        tag: child.tagName.toLowerCase(),
        className: String(child.className || '').slice(0, 300),
        text: textOf(child).slice(0, 1000),
        style: String(child.getAttribute('style') || '').slice(0, 500),
        backgroundImage: String(getComputedStyle(child).backgroundImage || '').slice(0, 500),
        rect: serializeRect(child.getBoundingClientRect()),
        before: cssContentText(getComputedStyle(child, '::before').content),
        after: cssContentText(getComputedStyle(child, '::after').content)
      })),
      items: Array.from(row.querySelectorAll('.item')).map((item, itemIndex) => ({
        itemIndex,
        text: textOf(item),
        className: String(item.className || '').slice(0, 300),
        backgroundColor: getComputedStyle(item).backgroundColor,
        top: getComputedStyle(item).top,
        height: getComputedStyle(item).height,
        rect: serializeRect(item.getBoundingClientRect())
      }))
    }));
  }

  function collectVisualProbe() {
    const rows = Array.from(document.querySelectorAll('.row')).slice(0, 8);
    const probes = [];
    rows.forEach((row, rowIndex) => {
      const rowRect = row.getBoundingClientRect();
      const dateCell = row.children[3] || row;
      const dateRect = dateCell.getBoundingClientRect();
      const x = Math.round(dateRect.left + Math.min(90, Math.max(20, dateRect.width / 2)));
      const yPoints = [0.18, 0.32, 0.46, 0.60, 0.74, 0.88].map((ratio) => Math.round(rowRect.top + rowRect.height * ratio));

      yPoints.forEach((y) => {
        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return;
        probes.push({
          rowIndex,
          point: { x, y },
          elements: document.elementsFromPoint(x, y).slice(0, 8).map((element) => ({
            tag: element.tagName.toLowerCase(),
            className: String(element.className || '').slice(0, 300),
            text: textOf(element).slice(0, 500),
            rect: serializeRect(element.getBoundingClientRect()),
            before: cssContentText(getComputedStyle(element, '::before').content),
            after: cssContentText(getComputedStyle(element, '::after').content),
            backgroundColor: getComputedStyle(element).backgroundColor
          }))
        });
      });
    });
    return probes;
  }

  function collectResourceSnapshot() {
    return performance.getEntriesByType('resource')
      .slice(-80)
      .map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        duration: Math.round(entry.duration),
        transferSize: entry.transferSize || 0
      }));
  }

  function serializeRestMatch(item) {
    return {
      source: item.source,
      text: item.text,
      tag: item.element.tagName.toLowerCase(),
      className: String(item.element.className || '').slice(0, 300),
      rect: serializeRect(item.rect),
      elementText: textOf(item.element).slice(0, 800),
      before: cssContentText(getComputedStyle(item.element, '::before').content),
      after: cssContentText(getComputedStyle(item.element, '::after').content)
    };
  }

  function classifyColor(hex) {
    const campus = CONFIG.campusByColor[hex];
    if (campus && CONFIG.realCampuses.has(campus)) {
      return { type: 'real', campus, meaning: campus };
    }
    if (campus === '虚拟校区') {
      return { type: 'online', campus, meaning: '虚拟校区' };
    }
    const onlineMeaning = CONFIG.onlineByColor[hex];
    if (onlineMeaning) {
      return { type: 'online', campus: onlineMeaning, meaning: onlineMeaning };
    }
    return { type: 'unknown', campus: '未知颜色', meaning: '未知颜色' };
  }

  function getCommuteMinutes(fromCampus, toCampus) {
    if (!fromCampus || !toCampus || fromCampus === toCampus) return 0;
    const direct = CONFIG.commuteRules[`${fromCampus}|${toCampus}`];
    if (direct != null) return direct;
    const reverse = CONFIG.commuteRules[`${toCampus}|${fromCampus}`];
    if (reverse != null) return reverse;
    if (
      fromCampus === '下沙校区'
      || toCampus === '下沙校区'
      || fromCampus === '小和山校区'
      || toCampus === '小和山校区'
    ) {
      return 90;
    }
    return null;
  }

  function getHeaderColumns() {
    const baseDate = getBaseDate();
    return Array.from(document.querySelectorAll('.header .th')).slice(3).map((element, index) => ({
      label: textOf(element),
      date: parseScheduleHeaderDate(textOf(element), baseDate) || addDays(baseDate, index)
    }));
  }

  function getBaseDate() {
    const input = Array.from(document.querySelectorAll('input')).find((item) => item.placeholder === '开始日期');
    const value = input && /^\d{4}-\d{2}-\d{2}$/.test(input.value) ? input.value : '';
    return value || formatDateInput(new Date());
  }

  function parseScheduleHeaderDate(label, baseDate) {
    const text = String(label || '').replace(/\s+/g, '');
    const zhMatch = text.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日?/);
    if (zhMatch) {
      const year = zhMatch[1] ? Number(zhMatch[1]) : null;
      return resolveScheduleHeaderDate(year, Number(zhMatch[2]), Number(zhMatch[3]), baseDate);
    }

    const slashMatch = text.match(/(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})/);
    if (slashMatch) {
      const year = slashMatch[1] ? Number(slashMatch[1]) : null;
      return resolveScheduleHeaderDate(year, Number(slashMatch[2]), Number(slashMatch[3]), baseDate);
    }
    return '';
  }

  function resolveScheduleHeaderDate(year, month, day, baseDate) {
    if (!Number.isInteger(month) || !Number.isInteger(day)) return '';
    if (year) return buildValidatedDate(year, month, day);

    const base = parseDateValue(baseDate) || new Date();
    const baseYear = base.getFullYear();
    return [baseYear - 1, baseYear, baseYear + 1]
      .map((candidateYear) => ({
        date: buildValidatedDate(candidateYear, month, day),
        distance: Math.abs(new Date(candidateYear, month - 1, day).getTime() - base.getTime())
      }))
      .filter((candidate) => candidate.date)
      .sort((a, b) => a.distance - b.distance)[0]?.date || '';
  }

  function buildValidatedDate(year, month, day) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return '';
    const date = new Date(year, month - 1, day);
    if (Number.isNaN(date.getTime())) return '';
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return '';
    return formatDateInput(date);
  }

  function formatHeaderDateRange(headerColumns) {
    const dates = (headerColumns || []).map((column) => column.date).filter(isIsoDate).sort();
    if (!dates.length) return '';
    return dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} 至 ${dates[dates.length - 1]}`;
  }

  function getRowTiming(row) {
    const timeNodes = Array.from(row.querySelectorAll('.text.time'))
      .map((element) => ({
        text: textOf(element),
        top: element.getBoundingClientRect().y - row.getBoundingClientRect().y
      }))
      .filter((item) => /^\d{2}:\d{2}$/.test(item.text));

    if (timeNodes.length >= 2) {
      const first = timeNodes[0];
      const second = timeNodes.find((item) => parseClockMinutes(item.text) > parseClockMinutes(first.text));
      if (second) {
        const minuteDelta = parseClockMinutes(second.text) - parseClockMinutes(first.text);
        const pixelDelta = second.top - first.top;
        if (pixelDelta > 0) {
          return {
            baseMinutes: parseClockMinutes(first.text),
            minutesPerPixel: minuteDelta / pixelDelta
          };
        }
      }
    }

    return {
      baseMinutes: 9 * 60,
      minutesPerPixel: CONFIG.defaultMinutesPerPixel
    };
  }

  function findScrollContainer() {
    const scale = document.querySelector('.scale');
    let current = scale;
    let fallback = null;
    while (current && current !== document.body) {
      if (!isCcheckFloatingElement(current) && current.scrollHeight > current.clientHeight + 80) {
        if (isScrollableByStyle(current, 'y')) return current;
        if (!fallback) fallback = current;
      }
      current = current.parentElement;
    }
    const candidates = Array.from(document.querySelectorAll('div'))
      .filter((element) => !isCcheckFloatingElement(element))
      .filter((element) => element.scrollHeight > element.clientHeight + 80);
    const styledCandidate = candidates
      .filter((element) => isScrollableByStyle(element, 'y'))
      .sort((a, b) => b.scrollHeight - a.scrollHeight);
    return styledCandidate[0]
      || fallback
      || candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
      || document.scrollingElement
      || document.documentElement;
  }

  function isCcheckFloatingElement(element) {
    return Boolean(element?.closest?.('#ccheck-panel, #ccheck-draft-modal, #ccheck-attendee-helper, #ccheck-meeting-draft-note'));
  }

  function isScrollableByStyle(element, axis) {
    const style = getComputedStyle(element);
    const overflow = axis === 'x' ? style.overflowX : style.overflowY;
    return /(auto|scroll|overlay)/.test(overflow);
  }

  function getScanStep(scroller) {
    const firstRow = document.querySelector('.row');
    const rowHeight = firstRow ? firstRow.getBoundingClientRect().height : 480;
    const viewport = scroller === document.scrollingElement
      ? window.innerHeight
      : scroller.clientHeight;
    const safeStep = Math.max(220, viewport - rowHeight / 2);
    return Math.min(600, safeStep);
  }

  function buildScanPositions(oldTop, maxTop, step) {
    const positions = [];
    for (let pos = 0; pos <= maxTop; pos += step) {
      positions.push(Math.round(pos));
      if (positions.length > CONFIG.maxScanSteps) break;
    }
    positions.push(maxTop, oldTop);
    return Array.from(new Set(positions.filter((pos) => pos >= 0 && pos <= maxTop))).sort((a, b) => a - b);
  }

  function readSettings() {
    return {
      adjacentGapMinutes: clampNumber(
        Number(document.getElementById('ccheck-adjacent')?.value),
        CONFIG.defaultAdjacentGapMinutes,
        0,
        60
      ),
      onlinePressureBufferMinutes: clampNumber(
        Number(document.getElementById('ccheck-buffer')?.value),
        CONFIG.defaultOnlinePressureBufferMinutes,
        0,
        180
      )
    };
  }

  function setButtonsDisabled(disabled) {
    document.querySelectorAll('#ccheck-panel .ccheck-btn').forEach((button) => {
      button.disabled = disabled;
    });
  }

  function setStatus(message) {
    const status = document.getElementById('ccheck-status');
    if (status) status.textContent = message;
  }

  function getScrollTop(scroller) {
    return scroller === document.scrollingElement ? window.scrollY : scroller.scrollTop;
  }

  function setScrollTop(scroller, value) {
    if (scroller === document.scrollingElement) {
      window.scrollTo(0, value);
    } else {
      scroller.scrollTop = value;
    }
  }

  function getMaxScrollTop(scroller) {
    if (scroller === document.scrollingElement) {
      return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    }
    return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  }

  function compareByTime(a, b) {
    return a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes || a.text.localeCompare(b.text, 'zh-CN');
  }

  function textOf(element) {
    if (!element) return '';
    return (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function rgbToHex(rgb) {
    const match = String(rgb).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!match) return String(rgb).toUpperCase();
    return '#' + [match[1], match[2], match[3]]
      .map((value) => Number(value).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  function parseCssNumber(value, fallback) {
    const match = String(value || '').match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : fallback;
  }

  function parseClockMinutes(value) {
    const [hour, minute] = String(value).split(':').map(Number);
    return hour * 60 + minute;
  }

  function formatMinutes(totalMinutes) {
    const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
    const hour = Math.floor(normalized / 60);
    const minute = normalized % 60;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  function roundToFive(value) {
    return Math.round(value / 5) * 5;
  }

  function addDays(dateText, days) {
    const date = new Date(`${dateText}T00:00:00`);
    date.setDate(date.getDate() + days);
    return formatDateInput(date);
  }

  function formatDateInput(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function formatShortDate(dateText) {
    const parts = parseIsoDateParts(dateText);
    return parts ? `${parts.month}.${parts.day}` : String(dateText || '');
  }

  function formatDateForFile(date) {
    return `${formatDateInput(date)}_${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function clampNumber(value, fallback, min, max) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }

  function csvCell(value) {
    const text = String(value == null ? '' : value);
    return `"${text.replace(/"/g, '""')}"`;
  }

  function serializeRect(rect) {
    if (!rect) return null;
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      left: Math.round(rect.left)
    };
  }

  function downloadTextFile(filename, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleInit, { once: true });
  } else {
    scheduleInit();
  }
  installRouteWatcher();
  installRoutePoller();
})();
