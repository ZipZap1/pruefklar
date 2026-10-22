/* Prüfklar – Fristenrechner (rechner.html)
   Läuft vollständig im Browser: keine Cookies, kein localStorage, keine Netzwerkanfragen.
   Nur wer das Erinnerungsformular absendet, überträgt E-Mail, Anlage und Termine an Brevo.
   Einzige Pflegestelle für Intervalle und Normen ist die Tabelle #intervalle in rechner.html. */
(() => {
  'use strict';

  const SOON_DAYS = 30; // "Bald fällig" wie der 30-Tage-Ring im Radar der Startseite
  const DAY_MS = 86_400_000;
  const MIN_DATE = '1990-01-01';
  const MAX_REMINDER_DAYS = 720; // Brevo hält den Einwilligungsnachweis (Logs) höchstens 24 Monate
  const ICS_MAX_OCTETS = 75; // RFC 5545, Abschnitt 3.1: Zeilen falten
  const PAGE_URL = 'https://zipzap1.github.io/pruefklar/rechner.html';
  const BREVO_PLACEHOLDER = 'BREVO_FORMULAR_URL';

  const byId = (id) => document.getElementById(id);
  const el = {
    form: byId('calc-form'),
    noscript: byId('calc-noscript'),
    anlage: byId('calc-anlage'),
    facts: byId('calc-facts'),
    factIntervall: byId('calc-fact-intervall'),
    factGrundlage: byId('calc-fact-grundlage'),
    factWer: byId('calc-fact-wer'),
    factHinweis: byId('calc-fact-hinweis'),
    datum: byId('calc-datum'),
    datumLabel: byId('calc-datum-label'),
    datumError: byId('calc-datum-error'),
    bez: byId('calc-bez'),
    live: byId('calc-live'),
    result: byId('calc-result'),
    due: byId('calc-due'),
    status: byId('calc-status'),
    grace: byId('calc-grace'),
    actions: byId('calc-actions'),
    lead: byId('calc-lead'),
    ics: byId('calc-ics'),
    overdue: byId('calc-overdue'),
    far: byId('calc-far'),
    remind: byId('remind-form'),
    remindFields: byId('remind-fields'),
    remindUnavailable: byId('remind-unavailable'),
    remindDate: byId('remind-date'),
    remindWhy: byId('remind-why'),
    remindWaitlist: byId('remind-warteliste'),
    remindAnlage: byId('remind-anlage'),
    remindFaellig: byId('remind-faellig'),
    remindErinnerung: byId('remind-erinnerung'),
  };

  /* Kalendertage als UTC-Mitternacht: keine Sprünge durch Sommer-/Winterzeit */
  const todayUtc = () => {
    const now = new Date();
    return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  };

  const parseIsoDate = (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const [year, month, day] = match.slice(1).map(Number);
    const time = Date.UTC(year, month - 1, day);
    const check = new Date(time);
    return check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? time : null;
  };

  /* Monatsende wird gekappt: 31.01. + 1 Monat = 28./29.02. */
  const addMonths = (time, months) => {
    const date = new Date(time);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + months;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay));
  };

  const addDays = (time, days) => time + days * DAY_MS;
  const daysBetween = (from, to) => Math.round((to - from) / DAY_MS);
  const isoDate = (time) => new Date(time).toISOString().slice(0, 10);

  const fmtLong = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  const fmtShort = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });

  /* Datumsattribut im Brevo-Formular (Kontoeinstellung DD-MM-YYYY): TT-MM-JJJJ */
  const brevoDate = (time) => isoDate(time).split('-').reverse().join('-');

  const normalize = (text) => text.replace(/\s+/g, ' ').trim();
  const plural = (count, one, many) => `${count.toLocaleString('de-DE')} ${count === 1 ? one : many}`;

  /* Katalog aus der Tabelle lesen */
  const fieldText = (row, name) => {
    const node = row.querySelector(`[data-field="${name}"]`);
    return node ? normalize(node.textContent) : '';
  };

  const readCatalog = () => Array.from(document.querySelectorAll('#intervalle tr[data-id]'), (row) => Object.freeze({
    id: row.dataset.id,
    months: Number(row.dataset.months),
    graceMonths: Number(row.dataset.grace || 0), // zulässige Überschreitung, z. B. Rauchwarnmelder 3 Monate
    basis: row.dataset.basis || 'Letzte Prüfung',
    anlage: fieldText(row, 'anlage'),
    pruefung: fieldText(row, 'pruefung'),
    intervall: fieldText(row, 'intervall'),
    grundlage: fieldText(row, 'grundlage'),
    wer: fieldText(row, 'wer'),
    hinweis: fieldText(row, 'hinweis'),
  })).filter((entry) => Number.isInteger(entry.months) && entry.months > 0);

  const fillSelect = (select, catalog) => {
    const groups = new Map();
    catalog.forEach((entry) => groups.set(entry.anlage, [...(groups.get(entry.anlage) || []), entry]));
    groups.forEach((entries, anlage) => {
      const group = document.createElement('optgroup');
      group.label = anlage;
      // Volle Bezeichnung, damit die geschlossene Auswahl eindeutig bleibt ("Aufzug · Hauptprüfung")
      entries.forEach((entry) => group.append(new Option(`${entry.anlage} · ${entry.pruefung}`, entry.id)));
      select.append(group);
    });
  };

  /* Berechnung (rein, ohne DOM) */
  const computeDue = (entry, last, today, leadDays) => {
    const due = addMonths(last, entry.months);
    const plannedReminder = addDays(due, -leadDays);
    const reminder = Math.max(plannedReminder, addDays(today, 1));
    const latest = entry.graceMonths > 0 ? addMonths(last, entry.months + entry.graceMonths) : null;
    return Object.freeze({
      due,
      days: daysBetween(today, due),
      latest,
      inGrace: latest !== null && due < today && today <= latest,
      reminder,
      reminderMoved: plannedReminder <= today,
      reminderTooFar: daysBetween(today, reminder) > MAX_REMINDER_DAYS,
    });
  };

  /* Bis 60 Tage genau, danach gerundet: "in rund 11 Monaten", "seit rund 5 Jahren" */
  const spanText = (days) => {
    if (days <= 60) return plural(days, 'Tag', 'Tagen');
    if (days <= 730) return `rund ${plural(Math.round(days / 30.44), 'Monat', 'Monaten')}`;
    return `rund ${plural(Math.round(days / 365.25), 'Jahr', 'Jahren')}`;
  };

  const describeStatus = ({ days, inGrace }) => {
    if (days < 0 && inGrace) return { tone: 's-soon', text: `Fällig seit ${spanText(-days)}` };
    if (days < 0) return { tone: 's-overdue', text: `Überfällig seit ${spanText(-days)}` };
    if (days === 0) return { tone: 's-overdue', text: 'Heute fällig' };
    if (days <= SOON_DAYS) return { tone: 's-soon', text: `Bald fällig · in ${spanText(days)}` };
    return { tone: 's-plan', text: `In ${spanText(days)}` };
  };

  const dateProblem = (value, last, today) => {
    if (!value) return '';
    if (last === null) return 'Bitte geben Sie ein gültiges Datum ein.';
    if (last > today) return 'Das Datum liegt in der Zukunft. Bitte geben Sie das Datum der letzten durchgeführten Prüfung ein.';
    if (last < parseIsoDate(MIN_DATE)) return 'Bitte prüfen Sie das Datum – es liegt vor 1990.';
    return '';
  };

  /* Kalenderdatei nach RFC 5545 */
  const escapeIcs = (text) => text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

  const foldIcsLine = (line) => {
    const encoder = new TextEncoder();
    const parts = [];
    let current = '';
    let octets = 0;
    for (const char of line) {
      const size = encoder.encode(char).length;
      if (octets + size > ICS_MAX_OCTETS) {
        parts.push(current);
        current = ' ';
        octets = 1;
      }
      current += char;
      octets += size;
    }
    return [...parts, current].join('\r\n');
  };

  const icsStamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const icsDay = (time) => isoDate(time).replace(/-/g, '');
  const randomId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

  const buildIcs = ({ entry, last, label, leadDays, result }) => {
    const title = `Prüfung fällig: ${entry.anlage} – ${entry.pruefung}${label ? ` (${label})` : ''}`;
    const description = [
      `Intervall: ${entry.intervall}`,
      `Grundlage: ${entry.grundlage}`,
      `Wer prüft: ${entry.wer}`,
      `${entry.basis}: ${fmtShort.format(last)}`,
      ...(entry.hinweis ? [`Hinweis: ${entry.hinweis}`] : []),
      '',
      'Typisches Intervall zur Orientierung, keine Rechtsberatung. Maßgeblich sind die für Ihre Anlage geltenden Vorschriften und Herstellerangaben.',
      `Berechnet mit dem Prüfklar-Fristenrechner: ${PAGE_URL}`,
    ].join('\n');
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pruefklar//Fristenrechner//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${randomId()}@pruefklar`,
      `DTSTAMP:${icsStamp(new Date())}`,
      `DTSTART;VALUE=DATE:${icsDay(result.due)}`,
      `DTEND;VALUE=DATE:${icsDay(addDays(result.due, 1))}`,
      `SUMMARY:${escapeIcs(title)}`,
      `DESCRIPTION:${escapeIcs(description)}`,
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeIcs(title)}`, `TRIGGER:-P${leadDays}D`, 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR',
    ];
    return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
  };

  const downloadFile = (name, content, type) => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  /* Zustand: wird bei jeder Änderung neu aus den Eingaben abgeleitet */
  const catalog = readCatalog();
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
  /* Zwei Brevo-Formulare: A nur Erinnerung, B Erinnerung plus Warteliste (je eigener DOI-Text).
     Die Warteliste-Checkbox hat keinen name; sie wählt beim Absenden nur das Formular. */
  const formActions = { remind: el.remind.getAttribute('action'), waitlist: el.remind.dataset.actionWaitlist || '' };
  const brevoReady = Object.values(formActions).every((url) => url && !url.includes(BREVO_PLACEHOLDER));

  const readState = () => {
    const entry = catalogById.get(el.anlage.value) || null;
    const today = todayUtc();
    const last = parseIsoDate(el.datum.value);
    const problem = dateProblem(el.datum.value, last, today);
    if (!entry || last === null || problem) return { entry, problem, result: null };
    const leadDays = Number(el.lead.value);
    return { entry, problem, last, leadDays, label: normalize(el.bez.value), result: computeDue(entry, last, today, leadDays) };
  };

  /* Darstellung */
  const renderFacts = (entry) => {
    el.facts.hidden = !entry;
    el.datumLabel.textContent = entry ? entry.basis : 'Letzte Prüfung';
    if (!entry) return;
    el.factIntervall.textContent = entry.intervall;
    el.factGrundlage.textContent = entry.grundlage;
    el.factWer.textContent = entry.wer;
    el.factHinweis.textContent = entry.hinweis;
    el.factHinweis.hidden = !entry.hinweis;
  };

  const renderDateProblem = (problem) => {
    el.datumError.textContent = problem;
    el.datumError.hidden = !problem;
    el.datum.setAttribute('aria-invalid', problem ? 'true' : 'false');
  };

  const renderGrace = (latest) => {
    el.grace.hidden = !latest;
    if (!latest) return;
    el.grace.textContent = `Noch fristgerecht bis ${fmtShort.format(latest)}.`;
  };

  const renderReminder = ({ entry, result }) => {
    const leadText = el.lead.selectedOptions[0].text.replace(/ vorher$/, '');
    el.remindDate.textContent = fmtShort.format(result.reminder);
    el.remindWhy.textContent = result.reminderMoved
      ? ` – die Fälligkeit ist näher als ${leadText}`
      : ` – ${leadText} vor der Fälligkeit`;
    el.remindAnlage.value = `${entry.anlage} – ${entry.pruefung}`;
    el.remindFaellig.value = fmtShort.format(result.due); // Textattribut, nur zur Anzeige in der E-Mail
    el.remindErinnerung.value = brevoDate(result.reminder); // Datumsattribut, löst die Automation aus
  };

  const clearReminder = () => {
    el.remindAnlage.value = '';
    el.remindFaellig.value = '';
    el.remindErinnerung.value = '';
  };

  const announce = (state, status) => {
    el.live.textContent = state.result
      ? `Nächste Fälligkeit: ${fmtLong.format(state.result.due)}. ${status.text}.`
      : '';
  };

  const renderResult = (state) => {
    const { result } = state;
    const status = describeStatus(result);
    const isDue = result.days <= 0;
    const canRemind = !isDue && !result.reminderTooFar;
    el.due.textContent = fmtLong.format(result.due);
    el.due.dateTime = isoDate(result.due);
    el.status.className = `pill ${status.tone}`;
    el.status.textContent = status.text;
    renderGrace(result.latest);
    el.actions.hidden = isDue;
    el.overdue.hidden = !isDue;
    el.far.hidden = isDue || canRemind;
    el.remind.hidden = !canRemind;
    if (canRemind) renderReminder(state);
    else clearReminder();
    el.result.hidden = false;
    announce(state, status);
  };

  const hideResult = () => {
    el.result.hidden = true;
    el.remind.hidden = true;
    el.live.textContent = '';
    clearReminder();
  };

  const update = () => {
    const state = readState();
    renderFacts(state.entry);
    renderDateProblem(state.problem);
    if (state.result) renderResult(state);
    else hideResult();
  };

  /* Start */
  const preselect = () => {
    const wanted = new URLSearchParams(window.location.search).get('anlage');
    if (wanted && catalogById.has(wanted)) el.anlage.value = wanted;
  };

  const today = todayUtc();
  fillSelect(el.anlage, catalog);
  preselect();
  el.datum.min = MIN_DATE;
  el.datum.max = isoDate(today);
  el.remindFields.disabled = !brevoReady;
  el.remindUnavailable.hidden = brevoReady;
  el.form.hidden = false;
  el.noscript.hidden = true;
  update();

  el.form.addEventListener('submit', (event) => event.preventDefault());
  el.anlage.addEventListener('change', update);
  el.datum.addEventListener('input', update);
  el.datum.addEventListener('change', update);
  el.lead.addEventListener('change', update);

  el.ics.addEventListener('click', () => {
    const state = readState();
    if (!state.result) return;
    downloadFile(`pruefung-${state.entry.id}-${isoDate(state.result.due)}.ics`, buildIcs(state), 'text/calendar;charset=utf-8');
  });

  el.remind.addEventListener('submit', (event) => {
    const state = readState();
    if (!brevoReady || !state.result || state.result.days <= 0 || state.result.reminderTooFar) {
      event.preventDefault();
      return;
    }
    renderReminder(state); // Werte unmittelbar vor dem Absenden noch einmal setzen
    el.remind.action = el.remindWaitlist.checked ? formActions.waitlist : formActions.remind;
  });
})();
