use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackageEntry {
    pub package: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apk_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installer: Option<String>,
}

/// Parses the output of `pm list packages [-f] [-i] [-u] [--uid]` into structured JSON.
pub fn parse_pm_list(stdout: &str) -> Option<Value> {
    let mut packages = Vec::new();

    for line in stdout.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("package:") else {
            continue;
        };

        // Format could be:
        // /data/app/.../base.apk=com.example.app uid:10245 installer=com.android.vending
        // or com.example.app
        let mut tokens = rest.split_whitespace();
        let first = tokens.next()?;

        let (apk_path, package) = if let Some((path, pkg)) = first.rsplit_once('=') {
            (Some(path.to_string()), pkg.to_string())
        } else {
            (None, first.to_string())
        };

        let mut uid = None;
        let mut installer = None;

        for token in tokens {
            if let Some(uid_str) = token.strip_prefix("uid:") {
                uid = uid_str.parse::<u32>().ok();
            } else if let Some(inst) = token.strip_prefix("installer=") {
                installer = Some(inst.to_string());
            }
        }

        packages.push(PackageEntry {
            package,
            apk_path,
            uid,
            installer,
        });
    }

    if packages.is_empty() {
        None
    } else {
        serde_json::to_value(packages).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_pm_list_packages() {
        let sample = r#"
package:/data/app/~~aBC123==/com.example.app-xyz==/base.apk=com.example.app uid:10245 installer=com.android.vending
package:/system/priv-app/Settings/Settings.apk=com.android.settings uid:1000
package:com.android.shell
"#;

        let parsed = parse_pm_list(sample).expect("should parse");
        let list = parsed.as_array().expect("must be array");
        assert_eq!(list.len(), 3);
        assert_eq!(list[0]["package"], "com.example.app");
        assert_eq!(
            list[0]["apkPath"],
            "/data/app/~~aBC123==/com.example.app-xyz==/base.apk"
        );
        assert_eq!(list[0]["uid"], 10245);
        assert_eq!(list[0]["installer"], "com.android.vending");

        assert_eq!(list[1]["package"], "com.android.settings");
        assert_eq!(list[1]["uid"], 1000);

        assert_eq!(list[2]["package"], "com.android.shell");
        assert!(list[2]["apkPath"].is_null());
    }
}
