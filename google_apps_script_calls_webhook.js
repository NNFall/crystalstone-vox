const SHEET_NAME = 'Звонки Crystal Stone';
const LEGACY_SHEET_NAME = 'Calls';
const SHEET_TITLE = 'Отчет по звонкам Crystal Stone';
const SHEET_TIMEZONE = 'Europe/Moscow';
const STANDARD_ROW_HEIGHT = 21;
const UNIFIED_ROW_HEIGHT = Math.round(STANDARD_ROW_HEIGHT * 1.5);
const TITLE_ROW = 1;
const HEADER_ROW = 2;
const DATA_START_ROW = 3;

const LEGACY_HEADERS = [
  'received_at_utc',
  'project',
  'script_name',
  'model',
  'caller_phone',
  'client_phone',
  'client_name',
  'call_duration_sec',
  'telephony_cost_rub',
  'websocket_duration_sec',
  'websocket_cost_rub',
  'voximplant_total_rub',
  'ai_cost_usd',
  'ai_cost_rub',
  'total_cost_rub',
  'call_goal',
  'manager_offer',
  'outcome',
  'next_step',
  'summary',
  'recording_status',
  'recording_url',
  'recording_error',
  'dialogue_text',
  'usage_in_text',
  'usage_in_audio',
  'usage_in_video',
  'usage_in_unknown',
  'usage_out_text',
  'usage_out_audio',
  'usage_out_video',
  'usage_out_unknown',
  'usage_events',
  'raw_json'
];

const VIEW_COLUMNS = [
  { key: 'call_datetime', title: 'Дата звонка (МСК)', width: 165, kind: 'datetime', align: 'center', source: ['exported_at_utc', 'received_at_utc'] },
  { key: 'client_name', title: 'Имя клиента', width: 135, kind: 'text', align: 'left', source: ['client_name'] },
  { key: 'client_phone', title: 'Телефон клиента', width: 145, kind: 'text', align: 'center', source: ['client_phone', 'caller_phone'] },
  { key: 'call_goal', title: 'Запрос клиента', width: 250, kind: 'text', wrap: true, source: ['call_goal'] },
  { key: 'manager_offer', title: 'Что предложили', width: 280, kind: 'text', wrap: true, source: ['manager_offer'] },
  { key: 'outcome', title: 'Итог', width: 210, kind: 'text', wrap: true, source: ['outcome'] },
  { key: 'next_step', title: 'Следующий шаг', width: 240, kind: 'text', wrap: true, source: ['next_step'] },
  { key: 'summary', title: 'Краткая сводка', width: 300, kind: 'text', wrap: true, source: ['summary'] },
  { key: 'dialogue_text', title: 'Диалог', width: 520, kind: 'text', wrap: true, source: ['dialogue_text'] },
  { key: 'recording_link', title: 'Запись звонка', width: 140, kind: 'link', align: 'center', source: ['recording_url'] },
  { key: 'call_duration_text', title: 'Длительность', width: 110, kind: 'duration', align: 'center', source: ['call_duration_sec'] },
  { key: 'voximplant_total_rub', title: 'Телефония, ₽', width: 125, kind: 'currency', align: 'right', source: ['voximplant_total_rub', 'telephony_cost_rub'] },
  { key: 'ai_cost_rub', title: 'AI, ₽', width: 110, kind: 'currency', align: 'right', source: ['ai_cost_rub'] }
];

const DISPLAY_HEADERS = VIEW_COLUMNS.map((column) => column.title);

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse_({ ok: false, error: 'empty_post_body' });
    }

    const payload = JSON.parse(e.postData.contents);
    const sheet = getOrCreateSheet_();

    ensureSheetView_(sheet);

    const rowNumber = appendPayloadRow_(sheet, payload);

    return jsonResponse_({
      ok: true,
      sheet: SHEET_NAME,
      row: rowNumber
    });
  } catch (error) {
    return jsonResponse_({
      ok: false,
      error: String(error)
    });
  }
}

function applyManagerSheetView() {
  const sheet = getOrCreateSheet_();
  ensureSheetView_(sheet);
}

function setupCallsSheetView() {
  applyManagerSheetView();
}

function getOrCreateSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSpreadsheetTimezone_(ss);
  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.getSheetByName(LEGACY_SHEET_NAME);
    if (sheet) {
      sheet.setName(SHEET_NAME);
    }
  }

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  return sheet;
}

function ensureSpreadsheetTimezone_(spreadsheet) {
  if (spreadsheet.getSpreadsheetTimeZone() !== SHEET_TIMEZONE) {
    spreadsheet.setSpreadsheetTimeZone(SHEET_TIMEZONE);
  }
}

function ensureSheetView_(sheet) {
  migrateLegacySheetIfNeeded_(sheet);
  syncColumnCount_(sheet);
  prepareSheetForMergedTitle_(sheet);
  writeTitleAndHeaders_(sheet);
  applySheetLayout_(sheet);
}

function syncColumnCount_(sheet) {
  const requiredColumns = VIEW_COLUMNS.length;
  const currentColumns = sheet.getMaxColumns();

  if (currentColumns < requiredColumns) {
    sheet.insertColumnsAfter(currentColumns, requiredColumns - currentColumns);
  } else if (currentColumns > requiredColumns) {
    sheet.deleteColumns(requiredColumns + 1, currentColumns - requiredColumns);
  }
}

function migrateLegacySheetIfNeeded_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (!values.length) return;

  const legacyHeaderRow = detectLegacyHeaderRow_(values);
  if (!legacyHeaderRow) return;

  const headerIndex = legacyHeaderRow - 1;
  const sourceHeaders = values[headerIndex];
  const payloads = values
    .slice(legacyHeaderRow)
    .filter((row) => rowHasContent_(row))
    .map((row) => rowToObject_(sourceHeaders, row));

  sheet.clearContents();
  sheet.clearFormats();
  sheet.clearConditionalFormatRules();

  const filter = sheet.getFilter();
  if (filter) filter.remove();

  removeAllBandings_(sheet);
  syncColumnCount_(sheet);
  writeTitleAndHeaders_(sheet);

  if (!payloads.length) return;

  const rows = payloads.map((payload) => toViewRow_(payload));
  const range = sheet.getRange(DATA_START_ROW, 1, rows.length, VIEW_COLUMNS.length);
  range.setValues(rows);

  payloads.forEach((payload, index) => {
    applyRecordingLink_(sheet, DATA_START_ROW + index, pickValue_(payload, ['recording_url']));
  });
}

function detectLegacyHeaderRow_(values) {
  if (!values.length) return 0;
  if (matchesHeaderRow_(values[0], LEGACY_HEADERS)) return 1;
  if (values.length > 1 && matchesHeaderRow_(values[1], LEGACY_HEADERS)) return 2;
  return 0;
}

function matchesHeaderRow_(rowValues, expectedHeaders) {
  if (!rowValues || rowValues.length < expectedHeaders.length) return false;

  for (let i = 0; i < expectedHeaders.length; i += 1) {
    if (String(rowValues[i] || '') !== expectedHeaders[i]) {
      return false;
    }
  }

  return true;
}

function writeTitleAndHeaders_(sheet) {
  syncColumnCount_(sheet);
  prepareSheetForMergedTitle_(sheet);

  const titleRange = sheet.getRange(TITLE_ROW, 1, 1, VIEW_COLUMNS.length);
  titleRange.breakApart();
  titleRange.clearContent();
  titleRange.merge();
  titleRange.setValue(SHEET_TITLE);

  sheet.getRange(HEADER_ROW, 1, 1, VIEW_COLUMNS.length).setValues([DISPLAY_HEADERS]);
}

function prepareSheetForMergedTitle_(sheet) {
  try {
    sheet.setFrozenColumns(0);
  } catch (error) {
    // Ignore if the sheet is in an intermediate state.
  }
}

function applySheetLayout_(sheet) {
  const lastRow = Math.max(sheet.getLastRow(), DATA_START_ROW);
  const dataRowCount = Math.max(lastRow - DATA_START_ROW + 1, 1);

  const titleRange = sheet.getRange(TITLE_ROW, 1, 1, VIEW_COLUMNS.length);
  const headerRange = sheet.getRange(HEADER_ROW, 1, 1, VIEW_COLUMNS.length);
  const dataRange = sheet.getRange(DATA_START_ROW, 1, dataRowCount, VIEW_COLUMNS.length);

  sheet.setFrozenRows(HEADER_ROW);
  sheet.setFrozenColumns(0);

  titleRange
    .setFontWeight('bold')
    .setFontSize(15)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setBackground('#1f2937')
    .setFontColor('#ffffff');

  headerRange
    .setFontWeight('bold')
    .setFontSize(10)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true)
    .setBackground('#dbeafe')
    .setFontColor('#0f172a');

  sheet.getRange(HEADER_ROW, 12, 1, 2).setBackground('#fef3c7');

  dataRange
    .setVerticalAlignment('top')
    .setHorizontalAlignment('left')
    .setWrap(true);

  VIEW_COLUMNS.forEach((column, index) => {
    const columnIndex = index + 1;
    const columnRange = sheet.getRange(DATA_START_ROW, columnIndex, dataRowCount, 1);

    sheet.setColumnWidth(columnIndex, column.width);
    columnRange.setWrap(Boolean(column.wrap));
    columnRange.setHorizontalAlignment(column.align || 'left');
  });

  sheet.setRowHeight(TITLE_ROW, UNIFIED_ROW_HEIGHT);
  sheet.setRowHeight(HEADER_ROW, UNIFIED_ROW_HEIGHT);

  if (sheet.getLastRow() >= DATA_START_ROW) {
    try {
      sheet.setRowHeights(DATA_START_ROW, sheet.getLastRow() - DATA_START_ROW + 1, UNIFIED_ROW_HEIGHT);
    } catch (error) {
      // Ignore row-height errors on freshly recreated sheets.
    }
  }

  sheet.getRange(DATA_START_ROW, 1, dataRowCount, 1).setNumberFormat('dd.MM.yyyy HH:mm');
  sheet.getRange(DATA_START_ROW, 12, dataRowCount, 2).setNumberFormat('#,##0.00');

  removeAllBandings_(sheet);
  if (sheet.getLastRow() >= DATA_START_ROW) {
    sheet
      .getRange(DATA_START_ROW, 1, Math.max(sheet.getLastRow() - DATA_START_ROW + 1, 1), VIEW_COLUMNS.length)
      .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY);
  }

  const filter = sheet.getFilter();
  if (filter) filter.remove();
  headerRange.createFilter();

  dataRange.setBorder(false, false, true, false, false, false, '#e5e7eb', SpreadsheetApp.BorderStyle.SOLID);
}

function appendPayloadRow_(sheet, payload) {
  const row = toViewRow_(payload);
  sheet.appendRow(row);

  const rowNumber = sheet.getLastRow();
  applyRecordingLink_(sheet, rowNumber, pickValue_(payload, ['recording_url']));
  applySheetLayout_(sheet);

  return rowNumber;
}

function toViewRow_(payload) {
  return VIEW_COLUMNS.map((column) => buildCellValue_(payload, column));
}

function buildCellValue_(payload, column) {
  const rawValue = pickValue_(payload, column.source || [column.key]);

  if (column.kind === 'datetime') return toDateValue_(rawValue);
  if (column.kind === 'duration') return formatDuration_(rawValue);
  if (column.kind === 'currency') return numberValue_(rawValue);
  if (column.kind === 'link') return rawValue ? 'Открыть запись' : '';

  return value_(rawValue);
}

function applyRecordingLink_(sheet, rowNumber, recordingUrl) {
  const columnIndex = getColumnIndexByKey_('recording_link');
  if (columnIndex < 1) return;

  const cell = sheet.getRange(rowNumber, columnIndex);
  if (!recordingUrl) {
    cell.setValue('');
    return;
  }

  const richText = SpreadsheetApp.newRichTextValue()
    .setText('Открыть запись')
    .setLinkUrl(recordingUrl)
    .build();

  cell.setRichTextValue(richText);
}

function getColumnIndexByKey_(key) {
  const index = VIEW_COLUMNS.findIndex((column) => column.key === key);
  return index >= 0 ? index + 1 : -1;
}

function pickValue_(obj, keys) {
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const value = obj && obj[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return '';
}

function rowToObject_(headers, row) {
  const obj = {};
  headers.forEach((header, index) => {
    obj[String(header || '')] = row[index];
  });
  return obj;
}

function rowHasContent_(row) {
  return row.some((cell) => cell !== '' && cell !== null);
}

function removeAllBandings_(sheet) {
  sheet.getBandings().forEach((banding) => banding.remove());
}

function toDateValue_(value) {
  if (!value) return '';

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date;
}

function formatDuration_(value) {
  const totalSeconds = Math.max(0, Math.round(numberValue_(value)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${pad2_(minutes)}:${pad2_(seconds)}`;
  }

  return `${pad2_(minutes)}:${pad2_(seconds)}`;
}

function pad2_(value) {
  return String(value).padStart(2, '0');
}

function value_(v) {
  return v === undefined || v === null ? '' : String(v);
}

function numberValue_(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : '';
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
