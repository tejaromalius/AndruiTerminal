use andrui_core::adb::command_builder::build_adb_command;
use andrui_core::operations::catalog::get_operation_catalog;
use serde_json::json;

#[test]
fn test_all_catalog_operations_have_valid_coverage_ids_and_categories() {
    let catalog = get_operation_catalog();
    assert!(!catalog.is_empty(), "Catalog must not be empty");

    let allowed_categories = ["C", "E", "F", "P", "D", "V", "N", "X", "Automation"];
    for op in &catalog {
        assert!(
            allowed_categories.contains(&op.category.as_str()),
            "Operation {} has invalid category {}",
            op.id,
            op.category
        );
        assert!(
            !op.coverage_ids.is_empty() || op.id.starts_with("automation."),
            "Operation {} must have coverage_ids",
            op.id
        );
        for cov_id in &op.coverage_ids {
            assert!(
                cov_id.starts_with(&op.category),
                "Operation {} in category {} has mismatched coverage_id {}",
                op.id,
                op.category,
                cov_id
            );
        }
    }
}

#[test]
fn test_category_c_command_construction() {
    let p = serde_json::Map::new();
    let cmd = build_adb_command("adb", "device.list", None, &p).unwrap();
    assert_eq!(cmd.args, vec!["devices", "-l"]);

    let mut p = serde_json::Map::new();
    p.insert("host".to_string(), json!("192.168.1.10"));
    p.insert("port".to_string(), json!(5555));
    let cmd = build_adb_command("adb", "device.connect", None, &p).unwrap();
    assert_eq!(cmd.args, vec!["connect", "192.168.1.10:5555"]);

    let mut p = serde_json::Map::new();
    p.insert("host".to_string(), json!("192.168.1.10"));
    p.insert("port".to_string(), json!(5555));
    p.insert("code".to_string(), json!("123456"));
    let cmd = build_adb_command("adb", "device.pair", None, &p).unwrap();
    assert_eq!(cmd.args, vec!["pair", "192.168.1.10:5555", "123456"]);

    let cmd = build_adb_command("adb", "device.mdns.check", None, &serde_json::Map::new()).unwrap();
    assert_eq!(cmd.args, vec!["mdns", "check"]);

    let cmd =
        build_adb_command("adb", "device.mdns.services", None, &serde_json::Map::new()).unwrap();
    assert_eq!(cmd.args, vec!["mdns", "services"]);

    let mut p = serde_json::Map::new();
    p.insert("port".to_string(), json!(5555));
    let cmd = build_adb_command("adb", "device.tcpip", Some("dev1"), &p).unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "tcpip", "5555"]);

    let cmd =
        build_adb_command("adb", "device.usb", Some("dev1"), &serde_json::Map::new()).unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "usb"]);

    let mut p = serde_json::Map::new();
    p.insert("target".to_string(), json!("offline"));
    let cmd = build_adb_command("adb", "device.reconnect", None, &p).unwrap();
    assert_eq!(cmd.args, vec!["reconnect", "offline"]);

    let cmd = build_adb_command("adb", "server.start", None, &serde_json::Map::new()).unwrap();
    assert_eq!(cmd.args, vec!["start-server"]);

    let cmd = build_adb_command("adb", "server.kill", None, &serde_json::Map::new()).unwrap();
    assert_eq!(cmd.args, vec!["kill-server"]);

    let cmd = build_adb_command("adb", "server.status", None, &serde_json::Map::new()).unwrap();
    assert_eq!(cmd.args, vec!["server-status"]);

    let mut p = serde_json::Map::new();
    p.insert("file".to_string(), json!("/tmp/key"));
    let cmd = build_adb_command("adb", "server.keygen", None, &p).unwrap();
    assert_eq!(cmd.args, vec!["keygen", "/tmp/key"]);

    let cmd = build_adb_command("adb", "server.pubkey", None, &p).unwrap();
    assert_eq!(cmd.args, vec!["pubkey", "/tmp/key"]);
}

#[test]
fn test_category_e_command_construction() {
    let mut p = serde_json::Map::new();
    p.insert(
        "command".to_string(),
        json!("getprop ro.build.version.release"),
    );
    let cmd = build_adb_command("adb", "shell.exec", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec!["-s", "dev1", "shell", "getprop ro.build.version.release"]
    );

    let mut p = serde_json::Map::new();
    p.insert("service".to_string(), json!("shell,v2:"));
    let cmd = build_adb_command("adb", "shell.raw", Some("dev1"), &p).unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "raw", "shell,v2:"]);

    let mut p = serde_json::Map::new();
    p.insert("command".to_string(), json!("screencap -p"));
    let cmd = build_adb_command("adb", "exec.out", Some("dev1"), &p).unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "exec-out", "screencap -p"]);

    let mut p = serde_json::Map::new();
    p.insert("state".to_string(), json!("device"));
    p.insert("transport".to_string(), json!("usb"));
    let cmd = build_adb_command("adb", "device.wait_for", Some("dev1"), &p).unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "wait-for-usb-device"]);

    let cmd = build_adb_command(
        "adb",
        "device.get_state",
        Some("dev1"),
        &serde_json::Map::new(),
    )
    .unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "get-state"]);

    let cmd = build_adb_command(
        "adb",
        "device.get_serialno",
        Some("dev1"),
        &serde_json::Map::new(),
    )
    .unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "get-serialno"]);

    let cmd = build_adb_command(
        "adb",
        "device.get_devpath",
        Some("dev1"),
        &serde_json::Map::new(),
    )
    .unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "get-devpath"]);

    let mut p = serde_json::Map::new();
    p.insert("useSu".to_string(), json!(true));
    let cmd = build_adb_command("adb", "execution.frida_start", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec![
            "-s",
            "dev1",
            "shell",
            "su -c '/data/local/tmp/frida-server -D &'"
        ]
    );

    let cmd = build_adb_command(
        "adb",
        "execution.frida_status",
        Some("dev1"),
        &serde_json::Map::new(),
    )
    .unwrap();
    assert_eq!(
        cmd.args,
        vec![
            "-s",
            "dev1",
            "shell",
            "ps -A | grep -i frida || echo 'Frida is not running'"
        ]
    );
}

#[test]
fn test_category_f_command_construction() {
    let mut p = serde_json::Map::new();
    p.insert("local".to_string(), json!("/host/file.txt"));
    p.insert("remote".to_string(), json!("/sdcard/file.txt"));
    p.insert("sync".to_string(), json!(true));
    p.insert("dryRun".to_string(), json!(true));
    p.insert("compression".to_string(), json!("zstd"));
    let cmd = build_adb_command("adb", "file.push", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec![
            "-s",
            "dev1",
            "push",
            "--sync",
            "-n",
            "-z",
            "zstd",
            "/host/file.txt",
            "/sdcard/file.txt"
        ]
    );

    let mut p = serde_json::Map::new();
    p.insert("remote".to_string(), json!("/sdcard/file.txt"));
    p.insert("local".to_string(), json!("/host/file.txt"));
    p.insert("preserveMode".to_string(), json!(true));
    p.insert("compression".to_string(), json!("none"));
    let cmd = build_adb_command("adb", "file.pull", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec![
            "-s",
            "dev1",
            "pull",
            "-a",
            "-Z",
            "/sdcard/file.txt",
            "/host/file.txt"
        ]
    );

    let mut p = serde_json::Map::new();
    p.insert("path".to_string(), json!("/sdcard/testdir"));
    let cmd = build_adb_command("adb", "file.mkdir", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec!["-s", "dev1", "shell", "mkdir", "-p", "/sdcard/testdir"]
    );

    let mut p = serde_json::Map::new();
    p.insert("path".to_string(), json!("/sdcard/old.txt"));
    p.insert("recursive".to_string(), json!(true));
    let cmd = build_adb_command("adb", "file.rm", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec!["-s", "dev1", "shell", "rm", "-r", "-f", "/sdcard/old.txt"]
    );

    let mut p = serde_json::Map::new();
    p.insert("package".to_string(), json!("com.example.app"));
    p.insert("command".to_string(), json!("ls -la"));
    let cmd = build_adb_command("adb", "file.run_as", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec!["-s", "dev1", "shell", "run-as", "com.example.app", "ls -la"]
    );
}

#[test]
fn test_category_p_command_construction() {
    let mut p = serde_json::Map::new();
    p.insert("apkPath".to_string(), json!("/tmp/base.apk"));
    p.insert("reinstall".to_string(), json!(true));
    p.insert("allowTest".to_string(), json!(true));
    p.insert("allowDowngrade".to_string(), json!(true));
    p.insert("grantPermissions".to_string(), json!(true));
    p.insert("instant".to_string(), json!(true));
    p.insert("abi".to_string(), json!("arm64-v8a"));
    p.insert("user".to_string(), json!("0"));
    p.insert("streaming".to_string(), json!(true));
    p.insert("incremental".to_string(), json!(false));
    let cmd = build_adb_command("adb", "package.install", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec![
            "-s",
            "dev1",
            "install",
            "-r",
            "-t",
            "-d",
            "-g",
            "--instant",
            "--abi",
            "arm64-v8a",
            "--user",
            "0",
            "--streaming",
            "--no-incremental",
            "/tmp/base.apk"
        ]
    );

    let mut p = serde_json::Map::new();
    p.insert(
        "apkPaths".to_string(),
        json!(["/tmp/base.apk", "/tmp/split_config.arm64.apk"]),
    );
    p.insert("reinstall".to_string(), json!(true));
    let cmd = build_adb_command("adb", "package.install_multiple", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec![
            "-s",
            "dev1",
            "install-multiple",
            "-r",
            "/tmp/base.apk",
            "/tmp/split_config.arm64.apk"
        ]
    );

    let mut p = serde_json::Map::new();
    p.insert("package".to_string(), json!("com.example.app"));
    p.insert("keepData".to_string(), json!(true));
    p.insert("user".to_string(), json!("0"));
    let cmd = build_adb_command("adb", "package.uninstall", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec![
            "-s",
            "dev1",
            "uninstall",
            "-k",
            "--user",
            "0",
            "com.example.app"
        ]
    );

    let mut p = serde_json::Map::new();
    p.insert("thirdPartyOnly".to_string(), json!(true));
    p.insert("enabledOnly".to_string(), json!(true));
    let cmd = build_adb_command("adb", "package.list", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec!["-s", "dev1", "shell", "pm", "list", "packages", "-3", "-e"]
    );

    let mut p = serde_json::Map::new();
    p.insert(
        "component".to_string(),
        json!("com.example.app/.MainActivity"),
    );
    p.insert("action".to_string(), json!("android.intent.action.VIEW"));
    p.insert("wait".to_string(), json!(true));
    p.insert("forceStop".to_string(), json!(true));
    let cmd = build_adb_command("adb", "activity.start", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec![
            "-s",
            "dev1",
            "shell",
            "am",
            "start",
            "-W",
            "-S",
            "-a",
            "android.intent.action.VIEW",
            "-n",
            "com.example.app/.MainActivity"
        ]
    );

    let mut p = serde_json::Map::new();
    p.insert("package".to_string(), json!("com.example.app"));
    let cmd = build_adb_command("adb", "activity.force_stop", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec!["-s", "dev1", "shell", "am", "force-stop", "com.example.app"]
    );

    let mut p = serde_json::Map::new();
    p.insert("package".to_string(), json!("com.example.app"));
    p.insert("permission".to_string(), json!("android.permission.CAMERA"));
    let cmd = build_adb_command("adb", "permission.grant", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec![
            "-s",
            "dev1",
            "shell",
            "pm",
            "grant",
            "com.example.app",
            "android.permission.CAMERA"
        ]
    );
}

#[test]
fn test_category_d_command_construction() {
    let mut p = serde_json::Map::new();
    p.insert("buffer".to_string(), json!("main"));
    p.insert("format".to_string(), json!("threadtime"));
    p.insert("lines".to_string(), json!(200));
    p.insert("filter".to_string(), json!("*:E"));
    let cmd = build_adb_command("adb", "logcat.dump", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec![
            "-s",
            "dev1",
            "logcat",
            "-d",
            "-b",
            "main",
            "-v",
            "threadtime",
            "-t",
            "200",
            "*:E"
        ]
    );

    let cmd =
        build_adb_command("adb", "logcat.stats", Some("dev1"), &serde_json::Map::new()).unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "logcat", "-S"]);

    let mut p = serde_json::Map::new();
    p.insert("path".to_string(), json!("/tmp/bugreport.zip"));
    let cmd = build_adb_command("adb", "diagnostics.bugreport", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec!["-s", "dev1", "bugreport", "/tmp/bugreport.zip"]
    );

    let mut p = serde_json::Map::new();
    p.insert("service".to_string(), json!("battery"));
    let cmd = build_adb_command("adb", "diagnostics.dumpsys", Some("dev1"), &p).unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "shell", "dumpsys", "battery"]);

    let mut p = serde_json::Map::new();
    p.insert("package".to_string(), json!("com.example.app"));
    let cmd = build_adb_command("adb", "diagnostics.dumpsys", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec![
            "-s",
            "dev1",
            "shell",
            "dumpsys",
            "package",
            "com.example.app"
        ]
    );

    let mut p = serde_json::Map::new();
    p.insert("property".to_string(), json!("ro.build.version.sdk"));
    let cmd = build_adb_command("adb", "diagnostics.getprop", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec!["-s", "dev1", "shell", "getprop", "ro.build.version.sdk"]
    );
}

#[test]
fn test_category_v_command_construction() {
    let cmd = build_adb_command(
        "adb",
        "screen.screencap",
        Some("dev1"),
        &serde_json::Map::new(),
    )
    .unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "exec-out", "screencap", "-p"]);

    let mut p = serde_json::Map::new();
    p.insert("remotePath".to_string(), json!("/sdcard/demo.mp4"));
    p.insert("timeLimit".to_string(), json!(30));
    let cmd = build_adb_command("adb", "screen.screenrecord", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec![
            "-s",
            "dev1",
            "shell",
            "screenrecord",
            "--time-limit",
            "30",
            "/sdcard/demo.mp4"
        ]
    );

    let mut p = serde_json::Map::new();
    p.insert("keycode".to_string(), json!(3));
    let cmd = build_adb_command("adb", "input.keyevent", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec!["-s", "dev1", "shell", "input", "keyevent", "3"]
    );

    let mut p = serde_json::Map::new();
    p.insert("x".to_string(), json!(100));
    p.insert("y".to_string(), json!(200));
    let cmd = build_adb_command("adb", "input.tap", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec!["-s", "dev1", "shell", "input", "tap", "100", "200"]
    );

    let mut p = serde_json::Map::new();
    p.insert("text".to_string(), json!("hello_world"));
    let cmd = build_adb_command("adb", "input.text", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec!["-s", "dev1", "shell", "input", "text", "hello_world"]
    );

    let cmd =
        build_adb_command("adb", "power.wake", Some("dev1"), &serde_json::Map::new()).unwrap();
    assert_eq!(
        cmd.args,
        vec!["-s", "dev1", "shell", "input", "keyevent", "224"]
    );
}

#[test]
fn test_category_n_command_construction() {
    let mut p = serde_json::Map::new();
    p.insert("local".to_string(), json!("tcp:8080"));
    p.insert("remote".to_string(), json!("tcp:8080"));
    p.insert("noRebind".to_string(), json!(true));
    let cmd = build_adb_command("adb", "forward.create", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec![
            "-s",
            "dev1",
            "forward",
            "--no-rebind",
            "tcp:8080",
            "tcp:8080"
        ]
    );

    let cmd =
        build_adb_command("adb", "forward.list", Some("dev1"), &serde_json::Map::new()).unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "forward", "--list"]);

    let mut p = serde_json::Map::new();
    p.insert("local".to_string(), json!("tcp:8080"));
    let cmd = build_adb_command("adb", "forward.remove", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec!["-s", "dev1", "forward", "--remove", "tcp:8080"]
    );

    let mut p = serde_json::Map::new();
    p.insert("remote".to_string(), json!("tcp:3000"));
    p.insert("local".to_string(), json!("tcp:3000"));
    let cmd = build_adb_command("adb", "reverse.create", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec!["-s", "dev1", "reverse", "tcp:3000", "tcp:3000"]
    );

    let mut p = serde_json::Map::new();
    p.insert("host".to_string(), json!("127.0.0.1"));
    p.insert("port".to_string(), json!(8080));
    let cmd = build_adb_command("adb", "network.proxy_set", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec![
            "-s",
            "dev1",
            "shell",
            "settings",
            "put",
            "global",
            "http_proxy",
            "127.0.0.1:8080"
        ]
    );

    let cmd = build_adb_command(
        "adb",
        "network.proxy_clear",
        Some("dev1"),
        &serde_json::Map::new(),
    )
    .unwrap();
    assert_eq!(
        cmd.args,
        vec![
            "-s",
            "dev1",
            "shell",
            "settings",
            "put",
            "global",
            "http_proxy",
            ":0"
        ]
    );
}

#[test]
fn test_category_x_command_construction() {
    let cmd =
        build_adb_command("adb", "system.root", Some("dev1"), &serde_json::Map::new()).unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "root"]);

    let cmd = build_adb_command(
        "adb",
        "system.unroot",
        Some("dev1"),
        &serde_json::Map::new(),
    )
    .unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "unroot"]);

    let mut p = serde_json::Map::new();
    p.insert("reboot".to_string(), json!(true));
    let cmd = build_adb_command("adb", "system.remount", Some("dev1"), &p).unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "remount", "-R"]);

    let cmd = build_adb_command(
        "adb",
        "system.disable_verity",
        Some("dev1"),
        &serde_json::Map::new(),
    )
    .unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "disable-verity"]);

    let mut p = serde_json::Map::new();
    p.insert("target".to_string(), json!("recovery"));
    let cmd = build_adb_command("adb", "system.reboot", Some("dev1"), &p).unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "reboot", "recovery"]);

    let mut p = serde_json::Map::new();
    p.insert("packagePath".to_string(), json!("/tmp/update.zip"));
    let cmd = build_adb_command("adb", "system.sideload", Some("dev1"), &p).unwrap();
    assert_eq!(cmd.args, vec!["-s", "dev1", "sideload", "/tmp/update.zip"]);

    let cmd = build_adb_command(
        "adb",
        "system.testharness",
        Some("dev1"),
        &serde_json::Map::new(),
    )
    .unwrap();
    assert_eq!(
        cmd.args,
        vec!["-s", "dev1", "shell", "cmd", "testharness", "enable"]
    );

    let mut p = serde_json::Map::new();
    p.insert("certPath".to_string(), json!("/sdcard/burp.crt"));
    p.insert("target".to_string(), json!("user"));
    let cmd = build_adb_command("adb", "system.cert_install", Some("dev1"), &p).unwrap();
    assert_eq!(
        cmd.args,
        vec![
            "-s",
            "dev1",
            "shell",
            "am start -a android.credentials.INSTALL -t application/x-x509-ca-cert -d file://\"/sdcard/burp.crt\""
        ]
    );

    let cmd = build_adb_command("adb", "fastboot.devices", None, &serde_json::Map::new()).unwrap();
    assert_eq!(cmd.program, "fastboot");
    assert_eq!(cmd.args, vec!["devices", "-l"]);

    let mut p = serde_json::Map::new();
    p.insert("variable".to_string(), json!("current-slot"));
    let cmd = build_adb_command("adb", "fastboot.getvar", Some("fastboot-dev1"), &p).unwrap();
    assert_eq!(cmd.program, "fastboot");
    assert_eq!(
        cmd.args,
        vec!["-s", "fastboot-dev1", "getvar", "current-slot"]
    );

    let mut p = serde_json::Map::new();
    p.insert("slot".to_string(), json!("b"));
    let cmd = build_adb_command("adb", "fastboot.set_active", Some("fastboot-dev1"), &p).unwrap();
    assert_eq!(cmd.program, "fastboot");
    assert_eq!(cmd.args, vec!["-s", "fastboot-dev1", "--set-active=b"]);

    let mut p = serde_json::Map::new();
    p.insert("partition".to_string(), json!("boot"));
    p.insert("imagePath".to_string(), json!("/tmp/magisk_patched.img"));
    let cmd = build_adb_command("adb", "fastboot.flash", Some("fastboot-dev1"), &p).unwrap();
    assert_eq!(cmd.program, "fastboot");
    assert_eq!(
        cmd.args,
        vec![
            "-s",
            "fastboot-dev1",
            "flash",
            "boot",
            "/tmp/magisk_patched.img"
        ]
    );

    let mut p = serde_json::Map::new();
    p.insert("target".to_string(), json!("recovery"));
    let cmd = build_adb_command("adb", "fastboot.reboot", Some("fastboot-dev1"), &p).unwrap();
    assert_eq!(cmd.program, "fastboot");
    assert_eq!(cmd.args, vec!["-s", "fastboot-dev1", "reboot", "recovery"]);
}

#[test]
fn rotary_input_is_explicitly_targeted_and_validates_axis_values() {
    let params = json!({"axisValue":-2.5}).as_object().unwrap().clone();
    let command = build_adb_command("adb", "input.rotary", Some("watch-serial"), &params).unwrap();
    assert_eq!(
        command.args,
        vec![
            "-s",
            "watch-serial",
            "shell",
            "input",
            "rotaryencoder",
            "scroll",
            "--axis",
            "SCROLL,-2.5"
        ]
    );
    for value in [json!(101), json!("1; reboot"), json!(null)] {
        let params = json!({"axisValue":value}).as_object().unwrap().clone();
        assert!(build_adb_command("adb", "input.rotary", Some("watch-serial"), &params).is_err());
    }
}
