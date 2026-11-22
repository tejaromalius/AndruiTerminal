//! Claude Code integration: registers the `andrui-terminal mcp` server and installs the
//! bundled `andrui-terminal` skill for the user running this server.
//!
//! `claude` is the only extra host binary run here. It is called with fixed argument arrays
//! (`--version`, `mcp add`, `mcp remove`), only for the MCP entry named `andrui`.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::error::{ApiError, ApiResult};

pub mod mcp_tools;

pub const SKILL_CONTENT: &str =
    include_str!("../../../../integrations/claude/skills/andrui-terminal/SKILL.md");
pub const MCP_NAME: &str = "andrui";
const SKILL_NAME: &str = "andrui-terminal";
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCliStatus {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub registered: bool,
    /// `user`, or `local:<project path>` for a project-only entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub args: Vec<String>,
    /// The user-scope entry runs this server's binary against this server's URL.
    pub matches_expected: bool,
    pub expected_command: String,
    pub expected_args: Vec<String>,
    pub config_path: String,
    /// This server's binary was replaced on disk; the entry starts the new binary while this
    /// process still runs the old one.
    pub restart_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillStatus {
    pub installed: bool,
    pub up_to_date: bool,
    pub path: String,
    pub bundled_content: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub claude_cli: ClaudeCliStatus,
    pub mcp: McpStatus,
    pub skill: SkillStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTestResult {
    pub ok: bool,
    pub latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
    pub tool_count: usize,
    pub tools: Vec<String>,
    pub sample_tool_call_ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ConfirmRequest {
    #[serde(default)]
    pub confirmed: bool,
}

/// Paths for one user; built from `$HOME` in production and from a temp dir in tests.
pub struct AiIntegration {
    pub home: PathBuf,
    /// Overrides the `claude` lookup (tests).
    pub claude: Option<PathBuf>,
    pub path_env: Option<String>,
    /// Binary and server URL the MCP entry should run.
    pub mcp_command: String,
    pub server_url: String,
    pub restart_required: bool,
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

impl AiIntegration {
    /// `server_url` comes from the request's validated loopback Host header.
    pub fn from_env(server_url: String) -> ApiResult<Self> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| ApiError::internal("HOME_UNSET", "HOME is not set for the server"))?;
        let exe = std::env::current_exe()
            .map_err(|e| ApiError::internal("CURRENT_EXE_UNKNOWN", e.to_string()))?;
        // Linux reports the running image as "<path> (deleted)" once the file is replaced
        // (package upgrade, rebuild).
        let exe = exe.to_string_lossy();
        let (mcp_command, restart_required) = match exe.strip_suffix(" (deleted)") {
            Some(path) => (path.to_string(), true),
            None => (exe.into_owned(), false),
        };
        Ok(Self {
            home,
            claude: None,
            path_env: std::env::var("PATH").ok(),
            mcp_command,
            server_url,
            restart_required,
        })
    }

    pub fn config_path(&self) -> PathBuf {
        self.home.join(".claude.json")
    }

    pub fn skill_path(&self) -> PathBuf {
        self.home
            .join(".claude/skills")
            .join(SKILL_NAME)
            .join("SKILL.md")
    }

    pub fn expected_args(&self) -> Vec<String> {
        vec![
            "mcp".to_string(),
            "--server".to_string(),
            self.server_url.clone(),
        ]
    }

    /// `claude` on PATH, then the usual install locations (a systemd user service has a
    /// minimal PATH that often lacks `~/.local/bin`).
    pub fn find_claude(&self) -> Option<PathBuf> {
        if let Some(path) = &self.claude {
            return is_executable(path).then(|| path.clone());
        }
        let from_path = self
            .path_env
            .iter()
            .flat_map(|p| std::env::split_paths(p).collect::<Vec<_>>())
            .map(|dir| dir.join("claude"));
        let fallbacks = [
            self.home.join(".local/bin/claude"),
            self.home.join(".claude/local/claude"),
            self.home.join(".npm-global/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
        ];
        // npm global installs under nvm: ~/.nvm/versions/node/<version>/bin/claude, newest first.
        let mut nvm: Vec<PathBuf> = std::fs::read_dir(self.home.join(".nvm/versions/node"))
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path().join("bin/claude"))
            .collect();
        nvm.sort_by(|a, b| b.cmp(a));
        from_path
            .chain(fallbacks)
            .chain(nvm)
            .find(|p| is_executable(p))
    }

    async fn run_claude(&self, claude: &Path, args: &[&str]) -> ApiResult<String> {
        let output = tokio::time::timeout(CLAUDE_TIMEOUT, async {
            let mut attempts = 0;
            loop {
                let result = tokio::process::Command::new(claude)
                    .args(args)
                    .stdin(std::process::Stdio::null())
                    .kill_on_drop(true)
                    .output()
                    .await;
                match result {
                    // ETXTBSY means the process never started. Retrying this
                    // spawn error cannot repeat an MCP configuration change.
                    Err(error) if error.raw_os_error() == Some(26) && attempts < 3 => {
                        attempts += 1;
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    result => return result,
                }
            }
        })
        .await
        .map_err(|_| ApiError::internal("CLAUDE_TIMEOUT", "claude did not finish in 30 s"))?
        .map_err(|e| ApiError::internal("CLAUDE_SPAWN_FAILED", e.to_string()))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(ApiError::bad_request_with_details(
                "CLAUDE_COMMAND_FAILED",
                format!(
                    "`claude {}` failed: {}",
                    args.join(" "),
                    if stderr.is_empty() { &stdout } else { &stderr }
                ),
                serde_json::json!({ "exitCode": output.status.code() }),
            ));
        }
        Ok(stdout)
    }

    async fn claude_status(&self) -> ClaudeCliStatus {
        let Some(path) = self.find_claude() else {
            return ClaudeCliStatus {
                available: false,
                path: None,
                version: None,
                reason: Some(
                    "Claude Code CLI (`claude`) not found on PATH or in ~/.local/bin".to_string(),
                ),
            };
        };
        let version = self.run_claude(&path, &["--version"]).await;
        ClaudeCliStatus {
            available: version.is_ok(),
            path: Some(path.to_string_lossy().into_owned()),
            reason: version.as_ref().err().map(|e| e.to_string()),
            version: version.ok(),
        }
    }

    /// Reads `~/.claude.json` without modifying it.
    pub fn mcp_status(&self) -> McpStatus {
        let config_path = self.config_path();
        let mut status = McpStatus {
            registered: false,
            scope: None,
            command: None,
            args: Vec::new(),
            matches_expected: false,
            expected_command: self.mcp_command.clone(),
            expected_args: self.expected_args(),
            config_path: config_path.to_string_lossy().into_owned(),
            restart_required: self.restart_required,
            reason: None,
        };
        let config: Value = match std::fs::read_to_string(&config_path) {
            Ok(text) => match serde_json::from_str(&text) {
                Ok(value) => value,
                Err(e) => {
                    status.reason = Some(format!("Could not parse {}: {e}", status.config_path));
                    return status;
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return status,
            Err(e) => {
                status.reason = Some(format!("Could not read {}: {e}", status.config_path));
                return status;
            }
        };
        let user_entry = config["mcpServers"].get(MCP_NAME);
        let local_entry = config["projects"].as_object().and_then(|projects| {
            projects.iter().find_map(|(path, project)| {
                project["mcpServers"]
                    .get(MCP_NAME)
                    .map(|entry| (format!("local:{path}"), entry))
            })
        });
        let (scope, entry) = match (user_entry, local_entry) {
            (Some(entry), _) => ("user".to_string(), entry),
            (None, Some((scope, entry))) => (scope, entry),
            (None, None) => return status,
        };
        status.registered = true;
        status.command = entry["command"].as_str().map(str::to_string);
        status.args = entry["args"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        status.matches_expected = scope == "user"
            && status.command.as_deref() == Some(self.mcp_command.as_str())
            && status.args == status.expected_args;
        status.scope = Some(scope);
        status
    }

    pub fn skill_status(&self) -> SkillStatus {
        let path = self.skill_path();
        let installed = std::fs::read_to_string(&path);
        SkillStatus {
            installed: installed.is_ok(),
            up_to_date: installed.is_ok_and(|content| content == SKILL_CONTENT),
            path: path.to_string_lossy().into_owned(),
            bundled_content: SKILL_CONTENT,
        }
    }

    pub async fn status(&self) -> AiStatus {
        AiStatus {
            claude_cli: self.claude_status().await,
            mcp: self.mcp_status(),
            skill: self.skill_status(),
        }
    }

    /// Registers (or re-registers) the user-scope `andrui` MCP entry via `claude mcp`.
    pub async fn install_mcp(&self) -> ApiResult<AiStatus> {
        let claude = self.find_claude().ok_or_else(|| {
            ApiError::bad_request(
                "CLAUDE_NOT_FOUND",
                "Claude Code CLI (`claude`) not found on PATH or in ~/.local/bin",
            )
        })?;
        let current = self.mcp_status();
        if !current.matches_expected {
            if current.scope.as_deref() == Some("user") {
                self.run_claude(&claude, &["mcp", "remove", "--scope", "user", MCP_NAME])
                    .await?;
            }
            let expected = self.expected_args();
            let mut args = vec![
                "mcp",
                "add",
                "--scope",
                "user",
                MCP_NAME,
                "--",
                self.mcp_command.as_str(),
            ];
            args.extend(expected.iter().map(String::as_str));
            self.run_claude(&claude, &args).await?;
        }
        Ok(self.status().await)
    }

    /// Removes the user-scope `andrui` MCP entry via `claude mcp remove`.
    pub async fn remove_mcp(&self) -> ApiResult<AiStatus> {
        let claude = self.find_claude().ok_or_else(|| {
            ApiError::bad_request(
                "CLAUDE_NOT_FOUND",
                "Claude Code CLI (`claude`) not found on PATH or in ~/.local/bin",
            )
        })?;
        let current = self.mcp_status();
        if current.registered && current.scope.as_deref() == Some("user") {
            self.run_claude(&claude, &["mcp", "remove", "--scope", "user", MCP_NAME])
                .await?;
        }
        Ok(self.status().await)
    }

    /// Writes the bundled skill to `~/.claude/skills/andrui-terminal/SKILL.md`.
    pub async fn install_skill(&self) -> ApiResult<AiStatus> {
        let path = self.skill_path();
        let dir = path.parent().expect("skill path has a parent");
        let write_failed =
            |e: std::io::Error| ApiError::internal("SKILL_WRITE_FAILED", e.to_string());
        tokio::fs::create_dir_all(dir).await.map_err(write_failed)?;
        let temp = dir.join(".SKILL.md.tmp");
        tokio::fs::write(&temp, SKILL_CONTENT)
            .await
            .map_err(write_failed)?;
        tokio::fs::rename(&temp, &path)
            .await
            .map_err(write_failed)?;
        Ok(self.status().await)
    }

    /// Removes the installed skill at `~/.claude/skills/andrui-terminal/SKILL.md`.
    pub async fn remove_skill(&self) -> ApiResult<AiStatus> {
        let path = self.skill_path();
        if path.exists() {
            tokio::fs::remove_file(&path)
                .await
                .map_err(|e| ApiError::internal("SKILL_REMOVE_FAILED", e.to_string()))?;
            if let Some(parent) = path.parent() {
                let _ = tokio::fs::remove_dir(parent).await;
            }
        }
        Ok(self.status().await)
    }

    pub fn find_mcp_command(&self) -> Option<PathBuf> {
        let p = PathBuf::from(&self.mcp_command);
        if is_executable(&p) {
            return Some(p);
        }
        if self.mcp_command.contains('/') {
            return None;
        }
        if let Ok(path_var) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path_var) {
                let candidate = dir.join(&self.mcp_command);
                if is_executable(&candidate) {
                    return Some(candidate);
                }
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                let candidate = parent.join("andrui-terminal");
                if is_executable(&candidate) {
                    return Some(candidate);
                }
                if let Some(grandparent) = parent.parent() {
                    let candidate = grandparent.join("andrui-terminal");
                    if is_executable(&candidate) {
                        return Some(candidate);
                    }
                }
            }
        }
        None
    }

    /// Tests the MCP server subcommand by running it over stdio and exercising initialize, ping,
    /// tools/list, and android_list_devices.
    pub async fn test_mcp(&self) -> McpTestResult {
        let start = std::time::Instant::now();
        let Some(bin_path) = self.find_mcp_command() else {
            return McpTestResult {
                ok: false,
                latency_ms: start.elapsed().as_millis() as u64,
                protocol_version: None,
                server_name: None,
                server_version: None,
                tool_count: 0,
                tools: Vec::new(),
                sample_tool_call_ok: false,
                details: None,
                error: Some(format!(
                    "MCP binary `{}` not found or not executable",
                    self.mcp_command
                )),
            };
        };

        match tokio::time::timeout(Duration::from_secs(10), self.run_mcp_session(&bin_path)).await {
            Ok(Ok(mut result)) => {
                result.latency_ms = start.elapsed().as_millis() as u64;
                result
            }
            Ok(Err(err)) => McpTestResult {
                ok: false,
                latency_ms: start.elapsed().as_millis() as u64,
                protocol_version: None,
                server_name: None,
                server_version: None,
                tool_count: 0,
                tools: Vec::new(),
                sample_tool_call_ok: false,
                details: None,
                error: Some(err),
            },
            Err(_) => McpTestResult {
                ok: false,
                latency_ms: start.elapsed().as_millis() as u64,
                protocol_version: None,
                server_name: None,
                server_version: None,
                tool_count: 0,
                tools: Vec::new(),
                sample_tool_call_ok: false,
                details: None,
                error: Some("MCP test timed out after 10 seconds".to_string()),
            },
        }
    }

    async fn run_mcp_session(&self, bin_path: &Path) -> Result<McpTestResult, String> {
        let mut child = tokio::process::Command::new(bin_path)
            .args(["mcp", "--server", &self.server_url])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to spawn MCP process: {e}"))?;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture MCP stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture MCP stdout".to_string())?;
        let mut lines = BufReader::new(stdout).lines();

        // 1. initialize
        stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\"},\"id\":1}\n")
            .await
            .map_err(|e| format!("Failed to send initialize: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush initialize: {e}"))?;

        let init_line = next_non_empty_line(&mut lines).await?;
        let init_val: Value = serde_json::from_str(&init_line)
            .map_err(|e| format!("Invalid JSON from MCP initialize ({init_line}): {e}"))?;
        if init_val.get("error").is_some() {
            return Err(format!("MCP initialize returned error: {init_line}"));
        }
        let protocol_version = init_val["result"]["protocolVersion"]
            .as_str()
            .map(str::to_string);
        let server_name = init_val["result"]["serverInfo"]["name"]
            .as_str()
            .map(str::to_string);
        let server_version = init_val["result"]["serverInfo"]["version"]
            .as_str()
            .map(str::to_string);

        // 2. ping
        stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"ping\",\"id\":2}\n")
            .await
            .map_err(|e| format!("Failed to send ping: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush ping: {e}"))?;

        let ping_line = next_non_empty_line(&mut lines).await?;
        let ping_val: Value = serde_json::from_str(&ping_line)
            .map_err(|e| format!("Invalid JSON from MCP ping ({ping_line}): {e}"))?;
        if ping_val.get("error").is_some() {
            return Err(format!("MCP ping returned error: {ping_line}"));
        }

        // 3. tools/list
        stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"id\":3}\n")
            .await
            .map_err(|e| format!("Failed to send tools/list: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush tools/list: {e}"))?;

        let tools_line = next_non_empty_line(&mut lines).await?;
        let tools_val: Value = serde_json::from_str(&tools_line)
            .map_err(|e| format!("Invalid JSON from MCP tools/list ({tools_line}): {e}"))?;
        if tools_val.get("error").is_some() {
            return Err(format!("MCP tools/list returned error: {tools_line}"));
        }
        let tools: Vec<String> = tools_val["result"]["tools"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t["name"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let tool_count = tools.len();

        // 4. tools/call android_list_devices
        stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"android_list_devices\",\"arguments\":{}},\"id\":4}\n")
            .await
            .map_err(|e| format!("Failed to send tools/call: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush tools/call: {e}"))?;

        let call_line = next_non_empty_line(&mut lines).await?;
        let call_val: Value = serde_json::from_str(&call_line)
            .map_err(|e| format!("Invalid JSON from MCP tools/call ({call_line}): {e}"))?;
        let sample_tool_call_ok = call_val["result"]["isError"].as_bool() == Some(false);

        drop(stdin);
        let _ = child.kill().await;

        Ok(McpTestResult {
            ok: true,
            latency_ms: 0,
            protocol_version,
            server_name,
            server_version,
            tool_count,
            tools,
            sample_tool_call_ok,
            details: Some(format!(
                "Verified MCP server on {}: initialized protocol, listed {} tools, sample tool call succeeded",
                self.server_url,
                tool_count
            )),
            error: None,
        })
    }
}

async fn next_non_empty_line<R: tokio::io::AsyncBufRead + Unpin>(
    lines: &mut tokio::io::Lines<R>,
) -> Result<String, String> {
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|e| format!("Read error: {e}"))?
    {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    Err("Unexpected EOF from MCP stdout".to_string())
}

pub fn require_confirmation(req: &ConfirmRequest) -> ApiResult<()> {
    if req.confirmed {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "CONFIRMATION_REQUIRED",
            "This changes your Claude Code setup; confirm to continue",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    fn integration(home: &Path) -> AiIntegration {
        AiIntegration {
            home: home.to_path_buf(),
            claude: Some(home.join("bin/claude")),
            path_env: None,
            mcp_command: "/usr/bin/andrui-terminal".to_string(),
            server_url: "http://127.0.0.1:19801".to_string(),
            restart_required: false,
        }
    }

    /// Fake `claude` that logs its arguments and edits ~/.claude.json like `mcp add/remove`.
    fn fake_claude(home: &Path) {
        let bin = home.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let script = format!(
            r#"#!/usr/bin/env python3
import json, os, sys
home = {home:?}
open(os.path.join(home, "calls.log"), "a").write(" ".join(sys.argv[1:]) + "\n")
args = sys.argv[1:]
if args == ["--version"]:
    print("2.0.0 (Claude Code)"); sys.exit(0)
path = os.path.join(home, ".claude.json")
cfg = json.load(open(path)) if os.path.exists(path) else {{}}
servers = cfg.setdefault("mcpServers", {{}})
if args[:2] == ["mcp", "add"]:
    name = args[4]
    if name in servers:
        print("already exists", file=sys.stderr); sys.exit(1)
    rest = args[args.index("--") + 1:]
    servers[name] = {{"type": "stdio", "command": rest[0], "args": rest[1:], "env": {{}}}}
elif args[:2] == ["mcp", "remove"]:
    servers.pop(args[-1])
json.dump(cfg, open(path, "w"))
"#,
            home = home.to_string_lossy()
        );
        let path = bin.join("claude");
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn calls(home: &Path) -> Vec<String> {
        std::fs::read_to_string(home.join("calls.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[tokio::test]
    async fn reports_missing_claude_and_unregistered_mcp() {
        let home = TempDir::new().unwrap();
        let status = integration(home.path()).status().await;
        assert!(!status.claude_cli.available);
        assert!(!status.mcp.registered);
        assert_eq!(
            status.mcp.expected_args,
            ["mcp", "--server", "http://127.0.0.1:19801"]
        );
        assert!(!status.skill.installed);
        assert!(integration(home.path()).install_mcp().await.is_err());
    }

    #[tokio::test]
    async fn installs_mcp_once_and_replaces_stale_entry() {
        let home = TempDir::new().unwrap();
        fake_claude(home.path());
        let ai = integration(home.path());

        let status = ai.install_mcp().await.unwrap();
        assert!(status.claude_cli.available);
        assert_eq!(
            status.claude_cli.version.as_deref(),
            Some("2.0.0 (Claude Code)")
        );
        assert!(status.mcp.registered && status.mcp.matches_expected);
        assert_eq!(status.mcp.scope.as_deref(), Some("user"));

        // Already correct: no further add/remove.
        let before = calls(home.path()).len();
        ai.install_mcp().await.unwrap();
        let after = calls(home.path());
        assert!(after[before..].iter().all(|c| c == "--version"));

        // A different server URL replaces the entry.
        let moved = AiIntegration {
            server_url: "http://localhost:19811".to_string(),
            ..integration(home.path())
        };
        assert!(!moved.mcp_status().matches_expected);
        let status = moved.install_mcp().await.unwrap();
        assert!(status.mcp.matches_expected);
        assert!(calls(home.path())
            .iter()
            .any(|c| c == "mcp remove --scope user andrui"));
    }

    #[test]
    fn finds_claude_under_nvm_without_path() {
        let home = TempDir::new().unwrap();
        let ai = AiIntegration {
            claude: None,
            ..integration(home.path())
        };
        assert_eq!(ai.find_claude(), None);
        for version in ["v18.0.0", "v22.14.0"] {
            let bin = home
                .path()
                .join(".nvm/versions/node")
                .join(version)
                .join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::write(bin.join("claude"), "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(bin.join("claude"), std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        assert_eq!(
            ai.find_claude().unwrap(),
            home.path().join(".nvm/versions/node/v22.14.0/bin/claude")
        );
    }

    #[test]
    fn reads_local_scope_and_bad_config() {
        let home = TempDir::new().unwrap();
        let ai = integration(home.path());
        std::fs::write(
            ai.config_path(),
            r#"{"projects":{"/repo":{"mcpServers":{"andrui":{"command":"/usr/bin/andrui-terminal","args":["mcp","--server","http://127.0.0.1:19801"]}}}}}"#,
        )
        .unwrap();
        let status = ai.mcp_status();
        assert!(status.registered);
        assert_eq!(status.scope.as_deref(), Some("local:/repo"));
        assert!(
            !status.matches_expected,
            "only user scope counts as installed"
        );

        std::fs::write(ai.config_path(), "{not json").unwrap();
        let status = ai.mcp_status();
        assert!(!status.registered);
        assert!(status.reason.unwrap().contains("Could not parse"));
    }

    #[tokio::test]
    async fn installs_and_updates_skill() {
        let home = TempDir::new().unwrap();
        let ai = integration(home.path());
        let status = ai.install_skill().await.unwrap();
        assert!(status.skill.installed && status.skill.up_to_date);
        assert_eq!(
            std::fs::read_to_string(ai.skill_path()).unwrap(),
            SKILL_CONTENT
        );

        std::fs::write(ai.skill_path(), "old").unwrap();
        let status = ai.skill_status();
        assert!(status.installed && !status.up_to_date);
        assert!(ai.install_skill().await.unwrap().skill.up_to_date);
    }

    #[test]
    fn bundled_skill_has_frontmatter() {
        assert!(SKILL_CONTENT.starts_with("---\nname: andrui-terminal\ndescription: "));
    }

    #[tokio::test]
    async fn test_mcp_reports_missing_binary() {
        let home = TempDir::new().unwrap();
        let mut ai = integration(home.path());
        ai.mcp_command = "/nonexistent/mcp-binary".to_string();
        let result = ai.test_mcp().await;
        assert!(!result.ok);
        assert!(result.error.unwrap().contains("not found"));
    }

    #[tokio::test]
    async fn test_mcp_succeeds_with_mock_mcp() {
        let home = TempDir::new().unwrap();
        let mock_script = home.path().join("mock_mcp.py");
        std::fs::write(
            &mock_script,
            r#"#!/usr/bin/env python3
import sys, json

for line in sys.stdin:
    if not line.strip():
        continue
    req = json.loads(line)
    method = req.get("method")
    id_ = req.get("id")
    if method == "initialize":
        res = {"protocolVersion": "2025-06-18", "serverInfo": {"name": "andrui-terminal", "version": "0.1.0"}}
    elif method == "ping":
        res = {}
    elif method == "tools/list":
        res = {"tools": [{"name": "android_list_devices"}]}
    elif method == "tools/call":
        res = {"content": [{"type": "text", "text": "[]"}], "isError": False}
    else:
        res = {}
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": id_, "result": res}) + "\n")
    sys.stdout.flush()
"#,
        )
        .unwrap();
        std::fs::set_permissions(&mock_script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let mut ai = integration(home.path());
        ai.mcp_command = mock_script.to_string_lossy().to_string();
        let result = ai.test_mcp().await;
        assert!(result.ok);
        assert_eq!(result.protocol_version.as_deref(), Some("2025-06-18"));
        assert_eq!(result.server_name.as_deref(), Some("andrui-terminal"));
        assert_eq!(result.tool_count, 1);
        assert!(result.sample_tool_call_ok);
    }

    #[tokio::test]
    async fn removes_mcp_and_skill() {
        let home = TempDir::new().unwrap();
        fake_claude(home.path());
        let ai = integration(home.path());

        ai.install_mcp().await.unwrap();
        ai.install_skill().await.unwrap();
        let s = ai.status().await;
        assert!(s.mcp.registered);
        assert!(s.skill.installed);
        assert!(s.mcp.matches_expected && !s.mcp.restart_required);
        assert!(s.skill.up_to_date);

        let s2 = ai.remove_mcp().await.unwrap();
        assert!(!s2.mcp.registered);

        let s3 = ai.remove_skill().await.unwrap();
        assert!(!s3.skill.installed);
        assert!(!ai.skill_path().exists());
    }
}
