/**
 * Wallet Import Script for Google Sheets
 * 
 * Sheet tabs:
 *   - "Data"        → Final data (Address | Label | Source) — bot reads this
 *   - "RawPaste"    → Paste rawWallets array content here (one line per cell, column A)
 *   - "CustomPaste" → Paste customWallets array content here (same format)
 *
 * Usage:
 *   1. Copy rawWallets array content from Tampermonkey script
 *   2. Paste into column A of "RawPaste" tab
 *   3. Do the same for customWallets → "CustomPaste" tab
 *   4. Click menu: 🔄 Wallet Import → Import All
 *   5. Done! "Data" tab is refreshed
 */

// ===================== MENU =====================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🔄 Wallet Import')
    .addItem('📥 Import All (Raw + Custom)', 'importAll')
    .addSeparator()
    .addItem('📥 Import Raw Only', 'importRawOnly')
    .addItem('📥 Import Custom Only', 'importCustomOnly')
    .addSeparator()
    .addItem('🧹 Clear Data Tab', 'clearDataTab')
    .addToUi();
}

// ===================== MAIN FUNCTIONS =====================

/**
 * Import both Raw and Custom wallets → write to "Data" tab
 * Clears "Data" tab first, then writes all wallets
 */
function importAll() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  const rawWallets = parsePasteTab(ss, 'RawPaste');
  const customWallets = parsePasteTab(ss, 'CustomPaste');
  
  // Combine: custom first (higher priority), then raw
  const allRows = [];
  
  customWallets.forEach(([addr, label]) => {
    allRows.push([addr, label, 'custom']);
  });
  
  rawWallets.forEach(([addr, label]) => {
    allRows.push([addr, label, 'raw']);
  });
  
  writeToDataTab(ss, allRows);
  
  const ui = SpreadsheetApp.getUi();
  ui.alert(
    '✅ Import hoàn tất',
    `Raw: ${rawWallets.length} wallets\nCustom: ${customWallets.length} wallets\nTotal: ${allRows.length} wallets`,
    ui.ButtonSet.OK
  );
}

function importRawOnly() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rawWallets = parsePasteTab(ss, 'RawPaste');
  
  // Keep existing custom wallets
  const dataSheet = getOrCreateSheet(ss, 'Data');
  const existingCustom = getExistingBySource(dataSheet, 'custom');
  
  const allRows = [];
  existingCustom.forEach(([addr, label]) => allRows.push([addr, label, 'custom']));
  rawWallets.forEach(([addr, label]) => allRows.push([addr, label, 'raw']));
  
  writeToDataTab(ss, allRows);
  
  SpreadsheetApp.getUi().alert('✅ Import Raw', `${rawWallets.length} raw wallets imported.\nCustom wallets preserved.`, SpreadsheetApp.getUi().ButtonSet.OK);
}

function importCustomOnly() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const customWallets = parsePasteTab(ss, 'CustomPaste');
  
  // Keep existing raw wallets
  const dataSheet = getOrCreateSheet(ss, 'Data');
  const existingRaw = getExistingBySource(dataSheet, 'raw');
  
  const allRows = [];
  customWallets.forEach(([addr, label]) => allRows.push([addr, label, 'custom']));
  existingRaw.forEach(([addr, label]) => allRows.push([addr, label, 'raw']));
  
  writeToDataTab(ss, allRows);
  
  SpreadsheetApp.getUi().alert('✅ Import Custom', `${customWallets.length} custom wallets imported.\nRaw wallets preserved.`, SpreadsheetApp.getUi().ButtonSet.OK);
}

function clearDataTab() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert('⚠️ Xác nhận', 'Bạn có chắc muốn xóa toàn bộ Data tab?', ui.ButtonSet.YES_NO);
  if (response !== ui.Button.YES) return;
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = getOrCreateSheet(ss, 'Data');
  dataSheet.clearContents();
  dataSheet.getRange('A1:C1').setValues([['Address', 'Label', 'Source']]);
  dataSheet.getRange('A1:C1').setFontWeight('bold');
  
  ui.alert('🧹 Đã xóa Data tab.');
}

// ===================== PARSER =====================

/**
 * Parse wallet entries from a paste tab
 * Supports formats:
 *   ['address', 'label'],              // JS array format
 *   ['address', 'label'], // comment   // with comments
 *   ["address", "label"],              // double quotes
 *   address, label                     // simple CSV
 */
function parsePasteTab(ss, tabName) {
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('⚠️ Tab "' + tabName + '" không tồn tại.\nHãy tạo tab này trước.');
    return [];
  }
  
  const lastRow = sheet.getLastRow();
  if (lastRow === 0) return [];
  
  const data = sheet.getRange(1, 1, lastRow, 1).getValues();
  const wallets = [];
  
  for (let i = 0; i < data.length; i++) {
    const raw = String(data[i][0] || '').trim();
    if (!raw) continue;
    
    const parsed = parseWalletLine(raw);
    if (parsed) {
      wallets.push(parsed);
    }
  }
  
  return wallets;
}

/**
 * Parse a single line like:
 *   ['0x123...', 'my label'],  // optional comment
 *   ["0x123...", "my label"],
 */
function parseWalletLine(line) {
  // Remove trailing comma and comments
  let clean = line.replace(/\/\/.*$/, '').trim();
  clean = clean.replace(/,\s*$/, '').trim();
  
  // Try JS array format: ['addr', 'label'] or ["addr", "label"]
  const jsMatch = clean.match(/^\[?\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\]?$/);
  if (jsMatch) {
    return [jsMatch[1].trim(), jsMatch[2].trim()];
  }
  
  // Try simple 2-value format: addr, label (no quotes)
  const parts = clean.split(',');
  if (parts.length >= 2) {
    const addr = parts[0].replace(/[\[\]'"]/g, '').trim();
    const label = parts.slice(1).join(',').replace(/[\[\]'"]/g, '').trim();
    if (addr && label) {
      return [addr, label];
    }
  }
  
  return null;
}

// ===================== WRITE =====================

function writeToDataTab(ss, rows) {
  const dataSheet = getOrCreateSheet(ss, 'Data');
  
  // Clear everything
  dataSheet.clearContents();
  
  // Header
  dataSheet.getRange('A1:C1').setValues([['Address', 'Label', 'Source']]);
  dataSheet.getRange('A1:C1').setFontWeight('bold').setBackground('#1f2937').setFontColor('#e5e7eb');
  
  // Data
  if (rows.length > 0) {
    dataSheet.getRange(2, 1, rows.length, 3).setValues(rows);
  }
  
  // Auto-resize
  dataSheet.autoResizeColumn(1);
  dataSheet.autoResizeColumn(2);
  dataSheet.autoResizeColumn(3);
  
  // Freeze header
  dataSheet.setFrozenRows(1);
}

// ===================== HELPERS =====================

function getOrCreateSheet(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

function getExistingBySource(dataSheet, source) {
  const lastRow = dataSheet.getLastRow();
  if (lastRow <= 1) return [];
  
  const data = dataSheet.getRange(2, 1, lastRow - 1, 3).getValues();
  return data
    .filter(row => String(row[2]).toLowerCase() === source)
    .map(row => [String(row[0]), String(row[1])]);
}
