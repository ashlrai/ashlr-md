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
    Add-Type -TypeDefinition 'namespace Windows.Automation { public class WindowPattern { public static object Pattern = new object(); } public enum TreeScope { Children = 2 } }'
}
# Stand in for user32 while executing the real selection/ancestry logic
# on every OS, with no desktop, installer, network, or polling delays.
Add-Type -TypeDefinition @'
public static class NativeDialogWindow {
    public static System.Collections.Generic.Dictionary<long, long> Roots = new System.Collections.Generic.Dictionary<long, long>();
    public static System.IntPtr GetAncestor(System.IntPtr hwnd, uint flags) {
        if (flags != 2) throw new System.Exception("must follow parents, never owners");
        long handle = hwnd.ToInt64();
        return new System.IntPtr(Roots.ContainsKey(handle) ? Roots[handle] : handle);
    }
}
'@
$script:nextRuntimeId = 0
function New-TestWindow([string]$className, [bool]$modal, [bool]$enabled=$true, [int]$ownerPid=123, [array]$children=@(), [int]$nativeWindowHandle=0) {
    $window = [pscustomobject]@{Current=[pscustomobject]@{ProcessId=$ownerPid;ClassName=$className;IsEnabled=$enabled;NativeWindowHandle=$nativeWindowHandle};Modal=$modal;Children=$children;Queries=0}
    $script:nextRuntimeId++
    $window | Add-Member -MemberType NoteProperty -Name RuntimeId -Value @(42, $script:nextRuntimeId)
    $window | Add-Member -MemberType ScriptMethod -Name GetRuntimeId -Value { return $this.RuntimeId }
    $window | Add-Member -MemberType ScriptMethod -Name GetCurrentPattern -Value { param($pattern) return [pscustomobject]@{Current=[pscustomobject]@{IsModal=$this.Modal}} }
    $window | Add-Member -MemberType ScriptMethod -Name TryGetCurrentPattern -Value { param($pattern,[ref]$value) $value.Value=$this.GetCurrentPattern($pattern); return $true }
    $window | Add-Member -MemberType ScriptMethod -Name FindAll -Value {
        param($scope,$condition)
        if ($scope -ne [Windows.Automation.TreeScope]::Children) { throw 'unbounded scope' }
        $this.Queries++
        return ,$this.Children
    }
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
# Execute the real discovery function with the failed run's disabled Tauri owner
# and a Common Item Dialog exposed as its child. The old desktop-only query
# misses this dialog entirely. No unrelated desktop tree or grandchildren may be read.
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$null)
$identity = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-DialogWindowKey'}, $false)
if ($null -ne $identity) { . ([scriptblock]::Create($identity.Extent.Text)) }
$ancestry = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-DialogRootKey'}, $false)
if ($null -ne $ancestry) { . ([scriptblock]::Create($ancestry.Extent.Text)) }
$discovery = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-OwnedDialogWindows'}, $false)
if ($null -eq $discovery) { throw 'owned dialog discovery function not found' }
. ([scriptblock]::Create($discovery.Extent.Text))
$condition = [pscustomobject]@{}
foreach ($modal in @($true,$false)) {
    $picker = New-TestWindow '#32770' $modal
    $owner = New-TestWindow 'Tauri Window' $false $false 123 @($picker)
    $dialog=$null; $observation=@{stage='inspect';count=1;overflow=$false;windows=@()}
    $windows = @($owner)
    . $probe
    if ($null -ne $dialog -or $observation.stage -cne 'wait') { throw 'desktop-only failure was not reproduced' }
    $dialog=$null; $observation=@{stage='inspect';count=2;overflow=$false;windows=@()}
    $windows = @(Get-OwnedDialogWindows @($owner) $condition $targetPid)
    . $probe
    if ($dialog -ne $picker -or $owner.Queries -ne 1 -or $picker.Queries -ne 0) { throw 'owned child dialog missed or traversal exceeded one level' }
}
# Desktop dialogs remain supported and are considered together with child dialogs.
$picker = New-TestWindow '#32770' $false
$windows = @(Get-OwnedDialogWindows @($picker) $condition $targetPid)
$dialog=$null; $observation=@{stage='inspect';count=1;overflow=$false;windows=@()}
. $probe
if ($dialog -ne $picker) { throw 'desktop dialog missed' }
foreach ($roots in @(
    ,@((New-TestWindow '#32770' $true $true 456)),
    ,@((New-TestWindow 'Tauri Window' $false $false 123 @((New-TestWindow '#32770' $true $true 456))))
)) {
    $rejected=$false
    try { Get-OwnedDialogWindows $roots $condition $targetPid | Out-Null } catch { if ($_.Exception.Message -ceq 'unexpected-owner') {$rejected=$true} else {throw} }
    if (-not $rejected) { throw 'foreign window accepted' }
    if ($roots[0].Current.ProcessId -ne $targetPid -and $roots[0].Queries -ne 0) { throw 'foreign window traversed' }
}
foreach ($count in @(8,9)) {
    $roots = @(1..$count | ForEach-Object { New-TestWindow 'Tauri Window' $false })
    $rejected=$false
    try { $windows = @(Get-OwnedDialogWindows $roots $condition $targetPid) } catch { if ($_.Exception.Message -ceq 'window-count') {$rejected=$true} else {throw} }
    if ($rejected -ne ($count -gt 8)) { throw 'desktop window cap changed' }
    if ($rejected -and @($roots | Where-Object { $_.Queries -ne 0 }).Count -ne 0) { throw 'overflowing roots traversed' }
    $children = @(1..($count-1) | ForEach-Object { New-TestWindow 'Tauri Window' $false })
    $owner = New-TestWindow 'Tauri Window' $false $false 123 $children
    $rejected=$false
    try { $windows = @(Get-OwnedDialogWindows @($owner) $condition $targetPid) } catch { if ($_.Exception.Message -ceq 'window-count') {$rejected=$true} else {throw} }
    if ($rejected -ne ($count -gt 8)) { throw 'combined window cap changed' }
    if (-not $rejected -and $windows.Count -ne $count) { throw 'combined window count changed' }
}
$windows=@(Get-OwnedDialogWindows @() $condition $targetPid)
if ($windows.Count -ne 0) { throw 'empty desktop produced windows' }
# Both same-level and cross-level ambiguous candidates must still fail closed.
$windows=@((New-TestWindow '#32770' $true),(New-TestWindow '#32770' $true))
$dialog=$null; $observation=@{stage='inspect';count=2;overflow=$false;windows=@()}
$rejected=$false
try { . $probe } catch { if ($_.Exception.Message -ceq 'ambiguous-dialog') {$rejected=$true} else {throw} }
if (-not $rejected) { throw 'desktop ambiguous dialogs accepted' }
$dialog=$null; $observation=@{stage='inspect';count=2;overflow=$false;windows=@()}
# Use a separate owner with one picker to exercise cross-level ambiguity.
$owner = New-TestWindow 'Tauri Window' $false $false 123 @((New-TestWindow '#32770' $true))
$windows=@(Get-OwnedDialogWindows @((New-TestWindow '#32770' $true),$owner) $condition $targetPid)
$rejected=$false
try { . $probe } catch { if ($_.Exception.Message -ceq 'ambiguous-dialog') {$rejected=$true} else {throw} }
if (-not $rejected) { throw 'ambiguous dialogs accepted' }
# The same dialog reported at desktop level and beneath its owner is one candidate, not ambiguous.
$picker = New-TestWindow '#32770' $true
$owner = New-TestWindow 'Tauri Window' $false $false 123 @($picker)
$windows = @(Get-OwnedDialogWindows @($picker,$owner) $condition $targetPid)
if ($windows.Count -ne 2) { throw 'duplicate dialog not collapsed' }
$dialog=$null; $observation=@{stage='inspect';count=2;overflow=$false;windows=@()}
. $probe
if ($null -eq $dialog -or -not [object]::ReferenceEquals($dialog,$picker)) { throw 'duplicate dialog not selected' }
# Two UIA provider entries with different RuntimeIds can refer to the same native
# dialog HWND. Exercise both enumeration orders and all discovery layouts.
foreach ($layout in @('desktop','owned','both')) {
    foreach ($reverse in @($true,$false)) {
        $picker = New-TestWindow '#32770' $true -nativeWindowHandle 901
        $alias = New-TestWindow '#32770' $true -nativeWindowHandle 901
        $entries = if ($reverse) { @($alias,$picker) } else { @($picker,$alias) }
        $children = @(switch ($layout) { 'desktop' { @() } 'owned' { $entries } 'both' { @($entries[1]) } })
        $owner = New-TestWindow 'Tauri Window' $false $false 123 $children
        $roots = @(switch ($layout) { 'desktop' { @($owner) + $entries } 'owned' { @($owner) } 'both' { @($owner,$entries[0]) } })
        $windows = @(Get-OwnedDialogWindows $roots $condition $targetPid)
        if ($windows.Count -ne 2) { throw 'native dialog aliases not collapsed' }
        $dialog=$null; $observation=@{stage='inspect';count=2;overflow=$false;windows=@()}
        . $probe
        if ($null -eq $dialog -or $dialog.Current.NativeWindowHandle -ne 901) { throw 'native dialog alias not selected' }
    }
}
# A matching HWND must never let a foreign-PID entry bypass the ownership check.
$alias.Current.ProcessId=456
$rejected=$false
try { Get-OwnedDialogWindows @($picker,$alias) $condition $targetPid | Out-Null } catch { if ($_.Exception.Message -ceq 'unexpected-owner') {$rejected=$true} else {throw} }
if (-not $rejected) { throw 'foreign native dialog alias accepted' }
# Different nonzero HWNDs remain ambiguous, just like the zero-HWND cases above.
$windows=@((New-TestWindow '#32770' $true -nativeWindowHandle 901),(New-TestWindow '#32770' $true -nativeWindowHandle 902))
$dialog=$null; $observation=@{stage='inspect';count=2;overflow=$false;windows=@()}
$rejected=$false
try { . $probe } catch { if ($_.Exception.Message -ceq 'ambiguous-dialog') {$rejected=$true} else {throw} }
if (-not $rejected) { throw 'distinct native dialogs accepted' }
# A provider alias beneath its own window does not make that window nested in
# itself. It must not hide one of two genuinely independent dialogs.
$selfAlias = New-TestWindow '#32770' $true -nativeWindowHandle 901
$picker = New-TestWindow '#32770' $true -children @($selfAlias) -nativeWindowHandle 901
$windows=@($picker,(New-TestWindow '#32770' $true -nativeWindowHandle 902))
$dialog=$null; $observation=@{stage='inspect';count=2;overflow=$false;windows=@()}
$rejected=$false
try { . $probe } catch { if ($_.Exception.Message -ceq 'ambiguous-dialog') {$rejected=$true} else {throw} }
if (-not $rejected) { throw 'self alias hid independent dialog ambiguity' }
# An inner #32770 beneath the real dialog is not a second candidate; the outermost dialog wins.
$inner = New-TestWindow '#32770' $false
$picker = New-TestWindow '#32770' $true $true 123 @($inner)
$windows = @($picker,$inner)
$dialog=$null; $observation=@{stage='inspect';count=3;overflow=$false;windows=@()}
. $probe
if ($null -eq $dialog -or -not [object]::ReferenceEquals($dialog,$picker)) { throw 'nested dialog not collapsed to outermost' }
# Nested filtering uses native identity too, even when a fresh child provider
# entry has a different RuntimeId from the entry discovered at desktop level.
$inner = New-TestWindow '#32770' $true -nativeWindowHandle 902
$alias = New-TestWindow '#32770' $true -nativeWindowHandle 902
$picker = New-TestWindow '#32770' $true -children @($alias) -nativeWindowHandle 901
[NativeDialogWindow]::Roots[902] = 901
$windows=@($picker,$inner)
$dialog=$null; $observation=@{stage='inspect';count=2;overflow=$false;windows=@()}
. $probe
if ($null -eq $dialog -or -not [object]::ReferenceEquals($dialog,$picker)) { throw 'nested native dialog alias not collapsed to outermost' }
[NativeDialogWindow]::Roots.Clear()
# UIA may reparent independent owned popups. Native roots must override that
# relationship, and two independent roots must still fail closed.
$inner = New-TestWindow '#32770' $true -nativeWindowHandle 902
$picker = New-TestWindow '#32770' $true -children @($inner) -nativeWindowHandle 901
foreach ($root in @(902,999)) {
    [NativeDialogWindow]::Roots[902] = $root
    $windows=@($picker,$inner)
    $dialog=$null; $observation=@{stage='inspect';count=2;overflow=$false;windows=@()}
    $rejected=$false
    try { . $probe } catch { if ($_.Exception.Message -ceq 'ambiguous-dialog') {$rejected=$true} else {throw} }
    if (-not $rejected -or $null -ne $dialog) { throw 'independent or unobserved native root accepted' }
}
# A failed native query cannot fall back to a guessed UIA relationship.
[NativeDialogWindow]::Roots[902] = 0
$rejected=$false
try { . $probe } catch { if ($_.Exception.Message -ceq 'dialog-root-unavailable') {$rejected=$true} else {throw} }
if (-not $rejected -or $null -ne $dialog) { throw 'failed native ancestry query accepted' }
[NativeDialogWindow]::Roots.Clear()
# Reproduce the unresolved ambiguity: two different HWNDs in one native picker,
# exposed as UIA siblings (or separated by a provider-only intermediate element).
# RuntimeId/HWND dedup and direct UIA child filtering cannot collapse this pair.
foreach ($reverse in @($true,$false)) {
    $picker = New-TestWindow '#32770' $true -nativeWindowHandle 911
    $inner = New-TestWindow '#32770' $true -nativeWindowHandle 912
    [NativeDialogWindow]::Roots[912] = 911
    $owner = New-TestWindow 'Tauri Window' $false $false 123 @($picker,$inner)
    $entries = if ($reverse) { @($inner,$picker) } else { @($picker,$inner) }
    foreach ($roots in @(,@($owner),$entries)) {
        $windows = @(Get-OwnedDialogWindows $roots $condition $targetPid)
        $dialog=$null; $observation=@{stage='inspect';count=$windows.Count;overflow=$false;windows=@()}
        . $probe
        if (-not [object]::ReferenceEquals($dialog,$picker)) { throw 'native nested dialog reported as ambiguous' }
        if (($observation.ancestry | Sort-Object) -join ',' -cne 'nested,root') { throw 'native ancestry diagnostic lost the relationship' }
    }
}
[NativeDialogWindow]::Roots.Clear()
[Console]::WriteLine('PASS: actual PowerShell discovery and selection cover owned child dialogs, desktop dialogs, native handle aliases and ancestry (7 new cases), modality, bounded traversal, ownership, count caps, regex collision, disabled and ambiguous candidates.')
