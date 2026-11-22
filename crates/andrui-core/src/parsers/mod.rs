pub mod battery;
pub mod package;
pub mod pm_list;

use serde_json::Value;

pub use battery::parse_battery;
pub use package::parse_dumpsys_package;
pub use pm_list::parse_pm_list;

/// Dispatches raw stdout to the appropriate structured JSON parser based on the operation or content.
pub fn parse_command_output(operation_id: &str, stdout: &str) -> Option<Value> {
    if stdout.trim().is_empty() {
        return None;
    }

    match operation_id {
        "package.list" => parse_pm_list(stdout),
        "diagnostics.batterystats" => parse_battery(stdout),
        "diagnostics.dumpsys" => {
            if stdout.contains("Current Battery Service state:") {
                parse_battery(stdout)
            } else if stdout.contains("Package [") || stdout.contains("Packages:") {
                parse_dumpsys_package(stdout)
            } else {
                None
            }
        }
        _ => {
            // General content sniff
            if stdout.contains("Current Battery Service state:") {
                parse_battery(stdout)
            } else if stdout.starts_with("package:") {
                parse_pm_list(stdout)
            } else if stdout.contains("Package [") {
                parse_dumpsys_package(stdout)
            } else {
                None
            }
        }
    }
}
