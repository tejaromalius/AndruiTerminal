use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BatteryInfo {
    pub ac_powered: Option<bool>,
    pub usb_powered: Option<bool>,
    pub wireless_powered: Option<bool>,
    pub status: Option<i32>,
    pub health: Option<i32>,
    pub present: Option<bool>,
    pub level: Option<i32>,
    pub scale: Option<i32>,
    pub voltage_mv: Option<i32>,
    pub temperature_c: Option<f32>,
    pub technology: Option<String>,
}

/// Parses the output of `dumpsys battery` into structured JSON.
pub fn parse_battery(stdout: &str) -> Option<Value> {
    if !stdout.contains("Battery Service") && !stdout.contains("level:") {
        return None;
    }

    let mut ac_powered = None;
    let mut usb_powered = None;
    let mut wireless_powered = None;
    let mut status = None;
    let mut health = None;
    let mut present = None;
    let mut level = None;
    let mut scale = None;
    let mut voltage_mv = None;
    let mut temperature_c = None;
    let mut technology = None;

    for line in stdout.lines() {
        let trimmed = line.trim();
        let Some((key, val)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim().to_lowercase();
        let val = val.trim();

        match key.as_str() {
            "ac powered" => ac_powered = Some(val.eq_ignore_ascii_case("true")),
            "usb powered" => usb_powered = Some(val.eq_ignore_ascii_case("true")),
            "wireless powered" => wireless_powered = Some(val.eq_ignore_ascii_case("true")),
            "status" => status = val.parse::<i32>().ok(),
            "health" => health = val.parse::<i32>().ok(),
            "present" => present = Some(val.eq_ignore_ascii_case("true")),
            "level" => level = val.parse::<i32>().ok(),
            "scale" => scale = val.parse::<i32>().ok(),
            "voltage" => voltage_mv = val.parse::<i32>().ok(),
            "temperature" => {
                if let Ok(raw_temp) = val.parse::<f32>() {
                    // Android reports battery temp in tenths of a degree Celsius (e.g. 280 = 28.0 C)
                    temperature_c = Some(raw_temp / 10.0);
                }
            }
            "technology" => technology = Some(val.to_string()),
            _ => {}
        }
    }

    let info = BatteryInfo {
        ac_powered,
        usb_powered,
        wireless_powered,
        status,
        health,
        present,
        level,
        scale,
        voltage_mv,
        temperature_c,
        technology,
    };

    serde_json::to_value(info).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_battery_output() {
        let sample = r#"
Current Battery Service state:
  AC powered: false
  USB powered: true
  Wireless powered: false
  Max charging current: 500000
  Max charging voltage: 5000000
  Charge counter: 2893000
  status: 2
  health: 2
  present: true
  level: 85
  scale: 100
  voltage: 4120
  temperature: 285
  technology: Li-ion
"#;

        let parsed = parse_battery(sample).expect("should parse");
        assert_eq!(parsed["level"], 85);
        assert_eq!(parsed["scale"], 100);
        assert_eq!(parsed["usbPowered"], true);
        assert_eq!(parsed["acPowered"], false);
        assert_eq!(parsed["voltageMv"], 4120);
        assert_eq!(parsed["temperatureC"], 28.5);
        assert_eq!(parsed["technology"], "Li-ion");
    }
}
