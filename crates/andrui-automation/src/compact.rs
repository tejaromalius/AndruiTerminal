//! Compact hierarchy for agents: a flat list of visible nodes that are interactive or carry
//! text, instead of the full accessibility XML. Works with helper XML and
//! `uiautomator dump` XML (which also has `long-clickable` and `focusable`).

use serde::Serialize;

const TEXT_CAP: usize = 200;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompactNode {
    /// Position in this snapshot's list; not stable across snapshots.
    pub id: usize,
    pub class: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    /// `[left, top, right, bottom]` in screen pixels.
    pub bounds: [i32; 4],
    pub center: [i32; 2],
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub flags: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_type: Option<String>,
}

fn parse_bounds(value: &str) -> Option<[i32; 4]> {
    let nums: Vec<i32> = value
        .split(|c: char| !(c.is_ascii_digit() || c == '-'))
        .filter(|s| !s.is_empty())
        .map(|s| s.parse().ok())
        .collect::<Option<_>>()?;
    match nums[..] {
        [l, t, r, b] => Some([l, t, r, b]),
        _ => None,
    }
}

fn non_empty(node: roxmltree::Node, name: &str) -> Option<String> {
    let value = node.attribute(name)?.trim();
    if value.is_empty() {
        return None;
    }
    Some(match value.char_indices().nth(TEXT_CAP) {
        Some((end, _)) => format!("{}…", &value[..end]),
        None => value.to_string(),
    })
}

fn is_true(node: roxmltree::Node, name: &str) -> bool {
    node.attribute(name) == Some("true")
}

fn is_valid_xml_char(c: char) -> bool {
    matches!(
        c as u32,
        0x09 | 0x0A | 0x0D | 0x20..=0xD7FF | 0xE000..=0xFFFD | 0x10000..=0x10FFFF
    )
}

fn valid_xml_entity(rest: &str) -> Option<usize> {
    for named in ["amp;", "lt;", "gt;", "quot;", "apos;"] {
        if rest.starts_with(named) {
            return Some(named.len());
        }
    }
    let after_hash = rest.strip_prefix('#')?;
    let semi = after_hash.find(';')?;
    if semi == 0 || semi > 10 {
        return None;
    }
    let digits = &after_hash[..semi];
    let code = if let Some(hex) = digits.strip_prefix('x').or_else(|| digits.strip_prefix('X')) {
        if hex.is_empty() {
            return None;
        }
        u32::from_str_radix(hex, 16).ok()?
    } else {
        digits.parse::<u32>().ok()?
    };
    let ch = char::from_u32(code)?;
    if is_valid_xml_char(ch) {
        Some(1 + semi + 1)
    } else {
        None
    }
}

/// Sanitize malformed `uiautomator dump` XML (trailing status text, invalid control chars,
/// unescaped `&` or `<` in attributes, or invalid numeric character references).
fn sanitize_hierarchy_xml(xml: &str) -> String {
    let start = match (xml.find("<?xml"), xml.find("<hierarchy")) {
        (Some(x), Some(h)) if x < h => x,
        (_, Some(h)) => h,
        (Some(x), None) => x,
        (None, None) => 0,
    };
    let end = xml
        .rfind("</hierarchy>")
        .map(|idx| idx + "</hierarchy>".len())
        .unwrap_or(xml.len());
    let slice = if start < end { &xml[start..end] } else { xml };

    let mut out = String::with_capacity(slice.len());
    let mut in_tag = false;
    let mut attr_quote: Option<char> = None;
    let mut chars = slice.char_indices().peekable();

    while let Some((idx, ch)) = chars.next() {
        if !is_valid_xml_char(ch) {
            continue;
        }
        if let Some(q) = attr_quote {
            if ch == q {
                attr_quote = None;
                out.push(ch);
            } else if ch == '<' {
                out.push_str("&lt;");
            } else if ch == '&' {
                let rest = &slice[idx + 1..];
                if let Some(len) = valid_xml_entity(rest) {
                    out.push('&');
                    out.push_str(&rest[..len]);
                    for _ in 0..rest[..len].chars().count() {
                        chars.next();
                    }
                } else {
                    out.push_str("&amp;");
                }
            } else {
                out.push(ch);
            }
        } else {
            if ch == '<' {
                in_tag = true;
            } else if ch == '>' && in_tag {
                in_tag = false;
            } else if in_tag && (ch == '"' || ch == '\'') {
                attr_quote = Some(ch);
            } else if ch == '&' {
                let rest = &slice[idx + 1..];
                if let Some(len) = valid_xml_entity(rest) {
                    out.push('&');
                    out.push_str(&rest[..len]);
                    for _ in 0..rest[..len].chars().count() {
                        chars.next();
                    }
                    continue;
                } else {
                    out.push_str("&amp;");
                    continue;
                }
            }
            out.push(ch);
        }
    }
    out
}

pub fn compact_nodes(xml: &str) -> Result<Vec<CompactNode>, String> {
    let sanitized;
    let doc = match roxmltree::Document::parse(xml) {
        Ok(doc) => doc,
        Err(_) => {
            sanitized = sanitize_hierarchy_xml(xml);
            roxmltree::Document::parse(&sanitized).map_err(|e| e.to_string())?
        }
    };
    let mut nodes = Vec::new();
    for node in doc.descendants().filter(|n| n.has_tag_name("node")) {
        if node.attribute("visible-to-user") == Some("false") {
            continue;
        }
        let Some(bounds) = node.attribute("bounds").and_then(parse_bounds) else {
            continue;
        };
        if bounds[2] <= bounds[0] || bounds[3] <= bounds[1] {
            continue;
        }
        let class = node.attribute("class").unwrap_or("");
        let editable = class.ends_with("EditText");
        let mut flags = Vec::new();
        for (attr, flag) in [
            ("clickable", "click"),
            ("long-clickable", "longClick"),
            ("scrollable", "scroll"),
            ("checkable", "check"),
        ] {
            if is_true(node, attr) {
                flags.push(flag);
            }
        }
        if editable {
            flags.push("edit");
        }
        let interactive = !flags.is_empty();
        let text = non_empty(node, "text");
        let desc = non_empty(node, "content-desc");
        if !interactive && text.is_none() && desc.is_none() {
            continue;
        }
        for (attr, flag) in [
            ("checked", "checked"),
            ("focused", "focused"),
            ("selected", "selected"),
            ("password", "password"),
        ] {
            if is_true(node, attr) {
                flags.push(flag);
            }
        }
        if node.attribute("enabled") == Some("false") {
            flags.push("disabled");
        }
        let window_type = node
            .ancestors()
            .find_map(|n| n.attribute("window-type"))
            .map(str::to_string);
        nodes.push(CompactNode {
            id: nodes.len(),
            class: class.rsplit('.').next().unwrap_or(class).to_string(),
            text,
            desc,
            hint: non_empty(node, "hint-text"),
            resource_id: non_empty(node, "resource-id"),
            bounds,
            center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
            flags,
            window_type,
        });
    }
    Ok(nodes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../tests/fixtures/data/hierarchy_settings.xml");

    #[test]
    fn keeps_interactive_and_text_nodes() {
        let nodes = compact_nodes(FIXTURE).unwrap();
        assert_eq!(nodes.len(), 31);
        let find = |text: &str| nodes.iter().find(|n| n.text.as_deref() == Some(text));

        let back = nodes
            .iter()
            .find(|n| n.desc.as_deref() == Some("Navigate up"))
            .unwrap();
        assert_eq!(back.class, "ImageButton");
        assert_eq!(back.flags, vec!["click"]);
        assert_eq!(back.center, [72, 168]);

        let search = nodes.iter().find(|n| n.flags.contains(&"edit")).unwrap();
        assert_eq!(search.hint.as_deref(), Some("Search settings"));
        assert!(search.flags.contains(&"focused"));

        let switch = nodes.iter().find(|n| n.class == "Switch").unwrap();
        assert_eq!(
            switch.resource_id.as_deref(),
            Some("android:id/switch_widget")
        );
        assert_eq!(switch.flags, vec!["check"]);

        assert_eq!(
            find("10:24").unwrap().window_type.as_deref(),
            Some("system")
        );
        assert_eq!(
            find("Airplane mode").unwrap().window_type.as_deref(),
            Some("application")
        );
        assert_eq!(nodes.iter().filter(|n| n.flags == ["click"]).count(), 9);
        assert!(nodes.iter().any(|n| n.flags.contains(&"scroll")));
        assert!(nodes.iter().enumerate().all(|(i, n)| n.id == i));
    }

    #[test]
    fn drops_hidden_zero_area_and_structural_nodes() {
        let nodes = compact_nodes(FIXTURE).unwrap();
        assert!(nodes
            .iter()
            .all(|n| n.text.as_deref() != Some("Offscreen item")));
        assert!(nodes
            .iter()
            .all(|n| n.resource_id.as_deref() != Some("com.android.settings:id/divider")));
        assert!(nodes
            .iter()
            .all(|n| !matches!(n.class.as_str(), "FrameLayout" | "RelativeLayout")));
    }

    #[test]
    fn compact_json_is_at_least_70_percent_smaller() {
        let json = serde_json::to_string(&compact_nodes(FIXTURE).unwrap()).unwrap();
        let ratio = json.len() as f64 / FIXTURE.len() as f64;
        assert!(ratio <= 0.30, "compact is {:.0}% of raw", ratio * 100.0);
    }

    #[test]
    fn supports_uiautomator_dump_attributes() {
        let xml = r#"<hierarchy rotation="0"><node index="0" text="" class="android.widget.FrameLayout" bounds="[0,0][100,100]">
            <node index="0" text="" content-desc="" class="android.view.View" long-clickable="true" enabled="false" bounds="[0,0][50,50]"/>
            <node index="1" text="" class="android.view.View" focusable="true" bounds="[50,50][100,100]"/>
            </node></hierarchy>"#;
        let nodes = compact_nodes(xml).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].flags, vec!["longClick", "disabled"]);
        assert_eq!(nodes[0].window_type, None);
    }

    #[test]
    fn caps_long_text_and_rejects_bad_xml() {
        let long = "é".repeat(TEXT_CAP + 5);
        let xml = format!(r#"<hierarchy><node text="{long}" bounds="[0,0][1,1]"/></hierarchy>"#);
        let text = compact_nodes(&xml).unwrap()[0].text.clone().unwrap();
        assert_eq!(text.chars().count(), TEXT_CAP + 1);
        assert!(compact_nodes("<hierarchy><node").is_err());
        assert_eq!(parse_bounds("[1,2][3,4]"), Some([1, 2, 3, 4]));
        assert_eq!(parse_bounds("[1,2][3]"), None);
    }

    #[test]
    fn sanitizes_malformed_uiautomator_dump_xml() {
        let noisy = "adb warning\n<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\
            <hierarchy rotation=\"0\">\
            <node text=\"AT&T <Live>\x00\x1b &amp; &#65; &#0;\" content-desc=\"A & B\" class=\"android.widget.TextView\" bounds=\"[0,0][100,40]\"/>\
            </hierarchy>UI hierchary dumped to: /dev/tty\n";
        let nodes = compact_nodes(noisy).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].text.as_deref(), Some("AT&T <Live> & A &#0;"));
        assert_eq!(nodes[0].desc.as_deref(), Some("A & B"));
    }
}
