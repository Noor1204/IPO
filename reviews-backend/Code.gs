// Trendy IPO: reviews backend (Google Apps Script). Developed by Zynora Technology (Noor).
// Reviews arrive in YOUR Google Sheet (tab "Reviews") as "pending". Only rows you mark "approved" are shown in the app.
// Setup steps are in REVIEWS.md. Paste this whole file into Extensions > Apps Script of a new Google Sheet.

var SHEET_NAME = "Reviews";
var MAX_TEXT = 500;
var MAX_NAME = 40;
var MAX_PER_HOUR = 30;       // whole-site limit, against spam floods

// Run this once (Run > setup) and accept the permissions: it prepares the sheets.
function setup() {
  var sh = reviewsSheet_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sum = ss.getSheetByName("Summary") || ss.insertSheet("Summary");
  sum.clear();
  sum.getRange("A1:B1").setValues([["Trendy IPO reviews", ""]]).setFontWeight("bold");
  sum.getRange("A3:B6").setValues([
    ["Total reviews", "=COUNTA(Reviews!A2:A)"],
    ["Waiting for approval (pending)", "=COUNTIF(Reviews!E2:E,\"pending\")"],
    ["Approved (public)", "=COUNTIF(Reviews!E2:E,\"approved\")"],
    ["Average rating (approved)", "=IFERROR(AVERAGEIF(Reviews!E2:E,\"approved\",Reviews!C2:C),\"-\")"]
  ]);
  sum.autoResizeColumns(1, 2);
  sh.getRange("E2:E").setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(["pending", "approved", "hidden"], true).build());
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Reviews")
    .addItem("Approve selected rows", "approveSelected")
    .addItem("Hide selected rows", "hideSelected")
    .addToUi();
}
function approveSelected() { setStatus_("approved"); }
function hideSelected() { setStatus_("hidden"); }
function setStatus_(status) {
  var sh = reviewsSheet_();
  var range = sh.getActiveRange();
  if (!range) return;
  for (var r = range.getRow(); r < range.getRow() + range.getNumRows(); r++) if (r > 1) sh.getRange(r, 5).setValue(status);
}

function reviewsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(["Time", "Name", "Rating", "Review", "Status", "Id"]);
    sh.setFrozenRows(1);
    sh.getRange("A1:F1").setFontWeight("bold");
    sh.setColumnWidth(4, 420);
  }
  return sh;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// no angle brackets, no control characters, trimmed and cut to a safe length
function clean_(value, max) {
  var s = String(value == null ? "" : value).split("<").join("").split(">").join("");
  var kept = "";
  for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); kept += (c < 32 || c === 127) ? " " : s.charAt(i); }
  return kept.trim().slice(0, max);
}

function hasLink_(s) {
  var l = String(s).toLowerCase();
  return l.indexOf("http") >= 0 || l.indexOf("www.") >= 0 || l.indexOf(".com") >= 0 || l.indexOf(".in/") >= 0;
}

// a visitor sends a review
function doPost(e) {
  try {
    var d = JSON.parse(e.postData.contents);
    if (d.website) return out_({ ok: true });                          // hidden field filled in = a bot: pretend it worked
    var rating = parseInt(d.rating, 10);
    var text = clean_(d.text, MAX_TEXT);
    var name = clean_(d.name, MAX_NAME) || "Anonymous";
    if (!(rating >= 1 && rating <= 5) || text.length < 5 || d.consent !== true) return out_({ ok: false, error: "invalid" });
    if (hasLink_(text) || hasLink_(name)) return out_({ ok: false, error: "links" });

    var cache = CacheService.getScriptCache();
    var key = "n" + Math.floor(Date.now() / 3600000);
    var count = Number(cache.get(key) || 0);
    if (count >= MAX_PER_HOUR) return out_({ ok: false, error: "busy" });
    cache.put(key, String(count + 1), 3600);

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      var sh = reviewsSheet_();
      var last = sh.getLastRow();
      if (last > 1 && sh.getRange(last, 4).getValue() === text && sh.getRange(last, 2).getValue() === name) return out_({ ok: true });   // same review twice in a row
      sh.appendRow([new Date(), name, rating, text, "pending", Utilities.getUuid()]);
    } finally { lock.releaseLock(); }

    try {
      MailApp.sendEmail(Session.getEffectiveUser().getEmail(), "New Trendy IPO review (" + rating + "/5)",
        name + " wrote:\n\n" + text + "\n\nIt is waiting for your approval in the Google Sheet (column Status: pending -> approved).");
    } catch (mailError) { /* the review is saved even if the email cannot be sent */ }
    return out_({ ok: true });
  } catch (err) {
    return out_({ ok: false, error: "error" });
  }
}

// the app asks for the approved reviews
function doGet(e) {
  if (!e || !e.parameter || e.parameter.action !== "list") return out_({ ok: true });
  var rows = reviewsSheet_().getDataRange().getValues();
  var list = [], sum = 0;
  for (var i = rows.length - 1; i >= 1; i--) {                         // newest first
    if (String(rows[i][4]).toLowerCase() !== "approved") continue;
    var rating = Math.max(1, Math.min(5, parseInt(rows[i][2], 10) || 0));
    sum += rating;
    if (list.length < 100) list.push({ name: clean_(rows[i][1], MAX_NAME) || "Anonymous", rating: rating, text: clean_(rows[i][3], MAX_TEXT), date: rows[i][0] instanceof Date ? rows[i][0].toISOString() : "" });
  }
  var total = 0;
  for (var j = 1; j < rows.length; j++) if (String(rows[j][4]).toLowerCase() === "approved") total++;
  return out_({ ok: true, count: total, avg: total ? Math.round(sum / total * 10) / 10 : 0, reviews: list });
}
