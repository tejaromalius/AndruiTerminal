//! Wireless ADB discovery over mDNS.
//!
//! Some adb builds (including Debian's) ship without mDNS support, so
//! `adb mdns services` returns nothing. This browses the same service types
//! directly and keeps a live list for the UI.

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::sync::Arc;

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;
use tokio::sync::RwLock;

/// (mDNS service type, kind reported to clients)
const SERVICE_TYPES: [(&str, &str); 3] = [
    ("_adb-tls-connect._tcp.local.", "connect"),
    ("_adb-tls-pairing._tcp.local.", "pairing"),
    ("_adb._tcp.local.", "legacy"),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredService {
    /// Service instance name, e.g. "adb-A3SQUT5527017708-FAXMDc".
    pub name: String,
    /// "connect" (wireless debugging), "pairing" (pairing code dialog open) or "legacy" (adb tcpip).
    pub kind: String,
    pub hostname: String,
    pub address: String,
    pub port: u16,
    /// "address:port", ready for `adb connect` / `adb pair`.
    pub endpoint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryStatus {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub services: Vec<DiscoveredService>,
}

#[derive(Clone)]
pub struct DeviceDiscovery {
    services: Arc<RwLock<BTreeMap<String, DiscoveredService>>>,
    error: Option<String>,
    // Keeps the mDNS daemon thread alive for the lifetime of the app.
    _daemon: Option<ServiceDaemon>,
}

impl DeviceDiscovery {
    /// Starts browsing in the background. Failure (e.g. no multicast interface)
    /// is reported through `status()` rather than aborting startup.
    pub fn start() -> Self {
        let services = Arc::new(RwLock::new(BTreeMap::new()));
        let daemon = match ServiceDaemon::new() {
            Ok(daemon) => daemon,
            Err(e) => {
                tracing::warn!("mDNS discovery unavailable: {e}");
                return Self {
                    services,
                    error: Some(format!("mDNS discovery unavailable: {e}")),
                    _daemon: None,
                };
            }
        };

        for (service_type, kind) in SERVICE_TYPES {
            match daemon.browse(service_type) {
                Ok(receiver) => {
                    let services = services.clone();
                    tokio::spawn(async move {
                        while let Ok(event) = receiver.recv_async().await {
                            handle_event(&services, kind, event).await;
                        }
                    });
                }
                Err(e) => tracing::warn!("mDNS browse for {service_type} failed: {e}"),
            }
        }

        Self {
            services,
            error: None,
            _daemon: Some(daemon),
        }
    }

    pub async fn status(&self) -> DiscoveryStatus {
        DiscoveryStatus {
            available: self.error.is_none(),
            error: self.error.clone(),
            services: self.services.read().await.values().cloned().collect(),
        }
    }
}

async fn handle_event(
    services: &RwLock<BTreeMap<String, DiscoveredService>>,
    kind: &str,
    event: ServiceEvent,
) {
    match event {
        ServiceEvent::ServiceResolved(info) => {
            // Prefer IPv4: adb connect handles it everywhere, and link-local IPv6 needs a scope.
            let mut addresses: Vec<IpAddr> =
                info.addresses.iter().map(|a| a.to_ip_addr()).collect();
            addresses.sort_by_key(|a| (!a.is_ipv4(), *a));
            let Some(ip) = addresses.first() else {
                return;
            };
            let endpoint = match ip {
                IpAddr::V4(v4) => format!("{v4}:{}", info.port),
                IpAddr::V6(v6) => format!("[{v6}]:{}", info.port),
            };
            let suffix = format!(".{}", info.ty_domain);
            let name = info
                .fullname
                .strip_suffix(&suffix)
                .unwrap_or(&info.fullname)
                .to_string();
            let service = DiscoveredService {
                name,
                kind: kind.to_string(),
                hostname: info.host.trim_end_matches('.').to_string(),
                address: ip.to_string(),
                port: info.port,
                endpoint,
            };
            services
                .write()
                .await
                .insert(info.fullname.clone(), service);
        }
        ServiceEvent::ServiceRemoved(_, fullname) => {
            services.write().await.remove(&fullname);
        }
        _ => {}
    }
}
