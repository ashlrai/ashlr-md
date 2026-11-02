param([ValidateSet('Preflight','Open')][string]$Mode)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$phase = 'assemblies'
$dialogReason = 'provider-error'
$observation = @{stage='not-started'; count=0; overflow=$false; windows=@()}
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    if ($Mode -eq 'Preflight') {
        [Console]::WriteLine('qa-uia-available')
        exit 0
    }
    $phase = 'inputs'
    $targetPid = 0
    if (-not [int]::TryParse($env:QA_UIA_PID, [ref]$targetPid) -or $targetPid -le 0) { throw 'pid' }
    $fixture = [IO.Path]::GetFullPath($env:QA_UIA_FIXTURE)
    $ready = [IO.Path]::GetFullPath($env:QA_UIA_READY)
    if (-not [IO.File]::Exists($fixture) -or [IO.Path]::GetFileName($fixture) -cne 'native-smoke.md') { throw 'fixture' }
    if ([IO.Path]::GetDirectoryName($fixture) -cne [IO.Path]::GetDirectoryName($ready) -or [IO.Path]::GetFileName($ready) -cne 'uia-ready') { throw 'ready' }
    $process = [Diagnostics.Process]::GetProcessById($targetPid)
    if ($process.MainModule.FileName -ine $env:QA_UIA_APP) { throw 'image' }
    $stream = [IO.File]::Open($ready, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $stream.Dispose()
    $phase = 'dialog'
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    $pidCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $targetPid)
    $windowCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Window)
    $condition = [Windows.Automation.AndCondition]::new($pidCondition, $windowCondition)
    $dialog = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        # Immediate desktop children only; never traverse unrelated desktop subtrees.
        $observation = @{stage='query'; count=0; overflow=$false; windows=@()}
        $windows = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $condition)
        $observation.count = [Math]::Min(8, $windows.Count)
        $observation.overflow = $windows.Count -gt 8
        if ($windows.Count -gt 8) { $dialogReason='count-overflow'; throw 'window-count' }
        $matches = @()
        foreach ($window in $windows) {
            $observation.stage = 'inspect'
            if ($window.Current.ProcessId -ne $targetPid) { $dialogReason='ownership'; throw 'unexpected-owner' }
            # Read only class/pattern flags, never Name, text, paths or desktop descendants.
            $class = $window.Current.ClassName
            if ($null -eq $class -or $class -cnotmatch '^[A-Za-z0-9_#.: -]{1,64}$') { $class = 'unknown' }
            $modal = $null
            $available = $false
            try {
                $readPattern = $null
                $available = $window.TryGetCurrentPattern([Windows.Automation.WindowPattern]::Pattern, [ref]$readPattern)
                if ($available) { $modal = [bool]$readPattern.Current.IsModal }
            } catch { $available = $false; $modal = $null }
            $observation.windows += @{class=$class; pattern=[bool]$available; modal=$modal; enabled=[bool]$window.Current.IsEnabled}
            $observation.stage = 'select'
            if ($window.Current.ClassName -ceq '#32770') {
                $pattern = $window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)
                if ($pattern.Current.IsModal -and $window.Current.IsEnabled) { $matches += $window }
            }
        }
        if ($matches.Count -gt 1) { $dialogReason='ambiguous'; throw 'ambiguous-dialog' }
        if ($matches.Count -eq 1) { $dialog = $matches[0]; break }
        $observation.stage = 'wait'
        Start-Sleep -Milliseconds 200
    }
    if ($null -eq $dialog) { $dialogReason='not-found'; throw 'dialog-unavailable' }
    if ($dialog.Current.ProcessId -ne $targetPid) { $dialogReason='ownership'; throw 'dialog-unavailable' }
    $phase = 'filename'
    $editCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Edit)
    $edits = $dialog.FindAll([Windows.Automation.TreeScope]::Descendants, $editCondition)
    if ($edits.Count -gt 16) { throw 'edit-count' }
    $matches = @()
    foreach ($edit in $edits) {
        $parent = [Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($edit)
        $isFilename = $edit.Current.AutomationId -ceq '1148'
        if ($null -ne $parent -and $parent.Current.ControlType -eq [Windows.Automation.ControlType]::ComboBox -and $parent.Current.AutomationId -ceq '1148') { $isFilename = $true }
        if ($isFilename -and $edit.Current.ProcessId -eq $targetPid -and $edit.Current.IsEnabled) { $matches += $edit }
    }
    if ($matches.Count -ne 1) { throw 'ambiguous-filename' }
    $value = $matches[0].GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    if ($value.Current.IsReadOnly) { throw 'readonly' }
    $value.SetValue($fixture)
    if ($value.Current.Value -cne $fixture) { throw 'readback' }
    $phase = 'confirm'
    $buttonCondition = [Windows.Automation.AndCondition]::new(
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button),
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, '1'))
    $buttons = $dialog.FindAll([Windows.Automation.TreeScope]::Descendants, $buttonCondition)
    if ($buttons.Count -ne 1 -or -not $buttons[0].Current.IsEnabled -or $buttons[0].Current.ProcessId -ne $targetPid) { throw 'ambiguous-open' }
    $invoke = $buttons[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()
    [Console]::WriteLine('qa-uia-open-invoked')
} catch {
    # Fixed phase only, never provider errors, dialog text, paths or process data.
    if ($phase -eq 'dialog') { $observation['reason']=$dialogReason; [Console]::Error.WriteLine('qa-uia-windows:' + ($observation | ConvertTo-Json -Compress -Depth 4)) }
    [Console]::Error.WriteLine('qa-uia-failed:' + $phase)
    exit 1
}
