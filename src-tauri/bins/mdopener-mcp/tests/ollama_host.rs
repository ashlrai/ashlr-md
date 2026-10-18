//! `OLLAMA_HOST` handling in the sidecar. The default stays 127.0.0.1:11434.

use mdopener_mcp::{ollama_base_from, parse_url};

#[test]
fn default_is_unchanged() {
    for v in [None, Some(""), Some("  "), Some("/")] {
        assert_eq!(ollama_base_from(v), "http://127.0.0.1:11434");
    }
    assert_eq!(
        parse_url(&ollama_base_from(None)).unwrap(),
        ("127.0.0.1".to_string(), 11434, "/".to_string())
    );
}

#[test]
fn override_is_honored() {
    assert_eq!(
        ollama_base_from(Some("gpu-box:11435")),
        "http://gpu-box:11435"
    );
    assert_eq!(ollama_base_from(Some("gpu-box")), "http://gpu-box:11434");
    assert_eq!(ollama_base_from(Some(":8080")), "http://localhost:8080");
    let url = format!(
        "{}/api/embeddings",
        ollama_base_from(Some("10.0.0.2:9000/"))
    );
    assert_eq!(
        parse_url(&url).unwrap(),
        ("10.0.0.2".to_string(), 9000, "/api/embeddings".to_string())
    );
}

#[test]
fn https_is_not_spoken_by_the_sidecar() {
    let base = ollama_base_from(Some("https://ollama.example.com"));
    assert_eq!(base, "https://ollama.example.com");
    assert!(parse_url(&base).is_err());
}
