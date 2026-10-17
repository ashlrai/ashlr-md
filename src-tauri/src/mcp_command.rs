//! Command-string formatting only; this module never executes a shell.

pub(crate) fn mcp_command(path: &str) -> String {
    command_for_shell(path, cfg!(windows))
}

fn command_for_shell(path: &str, powershell: bool) -> String {
    // Single quotes prevent interpolation of $, backticks, and other shell
    // syntax in an app install path. PowerShell doubles embedded apostrophes;
    // POSIX shells close the quote, escape the apostrophe, and reopen it.
    let quoted = if powershell {
        format!("'{}'", path.replace('\'', "''"))
    } else {
        posix_single_quote(path)
    };
    format!("claude mcp add --scope user ashlr-md {quoted}")
}

fn posix_single_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// The `command` of the Claude Code auto-open hook in `~/.claude/settings.json`.
///
/// Claude Code hands hook commands to a POSIX shell (`sh`/`bash`), so the
/// `mdopen` path is POSIX single-quoted: `/Applications/Ashlr MD.app/...` stays
/// one word instead of splitting at the space. The same quoting is written on
/// Windows on the assumption that hooks run under Git Bash there; that has not
/// been verified against an installed Windows build.
pub(crate) fn hook_command(mdopen: &str) -> String {
    format!("{} --hook", posix_single_quote(mdopen))
}

/// The unquoted hook `command` earlier versions wrote for this `mdopen` path;
/// matched exactly so only our own broken entry is ever rewritten.
pub(crate) fn legacy_hook_command(mdopen: &str) -> String {
    format!("{mdopen} --hook")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_macos_resource_path_is_one_quoted_argument() {
        assert_eq!(
            command_for_shell("/Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp", false),
            "claude mcp add --scope user ashlr-md '/Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp'"
        );
    }

    #[test]
    fn posix_apostrophes_and_interpolation_syntax_stay_literal() {
        assert_eq!(
            command_for_shell("/tmp/Mason's $HOME `whoami` $(id)/mdopener-mcp", false),
            "claude mcp add --scope user ashlr-md '/tmp/Mason'\\''s $HOME `whoami` $(id)/mdopener-mcp'"
        );
    }

    #[test]
    fn powershell_apostrophes_are_doubled_and_backslashes_preserved() {
        assert_eq!(
            command_for_shell("C:\\Users\\O'Brien\\Ashlr MD\\mdopener-mcp.exe", true),
            "claude mcp add --scope user ashlr-md 'C:\\Users\\O''Brien\\Ashlr MD\\mdopener-mcp.exe'"
        );
    }

    #[test]
    fn powershell_interpolation_syntax_stays_inside_single_quotes() {
        assert_eq!(
            command_for_shell("C:\\$HOME\\`whoami`\\$(id)\\mdopener-mcp.exe", true),
            "claude mcp add --scope user ashlr-md 'C:\\$HOME\\`whoami`\\$(id)\\mdopener-mcp.exe'"
        );
    }

    #[test]
    fn hook_command_keeps_a_spaced_app_path_as_one_word() {
        assert_eq!(
            hook_command("/Applications/Ashlr MD.app/Contents/Resources/mdopen"),
            "'/Applications/Ashlr MD.app/Contents/Resources/mdopen' --hook"
        );
        assert_eq!(
            hook_command("/tmp/O'Brien/$HOME/mdopen"),
            "'/tmp/O'\\''Brien/$HOME/mdopen' --hook"
        );
        assert_eq!(
            hook_command("C:\\Users\\me\\AppData\\Local\\Ashlr MD\\mdopen.exe"),
            "'C:\\Users\\me\\AppData\\Local\\Ashlr MD\\mdopen.exe' --hook"
        );
    }

    #[test]
    fn legacy_hook_command_is_the_old_unquoted_form() {
        let path = "/Applications/Ashlr MD.app/Contents/Resources/mdopen";
        assert_eq!(legacy_hook_command(path), format!("{path} --hook"));
        assert_ne!(legacy_hook_command(path), hook_command(path));
    }

    #[test]
    fn host_formatter_uses_the_host_shell_dialect() {
        let path = "/tmp/O'Brien/文档/mdopener-mcp";
        assert_eq!(mcp_command(path), command_for_shell(path, cfg!(windows)));
    }
}
