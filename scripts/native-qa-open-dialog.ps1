param([ValidateSet('Preflight','Open')][string]$Mode)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$phase = 'assemblies'
$dialogReason = 'provider-error'
$observation = @{stage='not-started'; count=0; overflow=$false; windows=@()}

function Get-DialogWindowKey($window) {
    # Provider entries for one native window can have different RuntimeIds.
    # Never merge unrelated elements whose provider has no native handle (zero).
    $handle = $window.Current.NativeWindowHandle
    if ($handle -ne 0) { return 'hwnd:' + $handle }
    return 'runtime:' + (@($window.GetRuntimeId()) -join '.')
}

function Get-DialogRootKey($window) {
    $handle = $window.Current.NativeWindowHandle
    if ($handle -eq 0) { return $null }
    # GA_ROOT follows native parents, not popup owners (GA_ROOTOWNER would
    # incorrectly merge independent dialogs owned by the same application).
    $root = [NativeDialogWindow]::GetAncestor([IntPtr]$handle, 2)
    if ($root -eq [IntPtr]::Zero) { throw 'dialog-root-unavailable' }
    return 'hwnd:' + $root.ToInt64()
}

function Get-DialogOwnerKey($window) {
    # GW_OWNER (4): the popup owner one level up, or $null for none. A Common Item
    # Dialog can expose an inner #32770 as a top-level popup owned by the picker;
    # GA_ROOT alone sees two roots. Only an owner that is itself an exact owned
    # candidate collapses it, so independent dialogs sharing the app owner stay ambiguous.
    $handle = $window.Current.NativeWindowHandle
    if ($handle -eq 0) { return $null }
    $owner = [NativeDialogWindow]::GetWindow([IntPtr]$handle, 4)
    if ($owner -eq [IntPtr]::Zero) { return $null }
    return 'hwnd:' + $owner.ToInt64()
}

function Get-FilenameEdits($dialog, [int]$targetPid) {
    # Enabled filename Edit controls (automation ID 1148, or its ComboBox parent) inside one
    # dialog, collapsed by RuntimeId so a control UIA reports twice counts once.
    # Query by automation ID 1148 on the provider side. A modern file picker exposes many unrelated
    # Edit controls (address band, search box, ...), so counting every Edit under the dialog made
    # the old 16-edit cap fail with edit-count on a healthy picker. Only 1148 matches are bounded.
    $idCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, '1148')
    $editCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Edit)
    $idMatches = @(foreach ($e in $dialog.FindAll([Windows.Automation.TreeScope]::Descendants, $idCondition)) { $e })
    if ($idMatches.Count -gt 16) { throw 'edit-count' }
    $edits = @()
    foreach ($m in $idMatches) {
        if ($m.Current.ControlType -eq [Windows.Automation.ControlType]::Edit) { $edits += $m }
        elseif ($m.Current.ControlType -eq [Windows.Automation.ControlType]::ComboBox) {
            # The filename ComboBox hosts its Edit as a descendant.
            $inners = @(foreach ($inner in $m.FindAll([Windows.Automation.TreeScope]::Descendants, $editCondition)) { $inner })
            if ($inners.Count -gt 0) { $edits += $inners } else { $edits += $m }  # Some providers expose the combo itself as the value holder.
        }
    }
    if ($edits.Count -eq 0) {
        # Some picker builds do not publish automation ID 1148 at all (run 44113712735: filename
        # phase failed with zero edits on a healthy picker). Fall back to the Edit the dialog labels
        # "File name:", read by exact Name only for matching; unrelated edits (address band, search)
        # carry other names, and the single-match rule below still fails closed on ambiguity.
        $named = @(foreach ($e in $dialog.FindAll([Windows.Automation.TreeScope]::Descendants, $editCondition)) { $e })
        if ($named.Count -gt 64) { throw 'edit-count' }
        foreach ($e in $named) { if ($e.Current.Name -cmatch '^File name:?$') { $edits += $e } }
    }
    $found = @()
    $seenEdits = @{}
    foreach ($edit in $edits) {
        if ($edit.Current.ProcessId -eq $targetPid -and $edit.Current.IsEnabled) {
            $editKey = (@($edit.GetRuntimeId()) -join '.')
            if (-not $seenEdits.ContainsKey($editKey)) { $seenEdits[$editKey] = $true; $found += $edit }
        }
    }
    return $found
}

function Get-ConfirmButtons($dialog) {
    # Buttons with automation ID 1 (Open) anywhere under one dialog.
    $buttonCondition = [Windows.Automation.AndCondition]::new(
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button),
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, '1'))
    $found = @(foreach ($b in $dialog.FindAll([Windows.Automation.TreeScope]::Descendants, $buttonCondition)) { $b })
    if ($found.Count -eq 0) {
        # Some picker builds do not publish automation ID 1 (same gap as the filename edit ID).
        # Fall back to the Button named exactly "Open"; the single-match rule still fails closed.
        $anyButton = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
        $all = @(foreach ($b in $dialog.FindAll([Windows.Automation.TreeScope]::Descendants, $anyButton)) { $b })
        if ($all.Count -gt 64) { throw 'edit-count' }
        foreach ($b in $all) { if ($b.Current.Name -cmatch '^&?Open$') { $found += $b } }
    }
    return $found
}

function Select-FilenameDialogs($candidates, [int]$targetPid) {
    # Several enabled exact-PID #32770 windows can survive ancestry collapsing (runs 44059630934
    # and 44063864477 still reported ambiguous-dialog). Only the real file picker carries the
    # filename edit, so narrow to candidates with exactly one, polling briefly while controls
    # populate. When UIA nests the picker and its inner #32770, every such candidate reports
    # the same underlying edit (same RuntimeId); that is one picker, so keep the candidate that
    # also exposes exactly one confirm button (candidates sharing that same button are still one
    # picker). Different edits or different buttons stay ambiguous. Any provider failure returns the candidates unchanged so ambiguity fails closed.
    try {
        $until = [DateTime]::UtcNow.AddSeconds(5)
        do {
            $withEdit = @()
            $editKeys = @{}
            foreach ($candidate in $candidates) {
                $edits = @(Get-FilenameEdits $candidate $targetPid)
                if ($edits.Count -eq 1) { $withEdit += $candidate; $editKeys[(@($edits[0].GetRuntimeId()) -join '.')] = $true }
            }
            if ($withEdit.Count -eq 1) { return $withEdit }
            if ($withEdit.Count -gt 1 -and $editKeys.Count -eq 1) {
                # Nested candidates overlap, so they may all expose the same single button;
                # that is still one picker. Only distinct buttons stay ambiguous.
                $withButton = @()
                $buttonKeys = @{}
                foreach ($candidate in $withEdit) {
                    $buttons = @(Get-ConfirmButtons $candidate)
                    if ($buttons.Count -eq 1) { $withButton += $candidate; $buttonKeys[(@($buttons[0].GetRuntimeId()) -join '.')] = $true }
                }
                if ($withButton.Count -ge 1 -and $buttonKeys.Count -eq 1) { return @($withButton[0]) }
            }
            Start-Sleep -Milliseconds 200
        } while ([DateTime]::UtcNow -lt $until)
    } catch { }
    return @($candidates)
}

function Get-OwnedDialogWindows($desktopWindows, $condition, [int]$targetPid) {
    # UIA can place an owned dialog beneath its application window rather than
    # directly beneath the desktop. Inspect one child level of exact-PID windows
    # only, keeping the same total cap and never traversing WebView descendants.
    # UIA may report the same owned dialog both at desktop level and beneath its owner
    # window; collapse by native window identity so it is never counted twice.
    $windows = @()
    $seen = @{}
    if ($desktopWindows.Count -gt 8) { throw 'window-count' }
    foreach ($window in $desktopWindows) {
        if ($window.Current.ProcessId -ne $targetPid) { throw 'unexpected-owner' }
        $key = Get-DialogWindowKey $window
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $windows += $window
    }
    foreach ($window in $desktopWindows) {
        # Materialize into an array: an empty result can surface as $null under
        # Windows PowerShell 5.1, and strict mode forbids reading .Count on it.
        $children = @(foreach ($child in $window.FindAll([Windows.Automation.TreeScope]::Children, $condition)) { $child })
        if ($windows.Count + $children.Count -gt 8) { throw 'window-count' }
        foreach ($child in $children) {
            if ($child.Current.ProcessId -ne $targetPid) { throw 'unexpected-owner' }
            $key = Get-DialogWindowKey $child
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            $windows += $child
        }
    }
    return $windows
}

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -TypeDefinition @'
public static class NativeDialogWindow {
    [System.Runtime.InteropServices.DllImport("user32.dll", ExactSpelling = true)]
    public static extern System.IntPtr GetAncestor(System.IntPtr hwnd, uint flags);
    [System.Runtime.InteropServices.DllImport("user32.dll", ExactSpelling = true)]
    public static extern System.IntPtr GetWindow(System.IntPtr hwnd, uint command);
}
'@
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
    $fixedViolations = @('window-count','unexpected-owner','ambiguous-dialog')
    $dialog = $null
    # The harness binds the picker deterministically: it snapshots top-level windows before the
    # click and passes the one new owned #32770 handle. Verify it, then skip the heuristic search.
    $boundHandle = 0L
    if ([Int64]::TryParse([string]$env:QA_UIA_HWND, [ref]$boundHandle) -and $boundHandle -gt 0) {
        $bound = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$boundHandle)
        if ($bound.Current.ProcessId -ne $targetPid) { $dialogReason='ownership'; throw 'unexpected-owner' }
        if ($bound.Current.ClassName -cne '#32770') { $dialogReason='not-found'; throw 'dialog-unavailable' }
        $dialog = $bound
    }
    while ($null -eq $dialog -and [DateTime]::UtcNow -lt $deadline) {
        # Desktop children plus one level beneath exact-owned-PID windows only.
        try {
            $observation = @{stage='query'; count=0; overflow=$false; windows=@()}
            $desktopWindows = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $condition)
            $windows = @(Get-OwnedDialogWindows $desktopWindows $condition $targetPid)
            $observation.count = $windows.Count
            $candidates = @()
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
                # The Common Item Dialog is an owned, enabled #32770 but does not always report
                # WindowPattern.IsModal, so modality is observed (above), not required. Ownership,
                # class and enabled state plus the single-candidate rule keep selection exact.
                if ($window.Current.ClassName -ceq '#32770' -and $window.Current.IsEnabled) { $candidates += $window }
            }
            if ($candidates.Count -gt 1) {
                # UIA provider parenting need not match HWND parenting. A picker
                # and its embedded #32770 may appear as siblings with distinct
                # handles; neither deduplication nor direct UIA children prove
                # independence. Collapse only to another exact owned candidate.
                $nested = @{}
                $candidateKeys = @{}
                $observation['ancestry'] = @() # Fixed labels only; never HWNDs or titles.
                foreach ($candidate in $candidates) { $candidateKeys[(Get-DialogWindowKey $candidate)] = $true }
                foreach ($outer in $candidates) {
                    $outerKey = Get-DialogWindowKey $outer
                    try { $rootKey = Get-DialogRootKey $outer } catch { $observation.ancestry += 'query-failed'; throw }
                    if ($null -ne $rootKey) {
                        if ($rootKey -ceq $outerKey) {
                            try { $ownerKey = Get-DialogOwnerKey $outer } catch { $observation.ancestry += 'query-failed'; throw }
                            if ($null -ne $ownerKey -and $ownerKey -cne $outerKey -and $candidateKeys.ContainsKey($ownerKey)) { $nested[$outerKey] = $true; $observation.ancestry += 'owned' }
                            else { $observation.ancestry += 'root' }
                        }
                        elseif ($candidateKeys.ContainsKey($rootKey)) { $nested[$outerKey] = $true; $observation.ancestry += 'nested' }
                        else { $observation.ancestry += 'outside' }
                        continue
                    }
                    $observation.ancestry += 'handleless'
                    # Handle-less provider elements retain the bounded UIA fallback.
                    foreach ($inner in $outer.FindAll([Windows.Automation.TreeScope]::Children, $condition)) {
                        if ($inner.Current.ProcessId -ne $targetPid) { throw 'unexpected-owner' }
                        if ($inner.Current.NativeWindowHandle -ne 0) { continue }
                        $innerKey = Get-DialogWindowKey $inner
                        if ($innerKey -cne $outerKey) { $nested[$innerKey] = $true }
                    }
                }
                $candidates = @($candidates | Where-Object { -not $nested.ContainsKey((Get-DialogWindowKey $_)) })
            }
            if ($candidates.Count -gt 1) { $candidates = @(Select-FilenameDialogs $candidates $targetPid) }
            if ($candidates.Count -gt 1) { $dialogReason='ambiguous'; throw 'ambiguous-dialog' }
            if ($candidates.Count -eq 1) { $dialog = $candidates[0]; break }
            $observation.stage = 'wait'
            $dialogReason='not-found'
        } catch {
            # Fixed violations abort immediately; a transient provider exception retries
            # inside the same bounded deadline instead of ending the poll early.
            if ($_.Exception.Message -ceq 'window-count') { $dialogReason='count-overflow'; $observation.count=8; $observation.overflow=$true }
            if ($_.Exception.Message -ceq 'unexpected-owner') { $dialogReason='ownership' }
            if ($fixedViolations -contains $_.Exception.Message) { throw }
            $dialogReason='provider-error'
        }
        Start-Sleep -Milliseconds 200
    }
    if ($null -eq $dialog) { throw 'dialog-unavailable' }
    if ($dialog.Current.ProcessId -ne $targetPid) { $dialogReason='ownership'; throw 'dialog-unavailable' }
    $phase = 'filename'
    # A just-opened Common Item Dialog populates its controls asynchronously, so poll the
    # filename edit inside a bounded deadline instead of failing on the first empty read.
    $filenameDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $candidates = @(Get-FilenameEdits $dialog $targetPid)
        if ($candidates.Count -eq 1) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $filenameDeadline)
    if ($candidates.Count -eq 0) { throw 'filename-none' }
    if ($candidates.Count -gt 1) { throw 'filename-many' }
    $value = $candidates[0].GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    if ($value.Current.IsReadOnly) { throw 'readonly' }
    $value.SetValue($fixture)
    if ($value.Current.Value -cne $fixture) { throw 'readback' }
    $phase = 'confirm'
    # The confirm button can lag the filename edit, so wait (bounded) for exactly one enabled match.
    $buttonDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $buttons = @(Get-ConfirmButtons $dialog)
        if ($buttons.Count -eq 1 -and $buttons[0].Current.IsEnabled) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $buttonDeadline)
    if ($buttons.Count -ne 1 -or -not $buttons[0].Current.IsEnabled -or $buttons[0].Current.ProcessId -ne $targetPid) { throw 'ambiguous-open' }
    $invoke = $buttons[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()
    [Console]::WriteLine('qa-uia-open-invoked')
} catch {
    # Fixed phase and allowlisted throw reasons only, never provider errors, dialog text, paths or process data.
    if ($phase -eq 'dialog') { $observation['reason']=$dialogReason; [Console]::Error.WriteLine('qa-uia-windows:' + ($observation | ConvertTo-Json -Compress -Depth 4)) }
    $detailReasons = @('pid','fixture','ready','image','window-count','unexpected-owner','ambiguous-dialog','dialog-unavailable','edit-count','filename-none','filename-many','readonly','readback','ambiguous-open')
    if ($detailReasons -contains $_.Exception.Message) { [Console]::Error.WriteLine('qa-uia-detail:' + $_.Exception.Message) }
    [Console]::Error.WriteLine('qa-uia-failed:' + $phase)
    exit 1
}
