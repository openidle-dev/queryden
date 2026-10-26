//! Native `.xlsx` export.
//!
//! An `.xlsx` workbook is a zip of a few SpreadsheetML XML parts, so it is
//! written directly with the `zip` crate the app already ships, rather than
//! pulling a spreadsheet library into the frontend. Output: one sheet with a
//! bold, frozen header row, sized columns, and typed cells — numbers stay
//! numbers, booleans are booleans, text (including exact decimals beyond
//! Excel's 15-digit precision) stays text, NULL is an empty cell.

use std::io::Write;
use std::path::Path;

use serde_json::Value;
use zip::write::SimpleFileOptions;

/// Excel's hard limits.
const MAX_ROWS: usize = 1_048_576;
const MAX_COLUMNS: usize = 16_384;
const MAX_CELL_CHARS: usize = 32_767;

/// `0 → A`, `25 → Z`, `26 → AA`.
fn column_letter(mut index: usize) -> String {
    let mut out = Vec::new();
    loop {
        out.push(b'A' + (index % 26) as u8);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Text safe for an XML text node: entities escaped, characters XML 1.0
/// forbids removed, capped at Excel's per-cell limit.
fn xml_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (count, c) in text.chars().enumerate() {
        if count >= MAX_CELL_CHARS {
            break;
        }
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 || c == '\u{FFFE}' || c == '\u{FFFF}' => {}
            c => out.push(c),
        }
    }
    out
}

/// A numeric-looking string that Excel can hold exactly as a number: plain
/// decimal notation, no leading zeros (codes like `00123` stay text), at most
/// 15 significant digits (Excel's precision; longer values stay text).
fn excel_number(text: &str) -> Option<f64> {
    let unsigned = text.strip_prefix('-').unwrap_or(text);
    let (int, frac) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    if int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if int.len() > 1 && int.starts_with('0') {
        return None;
    }
    let significant = format!("{int}{frac}").trim_start_matches('0').trim_end_matches('0').len();
    if significant > 15 {
        return None;
    }
    text.parse::<f64>().ok().filter(|f| f.is_finite())
}

fn cell_xml(reference: &str, value: &Value) -> Option<String> {
    let text_cell = |text: &str| {
        let space = if text.starts_with(char::is_whitespace) || text.ends_with(char::is_whitespace) {
            r#" xml:space="preserve""#
        } else {
            ""
        };
        format!(r#"<c r="{reference}" t="inlineStr"><is><t{space}>{}</t></is></c>"#, xml_text(text))
    };
    match value {
        Value::Null => None,
        Value::Bool(b) => Some(format!(r#"<c r="{reference}" t="b"><v>{}</v></c>"#, u8::from(*b))),
        Value::Number(n) => match n.as_f64().filter(|f| f.is_finite()) {
            Some(_) => Some(format!(r#"<c r="{reference}"><v>{n}</v></c>"#)),
            None => Some(text_cell(&n.to_string())),
        },
        Value::String(text) => match excel_number(text) {
            Some(number) => Some(format!(r#"<c r="{reference}"><v>{number}</v></c>"#)),
            None => Some(text_cell(text)),
        },
        other => Some(text_cell(&other.to_string())),
    }
}

/// Excel sheet names: ≤ 31 characters, none of `[]:*?/\`.
fn sheet_name(raw: Option<&str>) -> String {
    let cleaned: String = raw
        .unwrap_or("")
        .chars()
        .filter(|c| !"[]:*?/\\".contains(*c))
        .take(31)
        .collect();
    let trimmed = cleaned.trim().trim_matches('\'');
    if trimmed.is_empty() { "Results".to_string() } else { trimmed.to_string() }
}

fn display_width(value: &Value) -> usize {
    match value {
        Value::Null => 0,
        Value::String(s) => s.lines().map(|l| l.chars().count()).max().unwrap_or(0),
        other => other.to_string().chars().count(),
    }
}

fn worksheet_xml(columns: &[String], rows: &[Vec<Value>]) -> String {
    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>"#,
    );

    // Width from the header and the first rows' content, within sane bounds.
    xml.push_str("<cols>");
    for (i, name) in columns.iter().enumerate() {
        let widest = rows
            .iter()
            .take(500)
            .map(|r| r.get(i).map(display_width).unwrap_or(0))
            .max()
            .unwrap_or(0)
            .max(name.chars().count());
        let width = (widest as f64 + 2.0).clamp(6.0, 60.0);
        xml.push_str(&format!(r#"<col min="{n}" max="{n}" width="{width}" customWidth="1"/>"#, n = i + 1));
    }
    xml.push_str("</cols><sheetData>");

    // Header: bold text, even when a column is named like a number (`2024`).
    xml.push_str(r#"<row r="1">"#);
    for (i, name) in columns.iter().enumerate() {
        xml.push_str(&format!(
            r#"<c r="{}1" t="inlineStr" s="1"><is><t>{}</t></is></c>"#,
            column_letter(i),
            xml_text(name)
        ));
    }
    xml.push_str("</row>");

    for (r, row) in rows.iter().enumerate() {
        let excel_row = r + 2;
        xml.push_str(&format!(r#"<row r="{excel_row}">"#));
        for (c, value) in row.iter().enumerate().take(columns.len()) {
            if let Some(cell) = cell_xml(&format!("{}{excel_row}", column_letter(c)), value) {
                xml.push_str(&cell);
            }
        }
        xml.push_str("</row>");
    }
    xml.push_str("</sheetData></worksheet>");
    xml
}

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>"#;

const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#;

const WORKBOOK_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#;

// Style 0: default. Style 1: bold (header row).
const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>"#;

/// Write `columns` + positional `rows` as a one-sheet `.xlsx` at `path`.
pub fn write_xlsx(path: &Path, sheet: &str, columns: &[String], rows: &[Vec<Value>]) -> Result<(), String> {
    if rows.len() + 1 > MAX_ROWS {
        return Err(format!("Excel sheets hold at most {} rows; this result has {}. Export as CSV instead.", MAX_ROWS - 1, rows.len()));
    }
    if columns.len() > MAX_COLUMNS {
        return Err(format!("Excel sheets hold at most {MAX_COLUMNS} columns; this result has {}.", columns.len()));
    }

    let workbook = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="{}" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
        xml_text(sheet)
    );

    // Write next to the target, then rename: a failed export never leaves a
    // truncated workbook where the user expects one.
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".partial");
    let tmp = path.with_file_name(tmp_name);
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let file = std::fs::File::create(&tmp)?;
        let mut zip = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, body) in [
            ("[Content_Types].xml", CONTENT_TYPES.to_string()),
            ("_rels/.rels", ROOT_RELS.to_string()),
            ("xl/workbook.xml", workbook),
            ("xl/_rels/workbook.xml.rels", WORKBOOK_RELS.to_string()),
            ("xl/styles.xml", STYLES.to_string()),
            ("xl/worksheets/sheet1.xml", worksheet_xml(columns, rows)),
        ] {
            zip.start_file(name, options)?;
            zip.write_all(body.as_bytes())?;
        }
        zip.finish()?.sync_all()?;
        Ok(())
    })();
    match result {
        Ok(()) => std::fs::rename(&tmp, path).map_err(|e| format!("Could not save {}: {e}", path.display())),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(format!("Could not write the Excel file: {e}"))
        }
    }
}

/// Export a result set as `.xlsx`. Rows are positional (`rows[r][c]` belongs
/// to `columns[c]`). Returns the number of data rows written.
#[tauri::command(async)]
pub fn export_xlsx(
    path: String,
    sheet_name: Option<String>,
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
) -> Result<usize, String> {
    write_xlsx(Path::new(&path), &self::sheet_name(sheet_name.as_deref()), &columns, &rows)?;
    Ok(rows.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Read;

    #[test]
    fn column_letters() {
        assert_eq!(column_letter(0), "A");
        assert_eq!(column_letter(25), "Z");
        assert_eq!(column_letter(26), "AA");
        assert_eq!(column_letter(701), "ZZ");
        assert_eq!(column_letter(702), "AAA");
    }

    #[test]
    fn numbers_only_when_excel_can_hold_them_exactly() {
        assert_eq!(excel_number("123.45"), Some(123.45));
        assert_eq!(excel_number("-0.5"), Some(-0.5));
        assert_eq!(excel_number("1.50"), Some(1.5));
        assert_eq!(excel_number("00123"), None, "codes keep their leading zeros");
        assert_eq!(excel_number("12345678901234567.89"), None, "beyond 15 digits stays text");
        assert_eq!(excel_number("1e5"), None);
        assert_eq!(excel_number("2024-01-01"), None);
    }

    #[test]
    fn sheet_names_follow_excel_rules() {
        assert_eq!(sheet_name(Some("public.orders")), "public.orders");
        assert_eq!(sheet_name(Some("a/b:c*d?[e]")), "abcde");
        assert_eq!(sheet_name(None), "Results");
        assert_eq!(sheet_name(Some(&"x".repeat(40))).len(), 31);
    }

    #[test]
    fn writes_a_valid_typed_workbook() {
        let dir = std::env::temp_dir().join(format!("qd-xlsx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.xlsx");
        let columns = vec!["id".to_string(), "name & <co>".to_string(), "price".to_string(), "ok".to_string(), "doc".to_string(), "2024".to_string()];
        let rows = vec![
            vec![json!(1), json!(" padded "), json!("1.50"), json!(true), json!({"a": 1}), Value::Null],
            vec![json!(2), json!("bell\u{7}char"), json!("12345678901234567.89"), json!(false), Value::Null, json!("00123")],
        ];
        write_xlsx(&path, "Results", &columns, &rows).unwrap();
        assert!(!dir.join("out.xlsx.partial").exists());
        // Keep a copy for opening in Excel / LibreOffice / openpyxl.
        if let Ok(sample) = std::env::var("QUERYDEN_XLSX_SAMPLE") {
            std::fs::copy(&path, sample).unwrap();
        }

        let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
        let names: Vec<String> = archive.file_names().map(|n| n.unwrap().into_owned()).collect();
        for part in ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"] {
            assert!(names.contains(&part.to_string()), "missing {part}");
        }
        let mut sheet = String::new();
        archive.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut sheet).unwrap();
        assert!(sheet.contains(r#"<c r="B1" t="inlineStr" s="1"><is><t>name &amp; &lt;co&gt;</t></is></c>"#), "{sheet}");
        assert!(sheet.contains(r#"<c r="F1" t="inlineStr" s="1"><is><t>2024</t></is></c>"#), "numeric header stays text: {sheet}");
        assert!(sheet.contains(r#"<c r="A2"><v>1</v></c>"#));
        assert!(sheet.contains(r#"<t xml:space="preserve"> padded </t>"#));
        assert!(sheet.contains(r#"<c r="C2"><v>1.5</v></c>"#));
        assert!(sheet.contains(r#"<c r="D2" t="b"><v>1</v></c>"#));
        assert!(sheet.contains(r#"<t>{&quot;a&quot;:1}</t>"#));
        assert!(!sheet.contains(r#"r="F2""#), "NULL is an empty cell");
        assert!(sheet.contains("<t>bellchar</t>"), "control characters are dropped");
        assert!(sheet.contains("<t>12345678901234567.89</t>"));
        assert!(sheet.contains("<t>00123</t>"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
