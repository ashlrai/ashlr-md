param([string]$ScriptPath = (Join-Path $PSScriptRoot 'native-qa-open-dialog.ps1'))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Execute the real source's candidate-selection block without a desktop/provider.
# The legacy name is accepted only so this test proves the original source fails.
$source = [IO.File]::ReadAllText($ScriptPath)
$block = [regex]::Match($source, '(?s)            \$(?:matches|candidates) = @\(\).*?            \$observation.stage = ''wait''')
if (-not $block.Success) { throw 'selection source block not found' }
$probe = [scriptblock]::Create('while ($true) {' + $block.Value + '; break }')
# A minimal provider stand-in exercises PowerShell semantics, not real UIA support.
if (-not ('Windows.Automation.WindowPattern' -as [type])) {
    Add-Type -TypeDefinition 'namespace Windows.Automation { public class WindowPattern { public static object Pattern = new object(); } }'
}
function New-TestWindow([string]$className, [bool]$modal, [bool]$enabled=$true) {
    $window = [pscustomobject]@{Current=[pscustomobject]@{ProcessId=123;ClassName=$className;IsEnabled=$enabled};Modal=$modal}
    $window | Add-Member -MemberType ScriptMethod -Name GetCurrentPattern -Value { param($pattern) return [pscustomobject]@{Current=[pscustomobject]@{IsModal=$this.Modal}} }
    $window | Add-Member -MemberType ScriptMethod -Name TryGetCurrentPattern -Value { param($pattern,[ref]$value) $value.Value=$this.GetCurrentPattern($pattern); return $true }
    return $window
}
foreach ($className in @('TauriWindow', 'Chrome_WidgetWin_0', "invalid`nclass")) {
    $targetPid = 123
    $dialog = $null
    $observation = @{stage='inspect'; count=1; overflow=$false; windows=@()}
    $windows = @(New-TestWindow $className $false)
    . $probe
    if ($null -ne $dialog) { throw 'ordinary window falsely selected as a native dialog' }
    if ($observation.windows.Count -ne 1 -or $observation.stage -cne 'wait') { throw 'selection observation failed' }
}
foreach ($enabled in @($true,$false)) {
    $dialog=$null; $observation=@{stage='inspect';count=1;overflow=$false;windows=@()}
    $windows=@(New-TestWindow '#32770' $true $enabled)
    . $probe
    if (($null -ne $dialog) -ne $enabled) { throw 'modal enabled predicate changed' }
}
$dialog=$null; $observation=@{stage='inspect';count=2;overflow=$false;windows=@()}
$windows=@((New-TestWindow '#32770' $true),(New-TestWindow '#32770' $true))
$rejected=$false
try { . $probe } catch { if ($_.Exception.Message -ceq 'ambiguous-dialog') {$rejected=$true} else {throw} }
if (-not $rejected) { throw 'ambiguous dialogs accepted' }
[Console]::WriteLine('PASS: actual PowerShell source selection rejects regex collision, disabled and ambiguous candidates; accepts one modal candidate.')
