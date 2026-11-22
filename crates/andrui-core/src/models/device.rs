use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<HashMap<String, String>>,
}

impl Device {
    /// Parse the output of `adb devices -l`
    pub fn parse_adb_devices_l(output: &str) -> Vec<Device> {
        let mut devices = Vec::new();
        for line in output.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty()
                || trimmed.starts_with("List of devices attached")
                || trimmed.starts_with('*')
            {
                continue;
            }

            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() < 2 {
                continue;
            }

            let id = parts[0].to_string();
            let state = parts[1].to_string();

            let mut model = None;
            let mut product = None;
            let mut device_name = None;
            let mut transport_id = None;
            let mut details = HashMap::new();

            for item in &parts[2..] {
                if let Some((k, v)) = item.split_once(':') {
                    match k {
                        "model" => model = Some(v.to_string()),
                        "product" => product = Some(v.to_string()),
                        "device" => device_name = Some(v.to_string()),
                        "transport_id" => {
                            if let Ok(tid) = v.parse::<u64>() {
                                transport_id = Some(tid);
                            } else {
                                details.insert(k.to_string(), v.to_string());
                            }
                        }
                        _ => {
                            details.insert(k.to_string(), v.to_string());
                        }
                    }
                } else {
                    details.insert("flag".to_string(), item.to_string());
                }
            }

            devices.push(Device {
                id,
                state,
                model,
                product,
                device: device_name,
                transport_id,
                details: if details.is_empty() {
                    None
                } else {
                    Some(details)
                },
            });
        }
        devices
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_adb_devices_l() {
        let output = r#"List of devices attached
emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64x transport_id:1
192.168.1.100:5555     offline transport_id:2
XYZ123                 unauthorized usb:1-2 transport_id:3
"#;
        let devices = Device::parse_adb_devices_l(output);
        assert_eq!(devices.len(), 3);

        assert_eq!(devices[0].id, "emulator-5554");
        assert_eq!(devices[0].state, "device");
        assert_eq!(devices[0].model.as_deref(), Some("sdk_gphone64_x86_64"));
        assert_eq!(devices[0].product.as_deref(), Some("sdk_gphone64_x86_64"));
        assert_eq!(devices[0].device.as_deref(), Some("emu64x"));
        assert_eq!(devices[0].transport_id, Some(1));

        assert_eq!(devices[1].id, "192.168.1.100:5555");
        assert_eq!(devices[1].state, "offline");
        assert_eq!(devices[1].transport_id, Some(2));

        assert_eq!(devices[2].id, "XYZ123");
        assert_eq!(devices[2].state, "unauthorized");
        assert_eq!(
            devices[2]
                .details
                .as_ref()
                .unwrap()
                .get("usb")
                .map(|s| s.as_str()),
            Some("1-2")
        );
    }
}
