use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs, process};

fn verify(data: &[u8], signature: &str, key: &str) -> Result<(), Box<dyn std::error::Error>> {
    let key = String::from_utf8(STANDARD.decode(key)?)?;
    let signature = String::from_utf8(STANDARD.decode(signature)?)?;
    PublicKey::decode(&key)?.verify(data, &Signature::decode(&signature)?, true)?;
    Ok(())
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() != 3 {
        return Err(
            "usage: release-signature-check PUBLIC_KEY_FILE SIGNATURE_FILE ARTIFACT".into(),
        );
    }
    let key = fs::read_to_string(&args[0])?;
    let signature = fs::read_to_string(&args[1])?;
    let data = fs::read(&args[2])?;
    verify(&data, &signature, &key)
}
fn main() {
    if let Err(error) = run() {
        eprintln!("signature verification failed: {error}");
        process::exit(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    // Public example from minisign-verify 0.2.5 README; not a release credential.
    const KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIG: &str = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
    #[test]
    fn public_vector_and_modified_data() {
        let k = STANDARD.encode(KEY);
        let s = STANDARD.encode(SIG);
        assert!(verify(b"test", &s, &k).is_ok());
        assert!(verify(b"tampered", &s, &k).is_err());
        assert!(verify(b"test", &STANDARD.encode("invalid"), &k).is_err());
        assert!(verify(b"test", &format!("{s}\n"), &k).is_err());
    }
}
