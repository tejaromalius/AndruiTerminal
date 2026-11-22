use serde_json::Value;

use crate::error::{ApiError, ApiResult};
use crate::models::CommandPreview;

pub struct BuiltCommand {
    pub program: String,
    pub args: Vec<String>,
}

impl BuiltCommand {
    pub fn to_preview(&self) -> CommandPreview {
        let display = format_command_display(&self.program, &self.args);
        CommandPreview {
            program: self.program.clone(),
            args: self.args.clone(),
            display,
        }
    }
}

pub fn format_command_display(program: &str, args: &[String]) -> String {
    let mut parts = vec![program.to_string()];
    for arg in args {
        if arg.contains(' ') || arg.contains('"') || arg.contains('\'') || arg.is_empty() {
            parts.push(format!("\"{}\"", arg.replace('\"', "\\\"")));
        } else {
            parts.push(arg.clone());
        }
    }
    parts.join(" ")
}

fn add_device_targeting(args: &mut Vec<String>, device_id: Option<&str>) {
    if let Some(id) = device_id {
        if !id.is_empty() {
            args.push("-s".to_string());
            args.push(id.to_string());
        }
    }
}

fn get_str<'a>(params: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    params.get(key).and_then(|v| v.as_str())
}

fn get_bool(params: &serde_json::Map<String, Value>, key: &str) -> bool {
    params.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn get_u64(params: &serde_json::Map<String, Value>, key: &str) -> Option<u64> {
    params.get(key).and_then(|v| v.as_u64())
}

fn get_i64(params: &serde_json::Map<String, Value>, key: &str) -> Option<i64> {
    params.get(key).and_then(|v| v.as_i64())
}

fn get_f64(params: &serde_json::Map<String, Value>, key: &str) -> Option<f64> {
    params.get(key).and_then(|v| v.as_f64())
}

pub fn build_adb_command(
    adb_program: &str,
    operation_id: &str,
    device_id: Option<&str>,
    params: &serde_json::Map<String, Value>,
) -> ApiResult<BuiltCommand> {
    if operation_id.starts_with("automation.") {
        let request = crate::operations::semantic::request(operation_id, device_id, params)?;
        return Ok(BuiltCommand {
            program: "automation-helper".into(),
            args: vec![serde_json::to_string(&request)
                .map_err(|e| ApiError::bad_request("INVALID_ACTION", e.to_string()))?],
        });
    }
    let mut args = Vec::new();

    match operation_id {
        // --- Category C: Connectivity / Discovery / Server ---
        "device.list" => {
            args.push("devices".to_string());
            args.push("-l".to_string());
        }
        "device.connect" => {
            let host = get_str(params, "host").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'host' is required")
            })?;
            let port = get_u64(params, "port").unwrap_or(5555);
            args.push("connect".to_string());
            args.push(if host.contains(':') {
                host.to_string()
            } else {
                format!("{}:{}", host, port)
            });
        }
        "device.disconnect" => {
            args.push("disconnect".to_string());
            if let Some(host) = get_str(params, "host") {
                if let Some(port) = get_u64(params, "port") {
                    args.push(if host.contains(':') {
                        host.to_string()
                    } else {
                        format!("{}:{}", host, port)
                    });
                } else {
                    args.push(host.to_string());
                }
            } else if let Some(id) = device_id {
                args.push(id.to_string());
            }
        }
        "device.pair" => {
            let host = get_str(params, "host").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'host' is required")
            })?;
            let port = get_u64(params, "port")
                .or_else(|| {
                    host.rsplit_once(':')
                        .and_then(|(_, port)| port.parse::<u64>().ok())
                })
                .filter(|port| *port > 0 && *port <= 65535)
                .ok_or_else(|| {
                    ApiError::bad_request("MISSING_PARAM", "Provide a pairing port or HOST:PORT")
                })?;
            let code = get_str(params, "code").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'code' is required")
            })?;
            args.push("pair".to_string());
            args.push(if host.contains(':') {
                host.to_string()
            } else {
                format!("{}:{}", host, port)
            });
            args.push(code.to_string());
        }
        "device.mdns.check" => {
            args.push("mdns".to_string());
            args.push("check".to_string());
        }
        "device.mdns.services" => {
            args.push("mdns".to_string());
            args.push("services".to_string());
        }
        "device.tcpip" => {
            add_device_targeting(&mut args, device_id);
            let port = get_u64(params, "port").unwrap_or(5555);
            args.push("tcpip".to_string());
            args.push(port.to_string());
        }
        "device.usb" => {
            add_device_targeting(&mut args, device_id);
            args.push("usb".to_string());
        }
        "device.reconnect" => {
            args.push("reconnect".to_string());
            if let Some(sub) = get_str(params, "target") {
                if sub == "device" || sub == "offline" {
                    args.push(sub.to_string());
                }
            }
        }
        "device.attach" => {
            let serial = get_str(params, "serial").or(device_id).ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'serial' is required")
            })?;
            args.push("attach".to_string());
            args.push(serial.to_string());
        }
        "device.detach" => {
            let serial = get_str(params, "serial").or(device_id).ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'serial' is required")
            })?;
            args.push("detach".to_string());
            args.push(serial.to_string());
        }
        "server.start" => {
            args.push("start-server".to_string());
        }
        "server.kill" => {
            args.push("kill-server".to_string());
        }
        "server.status" => {
            args.push("server-status".to_string());
        }
        "server.features" => {
            add_device_targeting(&mut args, device_id);
            args.push("features".to_string());
        }
        "server.host_features" => {
            args.push("host-features".to_string());
        }
        "server.keygen" => {
            let file = get_str(params, "file").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'file' is required")
            })?;
            args.push("keygen".to_string());
            args.push(file.to_string());
        }
        "server.pubkey" => {
            let file = get_str(params, "file").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'file' is required")
            })?;
            args.push("pubkey".to_string());
            args.push(file.to_string());
        }

        // --- Category E: Execution & Shell ---
        "shell.exec" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            let command = get_str(params, "command").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'command' is required")
            })?;
            args.push(command.to_string());
        }
        "shell.raw" => {
            add_device_targeting(&mut args, device_id);
            args.push("raw".to_string());
            let service = get_str(params, "service").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'service' is required")
            })?;
            args.push(service.to_string());
        }
        "exec.out" => {
            add_device_targeting(&mut args, device_id);
            args.push("exec-out".to_string());
            let command = get_str(params, "command").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'command' is required")
            })?;
            args.push(command.to_string());
        }
        "exec.in" => {
            add_device_targeting(&mut args, device_id);
            args.push("exec-in".to_string());
            let command = get_str(params, "command").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'command' is required")
            })?;
            args.push(command.to_string());
        }
        "device.wait_for" => {
            add_device_targeting(&mut args, device_id);
            let state = get_str(params, "state").unwrap_or("device");
            let transport = get_str(params, "transport");
            let wait_cmd = match transport {
                Some("usb") => format!("wait-for-usb-{}", state),
                Some("local") => format!("wait-for-local-{}", state),
                Some("any") => format!("wait-for-any-{}", state),
                _ => format!("wait-for-{}", state),
            };
            args.push(wait_cmd);
        }
        "device.get_state" => {
            add_device_targeting(&mut args, device_id);
            args.push("get-state".to_string());
        }
        "device.get_serialno" => {
            add_device_targeting(&mut args, device_id);
            args.push("get-serialno".to_string());
        }
        "device.get_devpath" => {
            add_device_targeting(&mut args, device_id);
            args.push("get-devpath".to_string());
        }
        "emu.command" => {
            add_device_targeting(&mut args, device_id);
            args.push("emu".to_string());
            let command = get_str(params, "command").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'command' is required")
            })?;
            args.push(command.to_string());
        }
        "adb.version" => {
            args.push("version".to_string());
        }
        "adb.help" => {
            args.push("help".to_string());
        }
        "execution.frida_start" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            let path = get_str(params, "path").unwrap_or("/data/local/tmp/frida-server");
            let use_su = get_bool(params, "useSu");
            if use_su {
                args.push(format!("su -c '{} -D &'", path));
            } else {
                args.push(format!("{} -D &", path));
            }
        }
        "execution.frida_status" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("ps -A | grep -i frida || echo 'Frida is not running'".to_string());
        }

        // --- Category F: File Management ---
        "file.push" => {
            add_device_targeting(&mut args, device_id);
            args.push("push".to_string());
            if get_bool(params, "sync") {
                args.push("--sync".to_string());
            }
            if get_bool(params, "dryRun") {
                args.push("-n".to_string());
            }
            if let Some(algo) = get_str(params, "compression") {
                if algo == "none" {
                    args.push("-Z".to_string());
                } else {
                    args.push("-z".to_string());
                    args.push(algo.to_string());
                }
            }
            let local = get_str(params, "local").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'local' is required")
            })?;
            let remote = get_str(params, "remote").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'remote' is required")
            })?;
            args.push(local.to_string());
            args.push(remote.to_string());
        }
        "file.pull" => {
            add_device_targeting(&mut args, device_id);
            args.push("pull".to_string());
            if get_bool(params, "preserveMode") {
                args.push("-a".to_string());
            }
            if let Some(algo) = get_str(params, "compression") {
                if algo == "none" {
                    args.push("-Z".to_string());
                } else {
                    args.push("-z".to_string());
                    args.push(algo.to_string());
                }
            }
            let remote = get_str(params, "remote").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'remote' is required")
            })?;
            let local = get_str(params, "local").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'local' is required")
            })?;
            args.push(remote.to_string());
            args.push(local.to_string());
        }
        "file.sync" => {
            add_device_targeting(&mut args, device_id);
            args.push("sync".to_string());
            if get_bool(params, "dryRun") {
                args.push("-n".to_string());
            }
            if get_bool(params, "listOnly") {
                args.push("-l".to_string());
            }
            if let Some(partition) = get_str(params, "partition") {
                args.push(partition.to_string());
            }
        }
        "file.mkdir" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("mkdir".to_string());
            args.push("-p".to_string());
            let path = get_str(params, "path").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'path' is required")
            })?;
            args.push(path.to_string());
        }
        "file.rm" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("rm".to_string());
            if get_bool(params, "recursive") {
                args.push("-r".to_string());
            }
            args.push("-f".to_string());
            let path = get_str(params, "path").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'path' is required")
            })?;
            args.push(path.to_string());
        }
        "file.mv" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("mv".to_string());
            let src = get_str(params, "src").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'src' is required")
            })?;
            let dest = get_str(params, "dest").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'dest' is required")
            })?;
            args.push(src.to_string());
            args.push(dest.to_string());
        }
        "file.chmod" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("chmod".to_string());
            if get_bool(params, "recursive") {
                args.push("-R".to_string());
            }
            let mode = get_str(params, "mode").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'mode' is required")
            })?;
            let path = get_str(params, "path").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'path' is required")
            })?;
            args.push(mode.to_string());
            args.push(path.to_string());
        }
        "file.chown" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("chown".to_string());
            if get_bool(params, "recursive") {
                args.push("-R".to_string());
            }
            let owner = get_str(params, "owner").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'owner' is required")
            })?;
            let path = get_str(params, "path").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'path' is required")
            })?;
            args.push(owner.to_string());
            args.push(path.to_string());
        }
        "file.stat" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("stat".to_string());
            let path = get_str(params, "path").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'path' is required")
            })?;
            args.push(path.to_string());
        }
        "file.run_as" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("run-as".to_string());
            let package = get_str(params, "package").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'package' is required")
            })?;
            let command = get_str(params, "command").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'command' is required")
            })?;
            args.push(package.to_string());
            args.push(command.to_string());
        }

        // --- Category P: Package Lifecycle ---
        "package.install" => {
            add_device_targeting(&mut args, device_id);
            args.push("install".to_string());
            if get_bool(params, "reinstall") {
                args.push("-r".to_string());
            }
            if get_bool(params, "allowTest") {
                args.push("-t".to_string());
            }
            if get_bool(params, "allowDowngrade") {
                args.push("-d".to_string());
            }
            if get_bool(params, "grantPermissions") {
                args.push("-g".to_string());
            }
            if get_bool(params, "instant") {
                args.push("--instant".to_string());
            }
            if let Some(abi) = get_str(params, "abi") {
                args.push("--abi".to_string());
                args.push(abi.to_string());
            }
            if let Some(user) = get_str(params, "user") {
                args.push("--user".to_string());
                args.push(user.to_string());
            }
            if let Some(streaming) = params.get("streaming").and_then(|v| v.as_bool()) {
                if streaming {
                    args.push("--streaming".to_string());
                } else {
                    args.push("--no-streaming".to_string());
                }
            }
            if let Some(incremental) = params.get("incremental").and_then(|v| v.as_bool()) {
                if incremental {
                    args.push("--incremental".to_string());
                } else {
                    args.push("--no-incremental".to_string());
                }
            }
            let apk_path = get_str(params, "apkPath").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'apkPath' is required")
            })?;
            args.push(apk_path.to_string());
        }
        "package.install_multiple" => {
            add_device_targeting(&mut args, device_id);
            args.push("install-multiple".to_string());
            if get_bool(params, "reinstall") {
                args.push("-r".to_string());
            }
            if get_bool(params, "allowTest") {
                args.push("-t".to_string());
            }
            if get_bool(params, "allowDowngrade") {
                args.push("-d".to_string());
            }
            if get_bool(params, "grantPermissions") {
                args.push("-g".to_string());
            }
            if let Some(inherited) = get_str(params, "inherit") {
                args.push("-p".to_string());
                args.push(inherited.to_string());
            }
            let apks = params
                .get("apkPaths")
                .and_then(|v| v.as_array())
                .ok_or_else(|| {
                    ApiError::bad_request("MISSING_PARAM", "Parameter 'apkPaths' array is required")
                })?;
            for apk in apks {
                if let Some(path) = apk.as_str() {
                    args.push(path.to_string());
                }
            }
        }
        "package.install_multi_package" => {
            add_device_targeting(&mut args, device_id);
            args.push("install-multi-package".to_string());
            let apks = params
                .get("apkPaths")
                .and_then(|v| v.as_array())
                .ok_or_else(|| {
                    ApiError::bad_request("MISSING_PARAM", "Parameter 'apkPaths' array is required")
                })?;
            for apk in apks {
                if let Some(path) = apk.as_str() {
                    args.push(path.to_string());
                }
            }
        }
        "package.uninstall" => {
            add_device_targeting(&mut args, device_id);
            args.push("uninstall".to_string());
            if get_bool(params, "keepData") {
                args.push("-k".to_string());
            }
            if let Some(user) = get_str(params, "user") {
                args.push("--user".to_string());
                args.push(user.to_string());
            }
            if let Some(vc) = get_u64(params, "versionCode") {
                args.push("--versionCode".to_string());
                args.push(vc.to_string());
            }
            let package = get_str(params, "package").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'package' is required")
            })?;
            args.push(package.to_string());
        }
        "package.list" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("pm".to_string());
            args.push("list".to_string());
            args.push("packages".to_string());
            if get_bool(params, "thirdPartyOnly") {
                args.push("-3".to_string());
            }
            if get_bool(params, "systemOnly") {
                args.push("-s".to_string());
            }
            if get_bool(params, "enabledOnly") {
                args.push("-e".to_string());
            }
            if get_bool(params, "disabledOnly") {
                args.push("-d".to_string());
            }
            if get_bool(params, "showUid") {
                args.push("-U".to_string());
            }
            if let Some(user) = get_str(params, "user") {
                args.push("--user".to_string());
                args.push(user.to_string());
            }
        }
        "package.path" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("pm".to_string());
            args.push("path".to_string());
            let package = get_str(params, "package").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'package' is required")
            })?;
            args.push(package.to_string());
        }
        "package.clear" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("pm".to_string());
            args.push("clear".to_string());
            if let Some(user) = get_str(params, "user") {
                args.push("--user".to_string());
                args.push(user.to_string());
            }
            let package = get_str(params, "package").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'package' is required")
            })?;
            args.push(package.to_string());
        }
        "package.enable" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("pm".to_string());
            args.push("enable".to_string());
            if let Some(user) = get_str(params, "user") {
                args.push("--user".to_string());
                args.push(user.to_string());
            }
            let target = get_str(params, "target").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'target' is required")
            })?;
            args.push(target.to_string());
        }
        "package.disable" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("pm".to_string());
            args.push("disable-user".to_string());
            if let Some(user) = get_str(params, "user") {
                args.push("--user".to_string());
                args.push(user.to_string());
            }
            let target = get_str(params, "target").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'target' is required")
            })?;
            args.push(target.to_string());
        }
        "package.suspend" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("pm".to_string());
            args.push("suspend".to_string());
            if let Some(user) = get_str(params, "user") {
                args.push("--user".to_string());
                args.push(user.to_string());
            }
            let package = get_str(params, "package").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'package' is required")
            })?;
            args.push(package.to_string());
        }
        "package.unsuspend" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("pm".to_string());
            args.push("unsuspend".to_string());
            if let Some(user) = get_str(params, "user") {
                args.push("--user".to_string());
                args.push(user.to_string());
            }
            let package = get_str(params, "package").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'package' is required")
            })?;
            args.push(package.to_string());
        }
        "activity.start" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("am".to_string());
            args.push("start".to_string());
            if get_bool(params, "wait") {
                args.push("-W".to_string());
            }
            if get_bool(params, "forceStop") {
                args.push("-S".to_string());
            }
            if get_bool(params, "debug") {
                args.push("-D".to_string());
            }
            if let Some(action) = get_str(params, "action") {
                args.push("-a".to_string());
                args.push(action.to_string());
            }
            if let Some(data) = get_str(params, "data") {
                args.push("-d".to_string());
                args.push(data.to_string());
            }
            if let Some(mime) = get_str(params, "type") {
                args.push("-t".to_string());
                args.push(mime.to_string());
            }
            if let Some(component) = get_str(params, "component") {
                args.push("-n".to_string());
                args.push(component.to_string());
            }
            if let Some(user) = get_str(params, "user") {
                args.push("--user".to_string());
                args.push(user.to_string());
            }
        }
        "activity.force_stop" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("am".to_string());
            args.push("force-stop".to_string());
            let package = get_str(params, "package").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'package' is required")
            })?;
            args.push(package.to_string());
        }
        "activity.kill" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("am".to_string());
            args.push("kill".to_string());
            if let Some(user) = get_str(params, "user") {
                args.push("--user".to_string());
                args.push(user.to_string());
            }
            let package = get_str(params, "package").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'package' is required")
            })?;
            args.push(package.to_string());
        }
        "activity.kill_all" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("am".to_string());
            args.push("kill-all".to_string());
        }
        "service.start" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("am".to_string());
            if get_bool(params, "foreground") {
                args.push("start-foreground-service".to_string());
            } else {
                args.push("startservice".to_string());
            }
            if let Some(user) = get_str(params, "user") {
                args.push("--user".to_string());
                args.push(user.to_string());
            }
            let component = get_str(params, "component").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'component' is required")
            })?;
            args.push(component.to_string());
        }
        "service.stop" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("am".to_string());
            args.push("stopservice".to_string());
            if let Some(user) = get_str(params, "user") {
                args.push("--user".to_string());
                args.push(user.to_string());
            }
            let component = get_str(params, "component").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'component' is required")
            })?;
            args.push(component.to_string());
        }
        "broadcast.send" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("am".to_string());
            args.push("broadcast".to_string());
            if let Some(action) = get_str(params, "action") {
                args.push("-a".to_string());
                args.push(action.to_string());
            }
            if let Some(user) = get_str(params, "user") {
                args.push("--user".to_string());
                args.push(user.to_string());
            }
        }
        "instrumentation.run" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("am".to_string());
            args.push("instrument".to_string());
            if get_bool(params, "wait") {
                args.push("-w".to_string());
            }
            if get_bool(params, "raw") {
                args.push("-r".to_string());
            }
            let component = get_str(params, "component").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'component' is required")
            })?;
            args.push(component.to_string());
        }
        "debug.set_app" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("am".to_string());
            args.push("set-debug-app".to_string());
            if get_bool(params, "waitForDebugger") {
                args.push("-w".to_string());
            }
            if get_bool(params, "persistent") {
                args.push("--persistent".to_string());
            }
            let package = get_str(params, "package").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'package' is required")
            })?;
            args.push(package.to_string());
        }
        "debug.clear_app" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("am".to_string());
            args.push("clear-debug-app".to_string());
        }
        "permission.grant" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("pm".to_string());
            args.push("grant".to_string());
            if let Some(user) = get_str(params, "user") {
                args.push("--user".to_string());
                args.push(user.to_string());
            }
            let package = get_str(params, "package").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'package' is required")
            })?;
            let permission = get_str(params, "permission").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'permission' is required")
            })?;
            args.push(package.to_string());
            args.push(permission.to_string());
        }
        "permission.revoke" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("pm".to_string());
            args.push("revoke".to_string());
            if let Some(user) = get_str(params, "user") {
                args.push("--user".to_string());
                args.push(user.to_string());
            }
            let package = get_str(params, "package").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'package' is required")
            })?;
            let permission = get_str(params, "permission").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'permission' is required")
            })?;
            args.push(package.to_string());
            args.push(permission.to_string());
        }
        "appops.set" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("cmd".to_string());
            args.push("appops".to_string());
            args.push("set".to_string());
            if let Some(user) = get_str(params, "user") {
                args.push("--user".to_string());
                args.push(user.to_string());
            }
            let package = get_str(params, "package").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'package' is required")
            })?;
            let op = get_str(params, "op").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'op' is required")
            })?;
            let mode = get_str(params, "mode").unwrap_or("default");
            args.push(package.to_string());
            args.push(op.to_string());
            args.push(mode.to_string());
        }
        "applinks.get" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("pm".to_string());
            args.push("get-app-links".to_string());
            let package = get_str(params, "package").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'package' is required")
            })?;
            args.push(package.to_string());
        }
        "applinks.verify" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("pm".to_string());
            args.push("verify-app-links".to_string());
            if get_bool(params, "reVerify") {
                args.push("--re-verify".to_string());
            }
            let package = get_str(params, "package").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'package' is required")
            })?;
            args.push(package.to_string());
        }
        "users.list" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("pm".to_string());
            args.push("list".to_string());
            args.push("users".to_string());
        }
        "users.create" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("pm".to_string());
            args.push("create-user".to_string());
            let name = get_str(params, "name").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'name' is required")
            })?;
            args.push(name.to_string());
        }
        "users.remove" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("pm".to_string());
            args.push("remove-user".to_string());
            let user_id = get_str(params, "userId").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'userId' is required")
            })?;
            args.push(user_id.to_string());
        }
        "dpm.set_device_owner" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("dpm".to_string());
            args.push("set-device-owner".to_string());
            let component = get_str(params, "component").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'component' is required")
            })?;
            args.push(component.to_string());
        }

        // --- Category D: Diagnostics & Logs ---
        "logcat.dump" => {
            add_device_targeting(&mut args, device_id);
            args.push("logcat".to_string());
            if params
                .get("dumpOnly")
                .and_then(|v| v.as_bool())
                .unwrap_or(true)
            {
                args.push("-d".to_string());
            }
            if let Some(pid) = get_u64(params, "pid") {
                args.push(format!("--pid={pid}"));
            }
            if let Some(regex) = get_str(params, "regex") {
                args.push("-e".to_string());
                args.push(regex.to_string());
            }
            if let Some(b) = get_str(params, "buffer") {
                args.push("-b".to_string());
                args.push(b.to_string());
            }
            if let Some(v) = get_str(params, "format") {
                args.push("-v".to_string());
                args.push(v.to_string());
            }
            if let Some(t) = get_u64(params, "lines") {
                args.push("-t".to_string());
                args.push(t.to_string());
            }
            if let Some(filter) = get_str(params, "filter") {
                if filter.split_whitespace().any(|part| part.starts_with('-')) {
                    return Err(ApiError::bad_request(
                        "INVALID_FILTER",
                        "Logcat filters must be tag/priority specifications, not command flags",
                    ));
                }
                args.push(filter.to_string());
            }
        }
        "logcat.clear" => {
            add_device_targeting(&mut args, device_id);
            args.push("logcat".to_string());
            args.push("-c".to_string());
            if let Some(b) = get_str(params, "buffer") {
                args.push("-b".to_string());
                args.push(b.to_string());
            }
        }
        "logcat.stats" => {
            add_device_targeting(&mut args, device_id);
            args.push("logcat".to_string());
            args.push("-S".to_string());
        }
        "diagnostics.bugreport" => {
            add_device_targeting(&mut args, device_id);
            args.push("bugreport".to_string());
            if let Some(path) = get_str(params, "path") {
                args.push(path.to_string());
            }
        }
        "diagnostics.jdwp" => {
            add_device_targeting(&mut args, device_id);
            args.push("jdwp".to_string());
        }
        "diagnostics.dumpsys" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("dumpsys".to_string());
            let service = get_str(params, "service").unwrap_or_else(|| {
                if params.contains_key("package") {
                    "package"
                } else {
                    ""
                }
            });
            if !service.is_empty() {
                args.push(service.to_string());
            }
            if let Some(pkg) = get_str(params, "package") {
                args.push(pkg.to_string());
            }
        }
        "diagnostics.cpu" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("top".to_string());
            args.push("-n".to_string());
            args.push("1".to_string());
            args.push("-m".to_string());
            let count = get_u64(params, "count").unwrap_or(10);
            args.push(count.to_string());
        }
        "diagnostics.meminfo" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("dumpsys".to_string());
            args.push("meminfo".to_string());
            if let Some(package) = get_str(params, "package") {
                args.push(package.to_string());
            }
        }
        "diagnostics.gfxinfo" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("dumpsys".to_string());
            args.push("gfxinfo".to_string());
            if let Some(package) = get_str(params, "package") {
                args.push(package.to_string());
            }
        }
        "diagnostics.batterystats" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("dumpsys".to_string());
            args.push("batterystats".to_string());
        }
        "diagnostics.netstats" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("dumpsys".to_string());
            args.push("netstats".to_string());
        }
        "diagnostics.getprop" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("getprop".to_string());
            if let Some(prop) = get_str(params, "property") {
                args.push(prop.to_string());
            }
        }
        "diagnostics.setprop" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("setprop".to_string());
            let prop = get_str(params, "property").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'property' is required")
            })?;
            let val = get_str(params, "value").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'value' is required")
            })?;
            args.push(prop.to_string());
            args.push(val.to_string());
        }
        "diagnostics.settings_get" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("settings".to_string());
            args.push("get".to_string());
            let namespace = get_str(params, "namespace").unwrap_or("system");
            let key = get_str(params, "key").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'key' is required")
            })?;
            args.push(namespace.to_string());
            args.push(key.to_string());
        }
        "diagnostics.settings_put" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("settings".to_string());
            args.push("put".to_string());
            let namespace = get_str(params, "namespace").unwrap_or("system");
            let key = get_str(params, "key").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'key' is required")
            })?;
            let value = get_str(params, "value").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'value' is required")
            })?;
            args.push(namespace.to_string());
            args.push(key.to_string());
            args.push(value.to_string());
        }
        "diagnostics.net_interfaces" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("ip".to_string());
            args.push("addr".to_string());
        }
        "diagnostics.net_routes" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("ip".to_string());
            args.push("route".to_string());
        }

        // --- Category V: Screen & Interaction ---
        "screen.screencap" => {
            add_device_targeting(&mut args, device_id);
            args.push("exec-out".to_string());
            args.push("screencap".to_string());
            args.push("-p".to_string());
        }
        "screen.screenrecord" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("screenrecord".to_string());
            if let Some(size) = get_str(params, "size") {
                args.push("--size".to_string());
                args.push(size.to_string());
            }
            if let Some(bitrate) = get_u64(params, "bitRate") {
                args.push("--bit-rate".to_string());
                args.push(bitrate.to_string());
            }
            if let Some(limit) = get_u64(params, "timeLimit") {
                args.push("--time-limit".to_string());
                args.push(limit.to_string());
            }
            if let Some(display_id) = get_u64(params, "displayId") {
                args.push("--display-id".to_string());
                args.push(display_id.to_string());
            }
            let remote_path = get_str(params, "remotePath").unwrap_or("/sdcard/recording.mp4");
            args.push(remote_path.to_string());
        }
        "input.keyevent" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("input".to_string());
            args.push("keyevent".to_string());
            if let Some(kc) = params.get("keycode") {
                if let Some(s) = kc.as_str() {
                    args.push(s.to_string());
                } else if let Some(i) = kc.as_i64() {
                    args.push(i.to_string());
                } else {
                    return Err(ApiError::bad_request("INVALID_PARAM", "Invalid keycode"));
                }
            } else {
                return Err(ApiError::bad_request(
                    "MISSING_PARAM",
                    "Parameter 'keycode' is required",
                ));
            }
        }
        "input.tap" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("input".to_string());
            args.push("tap".to_string());
            let x = get_i64(params, "x").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'x' is required")
            })?;
            let y = get_i64(params, "y").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'y' is required")
            })?;
            args.push(x.to_string());
            args.push(y.to_string());
        }
        "input.swipe" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("input".to_string());
            args.push("swipe".to_string());
            let x1 = get_i64(params, "x1").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'x1' is required")
            })?;
            let y1 = get_i64(params, "y1").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'y1' is required")
            })?;
            let x2 = get_i64(params, "x2").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'x2' is required")
            })?;
            let y2 = get_i64(params, "y2").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'y2' is required")
            })?;
            args.push(x1.to_string());
            args.push(y1.to_string());
            args.push(x2.to_string());
            args.push(y2.to_string());
            if let Some(duration) = get_u64(params, "durationMs") {
                args.push(duration.to_string());
            }
        }
        "input.draganddrop" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("input".to_string());
            args.push("draganddrop".to_string());
            let x1 = get_i64(params, "x1").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'x1' is required")
            })?;
            let y1 = get_i64(params, "y1").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'y1' is required")
            })?;
            let x2 = get_i64(params, "x2").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'x2' is required")
            })?;
            let y2 = get_i64(params, "y2").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'y2' is required")
            })?;
            args.push(x1.to_string());
            args.push(y1.to_string());
            args.push(x2.to_string());
            args.push(y2.to_string());
            if let Some(duration) = get_u64(params, "durationMs") {
                args.push(duration.to_string());
            }
        }
        "input.text" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("input".to_string());
            args.push("text".to_string());
            let text = get_str(params, "text").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'text' is required")
            })?;
            args.push(text.to_string());
        }
        "input.rotary" => {
            let value = get_f64(params, "axisValue")
                .filter(|v| v.is_finite() && (-100.0..=100.0).contains(v))
                .ok_or_else(|| {
                    ApiError::bad_request(
                        "INVALID_AXIS",
                        "axisValue must be a finite number between -100 and 100",
                    )
                })?;
            add_device_targeting(&mut args, device_id);
            args.extend([
                "shell".into(),
                "input".into(),
                "rotaryencoder".into(),
                "scroll".into(),
                "--axis".into(),
                format!("SCROLL,{value}"),
            ]);
        }
        "input.roll" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("input".to_string());
            args.push("roll".to_string());
            let dx = get_f64(params, "dx").unwrap_or(0.0);
            let dy = get_f64(params, "dy").unwrap_or(0.0);
            args.push(dx.to_string());
            args.push(dy.to_string());
        }
        "input.press" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("input".to_string());
            args.push("press".to_string());
        }
        "power.wake" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("input".to_string());
            args.push("keyevent".to_string());
            args.push("224".to_string()); // KEYCODE_WAKEUP
        }
        "power.sleep" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("input".to_string());
            args.push("keyevent".to_string());
            args.push("223".to_string()); // KEYCODE_SLEEP
        }

        // --- Category N: Networking / Port Forwarding ---
        "forward.create" => {
            add_device_targeting(&mut args, device_id);
            args.push("forward".to_string());
            if get_bool(params, "noRebind") {
                args.push("--no-rebind".to_string());
            }
            let local = get_str(params, "local").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'local' is required")
            })?;
            let remote = get_str(params, "remote").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'remote' is required")
            })?;
            args.push(local.to_string());
            args.push(remote.to_string());
        }
        "forward.list" => {
            add_device_targeting(&mut args, device_id);
            args.push("forward".to_string());
            args.push("--list".to_string());
        }
        "forward.remove" => {
            add_device_targeting(&mut args, device_id);
            args.push("forward".to_string());
            args.push("--remove".to_string());
            let local = get_str(params, "local").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'local' is required")
            })?;
            args.push(local.to_string());
        }
        "forward.remove_all" => {
            add_device_targeting(&mut args, device_id);
            args.push("forward".to_string());
            args.push("--remove-all".to_string());
        }
        "reverse.create" => {
            add_device_targeting(&mut args, device_id);
            args.push("reverse".to_string());
            if get_bool(params, "noRebind") {
                args.push("--no-rebind".to_string());
            }
            let remote = get_str(params, "remote").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'remote' is required")
            })?;
            let local = get_str(params, "local").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'local' is required")
            })?;
            args.push(remote.to_string());
            args.push(local.to_string());
        }
        "reverse.list" => {
            add_device_targeting(&mut args, device_id);
            args.push("reverse".to_string());
            args.push("--list".to_string());
        }
        "reverse.remove" => {
            add_device_targeting(&mut args, device_id);
            args.push("reverse".to_string());
            args.push("--remove".to_string());
            let remote = get_str(params, "remote").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'remote' is required")
            })?;
            args.push(remote.to_string());
        }
        "reverse.remove_all" => {
            add_device_targeting(&mut args, device_id);
            args.push("reverse".to_string());
            args.push("--remove-all".to_string());
        }
        "network.proxy_set" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("settings".to_string());
            args.push("put".to_string());
            args.push("global".to_string());
            args.push("http_proxy".to_string());
            let host = get_str(params, "host").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'host' is required")
            })?;
            let port = get_u64(params, "port").unwrap_or(8080);
            args.push(format!("{host}:{port}"));
        }
        "network.proxy_clear" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("settings".to_string());
            args.push("put".to_string());
            args.push("global".to_string());
            args.push("http_proxy".to_string());
            args.push(":0".to_string());
        }

        // --- Category X: System & Recovery ---
        "system.root" => {
            add_device_targeting(&mut args, device_id);
            args.push("root".to_string());
        }
        "system.unroot" => {
            add_device_targeting(&mut args, device_id);
            args.push("unroot".to_string());
        }
        "system.remount" => {
            add_device_targeting(&mut args, device_id);
            args.push("remount".to_string());
            if get_bool(params, "reboot") {
                args.push("-R".to_string());
            }
        }
        "system.disable_verity" => {
            add_device_targeting(&mut args, device_id);
            args.push("disable-verity".to_string());
        }
        "system.enable_verity" => {
            add_device_targeting(&mut args, device_id);
            args.push("enable-verity".to_string());
        }
        "system.reboot" => {
            add_device_targeting(&mut args, device_id);
            args.push("reboot".to_string());
            if let Some(target) = get_str(params, "target") {
                if !target.is_empty() {
                    args.push(target.to_string());
                }
            }
        }
        "system.sideload" => {
            add_device_targeting(&mut args, device_id);
            args.push("sideload".to_string());
            let package_path = get_str(params, "packagePath").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'packagePath' is required")
            })?;
            args.push(package_path.to_string());
        }
        "system.rescue_getprop" => {
            add_device_targeting(&mut args, device_id);
            args.push("rescue".to_string());
            args.push("getprop".to_string());
            let prop = get_str(params, "property").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'property' is required")
            })?;
            args.push(prop.to_string());
        }
        "system.rescue_install" => {
            add_device_targeting(&mut args, device_id);
            args.push("rescue".to_string());
            args.push("install".to_string());
            let package_path = get_str(params, "packagePath").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'packagePath' is required")
            })?;
            args.push(package_path.to_string());
        }
        "system.rescue_wipe" => {
            add_device_targeting(&mut args, device_id);
            args.push("rescue".to_string());
            args.push("wipe".to_string());
            args.push("userdata".to_string());
        }
        "system.backup" => {
            add_device_targeting(&mut args, device_id);
            args.push("backup".to_string());
            if let Some(f) = get_str(params, "file") {
                args.push("-f".to_string());
                args.push(f.to_string());
            }
            if get_bool(params, "apk") {
                args.push("-apk".to_string());
            } else {
                args.push("-noapk".to_string());
            }
            if get_bool(params, "shared") {
                args.push("-shared".to_string());
            } else {
                args.push("-noshared".to_string());
            }
            if get_bool(params, "all") {
                args.push("-all".to_string());
            }
            if let Some(pkgs) = params.get("packages").and_then(|v| v.as_array()) {
                for pkg in pkgs {
                    if let Some(p) = pkg.as_str() {
                        args.push(p.to_string());
                    }
                }
            }
        }
        "system.restore" => {
            add_device_targeting(&mut args, device_id);
            args.push("restore".to_string());
            let file = get_str(params, "file").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'file' is required")
            })?;
            args.push(file.to_string());
        }
        "system.testharness" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            args.push("cmd".to_string());
            args.push("testharness".to_string());
            args.push("enable".to_string());
        }
        "system.cert_install" => {
            add_device_targeting(&mut args, device_id);
            args.push("shell".to_string());
            let cert_path = get_str(params, "certPath").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'certPath' is required")
            })?;
            let target = get_str(params, "target").unwrap_or("user");
            if target == "system" {
                args.push(format!(
                    "su -c 'cp \"{}\" /system/etc/security/cacerts/ && chmod 644 /system/etc/security/cacerts/*'",
                    cert_path
                ));
            } else {
                args.push(format!(
                    "am start -a android.credentials.INSTALL -t application/x-x509-ca-cert -d file://\"{}\"",
                    cert_path
                ));
            }
        }
        "fastboot.devices" => {
            args.push("devices".to_string());
            args.push("-l".to_string());
        }
        "fastboot.getvar" => {
            add_device_targeting(&mut args, device_id);
            args.push("getvar".to_string());
            let var = get_str(params, "variable").unwrap_or("all");
            args.push(var.to_string());
        }
        "fastboot.set_active" => {
            add_device_targeting(&mut args, device_id);
            let slot = get_str(params, "slot").unwrap_or("a");
            args.push(format!("--set-active={}", slot));
        }
        "fastboot.flash" => {
            add_device_targeting(&mut args, device_id);
            args.push("flash".to_string());
            let partition = get_str(params, "partition").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'partition' is required")
            })?;
            let image_path = get_str(params, "imagePath").ok_or_else(|| {
                ApiError::bad_request("MISSING_PARAM", "Parameter 'imagePath' is required")
            })?;
            args.push(partition.to_string());
            args.push(image_path.to_string());
        }
        "fastboot.reboot" => {
            add_device_targeting(&mut args, device_id);
            args.push("reboot".to_string());
            if let Some(target) = get_str(params, "target") {
                if !target.is_empty() {
                    args.push(target.to_string());
                }
            }
        }

        _ => {
            return Err(ApiError::bad_request(
                "UNKNOWN_OPERATION",
                format!("Operation '{}' is not recognized", operation_id),
            ));
        }
    }

    // adb shell joins argv through the device shell. Quote data arguments there,
    // while keeping explicitly requested shell programs as programs.
    if operation_id == "file.run_as" {
        if let Some(package) = get_str(params, "package") {
            if package.is_empty()
                || !package
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
            {
                return Err(ApiError::bad_request(
                    "INVALID_PACKAGE",
                    "Invalid Android package identifier",
                ));
            }
        }
    }
    if operation_id != "shell.exec"
        && operation_id != "file.run_as"
        && !operation_id.starts_with("execution.frida")
        && operation_id != "system.cert_install"
    {
        if let Some(i) = args.iter().position(|arg| arg == "shell") {
            for arg in &mut args[i + 1..] {
                if !arg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "_./:=,@%+-".contains(c))
                    || arg.is_empty()
                {
                    *arg = format!("'{}'", arg.replace('\'', "'\"'\"'"));
                }
            }
        }
    }
    let program = if operation_id.starts_with("fastboot.") {
        "fastboot".to_string()
    } else {
        adb_program.to_string()
    };
    Ok(BuiltCommand { program, args })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_device_list_command() {
        let cmd = build_adb_command("adb", "device.list", None, &serde_json::Map::new()).unwrap();
        assert_eq!(cmd.args, vec!["devices", "-l"]);
        assert_eq!(cmd.to_preview().display, "adb devices -l");
    }

    #[test]
    fn test_package_install_command() {
        let mut params = serde_json::Map::new();
        params.insert("apkPath".to_string(), json!("/tmp/app.apk"));
        params.insert("reinstall".to_string(), json!(true));
        params.insert("grantPermissions".to_string(), json!(true));

        let cmd = build_adb_command("adb", "package.install", Some("device-123"), &params).unwrap();
        assert_eq!(
            cmd.args,
            vec!["-s", "device-123", "install", "-r", "-g", "/tmp/app.apk"]
        );
        assert_eq!(
            cmd.to_preview().display,
            "adb -s device-123 install -r -g /tmp/app.apk"
        );
    }

    #[test]
    fn test_file_push_command() {
        let mut params = serde_json::Map::new();
        params.insert("local".to_string(), json!("/tmp/source.txt"));
        params.insert("remote".to_string(), json!("/sdcard/dest.txt"));
        params.insert("sync".to_string(), json!(true));

        let cmd = build_adb_command("adb", "file.push", Some("dev1"), &params).unwrap();
        assert_eq!(
            cmd.args,
            vec![
                "-s",
                "dev1",
                "push",
                "--sync",
                "/tmp/source.txt",
                "/sdcard/dest.txt"
            ]
        );
    }
}
