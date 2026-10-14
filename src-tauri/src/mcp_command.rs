//! Manual-copy command formatting only; this module never executes a shell.

pub(crate) fn mcp_command(path: &str) -> String {
    command_for_shell(path, cfg!(windows))
}

fn command_for_shell(path: &str, powershell: bool) -> String {
    // Single quotes prevent interpolation of $, backticks, and other shell
    // syntax in an app install path. PowerShell doubles embedded apostrophes;
    // POSIX shells close the quote, escape the apostrophe, and reopen it.
    let escaped = if powershell {
        path.replace('\'', "''")
    } else {
        path.replace('\'', "'\\''")
    };
    format!("claude mcp add --scope user ashlr-md '{escaped}'")
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
    fn host_formatter_uses_the_host_shell_dialect() {
        let path = "/tmp/O'Brien/文档/mdopener-mcp";
        assert_eq!(mcp_command(path), command_for_shell(path, cfg!(windows)));
    }
}
