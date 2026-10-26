//! Run by Claude Code for each Spool hook. Reads the hook payload from stdin and forwards it
//! to the broker's socket, tagged with this terminal's SPOOL_ID.
//!
//! Must never interfere with Claude: it always exits 0, prints nothing, and gives up quickly.
//! `spool-hook --version` prints the version, so the extension can check the binary runs.

use std::env;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::process;
use std::thread;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(2);

fn main() {
    if env::args().nth(1).as_deref() == Some("--version") {
        println!("spool-hook {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let (Ok(spool_id), Ok(socket_path)) = (env::var("SPOOL_ID"), env::var("SPOOL_SOCKET")) else {
        return;
    };
    thread::spawn(|| {
        thread::sleep(TIMEOUT);
        process::exit(0);
    });

    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return;
    }
    let Some(line) = message(&spool_id, &input) else {
        return;
    };
    if let Ok(mut socket) = UnixStream::connect(socket_path) {
        let _ = socket.write_all(line.as_bytes());
    }
}

/// The line sent to the broker: `{"spoolId": …, "payload": …}`. The payload isn't parsed,
/// only checked to be a JSON object; line breaks in valid JSON can only be whitespace
/// between tokens, so they become spaces to keep the message on one line.
fn message(spool_id: &str, input: &str) -> Option<String> {
    let payload = input.trim();
    if !(payload.starts_with('{') && payload.ends_with('}')) {
        return None;
    }
    let payload = payload.replace(['\n', '\r'], " ");
    Some(format!("{{\"spoolId\":{},\"payload\":{}}}\n", json_string(spool_id), payload))
}

fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_the_payload_on_one_line() {
        let line = message("abc", "{\n  \"hook_event_name\": \"Stop\"\n}\n").unwrap();
        assert_eq!(line, "{\"spoolId\":\"abc\",\"payload\":{   \"hook_event_name\": \"Stop\" }}\n");
    }

    #[test]
    fn skips_anything_but_an_object() {
        assert_eq!(message("abc", ""), None);
        assert_eq!(message("abc", "not json"), None);
        assert_eq!(message("abc", "[1]"), None);
    }

    #[test]
    fn escapes_the_id() {
        assert_eq!(json_string("a\"b\\c\n"), "\"a\\\"b\\\\c\\u000a\"");
    }
}
