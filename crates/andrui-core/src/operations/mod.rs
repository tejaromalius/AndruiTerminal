pub mod catalog;
pub mod preview;
pub mod semantic;

pub use catalog::*;
pub use preview::*;

/// Availability reflects the configured host client; device privileges/utilities
/// remain conditional and are reported by the actual operation result.
pub async fn runtime_catalog(
    executor: &crate::adb::executor::AdbExecutor,
) -> Vec<crate::models::Operation> {
    let help = executor
        .execute(
            &["help".into()],
            Some(std::time::Duration::from_secs(5)),
            None,
        )
        .await;
    let text = help
        .as_ref()
        .ok()
        .filter(|o| o.exit_code == 0)
        .map(|o| o.stdout.as_str());
    let mut catalog = catalog::get_operation_catalog();
    for op in &mut catalog {
        let command = match op.id.as_str() {
            "device.attach" => Some("attach"),
            "device.detach" => Some("detach"),
            "server.status" => Some("server-status"),
            "shell.raw" => Some("raw"),
            "system.rescue_getprop" | "system.rescue_install" | "system.rescue_wipe" => {
                Some("rescue")
            }
            _ => None,
        };
        if text.is_none() {
            op.available = false;
            op.unavailable_reason =
                Some("The configured ADB executable could not be queried with 'help'".into());
        } else if let (Some(command), Some(text)) = (command, text) {
            let present = text.lines().any(|line| {
                line.trim_start().starts_with(&format!("{command} ")) || line.trim() == command
            });
            if !present {
                op.available = false;
                op.unavailable_reason = Some(format!("The configured host ADB help does not advertise '{command}'; select a compatible Platform Tools executable"));
            }
        }
    }
    catalog
}
