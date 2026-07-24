// ============================================================
// OZ TANK - GOOGLE CALENDAR SYNC TO SUPABASE
// Version 13 - Move-aware reconciliation + actioned-row protection
//
// What changed vs v12:
//  1. MOVED EVENTS KEEP THEIR ROW. Before upserting, the script fetches
//     the existing DB rows and pairs "date disappeared" with "date
//     appeared" within the same (calendar, event id) group — a moved
//     event (including a dragged instance of a recurring series) gets
//     its event_date PATCHed on the SAME row, so the internal row id
//     survives and any tick status / POD / tank movement stays attached.
//  2. STALE CLEANUP NEVER DELETES ACTIONED ROWS. Before deleting rows
//     that vanished from the calendar, it checks calendar_event_status,
//     pods and tank_movements for references and keeps any row that has
//     history. (If the tick is later removed, the row becomes deletable
//     on a future run.)
//  3. Invoices calendar gets the same move-aware treatment, so invoiced
//     flags follow an invoice event when it changes date.
//
// This file is version-controlled in the oztank-pod-manager repo at
// docs/apps-script-calendar-sync.gs (with credential placeholders).
// The live copy runs in Google Apps Script (script.google.com).
// ============================================================

const CALENDARS = [
  { name: 'Allan', id: 'r14rmcv0p6uel5tvtp753ld2qo@group.calendar.google.com' },
  { name: 'Drew', id: 'i8u6mkve3jfpu06ljgfa5kn4eo@group.calendar.google.com' },
  { name: 'Matt', id: 'o4utbjuhpl3vn4nj0jl2urtf68@group.calendar.google.com' },
  { name: 'Michael', id: 'cq7t5e80e32o725kb58amgbh2k@group.calendar.google.com' },
  { name: 'Red', id: 'a00lotj6vc5n415gquspoet2tc@group.calendar.google.com' },
  { name: 'David', id: 'f80ddd3bc98fc42e512c5c9384ae27772445d844a61943558753012c2ed91a61@group.calendar.google.com' }
];

// Invoices calendar
const INVOICES_CALENDAR_ID = 'r8o4k8ucipqdc9b8mhaqdt5lss@group.calendar.google.com';

const SUPABASE_URL = 'PASTE-YOUR-SUPABASE-URL';
const SUPABASE_SERVICE_KEY = 'PASTE-YOUR-SERVICE-ROLE-KEY';

let KNOWN_SERVICE_DAYS = [];

// ============================================================
// MAIN SYNC FUNCTION
// ============================================================
function syncCalendarsToSupabase() {
  console.log('========================================');
  console.log('OZ TANK CALENDAR SYNC - Version 13');
  console.log('========================================');
  console.log('Start time: ' + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }));

  // Fetch known service days from database
  console.log('\n📋 Fetching known service days from database...');
  KNOWN_SERVICE_DAYS = fetchKnownServiceDays();
  console.log(`Found ${KNOWN_SERVICE_DAYS.length} known service days`);

  if (KNOWN_SERVICE_DAYS.length === 0) {
    console.log('❌ ERROR: No service days found in database. Aborting sync.');
    updateSyncStatus('error', 'No service days found in database');
    return;
  }

  // Date range: start of 2 months ago → end of 3 months ahead
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - 2);
  startDate.setDate(1);

  const endDate = new Date();
  endDate.setMonth(endDate.getMonth() + 3);
  endDate.setDate(0);

  console.log(`\n📅 Syncing events from ${formatDate(startDate)} to ${formatDate(endDate)}`);

  const syncRunId = new Date().toISOString();

  const allWorkerEvents = [];

  // Process each worker calendar
  for (const cal of CALENDARS) {
    console.log(`\n👤 Processing calendar: ${cal.name}`);

    try {
      const calendar = CalendarApp.getCalendarById(cal.id);

      if (!calendar) {
        console.log(`  ⚠️ Could not access calendar: ${cal.name}`);
        continue;
      }

      const events = calendar.getEvents(startDate, endDate);
      console.log(`  Found ${events.length} events`);

      for (const event of events) {
        const title = event.getTitle();
        const dateStr = formatDate(event.getStartTime());
        const serviceDayName = extractServiceDayName(title);
        const isKnownServiceDay = serviceDayName && KNOWN_SERVICE_DAYS.includes(serviceDayName);

        allWorkerEvents.push({
          event_id: event.getId(),
          calendar_owner: cal.name,
          event_date: dateStr,
          event_title: title,
          is_service_day: isKnownServiceDay,
          service_day_name: isKnownServiceDay ? serviceDayName : null,
          sync_run_id: syncRunId,
          description: event.getDescription() || null,
          location: event.getLocation() || null
        });
      }
    } catch (e) {
      console.log(`  ❌ Error processing ${cal.name}: ${e.message}`);
    }
  }

  // Deduplicate by calendar_owner + event_date + event_title
  const workerSeen = new Set();
  const deduplicatedWorkerEvents = allWorkerEvents.filter(e => {
    const key = `${e.calendar_owner}|${e.event_date}|${e.event_title}`;
    if (workerSeen.has(key)) return false;
    workerSeen.add(key);
    return true;
  });

  const dupCount = allWorkerEvents.length - deduplicatedWorkerEvents.length;

  // ── Move-aware reconciliation ─────────────────────────────
  // Pair rows whose date vanished with instances whose date appeared
  // (same calendar + google event id) and PATCH the existing row's date
  // so its internal id — and any ticks/PODs hanging off it — survives.
  console.log('\n🔎 Checking for moved events...');
  const existingRows = fetchExistingWorkerEvents(formatDate(startDate), formatDate(endDate));
  console.log(`  ${existingRows.length} existing rows in window`);
  const movedCount = reconcileMovedWorkerEvents(existingRows, deduplicatedWorkerEvents);
  console.log(`  ↪️ ${movedCount} moved event${movedCount === 1 ? '' : 's'} re-dated in place`);

  console.log(`\n📤 Syncing ${deduplicatedWorkerEvents.length} worker events to Supabase (${dupCount} duplicates removed)...`);

  if (deduplicatedWorkerEvents.length > 0) {
    const { success, inserted } = insertWorkerEvents(deduplicatedWorkerEvents);
    console.log(`  ✅ Upserted ${inserted} worker events`);

    if (success) {
      const removed = deleteStaleWorkerEvents(formatDate(startDate), formatDate(endDate), syncRunId);
      console.log(`  🗑️ Removed ${removed} stale orphan events (actioned rows protected)`);
    } else {
      console.log('  ⚠️ Some batches failed — skipping stale cleanup to avoid data loss');
    }
  }

  // Sync invoices calendar
  console.log('\n📄 Syncing invoices calendar...');
  syncInvoicesCalendar(startDate, endDate, syncRunId);

  const message = `Synced ${deduplicatedWorkerEvents.length} worker events (${movedCount} moves), invoices calendar synced`;
  updateSyncStatus('success', message);

  console.log('\n========================================');
  console.log(`✅ Sync complete! ${message}`);
  console.log('========================================');
}

// ============================================================
// WORKER EVENTS — FETCH EXISTING ROWS (paginated)
// ============================================================
function fetchExistingWorkerEvents(minDate, maxDate) {
  const rows = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/worker_calendar_events` +
      `?select=id,event_id,event_date,calendar_owner,event_title` +
      `&event_date=gte.${minDate}&event_date=lte.${maxDate}` +
      `&order=id.asc&limit=${pageSize}&offset=${offset}`;

    const response = UrlFetchApp.fetch(url, {
      method: 'GET',
      headers: supabaseHeaders(),
      muteHttpExceptions: true
    });

    if (response.getResponseCode() >= 400) {
      console.log(`  ❌ Fetch existing rows failed: ${response.getContentText()}`);
      return rows;
    }

    const batch = JSON.parse(response.getContentText());
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  return rows;
}

// ============================================================
// WORKER EVENTS — MOVE RECONCILIATION
// Within each (calendar_owner, event_id) group: dates that exist in
// the DB but not in the calendar are paired (in date order) with dates
// in the calendar but not the DB, and the DB row is re-dated in place.
// Handles: one-off moves, dragged recurring instances, and whole-series
// shifts. Unpaired leftovers fall through to normal insert / cleanup.
// ============================================================
function reconcileMovedWorkerEvents(existingRows, desiredEvents) {
  const groupKey = o => `${o.calendar_owner}|${o.event_id}`;

  const existingByKey = {};
  existingRows.forEach(r => {
    (existingByKey[groupKey(r)] = existingByKey[groupKey(r)] || []).push(r);
  });

  const desiredByKey = {};
  desiredEvents.forEach(e => {
    (desiredByKey[groupKey(e)] = desiredByKey[groupKey(e)] || []).push(e);
  });

  let patched = 0;

  for (const key in desiredByKey) {
    const desired = desiredByKey[key];
    const existing = existingByKey[key] || [];
    if (existing.length === 0) continue;

    const desiredDates = new Set(desired.map(e => e.event_date));
    const existingDates = new Set(existing.map(r => r.event_date));

    const missingRows = existing
      .filter(r => !desiredDates.has(r.event_date))
      .sort((a, b) => a.event_date.localeCompare(b.event_date));
    const newEvents = desired
      .filter(e => !existingDates.has(e.event_date))
      .sort((a, b) => a.event_date.localeCompare(b.event_date));

    const pairs = Math.min(missingRows.length, newEvents.length);
    for (let i = 0; i < pairs; i++) {
      const row = missingRows[i];
      const ev = newEvents[i];
      if (patchWorkerEventRow(row.id, ev)) {
        patched++;
        console.log(`  ↪️ Moved: "${ev.event_title}" ${row.event_date} → ${ev.event_date} (row ${row.id} kept)`);
      }
    }
  }

  return patched;
}

function patchWorkerEventRow(rowId, ev) {
  const url = `${SUPABASE_URL}/rest/v1/worker_calendar_events?id=eq.${rowId}`;

  const response = UrlFetchApp.fetch(url, {
    method: 'PATCH',
    headers: Object.assign(supabaseHeaders(), { 'Prefer': 'return=minimal' }),
    payload: JSON.stringify({
      event_date: ev.event_date,
      event_title: ev.event_title,
      description: ev.description,
      location: ev.location,
      is_service_day: ev.is_service_day,
      service_day_name: ev.service_day_name,
      sync_run_id: ev.sync_run_id
    }),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  if (code >= 400) {
    console.log(`  ❌ Patch row ${rowId} failed: ${code} - ${response.getContentText()}`);
    return false;
  }
  return true;
}

// ============================================================
// WORKER EVENTS — UPSERT
// Returns { success: boolean, inserted: number }
// ============================================================
function insertWorkerEvents(events) {
  const batchSize = 50;
  let totalInserted = 0;
  let allSucceeded = true;

  for (let i = 0; i < events.length; i += batchSize) {
    const batch = events.slice(i, i + batchSize);

    const url = `${SUPABASE_URL}/rest/v1/worker_calendar_events?on_conflict=event_id,event_date`;

    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: Object.assign(supabaseHeaders(), { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      payload: JSON.stringify(batch),
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    if (code < 400) {
      totalInserted += batch.length;
    } else {
      console.log(`  ❌ Upsert batch ${Math.floor(i / batchSize) + 1}: ${code} - ${response.getContentText()}`);
      allSucceeded = false;
    }

    Utilities.sleep(100);
  }

  return { success: allSucceeded, inserted: totalInserted };
}

// ============================================================
// WORKER EVENTS — STALE CLEANUP (protected)
// Deletes rows in the window that this run didn't touch — EXCEPT rows
// referenced by a tick status, POD, or tank movement. Those keep their
// history; if the tick is later removed they become deletable.
// ============================================================
function deleteStaleWorkerEvents(minDate, maxDate, syncRunId) {
  // 1. Find stale candidates
  const staleUrl = `${SUPABASE_URL}/rest/v1/worker_calendar_events` +
    `?select=id&event_date=gte.${minDate}&event_date=lte.${maxDate}&sync_run_id=neq.${syncRunId}&limit=10000`;

  const staleResp = UrlFetchApp.fetch(staleUrl, {
    method: 'GET',
    headers: supabaseHeaders(),
    muteHttpExceptions: true
  });

  if (staleResp.getResponseCode() >= 400) {
    console.log(`  ❌ Stale lookup failed: ${staleResp.getContentText()}`);
    return 0;
  }

  const staleIds = JSON.parse(staleResp.getContentText()).map(r => r.id);
  if (staleIds.length === 0) return 0;

  // 2. Find which of those are actioned (protected)
  const protectedIds = new Set();
  const refChecks = [
    { table: 'calendar_event_status', column: 'event_id' },
    { table: 'pods', column: 'calendar_event_id' },
    { table: 'tank_movements', column: 'calendar_event_id' }
  ];

  for (const check of refChecks) {
    for (const chunk of chunkArray(staleIds, 200)) {
      const url = `${SUPABASE_URL}/rest/v1/${check.table}?select=${check.column}&${check.column}=in.(${chunk.join(',')})`;
      const resp = UrlFetchApp.fetch(url, {
        method: 'GET',
        headers: supabaseHeaders(),
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() < 400) {
        JSON.parse(resp.getContentText()).forEach(r => protectedIds.add(r[check.column]));
      } else {
        console.log(`  ⚠️ Protection check on ${check.table} failed — protecting ALL stale rows this run`);
        return 0; // fail safe: delete nothing if we can't verify
      }
    }
  }

  const deletableIds = staleIds.filter(id => !protectedIds.has(id));
  if (protectedIds.size > 0) {
    console.log(`  🛡️ Protected ${protectedIds.size} actioned row(s) from cleanup`);
  }
  if (deletableIds.length === 0) return 0;

  // 3. Delete the unprotected stale rows
  let deleted = 0;
  for (const chunk of chunkArray(deletableIds, 200)) {
    const url = `${SUPABASE_URL}/rest/v1/worker_calendar_events?id=in.(${chunk.join(',')})`;
    const resp = UrlFetchApp.fetch(url, {
      method: 'DELETE',
      headers: Object.assign(supabaseHeaders(), { 'Prefer': 'return=minimal' }),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() < 400) {
      deleted += chunk.length;
    } else {
      console.log(`  ❌ Stale delete chunk failed: ${resp.getContentText()}`);
    }
  }

  return deleted;
}

// ============================================================
// INVOICES CALENDAR SYNC
// ============================================================
function syncInvoicesCalendar(startDate, endDate, syncRunId) {
  try {
    const calendar = CalendarApp.getCalendarById(INVOICES_CALENDAR_ID);

    if (!calendar) {
      console.log('  ⚠️ Could not access invoices calendar');
      return;
    }

    const events = calendar.getEvents(startDate, endDate);
    console.log(`  Found ${events.length} invoice events`);

    // Build entries, deduplicate by calendar_event_id + event_date
    const seen = new Map();
    for (const event of events) {
      const entry = {
        calendar_event_id: event.getId(),
        event_date: formatDate(event.getStartTime()),
        event_title: event.getTitle(),
        sync_run_id: syncRunId
      };
      seen.set(`${entry.calendar_event_id}|${entry.event_date}`, entry);
    }

    const dedupedEntries = Array.from(seen.values());
    console.log(`  ${events.length} events → ${dedupedEntries.length} after dedup`);

    if (dedupedEntries.length > 0) {
      // Move-aware: re-date existing entries in place so invoiced /
      // freight / checked flags follow an event that changes date.
      const existing = fetchExistingInvoiceEntries(formatDate(startDate), formatDate(endDate));
      const moved = reconcileMovedInvoiceEntries(existing, dedupedEntries);
      if (moved > 0) console.log(`  ↪️ ${moved} moved invoice entr${moved === 1 ? 'y' : 'ies'} re-dated in place`);

      const success = upsertInvoiceEntries(dedupedEntries);
      console.log(`  ✅ Synced ${dedupedEntries.length} invoice entries`);

      if (success) {
        const removed = deleteStaleInvoiceEntries(formatDate(startDate), formatDate(endDate), syncRunId);
        console.log(`  🗑️ Removed ${removed} stale invoice entries`);
      } else {
        console.log('  ⚠️ Some batches failed — skipping stale cleanup');
      }
    }

  } catch (e) {
    console.log(`  ❌ Error syncing invoices calendar: ${e.message}`);
  }
}

// ============================================================
// INVOICE ENTRIES — FETCH EXISTING + MOVE RECONCILIATION
// ============================================================
function fetchExistingInvoiceEntries(minDate, maxDate) {
  const rows = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/monthly_invoice_entries` +
      `?select=id,calendar_event_id,event_date,event_title` +
      `&event_date=gte.${minDate}&event_date=lte.${maxDate}` +
      `&order=id.asc&limit=${pageSize}&offset=${offset}`;

    const response = UrlFetchApp.fetch(url, {
      method: 'GET',
      headers: supabaseHeaders(),
      muteHttpExceptions: true
    });

    if (response.getResponseCode() >= 400) {
      console.log(`  ❌ Fetch existing invoice entries failed: ${response.getContentText()}`);
      return rows;
    }

    const batch = JSON.parse(response.getContentText());
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  return rows;
}

function reconcileMovedInvoiceEntries(existingRows, desiredEntries) {
  const existingByKey = {};
  existingRows.forEach(r => {
    (existingByKey[r.calendar_event_id] = existingByKey[r.calendar_event_id] || []).push(r);
  });

  const desiredByKey = {};
  desiredEntries.forEach(e => {
    (desiredByKey[e.calendar_event_id] = desiredByKey[e.calendar_event_id] || []).push(e);
  });

  let patched = 0;

  for (const key in desiredByKey) {
    const desired = desiredByKey[key];
    const existing = existingByKey[key] || [];
    if (existing.length === 0) continue;

    const desiredDates = new Set(desired.map(e => e.event_date));
    const existingDates = new Set(existing.map(r => r.event_date));

    const missingRows = existing
      .filter(r => !desiredDates.has(r.event_date))
      .sort((a, b) => a.event_date.localeCompare(b.event_date));
    const newEntries = desired
      .filter(e => !existingDates.has(e.event_date))
      .sort((a, b) => a.event_date.localeCompare(b.event_date));

    const pairs = Math.min(missingRows.length, newEntries.length);
    for (let i = 0; i < pairs; i++) {
      const row = missingRows[i];
      const entry = newEntries[i];
      const url = `${SUPABASE_URL}/rest/v1/monthly_invoice_entries?id=eq.${row.id}`;
      const resp = UrlFetchApp.fetch(url, {
        method: 'PATCH',
        headers: Object.assign(supabaseHeaders(), { 'Prefer': 'return=minimal' }),
        payload: JSON.stringify({
          event_date: entry.event_date,
          event_title: entry.event_title,
          sync_run_id: entry.sync_run_id
        }),
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() < 400) {
        patched++;
        console.log(`  ↪️ Moved invoice: "${entry.event_title}" ${row.event_date} → ${entry.event_date}`);
      } else {
        console.log(`  ❌ Patch invoice row ${row.id} failed: ${resp.getContentText()}`);
      }
    }
  }

  return patched;
}

// ============================================================
// INVOICE ENTRIES — UPSERT
// Returns true if all batches succeeded
// ============================================================
function upsertInvoiceEntries(entries) {
  const batchSize = 100;
  let allSucceeded = true;

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);

    const url = `${SUPABASE_URL}/rest/v1/monthly_invoice_entries?on_conflict=calendar_event_id,event_date`;

    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: Object.assign(supabaseHeaders(), { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      payload: JSON.stringify(batch),
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    if (code >= 400) {
      console.log(`  ❌ Invoice batch ${Math.floor(i / batchSize) + 1}: ${code} - ${response.getContentText()}`);
      allSucceeded = false;
    } else {
      console.log(`  Invoice batch ${Math.floor(i / batchSize) + 1}: ${code} ✅`);
    }
  }

  return allSucceeded;
}

// ============================================================
// INVOICE ENTRIES — STALE CLEANUP
// (unchanged: rows with invoiced/freight/checked/notes are already
// excluded by the filters, and moved rows now carry the current
// sync_run_id so they are no longer collateral damage)
// ============================================================
function deleteStaleInvoiceEntries(minDate, maxDate, syncRunId) {
  const url = `${SUPABASE_URL}/rest/v1/monthly_invoice_entries?event_date=gte.${minDate}&event_date=lte.${maxDate}&sync_run_id=neq.${syncRunId}&invoiced=eq.false&freight_added=eq.false&checked_sent=eq.false&notes=is.null`;

  const response = UrlFetchApp.fetch(url, {
    method: 'DELETE',
    headers: Object.assign(supabaseHeaders(), { 'Prefer': 'return=minimal' }),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  if (code >= 400) {
    console.log(`  ❌ Invoice stale cleanup failed: ${code} - ${response.getContentText()}`);
    return 0;
  }

  return '(count not returned by Supabase)';
}

// ============================================================
// FETCH KNOWN SERVICE DAYS
// ============================================================
function fetchKnownServiceDays() {
  const url = `${SUPABASE_URL}/rest/v1/service_days?select=name`;

  const response = UrlFetchApp.fetch(url, {
    method: 'GET',
    headers: supabaseHeaders(),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() >= 400) {
    console.log(`Error fetching service days: ${response.getContentText()}`);
    return [];
  }

  return JSON.parse(response.getContentText()).map(d => d.name);
}

// ============================================================
// EXTRACT SERVICE DAY NAME FROM TITLE
// ============================================================
function extractServiceDayName(title) {
  if (!title) return null;
  title = title.trim();
  if (!/day/i.test(title)) return null;

  let match = title.match(/Spare\s*Day\s*(\d+)/i);
  if (match) return `Spare Day ${match[1]}`;

  match = title.match(/Day\s*[-]?\s*(\d+(?:\.\d)?)/i);
  if (match) return `Day ${match[1]}`;

  return null;
}

// ============================================================
// UPDATE SYNC STATUS
// ============================================================
function updateSyncStatus(status, message) {
  const url = `${SUPABASE_URL}/rest/v1/calendar_sync_settings?id=eq.1`;

  const response = UrlFetchApp.fetch(url, {
    method: 'PATCH',
    headers: supabaseHeaders(),
    payload: JSON.stringify({
      last_sync_at: new Date().toISOString(),
      last_sync_status: status,
      last_sync_message: message
    }),
    muteHttpExceptions: true
  });

  console.log(`  Sync status updated: ${response.getResponseCode()}`);
}

// ============================================================
// HELPERS
// ============================================================
function supabaseHeaders() {
  return {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json'
  };
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function formatDate(date) {
  const year  = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day   = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ============================================================
// TRIGGER MANAGEMENT
// ============================================================
function createDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['syncCalendarsToSupabase', 'syncIfBusinessHours'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('syncCalendarsToSupabase')
    .timeBased()
    .atHour(2)
    .everyDays(1)
    .inTimezone('Australia/Brisbane')
    .create();

  ScriptApp.newTrigger('syncIfBusinessHours')
    .timeBased()
    .everyMinutes(15)
    .create();

  [17, 18, 19, 20, 21, 22].forEach(hour => {
    ScriptApp.newTrigger('syncCalendarsToSupabase')
      .timeBased()
      .atHour(hour)
      .everyDays(1)
      .inTimezone('Australia/Brisbane')
      .create();
  });

  console.log('✅ Triggers created: 2am + every 15min (7am–4pm) + hourly 5pm–10pm Brisbane time.');
}

function syncIfBusinessHours() {
  const hour = new Date().getHours();
  if (hour >= 7 && hour < 16) {
    syncCalendarsToSupabase();
  }
}

function removeDailyTrigger() {
  const triggers = ScriptApp.getProjectTriggers()
    .filter(t => ['syncCalendarsToSupabase', 'syncIfBusinessHours'].includes(t.getHandlerFunction()));
  triggers.forEach(t => ScriptApp.deleteTrigger(t));
  console.log(`Removed ${triggers.length} trigger(s).`);
}

// ============================================================
// MANUAL: INVOICES ONLY
// ============================================================
function syncInvoicesOnly() {
  console.log('Syncing invoices calendar only...');

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 60);

  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 90);

  const syncRunId = new Date().toISOString();

  console.log(`Range: ${formatDate(startDate)} → ${formatDate(endDate)}`);
  syncInvoicesCalendar(startDate, endDate, syncRunId);
  console.log('Done!');
}
