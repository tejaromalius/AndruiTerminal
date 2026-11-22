use andrui_core::inspect::apk::inspect_apk;

/// The bundled helper APK is signed by the checked-in development keystore, so
/// its certificate fingerprints are stable. These values match
/// `keytool -printcert -jarfile helper-apk/build/andrui-helper.apk`.
const HELPER_SHA256: &str =
    "72:F2:71:0D:91:9E:F4:FA:DD:9D:97:66:F8:0D:71:14:3B:18:13:92:7E:2A:88:CD:E4:85:AE:8A:37:B9:CE:5E";
const HELPER_SHA1: &str = "2A:C2:04:B6:EF:49:58:F6:30:F0:51:46:8B:EE:59:72:8F:3C:9C:EF";

#[test]
fn helper_apk_fingerprints_match_keytool() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../helper-apk/build/andrui-helper.apk");
    if !path.exists() {
        eprintln!("skipping: helper APK not built at {path:?}");
        return;
    }
    let bytes = std::fs::read(&path).unwrap();
    let signing = inspect_apk(&bytes);
    assert!(signing.schemes.contains(&"v2".to_string()));
    let cert = signing
        .certificates
        .iter()
        .find(|c| c.sha256 == HELPER_SHA256)
        .unwrap_or_else(|| panic!("fingerprint not found; got {:?}", signing.certificates));
    assert_eq!(cert.sha1, HELPER_SHA1);
    assert!(!cert.debug_key);
}

#[test]
fn garbage_input_reports_warning_not_panic() {
    let signing = inspect_apk(b"not a zip at all");
    assert!(signing.certificates.is_empty());
    assert!(!signing.warnings.is_empty());
}

#[tokio::test]
async fn signing_flow_pulls_apk_through_fake_adb() {
    use andrui_core::adb::executor::AdbExecutor;
    let helper = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../helper-apk/build/andrui-helper.apk");
    if !helper.exists() {
        eprintln!("skipping: helper APK not built");
        return;
    }
    let adb = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/adb");
    let executor = AdbExecutor::new(adb);
    let result =
        andrui_core::inspect::inspect_package_signing(&executor, "RF8M10ABCDE", "com.example.app")
            .await
            .unwrap();
    assert_eq!(result.apks.len(), 1);
    assert!(result.apks[0].path.ends_with("base.apk"));
    assert_eq!(result.apks[0].sha256.len(), 64);
    assert_eq!(result.apks[0].sha256, result.apks[0].sha256.to_lowercase());
    assert_eq!(result.signing.certificates[0].sha1, HELPER_SHA1);
}
