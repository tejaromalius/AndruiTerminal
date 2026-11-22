//! Native Linux desktop notifications for pending agent approvals via `notify-send`.

use std::process::Stdio;
use tokio::process::Command;
use tracing::{debug, warn};

use crate::{
    approvals::{Approval, ApprovalStatus},
    server::{router::resolve_approval_decision, state::AppState},
};

fn notifications_enabled(state: &AppState) -> bool {
    state.version != "test"
        && std::env::var_os("ANDRUI_DISABLE_DESKTOP_NOTIFICATIONS").is_none()
        && std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some()
}

pub fn build_notification_text(approval: &Approval) -> (String, String, &'static str) {
    let target = approval.device_id.as_deref().unwrap_or("Host");
    let summary = format!("Approval required: {}", approval.operation_label);
    let body = format!("{} · {}\n{}", approval.requester, target, approval.preview.display);
    let urgency = if approval.destructive { "critical" } else { "normal" };
    (summary, body, urgency)
}

pub fn parse_action(stdout: &[u8]) -> Option<bool> {
    match String::from_utf8_lossy(stdout).trim() {
        "allow" => Some(true),
        "reject" => Some(false),
        _ => None,
    }
}

/// Spawns a non-blocking `notify-send` prompt with Allow / Reject actions for a pending approval.
pub fn spawn_desktop_notification(state: AppState, approval: Approval) {
    if approval.status != ApprovalStatus::Pending || !notifications_enabled(&state) {
        return;
    }

    let (summary, body, urgency) = build_notification_text(&approval);
    let approval_id = approval.id.clone();

    tokio::spawn(async move {
        let mut child = match Command::new("notify-send")
            .args([
                "--app-name=AndruiTerminal",
                &format!("--urgency={urgency}"),
                "--icon=dialog-password",
                "--action=allow=Allow",
                "--action=reject=Reject",
                "--",
                &summary,
                &body,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(err) => {
                debug!(error = %err, "notify-send unavailable for approval notification");
                return;
            }
        };

        let mut events = state.job_manager.subscribe_global_events();
        let mut stdout = child.stdout.take();

        tokio::select! {
            status = child.wait() => {
                let Ok(status) = status else { return };
                if !status.success() {
                    debug!(code = ?status.code(), "notify-send exited with non-zero status");
                    return;
                }
                let mut buf = Vec::new();
                if let Some(ref mut out) = stdout {
                    use tokio::io::AsyncReadExt;
                    let _ = out.read_to_end(&mut buf).await;
                }
                if let Some(approve) = parse_action(&buf) {
                    if let Err(err) = resolve_approval_decision(&state, &approval_id, approve).await {
                        debug!(error = %err, approval_id = %approval_id, "native notification resolution skipped");
                    }
                }
            }
            _ = async {
                while let Ok(ev) = events.recv().await {
                    if ev.get("type").and_then(|v| v.as_str()) == Some("approval")
                        && ev.pointer("/data/id").and_then(|v| v.as_str()) == Some(approval_id.as_str())
                        && ev.pointer("/data/status").and_then(|v| v.as_str()) != Some("pending")
                    {
                        break;
                    }
                }
            } => {
                if let Err(err) = child.kill().await {
                    warn!(error = %err, approval_id = %approval_id, "failed to dismiss notify-send process");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approvals::Severity;
    use crate::models::CommandPreview;

    #[test]
    fn builds_notification_text_and_parses_actions() {
        let approval = Approval {
            id: "ap-1".into(),
            operation_id: "package.uninstall".into(),
            operation_label: "Uninstall Package".into(),
            destructive: true,
            severity: Severity::High,
            device_id: Some("emu-1".into()),
            parameters: Default::default(),
            preview: CommandPreview {
                program: "adb".into(),
                args: vec![],
                display: "adb -s emu-1 uninstall com.example".into(),
            },
            requester: "mcp".into(),
            status: ApprovalStatus::Pending,
            job_id: None,
            error: None,
            created_at: "2026-11-22T20:00:00Z".into(),
            resolved_at: None,
        };
        let (summary, body, urgency) = build_notification_text(&approval);
        assert_eq!(summary, "Approval required: Uninstall Package");
        assert_eq!(body, "mcp · emu-1\nadb -s emu-1 uninstall com.example");
        assert_eq!(urgency, "critical");
        assert_eq!(parse_action(b"allow\n"), Some(true));
        assert_eq!(parse_action(b"reject\n"), Some(false));
        assert_eq!(parse_action(b""), None);
    }
}
