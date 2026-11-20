# Report whether the current (possibly UAC-filtered) token holds WRITE_OWNER on a
# directory through an Allow ACE, which DSH's Windows ACL sandbox needs to label
# the workspace. Read-only: nothing is modified.
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($id)
$acl = Get-Acl -LiteralPath $Path
$allow = $false
$deny = $false
$takeOwnership = [Security.AccessControl.FileSystemRights]::TakeOwnership
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if (-not ($rule.FileSystemRights -band $takeOwnership)) { continue }
    $sid = [Security.Principal.SecurityIdentifier]$rule.IdentityReference
    # IsInRole uses CheckTokenMembership, so deny-only groups of a filtered admin token do not count.
    $applies = ($sid -eq $id.User) -or $principal.IsInRole($sid)
    if (-not $applies) { continue }
    if ($rule.AccessControlType -eq 'Deny') { $deny = $true } else { $allow = $true }
}
@{ path = $Path; owner = $acl.Owner; writeOwner = ($allow -and -not $deny); user = $id.Name } | ConvertTo-Json -Compress
