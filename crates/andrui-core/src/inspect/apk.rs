//! APK signature and certificate inspection.
//!
//! Parses APKs pulled from the device: the ZIP end-of-central-directory to find
//! the APK Signing Block (v2/v3/v3.1), the embedded X.509 certificates, and a
//! v1 (JAR) `META-INF/*.RSA|DSA|EC` fallback. Certificate fingerprints are the
//! SHA-256 and SHA-1 of the DER-encoded signer certificate, matching what
//! `apksigner --print-certs` and the Play Console report.

use sha1::Sha1;
use sha2::{Digest, Sha256};

/// A signer certificate summary extracted from an APK.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct CertInfo {
    /// Signature scheme that carried this certificate.
    pub scheme: String,
    /// Uppercase hex SHA-256 of the DER certificate, colon-separated.
    pub sha256: String,
    /// Uppercase hex SHA-1 of the DER certificate, colon-separated.
    pub sha1: String,
    /// Length of the DER certificate in bytes.
    pub der_len: usize,
    /// True when the certificate is the public Android debug key.
    pub debug_key: bool,
}

/// Result of inspecting an APK's signing information.
#[derive(Debug, Clone, serde::Serialize, Default)]
pub struct ApkSigning {
    pub schemes: Vec<String>,
    pub certificates: Vec<CertInfo>,
    pub warnings: Vec<String>,
}

const SIG_BLOCK_MAGIC: &[u8; 16] = b"APK Sig Block 42";
// Public SHA-256 of the AOSP debug signing certificate.
const DEBUG_CERT_SHA256: &str =
    "FB:94:9A:AA:5C:68:B5:40:4C:B9:A2:7F:94:FE:7D:36:96:92:5A:23:0C:C3:61:0E:A1:60:14:14:3F:76:86:59";

fn fingerprint<D: Digest>(der: &[u8]) -> String {
    let mut hasher = D::new();
    hasher.update(der);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn make_cert(scheme: &str, der: &[u8]) -> CertInfo {
    let sha256 = fingerprint::<Sha256>(der);
    CertInfo {
        scheme: scheme.to_string(),
        debug_key: sha256 == DEBUG_CERT_SHA256,
        sha1: fingerprint::<Sha1>(der),
        sha256,
        der_len: der.len(),
    }
}

fn read_u32(data: &[u8], off: usize) -> Option<u32> {
    data.get(off..off + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn read_u64(data: &[u8], off: usize) -> Option<u64> {
    data.get(off..off + 8)
        .map(|s| u64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
}

/// Locate the ZIP end-of-central-directory record and return the central
/// directory start offset.
pub(crate) fn central_dir_offset(data: &[u8]) -> Option<usize> {
    // EOCD signature 0x06054b50, scanning backwards over the trailing comment.
    let min = data.len().checked_sub(22)?;
    let floor = data.len().saturating_sub(22 + 0xffff);
    for i in (floor..=min).rev() {
        if data[i..].starts_with(&[0x50, 0x4b, 0x05, 0x06]) {
            return read_u32(data, i + 16).map(|v| v as usize);
        }
    }
    None
}

/// Extract the APK Signing Block that sits just before the central directory.
fn signing_block(data: &[u8], cd_offset: usize) -> Option<&[u8]> {
    // Layout: u64 size | pairs | u64 size (repeated) | 16-byte magic, and the
    // block ends exactly at cd_offset.
    let magic_start = cd_offset.checked_sub(16)?;
    if &data[magic_start..cd_offset] != SIG_BLOCK_MAGIC {
        return None;
    }
    let size_end = read_u64(data, magic_start.checked_sub(8)?)? as usize;
    // block_start points at the leading size field.
    let block_start = cd_offset.checked_sub(size_end + 8)?;
    let declared = read_u64(data, block_start)? as usize;
    if declared != size_end {
        return None;
    }
    // Return the ID/value pairs region (between the two size fields, before magic).
    data.get(block_start + 8..magic_start - 8)
}

/// Iterate ID-prefixed values inside the signing block pair region.
fn block_values(pairs: &[u8]) -> Vec<(u32, &[u8])> {
    let mut out = Vec::new();
    let mut off = 0usize;
    while off + 12 <= pairs.len() {
        let len = match read_u64(pairs, off) {
            Some(l) => l as usize,
            None => break,
        };
        if len < 4 || off + 8 + len > pairs.len() {
            break;
        }
        let id = read_u32(pairs, off + 8).unwrap_or(0);
        let value = &pairs[off + 12..off + 8 + len];
        out.push((id, value));
        off += 8 + len;
    }
    out
}

/// A length-prefixed sequence reader (u32 little-endian lengths), as used
/// throughout the v2/v3 signing block encoding.
struct LenReader<'a> {
    data: &'a [u8],
    off: usize,
}

impl<'a> LenReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, off: 0 }
    }
    fn next(&mut self) -> Option<&'a [u8]> {
        let len = read_u32(self.data, self.off)? as usize;
        let start = self.off + 4;
        let end = start.checked_add(len)?;
        if end > self.data.len() {
            return None;
        }
        self.off = end;
        self.data.get(start..end)
    }
}

/// Parse the certificates out of one v2/v3 signer sequence.
fn certs_from_signers(scheme: &str, value: &[u8], out: &mut Vec<CertInfo>) {
    // value = length-prefixed sequence of signers.
    let mut signers = LenReader::new(match LenReader::new(value).next() {
        Some(inner) => inner,
        None => return,
    });
    while let Some(signer) = signers.next() {
        // signer = signed_data | signatures | public_key (each length-prefixed).
        if let Some(signed_data) = LenReader::new(signer).next() {
            // signed_data = digests | certificates | attributes.
            let mut parts = LenReader::new(signed_data);
            let _digests = parts.next();
            if let Some(certs_block) = parts.next() {
                let mut certs = LenReader::new(certs_block);
                while let Some(der) = certs.next() {
                    let cert = make_cert(scheme, der);
                    if !out.iter().any(|c| c.sha256 == cert.sha256) {
                        out.push(cert);
                    }
                }
            }
        }
    }
}

/// Inspect raw APK bytes and summarize its signing certificates.
pub fn inspect_apk(data: &[u8]) -> ApkSigning {
    let mut result = ApkSigning::default();
    let cd_offset = match central_dir_offset(data) {
        Some(o) if o <= data.len() => o,
        _ => {
            result.warnings.push("Not a valid ZIP/APK archive".into());
            return result;
        }
    };

    if let Some(pairs) = signing_block(data, cd_offset) {
        for (id, value) in block_values(pairs) {
            let scheme = match id {
                0x7109871a => Some("v2"),
                0xf05368c0 => Some("v3"),
                0x1b93ad61 => Some("v3.1"),
                _ => None,
            };
            if let Some(scheme) = scheme {
                let before = result.certificates.len();
                certs_from_signers(scheme, value, &mut result.certificates);
                if result.certificates.len() > before {
                    result.schemes.push(scheme.to_string());
                }
            }
        }
    }

    // v1 (JAR) fallback: parse the DER certificate from META-INF/*.(RSA|DSA|EC).
    if result.certificates.is_empty() {
        match v1_certificate(data) {
            Some(der) => {
                result.schemes.push("v1".to_string());
                result.certificates.push(make_cert("v1", &der));
            }
            None => result
                .warnings
                .push("No APK signing block or v1 signature certificate found".into()),
        }
    }

    result
}

/// Extract the embedded certificate from a v1 PKCS#7 signature file inside the APK.
///
/// Walks the ZIP central directory for `META-INF/*.(RSA|DSA|EC)` entries,
/// reads each entry's local file data, inflates it when deflated, and returns
/// the first embedded X.509 certificate found.
fn v1_certificate(data: &[u8]) -> Option<Vec<u8>> {
    for entry in zip_entries(data) {
        let up = entry.name.to_uppercase();
        if !(up.starts_with("META-INF/")
            && (up.ends_with(".RSA") || up.ends_with(".DSA") || up.ends_with(".EC")))
        {
            continue;
        }
        if let Some(bytes) = read_zip_entry(data, &entry) {
            if let Some(der) = first_x509_in_pkcs7(&bytes) {
                return Some(der);
            }
        }
    }
    None
}

pub(crate) struct ZipEntry {
    pub(crate) name: String,
    pub(crate) method: u16,
    pub(crate) comp_size: usize,
    pub(crate) uncomp_size: usize,
    pub(crate) local_header_offset: usize,
}

/// Parse the ZIP central directory into a list of entries.
pub(crate) fn zip_entries(data: &[u8]) -> Vec<ZipEntry> {
    let mut entries = Vec::new();
    let cd_start = match central_dir_offset(data) {
        Some(o) => o,
        None => return entries,
    };
    let mut off = cd_start;
    // Central directory file header signature 0x02014b50.
    while off + 46 <= data.len() && data[off..].starts_with(&[0x50, 0x4b, 0x01, 0x02]) {
        let method = u16::from_le_bytes([data[off + 10], data[off + 11]]);
        let comp_size = read_u32(data, off + 20).unwrap_or(0) as usize;
        let uncomp_size = read_u32(data, off + 24).unwrap_or(0) as usize;
        let name_len = u16::from_le_bytes([data[off + 28], data[off + 29]]) as usize;
        let extra_len = u16::from_le_bytes([data[off + 30], data[off + 31]]) as usize;
        let comment_len = u16::from_le_bytes([data[off + 32], data[off + 33]]) as usize;
        let local_header_offset = read_u32(data, off + 42).unwrap_or(0) as usize;
        let name = data
            .get(off + 46..off + 46 + name_len)
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .unwrap_or_default();
        entries.push(ZipEntry {
            name,
            method,
            comp_size,
            uncomp_size,
            local_header_offset,
        });
        off += 46 + name_len + extra_len + comment_len;
    }
    entries
}

/// Read and decompress one ZIP entry's data from its local file header.
pub(crate) fn read_zip_entry(data: &[u8], entry: &ZipEntry) -> Option<Vec<u8>> {
    let lho = entry.local_header_offset;
    // Local file header signature 0x04034b50; data follows name + extra fields.
    if !data
        .get(lho..lho + 4)?
        .starts_with(&[0x50, 0x4b, 0x03, 0x04])
    {
        return None;
    }
    let name_len = u16::from_le_bytes([*data.get(lho + 26)?, *data.get(lho + 27)?]) as usize;
    let extra_len = u16::from_le_bytes([*data.get(lho + 28)?, *data.get(lho + 29)?]) as usize;
    let start = lho + 30 + name_len + extra_len;
    // Cap individual signature files to a sane size.
    if entry.comp_size > 8 * 1024 * 1024 {
        return None;
    }
    let raw = data.get(start..start + entry.comp_size)?;
    match entry.method {
        0 => Some(raw.to_vec()), // stored
        8 => {
            use std::io::Read;
            let mut out = Vec::with_capacity(entry.uncomp_size.min(8 * 1024 * 1024));
            flate2::read::DeflateDecoder::new(raw)
                .take(8 * 1024 * 1024)
                .read_to_end(&mut out)
                .ok()?;
            Some(out)
        }
        _ => None,
    }
}

/// Find the first embedded X.509 certificate SEQUENCE in a DER PKCS#7 blob.
///
/// PKCS#7 SignedData carries certificates as a `[0] IMPLICIT` set of full
/// certificates; each certificate is itself a top-level `SEQUENCE` beginning
/// with a `SEQUENCE` (tbsCertificate). We scan for that nested shape and return
/// the outer certificate's exact DER span.
fn first_x509_in_pkcs7(der: &[u8]) -> Option<Vec<u8>> {
    let mut i = 0usize;
    while i + 8 < der.len() {
        if der[i] == 0x30 {
            if let Some((hdr, len)) = der_len(der, i + 1) {
                let body = i + 1 + hdr;
                // A certificate SEQUENCE whose first element is also a SEQUENCE
                // (tbsCertificate) that starts with a context [0] version tag.
                if body + 1 < der.len() && der[body] == 0x30 && len > 64 && body + len <= der.len()
                {
                    if let Some((thdr, _)) = der_len(der, body + 1) {
                        let tbs = body + 1 + thdr;
                        if der.get(tbs) == Some(&0xA0) {
                            return Some(der[i..body + len].to_vec());
                        }
                    }
                }
            }
        }
        i += 1;
    }
    None
}

/// Decode a DER length at `off`, returning (header_len_after_off, content_len).
fn der_len(data: &[u8], off: usize) -> Option<(usize, usize)> {
    let first = *data.get(off)?;
    if first & 0x80 == 0 {
        return Some((1, first as usize));
    }
    let n = (first & 0x7f) as usize;
    if n == 0 || n > 4 {
        return None;
    }
    let mut len = 0usize;
    for k in 0..n {
        len = (len << 8) | *data.get(off + 1 + k)? as usize;
    }
    Some((1 + n, len))
}
